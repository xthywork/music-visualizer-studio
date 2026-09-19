import type { LyricCue } from "./models";

export const MAX_SRT_BYTES = 1024 * 1024;
export const MAX_CUES = 5000;
export function validateLyrics(value: unknown): LyricCue[] {
  if (!Array.isArray(value) || value.length > MAX_CUES) throw new Error("字幕最多支援 5000 句");
  let previous = -1;
  return value.map(cue => {
    if (!cue || typeof cue.start !== "number" || !Number.isFinite(cue.start) || cue.start < 0 || cue.start > 86400 || cue.start <= previous || typeof cue.text !== "string" || !cue.text.trim() || cue.text.length > 1000) throw new Error("字幕時間或文字格式無效");
    previous = cue.start;
    return { start: cue.start, text: cue.text };
  });
}
export function parseSrt(source: string): LyricCue[] {
  if (source.length > MAX_SRT_BYTES) throw new Error("SRT 檔案不可超過 1 MB");
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("字幕檔案是空的");
  const cues: LyricCue[] = [];
  for (const block of normalized.split(/\n[ \t]*\n+/)) {
    const lines = block.split("\n");
    if (/^\d+\s*$/.test(lines[0])) lines.shift();
    const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})\s*-->\s*\d{2,}:[0-5]\d:[0-5]\d[,.]\d{3}(?:\s.*)?$/.exec(lines.shift()?.trim() ?? "");
    if (!match) throw new Error(`第 ${cues.length + 1} 段字幕的時間格式無效`);
    const text = lines.join("\n").replace(/<[^>]*>/g, "").trim();
    if (!text) throw new Error("字幕段落缺少文字");
    const start = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
    cues.push({ start, text });
    if (cues.length > MAX_CUES) throw new Error("字幕最多支援 5000 句");
  }
  cues.sort((a, b) => a.start - b.start);
  const merged: LyricCue[] = [];
  for (const cue of cues) {
    const last = merged.at(-1);
    if (last?.start === cue.start) merged[merged.length - 1] = { start: cue.start, text: `${last.text}\n${cue.text}` };
    else merged.push(cue);
  }
  return validateLyrics(merged);
}
/** Latest start wins, regardless of the SRT end timestamp. */
export function activeLyric(cues: readonly LyricCue[], time: number): number {
  let lo = 0; let hi = cues.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cues[mid].start <= time) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
/** Reserve enough time to finish each move before the next start, including dense cues. */
export function lyricScroll(cues: readonly LyricCue[], time: number) {
  const index = activeLyric(cues, time);
  if (index < 0) return { index, position: -1 };
  const previousGap = index ? cues[index].start - cues[index - 1].start : 1;
  const nextGap = cues[index + 1] ? cues[index + 1].start - cues[index].start : 1;
  const duration = Math.min(.45, previousGap * .45, nextGap * .45);
  const p = Math.min(1, Math.max(0, (time - cues[index].start) / duration));
  return { index, position: index - 1 + (1 - (1 - p) ** 3) };
}
