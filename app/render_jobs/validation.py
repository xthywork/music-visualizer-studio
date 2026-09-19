"""Server-side media and subtitle validation before a job enters the queue."""

from __future__ import annotations

import json
import re
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from PIL import Image, UnidentifiedImageError

from .models import JobErrorCode
from .process import ProcessAdapter, ProcessAdapterError


MAX_AUDIO_SECONDS = 10 * 60
MAX_IMAGE_WIDTH = 3840 * 2
MAX_IMAGE_HEIGHT = 3840 * 2
MAX_IMAGE_PIXELS = 3840 * 2160 * 2
MAX_SUBTITLE_CUES = 5_000

_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a"}
_AUDIO_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/x-m4a",
    "application/octet-stream",
    "",
}
_IMAGE_TYPES = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
_TIMESTAMP_LINE = re.compile(
    r"^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*$"
)


class MediaValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class AudioMetadata:
    duration: float
    codec: str


@dataclass(frozen=True, slots=True)
class ImageMetadata:
    width: int
    height: int
    format: str


Probe = Callable[[Path], dict[str, Any]]


def ffprobe_json(
    path: Path,
    ffprobe_path: str = "ffprobe",
    *,
    cancelled: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    arguments = [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,duration",
        "-of",
        "json",
        "--",
        str(path),
    ]
    try:
        stdout = ProcessAdapter(
            ffprobe_path,
            error_code=JobErrorCode.INVALID_AUDIO,
            label="Audio metadata probe",
        ).run(
            arguments,
            timeout=20,
            cancelled=cancelled,
        )
    except ProcessAdapterError as error:
        raise MediaValidationError("invalid_audio", "伺服器無法檢查音訊檔案。") from error
    try:
        return json.loads(stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise MediaValidationError("invalid_audio", "音訊檢查結果無效。") from error


class MediaValidator:
    def __init__(
        self,
        *,
        probe: Probe = ffprobe_json,
        max_image_width: int = MAX_IMAGE_WIDTH,
        max_image_height: int = MAX_IMAGE_HEIGHT,
        max_image_pixels: int = MAX_IMAGE_PIXELS,
    ) -> None:
        self.probe = probe
        self.max_image_width = max_image_width
        self.max_image_height = max_image_height
        self.max_image_pixels = max_image_pixels

    def validate_audio(
        self,
        path: Path,
        *,
        original_filename: str,
        content_type: str,
    ) -> AudioMetadata:
        if Path(original_filename).suffix.lower() not in _AUDIO_EXTENSIONS:
            raise MediaValidationError("invalid_audio", "僅支援 MP3、WAV 或 M4A 音訊。")
        if content_type.lower() not in _AUDIO_TYPES:
            raise MediaValidationError("invalid_audio", "音訊 MIME type 不受支援。")
        payload = self.probe(path)
        streams = payload.get("streams")
        if not isinstance(streams, list):
            raise MediaValidationError("invalid_audio", "音訊內容缺少可解碼的 audio stream。")
        audio_stream = next(
            (stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"),
            None,
        )
        if audio_stream is None:
            raise MediaValidationError("invalid_audio", "檔案不包含音訊軌。")
        duration_value = (payload.get("format") or {}).get("duration") or audio_stream.get("duration")
        try:
            duration = float(duration_value)
        except (TypeError, ValueError) as error:
            raise MediaValidationError("invalid_audio", "無法讀取音訊長度。") from error
        if not 0 < duration <= MAX_AUDIO_SECONDS:
            raise MediaValidationError("invalid_audio", "音訊最長支援 10 分鐘。")
        codec = str(audio_stream.get("codec_name") or "unknown")
        return AudioMetadata(duration=duration, codec=codec)

    def validate_image(self, path: Path, *, content_type: str) -> ImageMetadata:
        expected_format = _IMAGE_TYPES.get(content_type.lower())
        if expected_format is None:
            raise MediaValidationError("invalid_image", "僅支援 PNG、JPEG 或 WebP 圖片。")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    width, height = image.size
                    actual_format = image.format
                    if actual_format != expected_format:
                        raise MediaValidationError("invalid_image", "圖片格式與 MIME type 不符。")
                    if (
                        width <= 0
                        or height <= 0
                        or width > self.max_image_width
                        or height > self.max_image_height
                        or width * height > self.max_image_pixels
                    ):
                        raise MediaValidationError("invalid_image", "圖片尺寸過大。")
                    image.verify()
        except MediaValidationError:
            raise
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise MediaValidationError("invalid_image", "圖片內容無法解碼。") from error
        return ImageMetadata(width=width, height=height, format=actual_format)

    @staticmethod
    def validate_subtitles(path: Path) -> int:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise MediaValidationError("invalid_subtitles", "字幕必須是有效的 UTF-8 SRT。") from error
        if "\x00" in text:
            raise MediaValidationError("invalid_subtitles", "字幕包含無效字元。")
        timestamp_lines = [line for line in text.splitlines() if "-->" in line]
        if not timestamp_lines or any(not _TIMESTAMP_LINE.match(line) for line in timestamp_lines):
            raise MediaValidationError("invalid_subtitles", "字幕不是有效的 SRT 時間格式。")
        if len(timestamp_lines) > MAX_SUBTITLE_CUES:
            raise MediaValidationError("invalid_subtitles", "字幕不可超過 5000 段。")
        return len(timestamp_lines)
