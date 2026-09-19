from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import UploadFile

from app.render_jobs.storage import (
    AssetKind,
    InsufficientStorage,
    JobStorage,
    RenderAdmission,
    StorageError,
    UploadTooLarge,
)


@pytest.fixture
def storage(tmp_path: Path) -> JobStorage:
    result = JobStorage(
        tmp_path / "data",
        storage_ceiling_bytes=1024 * 1024,
        minimum_free_bytes=1,
    )
    result.initialize()
    return result


def test_job_paths_are_uuid_derived_and_client_filename_is_not_used(storage: JobStorage) -> None:
    job_id = str(uuid4())
    storage.create_job_directories(job_id)

    assert storage.asset_path(job_id, AssetKind.AUDIO).name == "audio.bin"
    assert storage.output_relative_path(job_id) == f"jobs/{job_id}/output/output.mp4"
    assert storage.safe_download_name("../../Song\r\nInjected", job_id).endswith(".mp4")
    assert "/" not in storage.safe_download_name("../../Song", job_id)


@pytest.mark.parametrize("job_id", ("../other", "not-a-uuid", "", "/tmp/value"))
def test_invalid_job_identity_is_rejected(storage: JobStorage, job_id: str) -> None:
    with pytest.raises(StorageError):
        storage.job_root(job_id)


def test_relative_output_cannot_escape_or_target_another_shape(storage: JobStorage) -> None:
    job_id = str(uuid4())
    with pytest.raises(StorageError):
        storage.resolve_output_relative("../../etc/passwd")
    with pytest.raises(StorageError):
        storage.resolve_output_relative(f"jobs/{job_id}/input/audio.bin")


def test_symlinked_job_directory_is_rejected(storage: JobStorage, tmp_path: Path) -> None:
    job_id = str(uuid4())
    outside = tmp_path / "outside"
    outside.mkdir()
    (storage.jobs_root / job_id).symlink_to(outside, target_is_directory=True)

    with pytest.raises(StorageError, match="escapes|symbolic"):
        storage.create_job_directories(job_id)


@pytest.mark.anyio
async def test_upload_streams_to_fixed_path_and_closes_file(storage: JobStorage) -> None:
    job_id = str(uuid4())
    upload = UploadFile(filename="../../hostile.mp3", file=BytesIO(b"audio-data"))

    path, size = await storage.save_upload(
        job_id, AssetKind.AUDIO, upload, max_bytes=100
    )

    assert path == storage.asset_path(job_id, AssetKind.AUDIO)
    assert path.read_bytes() == b"audio-data"
    assert size == 10
    assert upload.file.closed


@pytest.mark.anyio
async def test_oversized_upload_removes_partial_files(storage: JobStorage) -> None:
    job_id = str(uuid4())
    upload = UploadFile(filename="audio.wav", file=BytesIO(b"x" * 20))

    with pytest.raises(UploadTooLarge):
        await storage.save_upload(job_id, AssetKind.AUDIO, upload, max_bytes=10)

    assert not storage.asset_path(job_id, AssetKind.AUDIO).exists()
    assert not list(storage.job_root(job_id).rglob("*.part"))


@pytest.mark.anyio
async def test_upload_read_failure_removes_partial_files(storage: JobStorage) -> None:
    class FailingFile(BytesIO):
        def read(self, size: int = -1) -> bytes:
            if self.tell() > 0:
                raise OSError("disconnected")
            return super().read(4 if size < 0 else min(size, 4))

    job_id = str(uuid4())
    upload = UploadFile(filename="audio.wav", file=FailingFile(b"abcdefgh"))

    with pytest.raises(OSError, match="disconnected"):
        await storage.save_upload(
            job_id, AssetKind.AUDIO, upload, max_bytes=100, chunk_bytes=4
        )

    assert not storage.asset_path(job_id, AssetKind.AUDIO).exists()
    assert not list(storage.job_root(job_id).rglob("*.part"))


def test_capacity_is_checked_before_accepting_more_bytes(tmp_path: Path) -> None:
    storage = JobStorage(
        tmp_path / "data",
        storage_ceiling_bytes=4,
        minimum_free_bytes=1,
    )
    storage.initialize()
    job_id = str(uuid4())
    storage.create_job_directories(job_id)
    storage.asset_path(job_id, AssetKind.AUDIO).write_bytes(b"1234")

    with pytest.raises(InsufficientStorage):
        storage.ensure_capacity(additional_bytes=1)


def test_queue_admission_rejects_before_upload(storage: JobStorage) -> None:
    admission = RenderAdmission(storage, active_count=lambda: 2, max_queue_depth=2)

    with pytest.raises(InsufficientStorage, match="queue"):
        admission.check(additional_bytes=1)


def test_terminal_cleanup_is_idempotent_and_preserves_completed_output(storage: JobStorage) -> None:
    job_id = str(uuid4())
    storage.create_job_directories(job_id)
    storage.asset_path(job_id, AssetKind.AUDIO).write_bytes(b"audio")
    storage.work_path(job_id, "output.part.mp4").write_bytes(b"partial")
    storage.output_path(job_id).write_bytes(b"complete")

    storage.cleanup_terminal(job_id, preserve_output=True)
    storage.cleanup_terminal(job_id, preserve_output=True)

    assert not (storage.job_root(job_id) / "input").exists()
    assert not (storage.job_root(job_id) / "work").exists()
    assert storage.output_path(job_id).read_bytes() == b"complete"


def test_deleting_one_job_never_removes_another(storage: JobStorage) -> None:
    first, second = str(uuid4()), str(uuid4())
    for job_id in (first, second):
        storage.create_job_directories(job_id)
        storage.output_path(job_id).write_bytes(job_id.encode())

    storage.delete_job(first)

    assert not storage.job_root(first).exists()
    assert storage.output_path(second).exists()
