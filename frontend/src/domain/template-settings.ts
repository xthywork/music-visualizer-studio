import type { TemplateId, TemplateSettings, TemplateSettingsMap } from "./models";

export const CURRENT_TEMPLATE_IDS: readonly TemplateId[] = ["quiet-editorial", "paper-resonance", "panorama-lyrics", "poetry-lyrics", "night-orbit", "dawn-spectrum"];
export function isLyricTemplate(id: TemplateId) { return id === "panorama-lyrics" || id === "poetry-lyrics"; }
export const PALETTES = {
  custom: { name: "原作／自訂強調色", colors: [] as string[] },
  earth: { name: "陶土・橄欖", colors: ["#b96046", "#87966a", "#bda87e"] },
  coast: { name: "海岸・霧藍", colors: ["#649ca8", "#8aabc2", "#c0b49b"] },
  plum: { name: "暮色・梅紫", colors: ["#ac7897", "#8b87b3", "#caa590"] },
  forest: { name: "苔蘚・琥珀", colors: ["#789c84", "#ba9c58", "#9ca895"] },
  rose: { name: "玫瑰・墨灰", colors: ["#c38383", "#92959b", "#b7a39b"] },
};
export function lineColors(settings: TemplateSettings) { const colors = PALETTES[settings.palette as keyof typeof PALETTES]?.colors; return colors?.length ? colors : [settings.accent, settings.theme === "dark" ? "#bbc8bc" : "#444b44", "#8b8a7b"]; }
export const SETTING_RANGES = { motion: [0, 5], background: [.2, 1], coverScale: [.65, 1], coverX: [-50, 50], coverY: [-50, 50], imageWidth: [10, 100], imageZoom: [1, 3], imageX: [-100, 100], imageY: [-100, 100], lineCount: [1, 8], lyricSize: [.8, 1.3], lineGap: [1.5, 2.3], fade: [.15, .65] } as const;
export function defaultSettings(id: TemplateId): TemplateSettings {
  if (id === "night-orbit" || id === "dawn-spectrum") return { ...defaultSettings("quiet-editorial"), theme: id === "night-orbit" ? "dark" : "light", accent: id === "night-orbit" ? "#8bbab8" : "#b77956" };
  return { theme: id === "paper-resonance" || id === "poetry-lyrics" ? "light" : "dark", accent: id === "paper-resonance" ? "#b84330" : id === "poetry-lyrics" ? "#8b735b" : "#c9b99c", motion: 1, background: 1, coverScale: 1, coverX: 0, coverY: 0, imageWidth: id === "poetry-lyrics" ? 24 : 100, imageZoom: 1, imageX: 0, imageY: 0, lineCount: id === "paper-resonance" ? 3 : 1, palette: "custom", lyricSize: 1, lineGap: 1.8, fade: .4 };
}
export function validateSettings(value: unknown, id: TemplateId): TemplateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("無效的模板設定");
  const input = value as Record<string, unknown>;
  const result = defaultSettings(id);
  if (input.palette !== undefined) {
    if (typeof input.palette !== "string" || !Object.hasOwn(PALETTES, input.palette)) throw new Error("無效的色卡");
    result.palette = input.palette;
  }
  if (input.theme !== undefined) {
    if (input.theme !== "light" && input.theme !== "dark") throw new Error("無效的明暗模式");
    result.theme = input.theme;
  }
  if (input.accent !== undefined) {
    if (typeof input.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(input.accent)) throw new Error("無效的強調色");
    result.accent = input.accent;
  }
  for (const key of Object.keys(SETTING_RANGES) as (keyof typeof SETTING_RANGES)[]) {
    const v = input[key]; const [min, max] = SETTING_RANGES[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`無效的模板設定：${key}`);
    result[key] = v;
  }
  if (!Number.isInteger(result.lineCount)) throw new Error("線條數量必須為整數");
  if (id === "poetry-lyrics" && result.imageWidth > 60) throw new Error("詩頁影像區域寬度上限為 60%");
  return result;
}
export function validateSettingsMap(value: unknown): TemplateSettingsMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("無效的模板設定");
  const input = value as Record<string, unknown>;
  const result: TemplateSettingsMap = {};
  for (const id of CURRENT_TEMPLATE_IDS) if (input[id] !== undefined) result[id] = validateSettings(input[id], id);
  if (!result["poetry-lyrics"] && input["geometry-lyrics"] !== undefined) result["poetry-lyrics"] = validateSettings(input["geometry-lyrics"], "poetry-lyrics");
  return result;
}
