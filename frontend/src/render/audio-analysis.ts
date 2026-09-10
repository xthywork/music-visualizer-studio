import type { AudioAnalysis, TemporalAudioEnvelope } from "./types";

export const MAX_ANALYSIS_POINTS = 32_768;
export const MAX_SPECTRUM_BANDS = 128;
export const MAX_BEATS = 8_192;
/** Temporal analysis is intentionally much smaller than a video frame stream. */
export const DEFAULT_TEMPORAL_RATE = 30;
export const MAX_TEMPORAL_RATE = 60;
export const MAX_TEMPORAL_FRAMES = 36_000;
export const MAX_TEMPORAL_SPECTRUM_BANDS = 64;

export interface AnalysisOptions {
  maxPoints?: number;
  maxBands?: number;
  maxBeats?: number;
  /** Requested temporal envelope rate. It is capped at 60 Hz. */
  temporalRate?: number;
  /** Hard cap for temporal rows, useful for unusually long source files. */
  maxTemporalFrames?: number;
}

/** Transfer-friendly audio data. It deliberately contains PCM only, never File/Blob/source references. */
export interface PcmAudioSnapshot {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  channels: Float32Array[];
}

export function pcmSnapshotFromAudioBuffer(buffer: AudioBuffer): PcmAudioSnapshot {
  return {
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    numberOfChannels: Math.max(1, Math.min(2, buffer.numberOfChannels)),
    channels: Array.from({ length: Math.max(1, Math.min(2, buffer.numberOfChannels)) }, (_, channel) => new Float32Array(buffer.getChannelData(channel))),
  };
}

export function pcmSnapshotTransferables(snapshot: PcmAudioSnapshot): Transferable[] {
  return snapshot.channels.map((channel) => channel.buffer);
}

/** Release transferred PCM references as soon as a render session is over. */
export function releasePcmAudioSnapshot(snapshot: PcmAudioSnapshot): void {
  for (let index = 0; index < snapshot.channels.length; index++) snapshot.channels[index] = new Float32Array(0);
  snapshot.channels.length = 0;
  snapshot.numberOfChannels = 0;
}

export async function decodeAudioBuffer(bytes: ArrayBuffer): Promise<{ buffer: AudioBuffer; close: () => Promise<void> }> {
  const Ctx = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("This browser cannot decode audio in memory (AudioContext unavailable).");
  const context = new Ctx();
  try {
    const buffer = await context.decodeAudioData(bytes.slice(0));
    return { buffer, close: () => context.close().catch(() => undefined) };
  } catch (error) {
    await context.close().catch(() => undefined); throw error;
  }
}

/** Decode and analyze in memory. The caller owns the input bytes and can release them afterwards. */
export async function analyzeAudioBytes(bytes: ArrayBuffer, options: AnalysisOptions = {}): Promise<AudioAnalysis> {
  const decoded = await decodeAudioBuffer(bytes);
  try {
    return analyzeAudioBuffer(decoded.buffer, options);
  } finally {
    await decoded.close();
  }
}

/** Bounded analysis which avoids retaining a decoded channel buffer. */
export function analyzeAudioBuffer(buffer: AudioBuffer, options: AnalysisOptions = {}): AudioAnalysis {
  return analyzePcmAudioSnapshot(pcmSnapshotFromAudioBuffer(buffer), options);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/** Attack quickly, then let a signal settle slowly so visual motion feels intentional. */
function smoothEnvelope(values: Float32Array, frameRate: number, attackSeconds = 0.045, releaseSeconds = 0.42): void {
  const attack = 1 - Math.exp(-1 / Math.max(1, frameRate * attackSeconds));
  const release = 1 - Math.exp(-1 / Math.max(1, frameRate * releaseSeconds));
  let previous = 0;
  for (let index = 0; index < values.length; index++) {
    const target = clamp01(values[index]);
    const coefficient = target >= previous ? attack : release;
    previous += (target - previous) * coefficient;
    values[index] = clamp01(previous);
  }
}

/**
 * Build a compact temporal feature stream in one pass over planar PCM.
 * The three bands come from two inexpensive one-pole low-pass filters; this
 * avoids allocating an FFT-sized window for every frame of a long song.
 */
function createTemporalEnvelope(
  snapshot: PcmAudioSnapshot,
  maxBands: number,
  options: AnalysisOptions,
  staticSpectrum: Float32Array,
): TemporalAudioEnvelope {
  const duration = Math.max(0, Number.isFinite(snapshot.duration) ? snapshot.duration : 0);
  const requestedRate = Math.max(1, Math.min(options.temporalRate ?? DEFAULT_TEMPORAL_RATE, MAX_TEMPORAL_RATE));
  const maxFrames = Math.max(1, Math.min(options.maxTemporalFrames ?? MAX_TEMPORAL_FRAMES, MAX_TEMPORAL_FRAMES));
  const frameCount = Math.max(1, Math.min(maxFrames, Math.ceil(duration * requestedRate) || 1));
  const frameRate = duration > 0 ? frameCount / duration : requestedRate;
  const amplitude = new Float32Array(frameCount);
  const low = new Float32Array(frameCount);
  const mid = new Float32Array(frameCount);
  const high = new Float32Array(frameCount);
  const samplesInFrame = new Uint32Array(frameCount);
  const length = snapshot.channels.reduce((largest, channel) => Math.max(largest, channel.length), 0);
  const channels = Math.max(1, Math.min(snapshot.numberOfChannels, snapshot.channels.length));
  const sampleRate = Math.max(1, Number.isFinite(snapshot.sampleRate) ? snapshot.sampleRate : 48_000);
  const lowCutoff = Math.min(sampleRate * 0.45, 180);
  const midCutoff = Math.min(sampleRate * 0.48, 2_000);
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * lowCutoff / sampleRate);
  const midAlpha = 1 - Math.exp(-2 * Math.PI * midCutoff / sampleRate);
  let lowState = 0;
  let midState = 0;
  let peak = 0;

  for (let sample = 0; sample < length; sample++) {
    const frame = Math.min(frameCount - 1, Math.floor(sample * frameCount / Math.max(1, length)));
    let value = 0;
    for (let channel = 0; channel < channels; channel++) value += snapshot.channels[channel]?.[sample] ?? 0;
    value /= channels;
    lowState += (value - lowState) * lowAlpha;
    midState += (value - midState) * midAlpha;
    const lowValue = lowState;
    const midValue = midState - lowState;
    const highValue = value - midState;
    amplitude[frame] += value * value;
    low[frame] += lowValue * lowValue;
    mid[frame] += midValue * midValue;
    high[frame] += highValue * highValue;
    samplesInFrame[frame]++;
    peak = Math.max(peak, Math.abs(value));
  }

  let rmsPeak = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const count = Math.max(1, samplesInFrame[frame]);
    amplitude[frame] = Math.sqrt(amplitude[frame] / count);
    low[frame] = Math.sqrt(low[frame] / count);
    mid[frame] = Math.sqrt(mid[frame] / count);
    high[frame] = Math.sqrt(high[frame] / count);
    rmsPeak = Math.max(rmsPeak, amplitude[frame]);
  }
  // RMS, rather than the sample peak, keeps a quiet but sustained passage visible.
  const scale = Math.max(rmsPeak, peak * 0.08, 1e-8);
  for (const values of [amplitude, low, mid, high]) {
    for (let frame = 0; frame < values.length; frame++) values[frame] = clamp01(values[frame] / scale);
    smoothEnvelope(values, frameRate);
  }

  // A compact, time-varying spectrum: the filter-bank energies are distributed
  // over the legacy log bands, retaining the source's broad spectral profile.
  const spectrumBands = Math.max(1, Math.min(maxBands, MAX_TEMPORAL_SPECTRUM_BANDS));
  const spectrum = new Float32Array(frameCount * spectrumBands);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let band = 0; band < spectrumBands; band++) {
      const position = (band + 0.5) / spectrumBands;
      const energy = position < 0.24 ? low[frame] : position < 0.68 ? mid[frame] : high[frame];
      const profile = staticSpectrum.length ? staticSpectrum[Math.min(staticSpectrum.length - 1, Math.floor(band * staticSpectrum.length / spectrumBands))] : 1;
      spectrum[frame * spectrumBands + band] = clamp01(energy * (0.55 + profile * 0.45));
    }
  }
  return { frameRate, frameCount, amplitude, low, mid, high, spectrumBands, spectrum };
}

/** Analyze transferred planar PCM without touching AudioContext or browser media APIs. */
export function analyzePcmAudioSnapshot(snapshot: PcmAudioSnapshot, options: AnalysisOptions = {}): AudioAnalysis {
  const maxPoints = Math.max(1, Math.min(options.maxPoints ?? MAX_ANALYSIS_POINTS, MAX_ANALYSIS_POINTS));
  const maxBands = Math.max(1, Math.min(options.maxBands ?? MAX_SPECTRUM_BANDS, MAX_SPECTRUM_BANDS));
  const maxBeats = Math.max(1, Math.min(options.maxBeats ?? MAX_BEATS, MAX_BEATS));
  const length = snapshot.channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const channels = Math.max(1, Math.min(snapshot.numberOfChannels, snapshot.channels.length));
  const points = Math.min(maxPoints, Math.max(1, Math.ceil(length / Math.max(1, Math.ceil(length / maxPoints)))));
  const waveform = new Float32Array(points);
  const mono = new Float32Array(Math.min(length, maxPoints * 2));
  const hop = Math.max(1, Math.floor(mono.length / points));
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const source = Math.min(length - 1, Math.floor(i * length / mono.length));
    let value = 0;
    for (let channel = 0; channel < channels; channel++) value += snapshot.channels[channel]?.[source] ?? 0;
    mono[i] = value / channels;
  }
  for (let p = 0; p < points; p++) {
    const start = Math.min(mono.length - 1, p * hop);
    const end = Math.min(mono.length, start + Math.max(1, hop));
    let sum = 0;
    for (let i = start; i < end; i++) sum += mono[i] * mono[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    waveform[p] = rms;
    peak = Math.max(peak, rms);
  }
  if (peak) for (let i = 0; i < waveform.length; i++) waveform[i] /= peak;

  const spectrum = new Float32Array(maxBands);
  const bins = Math.min(mono.length, 2048);
  for (let band = 0; band < maxBands; band++) {
    const from = Math.floor(Math.pow(band / maxBands, 1.65) * (bins / 2));
    const to = Math.max(from + 1, Math.floor(Math.pow((band + 1) / maxBands, 1.65) * (bins / 2)));
    let energy = 0;
    for (let k = from; k < Math.min(to, bins / 2); k++) {
      // Small deterministic DFT sample. It trades detail for a predictable bounded cost.
      let real = 0; let imag = 0;
      const frequency = (k + 0.5) / bins;
      for (let i = 0; i < bins; i += Math.max(1, Math.floor(bins / 256))) {
        const phase = 2 * Math.PI * frequency * i;
        real += mono[i] * Math.cos(phase); imag -= mono[i] * Math.sin(phase);
      }
      energy += Math.hypot(real, imag);
    }
    spectrum[band] = energy / Math.max(1, to - from);
  }
  let spectrumPeak = 0;
  for (const value of spectrum) spectrumPeak = Math.max(spectrumPeak, value);
  if (spectrumPeak) for (let i = 0; i < spectrum.length; i++) spectrum[i] /= spectrumPeak;

  const beats: number[] = [];
  const threshold = 0.62;
  const minGap = Math.max(1, Math.round(points * 0.18 / Math.max(snapshot.duration, 0.001)));
  let last = -minGap;
  for (let i = 1; i < waveform.length - 1; i++) {
    if (waveform[i] >= threshold && waveform[i] >= waveform[i - 1] && waveform[i] >= waveform[i + 1] && i - last >= minGap) {
      beats.push(Math.min(snapshot.duration, i * snapshot.duration / Math.max(1, points - 1))); last = i;
      if (beats.length >= maxBeats) break;
    }
  }
  return {
    duration: snapshot.duration,
    sampleRate: snapshot.sampleRate,
    waveform,
    spectrum,
    beats: Float32Array.from(beats),
    temporal: createTemporalEnvelope(snapshot, maxBands, options, spectrum),
  };
}

export interface AnalysisSample {
  amplitude: number;
  /** Broad spectral energy retained for existing scenes. */
  spectrum: number;
  low: number;
  mid: number;
  high: number;
  /** A view into the bounded temporal spectrum row, when available. */
  spectrumBands: Float32Array;
  beat: number;
}

export function analysisAt(analysis: AudioAnalysis, time: number): AnalysisSample {
  const safeTime = Number.isFinite(time) ? Math.max(0, Math.min(time, Math.max(0, analysis.duration))) : 0;
  const temporal = analysis.temporal;
  if (temporal && temporal.frameCount > 0) {
    const index = Math.min(temporal.frameCount - 1, Math.max(0, Math.floor(safeTime * temporal.frameRate)));
    const start = index * temporal.spectrumBands;
    const spectrumBands = temporal.spectrum.subarray(start, start + temporal.spectrumBands);
    let spectrum = 0;
    for (const value of spectrumBands) spectrum += value;
    spectrum /= Math.max(1, spectrumBands.length);
    let beat = 0;
    for (let i = 0; i < analysis.beats.length; i++) { const delta = safeTime - analysis.beats[i]; if (delta >= 0 && delta < 0.22) beat = Math.max(beat, 1 - delta / 0.22); }
    return {
      amplitude: temporal.amplitude[index] ?? 0,
      spectrum,
      low: temporal.low[index] ?? 0,
      mid: temporal.mid[index] ?? 0,
      high: temporal.high[index] ?? 0,
      spectrumBands,
      beat,
    };
  }

  // Compatibility for snapshots produced before temporal envelopes existed.
  const index = analysis.waveform.length ? Math.min(analysis.waveform.length - 1, Math.max(0, Math.floor(safeTime / Math.max(analysis.duration, 0.001) * analysis.waveform.length))) : 0;
  const spectrumIndex = analysis.spectrum.length ? Math.min(analysis.spectrum.length - 1, index % analysis.spectrum.length) : 0;
  const legacySpectrum = analysis.spectrum[spectrumIndex] ?? 0;
  let beat = 0;
  for (let i = 0; i < analysis.beats.length; i++) { const delta = safeTime - analysis.beats[i]; if (delta >= 0 && delta < 0.22) beat = Math.max(beat, 1 - delta / 0.22); }
  return { amplitude: analysis.waveform[index] ?? 0, spectrum: legacySpectrum, low: legacySpectrum, mid: legacySpectrum, high: legacySpectrum, spectrumBands: analysis.spectrum, beat };
}
