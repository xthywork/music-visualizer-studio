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
    const glow = ctx.createRadialGradient(coverX + coverSize * .5, coverY + coverSize * .5, coverSize * .12, coverX + coverSize * .5, coverY + coverSize * .5, coverSize * .9);
    glow.addColorStop(0, `rgba(116,127,157,${.18 + signal.beat * .08})`); glow.addColorStop(1, "rgba(16,19,30,0)"); color(ctx, glow as unknown as string); ctx.fillRect(0, 0, width, height);
    // Keep the artwork completely stable. Only the surrounding light and
    // spectrum respond to the music; the cover itself is an editorial anchor.
    drawCover(ctx, this.assets.coverImage, coverX, coverY, coverSize, .96);
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
    ctx.save(); ctx.globalAlpha = .42; ctx.fillStyle = "#000"; ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = radius * .3; ctx.beginPath(); ctx.arc(cx, cy + radius * .08, radius * recordPulse, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    const record = ctx.createRadialGradient(cx - radius * .35, cy - radius * .4, radius * .1, cx, cy, radius * 1.1);
    record.addColorStop(0, "#30333d"); record.addColorStop(.4, "#181a22"); record.addColorStop(1, "#090a0f"); color(ctx, record as unknown as string); ctx.beginPath(); ctx.arc(cx, cy, radius * recordPulse, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(frame.time * .055);
    // A denser set of very fine grooves gives the disc a physical surface.
    for (let groove = 1; groove <= 24; groove++) {
      const grooveRadius = radius * (.2 + groove / 27 * .69);
      ctx.beginPath(); ctx.arc(0, 0, grooveRadius, .08 + groove * .003, Math.PI * 1.92 - groove * .002);
      ctx.strokeStyle = `rgba(206,211,216,${.025 + (groove % 5) * .008})`; ctx.lineWidth = Math.max(1, short / 760); ctx.stroke();
    }
    // The specular band rotates with the vinyl, making the physical rotation
    // legible even when the record is almost black.
    ctx.beginPath(); ctx.arc(0, 0, radius * .91, Math.PI * .98, Math.PI * 1.64); ctx.strokeStyle = "rgba(255,255,255,.13)"; ctx.lineWidth = Math.max(1, short / 145); ctx.stroke();
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

type Point = { x: number; y: number };
type FlowDirection = "horizontal" | "vertical" | "diagonal";

/**
 * Draw one low-control-point silk ribbon. There is intentionally no waveform
 * sampling here: the audio only breathes the sculpture as a whole, so the
 * silhouette remains smooth at 4K and in the narrow portrait composition.
 */
function drawSilkRibbon(ctx: DrawContext, points: readonly Point[], thickness: number, drive: number, phase: number, direction: FlowDirection, first: string, second: string, stroke: string) {
  const drift = thickness * (.12 + drive * .18);
  const animated = points.map((point, index) => {
    const offset = phase + index * 1.37;
    const x = point.x + (direction === "vertical" ? Math.sin(offset) * drift : direction === "diagonal" ? Math.sin(offset) * drift * .65 : Math.sin(offset) * drift * .24);
    const y = point.y + (direction === "horizontal" ? Math.cos(offset) * drift : direction === "diagonal" ? Math.cos(offset) * drift * .65 : Math.cos(offset) * drift * .24);
    return { x, y };
  });
  const normals = animated.map((point, index) => {
    const before = animated[Math.max(0, index - 1)] ?? point; const after = animated[Math.min(animated.length - 1, index + 1)] ?? point;
    const tx = after.x - before.x; const ty = after.y - before.y; const length = Math.max(.001, Math.hypot(tx, ty));
    return { x: -ty / length, y: tx / length };
  });
  const halfWidths = animated.map((_, index) => thickness * (.5 + drive * .12) * (index === 0 || index === animated.length - 1 ? .72 : 1));
  const top = animated.map((point, index) => ({ x: point.x + normals[index].x * halfWidths[index], y: point.y + normals[index].y * halfWidths[index] }));
  const bottom = animated.map((point, index) => ({ x: point.x - normals[index].x * halfWidths[index], y: point.y - normals[index].y * halfWidths[index] }));
  const path = () => {
    const firstPoint = top[0]; const secondPoint = top[1]; const thirdPoint = top[2]; const fourthPoint = top[3];
    ctx.beginPath(); ctx.moveTo(firstPoint.x, firstPoint.y); ctx.bezierCurveTo(secondPoint.x, secondPoint.y, thirdPoint.x, thirdPoint.y, fourthPoint.x, fourthPoint.y);
    const b1 = bottom[2]; const b2 = bottom[1]; const b3 = bottom[0];
    ctx.bezierCurveTo(b1.x, b1.y, b2.x, b2.y, b3.x, b3.y); ctx.closePath();
  };
  const gradient = ctx.createLinearGradient(animated[0].x, animated[0].y, animated[3].x, animated[3].y);
  gradient.addColorStop(0, first); gradient.addColorStop(.52, second); gradient.addColorStop(1, first);
  ctx.save(); ctx.globalAlpha = .78; path(); color(ctx, gradient as unknown as string); ctx.fill();
  ctx.globalAlpha = .42; ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(1, thickness * .06); ctx.stroke();
  // A restrained luminous edge gives the form depth without adding a noisy
  // field of particles or repeated circles.
  ctx.globalAlpha = .22; ctx.lineWidth = Math.max(1, thickness * .018); ctx.stroke(); ctx.restore();
};

function drawSilkThread(ctx: DrawContext, points: readonly Point[], phase: number, direction: FlowDirection, stroke: string, alpha: number) {
  const animated = points.map((point, index) => {
    const drift = 2 + Math.sin(phase) * .8; const offset = phase + index * 1.6;
    return { x: point.x + (direction === "vertical" ? Math.sin(offset) * drift : 0), y: point.y + (direction !== "vertical" ? Math.cos(offset) * drift : 0) };
  });
  ctx.save(); ctx.globalAlpha = alpha; ctx.beginPath(); ctx.moveTo(animated[0].x, animated[0].y); ctx.bezierCurveTo(animated[1].x, animated[1].y, animated[2].x, animated[2].y, animated[3].x, animated[3].y); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
}

export class AbstractPulseScene implements Scene {
  readonly id = "abstract-pulse" as const;
  constructor(private readonly assets: SceneAssets = {}, private readonly title = "", private readonly artist = "") {}
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const kind = aspect(width, height); const a = analysisAt(frame.analysis, frame.time); const pulse = Math.max(beatEnvelope(frame.analysis, frame.time), a.amplitude * .12); const short = Math.min(width, height);
    background(ctx, width, height, "#090b16", "#1c1a2c", kind === "portrait" ? .12 : .65); drawAsset(ctx, this.assets.backgroundImage, width, height, .1);
    const glow = ctx.createRadialGradient(width * .5, height * .5, short * .04, width * .5, height * .5, short * .75); glow.addColorStop(0, `rgba(107,92,144,${.14 + pulse * .1 + a.mid * .06})`); glow.addColorStop(.55, `rgba(39,36,76,${.08 + a.high * .06})`); glow.addColorStop(1, "rgba(8,9,18,0)"); color(ctx, glow as unknown as string); ctx.fillRect(0, 0, width, height);
    const drive = clamp(a.low * .72 + pulse * .28);
    if (kind === "landscape") {
      // Three horizontal silk arcs leave generous negative space above and
      // below the focal band. Only four controls define each silhouette.
      drawSilkRibbon(ctx, [{ x: width * .04, y: height * .58 }, { x: width * .3, y: height * .28 }, { x: width * .67, y: height * .75 }, { x: width * .96, y: height * .42 }], short * .045, drive, frame.time * .24, "horizontal", "rgba(111,92,157,.18)", "rgba(178,145,199,.5)", "rgba(216,190,221,.5)");
      drawSilkRibbon(ctx, [{ x: width * .03, y: height * .36 }, { x: width * .3, y: height * .7 }, { x: width * .7, y: height * .18 }, { x: width * .97, y: height * .53 }], short * .025, drive * .8, frame.time * .18 + 2, "horizontal", "rgba(57,77,125,.16)", "rgba(111,143,181,.32)", "rgba(155,176,204,.34)");
      drawSilkRibbon(ctx, [{ x: width * .1, y: height * .72 }, { x: width * .34, y: height * .59 }, { x: width * .65, y: height * .55 }, { x: width * .9, y: height * .25 }], short * .012, drive * .55, frame.time * .14 + 4, "horizontal", "rgba(137,83,92,.1)", "rgba(202,151,126,.3)", "rgba(223,184,157,.35)");
      drawSilkThread(ctx, [{ x: width * .05, y: height * .54 }, { x: width * .34, y: height * .23 }, { x: width * .68, y: height * .7 }, { x: width * .95, y: height * .4 }], frame.time * .2, "horizontal", "#dfc9dd", .42);
    } else if (kind === "portrait") {
      // Portrait is a vertical kinetic sculpture: the ribbons travel in
      // calm S-curves instead of being rotated horizontal strips.
      drawSilkRibbon(ctx, [{ x: width * .3, y: height * .04 }, { x: width * .78, y: height * .23 }, { x: width * .76, y: height * .54 }, { x: width * .34, y: height * .94 }], short * .06, drive, frame.time * .2, "vertical", "rgba(104,84,153,.17)", "rgba(177,143,201,.48)", "rgba(215,187,220,.46)");
      drawSilkRibbon(ctx, [{ x: width * .7, y: height * .08 }, { x: width * .2, y: height * .32 }, { x: width * .22, y: height * .65 }, { x: width * .67, y: height * .96 }], short * .034, drive * .85, frame.time * .16 + 2, "vertical", "rgba(52,73,123,.15)", "rgba(109,139,181,.35)", "rgba(153,177,207,.35)");
      drawSilkRibbon(ctx, [{ x: width * .48, y: height * .01 }, { x: width * .65, y: height * .31 }, { x: width * .39, y: height * .68 }, { x: width * .52, y: height * .99 }], short * .014, drive * .6, frame.time * .13 + 4, "vertical", "rgba(139,81,93,.1)", "rgba(201,150,126,.28)", "rgba(222,181,155,.33)");
      drawSilkThread(ctx, [{ x: width * .27, y: height * .03 }, { x: width * .76, y: height * .22 }, { x: width * .75, y: height * .55 }, { x: width * .35, y: height * .96 }], frame.time * .18, "vertical", "#dfc9dd", .4);
    } else {
      // Square uses two elegant diagonal arcs crossing a quiet central field.
      drawSilkRibbon(ctx, [{ x: width * .08, y: height * .74 }, { x: width * .18, y: height * .22 }, { x: width * .72, y: height * .12 }, { x: width * .92, y: height * .66 }], short * .052, drive, frame.time * .2, "diagonal", "rgba(102,82,151,.17)", "rgba(177,145,201,.46)", "rgba(215,188,220,.46)");
      drawSilkRibbon(ctx, [{ x: width * .06, y: height * .3 }, { x: width * .34, y: height * .75 }, { x: width * .72, y: height * .86 }, { x: width * .94, y: height * .24 }], short * .026, drive * .82, frame.time * .16 + 2, "diagonal", "rgba(50,71,119,.14)", "rgba(110,143,182,.34)", "rgba(153,177,207,.34)");
      drawSilkRibbon(ctx, [{ x: width * .17, y: height * .9 }, { x: width * .34, y: height * .56 }, { x: width * .6, y: height * .43 }, { x: width * .84, y: height * .08 }], short * .014, drive * .55, frame.time * .13 + 4, "diagonal", "rgba(139,81,93,.1)", "rgba(201,150,126,.28)", "rgba(222,181,155,.32)");
      drawSilkThread(ctx, [{ x: width * .09, y: height * .72 }, { x: width * .18, y: height * .21 }, { x: width * .72, y: height * .11 }, { x: width * .92, y: height * .64 }], frame.time * .18, "diagonal", "#dfc9dd", .4);
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
