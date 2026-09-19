// @vitest-environment node
import { expect, it, vi } from "vitest";
import { runRenderJob } from "../src/workers/render-worker";
import { codecPolicy } from "../src/render/capabilities";
import type { WebCodecsEncoderAdapter } from "../src/render/encoder";
import type { RenderWorkerResponse } from "../src/workers/protocol";

it("separates draw, frame creation, video waits and all mux work without counting audio flush as video", async () => {
  let now = 0; let flushes = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("VideoFrame", class { constructor() { now += 3; } close() {} });
  const output = { aspectRatio: "16:9", resolution: "720p", frameRate: 30 } as const;
  const policy = codecPolicy(output, "vp9-opus");
  const messages: RenderWorkerResponse[] = [];
  const chunk = { type: "key" as const, timestamp: 0, data: new Uint8Array() };
  try {
    await runRenderJob({ type: "start", jobId: "timed", snapshot: { config: { schemaVersion: 1, template: { id: "quiet-editorial" }, output }, duration: .1, audio: { duration: .1, sampleRate: 48000, numberOfChannels: 1, channels: [new Float32Array(4800)] } } }, {
      post: message => messages.push(message),
      capabilityDetector: async () => ({ supported: true, canvas: true, videoEncoder: true, audioEncoder: true, mp4: true, reasons: [], suggestions: [], policy }),
      canvasFactory: () => ({ getContext: () => ({}) }) as unknown as OffscreenCanvas,
      sceneFactory: async () => ({ id: "quiet-editorial", render: () => { now += 2; } }),
      muxerFactory: () => { now += 1; return { addAudioChunk: () => { now += 7; }, addVideoChunk: () => { now += 1; }, finalize: () => { now += 2; return new Blob(); } }; },
      encoderFactory: (_config, _policy, muxer) => ({ configure: async () => {}, encodePcmSnapshot: async () => { muxer.addAudioChunk(chunk); return true; }, encodeVideo: async () => { now += 4; muxer.addVideoChunk(chunk); return true; }, flush: async () => { now += ++flushes === 1 ? 11 : 5; }, close() {}, counts: { audio: 1, video: 3 } }) as unknown as WebCodecsEncoderAdapter,
    });
    const complete = messages.find(message => message.type === "complete");
    expect(complete?.performance).toMatchObject({ canvasMs: 6, videoFrameMs: 9, videoEncodeMs: 17, muxMs: 13, frames: 3, codec: "VP9" });
    expect(flushes).toBe(2);
  } finally { clock.mockRestore(); vi.unstubAllGlobals(); }
});
