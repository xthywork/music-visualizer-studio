import { describe, expect, it } from "vitest";
import { createScene, VinylParticleScene } from "../src/render/scenes";
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
const templates: TemplateId[] = ["spectrum-cover", "vinyl-particle"];

function renderSignature(template: TemplateId, aspectRatio: AspectRatio, time = .5): string {
  // 180px long edge keeps this suite cheap while still exercising orientation changes.
  const dimensions = dimensionsFor({ aspectRatio, resolution: "720p", frameRate: 30 });
  const scale = 180 / Math.max(dimensions.width, dimensions.height);
  const width = Math.max(1, Math.round(dimensions.width * scale)); const height = Math.max(1, Math.round(dimensions.height * scale));
  const { context, calls } = recordingContext();
  createScene(template, { title: "Golden title", artist: "Golden artist" }).render(context, { time, frame: Math.round(time * 30), progress: .25, width, height, analysis });
  // A stable FNV-1a signature makes accidental visual-operation changes obvious without storing bitmaps.
  const source = JSON.stringify(calls); let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index++) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `${width}x${height}:${(hash >>> 0).toString(16)}`;
}

describe("low-resolution visualizer golden frames", () => {
  const golden: Record<string, string> = {
    "spectrum-cover/16:9": "180x101:8d4df7c0",
    "spectrum-cover/9:16": "101x180:eb96f543",
    "spectrum-cover/1:1": "180x180:c73af8cd",
    "vinyl-particle/16:9": "180x101:42a011ad",
    "vinyl-particle/9:16": "101x180:4ad49ae6",
    "vinyl-particle/1:1": "180x180:12efdea3",
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

describe("visual motion and cover treatment", () => {
  it("keeps every supported template visibly time-responsive", () => {
    for (const template of templates) expect(renderSignature(template, "1:1", .5)).not.toBe(renderSignature(template, "1:1", .83));
  });

  it("clips a supplied cover image into the vinyl label", () => {
    const { context, calls } = recordingContext();
    new VinylParticleScene({ coverImage: {} as ImageBitmap }).render(context, { time: .5, frame: 15, progress: .25, width: 180, height: 180, analysis });
    expect(calls.some(([name]) => name === "clip")).toBe(true);
    expect(calls.some(([name]) => name === "drawImage")).toBe(true);
    const imageIndex = calls.findIndex(([name]) => name === "drawImage");
    const lastRotate = calls.reduce((index, call, current) => call[0] === "rotate" ? current : index, -1);
    const lastTranslate = calls.reduce((index, call, current) => call[0] === "translate" ? current : index, -1);
    expect(lastTranslate).toBeGreaterThan(lastRotate);
    expect(imageIndex).toBeGreaterThan(lastTranslate);
    expect(calls.filter(([name]) => name === "arc").length).toBeGreaterThan(25);
  });

  it("keeps Spectrum Cover artwork geometry stable while the scene animates", () => {
    const image = {} as ImageBitmap;
    const geometryAt = (time: number) => {
      const { context, calls } = recordingContext();
      createScene("spectrum-cover", { assets: { coverImage: image } }).render(context, { time, frame: Math.round(time * 30), progress: .25, width: 180, height: 101, analysis });
      return calls.filter(([name]) => name === "drawImage").map((call) => call.slice(1));
    };
    expect(geometryAt(.1)).toEqual(geometryAt(.9));
  });
});
