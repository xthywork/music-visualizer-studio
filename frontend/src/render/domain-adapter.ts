import type { ImageReference, RenderConfigurationV1 } from "../domain/models";
import type { AspectRatio, RenderConfig, Resolution, TemplateId } from "./types";

function resolutionFromDimensions(width: number, height: number): Resolution {
  // Preset labels are defined by the short edge for landscape/portrait and
  // by either edge for square output. Using the long edge misclassified
  // 1280x720 and 720x1280 as 1080p.
  const baseEdge = Math.min(width, height);
  if (baseEdge >= 2160) return "4k";
  if (baseEdge >= 1440) return "1440p";
  if (baseEdge >= 1080) return "1080p";
  return "720p";
}

/** Converts the application's domain model to the renderer's portable worker snapshot. */
export function renderConfigFromDomain(config: RenderConfigurationV1): RenderConfig {
  return {
    schemaVersion: 1,
    template: {
      id: config.templateId as TemplateId,
      title: config.text.title,
      artist: config.text.artist,
      coverImage: config.coverImage?.value,
      backgroundImage: config.backgroundImage?.value,
    },
    output: {
      aspectRatio: config.output.aspectRatio as AspectRatio,
      resolution: resolutionFromDimensions(config.output.width, config.output.height),
      frameRate: config.output.frameRate,
    },
  };
}

function imageReference(value: string | undefined): ImageReference | undefined {
  return value ? { kind: value.startsWith("data:") ? "data-url" : "url", value } : undefined;
}

/** Converts a portable render snapshot back to the persisted domain configuration. */
export function renderConfigToDomain(config: RenderConfig): RenderConfigurationV1 {
  const widthHeight = dimensionsForDomain(config.output.aspectRatio, config.output.resolution);
  return {
    schemaVersion: 1,
    templateId: config.template.id,
    text: { title: config.template.title ?? "", artist: config.template.artist ?? "" },
    coverImage: imageReference(config.template.coverImage),
    backgroundImage: imageReference(config.template.backgroundImage),
    output: { aspectRatio: config.output.aspectRatio, width: widthHeight.width, height: widthHeight.height, frameRate: config.output.frameRate },
  };
}

function dimensionsForDomain(aspect: AspectRatio, resolution: Resolution): { width: number; height: number } {
  const base = resolution === "720p" ? 720 : resolution === "1080p" ? 1080 : resolution === "1440p" ? 1440 : 2160;
  if (aspect === "16:9") return { width: Math.round(base * 16 / 9), height: base };
  if (aspect === "9:16") return { width: base, height: Math.round(base * 16 / 9) };
  return { width: base, height: base };
}
