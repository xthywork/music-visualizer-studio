import { analyzePcmAudioSnapshot, releasePcmAudioSnapshot } from "../render/audio-analysis";
import { detectCapabilities } from "../render/capabilities";
import { WebCodecsEncoderAdapter } from "../render/encoder";
import { createMp4MuxerFactory, Mp4MuxerAdapter, type MuxerFactory } from "../render/muxer";
import { createSceneAsync, disposeScene } from "../render/scenes";
import { dimensionsFor, frameCount } from "../render/types";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./protocol";

export interface RenderRuntimeDeps {
  muxerFactory?: MuxerFactory;
  post?: (response: RenderWorkerResponse) => void;
  /** Retains cancellation that arrives while async capability preflight runs. */
  isCancelled?: () => boolean;
}

export async function runRenderJob(request: Extract<RenderWorkerRequest, { type: "start" }>, deps: RenderRuntimeDeps = {}): Promise<void> {
  const post = deps.post ?? (() => undefined); const { config, audio, duration } = request.snapshot;
  let selectedPolicy: Awaited<ReturnType<typeof detectCapabilities>>["policy"];
  const muxerFactory = deps.muxerFactory;
  const capability = await detectCapabilities(config.output, { muxer: true });
  if (!capability.supported) throw new Error(capability.reasons.join(" "));
  if (deps.isCancelled?.()) { releasePcmAudioSnapshot(audio); post({ type: "cancel", jobId: request.jobId }); return; }
  selectedPolicy = capability.policy;
  if (!selectedPolicy) throw new Error("Capability preflight returned no codec policy.");
  const analysis = analyzePcmAudioSnapshot(audio); const dimensions = dimensionsFor(config.output); const totalFrames = frameCount(Math.min(duration, analysis.duration), config.output.frameRate);
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height); const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create an OffscreenCanvas rendering context.");
  const scene = await createSceneAsync(config.template.id, config.template);
  const muxer = new Mp4MuxerAdapter(muxerFactory ?? createMp4MuxerFactory(selectedPolicy));
  const muxMetadata = { width: dimensions.width, height: dimensions.height, frameRate: config.output.frameRate, duration: analysis.duration, hasAudio: true, hasVideo: true, codecPolicy: selectedPolicy };
  const encoder = new WebCodecsEncoderAdapter(config.output, {}, selectedPolicy, {
    // Encoded chunks are consumed immediately. Do not retain a second copy of
    // the whole video/audio stream while mp4-muxer builds its single output.
    video: (chunk) => muxer.addVideoChunk(chunk),
    audio: (chunk) => muxer.addAudioChunk(chunk),
  });
  let cancelled = false; const cancel = () => { cancelled = true; };
  const isCancelled = () => cancelled || Boolean(deps.isCancelled?.());
  // The worker protocol can replace this callback while the job is active.
  (runRenderJob as unknown as { cancel?: () => void }).cancel = cancel;
  try {
    muxer.begin(muxMetadata);
    await encoder.configure();
    const audioEncoded = await encoder.encodePcmSnapshot(audio, 1024, 48_000, isCancelled);
    if (!audioEncoded) { post({ type: "cancel", jobId: request.jobId }); return; }
    // Analysis is already reduced to bounded waveform/spectrum arrays and the
    // encoder has consumed all PCM blocks. Release the transferred track before
    // allocating/encoding the potentially large video frame sequence.
    releasePcmAudioSnapshot(audio);
    const started = performance.now();
    for (let frame = 0; frame < totalFrames; frame++) {
      if (isCancelled()) { post({ type: "cancel", jobId: request.jobId }); return; }
      const time = frame / config.output.frameRate; scene.render(context, { time, frame, progress: frame / Math.max(1, totalFrames - 1), width: dimensions.width, height: dimensions.height, analysis });
      const VideoFrameCtor = (globalThis as any).VideoFrame;
      if (!VideoFrameCtor) throw new Error("VideoFrame is unavailable in this worker.");
      const videoFrame = new VideoFrameCtor(canvas, { timestamp: frame * 1_000_000 / config.output.frameRate, duration: 1_000_000 / config.output.frameRate });
      try {
        if (!await encoder.encodeVideo(videoFrame, frame === 0, isCancelled)) { post({ type: "cancel", jobId: request.jobId }); return; }
      } finally { videoFrame.close?.(); }
      const elapsedMs = performance.now() - started; const progress = (frame + 1) / totalFrames;
      post({ type: "progress", jobId: request.jobId, progress, frame: frame + 1, totalFrames, elapsedMs, etaMs: progress ? elapsedMs * (1 - progress) / progress : undefined });
      if (frame % 4 === 3) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await encoder.flush();
    const output = muxer.finalize();
    const counts = encoder.counts;
    post({ type: "complete", jobId: request.jobId, output, metadata: { width: dimensions.width, height: dimensions.height, frameRate: config.output.frameRate, duration: analysis.duration, hasAudio: counts.audio > 0, hasVideo: counts.video > 0 } });
  } finally {
    encoder.close(); muxer.close(); disposeScene(scene); releasePcmAudioSnapshot(audio);
    (runRenderJob as unknown as { cancel?: () => void }).cancel = undefined;
  }
}

const workerScope = globalThis as unknown as { postMessage?: (message: RenderWorkerResponse) => void; onmessage?: (event: MessageEvent<RenderWorkerRequest>) => void };
if (typeof workerScope.postMessage === "function" && typeof document === "undefined") {
  let activeJob: string | undefined;
  const cancelledJobs = new Set<string>();
  workerScope.onmessage = (event) => {
    const request = event.data;
    if (request.type === "cancel") {
      if (request.jobId === activeJob) {
        cancelledJobs.add(request.jobId);
        (runRenderJob as unknown as { cancel?: () => void }).cancel?.();
      }
      return;
    }
    activeJob = request.jobId; workerScope.postMessage?.({ type: "start", jobId: request.jobId });
    runRenderJob(request, {
      post: (response) => workerScope.postMessage?.(response),
      isCancelled: () => cancelledJobs.has(request.jobId),
    }).catch((error: unknown) => workerScope.postMessage?.({ type: "error", jobId: request.jobId, error: { code: "RENDER_FAILED", message: error instanceof Error ? error.message : String(error) } })).finally(() => {
      cancelledJobs.delete(request.jobId);
      activeJob = undefined;
    });
  };
}
