from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app.render_jobs.models import JobErrorCode
from app.render_jobs.preflight import EncoderProbe, update_worker_readiness
from app.render_jobs.process import ProcessAdapter, ProcessAdapterError
from app.render_jobs.service import WorkerReadiness


class FakeRunner:
    def __init__(self, payload: bytes = b"", error: Exception | None = None) -> None:
        self.payload = payload
        self.error = error
        self.calls: list[list[str]] = []

    def run(self, arguments: list[str], *, timeout: float | None = None) -> bytes:
        self.calls.append(arguments)
        if self.error:
            raise self.error
        return self.payload


def valid_probe_payload() -> bytes:
    return json.dumps(
        {
            "streams": [
                {
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                    "width": 1280,
                    "height": 720,
                }
            ]
        }
    ).encode()


def test_probe_requires_real_encode_and_verified_h264_metadata(tmp_path: Path) -> None:
    encoder = FakeRunner()
    verifier = FakeRunner(valid_probe_payload())
    result = EncoderProbe(tmp_path, ffmpeg=encoder, ffprobe=verifier).check()
    assert result.ready is True
    assert "h264_nvenc" in encoder.calls[0]
    assert any("format=rgba" in argument for argument in encoder.calls[0])
    assert "-rgb_mode" in encoder.calls[0]
    assert "lavfi" in encoder.calls[0]
    assert any(
        "color=c=black:s=1280x720:r=30:d=0.2" in argument
        for argument in encoder.calls[0]
    )
    assert encoder.calls[0][encoder.calls[0].index("-preset") + 1] == "p4"
    assert verifier.calls[0][-1].endswith("probe.mp4")
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "payload",
    [
        b"{}",
        b'{"streams": []}',
        b'{"streams": [{"codec_name": "hevc", "pix_fmt": "yuv420p", "width": 1280, "height": 720}]}',
        b'{"streams": [{"codec_name": "h264", "pix_fmt": "yuv444p", "width": 1280, "height": 720}]}',
        b"not json",
    ],
)
def test_probe_rejects_missing_or_wrong_output_metadata(tmp_path: Path, payload: bytes) -> None:
    result = EncoderProbe(tmp_path, ffmpeg=FakeRunner(), ffprobe=FakeRunner(payload)).check()
    assert result.ready is False
    assert result.reason == "NVIDIA H.264 encoder readiness check failed."


def test_probe_reports_unavailable_without_exposing_child_diagnostics(tmp_path: Path) -> None:
    failure = ProcessAdapterError(
        JobErrorCode.WORKER_UNAVAILABLE,
        "probe failed",
        detail="/private/input: driver details",
    )
    result = EncoderProbe(
        tmp_path, ffmpeg=FakeRunner(error=failure), ffprobe=FakeRunner()
    ).check()
    assert result.ready is False
    assert "/private" not in (result.reason or "")


def test_failed_probe_keeps_http_worker_readiness_blocked(tmp_path: Path) -> None:
    readiness = WorkerReadiness(ready=True)
    probe = EncoderProbe(
        tmp_path,
        ffmpeg=FakeRunner(error=OSError("binary missing")),
        ffprobe=FakeRunner(),
    )
    result = update_worker_readiness(probe, readiness)
    assert result.ready is False
    assert readiness.get().ready is False
    assert readiness.get().reason == "NVIDIA H.264 encoder readiness check failed."


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg binaries are not installed",
)
def test_software_encoder_uses_same_probe_contract(tmp_path: Path) -> None:
    probe = EncoderProbe(
        tmp_path,
        ffmpeg=ProcessAdapter(
            "ffmpeg",
            error_code=JobErrorCode.WORKER_UNAVAILABLE,
            label="software probe encoder",
        ),
        ffprobe=ProcessAdapter(
            "ffprobe",
            error_code=JobErrorCode.WORKER_UNAVAILABLE,
            label="software probe verifier",
        ),
        encoder="libx264",
    )
    assert probe.check().ready is True
