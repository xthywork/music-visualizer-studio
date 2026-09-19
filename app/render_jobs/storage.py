"""Filesystem isolation and bounded upload handling for render jobs."""

from __future__ import annotations

import os
import shutil
import uuid
from enum import StrEnum
from pathlib import Path
from typing import Callable

from fastapi import UploadFile


class StorageError(RuntimeError):
    pass


class UploadTooLarge(StorageError):
    pass


class InsufficientStorage(StorageError):
    pass


class AssetKind(StrEnum):
    AUDIO = "audio"
    COVER = "cover"
    BACKGROUND = "background"
    SUBTITLES = "subtitles"


_ASSET_FILENAMES: dict[AssetKind, str] = {
    AssetKind.AUDIO: "audio.bin",
    AssetKind.COVER: "cover.bin",
    AssetKind.BACKGROUND: "background.bin",
    AssetKind.SUBTITLES: "subtitles.srt",
}


class RenderAdmission:
    def __init__(
        self,
        storage: "JobStorage",
        *,
        active_count: Callable[[], int],
        max_queue_depth: int,
    ) -> None:
        self.storage = storage
        self.active_count = active_count
        self.max_queue_depth = max_queue_depth

    def check(self, *, additional_bytes: int = 0) -> None:
        if self.active_count() >= self.max_queue_depth:
            raise InsufficientStorage("render queue capacity has been reached")
        self.storage.ensure_capacity(additional_bytes=additional_bytes)


class JobStorage:
    def __init__(
        self,
        root: Path,
        *,
        storage_ceiling_bytes: int,
        minimum_free_bytes: int,
    ) -> None:
        self.root = root.expanduser().resolve()
        self.jobs_root = self.root / "jobs"
        self.storage_ceiling_bytes = storage_ceiling_bytes
        self.minimum_free_bytes = minimum_free_bytes

    def initialize(self) -> None:
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink() or self.jobs_root.is_symlink():
            raise StorageError("render storage root must not be a symbolic link")

    @staticmethod
    def normalize_job_id(job_id: str) -> str:
        try:
            return str(uuid.UUID(job_id))
        except (ValueError, AttributeError) as error:
            raise StorageError("invalid job id") from error

    def job_root(self, job_id: str) -> Path:
        identifier = self.normalize_job_id(job_id)
        candidate = self.jobs_root / identifier
        self._assert_contained(candidate, self.jobs_root)
        if candidate.is_symlink():
            raise StorageError("job directory must not be a symbolic link")
        return candidate

    def create_job_directories(self, job_id: str) -> Path:
        root = self.job_root(job_id)
        for area in ("input", "work", "output"):
            directory = root / area
            self._assert_contained(directory, root)
            directory.mkdir(parents=True, exist_ok=True)
            if directory.is_symlink():
                raise StorageError("job area must not be a symbolic link")
        return root

    def asset_path(self, job_id: str, kind: AssetKind) -> Path:
        root = self.job_root(job_id)
        candidate = root / "input" / _ASSET_FILENAMES[kind]
        self._assert_contained(candidate, root)
        return candidate

    def work_path(self, job_id: str, filename: str) -> Path:
        if filename not in {"output.part.mp4", "nvenc-probe.mp4"}:
            raise StorageError("unsupported work filename")
        root = self.job_root(job_id)
        candidate = root / "work" / filename
        self._assert_contained(candidate, root)
        return candidate

    def output_path(self, job_id: str) -> Path:
        root = self.job_root(job_id)
        candidate = root / "output" / "output.mp4"
        self._assert_contained(candidate, root)
        return candidate

    def output_relative_path(self, job_id: str) -> str:
        return self.output_path(job_id).relative_to(self.root).as_posix()

    def resolve_output_relative(self, relative: str) -> Path:
        candidate = (self.root / relative).resolve(strict=False)
        self._assert_contained(candidate, self.jobs_root)
        parts = candidate.relative_to(self.jobs_root).parts
        if len(parts) != 3 or parts[1:] != ("output", "output.mp4"):
            raise StorageError("invalid output identity")
        self.normalize_job_id(parts[0])
        return candidate

    async def save_upload(
        self,
        job_id: str,
        kind: AssetKind,
        upload: UploadFile,
        *,
        max_bytes: int,
        chunk_bytes: int = 1024 * 1024,
    ) -> tuple[Path, int]:
        self.create_job_directories(job_id)
        destination = self.asset_path(job_id, kind)
        partial = destination.with_suffix(destination.suffix + ".part")
        self._assert_contained(partial, self.job_root(job_id))
        partial.unlink(missing_ok=True)
        written = 0
        try:
            with partial.open("xb") as stream:
                while chunk := await upload.read(chunk_bytes):
                    written += len(chunk)
                    if written > max_bytes:
                        raise UploadTooLarge(f"{kind.value} upload exceeds its byte limit")
                    self.ensure_capacity(additional_bytes=len(chunk))
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            if written == 0:
                raise StorageError(f"{kind.value} upload is empty")
            os.replace(partial, destination)
            return destination, written
        except BaseException:
            partial.unlink(missing_ok=True)
            destination.unlink(missing_ok=True)
            raise
        finally:
            await upload.close()

    def ensure_capacity(self, *, additional_bytes: int = 0) -> None:
        usage = self.usage_bytes()
        free = shutil.disk_usage(self.root).free
        if usage + additional_bytes > self.storage_ceiling_bytes:
            raise InsufficientStorage("render storage ceiling would be exceeded")
        if free - additional_bytes < self.minimum_free_bytes:
            raise InsufficientStorage("render storage minimum free space would be violated")

    def usage_bytes(self) -> int:
        total = 0
        if not self.jobs_root.exists():
            return total
        for path in self.jobs_root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        return total

    def cleanup_terminal(self, job_id: str, *, preserve_output: bool) -> None:
        root = self.job_root(job_id)
        if not root.exists():
            return
        for area in ("input", "work"):
            target = root / area
            self._assert_contained(target, root)
            if target.is_symlink():
                raise StorageError("refusing to clean a symbolic-link job area")
            shutil.rmtree(target, ignore_errors=False) if target.exists() else None
        if not preserve_output:
            output = root / "output"
            self._assert_contained(output, root)
            if output.is_symlink():
                raise StorageError("refusing to clean a symbolic-link output area")
            shutil.rmtree(output, ignore_errors=False) if output.exists() else None
        self._remove_empty_job_root(root)

    def delete_output(self, job_id: str) -> None:
        output = self.job_root(job_id) / "output"
        self._assert_contained(output, self.job_root(job_id))
        if output.is_symlink():
            raise StorageError("refusing to delete a symbolic-link output area")
        if output.exists():
            shutil.rmtree(output)
        self._remove_empty_job_root(self.job_root(job_id))

    def delete_job(self, job_id: str) -> None:
        root = self.job_root(job_id)
        if root.exists():
            if root.is_symlink():
                raise StorageError("refusing to delete a symbolic-link job directory")
            shutil.rmtree(root)

    @staticmethod
    def safe_download_name(title: str, job_id: str) -> str:
        cleaned = "".join(character for character in title if character.isalnum() or character in " -_").strip()
        return f"{cleaned or 'music-visualizer'}-{job_id[:8]}.mp4"

    @staticmethod
    def _assert_contained(candidate: Path, root: Path) -> None:
        resolved_root = root.resolve(strict=False)
        resolved_candidate = candidate.resolve(strict=False)
        try:
            resolved_candidate.relative_to(resolved_root)
        except ValueError as error:
            raise StorageError("path escapes render storage") from error

    @staticmethod
    def _remove_empty_job_root(root: Path) -> None:
        if not root.exists() or root.is_symlink():
            return
        for directory in (root / "input", root / "work", root / "output"):
            if directory.exists() and directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
        if not any(root.iterdir()):
            root.rmdir()
