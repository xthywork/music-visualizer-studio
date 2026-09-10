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
    const glow = ctx.createRadialGradient(coverX + coverSize * .5, coverY + coverSize * .5, coverSize * .12, coverX + coverSize * .5, coverY + coverSize * .5, coverSize * .9);
    glow.addColorStop(0, `rgba(116,127,157,${.18 + signal.beat * .08})`); glow.addColorStop(1, "rgba(16,19,30,0)"); color(ctx, glow as unknown as string); ctx.fillRect(0, 0, width, height);
    // Keep the artwork completely stable. Only the surrounding light and
    // spectrum respond to the music; the cover itself is an editorial anchor.
    drawCover(ctx, this.assets.coverImage, coverX, coverY, coverSize, .96);
    const lineY = kind === "landscape" ? height * .82 : kind === "portrait" ? height * .77 : height * .79;
    const lineLeft = kind === "landscape" ? width * .62 : width * .1; const lineRight = kind === "landscape" ? width * .92 : width * .9;
    const lineWidth = lineRight - lineLeft; const temporalBands = signal.spectrumBands;
    const bars = Math.min(64, Math.max(1, temporalBands.length || frame.analysis.spectrum.length || 48));
    // Both signals intentionally share one baseline and one narrow visual
    // band. The spectral contour is the upper layer; the audio waveform
    // passes through it, making their relationship legible instead of looking
    // like two unrelated widgets placed beside one another.
    const baseline = lineY + short * .012;
    ctx.strokeStyle = "rgba(218,217,205,.38)"; ctx.lineWidth = Math.max(1, short / 330);
    ctx.beginPath(); ctx.moveTo(lineLeft, baseline); ctx.lineTo(lineRight, baseline); ctx.stroke();

    const spectrumValue = (index: number) => temporalBands.length
      ? temporalBands[index % temporalBands.length] ?? 0
      : frame.analysis.spectrum.length
        ? frame.analysis.spectrum[index % frame.analysis.spectrum.length] ?? 0
        : .25 + .2 * Math.sin(frame.time * 1.7 + index * .81);
    // A quiet set of vertical stems retains the spectrum reading while the
    // connected upper contour gives it a designed, waveform-like silhouette.
    ctx.strokeStyle = "rgba(218,217,205,.25)"; ctx.lineWidth = Math.max(1, short / 430);
    for (let index = 0; index < bars; index++) {
      const value = clamp(spectrumValue(index) + .05 * Math.sin(frame.time * .9 + index * .43) + signal.beat * .09);
      const x = lineLeft + lineWidth * (index + .5) / bars;
      const amplitude = short * (.055 + value * .17);
      ctx.beginPath(); ctx.moveTo(x, baseline); ctx.lineTo(x, baseline - amplitude); ctx.stroke();
    }
    ctx.beginPath();
    for (let index = 0; index <= bars * 2; index++) {
      const position = index / (bars * 2); const source = position * Math.max(0, bars - 1);
      const left = Math.floor(source); const mix = source - left;
      const value = spectrumValue(left) * (1 - mix) + spectrumValue(Math.min(bars - 1, left + 1)) * mix;
      const x = lineLeft + lineWidth * position;
      const y = baseline - short * (.065 + clamp(value + signal.beat * .12) * .19);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = "rgba(239,236,222,.92)"; ctx.lineWidth = Math.max(1, short / 250); ctx.stroke();

    // The lower waveform is deliberately larger than before, but remains
    // translucent so the upper spectral line stays the visual focus.
    ctx.strokeStyle = "rgba(154,167,188,.78)"; ctx.lineWidth = Math.max(1, short / 360); ctx.beginPath();
    const points = Math.min(256, frame.analysis.waveform.length || 128);
    for (let index = 0; index < points; index++) {
      const value = frame.analysis.waveform.length ? waveformAt(frame, index + Math.floor(frame.time * 5)) : .5 + .25 * Math.sin(frame.time * 1.3 + index * .12);
      const x = lineLeft + lineWidth * index / Math.max(1, points - 1); const y = baseline + (value - .5) * short * .11;
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
    const recordPulse = 1 + a.beat * .014 + a.amplitude * .004 + a.low * .008;
    // Fine, deliberately imperfect orbit lines sit behind the record. They
    // move slowly enough to read as atmosphere rather than a radial equalizer.
    for (let ring = 0; ring < 5; ring++) {
      const orbit = radius * (1.22 + ring * .31 + a.low * .035 * Math.sin(ring * 1.8 + frame.time * .7) + a.beat * .018);
      const rotation = frame.time * (.012 + ring * .004) + ring * 1.17 + a.mid * .012;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(rotation);
      ctx.beginPath();
      const points = 96;
      for (let point = 0; point <= points; point++) {
        const theta = point / points * Math.PI * 2;
        const wobble = 1 + .035 * Math.sin(theta * (2 + ring % 3) + ring * 1.7) + .018 * Math.sin(theta * 7 - ring);
        const x = Math.cos(theta) * orbit * wobble * (1 + ring * .018);
        const y = Math.sin(theta) * orbit * (0.78 + .07 * Math.sin(theta * 3 + ring)) * wobble;
        point ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.strokeStyle = `rgba(153,164,177,${.065 - ring * .007 + a.low * .018})`; ctx.lineWidth = Math.max(1, short / 620); ctx.stroke(); ctx.restore();
    }
    // Layered contact shadow and a restrained atmospheric halo give the disc
    // a physical place in the scene. Keep these passes bounded and outside
    // the rotating surface so the label remains a stable visual anchor.
    ctx.save(); ctx.globalAlpha = .42; ctx.fillStyle = "#000"; ctx.shadowColor = "rgba(0,0,0,.82)"; ctx.shadowBlur = radius * .34; ctx.shadowOffsetY = radius * .08; ctx.beginPath(); ctx.arc(cx, cy, radius * recordPulse, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.save();
    const aura = ctx.createRadialGradient(cx, cy, radius * .86, cx, cy, radius * 1.48);
    aura.addColorStop(0, "rgba(129,143,164,.095)"); aura.addColorStop(.34, "rgba(95,111,136,.035)"); aura.addColorStop(1, "rgba(16,18,25,0)");
    color(ctx, aura as unknown as string); ctx.beginPath(); ctx.arc(cx, cy, radius * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    const record = ctx.createRadialGradient(cx - radius * .35, cy - radius * .4, radius * .1, cx, cy, radius * 1.1);
    record.addColorStop(0, "#30333d"); record.addColorStop(.4, "#181a22"); record.addColorStop(1, "#090a0f"); color(ctx, record as unknown as string); ctx.beginPath(); ctx.arc(cx, cy, radius * recordPulse, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(frame.time * .055);
    const surfaceRadius = radius * recordPulse;
    // The surface is built from intentionally irregular families rather than
    // a uniform stack of circles: micro-groove clusters, interrupted cuts,
    // and a few broad mastering bands make the record read as designed.
    const microLine = Math.max(1, short / 980);
    const grooveGroups = [
      { start: .25, count: 5, spacing: .018, phase: .22, arc: 1.46 },
      { start: .37, count: 7, spacing: .014, phase: 2.08, arc: 1.08 },
      { start: .49, count: 4, spacing: .023, phase: 3.18, arc: 1.72 },
      { start: .60, count: 8, spacing: .012, phase: 4.04, arc: .92 },
    ];
    for (let group = 0; group < grooveGroups.length; group++) {
      const family = grooveGroups[group];
      for (let index = 0; index < family.count; index++) {
        const wobble = Math.sin(index * 2.71 + group * 1.83) * .006;
        const grooveRadius = surfaceRadius * (family.start + index * family.spacing + wobble);
        const start = family.phase + Math.sin(index * 1.91 + group) * .19;
        const span = Math.PI * (family.arc + .14 * Math.sin(index * 2.17 + group));
        const gap = .12 + .05 * ((index + group) % 3);
        const direction = index % 2 ? -1 : 1;
        ctx.beginPath();
        ctx.arc(0, 0, grooveRadius, start, start + direction * (span - gap), direction < 0);
        ctx.strokeStyle = `rgba(210,216,224,${.025 + ((index + group * 2) % 4) * .009})`;
        ctx.lineWidth = microLine * (1 + (index % 3) * .35); ctx.stroke();
        // A dim companion line offset by a fraction of a groove adds the
        // carved/shadowed edge that real lacquer surfaces catch in light.
        if ((index + group) % 2 === 0) {
          ctx.beginPath(); ctx.arc(0, 0, grooveRadius + microLine * 2.1, start + .035, start + direction * (span - gap) + .035, direction < 0);
          ctx.strokeStyle = "rgba(0,0,0,.18)"; ctx.lineWidth = microLine * .9; ctx.stroke();
        }
      }
    }
    // Fine mastering rings are deliberately broken into four quiet sectors,
    // so the highlight has a composed rhythm instead of a perfect halo.
    for (let ring = 0; ring < 5; ring++) {
      const ringRadius = surfaceRadius * (.69 + ring * .043);
      for (let sector = 0; sector < 4; sector++) {
        const start = sector * Math.PI * .5 + .08 + ring * .031;
        const span = Math.PI * (.22 + ((ring + sector) % 3) * .035);
        ctx.beginPath(); ctx.arc(0, 0, ringRadius, start, start + span);
        ctx.strokeStyle = `rgba(232,237,241,${.018 + (sector === 1 ? .018 : 0)})`; ctx.lineWidth = microLine * .7; ctx.stroke();
      }
    }
    // Rotating specular bands and the pressed outer rim make the spin legible
    // without moving the cover artwork.
    const sheen = ctx.createLinearGradient(-surfaceRadius, -surfaceRadius, surfaceRadius, surfaceRadius);
    sheen.addColorStop(0, "rgba(255,255,255,0)"); sheen.addColorStop(.46, "rgba(255,255,255,.025)"); sheen.addColorStop(.52, "rgba(255,255,255,.18)"); sheen.addColorStop(.58, "rgba(255,255,255,.025)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.beginPath(); ctx.arc(0, 0, surfaceRadius * .9, -.98, -.27); ctx.strokeStyle = sheen; ctx.lineWidth = Math.max(2, short / 170); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, surfaceRadius * .965, .12, Math.PI * 1.85); ctx.strokeStyle = "rgba(227,232,238,.11)"; ctx.lineWidth = Math.max(1, short / 260); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, surfaceRadius * .985, Math.PI * .9, Math.PI * 1.86); ctx.strokeStyle = "rgba(0,0,0,.54)"; ctx.lineWidth = Math.max(2, short / 120); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, surfaceRadius * .994, -.5, Math.PI * .62); ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = Math.max(1, short / 300); ctx.stroke();
    ctx.restore();
    // The label and artwork are intentionally outside the rotating transform:
    // the centre image stays upright while the disc and its grooves turn.
    const labelRadius = radius * .5; ctx.save(); ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, Math.PI * 2); color(ctx, "#a66f65"); ctx.fill();
    if (this.assets.coverImage) { ctx.save(); ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, Math.PI * 2); ctx.clip(); (ctx as any).drawImage(this.assets.coverImage, -labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2); ctx.restore(); }
    ctx.beginPath(); ctx.arc(0, 0, radius * .032, 0, Math.PI * 2); color(ctx, "#d9c7a8"); ctx.fill(); ctx.restore();
    const particles = 34;
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

export function createScene(id: TemplateId, config: { title?: string; artist?: string; assets?: SceneAssets } = {}): Scene {
  const assets = config.assets ?? {};
  if (id === "spectrum-cover") return new ConfiguredSpectrumCoverScene(config.title, config.artist, assets);
  return new VinylParticleScene(assets, config.title, config.artist);
}

async function decodeImageAsset(source: string | undefined): Promise<ImageBitmap | undefined> {
  if (!source || typeof fetch !== "function" || typeof createImageBitmap !== "function") return undefined;
  try { return await createImageBitmap(await (await fetch(source)).blob()); } catch { return undefined; }
}

export async function createSceneAsync(id: TemplateId, config: { title?: string; artist?: string; coverImage?: string; backgroundImage?: string } = {}): Promise<Scene> {
  const [coverImage, backgroundImage] = await Promise.all([decodeImageAsset(config.coverImage), decodeImageAsset(config.backgroundImage)]);
  const assets = { coverImage, backgroundImage };
  if (id === "spectrum-cover") return new ConfiguredSpectrumCoverScene(config.title, config.artist, assets);
  return new VinylParticleScene(assets, config.title, config.artist);
}

export function disposeScene(scene: Scene) { scene.dispose?.(); }

export const TEMPLATE_IDS: readonly TemplateId[] = ["spectrum-cover", "vinyl-particle"];
