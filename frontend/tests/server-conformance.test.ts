import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTPUT_PRESETS } from "../src/config";
import { activeLyric } from "../src/domain/subtitles";
import { CURRENT_TEMPLATE_IDS, defaultSettings } from "../src/domain/template-settings";
import type { AspectRatio, LyricCue, TemplateId } from "../src/domain/models";
import { computeImagePlacement } from "../src/render/image-placement";

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../fixtures/render-conformance/domain.json"), "utf8"),
) as any;

describe("server renderer conformance contract", () => {
  it("uses the same template identifiers, defaults, and output dimensions", () => {
    expect([...CURRENT_TEMPLATE_IDS]).toEqual(fixture.templateIds);
    for (const output of fixture.outputs) {
      const preset = OUTPUT_PRESETS[output.aspectRatio as AspectRatio].find(
        (candidate) => candidate.width === output.width && candidate.height === output.height,
      );
      expect(preset).toBeDefined();
    }
    for (const [templateId, expected] of Object.entries(fixture.defaults) as Array<[
      TemplateId,
      { theme: string; accent: string; lineCount: number },
    ]>) {
      const settings = defaultSettings(templateId);
      expect({ theme: settings.theme, accent: settings.accent, lineCount: settings.lineCount }).toEqual(expected);
    }
  });

  it("uses the same start-only lyric selection", () => {
    const cues = fixture.lyrics.cues as LyricCue[];
    for (const query of fixture.lyrics.queries) {
      expect(activeLyric(cues, query.time)).toBe(query.active);
    }
  });

  it("uses the same centered cover crop", () => {
    const value = fixture.placement;
    const placement = computeImagePlacement(
      value.source.width,
      value.source.height,
      value.destination.width,
      value.destination.height,
      { zoom: value.zoom, panX: value.panX, panY: value.panY },
    );
    const actual = [
      placement.sourceX,
      placement.sourceY,
      placement.sourceWidth,
      placement.sourceHeight,
    ];
    const expected = [
      value.expectedSource[0],
      value.expectedSource[1],
      value.expectedSource[2] - value.expectedSource[0],
      value.expectedSource[3] - value.expectedSource[1],
    ];
    actual.forEach((coordinate, index) => {
      expect(coordinate).toBeCloseTo(expected[index], 10);
    });
  });
});
