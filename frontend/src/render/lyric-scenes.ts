import type { LyricCue, TemplateSettings } from "../domain/models";
import { lyricScroll } from "../domain/subtitles";
import { analysisAt } from "./audio-analysis";
import type { Scene, SceneFrameContext } from "./types";
import type { SceneAssets } from "./scenes";
import { lineColors } from "../domain/template-settings";
import { placedBackground } from "./image-placement";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
function picture(ctx: Context, image: CanvasImageSource | undefined, x: number, y: number, w: number, h: number, contain = false) {
  if (!image) return;
  const s = image as { width: number; height: number; naturalWidth?: number; naturalHeight?: number };
  const iw = s.naturalWidth || s.width; const ih = s.naturalHeight || s.height;
  if (!iw || !ih) return;
  const scale = (contain ? Math.min : Math.max)(w / iw, h / ih);
  if (contain) ctx.drawImage(image, x + (w - iw * scale) / 2, y + (h - ih * scale) / 2, iw * scale, ih * scale);
  else ctx.drawImage(image, (iw - w / scale) / 2, (ih - h / scale) / 2, w / scale, h / scale, x, y, w, h);
}
function fit(ctx: Context, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  while (chars.length && ctx.measureText(chars.join("") + "…").width > width) chars.pop();
  return chars.join("") + "…";
}
function wrap(ctx: Context, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

/** Fixed slots keep scroll travel stable even for multilingual/multiline cues. */
export function drawLyrics(ctx: Context, cues: readonly LyricCue[], time: number, box: { x: number; y: number; w: number; h: number }, fontSize: number, settings: TemplateSettings, ink: string, align: CanvasTextAlign = "center", serif = false) {
  const { index, position } = lyricScroll(cues, time);
  const stride = box.h * .25 * settings.lineGap / 1.8;
  const center = box.y + box.h / 2;
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.textAlign = align; ctx.textBaseline = "middle";
  for (let i = Math.max(0, index - 3); i <= Math.min(cues.length - 1, index + 3); i++) {
    const y = center + (i - position) * stride;
    const distance = Math.abs(y - center) / (box.h / 2);
    if (distance >= 1.3) continue;
    const edge = clamp((1 - distance) / .28);
    const relative = Math.abs(i - position);
    ctx.globalAlpha = (settings.fade * Math.exp(-relative * .52) + (1 - settings.fade) * Math.exp(-relative * relative * 5)) * edge;
    ctx.fillStyle = ink;
    let size = fontSize * settings.lyricSize;
    let lines: string[] = [];
    for (let pass = 0; pass < 12; pass++) {
      ctx.font = serif ? `400 ${size}px Georgia, "Noto Serif CJK TC", serif` : `600 ${size}px system-ui, sans-serif`;
      lines = wrap(ctx, cues[i].text, box.w * .94);
      if (lines.length * size * 1.2 <= stride * .82) break;
      size *= Math.min(.9, Math.sqrt(stride * .82 / (lines.length * size * 1.2)));
    }
    const x = align === "left" ? box.x + box.w * .03 : box.x + box.w / 2;
    lines.forEach((line, row) => ctx.fillText(line, x, y + (row - (lines.length - 1) / 2) * size * 1.2));
  }
  ctx.restore();
}

export class LyricScene implements Scene {
  constructor(readonly id: "panorama-lyrics" | "poetry-lyrics", private readonly title: string = "", private readonly artist: string = "", private readonly assets: SceneAssets, private readonly lyrics: readonly LyricCue[], private readonly settings: TemplateSettings) {}
  render(ctx: Context, frame: SceneFrameContext) {
    const { width: w, height: h, time: t } = frame;
    const s = Math.min(w, h); const portrait = h > w * 1.15;
    const landscape = w > h * 1.15; const dark = this.settings.theme === "dark";
    const ink = dark ? "#f4f0e9" : "#222630";
    const ground = dark ? "#151b29" : "#e8e7e2";
    const accent = this.settings.accent;
    const a = analysisAt(frame.analysis, frame.analysisTime ?? t);
    const motion = this.settings.motion;
    ctx.save(); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = ground; ctx.fillRect(0, 0, w, h);
    let box: { x: number; y: number; w: number; h: number };
    if (this.id === "panorama-lyrics") {
      const drift = Math.sin(t * .08 * motion) * w * .005 * Math.min(1, motion);
      ctx.globalAlpha = this.settings.background;
      picture(ctx, this.assets.backgroundImage, -w * .02 + drift, -h * .02, w * 1.04, h * 1.04);
      ctx.globalAlpha = 1;
      ctx.fillStyle = dark ? "rgba(7,13,23,.61)" : "rgba(250,246,234,.75)"; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = dark ? "rgba(7,13,23,.36)" : "rgba(250,246,234,.38)";
      ctx.fillRect(w * .09, h * .25, w * .82, h * .60);
      const cover = s * .13 * this.settings.coverScale;
      const x = w * .085; const y = h * .085;
      ctx.save(); ctx.translate(w * this.settings.coverX / 100, h * this.settings.coverY / 100);
      ctx.fillStyle = dark ? "#394557" : "#d3c9b7"; ctx.fillRect(x, y, cover, cover);
      picture(ctx, this.assets.coverImage, x, y, cover, cover, true);
      ctx.restore();
      ctx.textAlign = "left"; ctx.fillStyle = ink;
      ctx.font = `600 ${s * .031}px system-ui, sans-serif`;
      ctx.fillText(fit(ctx, this.title || "Untitled", w * .75 - cover), x + cover + s * .035, y + cover * .42);
      ctx.globalAlpha = .65; ctx.font = `${s * .019}px system-ui, sans-serif`;
      ctx.fillText(fit(ctx, this.artist || "Unknown Artist", w * .75 - cover), x + cover + s * .035, y + cover * .72); ctx.globalAlpha = 1;
      box = { x: w * .12, y: h * .27, w: w * .76, h: h * .55 };
      ctx.strokeStyle = accent; ctx.lineWidth = s * .003;
      ctx.beginPath(); ctx.moveTo(w * .085, h * .9); ctx.lineTo(w * .915, h * .9); ctx.stroke();
      const bars = 50; ctx.fillStyle = accent;
      for (let i = 0; i < bars; i++) {
        const value = a.spectrumBands[i % Math.max(1, a.spectrumBands.length)] ?? 0;
        const height = s * (.002 + .025 * value * motion);
        ctx.fillRect(w * .25 + i * w * .50 / bars, h * .9 - height, s * .0018, height);
      }
    } else {
      const page = w * (1 - Math.min(60, this.settings.imageWidth) / 100 * (portrait ? .75 : 1)); const margin = s * .075;
      ctx.fillStyle = dark ? "#202423" : "#f1ede4"; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.beginPath(); ctx.rect(page, 0, w - page, h); ctx.clip();
      ctx.fillStyle = dark ? "#3f4d47" : "#b5b9a7"; ctx.fillRect(page, 0, w - page, h);
      ctx.globalAlpha = this.settings.background;
      if (this.assets.backgroundImage) placedBackground(ctx, this.assets.backgroundImage, page, 0, w - page, h, this.settings, t);
      ctx.globalAlpha = 1; ctx.fillStyle = dark ? "rgba(18,26,22,.28)" : "rgba(237,225,200,.12)"; ctx.fillRect(page, 0, w - page, h);
      ctx.restore();
      const gutter = ctx.createLinearGradient(page - s * .025, 0, page, 0);
      gutter.addColorStop(0, "transparent"); gutter.addColorStop(1, dark ? "#00000030" : "#483c2818");
      ctx.fillStyle = gutter; ctx.fillRect(page - s * .025, 0, s * .025, h);
      ctx.fillStyle = accent; ctx.font = `500 ${s * .014}px system-ui, sans-serif`;
      ctx.fillText("L Y R I C   /   N O T E S", margin, h * .07);
      const size = s * .14 * this.settings.coverScale; const top = h * .13;
      ctx.save(); ctx.translate(w * this.settings.coverX / 100, h * this.settings.coverY / 100);
      ctx.fillStyle = dark ? "#363b35" : "#ded7c8"; ctx.fillRect(margin, top, size, size);
      picture(ctx, this.assets.coverImage, margin, top, size, size, true);
      ctx.restore();
      const tx = margin + size + s * .03; const tw = page - margin - tx;
      ctx.fillStyle = ink; ctx.font = `400 ${s * .035}px Georgia, serif`;
      ctx.fillText(fit(ctx, this.title || "Untitled", tw), tx, top + size * .44);
      ctx.globalAlpha = .6; ctx.font = `${s * .019}px system-ui, sans-serif`;
      ctx.fillText(fit(ctx, this.artist || "Unknown Artist", tw), tx, top + size * .75);
      ctx.globalAlpha = .22; ctx.fillStyle = accent; ctx.fillRect(margin, h * .30, page - margin * 2, s * .0015); ctx.globalAlpha = 1;
      box = { x: margin, y: h * .33, w: page - margin * 2, h: h * .48 };
      // Layered ink gestures answer the audio; typography and sleeve remain still.
      const colors = lineColors(this.settings);
      for (let layer = this.settings.lineCount - 1; layer >= 0; layer--) {
        ctx.strokeStyle = colors[layer % colors.length]; ctx.lineWidth = s * (layer === 0 ? .0025 : .0016); ctx.beginPath();
        for (let i = 0; i <= 100; i++) {
          const u = i / 100;
          const envelope = Math.pow(Math.sin(u * Math.PI), 2);
          const wave = Math.sin(u * Math.PI * (8 + layer * 2) - t * .7 * motion + layer * .6) + .3 * Math.sin(u * Math.PI * 18 + t * motion);
          const x = margin + u * box.w; const y = h * .87 + wave * envelope * s * .014 * clamp(a.low * motion) / (1 + layer * .16);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = accent; ctx.globalAlpha = .18; ctx.fillRect(margin, h * .925, box.w, s * .0025);
      ctx.globalAlpha = 1; ctx.fillRect(margin, h * .925, box.w * clamp(frame.progress), s * .0025);
      const stamp = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, "0")}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, "0")}`;
      ctx.font = `500 ${s * .018}px ui-monospace, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = ink; ctx.globalAlpha = .65;
      ctx.fillText(`${stamp(t)}  /  ${stamp(frame.analysis.duration)}`, page / 2, h * .96); ctx.globalAlpha = 1;
    }
    drawLyrics(ctx, this.lyrics, t, box, s * (landscape ? .044 : .045), this.settings, ink, "center", this.id === "poetry-lyrics");
    if (this.id === "panorama-lyrics") { ctx.fillStyle = accent; ctx.fillRect(w * .085, h * .955, w * .83 * clamp(frame.progress), s * .0025); }
    ctx.restore();
  }
  dispose() { for (const image of [this.assets.coverImage, this.assets.backgroundImage]) (image as (CanvasImageSource & { close?: () => void }) | undefined)?.close?.(); }
}
