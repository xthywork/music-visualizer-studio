"""Bounded raw-frame streaming into the server's MP4 encoder."""

from __future__ import annotations

import math
import os
import selectors
import subprocess
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Protocol

from PIL import Image

from .models import JobErrorCode, OutputConfiguration
from .process import ManagedProcess, ProcessAdapter, ProcessAdapterError


class RenderCancelled(RuntimeError):
    pass


class EncoderRunner(Protocol):
    def spawn(
        self,
        arguments: list[str],
        *,
        stdin: int = subprocess.PIPE,
        stdout: int = subprocess.DEVNULL,
    ) -> ManagedProcess: ...


def video_bitrate(output: OutputConfiguration) -> str:
    pixels = output.width * output.height
    if pixels <= 1280 * 720:
        base = 8
    elif pixels <= 1920 * 1080:
        base = 14
    else:
        base = 40
    if output.frame_rate == 60:
        base = round(base * 1.5)
    return f"{base}M"


def encoder_arguments(
    output: OutputConfiguration,
    *,
    audio_path: Path,
    partial_path: Path,
    duration: float,
    encoder: str = "h264_nvenc",
) -> list[str]:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be positive and finite")
    bitrate = video_bitrate(output)
    uses_nvenc = encoder.endswith("_nvenc")
    input_pixel_format = "rgba" if uses_nvenc else "rgb24"
    # NVENC and libx264 use different preset namespaces.  The software
    # integration path must not inherit the production-only NVENC `p4` value.
    preset = "p4" if uses_nvenc else "veryfast"
    arguments = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "rawvideo",
        "-pix_fmt",
        input_pixel_format,
        "-video_size",
        f"{output.width}x{output.height}",
        "-framerate",
        str(output.frame_rate),
        "-i",
        "pipe:0",
        "-i",
        str(audio_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        encoder,
        "-preset",
        preset,
        "-profile:v",
        "high",
        "-b:v",
        bitrate,
        "-maxrate",
        bitrate,
        "-bufsize",
        f"{int(bitrate[:-1]) * 2}M",
    ]
    if uses_nvenc:
        # Packed RGBA is accepted directly by NVENC. Its RGB mode performs the
        # 4:2:0 conversion on the GPU instead of making FFmpeg run swscale on
        # the CPU before every encoded frame.
        arguments.extend(["-rgb_mode", "yuv420"])
    else:
        arguments.extend(["-pix_fmt", "yuv420p"])
    arguments.extend([
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        f"{duration:.6f}",
        "-movflags",
        "+faststart",
        "-y",
        str(partial_path),
    ])
    return arguments


class StreamingEncoder:
    """Write exactly one raw frame at a time and atomically publish the MP4."""

    def __init__(
        self,
        runner: EncoderRunner,
        *,
        encoder: str = "h264_nvenc",
        pipe_poll_seconds: float = 0.1,
    ) -> None:
        self.runner = runner
        self.encoder = encoder
        self.pipe_poll_seconds = pipe_poll_seconds

    @property
    def frame_mode(self) -> str:
        return "RGBA" if self.encoder.endswith("_nvenc") else "RGB"

    @classmethod
    def from_binary(cls, ffmpeg_path: str) -> "StreamingEncoder":
        return cls(
            ProcessAdapter(
                ffmpeg_path,
                error_code=JobErrorCode.ENCODE_FAILED,
                label="MP4 encoder",
            )
        )

    def encode(
        self,
        frames: Iterable[Image.Image | bytes],
        output: OutputConfiguration,
        *,
        audio_path: Path,
        partial_path: Path,
        final_path: Path,
        duration: float,
        total_frames: int,
        cancelled: Callable[[], bool] = lambda: False,
        progress: Callable[[int, int, float | None], None] = lambda *_: None,
    ) -> None:
        partial_path.parent.mkdir(parents=True, exist_ok=True)
        final_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path.unlink(missing_ok=True)
        process = self.runner.spawn(
            encoder_arguments(
                output,
                audio_path=audio_path,
                partial_path=partial_path,
                duration=duration,
                encoder=self.encoder,
            ),
            stdin=subprocess.PIPE,
        )
        started = time.monotonic()
        written_frames = 0
        try:
            if process.process.stdin is None:
                raise ProcessAdapterError(
                    JobErrorCode.ENCODE_FAILED, "MP4 encoder input pipe is unavailable."
                )
            descriptor = process.process.stdin.fileno()
            os.set_blocking(descriptor, False)
            with selectors.DefaultSelector() as selector:
                selector.register(descriptor, selectors.EVENT_WRITE)
                for frame in frames:
                    if written_frames >= total_frames:
                        break
                    if cancelled():
                        raise RenderCancelled("Render cancellation was requested.")
                    channels = 4 if self.frame_mode == "RGBA" else 3
                    if isinstance(frame, bytes):
                        payload = frame
                        if len(payload) != output.width * output.height * channels:
                            raise ValueError("scene returned a frame with the wrong byte length")
                    else:
                        if frame.mode != self.frame_mode or frame.size != (
                            output.width,
                            output.height,
                        ):
                            raise ValueError("scene returned a frame with the wrong mode or dimensions")
                        payload = frame.tobytes()
                    self._write_frame(
                        process,
                        selector,
                        payload,
                        cancelled=cancelled,
                    )
                    written_frames += 1
                    elapsed = max(0.001, time.monotonic() - started)
                    remaining = max(0, total_frames - written_frames)
                    eta = remaining / (written_frames / elapsed) if written_frames else None
                    progress(written_frames, total_frames, eta)
            if written_frames != total_frames:
                raise ValueError("scene ended before every output frame was produced")
            process.process.stdin.close()
            process.wait()
            if cancelled():
                raise RenderCancelled("Render cancellation was requested.")
            if not partial_path.is_file() or partial_path.stat().st_size == 0:
                raise ProcessAdapterError(
                    JobErrorCode.ENCODE_FAILED,
                    "MP4 encoder did not produce an output file.",
                )
            _publish(partial_path, final_path)
        except BaseException:
            process.terminate()
            partial_path.unlink(missing_ok=True)
            raise

    def _write_frame(
        self,
        process: ManagedProcess,
        selector: selectors.BaseSelector,
        payload: bytes,
        *,
        cancelled: Callable[[], bool],
    ) -> None:
        descriptor = process.process.stdin.fileno()  # type: ignore[union-attr]
        pending = memoryview(payload)
        while pending:
            if cancelled():
                raise RenderCancelled("Render cancellation was requested.")
            if process.process.poll() is not None:
                process.wait()
                raise ProcessAdapterError(
                    JobErrorCode.ENCODE_FAILED, "MP4 encoder closed its input pipe."
                )
            if not selector.select(self.pipe_poll_seconds):
                continue
            try:
                count = os.write(descriptor, pending)
            except BlockingIOError:
                continue
            except BrokenPipeError:
                process.wait()
                raise ProcessAdapterError(
                    JobErrorCode.ENCODE_FAILED, "MP4 encoder closed its input pipe."
                )
            pending = pending[count:]


def _publish(partial_path: Path, final_path: Path) -> None:
    if final_path.is_symlink() or partial_path.is_symlink():
        raise OSError("refusing to publish through a symbolic link")
    with partial_path.open("rb") as stream:
        os.fsync(stream.fileno())
    os.replace(partial_path, final_path)
    directory_fd = os.open(final_path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
