import { createScene } from "./scenes";
import { analyzeAudioBytes } from "./audio-analysis";
import { dimensionsFor, frameCount, type AudioAnalysis, type RenderConfig, type Scene } from "./types";

export interface RenderFrame { frame: number; timestamp: number; duration: number; bitmap?: ImageBitmap; }

export function createRenderTiming(config: RenderConfig, duration: number) {
  const totalFrames = frameCount(duration, config.output.frameRate);
  return { totalFrames, frameDuration: 1_000_000 / config.output.frameRate, secondsPerFrame: 1 / config.output.frameRate };
}

export function renderFrame(canvas: OffscreenCanvas | HTMLCanvasElement, scene: Scene, analysis: AudioAnalysis, frame: number, config: RenderConfig): void {
  const { width, height } = dimensionsFor(config.output); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("A 2D canvas context is required for rendering.");
  const total = frameCount(analysis.duration, config.output.frameRate); const progress = frame / Math.max(1, total - 1);
  scene.render(ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, { time: frame / config.output.frameRate, frame, progress, width, height, analysis });
}

export async function* renderFrames(canvas: OffscreenCanvas | HTMLCanvasElement, config: RenderConfig, audio: ArrayBuffer, scene: Scene = createScene(config.template.id, config.template)): AsyncGenerator<RenderFrame> {
  const analysis = await analyzeAudioBytes(audio);
  const timing = createRenderTiming(config, analysis.duration);
  for (let frame = 0; frame < timing.totalFrames; frame++) {
    renderFrame(canvas, scene, analysis, frame, config);
    let bitmap: ImageBitmap | undefined;
    if ("transferToImageBitmap" in canvas) bitmap = (canvas as OffscreenCanvas).transferToImageBitmap();
    yield { frame, timestamp: frame * timing.frameDuration, duration: timing.frameDuration, bitmap };
  }
}
