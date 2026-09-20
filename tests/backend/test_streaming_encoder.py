from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image
import pytest

from app.render_jobs.encoder import (
    RenderCancelled,
    StreamingEncoder,
    encoder_arguments,
    resolve_encoder_preset,
    video_bitrate,
)
from app.render_jobs.models import JobErrorCode, OutputConfiguration
from app.render_jobs.process import ProcessAdapter


def output(width: int = 1280, height: int = 720, fps: int = 30) -> OutputConfiguration:
    return OutputConfiguration.model_validate(
        {"aspectRatio": "16:9", "width": width, "height": height, "frameRate": fps}
    )


def test_encoder_command_uses_raw_rgb_nvenc_aac_and_yuv420p(tmp_path: Path) -> None:
    arguments = encoder_arguments(
        output(),
        audio_path=tmp_path / "audio.bin",
        partial_path=tmp_path / "output.part.mp4",
        duration=5,
    )
    joined = " ".join(arguments)
    assert "rawvideo" in arguments
    assert "rgb24" in arguments
    assert "h264_nvenc" in arguments
    assert "aac" in arguments
    assert "yuv420p" in arguments
    assert "pipe:0" in arguments
    assert "-shortest" not in arguments
    assert "+faststart" in arguments
    assert str(tmp_path / "audio.bin") in arguments
    assert ";" not in joined


def test_encoder_command_uses_encoder_specific_preset_namespaces(tmp_path: Path) -> None:
    common = {
        "audio_path": tmp_path / "audio.wav",
        "partial_path": tmp_path / "output.part.mp4",
        "duration": 1,
    }
    nvenc = encoder_arguments(output(), encoder="h264_nvenc", **common)
    software = encoder_arguments(
        output(), encoder="libx264", encoder_threads=8, **common
    )

    assert nvenc[nvenc.index("-preset") + 1] == "p4"
    assert software[software.index("-preset") + 1] == "veryfast"
    assert software[software.index("-threads") + 1] == "8"
    assert "p4" not in software
    assert "-threads" not in nvenc


def test_software_preset_can_be_selected_without_crossing_encoder_namespaces(
    tmp_path: Path,
) -> None:
    arguments = encoder_arguments(
        output(),
        audio_path=tmp_path / "audio.wav",
        partial_path=tmp_path / "output.part.mp4",
        duration=1,
        encoder="libx264",
        encoder_preset="ultrafast",
    )

    assert arguments[arguments.index("-preset") + 1] == "ultrafast"
    with pytest.raises(ValueError, match="unsupported preset"):
        resolve_encoder_preset("libx264", "p4")
    with pytest.raises(ValueError, match="unsupported preset"):
        resolve_encoder_preset("h264_nvenc", "ultrafast")


def test_bitrate_policy_covers_presets() -> None:
    assert video_bitrate(output()) == "8M"
    assert video_bitrate(output(fps=60)) == "12M"
    assert video_bitrate(output(1920, 1080)) == "14M"
    four_k = OutputConfiguration.model_validate(
        {"aspectRatio": "16:9", "width": 3840, "height": 2160, "frameRate": 60}
    )
    assert video_bitrate(four_k) == "60M"


def test_wrong_frame_dimensions_terminate_and_remove_partial(tmp_path: Path) -> None:
    runner = ProcessAdapter(
        sys.executable,
        error_code=JobErrorCode.ENCODE_FAILED,
        label="fake encoder",
    )
    encoder = StreamingEncoder(runner, encoder="ignored")
    partial = tmp_path / "partial.mp4"
    with pytest.raises(ValueError, match="wrong mode or dimensions"):
        encoder.encode(
            [Image.new("RGB", (2, 2))],
            output(),
            audio_path=tmp_path / "audio.bin",
            partial_path=partial,
            final_path=tmp_path / "final.mp4",
            duration=1,
            total_frames=1,
        )
    assert not partial.exists()


def test_wrong_raw_frame_byte_length_terminates_and_removes_partial(tmp_path: Path) -> None:
    runner = ProcessAdapter(
        sys.executable,
        error_code=JobErrorCode.ENCODE_FAILED,
        label="fake encoder",
    )
    partial = tmp_path / "partial.mp4"
    with pytest.raises(ValueError, match="wrong byte length"):
        StreamingEncoder(runner, encoder="ignored").encode(
            [b"too short"],
            output(),
            audio_path=tmp_path / "audio.bin",
            partial_path=partial,
            final_path=tmp_path / "final.mp4",
            duration=1,
            total_frames=1,
        )
    assert not partial.exists()


def test_cancellation_breaks_out_when_child_stops_reading_pipe(tmp_path: Path) -> None:
    runner = ProcessAdapter(
        sys.executable,
        error_code=JobErrorCode.ENCODE_FAILED,
        label="blocked encoder",
    )

    class SleepingEncoder(StreamingEncoder):
        def encode(self, frames, output_config, **kwargs):  # type: ignore[no-untyped-def]
            original_spawn = self.runner.spawn

            def sleeping_spawn(_arguments, **_options):  # type: ignore[no-untyped-def]
                return original_spawn(
                    ["-c", "import time; time.sleep(30)"], stdin=subprocess.PIPE
                )

            self.runner.spawn = sleeping_spawn  # type: ignore[method-assign]
            return super().encode(frames, output_config, **kwargs)

    checks = 0

    def cancelled() -> bool:
        nonlocal checks
        checks += 1
        return checks > 3

    frame = Image.new("RGB", (1280, 720))
    with pytest.raises(RenderCancelled):
        SleepingEncoder(runner).encode(
            [frame],
            output(),
            audio_path=tmp_path / "audio.bin",
            partial_path=tmp_path / "partial.mp4",
            final_path=tmp_path / "final.mp4",
            duration=1,
            total_frames=1,
            cancelled=cancelled,
        )
    assert checks > 3
