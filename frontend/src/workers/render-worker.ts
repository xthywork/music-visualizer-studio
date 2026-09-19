import { analyzePcmAudioSnapshot, releasePcmAudioSnapshot } from "../render/audio-analysis";
import { detectCapabilities } from "../render/capabilities";
import { WebCodecsEncoderAdapter } from "../render/encoder";
import { createMp4MuxerFactory, Mp4MuxerAdapter, type MuxerFactory } from "../render/muxer";
import { createSceneAsync, disposeScene } from "../render/scenes";
import { dimensionsFor, frameCount, type Scene } from "../render/types";
import type { RenderWorkerRequest, RenderWorkerResponse, RenderPerformance } from "./protocol";

export interface RenderRuntimeDeps {
  muxerFactory?: MuxerFactory;
  post?: (response: RenderWorkerResponse) => void;
  /** Retains cancellation that arrives while async capability preflight runs. */
  isCancelled?: () => boolean;
  capabilityDetector?: typeof detectCapabilities;
  canvasFactory?: (width: number, height: number) => OffscreenCanvas;
  sceneFactory?: typeof createSceneAsync;
  encoderFactory?: (
    config: Extract<RenderWorkerRequest, { type: "start" }>["snapshot"]["config"],
    policy: NonNullable<Awaited<ReturnType<typeof detectCapabilities>>["policy"]>,
    muxer: Mp4MuxerAdapter,
  ) => WebCodecsEncoderAdapter;
}

export async function runRenderJob(request: Extract<RenderWorkerRequest, { type: "start" }>, deps: RenderRuntimeDeps = {}): Promise<void> {
  const post = deps.post ?? (() => undefined); const { config, audio, duration } = request.snapshot;
  let scene: Scene | undefined;
  let muxer: Mp4MuxerAdapter | undefined;
  let encoder: WebCodecsEncoderAdapter | undefined;
  let primaryError: unknown;
  const jobStarted = performance.now();
  try {
    const capability = await (deps.capabilityDetector ?? detectCapabilities)(config.output, { muxer: true });
    if (!capability.supported) throw new Error(capability.reasons.join(" "));
    if (deps.isCancelled?.()) { post({ type: "cancel", jobId: request.jobId }); return; }
    const selectedPolicy = capability.policy;
    if (!selectedPolicy) throw new Error("Capability preflight returned no codec policy.");
    const timings: RenderPerformance = { canvasMs: 0, videoFrameMs: 0, videoEncodeMs: 0, muxMs: 0, workerMs: 0, frames: 0, width: 0, height: 0, codec: selectedPolicy.video.containerCodec === "avc" ? "H.264" : "VP9" };
    const analysis = analyzePcmAudioSnapshot(audio); const dimensions = dimensionsFor(config.output); const totalFrames = frameCount(Math.min(duration, analysis.duration), config.output.frameRate);
    const canvas = (deps.canvasFactory ?? ((width, height) => new OffscreenCanvas(width, height)))(dimensions.width, dimensions.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to create an OffscreenCanvas rendering context.");
    scene = await (deps.sceneFactory ?? createSceneAsync)(config.template.id, config.template);
    muxer = new Mp4MuxerAdapter(deps.muxerFactory ?? createMp4MuxerFactory(selectedPolicy));
    const muxMetadata = { width: dimensions.width, height: dimensions.height, frameRate: config.output.frameRate, duration: analysis.duration, hasAudio: true, hasVideo: true, codecPolicy: selectedPolicy };
    encoder = deps.encoderFactory
      ? deps.encoderFactory(config, selectedPolicy, muxer)
      : new WebCodecsEncoderAdapter(config.output, {}, selectedPolicy, {
          // Encoded chunks are consumed immediately. Do not retain a second copy of
          // the whole video/audio stream while mp4-muxer builds its single output.
          video: (chunk) => muxer?.addVideoChunk(chunk),
          audio: (chunk) => muxer?.addAudioChunk(chunk),
        });
    const isCancelled = () => Boolean(deps.isCancelled?.());
    muxer.begin(muxMetadata);
    await encoder.configure();
    const audioEncoded = await encoder.encodePcmSnapshot(audio, 1024, 48_000, isCancelled);
    if (!audioEncoded) { post({ type: "cancel", jobId: request.jobId }); return; }
    // Drain audio before measuring video waits, so the final flush excludes pending audio.
    await encoder.flush();
    // Analysis is already reduced to bounded waveform/spectrum arrays and the
    // encoder has consumed all PCM blocks. Release the transferred track before
    // allocating/encoding the potentially large video frame sequence.
    releasePcmAudioSnapshot(audio);
    const started = performance.now();
    for (let frame = 0; frame < totalFrames; frame++) {
      if (isCancelled()) { post({ type: "cancel", jobId: request.jobId }); return; }
      const time = frame / config.output.frameRate;
      const drawStart = performance.now();
      scene.render(context, { time, frame, progress: frame / Math.max(1, totalFrames - 1), width: dimensions.width, height: dimensions.height, analysis });
      timings.canvasMs += performance.now() - drawStart;
      const VideoFrameCtor = (globalThis as any).VideoFrame;
      if (!VideoFrameCtor) throw new Error("VideoFrame is unavailable in this worker.");
      const frameStart = performance.now();
      const videoFrame = new VideoFrameCtor(canvas, { timestamp: frame * 1_000_000 / config.output.frameRate, duration: 1_000_000 / config.output.frameRate });
      timings.videoFrameMs += performance.now() - frameStart;
      const encodeStart = performance.now(); const muxBefore = muxer.elapsedMs;
      try {
        if (!await encoder.encodeVideo(videoFrame, frame === 0, isCancelled)) { post({ type: "cancel", jobId: request.jobId }); return; }
      } finally {
        timings.videoEncodeMs += Math.max(0, performance.now() - encodeStart - (muxer.elapsedMs - muxBefore));
        videoFrame.close?.();
      }
      const elapsedMs = performance.now() - started; const progress = (frame + 1) / totalFrames;
      post({ type: "progress", jobId: request.jobId, progress, frame: frame + 1, totalFrames, elapsedMs, etaMs: progress ? elapsedMs * (1 - progress) / progress : undefined });
      if (frame % 4 === 3) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const flushStart = performance.now(); const muxBefore = muxer.elapsedMs;
    await encoder.flush();
    timings.videoEncodeMs += Math.max(0, performance.now() - flushStart - (muxer.elapsedMs - muxBefore));
    const output = muxer.finalize();
    Object.assign(timings, { muxMs: muxer.elapsedMs, workerMs: performance.now() - jobStarted, frames: totalFrames, width: dimensions.width, height: dimensions.height });
    const counts = encoder.counts;
    post({ type: "complete", jobId: request.jobId, output, performance: timings, metadata: { width: dimensions.width, height: dimensions.height, frameRate: config.output.frameRate, duration: analysis.duration, hasAudio: counts.audio > 0, hasVideo: counts.video > 0 } });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      () => encoder?.close(),
      () => muxer?.close(),
      () => { if (scene) disposeScene(scene); },
      () => releasePcmAudioSnapshot(audio),
    ]) {
      try { cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (primaryError === undefined && cleanupErrors.length) throw cleanupErrors[0];
  }
}

type RenderJobRunner = (request: Extract<RenderWorkerRequest, { type: "start" }>, deps: RenderRuntimeDeps) => Promise<void>;

/** Owns worker job identity so cancel and terminal cleanup cannot target a later job. */
export function createRenderWorkerMessageHandler(
  post: (message: RenderWorkerResponse) => void,
  runner: RenderJobRunner = runRenderJob,
): (event: MessageEvent<RenderWorkerRequest>) => void {
  let activeJob: { readonly jobId: string; cancelled: boolean } | undefined;
  return (event) => {
    const request = event.data;
    if (request.type === "cancel") {
      if (request.jobId === activeJob?.jobId) activeJob.cancelled = true;
      return;
    }
    if (activeJob) {
      post({
        type: "error",
        jobId: request.jobId,
        error: { code: "RENDER_BUSY", message: "A render is already in progress in this worker." },
      });
      return;
    }
    const job = { jobId: request.jobId, cancelled: false };
    activeJob = job;
    post({ type: "start", jobId: request.jobId });
    void runner(request, {
      post,
      isCancelled: () => job.cancelled,
    }).catch((error: unknown) => post({
      type: "error",
      jobId: request.jobId,
      error: { code: "RENDER_FAILED", message: error instanceof Error ? error.message : String(error) },
    })).finally(() => {
      if (activeJob === job) activeJob = undefined;
    });
  };
}

const workerScope = globalThis as unknown as { postMessage?: (message: RenderWorkerResponse) => void; onmessage?: (event: MessageEvent<RenderWorkerRequest>) => void };
if (typeof workerScope.postMessage === "function" && typeof document === "undefined") {
  workerScope.onmessage = createRenderWorkerMessageHandler((message) => workerScope.postMessage?.(message));
}
