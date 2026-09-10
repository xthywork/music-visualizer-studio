import { describe, expect, it } from "vitest";
import { createScene } from "../src/render/scenes";
import { dimensionsFor, type AspectRatio, type AudioAnalysis, type TemplateId } from "../src/render/types";

/** A small recording context keeps golden tests independent of GPU/browser Canvas. */
function recordingContext() {
  const calls: unknown[][] = []; let gradientId = 0;
  const normalize = (value: unknown): unknown => {
    if (value && typeof value === "object") {
      const candidate = value as { __gradient?: number };
      if (candidate.__gradient) return `gradient:${candidate.__gradient}`;
      if (Array.isArray(value)) return value.map(normalize);
    }
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  };
  const target: Record<string, unknown> = {
    createLinearGradient: (...args: unknown[]) => { const id = ++gradientId; calls.push(["linearGradient", ...args]); return { __gradient: id, addColorStop: (...stop: unknown[]) => calls.push(["colorStop", id, ...stop]) }; },
    createRadialGradient: (...args: unknown[]) => { const id = ++gradientId; calls.push(["radialGradient", ...args]); return { __gradient: id, addColorStop: (...stop: unknown[]) => calls.push(["colorStop", id, ...stop]) }; },
    measureText: (value: string) => ({ width: value.length * 6 }),
  };
  const context = new Proxy(target, {
    get(object, property: string) {
      if (property in object) return object[property];
      return (...args: unknown[]) => calls.push([property, ...args.map(normalize)]);
    },
    set(_object, property: string, value: unknown) { calls.push([`set:${property}`, normalize(value)]); return true; },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const analysis: AudioAnalysis = {
  duration: 2,
  sampleRate: 48_000,
  waveform: Float32Array.from({ length: 64 }, (_, index) => (Math.sin(index * .43) + 1) / 2),
  spectrum: Float32Array.from({ length: 32 }, (_, index) => (index % 7) / 6),
  beats: Float32Array.from([.5, 1.25]),
};

const ratios: AspectRatio[] = ["16:9", "9:16", "1:1"];
const templates: TemplateId[] = ["spectrum-cover", "vinyl-particle", "abstract-pulse"];

function renderSignature(template: TemplateId, aspectRatio: AspectRatio): string {
  // 180px long edge keeps this suite cheap while still exercising orientation changes.
  const dimensions = dimensionsFor({ aspectRatio, resolution: "720p", frameRate: 30 });
  const scale = 180 / Math.max(dimensions.width, dimensions.height);
  const width = Math.max(1, Math.round(dimensions.width * scale)); const height = Math.max(1, Math.round(dimensions.height * scale));
  const { context, calls } = recordingContext();
  createScene(template, { title: "Golden title", artist: "Golden artist" }).render(context, { time: .5, frame: 15, progress: .25, width, height, analysis });
  // A stable FNV-1a signature makes accidental visual-operation changes obvious without storing bitmaps.
  const source = JSON.stringify(calls); let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index++) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `${width}x${height}:${(hash >>> 0).toString(16)}`;
}

describe("low-resolution visualizer golden frames", () => {
  const golden: Record<string, string> = {
    "spectrum-cover/16:9": "180x101:c2f4cd99",
    "spectrum-cover/9:16": "101x180:2623f828",
    "spectrum-cover/1:1": "180x180:676aaf37",
    "vinyl-particle/16:9": "180x101:97c42e55",
    "vinyl-particle/9:16": "101x180:fd8e4375",
    "vinyl-particle/1:1": "180x180:f04a7d2e",
    "abstract-pulse/16:9": "180x101:31cd0a52",
    "abstract-pulse/9:16": "101x180:bbc872db",
    "abstract-pulse/1:1": "180x180:94a26a7",
  };

  for (const template of templates) {
    for (const aspectRatio of ratios) {
      it(`${template} renders a deterministic ${aspectRatio} representative frame`, () => {
        const key = `${template}/${aspectRatio}`; const first = renderSignature(template, aspectRatio); const second = renderSignature(template, aspectRatio);
        expect(second).toBe(first); expect(first).toBe(golden[key]);
      });
    }
  }
});
