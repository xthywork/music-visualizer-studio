"""Opt-in acceptance test for the deployed NVIDIA encoder.

Run on the target host with:
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
"""

from __future__ import annotations

import json
import math
import os
import shutil
import wave
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from app.render_jobs.encoder import StreamingEncoder
from app.render_jobs.models import JobErrorCode, OutputConfiguration
from app.render_jobs.process import ProcessAdapter


def write_tone(path: Path, *, duration: float, rate: int = 48_000) -> None:
    time = np.arange(round(duration * rate), dtype=np.float32) / rate
    samples = (np.sin(2 * np.pi * 440 * time) * 12_000).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(samples.tobytes())


pytestmark = pytest.mark.skipif(
    os.getenv("VISUALIZER_RUN_NVENC_TESTS") != "1"
    or shutil.which("ffmpeg") is None
    or shutil.which("ffprobe") is None,
    reason="set VISUALIZER_RUN_NVENC_TESTS=1 on an NVIDIA/FFmpeg host",
)


@pytest.mark.parametrize(
    ("label", "width", "height", "fps"),
    (
        ("720p30", 1280, 720, 30),
        ("1080p60", 1920, 1080, 60),
        ("4k60", 3840, 2160, 60),
    ),
)
def test_nvenc_output_contract(
    tmp_path: Path,
    label: str,
    width: int,
    height: int,
    fps: int,
) -> None:
    duration = 0.2
    output = OutputConfiguration.model_validate(
        {
            "aspectRatio": "16:9",
            "width": width,
            "height": height,
            "frameRate": fps,
        }
    )
    audio = tmp_path / f"{label}.wav"
    write_tone(audio, duration=duration)
    frame = Image.new("RGB", (width, height), "#17242d")
    total_frames = math.ceil(duration * fps)
    final = tmp_path / f"{label}.mp4"
    StreamingEncoder.from_binary("ffmpeg").encode(
        (frame for _ in range(total_frames)),
        output,
        audio_path=audio,
        partial_path=tmp_path / f"{label}.part.mp4",
        final_path=final,
        duration=duration,
        total_frames=total_frames,
    )
    metadata = json.loads(
        ProcessAdapter(
            "ffprobe",
            error_code=JobErrorCode.ENCODE_FAILED,
            label="NVENC smoke verifier",
        ).run(
            [
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate",
                "-of",
                "json",
                str(final),
            ],
            timeout=15,
        )
    )
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio_stream = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    assert video["codec_name"] == "h264"
    assert video["pix_fmt"] == "yuv420p"
    assert (video["width"], video["height"]) == (width, height)
    assert video["r_frame_rate"] == f"{fps}/1"
    assert audio_stream["codec_name"] == "aac"
