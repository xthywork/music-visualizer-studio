"""Bounded-memory PCM decoding and audio feature extraction."""

from __future__ import annotations

import math
import os
import selectors
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator, Protocol

import numpy as np
from numpy.typing import NDArray

from .models import JobErrorCode
from .process import ManagedProcess, ProcessAdapter, ProcessAdapterError


MAX_ANALYSIS_POINTS = 32_768
MAX_SPECTRUM_BANDS = 64
MAX_BEATS = 8_192
MAX_TEMPORAL_FRAMES = 36_000
SAMPLE_RATE = 48_000

FloatArray = NDArray[np.float32]


class AudioAnalysisError(RuntimeError):
    pass


class DecoderRunner(Protocol):
    def spawn(
        self,
        arguments: list[str],
        *,
        stdin: int = subprocess.DEVNULL,
        stdout: int = subprocess.PIPE,
    ) -> ManagedProcess: ...


@dataclass(frozen=True, slots=True)
class AudioAnalysis:
    duration: float
    sample_rate: int
    waveform: FloatArray
    spectrum: FloatArray
    beats: FloatArray
    temporal_rate: float
    amplitude: FloatArray
    low: FloatArray
    mid: FloatArray
    high: FloatArray
    temporal_spectrum: FloatArray

    @property
    def frame_count(self) -> int:
        return int(self.amplitude.size)

    def frame_index_at(self, time_seconds: float) -> int:
        if self.frame_count <= 1:
            return 0
        return min(
            self.frame_count - 1,
            max(0, int(max(0.0, time_seconds) * self.temporal_rate)),
        )

    def values_at(self, time_seconds: float) -> tuple[float, float, float, float]:
        index = self.frame_index_at(time_seconds)
        return (
            float(self.amplitude[index]),
            float(self.low[index]),
            float(self.mid[index]),
            float(self.high[index]),
        )


def decode_pcm_chunks(
    source: Path,
    *,
    ffmpeg_path: str = "ffmpeg",
    chunk_bytes: int = 256 * 1024,
    runner: DecoderRunner | None = None,
    cancelled: Callable[[], bool] = lambda: False,
) -> Iterator[FloatArray]:
    arguments = [
        "-v",
        "error",
        "-nostdin",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "pipe:1",
    ]
    decoder = runner or ProcessAdapter(
        ffmpeg_path,
        error_code=JobErrorCode.DECODE_FAILED,
        label="Audio decoder",
    )
    try:
        process = decoder.spawn(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
        )
    except ProcessAdapterError as error:
        raise AudioAnalysisError(str(error)) from error
    assert process.process.stdout is not None
    descriptor = process.process.stdout.fileno()
    os.set_blocking(descriptor, False)
    pending = b""
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(descriptor, selectors.EVENT_READ)
            while True:
                if cancelled():
                    raise AudioAnalysisError("Audio decoding was cancelled.")
                ready = selector.select(0.1)
                if ready:
                    data = os.read(descriptor, chunk_bytes)
                    if not data:
                        break
                    data = pending + data
                    usable = len(data) - len(data) % 4
                    if usable:
                        yield np.frombuffer(data[:usable], dtype="<f4").astype(
                            np.float32, copy=False
                        )
                    pending = data[usable:]
                elif process.process.poll() is not None:
                    break
        process.wait()
        if pending:
            raise AudioAnalysisError("Decoded PCM ended with an incomplete sample.")
    except ProcessAdapterError as error:
        raise AudioAnalysisError(str(error)) from error
    finally:
        process.terminate()


def analyze_audio(
    source: Path,
    *,
    duration: float,
    ffmpeg_path: str = "ffmpeg",
    temporal_rate: int = 30,
    cancelled: Callable[[], bool] = lambda: False,
) -> AudioAnalysis:
    return analyze_pcm_chunks(
        decode_pcm_chunks(source, ffmpeg_path=ffmpeg_path, cancelled=cancelled),
        duration=duration,
        sample_rate=SAMPLE_RATE,
        temporal_rate=temporal_rate,
    )


def analyze_pcm_chunks(
    chunks: Iterable[FloatArray],
    *,
    duration: float,
    sample_rate: int,
    temporal_rate: int = 30,
) -> AudioAnalysis:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be positive and finite")
    requested_rate = max(1, min(60, int(temporal_rate)))
    frame_count = max(1, min(MAX_TEMPORAL_FRAMES, math.ceil(duration * requested_rate)))
    actual_rate = frame_count / duration
    amplitude = np.zeros(frame_count, dtype=np.float32)
    low = np.zeros(frame_count, dtype=np.float32)
    mid = np.zeros(frame_count, dtype=np.float32)
    high = np.zeros(frame_count, dtype=np.float32)
    temporal_spectrum = np.zeros((frame_count, MAX_SPECTRUM_BANDS), dtype=np.float32)

    pending = np.empty(0, dtype=np.float32)
    consumed = 0
    frame = 0
    for chunk in chunks:
        values = np.asarray(chunk, dtype=np.float32).reshape(-1)
        if values.size == 0:
            continue
        pending = np.concatenate((pending, values)) if pending.size else values
        while frame < frame_count:
            target = round((frame + 1) * sample_rate / actual_rate)
            required = max(1, target - consumed)
            if pending.size < required:
                break
            samples = pending[:required]
            pending = pending[required:]
            _analyze_frame(
                samples,
                sample_rate,
                amplitude,
                low,
                mid,
                high,
                temporal_spectrum,
                frame,
            )
            consumed += required
            frame += 1
        if frame >= frame_count:
            break

    if frame < frame_count and pending.size:
        _analyze_frame(
            pending,
            sample_rate,
            amplitude,
            low,
            mid,
            high,
            temporal_spectrum,
            frame,
        )
        frame += 1
    if frame == 0:
        raise AudioAnalysisError("Decoded audio did not contain PCM samples.")
    if frame < frame_count:
        amplitude[frame:] = amplitude[frame - 1]
        low[frame:] = low[frame - 1]
        mid[frame:] = mid[frame - 1]
        high[frame:] = high[frame - 1]
        temporal_spectrum[frame:] = temporal_spectrum[frame - 1]

    _normalize_and_smooth(amplitude, actual_rate)
    _normalize_and_smooth(low, actual_rate)
    _normalize_and_smooth(mid, actual_rate)
    _normalize_and_smooth(high, actual_rate)
    spectrum_peak = float(np.percentile(temporal_spectrum, 99)) if temporal_spectrum.size else 0
    if spectrum_peak > 0:
        np.clip(temporal_spectrum / spectrum_peak, 0, 1, out=temporal_spectrum)
    static_spectrum = temporal_spectrum.mean(axis=0, dtype=np.float64).astype(np.float32)
    static_peak = float(static_spectrum.max(initial=0))
    if static_peak > 0:
        static_spectrum /= static_peak
    waveform_points = min(MAX_ANALYSIS_POINTS, frame_count)
    waveform = np.interp(
        np.linspace(0, frame_count - 1, waveform_points),
        np.arange(frame_count),
        amplitude,
    ).astype(np.float32)
    beats = _detect_beats(amplitude, actual_rate)
    return AudioAnalysis(
        duration=duration,
        sample_rate=sample_rate,
        waveform=waveform,
        spectrum=static_spectrum,
        beats=beats,
        temporal_rate=actual_rate,
        amplitude=amplitude,
        low=low,
        mid=mid,
        high=high,
        temporal_spectrum=temporal_spectrum,
    )


def _analyze_frame(
    samples: FloatArray,
    sample_rate: int,
    amplitude: FloatArray,
    low: FloatArray,
    mid: FloatArray,
    high: FloatArray,
    temporal_spectrum: FloatArray,
    frame: int,
) -> None:
    samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    amplitude[frame] = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    if samples.size < 4:
        low[frame] = mid[frame] = high[frame] = amplitude[frame]
        return
    windowed = samples * np.hanning(samples.size).astype(np.float32)
    magnitudes = np.abs(np.fft.rfft(windowed))
    frequencies = np.fft.rfftfreq(samples.size, 1 / sample_rate)
    low[frame] = _band_rms(magnitudes, frequencies, 20, 180)
    mid[frame] = _band_rms(magnitudes, frequencies, 180, 2_000)
    high[frame] = _band_rms(magnitudes, frequencies, 2_000, min(20_000, sample_rate / 2))
    edges = np.geomspace(30, min(20_000, sample_rate / 2), MAX_SPECTRUM_BANDS + 1)
    for band in range(MAX_SPECTRUM_BANDS):
        mask = (frequencies >= edges[band]) & (frequencies < edges[band + 1])
        if np.any(mask):
            temporal_spectrum[frame, band] = float(np.sqrt(np.mean(np.square(magnitudes[mask]))))


def _band_rms(
    magnitudes: NDArray[np.float64],
    frequencies: NDArray[np.float64],
    minimum: float,
    maximum: float,
) -> float:
    mask = (frequencies >= minimum) & (frequencies < maximum)
    if not np.any(mask):
        return 0.0
    return float(np.sqrt(np.mean(np.square(magnitudes[mask]))))


def _normalize_and_smooth(values: FloatArray, frame_rate: float) -> None:
    peak = float(np.percentile(values, 99)) if values.size else 0
    if peak > 0:
        np.clip(values / peak, 0, 1, out=values)
    attack = 1 - math.exp(-1 / max(1, frame_rate * 0.045))
    release = 1 - math.exp(-1 / max(1, frame_rate * 0.42))
    previous = 0.0
    for index in range(values.size):
        target = float(values[index])
        coefficient = attack if target >= previous else release
        previous += (target - previous) * coefficient
        values[index] = min(1.0, max(0.0, previous))


def _detect_beats(amplitude: FloatArray, frame_rate: float) -> FloatArray:
    if amplitude.size < 3:
        return np.empty(0, dtype=np.float32)
    window = max(3, round(frame_rate * 0.8))
    minimum_gap = max(1, round(frame_rate * 0.18))
    beats: list[float] = []
    last = -minimum_gap
    for index in range(1, amplitude.size - 1):
        start = max(0, index - window)
        history = amplitude[start:index]
        threshold = float(history.mean() + history.std() * 0.9) if history.size else 1.0
        if (
            amplitude[index] >= threshold
            and amplitude[index] > amplitude[index - 1]
            and amplitude[index] >= amplitude[index + 1]
            and index - last >= minimum_gap
        ):
            beats.append(index / frame_rate)
            last = index
            if len(beats) >= MAX_BEATS:
                break
    return np.asarray(beats, dtype=np.float32)
