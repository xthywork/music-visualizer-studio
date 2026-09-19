// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("static editor preview", () => {
  it("does not start a browser frame-generation loop", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain("requestAnimationFrame(");
    expect(source).not.toContain("cancelAnimationFrame(");
    expect(source).toContain("const STATIC_PREVIEW_TIME_SECONDS");
  });
});
