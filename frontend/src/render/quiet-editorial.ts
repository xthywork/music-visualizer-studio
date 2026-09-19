import { analysisAt } from "./audio-analysis";
import type { SceneAssets } from "./scenes";
import type { Scene, SceneFrameContext } from "./types";
import type { TemplateSettings } from "../domain/models";
import { defaultSettings } from "../domain/template-settings";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Fit the entire sleeve; fill the photographic backdrop without distorting either. */
function imageFit(ctx: Context, image: CanvasImageSource, x: number, y: number, w: number, h: number, contain = false) {
  const source = image as { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
  const iw = source.naturalWidth || source.width;
  const ih = source.naturalHeight || source.height;
  if (!iw || !ih) return;
  const scale = (contain ? Math.min : Math.max)(w / iw, h / ih);
  if (contain) ctx.drawImage(image, x + (w - iw * scale) / 2, y + (h - ih * scale) / 2, iw * scale, ih * scale);
  else ctx.drawImage(image, (iw - w / scale) / 2, (ih - h / scale) / 2, w / scale, h / scale, x, y, w, h);
}

function rule(ctx: Context, x: number, y: number, end: number, opacity: number, rgb: string) {
  ctx.strokeStyle = `rgba(${rgb},${opacity})`;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(end, y); ctx.stroke();
}

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
}

/** Character-aware wrapping also handles CJK titles and long unbroken words. */
function titleLines(ctx: Context, title: string, width: number): string[] {
  const chars = Array.from(title.trim() || "Untitled");
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < chars.length; index++) {
    const candidate = current + chars[index];
    if (ctx.measureText(candidate).width > width && current) {
      if (lines.length === 1) {
        while (current && ctx.measureText(current.trimEnd() + "…").width > width) current = Array.from(current).slice(0, -1).join("");
        return [...lines, current.trimEnd() + "…"];
      }
      const breakAt = current.lastIndexOf(" ");
      if (breakAt > current.length * .45) {
        lines.push(current.slice(0, breakAt));
        current = current.slice(breakAt + 1) + chars[index];
      } else { lines.push(current); current = chars[index]; }
    } else current = candidate;
  }
  if (current) lines.push(current.trim());
  return lines;
}

export class QuietEditorialScene implements Scene {
  readonly id = "quiet-editorial" as const;
  constructor(private readonly title = "", private readonly artist = "", private readonly assets: SceneAssets = {}, private readonly settings: TemplateSettings = defaultSettings("quiet-editorial")) {}

  render(ctx: Context, frame: SceneFrameContext) {
    const { width: w, height: h, time: t, analysis } = frame;
    const dark = this.settings.theme === "dark";
    const INK = dark ? "#eee8dd" : "#282d29";
    const MUTED = dark ? "#b9b2a7" : "#575e55";
    const line = (ctx: Context, x: number, y: number, end: number, opacity = .22) => rule(ctx, x, y, end, opacity, dark ? "238,232,221" : "40,45,41");
    const motionTime = t * this.settings.motion;
    const short = Math.min(w, h);
    const landscape = w > h * 1.15;
    const portrait = h > w * 1.15;
    const margin = w * (landscape ? .065 : .09);

    // A fixed, causal convolution gives the same result on seeks and at 30/60 fps.
    // Interpolating each analysis row removes frame-rate-dependent stepping.
    const rate = analysis.temporal?.frameRate ?? 30;
    const samples = Array.from({ length: 9 }, (_, i) => {
      const time = frame.analysisTime === undefined
        ? Math.max(0, t - i / 30)
        : ((frame.analysisTime - i / 30) % analysis.duration + analysis.duration) % analysis.duration;
      const row = Math.floor(time * rate);
      return { a: analysisAt(analysis, row / rate), b: analysisAt(analysis, (row + 1) / rate), mix: time * rate - row, weight: Math.sin((i + 1) * Math.PI / 10) };
    });
    const total = samples.reduce((sum, s) => sum + s.weight, 0);
    const low = samples.reduce((sum, s) => sum + (s.a.low * (1 - s.mix) + s.b.low * s.mix) * s.weight, 0) / total;
    // Fast eased attack, soft release; absolute time keeps seeking deterministic.
    let accent = 0;
    for (const beat of analysis.beats) {
      const delta = frame.analysisTime === undefined ? t - beat
        : ((frame.analysisTime - beat) % analysis.duration + analysis.duration) % analysis.duration;
      if (delta < 0 || delta > .4) continue;
      const attack = clamp(delta / .055);
      const pulse = delta < .055 ? attack * attack * (3 - 2 * attack) : (1 - (delta - .055) / .345) ** 2;
      accent = Math.max(accent, pulse);
    }

    ctx.save();
    ctx.fillStyle = dark ? "#222723" : "#eee8dd"; ctx.fillRect(0, 0, w, h);
    if (this.assets.backgroundImage) {
      // Overscan exceeds translation so no empty edges appear at any time.
      const zoom = 1.055 + .012 * Math.sin(motionTime * Math.PI * 2 / 53);
      const dx = w * .008 * Math.sin(motionTime * Math.PI * 2 / 41);
      const dy = h * .006 * Math.sin(motionTime * Math.PI * 2 / 59 + .7);
      ctx.globalAlpha = this.settings.background;
      imageFit(ctx, this.assets.backgroundImage, (w - w * zoom) / 2 + dx, (h - h * zoom) / 2 + dy, w * zoom, h * zoom);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = dark ? "rgba(14,19,18,.42)" : "rgba(249,246,236,.66)"; ctx.fillRect(0, 0, w, h);
    const scrim = ctx.createLinearGradient(0, 0, landscape ? w : 0, landscape ? h * .25 : h);
    scrim.addColorStop(0, dark ? "rgba(14,18,17,.16)" : "rgba(249,246,236,.12)");
    scrim.addColorStop(.5, dark ? "rgba(14,18,17,.35)" : "rgba(249,246,236,.35)");
    scrim.addColorStop(1, dark ? "rgba(10,14,13,.88)" : "rgba(249,246,236,.85)");
    ctx.fillStyle = scrim; ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = Math.max(.95, short / 800);
    ctx.textAlign = "left";
    ctx.font = `500 ${short * .013}px system-ui, sans-serif`;
    ctx.fillStyle = INK; ctx.fillText("N O W   P L A Y I N G", margin, h * .084);
    line(ctx, margin, h * .11, w - margin, .27);

    const size = short * (landscape ? .57 : portrait ? .76 : .46) * this.settings.coverScale;
    const cx = (landscape ? w * .105 : (w - size) / 2) + w * this.settings.coverX / 100;
    const cy = (landscape ? h * .225 : portrait ? h * .205 : h * .165) + h * this.settings.coverY / 100;
    const pad = short * .012;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.38)"; ctx.shadowBlur = short * .045; ctx.shadowOffsetY = short * .02;
    ctx.fillStyle = "#ccc3b2"; ctx.fillRect(cx - pad, cy - pad, size + pad * 2, size + pad * 2);
    ctx.restore();
    ctx.fillStyle = "#202621"; ctx.fillRect(cx, cy, size, size);
    if (this.assets.coverImage) imageFit(ctx, this.assets.coverImage, cx, cy, size, size, true);
    else {
      // A quiet printed sleeve provides a deliberate no-artwork fallback.
      const paper = ctx.createLinearGradient(cx, cy, cx + size, cy + size);
      paper.addColorStop(0, "#8e9686"); paper.addColorStop(1, "#3d4942");
      ctx.fillStyle = paper; ctx.fillRect(cx, cy, size, size);
      for (let i = 0; i < 6; i++) line(ctx, cx + size * .15, cy + size * (.28 + i * .08), cx + size * .85, .12);
      ctx.fillStyle = INK; ctx.font = `${size * .035}px Georgia, serif`;
      ctx.fillText("A moment in sound.", cx + size * .15, cy + size * .84);
    }
    // Light stays on the mount, never flashes over or scales the artwork.
    line(ctx, cx - pad, cy - pad, cx + size + pad, .22 + clamp(low * this.settings.motion) * .22);

    const tx = landscape ? w * .56 : (w - size) / 2 - pad;
    const tw = landscape ? w - margin - tx : size + pad * 2;
    const ty = landscape ? h * .35 : portrait ? h * .72 : h * .70;
    const fontSize = short * (landscape ? .063 : portrait ? .055 : .042);
    ctx.font = `400 ${fontSize}px Georgia, "Noto Serif CJK TC", serif`;
    ctx.fillStyle = INK;
    const rows = titleLines(ctx, this.title, tw);
    const titleTop = ty - (rows.length - 1) * fontSize * .62;
    rows.forEach((row, i) => ctx.fillText(row, tx, titleTop + i * fontSize * 1.16));
    const artistY = titleTop + (rows.length - 1) * fontSize * 1.16 + short * .044;
    ctx.font = `400 ${short * .02}px system-ui, sans-serif`;
    ctx.fillStyle = MUTED;
    let artist = this.artist.trim() || "Unknown Artist";
    if (ctx.measureText(artist).width > tw) {
      while (artist && ctx.measureText(artist + "…").width > tw) artist = Array.from(artist).slice(0, -1).join("");
      artist += "…";
    }
    ctx.fillText(artist, tx, artistY);

    // A small one-sided frequency notation keeps the sleeve as the primary focus.
    const sy = landscape ? h * .70 : portrait ? h * .87 : h * .905;
    const sw = tw * .88;
    const bars = 64;
    // Keep the taller motion below even a two-line title and its artist credit.
    const maxHeight = Math.min(short * .095, (sy - artistY - short * .014) / 1.5);
    for (let i = 0; i < bars; i++) {
      const energy = samples.reduce((sum, sample) => {
        const band = (s: typeof sample.a) => {
          const values = s.spectrumBands;
          const index = Math.min(values.length - 1, Math.floor(i / bars * values.length));
          return values[index] ?? 0;
        };
        return sum + (band(sample.a) * (1 - sample.mix) + band(sample.b) * sample.mix) * sample.weight;
      }, 0) / total;
      ctx.fillStyle = this.settings.accent;
      const restingHeight = short * .002;
      // Double the reactive gain, reserving headroom for the full accent boost.
      const response = clamp(2 * Math.pow(clamp(energy), 1.35) * this.settings.motion);
      const height = restingHeight + (maxHeight - restingHeight) * response * (1 + accent * .5);
      ctx.fillRect(tx + i * sw / bars, sy - height, Math.max(1.1, short * .0023), height);
    }

    const bottom = h * .925;
    ctx.lineWidth = Math.max(1.3, short / 600);
    line(ctx, margin, bottom, w - margin, .17);
    line(ctx, margin, bottom, margin + (w - 2 * margin) * clamp(frame.progress), .65);
    ctx.font = `600 ${short * .021}px ui-monospace, "Liberation Mono", monospace`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const timeY = bottom + h * .0275;
    ctx.fillText(clock(clamp(frame.progress) * analysis.duration), margin, timeY);
    ctx.fillText(clock(analysis.duration), w - margin, timeY);
    ctx.restore();
  }

  dispose() {
    for (const image of [this.assets.coverImage, this.assets.backgroundImage]) {
      (image as (CanvasImageSource & { close?: () => void }) | undefined)?.close?.();
    }
  }
}
