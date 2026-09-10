import type { RenderConfig } from "../render/types";
import { pcmSnapshotFromAudioBuffer, pcmSnapshotTransferables, type PcmAudioSnapshot } from "../render/audio-analysis";
import { freezeSnapshot, transitionState, type RenderState, type RenderWorkerRequest, type RenderWorkerResponse } from "./protocol";

export interface RenderWorkerLike { postMessage(message: RenderWorkerRequest, transfer?: Transferable[]): void; terminate?(): void; onmessage: ((event: MessageEvent<RenderWorkerResponse>) => void) | null; }
export interface RenderUpdate { state: RenderState; response: RenderWorkerResponse; }

export class RenderController {
  private state: RenderState = "idle";
  private jobId?: string;
  private listener?: (update: RenderUpdate) => void;
  constructor(private readonly worker: RenderWorkerLike) { worker.onmessage = (event) => this.receive(event.data); }
  onUpdate(listener: (update: RenderUpdate) => void) { this.listener = listener; return () => { if (this.listener === listener) this.listener = undefined; }; }
  start(config: RenderConfig, audio: PcmAudioSnapshot, duration = audio.duration, jobId = createJobId()): string {
    if (this.state === "queued" || this.state === "rendering") throw new Error("A render is already in progress.");
    this.jobId = jobId; this.state = "queued";
    // PCM is already a transient copy made from AudioBuffer. Transfer that
    // copy directly instead of cloning the entire track a second time.
    const request = freezeSnapshot({ type: "start", jobId, snapshot: { config, audio, duration } }, { copyAudio: false });
    this.worker.postMessage(request, pcmSnapshotTransferables(request.snapshot.audio)); return jobId;
  }
  /** Decode on the main thread, copy only transient PCM, then transfer it to the worker. */
  startFromAudioBuffer(config: RenderConfig, audioBuffer: AudioBuffer, jobId?: string): string {
    return this.start(config, pcmSnapshotFromAudioBuffer(audioBuffer), audioBuffer.duration, jobId);
  }
  cancel() { if (this.jobId && (this.state === "queued" || this.state === "rendering")) this.worker.postMessage({ type: "cancel", jobId: this.jobId }); }
  private receive(response: RenderWorkerResponse) { if (response.jobId !== this.jobId) return; this.state = transitionState(this.state, response.type); this.listener?.({ state: this.state, response }); }
  getState() { return this.state; }
  dispose() { this.worker.terminate?.(); this.listener = undefined; this.jobId = undefined; this.state = "idle"; }
}

function createJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
