import { frameCount, type RenderConfig } from "./types";

export function createRenderTiming(config: RenderConfig, duration: number) {
  const totalFrames = frameCount(duration, config.output.frameRate);
  return { totalFrames, frameDuration: 1_000_000 / config.output.frameRate, secondsPerFrame: 1 / config.output.frameRate };
}
