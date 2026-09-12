import type { AspectRatio, OutputConfiguration, TemplateId } from "../domain/models";

/** Serializable boundary shared by preview, worker, and a future server renderer. */
export type { AspectRatio, TemplateId } from "../domain/models";
export type FrameRate = OutputConfiguration["frameRate"];
export type Resolution = "720p" | "1080p" | "1440p" | "4k";

export interface OutputConfig {
  aspectRatio: AspectRatio;
  resolution: Resolution;
  frameRate: FrameRate;
}

export interface TemplateConfig {
  id: TemplateId;
  title?: string;
  artist?: string;
  /** Data URL or an application-managed object URL. Never a source-audio URL. */
  coverImage?: string;
  backgroundImage?: string;
  accentColor?: string;
}

export interface RenderConfig {
  schemaVersion: 1;
  template: TemplateConfig;
  output: OutputConfig;
}

/**
 * Bounded, time-aligned audio features used by animated scenes.
 *
 * `spectrum` is packed row-major (`frame * spectrumBands + band`) so a long
 * song does not create one JavaScript array per frame.  All values are
 * normalized to the range 0..1.
 */
export interface TemporalAudioEnvelope {
  /** Effective frames per second. It can be lower than the requested rate for very long audio. */
  frameRate: number;
  /** Number of rows in each envelope and in the packed spectrum. */
  frameCount: number;
  amplitude: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  spectrumBands: number;
  spectrum: Float32Array;
}

export interface AudioAnalysis {
  duration: number;
  sampleRate: number;
  /** Normalized mono waveform, bounded to maxPoints. */
  waveform: Float32Array;
  /** Log-scaled, normalized frequency bands, bounded to maxBands. */
  spectrum: Float32Array;
  /** Seconds since start of detected transient/beat events. */
  beats: Float32Array;
  /** Optional bounded time series. Older snapshots may omit this field. */
  temporal?: TemporalAudioEnvelope;
}

export interface SceneFrameContext {
  time: number;
  frame: number;
  progress: number;
  width: number;
  height: number;
  analysis: AudioAnalysis;
}

export interface Scene {
  readonly id: TemplateId;
  render(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, frame: SceneFrameContext): void;
  dispose?(): void;
}

export interface RenderJobSnapshot {
  config: RenderConfig;
  duration: number;
  /** Audio bytes are deliberately transient and must not be persisted. */
  audio: ArrayBuffer;
}

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 16, height: 9 },
  "9:16": { width: 9, height: 16 },
  "1:1": { width: 1, height: 1 },
};

export function dimensionsFor(output: OutputConfig): { width: number; height: number } {
  const base = output.resolution === "720p" ? 720 : output.resolution === "1080p" ? 1080 : output.resolution === "1440p" ? 1440 : 2160;
  if (output.aspectRatio === "16:9") return { width: Math.round(base * 16 / 9), height: base };
  if (output.aspectRatio === "9:16") return { width: base, height: Math.round(base * 16 / 9) };
  return { width: base, height: base };
}

export function frameCount(duration: number, fps: FrameRate): number {
  return Math.max(1, Math.ceil(Math.max(0, duration) * fps));
}

export function cloneRenderConfig(config: RenderConfig): RenderConfig {
  return JSON.parse(JSON.stringify(config)) as RenderConfig;
}
