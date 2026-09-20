import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.render_jobs import repository as repository_module
from app.render_jobs.models import JobErrorCode, JobState, RenderConfiguration
from app.render_jobs.repository import JobRepository


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


@pytest.fixture
def repository(tmp_path: Path) -> JobRepository:
    result = JobRepository(tmp_path / "jobs.sqlite3")
    result.initialize()
    return result


def test_configuration_round_trips_through_repository(repository: JobRepository) -> None:
    created = repository.create_job(configuration())

    loaded = repository.require(created.id)

    assert loaded.configuration == configuration()
    assert loaded.state == JobState.QUEUED
    assert loaded.progress == 0


def test_atomic_claim_prevents_two_workers_from_claiming_one_job(repository: JobRepository) -> None:
    created = repository.create_job(configuration())

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(repository.claim_next, ("worker-a", "worker-b")))

    claimed = [result for result in results if result is not None]
    assert len(claimed) == 1
    assert claimed[0].id == created.id
    assert repository.require(created.id).worker_id in {"worker-a", "worker-b"}


def test_queue_claims_jobs_in_creation_order(repository: JobRepository) -> None:
    created = [repository.create_job(configuration()) for _ in range(3)]

    claimed: list[str] = []
    for index in range(3):
        record = repository.claim_next(f"worker-{index}")
        assert record is not None
        claimed.append(record.id)
        assert repository.finish(
            record.id,
            f"worker-{index}",
            JobState.FAILED,
            error_code=JobErrorCode.RENDER_FAILED,
            error_message="fixture",
        )

    assert claimed == [record.id for record in created]


def test_terminal_compare_and_set_rejects_late_completion(repository: JobRepository) -> None:
    created = repository.create_job(configuration())
    repository.claim_next("worker-a")

    assert repository.finish(
        created.id,
        "worker-a",
        JobState.CANCELLED,
        error_code=JobErrorCode.CANCELLED,
        error_message="cancelled",
    )
    assert not repository.finish(
        created.id,
        "worker-a",
        JobState.COMPLETED,
        output_relpath=f"{created.id}/output/output.mp4",
    )
    assert repository.require(created.id).state == JobState.CANCELLED


def test_cancel_flag_wins_before_terminal_completion(repository: JobRepository) -> None:
    created = repository.create_job(configuration())
    repository.claim_next("worker-a")
    repository.request_cancel(created.id)

    assert not repository.finish(
        created.id,
        "worker-a",
        JobState.COMPLETED,
        output_relpath=f"{created.id}/output/output.mp4",
    )
    assert repository.finish(
        created.id,
        "worker-a",
        JobState.CANCELLED,
        error_code=JobErrorCode.CANCELLED,
        error_message="cancelled",
    )


def test_invalid_transitions_do_not_mutate_job(repository: JobRepository) -> None:
    created = repository.create_job(configuration())

    assert not repository.finish(
        created.id,
        "worker-a",
        JobState.COMPLETED,
        output_relpath=f"{created.id}/output/output.mp4",
    )
    with pytest.raises(ValueError):
        repository.finish(created.id, "worker-a", JobState.RUNNING)
    assert repository.require(created.id).state == JobState.QUEUED


def test_progress_only_accepts_current_worker(repository: JobRepository) -> None:
    created = repository.create_job(configuration())
    repository.claim_next("worker-a")

    assert not repository.update_progress(
        created.id, "worker-b", frame=2, total_frames=10, eta_seconds=3
    )
    assert repository.update_progress(
        created.id, "worker-a", frame=2, total_frames=10, eta_seconds=3
    )
    record = repository.require(created.id)
    assert record.frame == 2
    assert record.progress == pytest.approx(0.2)


def test_cancel_queued_job_is_terminal_and_cannot_be_claimed(repository: JobRepository) -> None:
    created = repository.create_job(configuration())

    cancelled = repository.request_cancel(created.id)

    assert cancelled is not None
    assert cancelled.state == JobState.CANCELLED
    assert repository.claim_next("worker-a") is None


def test_recovery_interrupts_running_jobs_but_not_queued_jobs(repository: JobRepository) -> None:
    running = repository.create_job(configuration())
    queued = repository.create_job(configuration())
    repository.claim_next("dead-worker")

    assert repository.recover_orphaned_running() == 1

    recovered = repository.require(running.id)
    assert recovered.state == JobState.INTERRUPTED
    assert recovered.error_code == JobErrorCode.INTERRUPTED
    assert repository.require(queued.id).state == JobState.QUEUED


def test_missing_completed_output_becomes_unavailable(repository: JobRepository) -> None:
    created = repository.create_job(configuration())
    repository.claim_next("worker-a")
    relative_output = f"{created.id}/output/output.mp4"
    assert repository.finish(
        created.id,
        "worker-a",
        JobState.COMPLETED,
        output_relpath=relative_output,
    )

    assert repository.reconcile_completed_outputs(lambda _path: False) == 1

    reconciled = repository.require(created.id)
    assert reconciled.state == JobState.COMPLETED
    assert reconciled.output_available is False
    assert reconciled.output_relpath == relative_output


def test_cleanup_marker_is_idempotent(repository: JobRepository) -> None:
    created = repository.create_job(configuration())
    repository.request_cancel(created.id)

    assert repository.mark_cleanup_done(created.id)
    assert not repository.mark_cleanup_done(created.id)


def test_repeated_cancel_polling_closes_every_sqlite_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = 0
    closed = 0
    real_connect = sqlite3.connect

    class TrackingConnection(sqlite3.Connection):
        def close(self) -> None:
            nonlocal closed
            closed += 1
            super().close()

    def tracking_connect(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal opened
        opened += 1
        return real_connect(*args, **kwargs, factory=TrackingConnection)

    monkeypatch.setattr(repository_module.sqlite3, "connect", tracking_connect)
    tracked = JobRepository(tmp_path / "tracked.sqlite3")
    tracked.initialize()
    created = tracked.create_job(configuration())
    assert tracked.claim_next("worker") is not None

    for _ in range(2_000):
        assert not tracked.is_cancel_requested(created.id, "worker")

    assert opened >= 2_000
    assert opened == closed
