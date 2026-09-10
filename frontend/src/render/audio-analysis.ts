import type { AudioAnalysis } from "./types";

export const MAX_ANALYSIS_POINTS = 32_768;
export const MAX_SPECTRUM_BANDS = 128;
export const MAX_BEATS = 8_192;

export interface AnalysisOptions {
  maxPoints?: number;
  maxBands?: number;
  maxBeats?: number;
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
  return { duration: snapshot.duration, sampleRate: snapshot.sampleRate, waveform, spectrum, beats: Float32Array.from(beats) };
}

export function analysisAt(analysis: AudioAnalysis, time: number): { amplitude: number; spectrum: number; beat: number } {
  const index = analysis.waveform.length ? Math.min(analysis.waveform.length - 1, Math.max(0, Math.floor(time / Math.max(analysis.duration, 0.001) * analysis.waveform.length))) : 0;
  const spectrumIndex = analysis.spectrum.length ? Math.min(analysis.spectrum.length - 1, index % analysis.spectrum.length) : 0;
  let beat = 0;
  for (let i = 0; i < analysis.beats.length; i++) { const delta = time - analysis.beats[i]; if (delta >= 0 && delta < 0.22) beat = Math.max(beat, 1 - delta / 0.22); }
  return { amplitude: analysis.waveform[index] ?? 0, spectrum: analysis.spectrum[spectrumIndex] ?? 0, beat };
}
