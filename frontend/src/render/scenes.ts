import type { Scene, SceneFrameContext, TemplateId } from "./types";
import { analysisAt } from "./audio-analysis";

type DrawContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface SceneAssets { coverImage?: ImageBitmap; backgroundImage?: ImageBitmap; }

function drawAsset(ctx: DrawContext, image: ImageBitmap | undefined, width: number, height: number, alpha = 1) {
  if (!image || typeof (ctx as any).drawImage !== "function") return;
  ctx.save(); ctx.globalAlpha = alpha; (ctx as any).drawImage(image, 0, 0, width, height); ctx.restore();
}
function disposeAssets(assets: SceneAssets) { assets.coverImage?.close(); assets.backgroundImage?.close(); }

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

/** A deterministic impulse with a short attack and a long, soft release. */
function beatEnvelope(analysis: SceneFrameContext["analysis"], time: number): number {
  let envelope = 0;
  for (let index = 0; index < analysis.beats.length; index++) {
    const delta = time - analysis.beats[index];
    if (delta < 0 || delta > 2.8) continue;
    const attack = .045;
    const value = delta < attack ? delta / attack : Math.exp(-(delta - attack) / 1.05);
    envelope = Math.max(envelope, value);
  }
  return envelope;
}

export class SpectrumCoverScene implements Scene {
  readonly id = "spectrum-cover" as const;
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const signal = analysisAt(frame.analysis, frame.time);
    background(ctx, width, height, "#120c2c", "#25145b", 0.35);
    const cx = width / 2; const cy = height * 0.42; const radius = Math.min(width, height) * 0.25;
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius * 1.8);
    glow.addColorStop(0, `rgba(118, 91, 255, ${0.38 + signal.beat * 0.2})`); glow.addColorStop(1, "rgba(30,10,70,0)");
    color(ctx, glow as unknown as string); ctx.fillRect(0, 0, width, height);
    ctx.beginPath(); ctx.arc(cx, cy, radius * (1 + signal.beat * 0.07), 0, Math.PI * 2); color(ctx, "rgba(8,7,25,.72)"); ctx.fill();
    // Rotating spectrum rays and a waveform orbit make motion visible even when
    // the source has a quiet section. Their values remain entirely audio/time based.
    const spectrumLength = frame.analysis.spectrum.length;
    const bars = Math.min(72, spectrumLength);
    const phase = frame.time * .62;
    ctx.strokeStyle = "#7cf7ff";
    for (let i = 0; i < bars; i++) {
      const v = frame.analysis.spectrum[i % spectrumLength] ?? 0; const a = i / bars * Math.PI * 2 + phase;
      const inner = radius * 1.08; const outer = inner + radius * (0.12 + v * 0.78 + signal.beat * 0.2);
      ctx.lineWidth = Math.max(1, width / 300); ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner); ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer); ctx.stroke();
    }
    ctx.beginPath();
    const waveformLength = frame.analysis.waveform.length;
    const orbitPoints = Math.min(256, waveformLength);
    for (let i = 0; i < orbitPoints; i++) {
      const angle = i / orbitPoints * Math.PI * 2 + phase * .35;
      const waveform = frame.analysis.waveform[i % waveformLength] ?? 0;
      const orbit = radius * (1.16 + waveform * .16 + signal.beat * .09);
      const x = cx + Math.cos(angle) * orbit; const y = cy + Math.sin(angle) * orbit;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.strokeStyle = "rgba(124,247,255,.72)"; ctx.lineWidth = Math.max(1, width / 260); ctx.stroke();
    ctx.lineWidth = Math.max(1, width / 240); ctx.beginPath();
    const points = Math.min(512, frame.analysis.waveform.length);
    for (let i = 0; i < points; i++) { const x = width * i / Math.max(1, points - 1); const value = frame.analysis.waveform[(i + Math.floor(frame.time * 8)) % frame.analysis.waveform.length] ?? 0; const y = height * 0.78 + (value - .5) * height * .18; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = "rgba(255,255,255,.78)"; ctx.stroke();
    ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = `600 ${Math.max(14, Math.round(height * .042))}px system-ui, sans-serif`;
    ctx.fillText(fitText(ctx, frame.analysis ? "" : "", width * .8), cx, height * .88);
    // Text is set by the scene factory, keeping the scene itself serializable.
  }
}

export class ConfiguredSpectrumCoverScene extends SpectrumCoverScene {
  constructor(private readonly title = "", private readonly artist = "", private readonly assets: SceneAssets = {}) { super(); }
  render(ctx: DrawContext, frame: SceneFrameContext) {
    super.render(ctx, frame); const { width, height } = frame;
    drawAsset(ctx, this.assets.backgroundImage, width, height, .22);
    if (this.assets.coverImage) {
      const size = Math.min(width, height) * .5;
      ctx.save(); ctx.globalAlpha = .82;
      (ctx as any).drawImage(this.assets.coverImage, width / 2 - size / 2, height * .42 - size / 2, size, size);
      ctx.restore();
    }
    ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = `600 ${Math.max(14, Math.round(height * .042))}px system-ui, sans-serif`;
    ctx.fillText(fitText(ctx, this.title, width * .8), width / 2, height * .86);
    ctx.font = `400 ${Math.max(10, Math.round(height * .022))}px system-ui, sans-serif`; ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.fillText(fitText(ctx, this.artist, width * .72), width / 2, height * .91);
  }
  dispose() { disposeAssets(this.assets); }
}

export class VinylParticleScene implements Scene {
  readonly id = "vinyl-particle" as const;
  constructor(private readonly assets: SceneAssets = {}) {}
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const a = analysisAt(frame.analysis, frame.time); const cx = width / 2; const cy = height / 2;
    background(ctx, width, height, "#060b14", "#172d36", 1.2);
    drawAsset(ctx, this.assets.backgroundImage, width, height, .18);
    const radius = Math.min(width, height) * (.28 + a.amplitude * .035 + a.beat * .04);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(frame.time * .12); ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); color(ctx, "#0c0e13"); ctx.fill();
    for (let i = 1; i < 7; i++) { ctx.beginPath(); ctx.arc(0, 0, radius * i / 7, 0, Math.PI * 2); ctx.strokeStyle = `rgba(120,140,150,${.12 + i * .015})`; ctx.lineWidth = 1; ctx.stroke(); }
    const labelRadius = radius * .36;
    ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, Math.PI * 2); color(ctx, "#e76058"); ctx.fill();
    if (this.assets.coverImage) {
      // Clip the cover to the label so all image sources (including square data
      // URLs and ImageBitmaps decoded in the worker) land reliably at the center.
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, labelRadius, 0, Math.PI * 2); ctx.clip();
      (ctx as any).drawImage(this.assets.coverImage, -labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2); ctx.restore();
    }
    ctx.beginPath(); ctx.arc(0, 0, radius * .035, 0, Math.PI * 2); color(ctx, "#f4d6b0"); ctx.fill(); ctx.restore();
    const count = 112;
    for (let i = 0; i < count; i++) {
      const baseAngle = i * 2.399963; const speed = .022 + (i % 7) * .003;
      const angle = baseAngle + frame.time * speed; const orbit = radius * (1.28 + (i * 17 % 100) / 100 * 1.15 + Math.sin(frame.time * .42 + i * .71) * .08); const pulse = 1 + a.spectrum * .24 + a.beat * .38;
      const x = cx + Math.cos(angle) * orbit * pulse; const y = cy + Math.sin(angle) * orbit * pulse;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1, width / 500 * (1 + i % 4 / 3)), 0, Math.PI * 2); ctx.fillStyle = `hsla(${175 + i % 80}, 85%, ${58 + i % 20}%, ${.35 + (i % 4) * .12})`; ctx.fill();
    }
  }
  dispose() { disposeAssets(this.assets); }
}

export class AbstractPulseScene implements Scene {
  readonly id = "abstract-pulse" as const;
  constructor(private readonly assets: SceneAssets = {}) {}
  render(ctx: DrawContext, frame: SceneFrameContext) {
    const { width, height } = frame; const a = analysisAt(frame.analysis, frame.time); const cx = width / 2; const cy = height / 2;
    background(ctx, width, height, "#03030b", "#181035", .7);
    drawAsset(ctx, this.assets.backgroundImage, width, height, .2);
    const pulse = beatEnvelope(frame.analysis, frame.time);
    const rings = 7;
    for (let ring = rings; ring > 0; ring--) {
      const slowMotion = Math.sin(frame.time * 1.15 + ring * .72) * .012;
      const radius = Math.min(width, height) * (.14 + ring * .085 + a.amplitude * .06 + pulse * (.08 + ring * .012) + slowMotion);
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.lineWidth = Math.max(2, width / 220); ctx.strokeStyle = `hsla(${254 + ring * 8}, 94%, ${58 + ring * 3}%, ${.22 + pulse * .34})`; ctx.stroke();
    }
    ctx.beginPath(); const samples = Math.min(512, frame.analysis.waveform.length);
    for (let i = 0; i < samples; i++) { const angle = i / samples * Math.PI * 2 + frame.time * .08; const waveform = (frame.analysis.waveform[i] ?? 0) - .5; const r = Math.min(width, height) * (.39 + waveform * .16 + a.amplitude * .08 + pulse * .18); const x = cx + Math.cos(angle) * r; const y = cy + Math.sin(angle) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.strokeStyle = "#b995ff"; ctx.lineWidth = Math.max(2, width / 170); ctx.stroke();
  }
  dispose() { disposeAssets(this.assets); }
}

export function createScene(id: TemplateId, config: { title?: string; artist?: string } = {}): Scene {
  if (id === "spectrum-cover") return new ConfiguredSpectrumCoverScene(config.title, config.artist);
  if (id === "vinyl-particle") return new VinylParticleScene();
  return new AbstractPulseScene();
}

async function decodeImageAsset(source: string | undefined): Promise<ImageBitmap | undefined> {
  if (!source || typeof fetch !== "function" || typeof createImageBitmap !== "function") return undefined;
  try { return await createImageBitmap(await (await fetch(source)).blob()); } catch { return undefined; }
}

/** Optional image treatment without changing the worker message protocol; assets remain transient. */
export async function createSceneAsync(id: TemplateId, config: { title?: string; artist?: string; coverImage?: string; backgroundImage?: string } = {}): Promise<Scene> {
  const [coverImage, backgroundImage] = await Promise.all([decodeImageAsset(config.coverImage), decodeImageAsset(config.backgroundImage)]);
  const assets = { coverImage, backgroundImage };
  if (id === "spectrum-cover") return new ConfiguredSpectrumCoverScene(config.title, config.artist, assets);
  if (id === "vinyl-particle") return new VinylParticleScene(assets);
  return new AbstractPulseScene(assets);
}

export function disposeScene(scene: Scene) { scene.dispose?.(); }

export const TEMPLATE_IDS: readonly TemplateId[] = ["spectrum-cover", "vinyl-particle", "abstract-pulse"];
