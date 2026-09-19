import { expect, it } from "vitest";
import { defaultSettings } from "../src/domain/template-settings";
import { placedBackground } from "../src/render/image-placement";

it("keeps zoomed and panned crops inside the image at every extreme", () => {
  for (const [iw, ih] of [[1600, 900], [400, 1200]]) {
    for (const imageX of [-100, 0, 100]) for (const imageY of [-100, 0, 100]) for (const imageZoom of [1, 3]) {
      const ctx = { drawImage(_image: unknown, sx: number, sy: number, sw: number, sh: number, x: number, y: number, w: number, h: number) {
        expect(sx).toBeGreaterThanOrEqual(0); expect(sy).toBeGreaterThanOrEqual(0);
        expect(sx + sw).toBeLessThanOrEqual(iw + 1e-8); expect(sy + sh).toBeLessThanOrEqual(ih + 1e-8);
        expect(sw / sh).toBeCloseTo(w / h); expect([x, y, w, h]).toEqual([500, 0, 220, 1280]);
      } };
      placedBackground(ctx as unknown as CanvasRenderingContext2D, { width: iw, height: ih } as CanvasImageSource, 500, 0, 220, 1280, { ...defaultSettings("poetry-lyrics"), motion: 5, imageX, imageY, imageZoom }, 10);
    }
  }
});
