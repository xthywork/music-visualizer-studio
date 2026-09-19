import { analysisAt } from "./audio-analysis";
import type { SceneAssets } from "./scenes";
import type { Scene, SceneFrameContext } from "./types";
import type { TemplateSettings } from "../domain/models";
import { defaultSettings, lineColors } from "../domain/template-settings";
import { placedBackground } from "./image-placement";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const INK = "#282b29";
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function fittedImage(ctx: Context, image: CanvasImageSource, x: number, y: number, width: number, height: number, contain: boolean, time = 0) {
  const source = image as { width: number; height: number; naturalWidth?: number; naturalHeight?: number };
  const iw = source.naturalWidth || source.width;
  const ih = source.naturalHeight || source.height;
  if (!iw || !ih) return;
  const scale = (contain ? Math.min : Math.max)(width / iw, height / ih);
  if (contain) {
    ctx.drawImage(image, x + (width - iw * scale) / 2, y + (height - ih * scale) / 2, iw * scale, ih * scale);
  } else {
    const cropW = width / (scale * 1.04);
    const cropH = height / (scale * 1.04);
    const sx = (iw - cropW) * (.5 + .025 * Math.sin(time * Math.PI * 2 / 47));
    const sy = (ih - cropH) * (.5 + .02 * Math.sin(time * Math.PI * 2 / 61));
    ctx.drawImage(image, sx, sy, cropW, cropH, x, y, width, height);
  }
}

function rule(ctx: Context, x: number, y: number, end: number, color = INK) {
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(end, y); ctx.stroke();
}

function ellipsis(ctx: Context, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  while (chars.length && ctx.measureText(chars.join("") + "…").width > width) chars.pop();
  return chars.join("").trimEnd() + "…";
}

function headline(ctx: Context, text: string, width: number): string[] {
  const chars = Array.from(text.trim() || "Untitled");
  let first = "";
  let index = 0;
  while (index < chars.length && ctx.measureText(first + chars[index]).width <= width) first += chars[index++];
  if (index === chars.length) return [first];
  // Keep words intact where possible, while allowing Chinese and unbroken titles.
  const space = first.lastIndexOf(" ");
  if (space > first.length * .4) {
    index -= Array.from(first.slice(space)).length;
    first = first.slice(0, space);
  }
  return [first, ellipsis(ctx, chars.slice(index).join("").trim(), width)];
}

function timeLabel(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

/** A printed music poster: photographic strip, pasted sleeve, three living ink contours. */
export class PaperResonanceScene implements Scene {
  readonly id = "paper-resonance" as const;
  constructor(private readonly title = "", private readonly artist = "", private readonly assets: SceneAssets = {}, private readonly settings: TemplateSettings = defaultSettings("paper-resonance")) {}

  render(ctx: Context, frame: SceneFrameContext) {
    const { width: w, height: h, time: t, analysis } = frame;
    const dark = this.settings.theme === "dark";
    const PAPER = dark ? "#20272b" : "#eee8dc";
    const INK = dark ? "#eee8dc" : "#282b29";
    const RED = this.settings.accent;
    const short = Math.min(w, h);
    const landscape = w > h * 1.15;
    const portrait = h > w * 1.15;
    const margin = w * .065;
    const imageTop = h * .14;
    const imageHeight = h * (landscape ? .31 : portrait ? .28 : .24);
    const imageWidth = (w - margin * 2) * this.settings.imageWidth / 100;
    const imageLeft = w - margin - imageWidth;

    // Finite, interpolated smoothing is reproducible in preview, worker and seeks.
    const rate = analysis.temporal?.frameRate ?? 30;
    const samples = Array.from({ length: 7 }, (_, index) => {
      const signalTime = frame.analysisTime === undefined ? Math.max(0, t - index / 30)
        : ((frame.analysisTime - index / 30) % analysis.duration + analysis.duration) % analysis.duration;
      const row = Math.floor(signalTime * rate);
      return { a: analysisAt(analysis, row / rate), b: analysisAt(analysis, (row + 1) / rate), mix: signalTime * rate - row, weight: 7 - index };
    });
    const energy = (key: "low" | "mid" | "high" | "beat") => clamp(samples.reduce((sum, s) => sum + (s.a[key] * (1 - s.mix) + s.b[key] * s.mix) * s.weight, 0) / 28);
    const levels = [energy("low"), energy("mid"), energy("high")];
    const beat = energy("beat");

    ctx.save();
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, h);
    // Fixed paper flecks are texture, not animated particles. Bounded at any resolution.
    ctx.fillStyle = "rgba(81,63,41,.075)";
    for (let i = 0; i < 360; i++) {
      const x = ((i * 137.508 + 19) % 997) / 997 * w;
      const y = ((i * 251.137 + 53) % 991) / 991 * h;
      ctx.fillRect(x, y, Math.max(.5, short * .0008), Math.max(.5, short * .0008));
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.font = `700 ${short * .023}px system-ui, sans-serif`;
    ctx.fillText("SOUND / STUDY", margin, h * .085);
    ctx.fillStyle = RED;
    ctx.fillRect(margin, h * .105, w * .052, Math.max(2, short * .005));
    ctx.lineWidth = Math.max(.9, short * .0016);
    rule(ctx, margin + w * .065, h * .107, w - margin, dark ? "#707d80" : "rgba(40,43,41,.35)");

    ctx.fillStyle = "#bcb9a7";
    ctx.save(); ctx.beginPath(); ctx.rect(imageLeft, imageTop, imageWidth, imageHeight); ctx.clip();
    ctx.fillRect(imageLeft, imageTop, imageWidth, imageHeight);
    if (this.assets.backgroundImage) {
      ctx.globalAlpha = this.settings.background;
      placedBackground(ctx, this.assets.backgroundImage, imageLeft, imageTop, imageWidth, imageHeight, this.settings, t);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(224,206,168,.13)";
      ctx.fillRect(margin, imageTop, w - margin * 2, imageHeight);
    } else {
      // A restrained folded-paper silhouette keeps an intentional empty-state composition.
      ctx.fillStyle = "#8d9b91"; ctx.beginPath();
      ctx.moveTo(margin, imageTop + imageHeight); ctx.lineTo(w * .4, imageTop + imageHeight * .22);
      ctx.lineTo(w * .7, imageTop + imageHeight); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#637d73"; ctx.beginPath();
      ctx.moveTo(w * .4, imageTop + imageHeight); ctx.lineTo(w * .76, imageTop + imageHeight * .4);
      ctx.lineTo(w - margin, imageTop + imageHeight); ctx.closePath(); ctx.fill();
    }

    ctx.restore();
    const cover = short * (landscape ? .39 : portrait ? .64 : .36) * this.settings.coverScale;
    const cx = (portrait ? (w - cover) / 2 : margin + w * .025) + w * this.settings.coverX / 100;
    const cy = h * (landscape ? .255 : portrait ? .23 : .24) + h * this.settings.coverY / 100;
    const mount = short * .011;
    ctx.save();
    ctx.shadowColor = "rgba(43,34,23,.20)"; ctx.shadowBlur = short * .023; ctx.shadowOffsetY = short * .009;
    ctx.fillStyle = "#faf5eb"; ctx.fillRect(cx - mount, cy - mount, cover + mount * 2, cover + mount * 2);
    ctx.restore();
    ctx.fillStyle = "#dfd5c2"; ctx.fillRect(cx, cy, cover, cover);
    if (this.assets.coverImage) fittedImage(ctx, this.assets.coverImage, cx, cy, cover, cover, true);
    else {
      ctx.fillStyle = RED; ctx.beginPath(); ctx.arc(cx + cover * .5, cy + cover * .45, cover * .28, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = INK; ctx.fillRect(cx + cover * .18, cy + cover * .46, cover * .64, cover * .32);
      ctx.fillStyle = PAPER; ctx.font = `600 ${cover * .038}px system-ui, sans-serif`;
      ctx.fillText("SOUND, IN PRINT.", cx + cover * .23, cy + cover * .7);
    }

    const tx = landscape ? w * .43 : portrait ? margin : w * .51;
    const tw = w - margin - tx;
    const titleY = h * (landscape ? .54 : portrait ? .65 : .47);
    const fontSize = short * (landscape ? .071 : portrait ? .063 : .048);
    ctx.fillStyle = INK; ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
    const lines = headline(ctx, this.title, tw);
    lines.forEach((value, index) => ctx.fillText(value, tx, titleY + index * fontSize * 1.08));
    const artistY = titleY + (lines.length - 1) * fontSize * 1.08 + short * .042;
    ctx.font = `500 ${short * .023}px system-ui, sans-serif`;
    ctx.fillStyle = dark ? "#b9b6ad" : "#69685f";
    ctx.fillText(ellipsis(ctx, this.artist.trim() || "Unknown Artist", tw), tx, artistY);

    // Each contour has a role: bass in red, midrange in graphite, treble as a fine echo.
    // These are energy-driven ink forms, not a literal sampled PCM waveform.
    const waveY = h * (portrait ? .825 : .80);
    const waveWidth = w - 2 * margin;
    const colors = lineColors(this.settings);
    const scales = [1, .56, .30];
    const amplitudeLimit = Math.min(short * .105, waveY - artistY - short * .035);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (let layer = this.settings.lineCount - 1; layer >= 0; layer--) {
      ctx.strokeStyle = colors[layer % colors.length];
      ctx.lineWidth = short * (layer === 0 ? .0045 : layer === 1 ? .0028 : .0018);
      ctx.beginPath();
      const amplitude = amplitudeLimit * (scales[layer] ?? .3 / (1 + (layer - 2) * .15)) * clamp(3.2 * levels[layer % 3] ** 1.25 * this.settings.motion) * (1 + beat * .25) / 1.25;
      for (let i = 0; i <= 200; i++) {
        const u = i / 200;
        const envelope = Math.sin(Math.PI * u) ** 1.3;
        const carrier = .70 * Math.sin(u * Math.PI * (7 + layer * 4) - t * (.85 + layer * .17))
          + .30 * Math.sin(u * Math.PI * (15 + layer * 3) + t * .31 + layer);
        const y = waveY + amplitude * envelope * carrier;
        if (i === 0) ctx.moveTo(margin, y); else ctx.lineTo(margin + waveWidth * u, y);
      }
      ctx.stroke();
    }

    // Progress is a printed rule with a moving red end mark; elapsed/total stay centered.
    const footerY = h * .925;
    ctx.lineWidth = Math.max(1.2, short * .002);
    rule(ctx, margin, footerY, w - margin, dark ? "#707d80" : "rgba(40,43,41,.24)");
    const progressX = margin + waveWidth * clamp(frame.progress);
    rule(ctx, margin, footerY, progressX, RED);
    ctx.fillStyle = RED; ctx.fillRect(progressX - short * .002, footerY - short * .005, short * .004, short * .01);
    ctx.font = `600 ${short * .021}px ui-monospace, "Liberation Mono", monospace`;
    ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(timeLabel(clamp(frame.progress) * analysis.duration), margin, h * .957);
    ctx.fillText(timeLabel(analysis.duration), w - margin, h * .957);
    ctx.restore();
  }

  dispose() {
    for (const image of [this.assets.coverImage, this.assets.backgroundImage]) {
      (image as (CanvasImageSource & { close?: () => void }) | undefined)?.close?.();
    }
  }
}
