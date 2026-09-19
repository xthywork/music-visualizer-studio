import type { TemplateSettings } from "../domain/models";
import { analysisAt } from "./audio-analysis";
import { placedBackground } from "./image-placement";
import type { SceneAssets } from "./scenes";
import type { Scene, SceneFrameContext } from "./types";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
function fit(ctx: Context, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  while (chars.length && ctx.measureText(chars.join("") + "…").width > width) chars.pop();
  return chars.join("") + "…";
}
function sleeve(ctx: Context, image: CanvasImageSource | undefined, x: number, y: number, size: number, ink: string, dark: boolean) {
  ctx.fillStyle = dark ? "#263c42" : "#e1d3bc"; ctx.fillRect(x, y, size, size);
  if (image) {
    const source = image as { width: number; height: number; naturalWidth?: number; naturalHeight?: number };
    const iw = source.naturalWidth || source.width; const ih = source.naturalHeight || source.height;
    if (iw && ih) { const scale = Math.min(size / iw, size / ih); ctx.drawImage(image, x + (size - iw * scale) / 2, y + (size - ih * scale) / 2, iw * scale, ih * scale); }
  } else {
    ctx.strokeStyle = ink; ctx.lineWidth = size * .005; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size * .28, 0, Math.PI * 2); ctx.stroke();
    ctx.font = `${size * .045}px Georgia, serif`; ctx.fillStyle = ink; ctx.textAlign = "center";
    ctx.fillText("S O U N D   /   S T I L L", x + size / 2, y + size * .87);
  }
}
const timestamp = (t: number) => `${Math.floor(Math.max(0, t) / 60).toString().padStart(2, "0")}:${Math.floor(Math.max(0, t) % 60).toString().padStart(2, "0")}`;

/** Two non-lyric compositions. Audio is smoothed with a deterministic finite window. */
export class InstrumentalScene implements Scene {
  constructor(readonly id: "night-orbit" | "dawn-spectrum", private readonly title = "", private readonly artist = "", private readonly assets: SceneAssets, private readonly settings: TemplateSettings) {}
  render(ctx: Context, frame: SceneFrameContext) {
    const { width: w, height: h, time: t } = frame; const s = Math.min(w, h);
    const landscape = w > h * 1.15; const dark = this.settings.theme === "dark";
    const orbit = this.id === "night-orbit"; const ink = dark ? "#e4eeeb" : "#283e42";
    const accent = this.settings.accent; const margin = s * .075;
    const motion = this.settings.motion;
    const samples = Array.from({ length: 5 }, (_, i) => analysisAt(frame.analysis, Math.max(0, (frame.analysisTime ?? t) - i / 60)));
    const band = (u: number) => {
      const value = samples.reduce((sum, row) => {
        const bands = row.spectrumBands; const p = clamp(u) * Math.max(0, bands.length - 1); const a = Math.floor(p);
        return sum + (bands[a] ?? 0) * (1 - (p - a)) + (bands[Math.min(a + 1, bands.length - 1)] ?? 0) * (p - a);
      }, 0) / samples.length;
      return Math.min(1.7, Math.pow(clamp(value), .85) * motion);
    };
    ctx.save(); ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = dark ? (orbit ? "#101f29" : "#24272a") : (orbit ? "#e4ece8" : "#f3eee4"); ctx.fillRect(0, 0, w, h);
    if (orbit) {
      ctx.globalAlpha = this.settings.background * .55;
      if (this.assets.backgroundImage) placedBackground(ctx, this.assets.backgroundImage, 0, 0, w, h, this.settings, t);
      ctx.globalAlpha = 1; ctx.fillStyle = dark ? "rgba(8,23,33,.76)" : "rgba(228,236,232,.8)"; ctx.fillRect(0, 0, w, h);
      const cx = landscape ? w * .31 : w * .5; const cy = landscape ? h * .48 : h * .35;
      const radius = s * .25;
      ctx.fillStyle = dark ? "#142b36" : "#d3dfd8"; ctx.beginPath(); ctx.arc(cx, cy, radius * .84, 0, Math.PI * 2); ctx.fill();
      // Closed, continuous frequency contours; the album itself never spins.
      for (let layer = 1; layer >= 0; layer--) {
        ctx.globalAlpha = layer ? .28 : .9; ctx.strokeStyle = accent; ctx.lineWidth = s * (layer ? .0015 : .003);
        ctx.beginPath();
        for (let i = 0; i <= 240; i++) {
          const angle = i / 240 * Math.PI * 2 - Math.PI / 2;
          const frequency = (1 - Math.cos(i / 240 * Math.PI * 2)) / 2;
          const breathing = 1 + .08 * Math.sin(t * .65 * motion + angle * 3 + layer);
          const r = radius * (1 + layer * .11) + s * .032 * band(frequency) * breathing * (layer ? .6 : 1);
          const x = cx + Math.cos(angle) * r; const y = cy + Math.sin(angle) * r;
          if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const cover = s * .285 * this.settings.coverScale;
      sleeve(ctx, this.assets.coverImage, cx - cover / 2 + w * this.settings.coverX / 100, cy - cover / 2 + h * this.settings.coverY / 100, cover, accent, dark);
      const tx = landscape ? w * .64 : w * .5; const ty = landscape ? h * .40 : h * .70;
      ctx.textAlign = landscape ? "left" : "center"; ctx.fillStyle = accent; ctx.font = `500 ${s * .016}px system-ui, sans-serif`;
      ctx.fillText("N I G H T   /   F R E Q U E N C Y", tx, ty - s * .055);
      ctx.fillStyle = ink; ctx.font = `400 ${s * .043}px Georgia, serif`;
      const textWidth = landscape ? w - tx - margin : w - 2 * margin;
      ctx.fillText(fit(ctx, this.title || "Untitled", textWidth), tx, ty);
      ctx.globalAlpha = .6; ctx.font = `${s * .021}px system-ui, sans-serif`; ctx.fillText(fit(ctx, this.artist || "Unknown Artist", textWidth), tx, ty + s * .045); ctx.globalAlpha = 1;
    } else {
      const photoY = h * .13; const photoH = h * .34;
      ctx.fillStyle = dark ? "#45544c" : "#c0c8b4"; ctx.fillRect(0, photoY, w, photoH);
      ctx.globalAlpha = this.settings.background;
      if (this.assets.backgroundImage) placedBackground(ctx, this.assets.backgroundImage, 0, photoY, w, photoH, this.settings, t);
      ctx.globalAlpha = 1; ctx.fillStyle = dark ? "rgba(17,23,24,.25)" : "rgba(238,219,188,.15)"; ctx.fillRect(0, photoY, w, photoH);
      ctx.textAlign = "left"; ctx.fillStyle = accent; ctx.font = `500 ${s * .016}px system-ui, sans-serif`;
      ctx.fillText("D A W N   /   S O U N D S C A P E", margin, h * .075);
      const cover = s * (landscape ? .28 : .25) * this.settings.coverScale;
      const x = margin + w * this.settings.coverX / 100; const y = h * .43 - cover * .25 + h * this.settings.coverY / 100;
      ctx.fillStyle = dark ? "#24272a" : "#f3eee4"; ctx.fillRect(x - s * .01, y - s * .01, cover + s * .02, cover + s * .02);
      sleeve(ctx, this.assets.coverImage, x, y, cover, accent, dark);
      const tx = margin + s * .33; const textWidth = Math.max(s * .1, w - tx - margin);
      ctx.textAlign = "left"; ctx.fillStyle = ink; ctx.font = `500 ${s * .042}px system-ui, sans-serif`;
      ctx.fillText(fit(ctx, this.title || "Untitled", textWidth), tx, h * .54);
      ctx.globalAlpha = .6; ctx.font = `${s * .021}px system-ui, sans-serif`; ctx.fillText(fit(ctx, this.artist || "Unknown Artist", textWidth), tx, h * .54 + s * .04); ctx.globalAlpha = 1;
      const baseline = h * .78; const width = w - 2 * margin;
      ctx.strokeStyle = accent; ctx.lineWidth = s * .0028;
      for (let side = -1; side <= 1; side += 2) {
        ctx.globalAlpha = side === -1 ? .95 : .3; ctx.beginPath();
        for (let i = 0; i <= 240; i++) {
          const u = i / 240;
          const envelope = Math.sin(u * Math.PI) ** 1.5;
          const carrier = .35 + .65 * Math.sin(u * Math.PI * 12 - t * .55 * motion) ** 2;
          const y = baseline + side * s * .052 * band(u) * envelope * carrier;
          if (!i) ctx.moveTo(margin, y); else ctx.lineTo(margin + width * u, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = accent; ctx.globalAlpha = .2; ctx.fillRect(margin, h * .91, w - 2 * margin, s * .0025);
    ctx.globalAlpha = 1; ctx.fillRect(margin, h * .91, (w - 2 * margin) * clamp(frame.progress), s * .0025);
    ctx.fillStyle = ink; ctx.globalAlpha = .65; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `500 ${s * .019}px ui-monospace, monospace`;
    ctx.fillText(`${timestamp(t)}  /  ${timestamp(frame.analysis.duration)}`, w / 2, h * .953);
    ctx.restore();
  }
  dispose() { for (const image of [this.assets.coverImage, this.assets.backgroundImage]) (image as (CanvasImageSource & { close?: () => void }) | undefined)?.close?.(); }
}
