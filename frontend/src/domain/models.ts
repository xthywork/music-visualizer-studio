/**
 * Serializable data shared by the editor, render worker and persistence layer.
 *
 * Deliberately do not add File, ArrayBuffer, AudioBuffer, object URLs, or any
 * other source-audio value to these types. Source audio belongs to the active
 * render session and is released when that session ends.
 */

export const DOMAIN_SCHEMA_VERSION = 1 as const;

export type DomainSchemaVersion = typeof DOMAIN_SCHEMA_VERSION;

export type TemplateId =
  | "spectrum-cover"
  | "vinyl-particle"
  | "abstract-pulse";

export type AspectRatio = "16:9" | "9:16" | "1:1";

export interface OutputDimensions {
  readonly width: number;
  readonly height: number;
}

export interface OutputConfiguration {
  readonly aspectRatio: AspectRatio;
  readonly width: number;
  readonly height: number;
  readonly frameRate: 24 | 25 | 30 | 50 | 60;
}

/** A browser-local image value which can safely be represented as JSON. */
export interface ImageReference {
  readonly kind: "data-url" | "url";
  readonly value: string;
  readonly alt?: string;
}

export interface TextConfiguration {
  readonly title: string;
  readonly artist: string;
}

/** Safe source identity only; no bytes, path, File, or handle is persisted. */
export interface RenderConfigurationV1 {
  readonly schemaVersion: DomainSchemaVersion;
  readonly templateId: TemplateId;
  readonly text: TextConfiguration;
  readonly coverImage?: ImageReference;
  readonly backgroundImage?: ImageReference;
  readonly output: OutputConfiguration;
}

export type RenderConfiguration = RenderConfigurationV1;

export type ProjectRenderStatus =
  | "queued"
  | "rendering"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface RenderError {
  readonly code: string;
  readonly message: string;
  readonly details?: string;
}

export interface OutputMetadata {
  readonly mimeType: "video/mp4";
  readonly byteLength: number;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly createdAt: string;
}

export interface RenderRecordV1 {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: string;
  readonly status: ProjectRenderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: RenderError;
  readonly output?: OutputMetadata;
}

export type RenderRecord = RenderRecordV1;

export interface ProjectRecordV1 {
  readonly schemaVersion: DomainSchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly configuration: RenderConfigurationV1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly renders: readonly RenderRecordV1[];
}

export type ProjectRecord = ProjectRecordV1;

export interface SerializableProjectState {
  readonly project: ProjectRecordV1;
  readonly renders: readonly RenderRecordV1[];
}

export function dimensionsForAspectRatio(
  aspectRatio: AspectRatio,
  longEdge: number,
): OutputDimensions {
  if (!Number.isFinite(longEdge) || longEdge <= 0) {
    throw new RangeError("longEdge must be a positive finite number");
  }

  switch (aspectRatio) {
    case "16:9":
      return { width: longEdge, height: Math.round((longEdge * 9) / 16) };
    case "9:16":
      return { width: Math.round((longEdge * 9) / 16), height: longEdge };
    case "1:1":
      return { width: longEdge, height: longEdge };
  }
}
