export const MAX_AUDIO_SECONDS = 10 * 60;
export const ACCEPTED_AUDIO_EXTENSIONS = ["mp3", "wav", "m4a"] as const;
export const ACCEPTED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
] as const;

export type AspectRatio = "16:9" | "9:16" | "1:1";
export type TemplateId = "spectrum-cover" | "vinyl-particle" | "abstract-pulse";

export interface OutputPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  aspectRatio: AspectRatio;
}

export const OUTPUT_PRESETS: Record<AspectRatio, OutputPreset[]> = {
  "16:9": [
    { id: "16-9-720p", label: "HD 720p", width: 1280, height: 720, aspectRatio: "16:9" },
    { id: "16-9-1080p", label: "Full HD 1080p", width: 1920, height: 1080, aspectRatio: "16:9" },
    { id: "16-9-4k", label: "4K UHD", width: 3840, height: 2160, aspectRatio: "16:9" },
  ],
  "9:16": [
    { id: "9-16-720p", label: "HD 720p", width: 720, height: 1280, aspectRatio: "9:16" },
    { id: "9-16-1080p", label: "Full HD 1080p", width: 1080, height: 1920, aspectRatio: "9:16" },
    { id: "9-16-4k", label: "4K UHD", width: 2160, height: 3840, aspectRatio: "9:16" },
  ],
  "1:1": [
    { id: "1-1-720p", label: "HD 720", width: 720, height: 720, aspectRatio: "1:1" },
    { id: "1-1-1080p", label: "Full HD 1080", width: 1080, height: 1080, aspectRatio: "1:1" },
    { id: "1-1-4k", label: "4K Square", width: 2160, height: 2160, aspectRatio: "1:1" },
  ],
};

export const FRAME_RATES = [30, 60] as const;

export const TEMPLATES: Array<{ id: TemplateId; name: string; description: string; accent: string }> = [
  {
    id: "spectrum-cover",
    name: "Spectrum Cover",
    description: "極簡封面與細緻音訊頻譜",
    accent: "#64f0d0",
  },
  {
    id: "vinyl-particle",
    name: "Vinyl Particle",
    description: "旋轉唱片與節拍粒子",
    accent: "#ff7a9c",
  },
  {
    id: "abstract-pulse",
    name: "Abstract Pulse",
    description: "全螢幕漸層、波形與脈衝",
    accent: "#8d82ff",
  },
];

export function fileExtension(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

export function validateAudioFile(file: Pick<File, "name" | "type" | "size">): string | null {
  const extension = fileExtension(file.name);
  const acceptedExtension = ACCEPTED_AUDIO_EXTENSIONS.includes(
    extension as (typeof ACCEPTED_AUDIO_EXTENSIONS)[number],
  );
  const acceptedType = !file.type || ACCEPTED_AUDIO_TYPES.includes(file.type as (typeof ACCEPTED_AUDIO_TYPES)[number]);
  if (!acceptedExtension || !acceptedType) return "僅支援 MP3、WAV 或 M4A 音訊。";
  if (file.size === 0) return "音訊檔案是空的。";
  return null;
}

export function validateAudioDuration(durationSeconds: number): string | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return "無法讀取音訊長度。";
  if (durationSeconds > MAX_AUDIO_SECONDS) return "音訊最長支援 10 分鐘。";
  return null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
