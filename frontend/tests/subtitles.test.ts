import { describe, expect, it } from "vitest";
import { activeLyric, lyricScroll, parseSrt, validateLyrics } from "../src/domain/subtitles";
import { defaultSettings, validateSettings, PALETTES, lineColors } from "../src/domain/template-settings";
import { deserializeConfiguration, serializeConfiguration, type RenderConfiguration } from "../src/domain";
import { renderConfigFromDomain, renderConfigToDomain } from "../src/render/domain-adapter";
import { drawLyrics } from "../src/render/lyric-scenes";
import { createSceneAsync } from "../src/render/scenes";

it("rejects subtitle-free or invalid lyric exports at the worker scene boundary", async () => {
  await expect(createSceneAsync("panorama-lyrics")).rejects.toThrow("SRT");
  await expect(createSceneAsync("poetry-lyrics", { lyrics: [{ start: -1, text: "bad" }] })).rejects.toThrow();
});

it.each(["night-orbit", "dawn-spectrum"] as const)("exports %s without subtitles and persists its settings", async id => {
  const scene = await createSceneAsync(id);
  expect(scene.id).toBe(id); scene.dispose?.();
  const settings = { ...defaultSettings(id), coverX: 5, motion: 3 };
  const config: RenderConfiguration = { schemaVersion: 1, templateId: id, text: { title: "New scene", artist: "Artist" }, templateSettings: { [id]: settings }, output: { aspectRatio: "16:9", width: 1280, height: 720, frameRate: 30 } };
  expect(deserializeConfiguration(serializeConfiguration(config))).toEqual(config);
});

it("defaults legacy settings and validates placement, palettes, counts and expanded motion", () => {
  expect(validateSettings({ motion: 2 }, "poetry-lyrics")).toMatchObject({ coverX: 0, coverY: 0, imageWidth: 24, imageZoom: 1, lineCount: 1, palette: "custom" });
  const settings = { ...defaultSettings("poetry-lyrics"), motion: 5, imageWidth: 60, imageZoom: 3, imageX: -100, imageY: 100, coverX: -20, coverY: 15, lineCount: 8, palette: "coast" };
  expect(validateSettings(settings, "poetry-lyrics")).toEqual(settings);
  expect(lineColors(settings)).toEqual(PALETTES.coast.colors);
  for (const patch of [{ motion: 5.1 }, { lineCount: 2.5 }, { lineCount: 9 }, { imageWidth: 61 }, { imageZoom: .9 }, { coverX: 51 }, { palette: "unknown" }]) expect(() => validateSettings({ ...settings, ...patch }, "poetry-lyrics")).toThrow();
});

it("centers the active lyric and continuously fades surrounding lines as they move upward", () => {
  const cues = Array.from({ length: 7 }, (_, i) => ({ start: i, text: `Line ${i}` }));
  const draw = (time: number) => {
    const calls: { text: string; y: number; alpha: number }[] = [];
    const ctx = { globalAlpha: 1, font: "", save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, measureText(text: string) { return { width: text.length * 12 }; }, fillText(text: string, _x: number, y: number) { calls.push({ text, y, alpha: this.globalAlpha }); } };
    drawLyrics(ctx as unknown as CanvasRenderingContext2D, cues, time, { x: 0, y: 0, w: 800, h: 600 }, 40, defaultSettings("panorama-lyrics"), "#fff");
    return calls;
  };
  const settled = draw(3.6);
  const current = settled.find(line => line.text === "Line 3")!;
  expect(current.y).toBe(300); expect(current.alpha).toBe(1);
  expect(settled.find(line => line.text === "Line 2")!.alpha).toBeLessThan(1);
  expect(settled.find(line => line.text === "Line 1")!.alpha).toBeLessThan(settled.find(line => line.text === "Line 2")!.alpha);
  const before = draw(2.999).find(line => line.text === "Line 2")!;
  const boundary = draw(3).find(line => line.text === "Line 2")!;
  expect(boundary.y).toBeCloseTo(before.y); expect(boundary.alpha).toBeCloseTo(before.alpha);
  const moving = draw(3.1).find(line => line.text === "Line 2")!;
  expect(moving.y).toBeLessThan(boundary.y); expect(moving.alpha).toBeLessThan(boundary.alpha);
});

describe("SRT timing and validation", () => {
  const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:01,100\r\n第一句\r\n\r\n2\r\n00:00:03,000 --> 00:00:09,000\r\n第二句\r\n下一行\r\n";
  it("keeps multiline UTF-8 lyrics and uses starts only, through gaps and the last cue", () => {
    const cues = parseSrt(srt);
    expect(cues).toEqual([{ start: 1, text: "第一句" }, { start: 3, text: "第二句\n下一行" }]);
    expect(activeLyric(cues, .999)).toBe(-1);
    expect(activeLyric(cues, 1)).toBe(0);
    expect(activeLyric(cues, 2.9)).toBe(0);
    expect(activeLyric(cues, 30)).toBe(1);
    expect(parseSrt(srt.replace("00:00:09,000", "00:00:00,000"))).toEqual(cues);
  });
  it("sorts out-of-order cues and merges simultaneous starts", () => {
    expect(parseSrt("00:00:02.000 --> 00:00:03.000\n後\n\n00:00:01,000 --> 00:00:00,000\n<i>前</i>\n\n3\n00:00:01,000 --> 00:00:04,000\n同時"))
      .toEqual([{ start: 1, text: "前\n同時" }, { start: 2, text: "後" }]);
  });
  it("rejects invalid, empty, oversized and excessive subtitle data", () => {
    for (const bad of ["", "hello", "1\n00:61:00,000 --> 00:00:02,000\n文字", "00:00:01,000 --> 00:00:02,000\n"]) expect(() => parseSrt(bad)).toThrow();
    expect(() => parseSrt("x".repeat(1024 * 1024 + 1))).toThrow();
    expect(() => validateLyrics(Array(5001).fill({ start: 1, text: "x" }))).toThrow();
    expect(() => validateLyrics([{ start: 1, text: "a" }, { start: 1, text: "b" }])).toThrow();
  });
  it("scrolls upward smoothly, completes dense transitions, and holds the final line", () => {
    const cues = [{ start: 0, text: "一" }, { start: .1, text: "二" }, { start: .15, text: "三" }];
    expect(lyricScroll(cues, -.1).index).toBe(-1);
    expect(lyricScroll(cues, .1).position).toBeCloseTo(0);
    expect(lyricScroll(cues, .11).position).toBeGreaterThan(0);
    expect(lyricScroll(cues, .14).position).toBeCloseTo(1);
    expect(lyricScroll(cues, 4)).toEqual({ index: 2, position: 2 });
  });
});

describe("template and subtitle persistence", () => {
  const config: RenderConfiguration = { schemaVersion: 1, templateId: "panorama-lyrics", text: { title: "字幕", artist: "藝人" }, lyrics: [{ start: .2, text: "保留字幕" }], templateSettings: { "panorama-lyrics": { ...defaultSettings("panorama-lyrics"), theme: "light", lyricSize: 1.2 }, "poetry-lyrics": { ...defaultSettings("poetry-lyrics"), motion: .5 } }, output: { aspectRatio: "16:9", width: 1280, height: 720, frameRate: 30 } };
  it("preserves settings per template and sends selected settings and cues to the worker", () => {
    expect(deserializeConfiguration(serializeConfiguration(config))).toEqual(config);
    const worker = renderConfigFromDomain(config);
    expect(worker.template.settings?.theme).toBe("light");
    expect(worker.template.lyrics).toEqual(config.lyrics);
    expect(renderConfigToDomain(worker).lyrics).toEqual(config.lyrics);
    expect(renderConfigToDomain(worker).templateSettings?.["panorama-lyrics"]).toEqual(config.templateSettings?.["panorama-lyrics"]);
  });
  it.each(["spectrum-cover", "vinyl-particle", "abstract-pulse"])("migrates %s without deleting images or text", templateId => {
    const result = deserializeConfiguration(JSON.stringify({ ...config, templateId, coverImage: { kind: "data-url", value: "data:image/png;base64,a" } }));
    expect(result.templateId).toBe("quiet-editorial");
    expect(result.text).toEqual(config.text); expect(result.coverImage?.value).toContain("base64,a");
  });
  it("rejects invalid settings and discards unknown fields", () => {
    expect(() => deserializeConfiguration(JSON.stringify({ ...config, templateSettings: { "panorama-lyrics": { motion: 99 } } }))).toThrow();
    expect(() => deserializeConfiguration(JSON.stringify({ ...config, lyrics: [{ start: -1, text: "x" }] }))).toThrow();
    expect(serializeConfiguration({ ...config, sourceAudio: "secret" } as RenderConfiguration)).not.toContain("secret");
  });
  it("migrates retired Geometry Lyrics and its settings without losing subtitle or image data", () => {
    const settings = { ...defaultSettings("poetry-lyrics"), theme: "dark", motion: .75 };
    const legacy = { ...config, templateId: "geometry-lyrics", templateSettings: { "geometry-lyrics": settings }, coverImage: { kind: "data-url", value: "data:image/png;base64,a" } };
    const result = deserializeConfiguration(JSON.stringify(legacy));
    expect(result.templateId).toBe("poetry-lyrics");
    expect(result.templateSettings?.["poetry-lyrics"]).toEqual(settings);
    expect(result.lyrics).toEqual(config.lyrics);
    expect(result.coverImage).toEqual(legacy.coverImage);
    expect(result.text).toEqual(config.text);
    const current = defaultSettings("poetry-lyrics");
    expect(deserializeConfiguration(JSON.stringify({ ...legacy, templateSettings: { ...legacy.templateSettings, "poetry-lyrics": current } })).templateSettings?.["poetry-lyrics"]).toEqual(current);
  });
});
