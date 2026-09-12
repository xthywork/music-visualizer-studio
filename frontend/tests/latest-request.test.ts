// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LatestRequestGate } from "../src/ui/latest-request";

describe("LatestRequestGate", () => {
  it("rejects an older capability result that completes after a newer request", () => {
    const gate = new LatestRequestGate();
    const older = gate.begin();
    const newer = gate.begin();
    expect(gate.isCurrent(older)).toBe(false);
    expect(gate.isCurrent(newer)).toBe(true);
  });
});
