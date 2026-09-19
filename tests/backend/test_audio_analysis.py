import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest

from app.render_jobs.audio import (
    MAX_ANALYSIS_POINTS,
    MAX_SPECTRUM_BANDS,
    MAX_TEMPORAL_FRAMES,
    AudioAnalysisError,
    decode_pcm_chunks,
    analyze_pcm_chunks,
)
from app.render_jobs.models import JobErrorCode
from app.render_jobs.process import ProcessAdapter


ROOT = Path(__file__).resolve().parents[2]


def sine_chunks(
    *, duration: float, sample_rate: int, chunk_samples: int = 997
):
    total = round(duration * sample_rate)
    position = 0
    while position < total:
        count = min(chunk_samples, total - position)
        time = (np.arange(count, dtype=np.float32) + position) / sample_rate
        envelope = np.where(time < duration / 2, 0.2, 0.8)
        yield (np.sin(2 * np.pi * 440 * time) * envelope).astype(np.float32)
        position += count


def test_streaming_analysis_is_bounded_and_normalized() -> None:
    analysis = analyze_pcm_chunks(
        sine_chunks(duration=4, sample_rate=48_000),
        duration=4,
        sample_rate=48_000,
        temporal_rate=60,
    )

    assert analysis.frame_count == 240
    assert analysis.frame_count <= MAX_TEMPORAL_FRAMES
    assert analysis.waveform.size <= MAX_ANALYSIS_POINTS
    assert analysis.spectrum.size == MAX_SPECTRUM_BANDS
    assert analysis.temporal_spectrum.shape == (240, MAX_SPECTRUM_BANDS)
    for values in (
        analysis.waveform,
        analysis.spectrum,
        analysis.amplitude,
        analysis.low,
        analysis.mid,
        analysis.high,
        analysis.temporal_spectrum,
    ):
        assert np.isfinite(values).all()
        assert float(values.min(initial=0)) >= 0
        assert float(values.max(initial=0)) <= 1
    assert analysis.amplitude[-1] > analysis.amplitude[10]


def test_timestamp_lookup_matches_shared_conformance_fixture() -> None:
    fixture = json.loads(
        (ROOT / "fixtures/render-conformance/audio-analysis.json").read_text(encoding="utf-8")
    )
    analysis = analyze_pcm_chunks(
        sine_chunks(duration=fixture["duration"], sample_rate=fixture["sampleRate"]),
        duration=fixture["duration"],
        sample_rate=fixture["sampleRate"],
        temporal_rate=fixture["temporalRate"],
    )

    for query in fixture["queries"]:
        assert analysis.frame_index_at(query["time"]) == query["expectedFrame"]


def test_empty_pcm_stream_is_rejected() -> None:
    with pytest.raises(AudioAnalysisError, match="PCM"):
        analyze_pcm_chunks([], duration=1, sample_rate=48_000)


def test_unusually_long_duration_is_capped() -> None:
    analysis = analyze_pcm_chunks(
        [np.ones(100, dtype=np.float32)],
        duration=10_000,
        sample_rate=1,
        temporal_rate=60,
    )
    assert analysis.frame_count == MAX_TEMPORAL_FRAMES


class PythonDecoder:
    def __init__(self, code: str) -> None:
        self.code = code
        self.adapter = ProcessAdapter(
            sys.executable,
            error_code=JobErrorCode.DECODE_FAILED,
            label="fake audio decoder",
        )

    def spawn(self, _arguments, *, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE):  # type: ignore[no-untyped-def]
        return self.adapter.spawn(["-c", self.code], stdin=stdin, stdout=stdout)


def test_decoder_streams_float_pcm_through_owned_process() -> None:
    chunks = list(
        decode_pcm_chunks(
            Path("unused"),
            runner=PythonDecoder(
                "import struct,sys; sys.stdout.buffer.write(struct.pack('<4f', .1, .2, .3, .4))"
            ),
            chunk_bytes=7,
        )
    )
    assert np.concatenate(chunks) == pytest.approx([0.1, 0.2, 0.3, 0.4])


def test_decoder_cancellation_terminates_blocked_child() -> None:
    checks = 0

    def cancelled() -> bool:
        nonlocal checks
        checks += 1
        return checks > 2

    with pytest.raises(AudioAnalysisError, match="cancelled"):
        list(
            decode_pcm_chunks(
                Path("unused"),
                runner=PythonDecoder("import time; time.sleep(30)"),
                cancelled=cancelled,
            )
        )
    assert checks > 2
