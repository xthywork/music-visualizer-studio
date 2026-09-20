"""Runtime configuration for the HTTP service and local render worker."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 34388
MIB = 1024 * 1024
GIB = 1024 * MIB
VideoEncoder = Literal["h264_nvenc", "libx264"]
NVENC_PRESETS = frozenset({"p1", "p2", "p3", "p4", "p5", "p6", "p7"})
X264_PRESETS = frozenset(
    {
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
    }
)


def _env_int(name: str, default: int) -> int:
    """Read a positive integer environment value, falling back safely."""

    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if 1 <= parsed <= 65535 else default


def _env_positive_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _env_video_encoder(name: str, default: VideoEncoder) -> VideoEncoder:
    value = os.getenv(name)
    if value in {"h264_nvenc", "libx264"}:
        return value
    return default


def _env_encoder_preset(name: str, encoder: VideoEncoder) -> str:
    default = "p4" if encoder == "h264_nvenc" else "veryfast"
    value = os.getenv(name)
    allowed = NVENC_PRESETS if encoder == "h264_nvenc" else X264_PRESETS
    return value if value in allowed else default


def _default_data_root() -> Path:
    xdg_root = os.getenv("XDG_DATA_HOME")
    base = Path(xdg_root).expanduser() if xdg_root else Path.home() / ".local" / "share"
    return base / "music-visualizer"


@dataclass(frozen=True, slots=True)
class Settings:
    """Application settings loaded from the process environment."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    frontend_dist: str | None = None
    data_root: Path = _default_data_root()
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    font_path: Path | None = None
    max_audio_bytes: int = 256 * MIB
    max_image_bytes: int = 3840 * 2160
    max_subtitle_bytes: int = MIB
    max_queue_depth: int = 100
    storage_ceiling_bytes: int = 100 * GIB
    minimum_free_bytes: int = 2 * GIB
    worker_enabled: bool = True
    worker_poll_ms: int = 250
    frame_workers: int = 12
    video_encoder: VideoEncoder = "h264_nvenc"
    encoder_threads: int = 8
    encoder_preset: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        """Build settings from environment variables.

        ``FRONTEND_DIST`` is optional and mainly useful for a packaged
        deployment or tests. When unset, the application resolves the
        repository's ``frontend/dist`` directory at startup.
        """

        video_encoder = _env_video_encoder(
            "VISUALIZER_VIDEO_ENCODER", "h264_nvenc"
        )
        return cls(
            host=os.getenv("VISUALIZER_HOST", DEFAULT_HOST),
            port=_env_int("VISUALIZER_PORT", DEFAULT_PORT),
            frontend_dist=os.getenv("FRONTEND_DIST") or None,
            data_root=Path(os.getenv("VISUALIZER_DATA_ROOT", os.fspath(_default_data_root()))).expanduser(),
            ffmpeg_path=os.getenv("VISUALIZER_FFMPEG", "ffmpeg"),
            ffprobe_path=os.getenv("VISUALIZER_FFPROBE", "ffprobe"),
            font_path=Path(os.environ["VISUALIZER_FONT_PATH"]).expanduser()
            if os.getenv("VISUALIZER_FONT_PATH")
            else None,
            max_audio_bytes=_env_positive_int("VISUALIZER_MAX_AUDIO_BYTES", 256 * MIB),
            max_image_bytes=_env_positive_int("VISUALIZER_MAX_IMAGE_BYTES", 3840 * 2160),
            max_subtitle_bytes=_env_positive_int("VISUALIZER_MAX_SUBTITLE_BYTES", MIB),
            max_queue_depth=_env_positive_int("VISUALIZER_MAX_QUEUE_DEPTH", 100),
            storage_ceiling_bytes=_env_positive_int("VISUALIZER_STORAGE_CEILING_BYTES", 100 * GIB),
            minimum_free_bytes=_env_positive_int("VISUALIZER_MINIMUM_FREE_BYTES", 2 * GIB),
            worker_enabled=_env_bool("VISUALIZER_WORKER_ENABLED", True),
            worker_poll_ms=_env_positive_int("VISUALIZER_WORKER_POLL_MS", 250),
            frame_workers=_env_positive_int("VISUALIZER_FRAME_WORKERS", 12),
            video_encoder=video_encoder,
            encoder_threads=_env_positive_int("VISUALIZER_ENCODER_THREADS", 8),
            encoder_preset=_env_encoder_preset(
                "VISUALIZER_ENCODER_PRESET", video_encoder
            ),
        )
