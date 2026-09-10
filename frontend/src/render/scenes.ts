import type { Scene, SceneFrameContext, TemplateId } from "./types";
import { analysisAt } from "./audio-analysis";

type DrawContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ImageAsset = CanvasImageSource;
export interface SceneAssets { coverImage?: ImageAsset; backgroundImage?: ImageAsset; }

function drawAsset(ctx: DrawContext, image: ImageAsset | undefined, width: number, height: number, alpha = 1) {
  if (!image || typeof (ctx as any).drawImage !== "function") return;
  ctx.save(); ctx.globalAlpha = alpha; (ctx as any).drawImage(image, 0, 0, width, height); ctx.restore();
}
function disposeAssets(assets: SceneAssets) {
  for (const image of [assets.coverImage, assets.backgroundImage]) (image as ImageAsset & { close?: () => void } | undefined)?.close?.();
}
function color(ctx: DrawContext, fill: string) { ctx.fillStyle = fill; }
function fitText(ctx: DrawContext, value: string, max: number): string {
  if (ctx.measureText(value).width <= max) return value;
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > max) text = text.slice(0, -1);
  return `${text}…`;
}
function background(ctx: DrawContext, width: number, height: number, first: string, second: string, angle = 0) {
  const gradient = ctx.createLinearGradient(0, 0, width * Math.cos(angle), height * Math.sin(angle));
  gradient.addColorStop(0, first); gradient.addColorStop(1, second); color(ctx, gradient as unknown as string); ctx.fillRect(0, 0, width, height);
}
function aspect(width: number, height: number): "landscape" | "portrait" | "square" {
  if (width > height * 1.15) return "landscape";
  if (height > width * 1.15) return "portrait";
  return "square";
}
function clamp(value: number, minimum = 0, maximum = 1) { return Math.max(minimum, Math.min(maximum, value)); }

/** Continuous fast attack and slow release for deterministic beat response. */
function beatEnvelope(analysis: SceneFrameContext["analysis"], time: number): number {
  const attack = .045; const release = 1.05;
  let envelope = 0;
  for (let index = 0; index < analysis.beats.length; index++) {
    const delta = time - analysis.beats[index];
    if (delta < 0 || delta > 2.8) continue;
    const value = delta < attack ? delta / attack : Math.exp(-(delta - attack) / release);
    envelope = Math.max(envelope, value);
  }
  return envelope;
}
function waveformAt(frame: SceneFrameContext, index: number): number {
  const values = frame.analysis.waveform;
  return values.length ? values[index % values.length] ?? 0 : 0;
}
function drawEditorialText(ctx: DrawContext, title: string, artist: string, x: number, titleY: number, maxWidth: number, align: CanvasTextAlign = "left", shortEdge = 720) {
  const titleSize = Math.max(15, Math.round(shortEdge * .052)); const artistSize = Math.max(10, Math.round(shortEdge * .024)); const gap = Math.max(16, Math.round(shortEdge * .03));
  ctx.textAlign = align; ctx.fillStyle = "#f0eee8"; ctx.font = `600 ${titleSize}px Georgia, serif`;
  ctx.fillText(fitText(ctx, title || "Untitled", maxWidth), x, titleY);
  ctx.fillStyle = "rgba(221,220,214,.58)"; ctx.font = `500 ${artistSize}px system-ui, sans-serif`;
  ctx.fillText(fitText(ctx, artist || "Unknown Artist", maxWidth), x, titleY + gap);
}
function coverSizeFor(kind: "landscape" | "portrait" | "square", width: number, height: number) {
  const short = Math.min(width, height);
  return kind === "landscape" ? short * .54 : kind === "portrait" ? width * .68 : short * .59;
}
function roundedRectPath(ctx: DrawContext, x: number, y: number, size: number, radius: number) {
  ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.lineTo(x + size - radius, y); ctx.arc(x + size - radius, y + radius, radius, -Math.PI / 2, 0); ctx.lineTo(x + size, y + size - radius); ctx.arc(x + size - radius, y + size - radius, radius, 0, Math.PI / 2); ctx.lineTo(x + radius, y + size); ctx.arc(x + radius, y + size - radius, radius, Math.PI / 2, Math.PI); ctx.lineTo(x, y + radius); ctx.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5); ctx.closePath();
}
function drawCover(ctx: DrawContext, image: ImageAsset | undefined, x: number, y: number, size: number, alpha = 1) {
  const radius = size * .025;
  ctx.save(); ctx.globalAlpha = alpha; ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = size * .08; ctx.shadowOffsetY = size * .035;
  if (typeof (ctx as any).clip === "function") { roundedRectPath(ctx, x, y, size, radius); ctx.clip(); }
  if (image) (ctx as any).drawImage(image, x, y, size, size);
  else { color(ctx, "#252936"); ctx.fillRect(x, y, size, size); color(ctx, "rgba(232,225,207,.08)"); ctx.fillRect(x + size * .09, y + size * .09, size * .82, size * .82); }
  ctx.restore();
  ctx.save(); ctx.strokeStyle = "rgba(236,231,216,.35)"; ctx.lineWidth = Math.max(1, size / 180); roundedRectPath(ctx, x, y, size, radius); ctx.stroke(); ctx.restore();
}

export class SpectrumCoverScene implements Scene {
  readonly id = "spectrum-cover" as const;
  constructor(protected readonly title = "", protected readonly artist = "", protected readonly assets: SceneAssets = {}) {}
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const kind = aspect(width, height); const signal = analysisAt(frame.analysis, frame.time); const short = Math.min(width, height);
    background(ctx, width, height, "#0b0d14", "#1b202d", kind === "portrait" ? .05 : .32); drawAsset(ctx, this.assets.backgroundImage, width, height, .12);
    const coverSize = coverSizeFor(kind, width, height);
    const coverX = kind === "landscape" ? width * .08 : width * .5 - coverSize * .5;
    const coverY = kind === "landscape" ? height * .18 : kind === "portrait" ? height * .12 : height * .12;
    const coverPulse = 1 + signal.beat * .022 + signal.amplitude * .008;
    const glow = ctx.createRadialGradient(coverX + coverSize * .5, coverY + coverSize * .5, coverSize * .12, coverX + coverSize * .5, coverY + coverSize * .5, coverSize * .9);
    glow.addColorStop(0, `rgba(116,127,157,${.18 + signal.beat * .08})`); glow.addColorStop(1, "rgba(16,19,30,0)"); color(ctx, glow as unknown as string); ctx.fillRect(0, 0, width, height);
    drawCover(ctx, this.assets.coverImage, coverX - coverSize * (coverPulse - 1) * .5, coverY - coverSize * (coverPulse - 1) * .5, coverSize * coverPulse, .96);
    const lineY = kind === "landscape" ? height * .82 : kind === "portrait" ? height * .77 : height * .79;
    const lineLeft = kind === "landscape" ? width * .62 : width * .1; const lineRight = kind === "landscape" ? width * .92 : width * .9;
    const lineWidth = lineRight - lineLeft; const temporalBands = signal.spectrumBands; const bars = Math.min(64, Math.max(1, temporalBands.length || frame.analysis.spectrum.length || 48));
    ctx.strokeStyle = "rgba(218,217,205,.78)"; ctx.lineWidth = Math.max(1, short / 310);
    ctx.beginPath(); ctx.moveTo(lineLeft, lineY); ctx.lineTo(lineRight, lineY); ctx.stroke();
    for (let index = 0; index < bars; index++) {
      const value = temporalBands.length ? temporalBands[index % temporalBands.length] ?? 0 : frame.analysis.spectrum.length ? frame.analysis.spectrum[index % frame.analysis.spectrum.length] ?? 0 : .25 + .2 * Math.sin(frame.time * 1.7 + index * .81);
      const moving = .08 * (0.5 + 0.5 * Math.sin(frame.time * .9 + index * .43));
      const amplitude = lineWidth * .17 * clamp(value * .72 + moving + signal.beat * .18, .05, 1);
      const x = lineLeft + lineWidth * (index + .5) / bars;
      ctx.beginPath(); ctx.moveTo(x, lineY - amplitude); ctx.lineTo(x, lineY + amplitude); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(154,167,188,.82)"; ctx.lineWidth = Math.max(1, short / 420); ctx.beginPath();
    const points = Math.min(256, frame.analysis.waveform.length || 128);
    for (let index = 0; index < points; index++) {
      const value = frame.analysis.waveform.length ? waveformAt(frame, index + Math.floor(frame.time * 5)) : .5 + .25 * Math.sin(frame.time * 1.3 + index * .12);
      const x = lineLeft + lineWidth * index / Math.max(1, points - 1); const y = lineY + (value - .5) * short * .13;
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    const textX = kind === "landscape" ? width * .62 : width * .5; const textY = kind === "landscape" ? height * .59 : kind === "portrait" ? height * .9 : height * .9;
    drawEditorialText(ctx, this.title, this.artist, textX, textY, kind === "landscape" ? width * .3 : width * .8, kind === "landscape" ? "left" : "center", short);
  }
  dispose() { disposeAssets(this.assets); }
}

export class ConfiguredSpectrumCoverScene extends SpectrumCoverScene {
  constructor(title = "", artist = "", assets: SceneAssets = {}) { super(title, artist, assets); }
}

export class VinylParticleScene implements Scene {
  readonly id = "vinyl-particle" as const;
  constructor(private readonly assets: SceneAssets = {}, private readonly title = "", private readonly artist = "") {}
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const kind = aspect(width, height); const a = analysisAt(frame.analysis, frame.time); const short = Math.min(width, height);
    background(ctx, width, height, "#0b0d12", "#191d24", kind === "portrait" ? .05 : 1.1); drawAsset(ctx, this.assets.backgroundImage, width, height, .11);
    const radius = kind === "landscape" ? short * .31 : kind === "portrait" ? short * .37 : short * .34;
    const cx = kind === "landscape" ? width * .34 : width * .5; const cy = kind === "landscape" ? height * .47 : kind === "portrait" ? height * .37 : height * .4;
    const recordPulse = 1 + a.beat * .018 + a.amplitude * .006 + a.low * .012;
    ctx.save(); ctx.globalAlpha = .42; ctx.fillStyle = "#000"; ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = radius * .3; ctx.beginPath(); ctx.arc(cx, cy + radius * .08, radius * recordPulse, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    const record = ctx.createRadialGradient(cx - radius * .35, cy - radius * .4, radius * .1, cx, cy, radius * 1.1);
    record.addColorStop(0, "#30333d"); record.addColorStop(.4, "#181a22"); record.addColorStop(1, "#090a0f"); color(ctx, record as unknown as string); ctx.beginPath(); ctx.arc(cx, cy, radius * recordPulse, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(frame.time * .055);
    for (let groove = 1; groove <= 8; groove++) { ctx.beginPath(); ctx.arc(0, 0, radius * (groove / 9), .12, Math.PI * 1.88); ctx.strokeStyle = `rgba(207,211,213,${.055 + groove * .007})`; ctx.lineWidth = Math.max(1, short / 520); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(0, 0, radius * .91, Math.PI * .98, Math.PI * 1.64); ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.lineWidth = Math.max(1, short / 130); ctx.stroke();
    const labelRadius = radius * .5; ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, Math.PI * 2); color(ctx, "#a66f65"); ctx.fill();
    if (this.assets.coverImage) { ctx.save(); ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, Math.PI * 2); ctx.clip(); (ctx as any).drawImage(this.assets.coverImage, -labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2); ctx.restore(); }
    ctx.beginPath(); ctx.arc(0, 0, radius * .032, 0, Math.PI * 2); color(ctx, "#d9c7a8"); ctx.fill(); ctx.restore();
    const particles = 38;
    for (let index = 0; index < particles; index++) {
      const depth = (index % 9) / 8; const angle = index * 2.399963 + frame.time * (.018 + depth * .009); const orbit = radius * (1.25 + depth * 1.4 + Math.sin(index * 2.1) * .08); const pulse = 1 + a.high * .1 + a.beat * (.12 + depth * .08);
      const x = cx + Math.cos(angle) * orbit * pulse; const y = cy + Math.sin(angle) * orbit * pulse;
      ctx.beginPath(); ctx.arc(x, y, Math.max(.8, short / 520 * (.65 + depth * 1.2)), 0, Math.PI * 2); ctx.fillStyle = `rgba(${190 + Math.round(depth * 35)},${196 + Math.round(depth * 24)},${190 + Math.round(depth * 20)},${.16 + depth * .34})`; ctx.fill();
    }
    if (kind === "landscape") drawEditorialText(ctx, this.title, this.artist, width * .68, height * .45, width * .23, "left", short);
    else drawEditorialText(ctx, this.title, this.artist, width * .5, height * .86, width * .78, "center", short);
  }
  dispose() { disposeAssets(this.assets); }
}

function drawRibbon(ctx: DrawContext, frame: SceneFrameContext, cx: number, cy: number, spanX: number, spanY: number, phase: number, thickness: number, fill: string, stroke: string, pulse: number) {
  const points = 72; const top: Array<[number, number]> = []; const bottom: Array<[number, number]> = []; const signal = analysisAt(frame.analysis, frame.time);
  for (let index = 0; index < points; index++) {
    const t = index / (points - 1) * 2 - 1; const audio = waveformAt(frame, index * 3) - .5 + signal.mid * .12 + signal.high * .08;
    const x = cx + t * spanX; const y = cy + Math.sin(t * 3.2 + phase) * spanY * .28 + audio * spanY * .7 + Math.sin(t * 7 + phase * .7) * spanY * .08;
    const localThickness = thickness * (1 + .22 * Math.sin(t * 2.4 + phase) + pulse * .22);
    top.push([x, y - localThickness]); bottom.push([x, y + localThickness]);
  }
  ctx.beginPath(); top.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  for (let index = bottom.length - 1; index >= 0; index--) ctx.lineTo(bottom[index][0], bottom[index][1]);
  ctx.closePath(); color(ctx, fill); ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(1, Math.min(spanX, spanY) / 180); ctx.stroke();
}

export class AbstractPulseScene implements Scene {
  readonly id = "abstract-pulse" as const;
  constructor(private readonly assets: SceneAssets = {}, private readonly title = "", private readonly artist = "") {}
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const kind = aspect(width, height); const a = analysisAt(frame.analysis, frame.time); const pulse = Math.max(beatEnvelope(frame.analysis, frame.time), a.amplitude * .12); const short = Math.min(width, height);
    background(ctx, width, height, "#090b16", "#1c1a2c", kind === "portrait" ? .12 : .65); drawAsset(ctx, this.assets.backgroundImage, width, height, .1);
    const glow = ctx.createRadialGradient(width * .5, height * .5, short * .04, width * .5, height * .5, short * .75); glow.addColorStop(0, `rgba(107,92,144,${.14 + pulse * .1 + a.mid * .06})`); glow.addColorStop(.55, `rgba(39,36,76,${.08 + a.high * .06})`); glow.addColorStop(1, "rgba(8,9,18,0)"); color(ctx, glow as unknown as string); ctx.fillRect(0, 0, width, height);
    if (kind === "landscape") {
      drawRibbon(ctx, frame, width * .5, height * (.47 + pulse * .035), width * .48, height * .27, frame.time * .55, short * (.055 + pulse * .035), "rgba(106,91,153,.27)", "rgba(168,146,193,.48)", pulse);
      drawRibbon(ctx, frame, width * .5, height * (.56 - pulse * .025), width * .5, height * .17, frame.time * .38 + 2, short * (.035 + pulse * .022), "rgba(57,72,116,.3)", "rgba(119,136,178,.34)", pulse);
      drawRibbon(ctx, frame, width * .5, height * (.4 + pulse * .02), width * .42, height * .11, frame.time * .74 + 4, short * .021, "rgba(165,111,96,.2)", "rgba(202,153,126,.32)", pulse);
    } else if (kind === "portrait") {
      ctx.save(); ctx.translate(width * .5, height * .5); ctx.rotate(-.12);
      drawRibbon(ctx, frame, 0, 0, width * .27, height * .43, frame.time * .52, short * (.08 + pulse * .04), "rgba(95,79,147,.27)", "rgba(169,145,192,.45)", pulse);
      drawRibbon(ctx, frame, 0, height * .04, width * .2, height * .45, frame.time * .34 + 2, short * (.045 + pulse * .026), "rgba(52,69,114,.32)", "rgba(114,131,173,.34)", pulse);
      ctx.restore();
    } else {
      drawRibbon(ctx, frame, width * .5, height * (.5 + pulse * .03), width * .45, height * .26, frame.time * .5, short * (.065 + pulse * .035), "rgba(101,84,148,.28)", "rgba(168,144,194,.45)", pulse);
      drawRibbon(ctx, frame, width * .5, height * .43, width * .4, height * .14, frame.time * .72 + 2, short * (.028 + pulse * .02), "rgba(161,108,92,.2)", "rgba(202,151,125,.3)", pulse);
    }
    if (this.title || this.artist) drawEditorialText(ctx, this.title, this.artist, kind === "landscape" ? width * .07 : width * .5, kind === "landscape" ? height * .82 : height * .9, kind === "landscape" ? width * .3 : width * .8, kind === "landscape" ? "left" : "center", short);
  }
  dispose() { disposeAssets(this.assets); }
}

export function createScene(id: TemplateId, config: { title?: string; artist?: string; assets?: SceneAssets } = {}): Scene {
  const assets = config.assets ?? {};
  if (id === "spectrum-cover") return new ConfiguredSpectrumCoverScene(config.title, config.artist, assets);
  if (id === "vinyl-particle") return new VinylParticleScene(assets, config.title, config.artist);
  return new AbstractPulseScene(assets, config.title, config.artist);
}

async function decodeImageAsset(source: string | undefined): Promise<ImageBitmap | undefined> {
  if (!source || typeof fetch !== "function" || typeof createImageBitmap !== "function") return undefined;
  try { return await createImageBitmap(await (await fetch(source)).blob()); } catch { return undefined; }
}

export async function createSceneAsync(id: TemplateId, config: { title?: string; artist?: string; coverImage?: string; backgroundImage?: string } = {}): Promise<Scene> {
  const [coverImage, backgroundImage] = await Promise.all([decodeImageAsset(config.coverImage), decodeImageAsset(config.backgroundImage)]);
  const assets = { coverImage, backgroundImage };
  if (id === "spectrum-cover") return new ConfiguredSpectrumCoverScene(config.title, config.artist, assets);
  if (id === "vinyl-particle") return new VinylParticleScene(assets, config.title, config.artist);
  return new AbstractPulseScene(assets, config.title, config.artist);
}

export function disposeScene(scene: Scene) { scene.dispose?.(); }

export const TEMPLATE_IDS: readonly TemplateId[] = ["spectrum-cover", "vinyl-particle", "abstract-pulse"];
