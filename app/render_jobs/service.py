"""Application service composing render job persistence, storage and validation."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile
from pydantic import ValidationError

from app.config import Settings

from .lifecycle import JobLifecycle
from .models import (
    JobError,
    JobErrorCode,
    JobState,
    RenderCapabilitiesResponse,
    RenderConfiguration,
    RenderJobResponse,
    TERMINAL_JOB_STATES,
)
from .repository import JobRecord, JobRepository
from .storage import (
    AssetKind,
    InsufficientStorage,
    JobStorage,
    RenderAdmission,
    StorageError,
    UploadTooLarge,
)
from .validation import MediaValidationError, MediaValidator, ffprobe_json


class RenderServiceError(RuntimeError):
    def __init__(self, status_code: int, code: JobErrorCode, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True, slots=True)
class WorkerStatus:
    ready: bool
    reason: str | None = None


class WorkerReadiness:
    def __init__(self, ready: bool = False, reason: str | None = "Render worker is starting.") -> None:
        self._status = WorkerStatus(ready, reason)
        self._lock = threading.Lock()

    def get(self) -> WorkerStatus:
        with self._lock:
            return self._status

    def set(self, ready: bool, reason: str | None = None) -> None:
        with self._lock:
            self._status = WorkerStatus(ready, reason)


class RenderJobService:
    def __init__(
        self,
        settings: Settings,
        *,
        repository: JobRepository | None = None,
        storage: JobStorage | None = None,
        validator: MediaValidator | None = None,
        readiness: WorkerReadiness | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository or JobRepository(settings.data_root / "jobs.sqlite3")
        self.storage = storage or JobStorage(
            settings.data_root,
            storage_ceiling_bytes=settings.storage_ceiling_bytes,
            minimum_free_bytes=settings.minimum_free_bytes,
        )
        self.validator = validator or MediaValidator(
            probe=lambda path: ffprobe_json(path, settings.ffprobe_path)
        )
        self.readiness = readiness or WorkerReadiness(
            ready=False,
            reason="Embedded render worker is disabled." if not settings.worker_enabled else "Render worker is starting.",
        )
        self.lifecycle = JobLifecycle(self.repository, self.storage)
        self.admission = RenderAdmission(
            self.storage,
            active_count=self.repository.count_active,
            max_queue_depth=settings.max_queue_depth,
        )
        self.initialized = False

    def initialize(self) -> None:
        self.storage.initialize()
        self.repository.initialize()
        self.repository.recover_orphaned_running()
        self.repository.reconcile_completed_outputs(
            lambda relative: self._safe_output_exists(relative)
        )
        # Recovery terminalizes orphaned work in the database first, then the
        # same idempotent lifecycle used by live workers removes source assets
        # and partial output before the service accepts requests.
        for record in self.repository.iter_jobs():
            if record.state in TERMINAL_JOB_STATES and not record.cleanup_done:
                self.lifecycle.cleanup_terminal(record.id)
        self.initialized = True

    def _safe_output_exists(self, relative: str) -> bool:
        try:
            return self.storage.resolve_output_relative(relative).is_file()
        except StorageError:
            return False

    def capabilities(self) -> RenderCapabilitiesResponse:
        status = self.readiness.get()
        return RenderCapabilitiesResponse(
            ready=status.ready,
            reason=status.reason,
            video_codec=self.settings.video_encoder,
        )

    async def create(
        self,
        *,
        config_json: str,
        audio: UploadFile,
        cover: UploadFile | None = None,
        background: UploadFile | None = None,
        subtitles: UploadFile | None = None,
    ) -> RenderJobResponse:
        status = self.readiness.get()
        if not status.ready:
            raise RenderServiceError(
                503,
                JobErrorCode.WORKER_UNAVAILABLE,
                status.reason or "Render worker is unavailable.",
            )
        try:
            configuration = RenderConfiguration.model_validate_json(config_json)
        except ValidationError as error:
            raise RenderServiceError(422, JobErrorCode.INVALID_REQUEST, "Render configuration is invalid.") from error
        try:
            self.admission.check()
        except InsufficientStorage as error:
            raise RenderServiceError(507, JobErrorCode.CAPACITY_EXCEEDED, str(error)) from error

        job_id = str(uuid.uuid4())
        upload_metadata = {
            AssetKind.AUDIO: (audio.filename or "audio", audio.content_type or ""),
        }
        uploads: list[tuple[AssetKind, UploadFile, int]] = [
            (AssetKind.AUDIO, audio, self.settings.max_audio_bytes)
        ]
        for kind, upload, limit in (
            (AssetKind.COVER, cover, self.settings.max_image_bytes),
            (AssetKind.BACKGROUND, background, self.settings.max_image_bytes),
            (AssetKind.SUBTITLES, subtitles, self.settings.max_subtitle_bytes),
        ):
            if upload is not None:
                upload_metadata[kind] = (upload.filename or kind.value, upload.content_type or "")
                uploads.append((kind, upload, limit))

        try:
            for kind, upload, limit in uploads:
                await self.storage.save_upload(job_id, kind, upload, max_bytes=limit)
            audio_name, audio_type = upload_metadata[AssetKind.AUDIO]
            self.validator.validate_audio(
                self.storage.asset_path(job_id, AssetKind.AUDIO),
                original_filename=audio_name,
                content_type=audio_type,
            )
            for kind in (AssetKind.COVER, AssetKind.BACKGROUND):
                if kind in upload_metadata:
                    _name, content_type = upload_metadata[kind]
                    self.validator.validate_image(
                        self.storage.asset_path(job_id, kind), content_type=content_type
                    )
            if AssetKind.SUBTITLES in upload_metadata:
                self.validator.validate_subtitles(
                    self.storage.asset_path(job_id, AssetKind.SUBTITLES)
                )
            record = self.repository.create_job(configuration, job_id=job_id)
        except UploadTooLarge as error:
            self.storage.delete_job(job_id)
            raise RenderServiceError(413, JobErrorCode.INVALID_REQUEST, str(error)) from error
        except InsufficientStorage as error:
            self.storage.delete_job(job_id)
            raise RenderServiceError(507, JobErrorCode.CAPACITY_EXCEEDED, str(error)) from error
        except MediaValidationError as error:
            self.storage.delete_job(job_id)
            code = {
                "invalid_audio": JobErrorCode.INVALID_AUDIO,
                "invalid_image": JobErrorCode.INVALID_IMAGE,
                "invalid_subtitles": JobErrorCode.INVALID_SUBTITLES,
            }.get(error.code, JobErrorCode.INVALID_REQUEST)
            raise RenderServiceError(422, code, str(error)) from error
        except BaseException:
            self.storage.delete_job(job_id)
            raise
        return self.to_response(record)

    def status(self, job_id: str) -> RenderJobResponse:
        record = self._require(job_id)
        if record.state == JobState.COMPLETED and record.output_available:
            if not record.output_relpath or not self._safe_output_exists(record.output_relpath):
                self.repository.mark_output_unavailable(record.id)
                record = self.repository.require(record.id)
        return self.to_response(record)

    def cancel(self, job_id: str) -> RenderJobResponse:
        record = self._require(job_id)
        updated = self.repository.request_cancel(record.id)
        assert updated is not None
        if updated.state == JobState.CANCELLED:
            updated = self.lifecycle.cleanup_terminal(updated.id)
        return self.to_response(updated)

    def delete_output(self, job_id: str) -> RenderJobResponse:
        try:
            return self.to_response(self.lifecycle.delete_output(self._require(job_id).id))
        except ValueError as error:
            raise RenderServiceError(409, JobErrorCode.OUTPUT_UNAVAILABLE, str(error)) from error

    def delete_job(self, job_id: str) -> None:
        record = self._require(job_id)
        if record.state in {JobState.QUEUED, JobState.RUNNING}:
            cancelled = self.repository.request_cancel(record.id)
            if cancelled is not None and cancelled.state == JobState.CANCELLED:
                self.lifecycle.cleanup_terminal(record.id)
            else:
                raise RenderServiceError(
                    409,
                    JobErrorCode.CANCELLED,
                    "Render cancellation is pending; retry deletion after it stops.",
                )
        self.lifecycle.delete_job(record.id)

    def output_path(self, job_id: str) -> tuple[Path, str]:
        record = self._require(job_id)
        if record.state != JobState.COMPLETED or not record.output_available or not record.output_relpath:
            raise RenderServiceError(404, JobErrorCode.OUTPUT_UNAVAILABLE, "Render output is unavailable.")
        try:
            path = self.storage.resolve_output_relative(record.output_relpath)
        except StorageError as error:
            raise RenderServiceError(404, JobErrorCode.OUTPUT_UNAVAILABLE, "Render output is unavailable.") from error
        if not path.is_file():
            self.repository.mark_output_unavailable(record.id)
            raise RenderServiceError(404, JobErrorCode.OUTPUT_UNAVAILABLE, "Render output is unavailable.")
        return path, self.storage.safe_download_name(record.configuration.text.title, record.id)

    def _require(self, job_id: str) -> JobRecord:
        record = self.repository.get(job_id)
        if record is None:
            raise RenderServiceError(404, JobErrorCode.INVALID_REQUEST, "Render job was not found.")
        return record

    @staticmethod
    def to_response(record: JobRecord) -> RenderJobResponse:
        error = None
        if record.error_code and record.error_message:
            error = JobError(code=record.error_code, message=record.error_message)
        return RenderJobResponse(
            id=record.id,
            state=record.state,
            progress=record.progress,
            frame=record.frame,
            total_frames=record.total_frames,
            eta_seconds=record.eta_seconds,
            output_available=record.output_available,
            output_url=f"/api/render-jobs/{record.id}/output" if record.output_available else None,
            error=error,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
