import { describe, expect, it } from "vitest";
import { renderProgressMessage } from "../src/ui/render-progress";

describe("render progress messaging", () => {
  it("shows seconds for a short render estimate", () => {
    expect(renderProgressMessage(3, 30, 9_100)).toBe("正在渲染第 3/30 幀 · 約剩 10 秒");
  });

  it("makes long-running work explicit", () => {
    expect(renderProgressMessage(10, 3_600, 125_000)).toBe("長時間渲染中 · 正在渲染第 10/3600 幀 · 約剩 3 分鐘");
  });
});
