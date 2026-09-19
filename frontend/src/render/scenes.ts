import type { Scene, TemplateId, TemplateConfig } from "./types";
import { QuietEditorialScene } from "./quiet-editorial";
import { PaperResonanceScene } from "./paper-resonance";
import { LyricScene } from "./lyric-scenes";
import { InstrumentalScene } from "./instrumental-scenes";
import { CURRENT_TEMPLATE_IDS, defaultSettings, isLyricTemplate } from "../domain/template-settings";
import { validateLyrics } from "../domain/subtitles";

export interface SceneAssets { coverImage?: CanvasImageSource; backgroundImage?: CanvasImageSource; }
type SceneConfig = Omit<TemplateConfig, "id"> & { assets?: SceneAssets };
export function createScene(id: TemplateId, config: SceneConfig = {}): Scene {
  const assets = config.assets ?? {};
  const settings = config.settings ?? defaultSettings(id);
  if (id === "night-orbit" || id === "dawn-spectrum") return new InstrumentalScene(id, config.title, config.artist, assets, settings);
  if (id === "quiet-editorial") return new QuietEditorialScene(config.title, config.artist, assets, settings);
  if (id === "paper-resonance") return new PaperResonanceScene(config.title, config.artist, assets, settings);
  return new LyricScene(id, config.title, config.artist, assets, config.lyrics ?? [], settings);
}
async function decodeImageAsset(source?: string): Promise<ImageBitmap | undefined> {
  if (!source || typeof fetch !== "function" || typeof createImageBitmap !== "function") return undefined;
  try { return await createImageBitmap(await (await fetch(source)).blob()); } catch { return undefined; }
}
export async function createSceneAsync(id: TemplateId, config: Omit<SceneConfig, "assets"> = {}): Promise<Scene> {
  if (isLyricTemplate(id)) {
    if (!config.lyrics?.length) throw new Error("字幕模板需要先匯入 SRT 字幕。");
    validateLyrics(config.lyrics);
  }
  const [coverImage, backgroundImage] = await Promise.all([decodeImageAsset(config.coverImage), decodeImageAsset(config.backgroundImage)]);
  return createScene(id, { ...config, assets: { coverImage, backgroundImage } });
}
export function disposeScene(scene: Scene) { scene.dispose?.(); }
export const TEMPLATE_IDS = CURRENT_TEMPLATE_IDS;
