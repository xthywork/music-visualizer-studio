from __future__ import annotations

import threading
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.render_jobs.lifecycle import JobLifecycle
from app.render_jobs.models import JobErrorCode, JobState, RenderConfiguration
from app.render_jobs.repository import JobRepository
from app.render_jobs.preflight import ProbeResult
from app.render_jobs.service import RenderJobService, WorkerReadiness
from app.render_jobs.storage import AssetKind, JobStorage
from app.render_jobs.worker import RenderWorker
from app.render_jobs.worker import WorkerSupervisor


def configuration() -> RenderConfiguration:
    return RenderConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "templateId": "night-orbit",
            "text": {"title": "Song", "artist": "Artist"},
            "output": {
                "aspectRatio": "16:9",
                "width": 1280,
                "height": 720,
                "frameRate": 30,
            },
        }
    )


def services(tmp_path: Path):
    root = tmp_path / "data"
    repository = JobRepository(root / "jobs.sqlite3")
    repository.initialize()
    storage = JobStorage(root, storage_ceiling_bytes=10**9, minimum_free_bytes=1)
    storage.initialize()
    return repository, storage, JobLifecycle(repository, storage)


def queued_job(repository: JobRepository, storage: JobStorage) -> str:
    job_id = str(uuid4())
    storage.create_job_directories(job_id)
    storage.asset_path(job_id, AssetKind.AUDIO).write_bytes(b"audio")
    repository.create_job(configuration(), job_id=job_id)
    return job_id


def test_worker_publishes_completed_output_and_cleans_sources(tmp_path: Path) -> None:
    repository, storage, lifecycle = services(tmp_path)
    job_id = queued_job(repository, storage)

    def execute(record, _worker, _cancelled, progress):  # type: ignore[no-untyped-def]
        progress(1, 2, 1.0)
        progress(2, 2, 0.0)
        storage.output_path(record.id).write_bytes(b"mp4")
        return storage.output_relative_path(record.id)

    assert RenderWorker(repository, lifecycle, execute, worker_id="worker").run_once()
    record = repository.require(job_id)
    assert record.state == JobState.COMPLETED
    assert record.progress == 1
    assert record.cleanup_done
    assert storage.output_path(job_id).read_bytes() == b"mp4"
    assert not storage.asset_path(job_id, AssetKind.AUDIO).exists()


def test_cancel_after_output_publication_wins_and_removes_output(tmp_path: Path) -> None:
    repository, storage, lifecycle = services(tmp_path)
    job_id = queued_job(repository, storage)

    def execute(record, _worker, _cancelled, _progress):  # type: ignore[no-untyped-def]
        storage.output_path(record.id).write_bytes(b"late output")
        repository.request_cancel(record.id)
        return storage.output_relative_path(record.id)

    RenderWorker(repository, lifecycle, execute, worker_id="worker").run_once()
    record = repository.require(job_id)
    assert record.state == JobState.CANCELLED
    assert record.error_code == JobErrorCode.CANCELLED
    assert not storage.output_path(job_id).exists()
    assert record.cleanup_done


def test_http_remains_responsive_while_worker_executes_long_job(tmp_path: Path) -> None:
    settings = Settings(
        data_root=tmp_path / "data",
        worker_enabled=False,
        storage_ceiling_bytes=10**9,
        minimum_free_bytes=1,
    )
    readiness = WorkerReadiness(ready=True)
    service = RenderJobService(settings, readiness=readiness)
    app = create_app(settings, service)
    entered = threading.Event()
    release = threading.Event()

    with TestClient(app) as client:
        job_id = queued_job(service.repository, service.storage)

        def execute(record, _worker, _cancelled, _progress):  # type: ignore[no-untyped-def]
            entered.set()
            assert release.wait(2)
            service.storage.output_path(record.id).write_bytes(b"mp4")
            return service.storage.output_relative_path(record.id)

        worker = RenderWorker(
            service.repository,
            service.lifecycle,
            execute,
            worker_id="worker",
        )
        thread = threading.Thread(target=worker.run_once)
        thread.start()
        assert entered.wait(1)
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["renderWorkerReady"] is True
        release.set()
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert service.repository.require(job_id).state == JobState.COMPLETED


class ReadyProbe:
    def check(self) -> ProbeResult:
        return ProbeResult(ready=True)


def wait_for_stop(_settings, stop) -> None:  # type: ignore[no-untyped-def]
    stop.wait(30)


def test_supervisor_graceful_stop_reaps_worker_process(tmp_path: Path) -> None:
    settings = Settings(data_root=tmp_path / "data", worker_enabled=True)
    readiness = WorkerReadiness()
    supervisor = WorkerSupervisor(
        settings,
        readiness,
        process_target=wait_for_stop,
        probe=ReadyProbe(),  # type: ignore[arg-type]
    )
    assert supervisor.start()
    process = supervisor._process
    assert process is not None and process.is_alive()
    assert readiness.get().ready is True

    supervisor.stop(timeout=2)

    assert not process.is_alive()
    assert readiness.get().ready is False


def test_service_startup_recovers_and_cleans_orphaned_worker_inputs(tmp_path: Path) -> None:
    settings = Settings(
        data_root=tmp_path / "data",
        worker_enabled=False,
        storage_ceiling_bytes=10**9,
        minimum_free_bytes=1,
    )
    repository, storage, _lifecycle = services(tmp_path)
    job_id = queued_job(repository, storage)
    storage.work_path(job_id, "output.part.mp4").write_bytes(b"partial")
    assert repository.claim_next("dead-worker") is not None

    service = RenderJobService(
        settings,
        repository=repository,
        storage=storage,
        readiness=WorkerReadiness(False),
    )
    service.initialize()

    record = repository.require(job_id)
    assert record.state == JobState.INTERRUPTED
    assert record.cleanup_done
    assert not storage.asset_path(job_id, AssetKind.AUDIO).exists()
    assert not storage.work_path(job_id, "output.part.mp4").exists()


def test_graceful_worker_stop_interrupts_active_job_instead_of_user_cancelling(
    tmp_path: Path,
) -> None:
    repository, storage, lifecycle = services(tmp_path)
    job_id = queued_job(repository, storage)
    stop = threading.Event()

    def execute(_record, _worker, cancelled, _progress):  # type: ignore[no-untyped-def]
        stop.set()
        if cancelled():
            from app.render_jobs.encoder import RenderCancelled

            raise RenderCancelled("stop")
        raise AssertionError("stop signal was not visible")

    RenderWorker(repository, lifecycle, execute, worker_id="worker").run_once(stop)

    record = repository.require(job_id)
    assert record.state == JobState.INTERRUPTED
    assert record.error_code == JobErrorCode.INTERRUPTED
    assert record.cleanup_done
