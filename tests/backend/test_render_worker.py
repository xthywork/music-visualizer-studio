from __future__ import annotations

import threading
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.render_jobs import worker as worker_module
from app.render_jobs.lifecycle import JobLifecycle
from app.render_jobs.models import JobErrorCode, JobState, RenderConfiguration
from app.render_jobs.repository import JobRepository
from app.render_jobs.preflight import ProbeResult
from app.render_jobs.service import RenderJobService, WorkerReadiness
from app.render_jobs.storage import AssetKind, JobStorage
from app.render_jobs.worker import JobRenderer, RenderWorker, WorkerSupervisor


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


def test_job_renderer_uses_configured_software_encoder(tmp_path: Path) -> None:
    settings = Settings(
        data_root=tmp_path / "data",
        video_encoder="libx264",
        encoder_threads=8,
        encoder_preset="ultrafast",
    )
    storage = JobStorage(
        settings.data_root,
        storage_ceiling_bytes=10**9,
        minimum_free_bytes=1,
    )

    renderer = JobRenderer(settings, storage)

    assert renderer.encoder.encoder == "libx264"
    assert renderer.encoder.encoder_threads == 8
    assert renderer.encoder.encoder_preset == "ultrafast"


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


def test_worker_throttles_repeated_database_cancel_checks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, storage, lifecycle = services(tmp_path)
    job_id = queued_job(repository, storage)
    cancel_checks = 0
    real_cancel_check = repository.is_cancel_requested

    def count_cancel_checks(job: str, worker: str) -> bool:
        nonlocal cancel_checks
        cancel_checks += 1
        return real_cancel_check(job, worker)

    monkeypatch.setattr(repository, "is_cancel_requested", count_cancel_checks)
    monkeypatch.setattr(worker_module.time, "monotonic", lambda: 10.0)

    def execute(record, _worker, cancelled, _progress):  # type: ignore[no-untyped-def]
        for _ in range(10_000):
            assert not cancelled()
        storage.output_path(record.id).write_bytes(b"mp4")
        return storage.output_relative_path(record.id)

    assert RenderWorker(repository, lifecycle, execute, worker_id="worker").run_once()
    assert repository.require(job_id).state == JobState.COMPLETED
    assert cancel_checks == 2


def test_worker_throttles_frame_progress_writes_but_always_writes_final_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, storage, lifecycle = services(tmp_path)
    job_id = queued_job(repository, storage)
    writes: list[int] = []
    real_update = repository.update_progress

    def record_progress(job: str, worker: str, *, frame: int, total_frames: int, eta_seconds: float | None) -> bool:
        writes.append(frame)
        return real_update(
            job,
            worker,
            frame=frame,
            total_frames=total_frames,
            eta_seconds=eta_seconds,
        )

    monkeypatch.setattr(repository, "update_progress", record_progress)
    ticks = iter([0.0, 0.05, 0.10, 0.15, 0.20])
    monkeypatch.setattr(worker_module.time, "monotonic", lambda: next(ticks))

    def execute(record, _worker, _cancelled, progress):  # type: ignore[no-untyped-def]
        for frame in range(1, 6):
            progress(frame, 5, 1.0)
        storage.output_path(record.id).write_bytes(b"mp4")
        return storage.output_relative_path(record.id)

    RenderWorker(repository, lifecycle, execute, worker_id="worker").run_once()

    assert writes == [1, 5]
    assert repository.require(job_id).state == JobState.COMPLETED


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
