import { describe, expect, it } from "vitest";
import {
  OUTPUT_PRESETS,
  TEMPLATES,
  validateAudioDuration,
  validateAudioFile,
} from "../src/config";

describe("audio validation", () => {
  it("accepts the three supported extensions", () => {
    expect(validateAudioFile({ name: "track.mp3", type: "audio/mpeg", size: 4 })).toBeNull();
    expect(validateAudioFile({ name: "track.wav", type: "audio/wav", size: 4 })).toBeNull();
    expect(validateAudioFile({ name: "track.m4a", type: "audio/mp4", size: 4 })).toBeNull();
  });

  it("rejects unsupported, empty, and over-limit audio", () => {
    expect(validateAudioFile({ name: "track.flac", type: "audio/flac", size: 4 })).toMatch(/MP3/);
    expect(validateAudioFile({ name: "track.mp3", type: "audio/mpeg", size: 0 })).toMatch(/空/);
    expect(validateAudioDuration(601)).toMatch(/10 分鐘/);
  });
});

describe("configuration catalog", () => {
  it("contains the two supported templates", () => {
    expect(TEMPLATES.map((item) => item.id)).toEqual([
      "spectrum-cover",
      "vinyl-particle",
    ]);
  });

  it("contains 4K presets for every supported ratio", () => {
    expect(Object.keys(OUTPUT_PRESETS)).toEqual(["16:9", "9:16", "1:1"]);
    for (const presets of Object.values(OUTPUT_PRESETS)) {
      expect(presets.some((preset) => preset.label.includes("4K"))).toBe(true);
    }
  });
});
