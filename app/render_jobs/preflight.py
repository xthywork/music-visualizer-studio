"""Executable encoder readiness checks for the render worker."""

from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .models import JobErrorCode
from .process import ProcessAdapter, ProcessAdapterError


class CommandRunner(Protocol):
    def run(self, arguments: list[str], *, timeout: float | None = None) -> bytes: ...


class ReadinessSink(Protocol):
    def set(self, ready: bool, reason: str | None = None) -> None: ...


@dataclass(frozen=True, slots=True)
class ProbeResult:
    ready: bool
    reason: str | None = None


class EncoderProbe:
    """Encode a real short clip and verify it using ffprobe."""

    def __init__(
        self,
        work_root: Path,
        *,
        ffmpeg: CommandRunner,
        ffprobe: CommandRunner,
        encoder: str = "h264_nvenc",
        timeout_seconds: float = 15,
    ) -> None:
        self.work_root = work_root
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.encoder = encoder
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_paths(
        cls,
        work_root: Path,
        *,
        ffmpeg_path: str,
        ffprobe_path: str,
    ) -> "EncoderProbe":
        return cls(
            work_root,
            ffmpeg=ProcessAdapter(
                ffmpeg_path,
                error_code=JobErrorCode.WORKER_UNAVAILABLE,
                label="NVENC preflight encoder",
            ),
            ffprobe=ProcessAdapter(
                ffprobe_path,
                error_code=JobErrorCode.WORKER_UNAVAILABLE,
                label="NVENC preflight verifier",
            ),
        )

    def check(self) -> ProbeResult:
        self.work_root.mkdir(parents=True, exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(
                prefix="nvenc-probe-", dir=self.work_root
            ) as directory:
                output = Path(directory) / "probe.mp4"
                self.ffmpeg.run(
                    self.encode_arguments(output), timeout=self.timeout_seconds
                )
                payload = self.ffprobe.run(
                    self.verify_arguments(output), timeout=self.timeout_seconds
                )
                self._verify(payload)
        except (OSError, ProcessAdapterError, ValueError, json.JSONDecodeError):
            return ProbeResult(
                ready=False,
                reason="NVIDIA H.264 encoder readiness check failed.",
            )
        return ProbeResult(ready=True)

    def encode_arguments(self, output: Path) -> list[str]:
        return [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            # Probe the smallest supported production preset instead of a
            # tiny synthetic frame that some NVENC generations reject even
            # though every user-selectable output size is supported.
            "color=c=black:s=1280x720:r=30:d=0.2",
            "-an",
            "-c:v",
            self.encoder,
            "-preset",
            "p4",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-y",
            str(output),
        ]

    @staticmethod
    def verify_arguments(output: Path) -> list[str]:
        return [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,pix_fmt,width,height",
            "-of",
            "json",
            str(output),
        ]

    @staticmethod
    def _verify(payload: bytes) -> None:
        document = json.loads(payload)
        streams = document.get("streams")
        if not isinstance(streams, list) or len(streams) != 1:
            raise ValueError("preflight output does not contain one video stream")
        stream = streams[0]
        if not isinstance(stream, dict):
            raise ValueError("preflight stream metadata is invalid")
        expected = {
            "codec_name": "h264",
            "pix_fmt": "yuv420p",
            "width": 1280,
            "height": 720,
        }
        if any(stream.get(key) != value for key, value in expected.items()):
            raise ValueError("preflight output metadata does not match policy")


def update_worker_readiness(probe: EncoderProbe, readiness: ReadinessSink) -> ProbeResult:
    """Publish one probe result to the HTTP-facing readiness state."""

    result = probe.check()
    readiness.set(result.ready, result.reason)
    return result
