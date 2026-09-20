"""Durable render worker and embedded single-process supervisor."""

from __future__ import annotations

import logging
import math
import multiprocessing
import threading
import time
import uuid
from collections.abc import Callable
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Protocol

from .audio import AudioAnalysisError, analyze_audio
from .encoder import RenderCancelled, StreamingEncoder
from .frames import FramePlan, ParallelFrameSource
from .lifecycle import JobLifecycle
from .models import JobErrorCode, JobState
from .preflight import EncoderProbe, update_worker_readiness
from .process import ProcessAdapterError
from .repository import JobRecord, JobRepository
from .scene import FontBook
from .scenes import create_scene, load_scene_assets
from .service import WorkerReadiness
from .storage import AssetKind, JobStorage
from .validation import MediaValidationError, ffprobe_json


LOGGER = logging.getLogger(__name__)


class StopSignal(Protocol):
    def is_set(self) -> bool: ...

    def wait(self, timeout: float) -> bool: ...


ExecuteJob = Callable[[JobRecord, str, Callable[[], bool], Callable[[int, int, float | None], None]], str]


class RenderWorker:
    def __init__(
        self,
        repository: JobRepository,
        lifecycle: JobLifecycle,
        execute: ExecuteJob,
        *,
        worker_id: str | None = None,
    ) -> None:
        self.repository = repository
        self.lifecycle = lifecycle
        self.execute = execute
        self.worker_id = worker_id or f"worker-{uuid.uuid4()}"

    def run_once(self, stop: StopSignal | None = None) -> bool:
        record = self.repository.claim_next(self.worker_id)
        if record is None:
            return False

        last_cancel_poll = float("-inf")
        cancel_requested = False
        last_progress_write = float("-inf")

        def user_cancelled() -> bool:
            return self.repository.is_cancel_requested(
                record.id, self.worker_id
            )

        def cancelled() -> bool:
            nonlocal last_cancel_poll, cancel_requested
            if stop and stop.is_set():
                return True
            if cancel_requested:
                return True
            now = time.monotonic()
            if now - last_cancel_poll >= 0.1:
                cancel_requested = user_cancelled()
                last_cancel_poll = now
            return cancel_requested

        def progress(frame: int, total: int, eta: float | None) -> None:
            nonlocal last_progress_write
            now = time.monotonic()
            if frame < total and now - last_progress_write < 0.25:
                return
            self.repository.update_progress(
                record.id,
                self.worker_id,
                frame=frame,
                total_frames=total,
                eta_seconds=eta,
            )
            last_progress_write = now

        try:
            output_relpath = self.execute(record, self.worker_id, cancelled, progress)
            # Force one authoritative database read at the publication
            # boundary so a request received inside the polling interval still
            # wins over a late completion.
            if bool(stop and stop.is_set()) or user_cancelled():
                self._discard_output(record)
                if user_cancelled():
                    self._finish_cancelled(record)
                else:
                    self._finish_interrupted(record)
            elif not self.repository.finish(
                record.id,
                self.worker_id,
                JobState.COMPLETED,
                output_relpath=output_relpath,
            ):
                # A cancel request can win after output publication but before
                # the completion CAS. Never expose that late output.
                current = self.repository.require(record.id)
                if current.state == JobState.RUNNING and current.cancel_requested:
                    self._discard_output(record)
                    self._finish_cancelled(record)
        except RenderCancelled:
            self._discard_output(record)
            if user_cancelled():
                self._finish_cancelled(record)
            else:
                self._finish_interrupted(record)
        except ProcessAdapterError as error:
            self._finish_failure(
                record,
                error.code,
                str(error),
                interrupted=bool(stop and stop.is_set()),
            )
        except (AudioAnalysisError, MediaValidationError) as error:
            self._finish_failure(
                record,
                JobErrorCode.DECODE_FAILED,
                str(error),
                interrupted=bool(stop and stop.is_set()),
            )
        except OSError:
            self._finish_failure(
                record,
                JobErrorCode.STORAGE_FAILED,
                "Render storage operation failed.",
                interrupted=bool(stop and stop.is_set()),
            )
        except Exception:
            LOGGER.exception("render job %s failed", record.id)
            self._finish_failure(
                record,
                JobErrorCode.RENDER_FAILED,
                "Server scene rendering failed.",
                interrupted=bool(stop and stop.is_set()),
            )

        current = self.repository.require(record.id)
        if current.state in {
            JobState.COMPLETED,
            JobState.CANCELLED,
            JobState.FAILED,
            JobState.INTERRUPTED,
        }:
            try:
                self.lifecycle.cleanup_terminal(record.id)
            except OSError:
                LOGGER.exception("terminal cleanup failed for render job %s", record.id)
        return True

    def run(self, stop: StopSignal, *, poll_seconds: float) -> None:
        while not stop.is_set():
            if not self.run_once(stop):
                stop.wait(poll_seconds)

    def _finish_cancelled(self, record: JobRecord) -> None:
        self.repository.finish(
            record.id,
            self.worker_id,
            JobState.CANCELLED,
            error_code=JobErrorCode.CANCELLED,
            error_message="Render cancelled by the user.",
        )

    def _finish_failure(
        self,
        record: JobRecord,
        code: JobErrorCode,
        message: str,
        *,
        interrupted: bool = False,
    ) -> None:
        if self.repository.is_cancel_requested(record.id, self.worker_id):
            self._finish_cancelled(record)
            return
        if interrupted:
            self._finish_interrupted(record)
            return
        self.repository.finish(
            record.id,
            self.worker_id,
            JobState.FAILED,
            error_code=code,
            error_message=message[:1_000],
        )

    def _finish_interrupted(self, record: JobRecord) -> None:
        self.repository.finish(
            record.id,
            self.worker_id,
            JobState.INTERRUPTED,
            error_code=JobErrorCode.INTERRUPTED,
            error_message="Render worker stopped before completion.",
        )

    def _discard_output(self, record: JobRecord) -> None:
        storage = self.lifecycle.storage
        storage.output_path(record.id).unlink(missing_ok=True)
        storage.work_path(record.id, "output.part.mp4").unlink(missing_ok=True)


class JobRenderer:
    """Compose audio analysis, Pillow scene frames and FFmpeg encoding."""

    def __init__(self, settings, storage: JobStorage) -> None:  # settings kept untyped for spawn safety
        self.settings = settings
        self.storage = storage
        self.encoder = StreamingEncoder.from_binary(settings.ffmpeg_path)

    def __call__(
        self,
        record: JobRecord,
        _worker_id: str,
        cancelled: Callable[[], bool],
        progress: Callable[[int, int, float | None], None],
    ) -> str:
        audio_path = self.storage.asset_path(record.id, AssetKind.AUDIO)
        duration = _audio_duration(
            audio_path, self.settings.ffprobe_path, cancelled=cancelled
        )
        if cancelled():
            raise RenderCancelled("Render cancellation was requested.")
        analysis = analyze_audio(
            audio_path,
            duration=duration,
            ffmpeg_path=self.settings.ffmpeg_path,
            temporal_rate=record.configuration.output.frame_rate,
            cancelled=cancelled,
        )
        cover_path = self.storage.asset_path(record.id, AssetKind.COVER)
        background_path = self.storage.asset_path(record.id, AssetKind.BACKGROUND)
        scene = create_scene(
            record.configuration,
            load_scene_assets(
                cover_path if cover_path.is_file() else None,
                background_path if background_path.is_file() else None,
            ),
            FontBook(self.settings.font_path),
            output_mode=self.encoder.frame_mode,
        )
        output = record.configuration.output
        total_frames = max(1, math.ceil(duration * output.frame_rate))

        started = time.monotonic()
        with ParallelFrameSource(
            scene,
            analysis,
            FramePlan(
                total_frames=total_frames,
                width=output.width,
                height=output.height,
                frame_rate=output.frame_rate,
                mode=self.encoder.frame_mode,
            ),
            workers=self.settings.frame_workers,
            cancelled=cancelled,
        ) as frames:
            ordered_frames = frames.prime()
            self.encoder.encode(
                ordered_frames,
                output,
                audio_path=audio_path,
                partial_path=self.storage.work_path(record.id, "output.part.mp4"),
                final_path=self.storage.output_path(record.id),
                duration=duration,
                total_frames=total_frames,
                cancelled=cancelled,
                progress=progress,
            )
        elapsed = max(0.001, time.monotonic() - started)
        LOGGER.info(
            "render job %s produced %d frames with %d frame workers in %.2fs (%.2f fps)",
            record.id,
            total_frames,
            self.settings.frame_workers,
            elapsed,
            total_frames / elapsed,
        )
        return self.storage.output_relative_path(record.id)


def _audio_duration(
    path: Path,
    ffprobe_path: str,
    *,
    cancelled: Callable[[], bool],
) -> float:
    payload = ffprobe_json(path, ffprobe_path, cancelled=cancelled)
    streams = payload.get("streams") or []
    audio = next(
        (stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"),
        {},
    )
    raw = (payload.get("format") or {}).get("duration") or audio.get("duration")
    try:
        duration = float(raw)
    except (TypeError, ValueError) as error:
        raise MediaValidationError("invalid_audio", "Audio duration is unavailable.") from error
    if not math.isfinite(duration) or duration <= 0:
        raise MediaValidationError("invalid_audio", "Audio duration is invalid.")
    return duration


def worker_process_main(settings, stop: StopSignal) -> None:  # pragma: no cover - exercised through supervisor
    repository = JobRepository(settings.data_root / "jobs.sqlite3")
    storage = JobStorage(
        settings.data_root,
        storage_ceiling_bytes=settings.storage_ceiling_bytes,
        minimum_free_bytes=settings.minimum_free_bytes,
    )
    storage.initialize()
    repository.initialize()
    worker = RenderWorker(
        repository,
        JobLifecycle(repository, storage),
        JobRenderer(settings, storage),
    )
    worker.run(stop, poll_seconds=settings.worker_poll_ms / 1_000)


class WorkerSupervisor:
    """Own exactly one independent worker process for the embedded deployment."""

    def __init__(
        self,
        settings,
        readiness: WorkerReadiness,
        *,
        process_target=worker_process_main,
        probe: EncoderProbe | None = None,
    ) -> None:
        self.settings = settings
        self.readiness = readiness
        self.process_target = process_target
        self.probe = probe
        self._context = multiprocessing.get_context("spawn")
        self._stop = self._context.Event()
        self._process: BaseProcess | None = None
        self._monitor: threading.Thread | None = None
        self._stopping = threading.Event()

    def start(self) -> bool:
        probe = self.probe or EncoderProbe.from_paths(
            self.settings.data_root / "probe",
            ffmpeg_path=self.settings.ffmpeg_path,
            ffprobe_path=self.settings.ffprobe_path,
        )
        if not update_worker_readiness(probe, self.readiness).ready:
            return False
        self._process = self._context.Process(
            target=self.process_target,
            args=(self.settings, self._stop),
            name="music-visualizer-render-worker",
        )
        try:
            self._process.start()
        except BaseException:
            self.readiness.set(False, "Render worker could not start.")
            raise
        self._monitor = threading.Thread(
            target=self._monitor_process,
            name="render-worker-supervisor",
            daemon=True,
        )
        self._monitor.start()
        return True

    def stop(self, *, timeout: float = 10) -> None:
        self._stopping.set()
        self.readiness.set(False, "Render worker is stopping.")
        self._stop.set()
        process = self._process
        if process is not None:
            process.join(timeout)
            if process.is_alive():
                process.terminate()
                process.join(timeout=2)
        if self._monitor is not None:
            self._monitor.join(timeout=2)

    def _monitor_process(self) -> None:
        process = self._process
        if process is None:
            return
        process.join()
        if not self._stopping.is_set():
            self.readiness.set(False, "Render worker stopped unexpectedly.")
