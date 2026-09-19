from __future__ import annotations

import json
import math
import shutil
import wave
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from app.render_jobs.encoder import StreamingEncoder
from app.render_jobs.models import JobErrorCode, OutputConfiguration
from app.render_jobs.process import ProcessAdapter


FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def write_tone(path: Path, *, duration: float, rate: int = 48_000) -> None:
    time = np.arange(round(duration * rate), dtype=np.float32) / rate
    samples = (np.sin(2 * np.pi * 440 * time) * 12_000).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(samples.tobytes())


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binaries are not installed")
def test_software_pipeline_produces_h264_aac_mp4_with_expected_metadata(tmp_path: Path) -> None:
    duration = 0.2
    fps = 30
    configuration = OutputConfiguration.model_validate(
        {
            "aspectRatio": "16:9",
            "width": 1280,
            "height": 720,
            "frameRate": fps,
        }
    )
    audio = tmp_path / "tone.wav"
    partial = tmp_path / "output.part.mp4"
    final = tmp_path / "output.mp4"
    write_tone(audio, duration=duration)
    frame_count = math.ceil(duration * fps)
    encoder = StreamingEncoder(
        ProcessAdapter(
            "ffmpeg",
            error_code=JobErrorCode.ENCODE_FAILED,
            label="software integration encoder",
        ),
        encoder="libx264",
    )
    encoder.encode(
        (Image.new("RGB", (1280, 720), (20 + frame * 5, 40, 60)) for frame in range(frame_count)),
        configuration,
        audio_path=audio,
        partial_path=partial,
        final_path=final,
        duration=duration,
        total_frames=frame_count,
    )

    payload = ProcessAdapter(
        "ffprobe",
        error_code=JobErrorCode.ENCODE_FAILED,
        label="software integration verifier",
    ).run(
        [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate",
            "-of",
            "json",
            str(final),
        ],
        timeout=10,
    )
    metadata = json.loads(payload)
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio_stream = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    assert video == {
        "codec_name": "h264",
        "codec_type": "video",
        "width": 1280,
        "height": 720,
        "pix_fmt": "yuv420p",
        "r_frame_rate": "30/1",
    }
    assert audio_stream["codec_name"] == "aac"
    assert float(metadata["format"]["duration"]) == pytest.approx(duration, abs=0.08)
    assert final.stat().st_size > 0
    assert not partial.exists()
