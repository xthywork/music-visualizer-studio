// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateAudioDuration, validateAudioFile } from "../src/config";
import { DOMAIN_SCHEMA_VERSION, type RenderConfiguration } from "../src/domain";
import { analyzePcmAudioSnapshot } from "../src/render/audio-analysis";
import { detectCapabilities } from "../src/render/capabilities";
import { WebCodecsEncoderAdapter } from "../src/render/encoder";
import { Mp4MuxerAdapter } from "../src/render/muxer";
import { InMemoryProjectStorage } from "../src/storage/in-memory";
import { outputId, STORAGE_SCHEMA_VERSION, type StoredOutput } from "../src/storage";
import { ProjectService } from "../src/ui/project-service";
import { RenderController } from "../src/workers/orchestrator";
import type { RenderWorkerRequest, RenderWorkerResponse } from "../src/workers/protocol";
import type { PcmAudioSnapshot } from "../src/render/audio-analysis";
import type { RenderConfig } from "../src/render/types";

const renderConfig: RenderConfig = {
  schemaVersion: 1,
  template: { id: "spectrum-cover", title: "Failure test", artist: "Test" },
  output: { aspectRatio: "16:9", resolution: "720p", frameRate: 30 },
};

const domainConfig: RenderConfiguration = {
  schemaVersion: DOMAIN_SCHEMA_VERSION,
  templateId: "spectrum-cover",
  text: { title: "Failure test", artist: "Test" },
  output: { aspectRatio: "16:9", width: 1280, height: 720, frameRate: 30 },
};

const pcm: PcmAudioSnapshot = {
  duration: 0.1,
  sampleRate: 48_000,
  numberOfChannels: 1,
  channels: [new Float32Array(4_800)],
};

describe("actionable input and capability failures", () => {
  it("rejects invalid audio before a render can start", () => {
    expect(validateAudioFile({ name: "track.flac", type: "audio/flac", size: 10 })).toMatch(/MP3/);
    expect(validateAudioDuration(601)).toMatch(/10 分鐘/);
    expect(validateAudioDuration(Number.NaN)).toMatch(/音訊/);
  });

  it("reports unsupported codec/device capabilities with alternatives", async () => {
    class UnsupportedVideo {
      static async isConfigSupported(): Promise<{ supported: boolean }> { return { supported: false }; }
    }
    class UnsupportedAudio {
      static async isConfigSupported(): Promise<{ supported: boolean }> { return { supported: false }; }
    }
    const result = await detectCapabilities(
      { ...renderConfig.output, resolution: "4k" },
      {
        canvas: false,
        videoEncoder: UnsupportedVideo as unknown as typeof VideoEncoder,
        audioEncoder: UnsupportedAudio as unknown as typeof AudioEncoder,
        muxer: false,
      },
    );
    expect(result.supported).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Canvas|video encoder|audio encoder|muxing/);
    expect(result.suggestions.map((suggestion) => suggestion.resolution)).toEqual(["1080p", "720p"]);
  });
});

class FakeWorker {
  onmessage: ((event: MessageEvent<RenderWorkerResponse>) => void) | null = null;
  readonly messages: RenderWorkerRequest[] = [];
  postMessage(message: RenderWorkerRequest): void { this.messages.push(message); }
}

describe("worker cancellation and runtime failures", () => {
  it("transitions cancellation to a terminal state and never reports completion", () => {
    const worker = new FakeWorker();
    const controller = new RenderController(worker);
    const updates: RenderWorkerResponse[] = [];
    controller.onUpdate(({ response }) => updates.push(response));
    controller.start(renderConfig, pcm, pcm.duration, "cancel-job");
    worker.onmessage?.({ data: { type: "start", jobId: "cancel-job" } } as MessageEvent<RenderWorkerResponse>);
    controller.cancel();
    expect(worker.messages.at(-1)).toEqual({ type: "cancel", jobId: "cancel-job" });
    worker.onmessage?.({ data: { type: "cancel", jobId: "cancel-job" } } as MessageEvent<RenderWorkerResponse>);
    expect(controller.getState()).toBe("cancelled");
    expect(updates.some((response) => response.type === "complete")).toBe(false);
  });

  it("surfaces memory/encoder failures as actionable failed state", () => {
    const worker = new FakeWorker();
    const controller = new RenderController(worker);
    let failure: RenderWorkerResponse | undefined;
    controller.onUpdate(({ response }) => { failure = response; });
    controller.start(renderConfig, pcm, pcm.duration, "memory-job");
    worker.onmessage?.({ data: { type: "error", jobId: "memory-job", error: { code: "MEMORY_EXHAUSTED", message: "Lower resolution or close other tabs and retry." } } } as MessageEvent<RenderWorkerResponse>);
    expect(controller.getState()).toBe("failed");
    expect(failure).toMatchObject({ type: "error", error: { code: "MEMORY_EXHAUSTED" } });
    expect((failure as Extract<RenderWorkerResponse, { type: "error" }>).error.message).toMatch(/retry/);
  });

  it("does not expose a partial MP4 when muxing fails", () => {
    const adapter = new Mp4MuxerAdapter(() => ({
      addVideoChunk: () => { throw new Error("muxing failed: invalid chunk"); },
      addAudioChunk: () => undefined,
      finalize: () => new Blob(["partial"], { type: "video/mp4" }),
    }));
    let muxError: unknown;
    try {
      adapter.mux({
        video: [{ type: "key", timestamp: 0, data: new Uint8Array([1]) }],
        audio: [],
        metadata: { width: 320, height: 180, frameRate: 30, duration: 1, hasAudio: false, hasVideo: true },
      });
    } catch (error) {
      muxError = error;
    }
    expect(muxError).toBeInstanceOf(Error);
    expect((muxError as Error).message).toMatch(/muxing failed/);
  });

  it("persists a useful failed state after a muxing error", async () => {
    const storage = new InMemoryProjectStorage();
    const service = new ProjectService(storage, { now: () => "2026-01-02T00:00:00.000Z", createId: () => "project-1" });
    const project = await service.createProject("Mux failure", domainConfig);
    const render = await service.queueRender(project.id, "render-1");
    const failed = await service.markFailed(project.id, render.id, {
      code: "MUX_FAILED",
      message: "MP4 assembly failed; no partial output was saved. Retry with a supported preset.",
    });
    expect(failed).toMatchObject({ status: "failed", error: { code: "MUX_FAILED" } });
    expect(failed.error?.message).toMatch(/Retry/);
    expect(await service.getOutput(project.id, render.id)).toBeUndefined();
  });

  it("reports encoder configuration errors before frames are queued", async () => {
    class ThrowingEncoder {
      constructor(_init: unknown) {}
      configure(): void { throw new Error("Encoder rejected requested device profile"); }
      encode(): void {}
      async flush(): Promise<void> {}
      close(): void {}
    }
    const adapter = new WebCodecsEncoderAdapter(renderConfig.output, {
      videoEncoder: ThrowingEncoder as unknown as typeof VideoEncoder,
      audioEncoder: ThrowingEncoder as unknown as typeof AudioEncoder,
    });
    await expect(adapter.configure()).rejects.toThrow(/device profile/);
    adapter.close();
  });

  it("keeps analysis buffers bounded for memory-constrained sessions", () => {
    const analysis = analyzePcmAudioSnapshot({
      duration: 60,
      sampleRate: 48_000,
      numberOfChannels: 1,
      channels: [new Float32Array(48_000 * 60)],
    }, { maxPoints: 32, maxBands: 8, maxBeats: 2 });
    expect(analysis.waveform.length).toBeLessThanOrEqual(32);
    expect(analysis.spectrum.length).toBe(8);
    expect(analysis.beats.length).toBeLessThanOrEqual(2);
  });
});

describe("reload and local quota failures", () => {
  it("reconciles an active render after reload and removes its output", async () => {
    const storage = new InMemoryProjectStorage();
    const service = new ProjectService(storage, { now: () => "2026-01-02T00:00:00.000Z", createId: () => "project-1" });
    const project = await service.createProject("Reload", domainConfig);
    const render = await service.queueRender(project.id, "render-1");
    const output: StoredOutput = {
      id: outputId(project.id, render.id), projectId: project.id, renderId: render.id,
      schemaVersion: STORAGE_SCHEMA_VERSION, blob: new Blob(["partial"], { type: "video/mp4" }),
      metadata: { mimeType: "video/mp4", byteLength: 7, durationMs: 1000, width: 1280, height: 720, frameRate: 30, createdAt: "2026-01-02T00:00:00.000Z" },
    };
    await storage.saveOutput(output);
    const reconciled = await service.reconcileInterruptedRenders();
    expect(reconciled[0].renders[0]).toMatchObject({ status: "interrupted", error: { code: "render-interrupted" } });
    expect(await service.getOutput(project.id, render.id)).toBeUndefined();
  });

  it("returns a quota error with retry state and frees space after output deletion", async () => {
    const storage = new InMemoryProjectStorage({ maxBytes: 3_000 });
    const service = new ProjectService(storage, { now: () => "2026-01-02T00:00:00.000Z", createId: () => "project-1" });
    const project = await service.createProject("Quota", domainConfig);
    const first = await service.queueRender(project.id, "render-1");
    const saved = await service.recordCompletedRender(project.id, first.id, new Blob([new Uint8Array(800)]), {
      mimeType: "video/mp4", byteLength: 800, durationMs: 1000, width: 1280, height: 720, frameRate: 30, createdAt: "2026-01-02T00:00:00.000Z",
    });
    expect(saved.outputSaved).toBe(true);
    const second = await service.queueRender(project.id, "render-2");
    const rejected = await service.recordCompletedRender(project.id, second.id, new Blob([new Uint8Array(2_500)]), {
      mimeType: "video/mp4", byteLength: 2_500, durationMs: 1000, width: 1280, height: 720, frameRate: 30, createdAt: "2026-01-02T00:00:00.000Z",
    });
    expect(rejected.outputSaved).toBe(false);
    expect(rejected.quotaError?.message).toMatch(/quota/i);
    expect((await service.reopenProject(project.id))?.renders.at(-1)?.status).toBe("completed");
    await service.deleteOutput(project.id, first.id);
    expect((await service.estimateQuota()).availableBytes).toBeGreaterThan(0);
  });
});
