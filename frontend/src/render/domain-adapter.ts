import type { ImageReference, RenderConfigurationV1 } from "../domain/models";
import { dimensionsFor, type RenderConfig, type Resolution } from "./types";

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
      id: config.templateId,
      title: config.text.title,
      artist: config.text.artist,
      coverImage: config.coverImage?.value,
      backgroundImage: config.backgroundImage?.value,
    },
    output: {
      aspectRatio: config.output.aspectRatio,
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
  const widthHeight = dimensionsFor(config.output);
  return {
    schemaVersion: 1,
    templateId: config.template.id,
    text: { title: config.template.title ?? "", artist: config.template.artist ?? "" },
    coverImage: imageReference(config.template.coverImage),
    backgroundImage: imageReference(config.template.backgroundImage),
    output: { aspectRatio: config.output.aspectRatio, width: widthHeight.width, height: widthHeight.height, frameRate: config.output.frameRate },
  };
}
