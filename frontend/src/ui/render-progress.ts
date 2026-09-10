export function renderProgressMessage(frame: number, totalFrames: number, etaMs?: number): string {
  const progress = `正在渲染第 ${frame}/${totalFrames} 幀`;
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return progress;
  if (etaMs >= 60_000) return `長時間渲染中 · ${progress} · 約剩 ${Math.max(1, Math.ceil(etaMs / 60_000))} 分鐘`;
  return `${progress} · 約剩 ${Math.max(1, Math.ceil(etaMs / 1_000))} 秒`;
}
