import type { OutputConfig } from "./types";
import { dimensionsFor } from "./types";

export type CodecPath = "h264-aac" | "h264-opus" | "vp9-aac" | "vp9-opus";
export type HardwareAcceleration = "prefer-hardware" | "no-preference" | "prefer-software";

export interface CodecPolicy {
  path: CodecPath;
  hardwareAcceleration: HardwareAcceleration;
  video: { codec: string; containerCodec: "avc" | "vp9"; width: number; height: number; bitrate: number; framerate: number; hardwareAcceleration: HardwareAcceleration; avc?: { format: "avc" } };
  audio: { codec: string; containerCodec: "aac" | "opus"; sampleRate: number; numberOfChannels: number; bitrate: number };
}

export interface CapabilityResult {
  supported: boolean;
  canvas: boolean;
  videoEncoder: boolean;
  audioEncoder: boolean;
  mp4: boolean;
  reasons: string[];
  suggestions: OutputConfig[];
  policy?: CodecPolicy;
  codecPath?: CodecPath;
}

export interface CapabilityEnvironment {
  canvas?: boolean;
  videoEncoder?: typeof VideoEncoder;
  audioEncoder?: typeof AudioEncoder;
  isTypeSupported?: (codec: string) => Promise<boolean>;
  muxer?: boolean;
  hardwareAcceleration?: HardwareAcceleration;
}

const AAC_CODEC = "mp4a.40.2";
const OPUS_CODEC = "opus";

function h264Codec(output: OutputConfig): string {
  if (output.resolution === "4k") return "avc1.640034";
  if (output.resolution === "1440p" || output.frameRate >= 50) return "avc1.64002a";
  if (output.resolution === "1080p") return "avc1.4d4028";
  return "avc1.42001f";
}

function candidatePolicy(output: OutputConfig, path: CodecPath, hardwareAcceleration: HardwareAcceleration): CodecPolicy {
  const { width, height } = dimensionsFor(output); const h264 = path.startsWith("h264"); const aac = path.endsWith("aac");
  return {
    path, hardwareAcceleration,
    video: { codec: h264 ? h264Codec(output) : "vp09.00.10.08", containerCodec: h264 ? "avc" : "vp9", width, height, bitrate: output.resolution === "4k" ? 32_000_000 : 8_000_000, framerate: output.frameRate, hardwareAcceleration, ...(h264 ? { avc: { format: "avc" as const } } : {}) },
    audio: { codec: aac ? AAC_CODEC : OPUS_CODEC, containerCodec: aac ? "aac" : "opus", sampleRate: 48_000, numberOfChannels: 2, bitrate: aac ? 192_000 : 128_000 },
  };
}

async function configSupported(encoder: typeof VideoEncoder | typeof AudioEncoder | undefined, config: unknown, codec: string, typeSupported?: (codec: string) => Promise<boolean>): Promise<boolean> {
  if (!encoder) return false;
  if (typeSupported && !(await typeSupported(codec))) return false;
  if (!encoder.isConfigSupported) return true;
  try { return Boolean((await encoder.isConfigSupported(config as never)).supported); } catch { return false; }
}

/** Probe complete pairs in priority order, trying hardware before CPU fallbacks. */
export async function detectCapabilities(output: OutputConfig, env: CapabilityEnvironment = {}): Promise<CapabilityResult> {
  const videoEncoder = env.videoEncoder ?? globalThis.VideoEncoder; const audioEncoder = env.audioEncoder ?? globalThis.AudioEncoder;
  const canvas = env.canvas ?? (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined"); const mp4 = env.muxer ?? true;
  const preferred = env.hardwareAcceleration ?? "prefer-hardware";
  const accelerationOrder: HardwareAcceleration[] = preferred === "prefer-hardware" ? ["prefer-hardware", "no-preference", "prefer-software"] : [preferred, "no-preference", "prefer-software"];
  let selected: CodecPolicy | undefined;
  for (const path of ["h264-aac", "h264-opus", "vp9-aac", "vp9-opus"] as const) {
    const audioPolicy = candidatePolicy(output, path, "no-preference");
    if (!await configSupported(audioEncoder, audioPolicy.audio, audioPolicy.audio.codec, env.isTypeSupported)) continue;
    for (const acceleration of accelerationOrder) {
      const policy = candidatePolicy(output, path, acceleration);
      if (await configSupported(videoEncoder, policy.video, policy.video.codec, env.isTypeSupported)) { selected = policy; break; }
    }
    if (selected) break;
  }
  const reasons: string[] = [];
  if (!canvas) reasons.push("Canvas or OffscreenCanvas is unavailable.");
  if (!selected) reasons.push("No playable MP4 codec pair is supported (tried H.264/AAC, H.264/Opus, VP9/AAC, and VP9/Opus).");
  if (!mp4) reasons.push("No MP4 muxing path is available.");
  const suggestions: OutputConfig[] = [];
  if (!(canvas && selected && mp4)) for (const resolution of ["1080p", "720p"] as const) if (resolution !== output.resolution) suggestions.push({ ...output, resolution });
  return { supported: reasons.length === 0, canvas, videoEncoder: Boolean(selected), audioEncoder: Boolean(selected), mp4, reasons, suggestions, policy: selected, codecPath: selected?.path };
}

/** Deterministic preferred policy before runtime support is known. */
export function codecPolicy(output: OutputConfig, path: CodecPath = "h264-aac", hardwareAcceleration: HardwareAcceleration = "prefer-hardware"): CodecPolicy {
  return candidatePolicy(output, path, hardwareAcceleration);
}
