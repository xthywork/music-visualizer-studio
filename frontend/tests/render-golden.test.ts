import { describe, expect, it } from "vitest";
import { createScene, TEMPLATE_IDS } from "../src/render/scenes";
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
const templates = TEMPLATE_IDS;

function renderSignature(template: TemplateId, aspectRatio: AspectRatio, time = .5): string {
  // 180px long edge keeps this suite cheap while still exercising orientation changes.
  const dimensions = dimensionsFor({ aspectRatio, resolution: "720p", frameRate: 30 });
  const scale = 180 / Math.max(dimensions.width, dimensions.height);
  const width = Math.max(1, Math.round(dimensions.width * scale)); const height = Math.max(1, Math.round(dimensions.height * scale));
  const { context, calls } = recordingContext();
  createScene(template, { title: "Golden title", artist: "Golden artist", lyrics: [{ start: 0, text: "First line" }, { start: .5, text: "Current line" }, { start: 1, text: "Next line" }] }).render(context, { time, frame: Math.round(time * 30), progress: .25, width, height, analysis });
  // A stable FNV-1a signature makes accidental visual-operation changes obvious without storing bitmaps.
  const source = JSON.stringify(calls); let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index++) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `${width}x${height}:${(hash >>> 0).toString(16)}`;
}

describe("low-resolution visualizer golden frames", () => {

  for (const template of templates) {
    for (const aspectRatio of ratios) {
      it(`${template} renders a deterministic ${aspectRatio} representative frame`, () => {
        const first = renderSignature(template, aspectRatio); const second = renderSignature(template, aspectRatio);
        expect(second).toBe(first);
      });
    }
  }
});

describe("visual motion and cover treatment", () => {
  it.each(["night-orbit", "dawn-spectrum"] as const)("%s settles in silence, responds to sound, and preserves full cover aspect ratio", id => {
    const cover = { width: 300, height: 600 } as CanvasImageSource;
    const draw = (level: number, time: number) => {
      const { context, calls } = recordingContext();
      createScene(id, { assets: { coverImage: cover } }).render(context, { width: 1280, height: 720, time, frame: 0, progress: .5, analysis: { ...analysis, spectrum: new Float32Array(32).fill(level), waveform: new Float32Array(64).fill(level), beats: new Float32Array() } });
      const image = calls.find(([name]) => name === "drawImage")!;
      expect(Number(image[4]) / Number(image[5])).toBeCloseTo(.5);
      return calls.filter(([name]) => name === "lineTo" || name === "moveTo");
    };
    expect(draw(0, 0)).toEqual(draw(0, 1));
    expect(draw(.8, 0)).not.toEqual(draw(0, 0));
    expect(draw(.8, 0)).not.toEqual(draw(.8, 1));
  });
  it("keeps poetry covers complete and still, with no rotating geometry in any ratio", () => {
    for (const aspectRatio of ratios) {
      const dimensions = dimensionsFor({ aspectRatio, resolution: "720p", frameRate: 30 });
      const cover = { width: 450, height: 900 } as CanvasImageSource;
      const background = { width: 1600, height: 900 } as CanvasImageSource;
      const draw = (time: number) => {
        const { context, calls } = recordingContext();
        createScene("poetry-lyrics", { assets: { coverImage: cover, backgroundImage: background }, lyrics: [{ start: 0, text: "A quiet page" }] }).render(context, { ...dimensions, time, frame: time * 30, progress: .5, analysis });
        expect(calls.some(([name]) => name === "rotate")).toBe(false);
        expect(calls.some(([name, value]) => name === "set:font" && String(value).includes("serif"))).toBe(true);
        return calls.filter(([name]) => name === "drawImage");
      };
      const first = draw(0); const later = draw(10);
      expect(first).toHaveLength(2);
      expect(first[1]).toEqual(later[1]);
      expect(Number(first[1][4]) / Number(first[1][5])).toBeCloseTo(.5);
      expect(first[0]).not.toEqual(later[0]);
    }
  });
  it("keeps paper sleeves complete and fixed while photographic crops move in all ratios", () => {
    for (const aspectRatio of ratios) {
      const dimensions = dimensionsFor({ aspectRatio, resolution: "4k", frameRate: 60 });
      const cover = { width: 450, height: 900 } as CanvasImageSource;
      const background = { width: 1600, height: 900 } as CanvasImageSource;
      const draw = (time: number) => {
        const { context, calls } = recordingContext();
        createScene("paper-resonance", { assets: { coverImage: cover, backgroundImage: background } }).render(context, {
          ...dimensions, time, frame: time * 60, progress: .5, analysis,
        });
        return calls.filter(([name]) => name === "drawImage");
      };
      const first = draw(0); const later = draw(10);
      expect(first).toHaveLength(2);
      expect(first[1]).toEqual(later[1]);
      expect(Number(first[1][4]) / Number(first[1][5])).toBeCloseTo(.5);
      expect(first[0]).not.toEqual(later[0]);
      for (const image of [first[0], later[0]]) {
        expect(Number(image[2])).toBeGreaterThanOrEqual(0);
        expect(Number(image[3])).toBeGreaterThanOrEqual(0);
        expect(Number(image[2]) + Number(image[4])).toBeLessThanOrEqual(1600);
        expect(Number(image[3]) + Number(image[5])).toBeLessThanOrEqual(900);
      }
    }
  });

  it("settles paper ink contours in silence and keeps loud frames deterministic and below text", () => {
    for (const aspectRatio of ratios) {
      const dimensions = dimensionsFor({ aspectRatio, resolution: "720p", frameRate: 60 });
      const draw = (level: number, time = .6) => {
        const { context, calls } = recordingContext();
        const scene = createScene("paper-resonance", { title: "很長的中文曲名與遠方城市裡那些仍然值得記住的美好聲音", artist: "Paper Artist" });
        scene.render(context, { ...dimensions, time, frame: Math.round(time * 60), progress: .5,
          analysis: { ...analysis, spectrum: new Float32Array(64).fill(level), waveform: new Float32Array(64).fill(level) },
        });
        const start = calls.findIndex(([name, value]) => name === "set:strokeStyle" && value === "#b84330");
        const end = calls.findIndex(([name], index) => index > start && name === "stroke");
        const curve = calls.slice(start, end).filter(([name]) => name === "lineTo" || name === "moveTo");
        const ys = curve.map((call) => Number(call[2]));
        const artist = calls.find(([name, value]) => name === "fillText" && value === "Paper Artist")!;
        expect(Math.min(...ys)).toBeGreaterThan(Number(artist[3]) + Math.min(dimensions.width, dimensions.height) * .025);
        expect(Math.max(...ys)).toBeLessThan(dimensions.height * .925);
        return curve;
      };
      const silent = draw(0).map((call) => Number(call[2]));
      expect(Math.max(...silent) - Math.min(...silent)).toBe(0);
      expect(draw(1)).toEqual(draw(1));
      expect(draw(1)).not.toEqual(draw(0));
      expect(draw(1, 1.2)).not.toEqual(draw(1));
    }
  });
  it("keeps the complete editorial sleeve stationary and undistorted while its background moves", () => {
    for (const ratio of ratios) {
      const dimensions = dimensionsFor({ aspectRatio: ratio, resolution: "4k", frameRate: 60 });
      const cover = { width: 800, height: 400 } as CanvasImageSource;
      const backdrop = { width: 600, height: 900 } as CanvasImageSource;
      const draw = (time: number) => {
        const { context, calls } = recordingContext();
        createScene("quiet-editorial", { assets: { coverImage: cover, backgroundImage: backdrop } }).render(context, {
          ...dimensions, time, frame: time * 60, progress: .25, analysis,
        });
        return calls.filter(([name]) => name === "drawImage");
      };
      const first = draw(.5); const later = draw(1.5);
      expect(first).toHaveLength(2);
      expect(first[1]).toEqual(later[1]);
      expect(Number(first[1][4]) / Number(first[1][5])).toBeCloseTo(2);
      expect(first[0]).not.toEqual(later[0]);
    }
  });

  it("settles editorial frequency strokes to a baseline in silence and responds to audio energy", () => {
    const heights = (energy: number) => {
      const { context, calls } = recordingContext();
      const silent: AudioAnalysis = { ...analysis, waveform: new Float32Array(64).fill(energy), spectrum: new Float32Array(32).fill(energy), beats: new Float32Array() };
      createScene("quiet-editorial").render(context, { time: 1, frame: 30, progress: .5, width: 1280, height: 720, analysis: silent });
      return calls.filter(([name, , , width]) => name === "fillRect" && Number(width) < 2).map((call) => Number(call[4]));
    };
    expect(heights(0)).toHaveLength(64);
    expect(Math.max(...heights(0))).toBeLessThan(2);
    expect(Math.min(...heights(.8))).toBeGreaterThan(20);
  });
  it("adds 50% reactive height on accents, releases smoothly, and clears long titles in every ratio", () => {
    for (const ratio of ratios) {
      const dimensions = dimensionsFor({ aspectRatio: ratio, resolution: "720p", frameRate: 60 });
      const short = Math.min(dimensions.width, dimensions.height);
      const draw = (time: number, beats: Float32Array) => {
        const { context, calls } = recordingContext();
        const steady: AudioAnalysis = { ...analysis, spectrum: new Float32Array(64).fill(1), beats };
        createScene("quiet-editorial", { title: "A long composition title with enough words to wrap across two lines", artist: "Artist credit" }).render(context, {
          ...dimensions, time, frame: Math.round(time * 60), progress: .5, analysis: steady,
        });
        const bars = calls.filter(([name, , , width]) => name === "fillRect" && Number(width) < 2);
        const artist = calls.find(([name, value]) => name === "fillText" && value === "Artist credit")!;
        expect(Math.min(...bars.map((call) => Number(call[2])))).toBeGreaterThanOrEqual(Number(artist[3]) + short * .014 - .001);
        return Number(bars[0][4]) - short * .002;
      };
      const baseline = draw(.555, new Float32Array());
      const peak = draw(.555, new Float32Array([.5]));
      expect(peak / baseline).toBeCloseTo(1.5, 5);
      expect(draw(.54, new Float32Array([.5]))).toBeLessThan(peak);
      expect(draw(.7, new Float32Array([.5]))).toBeLessThan(peak);
      expect(draw(.91, new Float32Array([.5]))).toBeCloseTo(baseline, 5);
    }
  });

  it("keeps every supported template visibly time-responsive", () => {
    for (const template of templates) expect(renderSignature(template, "1:1", .5)).not.toBe(renderSignature(template, "1:1", .83));
  });


});
