from pathlib import Path
from uuid import uuid4

import pytest

from app.render_jobs.lifecycle import JobLifecycle
from app.render_jobs.models import JobErrorCode, JobState, RenderConfiguration
from app.render_jobs.repository import JobRepository
from app.render_jobs.storage import AssetKind, JobStorage


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
def services(tmp_path: Path) -> tuple[JobRepository, JobStorage, JobLifecycle]:
    repository = JobRepository(tmp_path / "data" / "jobs.sqlite3")
    repository.initialize()
    storage = JobStorage(
        tmp_path / "data", storage_ceiling_bytes=1024 * 1024, minimum_free_bytes=1
    )
    storage.initialize()
    return repository, storage, JobLifecycle(repository, storage)


def create_completed(
    repository: JobRepository, storage: JobStorage
) -> str:
    job_id = str(uuid4())
    storage.create_job_directories(job_id)
    storage.asset_path(job_id, AssetKind.AUDIO).write_bytes(b"audio")
    storage.work_path(job_id, "output.part.mp4").write_bytes(b"partial")
    storage.output_path(job_id).write_bytes(b"complete")
    repository.create_job(configuration(), job_id=job_id)
    repository.claim_next("worker")
    repository.finish(
        job_id,
        "worker",
        JobState.COMPLETED,
        output_relpath=storage.output_relative_path(job_id),
    )
    return job_id


def test_terminal_cleanup_preserves_completed_output_and_is_repeatable(services) -> None:
    repository, storage, lifecycle = services
    job_id = create_completed(repository, storage)

    lifecycle.cleanup_terminal(job_id)
    lifecycle.cleanup_terminal(job_id)

    assert storage.output_path(job_id).read_bytes() == b"complete"
    assert repository.require(job_id).cleanup_done
    assert not storage.asset_path(job_id, AssetKind.AUDIO).exists()


@pytest.mark.parametrize(
    ("state", "error_code"),
    (
        (JobState.CANCELLED, JobErrorCode.CANCELLED),
        (JobState.FAILED, JobErrorCode.RENDER_FAILED),
        (JobState.INTERRUPTED, JobErrorCode.INTERRUPTED),
    ),
)
def test_non_completed_terminal_cleanup_removes_partial_output(
    services, state: JobState, error_code: JobErrorCode
) -> None:
    repository, storage, lifecycle = services
    job_id = str(uuid4())
    storage.create_job_directories(job_id)
    storage.asset_path(job_id, AssetKind.AUDIO).write_bytes(b"audio")
    storage.work_path(job_id, "output.part.mp4").write_bytes(b"partial")
    repository.create_job(configuration(), job_id=job_id)
    repository.claim_next("worker")
    repository.finish(
        job_id,
        "worker",
        state,
        error_code=error_code,
        error_message=state.value,
    )

    lifecycle.cleanup_terminal(job_id)

    assert not storage.job_root(job_id).exists()
    assert repository.require(job_id).cleanup_done


def test_explicit_output_delete_updates_record_after_filesystem(services) -> None:
    repository, storage, lifecycle = services
    job_id = create_completed(repository, storage)
    lifecycle.cleanup_terminal(job_id)

    record = lifecycle.delete_output(job_id)

    assert record.state == JobState.COMPLETED
    assert record.output_available is False
    assert not storage.output_path(job_id).exists()


def test_explicit_job_delete_removes_terminal_record_and_files(services) -> None:
    repository, storage, lifecycle = services
    job_id = create_completed(repository, storage)

    lifecycle.delete_job(job_id)

    assert repository.get(job_id) is None
    assert not storage.job_root(job_id).exists()


def test_active_job_cannot_be_deleted(services) -> None:
    repository, storage, lifecycle = services
    job_id = str(uuid4())
    storage.create_job_directories(job_id)
    repository.create_job(configuration(), job_id=job_id)

    with pytest.raises(ValueError, match="cancelled"):
        lifecycle.delete_job(job_id)

    assert repository.get(job_id) is not None
