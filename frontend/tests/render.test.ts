import { describe, expect, it } from "vitest";
import { analysisAt, analyzeAudioBuffer, analyzePcmAudioSnapshot, pcmSnapshotFromAudioBuffer, pcmSnapshotTransferables, releasePcmAudioSnapshot, type PcmAudioSnapshot } from "../src/render/audio-analysis";
import { codecPolicy, detectCapabilities } from "../src/render/capabilities";
import { createRenderTiming } from "../src/render/renderer";
import { createScene, TEMPLATE_IDS } from "../src/render/scenes";
import { dimensionsFor, type RenderConfig } from "../src/render/types";
import { freezeSnapshot, transitionState } from "../src/workers/protocol";
import { renderConfigFromDomain, renderConfigToDomain } from "../src/render/domain-adapter";
import { createMp4MuxerFactory, Mp4MuxerAdapter } from "../src/render/muxer";

const config: RenderConfig = { schemaVersion: 1, template: { id: "spectrum-cover", title: "Test", artist: "Artist" }, output: { aspectRatio: "16:9", resolution: "720p", frameRate: 30 } };

describe("render configuration and timing", () => {
  it("produces stable dimensions and frame timing for every aspect ratio", () => {
    expect(dimensionsFor(config.output)).toEqual({ width: 1280, height: 720 });
    expect(dimensionsFor({ ...config.output, aspectRatio: "9:16" })).toEqual({ width: 720, height: 1280 });
    expect(dimensionsFor({ ...config.output, aspectRatio: "1:1" })).toEqual({ width: 720, height: 720 });
    expect(createRenderTiming(config, 2)).toEqual({ totalFrames: 60, frameDuration: 1_000_000 / 30, secondsPerFrame: 1 / 30 });
  });
  it("round-trips the persisted domain configuration through the worker boundary", () => {
    const domain = { schemaVersion: 1 as const, templateId: "vinyl-particle" as const, text: { title: "Song", artist: "Band" }, coverImage: { kind: "data-url" as const, value: "data:image/png;base64,x" }, output: { aspectRatio: "1:1" as const, width: 2160, height: 2160, frameRate: 60 as const } };
    expect(renderConfigToDomain(renderConfigFromDomain(domain))).toEqual(domain);
  });
  it("maps 720p domain dimensions correctly in landscape and portrait", () => {
    for (const output of [
      { aspectRatio: "16:9" as const, width: 1280, height: 720, frameRate: 30 as const },
      { aspectRatio: "9:16" as const, width: 720, height: 1280, frameRate: 30 as const },
    ]) {
      const domain = { schemaVersion: 1 as const, templateId: "spectrum-cover" as const, text: { title: "", artist: "" }, output };
      expect(renderConfigFromDomain(domain).output.resolution).toBe("720p");
    }
  });
  it("freezes a copy of the render snapshot so later UI edits cannot affect it", () => {
    const source: PcmAudioSnapshot = { duration: 1, sampleRate: 48_000, numberOfChannels: 1, channels: [new Float32Array([0, 1])] }; const snapshot = freezeSnapshot({ type: "start", jobId: "x", snapshot: { config, audio: source, duration: 1 } });
    expect(Object.isFrozen(snapshot)).toBe(true); expect(snapshot.snapshot.audio).not.toBe(source); expect(snapshot.snapshot.audio.channels[0]).not.toBe(source.channels[0]); expect(snapshot.snapshot.config).not.toBe(config);
  });
  it("can freeze the worker request without a second PCM allocation", () => {
    const source: PcmAudioSnapshot = { duration: 1, sampleRate: 48_000, numberOfChannels: 1, channels: [new Float32Array([0, 1])] };
    const snapshot = freezeSnapshot({ type: "start", jobId: "x", snapshot: { config, audio: source, duration: 1 } }, { copyAudio: false });
    expect(snapshot.snapshot.audio).toBe(source);
    releasePcmAudioSnapshot(source);
    expect(source.channels).toHaveLength(0);
  });
});

describe("MP4 mux boundary", () => {
  it("does not expose a partial output when no muxer is configured", () => {
    const adapter = new Mp4MuxerAdapter();
    expect(() => adapter.mux({ video: [], audio: [], metadata: { width: 320, height: 180, frameRate: 30, duration: 1, hasAudio: true, hasVideo: true } })).toThrow(/muxer/);
  });
  it("uses the capability-selected codec pair in the muxer track metadata", () => {
    let options: any;
    class FakeMuxer {
      constructor(value: any) { options = value; }
      addVideoChunkRaw() {}
      addAudioChunkRaw() {}
      finalize() {}
    }
    const policy = codecPolicy(config.output, "vp9-opus", "no-preference");
    const muxer = createMp4MuxerFactory(policy, FakeMuxer as any)({ width: 1280, height: 720, frameRate: 30, duration: 1, hasAudio: true, hasVideo: true });
    muxer.addVideoChunk({ type: "key", timestamp: 0, data: new Uint8Array([1]) }); muxer.addAudioChunk({ type: "key", timestamp: 0, data: new Uint8Array([1]) }); muxer.finalize();
    expect(options.video.codec).toBe("vp9"); expect(options.audio.codec).toBe("opus"); expect(options.fastStart).toBe(false);
  });
  it("accepts chunks incrementally before finalizing one output Blob", () => {
    const received: string[] = [];
    const adapter = new Mp4MuxerAdapter(() => ({
      addVideoChunk: () => received.push("video"),
      addAudioChunk: () => received.push("audio"),
      finalize: () => new Uint8Array([1, 2, 3]),
    }));
    adapter.begin({ width: 320, height: 180, frameRate: 30, duration: 1, hasAudio: true, hasVideo: true });
    adapter.addVideoChunk({ type: "key", timestamp: 0, data: new Uint8Array([1]) });
    adapter.addAudioChunk({ type: "key", timestamp: 0, data: new Uint8Array([2]) });
    expect(received).toEqual(["video", "audio"]);
    expect(adapter.finalize()).toBeInstanceOf(Blob);
    adapter.close();
  });
});

describe("bounded audio analysis", () => {
  it("returns bounded waveform, bands, and beats", () => {
    const values = new Float32Array(1000); for (let i = 0; i < values.length; i++) values[i] = Math.sin(i / 4) * (i % 100 === 0 ? 1 : .2);
    const fakeBuffer = { length: values.length, numberOfChannels: 1, sampleRate: 1000, duration: 1, getChannelData: () => values } as unknown as AudioBuffer;
    const analysis = analyzeAudioBuffer(fakeBuffer, { maxPoints: 64, maxBands: 16, maxBeats: 4 });
    expect(analysis.waveform.length).toBeLessThanOrEqual(64); expect(analysis.spectrum.length).toBe(16); expect(analysis.beats.length).toBeLessThanOrEqual(4);
    expect(Array.from(analysis.waveform).every((value) => value >= 0 && value <= 1)).toBe(true);
  });
  it("analyzes transferred planar PCM without AudioContext", () => {
    const snapshot: PcmAudioSnapshot = { duration: 1, sampleRate: 1_000, numberOfChannels: 1, channels: [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 5))] };
    const analysis = analyzePcmAudioSnapshot(snapshot, { maxPoints: 32, maxBands: 8 });
    expect(analysis.duration).toBe(1); expect(analysis.waveform.length).toBeLessThanOrEqual(32); expect(analysis.spectrum.length).toBe(8);
  });
  it("keeps amplitude and frequency bands time-aligned instead of cycling one spectrum", () => {
    const sampleRate = 4_800;
    const values = new Float32Array(sampleRate * 2);
    for (let i = 0; i < values.length; i++) {
      const frequency = i < sampleRate ? 80 : 1_000;
      values[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * .8;
    }
    const analysis = analyzePcmAudioSnapshot({ duration: 2, sampleRate, numberOfChannels: 1, channels: [values] }, { temporalRate: 10, maxBands: 12 });
    expect(analysis.temporal).toBeDefined();
    expect(analysis.temporal!.frameCount).toBe(20);
    const early = analysisAt(analysis, .65);
    const late = analysisAt(analysis, 1.65);
    expect(early.low).toBeGreaterThan(early.high);
    expect(late.mid).toBeGreaterThan(late.low);
    expect(early.spectrumBands).not.toBe(late.spectrumBands);
    expect(Array.from(early.spectrumBands)).not.toEqual(Array.from(late.spectrumBands));
  });
  it("bounds temporal buffers and clamps analysisAt outside the source duration", () => {
    const analysis = analyzePcmAudioSnapshot({
      duration: 600,
      sampleRate: 48_000,
      numberOfChannels: 1,
      channels: [new Float32Array(48_000 * 600)],
    }, { temporalRate: 60, maxTemporalFrames: 120, maxBands: 128 });
    const temporal = analysis.temporal!;
    expect(temporal.frameCount).toBe(120);
    expect(temporal.amplitude).toHaveLength(120);
    expect(temporal.spectrumBands).toBeLessThanOrEqual(64);
    expect(temporal.spectrum).toHaveLength(temporal.frameCount * temporal.spectrumBands);
    expect(analysisAt(analysis, -100).amplitude).toBe(temporal.amplitude[0]);
    expect(analysisAt(analysis, 1000).amplitude).toBe(temporal.amplitude[temporal.frameCount - 1]);
  });
  it("copies only planar PCM and exposes transferables", () => {
    const left = Float32Array.from([0, .25, .5]); const right = Float32Array.from([0, -.25, -.5]);
    const fakeBuffer = { length: 3, numberOfChannels: 2, sampleRate: 48_000, duration: 3 / 48_000, getChannelData: (channel: number) => channel ? right : left } as unknown as AudioBuffer;
    const snapshot = pcmSnapshotFromAudioBuffer(fakeBuffer);
    expect(snapshot.channels).toHaveLength(2); expect(snapshot.channels[0]).not.toBe(left); expect(pcmSnapshotTransferables(snapshot)).toEqual([snapshot.channels[0].buffer, snapshot.channels[1].buffer]);
  });
});

describe("capability matrix", () => {
  it("blocks an unavailable path and offers lower presets", async () => {
    const result = await detectCapabilities({ ...config.output, resolution: "4k" }, { canvas: true, videoEncoder: undefined, audioEncoder: undefined, muxer: false });
    expect(result.supported).toBe(false); expect(result.reasons.length).toBeGreaterThan(0); expect(result.suggestions.map((item) => item.resolution)).toEqual(["1080p", "720p"]);
  });
  it("falls back to VP9/Opus and keeps the software acceleration choice", async () => {
    class VideoEncoderProbe {
      static async isConfigSupported(config: { codec: string; hardwareAcceleration: string }) {
        return { supported: config.codec.startsWith("vp09") && config.hardwareAcceleration !== "prefer-hardware" };
      }
    }
    class AudioEncoderProbe {
      static async isConfigSupported(config: { codec: string }) { return { supported: config.codec === "opus" }; }
    }
    const result = await detectCapabilities(config.output, { canvas: true, videoEncoder: VideoEncoderProbe as any, audioEncoder: AudioEncoderProbe as any, muxer: true });
    expect(result.supported).toBe(true); expect(result.codecPath).toBe("vp9-opus"); expect(result.policy?.video.codec).toBe("vp09.00.10.08"); expect(result.policy?.audio.codec).toBe("opus"); expect(result.policy?.hardwareAcceleration).toBe("no-preference");
    expect(codecPolicy(config.output, result.policy!.path, result.policy!.hardwareAcceleration).video.codec).toBe(result.policy?.video.codec);
  });
  it("keeps AVC video when only AAC needs the Opus fallback", async () => {
    class VideoEncoderProbe {
      static async isConfigSupported(value: { codec: string; hardwareAcceleration: string }) { return { supported: value.codec.startsWith("avc1") && value.hardwareAcceleration === "no-preference" }; }
    }
    class AudioEncoderProbe {
      static async isConfigSupported(value: { codec: string }) { return { supported: value.codec === "opus" }; }
    }
    const result = await detectCapabilities(config.output, { canvas: true, videoEncoder: VideoEncoderProbe as any, audioEncoder: AudioEncoderProbe as any, muxer: true });
    expect(result.codecPath).toBe("h264-opus"); expect(result.policy?.video.containerCodec).toBe("avc"); expect(result.policy?.audio.containerCodec).toBe("opus"); expect(result.policy?.video.hardwareAcceleration).toBe("no-preference");
  });
});

describe("templates and worker states", () => {
  it("registers all supported template ids with deterministic scene calls", () => {
    const analysis = { duration: 1, sampleRate: 48_000, waveform: new Float32Array([0, .5, 1]), spectrum: new Float32Array([.2, .8]), beats: new Float32Array([.5]) };
    const gradient = { addColorStop() {} };
    const calls: string[] = [];
    const context = { createLinearGradient: () => gradient, createRadialGradient: () => gradient, fillRect: () => calls.push("fillRect"), beginPath: () => calls.push("beginPath"), arc: () => calls.push("arc"), fill: () => calls.push("fill"), stroke: () => calls.push("stroke"), moveTo: () => {}, lineTo: () => {}, quadraticCurveTo: () => {}, bezierCurveTo: () => {}, closePath: () => {}, save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, measureText: (text: string) => ({ width: text.length * 6 }), fillText: () => calls.push("fillText"), set fillStyle(_: unknown) {}, set strokeStyle(_: unknown) {}, set lineWidth(_: unknown) {}, set font(_: unknown) {}, set textAlign(_: unknown) {} } as any;
    for (const id of TEMPLATE_IDS) { calls.length = 0; createScene(id, config.template).render(context, { time: .5, frame: 15, progress: .5, width: 320, height: 180, analysis }); expect(calls.length).toBeGreaterThan(0); }
  });
  it("transitions worker events and keeps terminal states immutable", () => {
    expect(transitionState("queued", "start")).toBe("rendering"); expect(transitionState("rendering", "complete")).toBe("completed"); expect(transitionState("rendering", "cancel")).toBe("cancelled"); expect(transitionState("rendering", "error")).toBe("failed");
    expect(transitionState("completed", "error")).toBe("completed");
    expect(transitionState("cancelled", "complete")).toBe("cancelled");
    expect(transitionState("failed", "progress")).toBe("failed");
  });
});
