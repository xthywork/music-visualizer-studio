import type { PcmAudioSnapshot } from "../render/audio-analysis";
import type { RenderConfig } from "../render/types";

export type RenderWorkerRequest =
  | { type: "start"; jobId: string; snapshot: { config: RenderConfig; duration: number; audio: PcmAudioSnapshot } }
  | { type: "cancel"; jobId: string };

export type RenderWorkerResponse =
  | { type: "start"; jobId: string }
  | { type: "progress"; jobId: string; progress: number; frame: number; totalFrames: number; elapsedMs: number; etaMs?: number }
  | { type: "complete"; jobId: string; output: Blob; metadata: { width: number; height: number; frameRate: number; duration: number; hasAudio: boolean; hasVideo: boolean } }
  | { type: "cancel"; jobId: string }
  | { type: "error"; jobId: string; error: { code: string; message: string } };

export function freezeSnapshot(snapshot: Extract<RenderWorkerRequest, { type: "start" }>): Extract<RenderWorkerRequest, { type: "start" }> {
  const start = snapshot as Extract<RenderWorkerRequest, { type: "start" }>;
  const immutable = { ...start, snapshot: { ...start.snapshot, config: JSON.parse(JSON.stringify(start.snapshot.config)), audio: { ...start.snapshot.audio, channels: start.snapshot.audio.channels.map((channel) => new Float32Array(channel)) } } } as Extract<RenderWorkerRequest, { type: "start" }>;
  return Object.freeze(immutable);
}

export type RenderState = "idle" | "queued" | "rendering" | "completed" | "cancelled" | "failed";

export function transitionState(current: RenderState, event: RenderWorkerResponse["type"]): RenderState {
  if (event === "start") return "rendering";
  if (event === "progress") return current === "queued" || current === "rendering" ? "rendering" : current;
  if (event === "complete") return "completed";
  if (event === "cancel") return "cancelled";
  if (event === "error") return "failed";
  return current;
}
