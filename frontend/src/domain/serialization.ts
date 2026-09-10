import {
  DOMAIN_SCHEMA_VERSION,
  type ImageReference,
  type ProjectRecord,
  type RenderConfiguration,
  type RenderError,
  type RenderRecord,
  type TemplateId,
} from "./models";

export class DomainSerializationError extends Error {
  override readonly name = "DomainSerializationError";
}

const templateIds: ReadonlySet<TemplateId> = new Set([
  "spectrum-cover",
  "vinyl-particle",
  "abstract-pulse",
]);
const aspectRatios = new Set(["16:9", "9:16", "1:1"]);
const frameRates = new Set([24, 25, 30, 50, 60]);
const renderStatuses = new Set([
  "queued",
  "rendering",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);

function fail(message: string): never {
  throw new DomainSerializationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") return fail(`${label} must be a string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label);
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fail(`${label} must be a positive finite number`);
  }
  return value;
}

function imageReference(value: unknown, label: string): ImageReference | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  if (input.kind !== "data-url" && input.kind !== "url") {
    return fail(`${label}.kind is invalid`);
  }
  const alt = optionalString(input.alt, `${label}.alt`);
  return {
    kind: input.kind,
    value: stringValue(input.value, `${label}.value`),
    ...(alt === undefined ? {} : { alt }),
  };
}

function configuration(value: unknown): RenderConfiguration {
  const input = object(value, "configuration");
  if (input.schemaVersion !== DOMAIN_SCHEMA_VERSION) {
    return fail("configuration.schemaVersion is unsupported");
  }
  if (!templateIds.has(input.templateId as TemplateId)) {
    return fail("configuration.templateId is invalid");
  }
  const text = object(input.text, "configuration.text");
  const output = object(input.output, "configuration.output");
  if (!aspectRatios.has(output.aspectRatio as string)) {
    return fail("configuration.output.aspectRatio is invalid");
  }
  if (typeof output.frameRate !== "number" || !frameRates.has(output.frameRate)) {
    return fail("configuration.output.frameRate is invalid");
  }
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    templateId: input.templateId as TemplateId,
    text: {
      title: stringValue(text.title, "configuration.text.title"),
      artist: stringValue(text.artist, "configuration.text.artist"),
    },
    ...(imageReference(input.coverImage, "configuration.coverImage")
      ? { coverImage: imageReference(input.coverImage, "configuration.coverImage") }
      : {}),
    ...(imageReference(input.backgroundImage, "configuration.backgroundImage")
      ? { backgroundImage: imageReference(input.backgroundImage, "configuration.backgroundImage") }
      : {}),
    output: {
      aspectRatio: output.aspectRatio as RenderConfiguration["output"]["aspectRatio"],
      width: positiveNumber(output.width, "configuration.output.width"),
      height: positiveNumber(output.height, "configuration.output.height"),
      frameRate: output.frameRate as RenderConfiguration["output"]["frameRate"],
    },
  };
}

function renderError(value: unknown): RenderError | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "render.error");
  const details = optionalString(input.details, "render.error.details");
  return {
    code: stringValue(input.code, "render.error.code"),
    message: stringValue(input.message, "render.error.message"),
    ...(details === undefined ? {} : { details }),
  };
}

function renderRecord(value: unknown): RenderRecord {
  const input = object(value, "render");
  if (input.schemaVersion !== DOMAIN_SCHEMA_VERSION) {
    return fail("render.schemaVersion is unsupported");
  }
  const output = input.output === undefined ? undefined : object(input.output, "render.output");
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: stringValue(input.id, "render.id"),
    status: renderStatuses.has(input.status as string)
      ? (input.status as RenderRecord["status"])
      : fail("render.status is invalid"),
    createdAt: stringValue(input.createdAt, "render.createdAt"),
    updatedAt: stringValue(input.updatedAt, "render.updatedAt"),
    ...(input.startedAt === undefined ? {} : { startedAt: stringValue(input.startedAt, "render.startedAt") }),
    ...(input.completedAt === undefined ? {} : { completedAt: stringValue(input.completedAt, "render.completedAt") }),
    ...(renderError(input.error) ? { error: renderError(input.error) } : {}),
    ...(output
      ? {
          output: {
            mimeType: "video/mp4",
            byteLength: positiveNumber(output.byteLength, "render.output.byteLength"),
            durationMs: positiveNumber(output.durationMs, "render.output.durationMs"),
            width: positiveNumber(output.width, "render.output.width"),
            height: positiveNumber(output.height, "render.output.height"),
            frameRate: positiveNumber(output.frameRate, "render.output.frameRate"),
            createdAt: stringValue(output.createdAt, "render.output.createdAt"),
          },
        }
      : {}),
  };
}

/**
 * Serialize by selecting known fields. This is intentionally a whitelist:
 * accidental `audio`, `sourceAudio`, or `audioFile` properties are discarded.
 */
export function serializeConfiguration(configurationValue: RenderConfiguration): string {
  const configurationValueChecked = configuration(configurationValue);
  return JSON.stringify(configurationValueChecked);
}

export function deserializeConfiguration(serialized: string): RenderConfiguration {
  try {
    return configuration(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof DomainSerializationError) throw error;
    throw new DomainSerializationError("configuration is not valid JSON");
  }
}

export function serializeRenderRecord(render: RenderRecord): string {
  return JSON.stringify(renderRecord(render));
}

export function deserializeRenderRecord(serialized: string): RenderRecord {
  try {
    return renderRecord(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof DomainSerializationError) throw error;
    throw new DomainSerializationError("render is not valid JSON");
  }
}

export function serializeProject(projectValue: ProjectRecord): string {
  const project = object(projectValue, "project");
  if (project.schemaVersion !== DOMAIN_SCHEMA_VERSION) fail("project.schemaVersion is unsupported");
  const renders = Array.isArray(project.renders) ? project.renders.map(renderRecord) : fail("project.renders must be an array");
  return JSON.stringify({
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: stringValue(project.id, "project.id"),
    name: stringValue(project.name, "project.name"),
    configuration: configuration(project.configuration),
    createdAt: stringValue(project.createdAt, "project.createdAt"),
    updatedAt: stringValue(project.updatedAt, "project.updatedAt"),
    renders,
  });
}

export function deserializeProject(serialized: string): ProjectRecord {
  try {
    const project = object(JSON.parse(serialized), "project");
    if (!Array.isArray(project.renders)) fail("project.renders must be an array");
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: stringValue(project.id, "project.id"),
      name: stringValue(project.name, "project.name"),
      configuration: configuration(project.configuration),
      createdAt: stringValue(project.createdAt, "project.createdAt"),
      updatedAt: stringValue(project.updatedAt, "project.updatedAt"),
      renders: project.renders.map(renderRecord),
    };
  } catch (error) {
    if (error instanceof DomainSerializationError) throw error;
    throw new DomainSerializationError("project is not valid JSON");
  }
}
