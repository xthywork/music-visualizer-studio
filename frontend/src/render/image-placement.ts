import type { TemplateSettings } from "../domain/models";
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface ImagePlacementOptions { zoom: number; panX: number; panY: number; }
export interface ImagePlacement { sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number; }
/** Pure crop calculation shared with server-renderer conformance fixtures. */
export function computeImagePlacement(iw: number, ih: number, w: number, h: number, options: ImagePlacementOptions): ImagePlacement {
  if (![iw, ih, w, h].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid image dimensions");
  const scale = Math.max(w / iw, h / ih) * options.zoom * 1.04;
  const sourceWidth = w / scale; const sourceHeight = h / scale;
  const bound = (v: number) => Math.max(0, Math.min(1, v));
  return {
    sourceX: (iw - sourceWidth) * bound(.5 - options.panX / 200),
    sourceY: (ih - sourceHeight) * bound(.5 - options.panY / 200),
    sourceWidth,
    sourceHeight,
  };
}
/** Pan over the available crop, never outside the source image. */
export function placedBackground(ctx: Context, image: CanvasImageSource, x: number, y: number, w: number, h: number, settings: TemplateSettings, time: number) {
  const source = image as { width: number; height: number; naturalWidth?: number; naturalHeight?: number };
  const iw = source.naturalWidth || source.width; const ih = source.naturalHeight || source.height;
  if (!iw || !ih) return;
  const dx = .025 * Math.sin(time * .13 * settings.motion) * Math.min(1, settings.motion);
  const dy = .02 * Math.sin(time * .10 * settings.motion) * Math.min(1, settings.motion);
  const placement = computeImagePlacement(iw, ih, w, h, { zoom: settings.imageZoom, panX: settings.imageX - dx * 200, panY: settings.imageY - dy * 200 });
  ctx.drawImage(image, placement.sourceX, placement.sourceY, placement.sourceWidth, placement.sourceHeight, x, y, w, h);
}
