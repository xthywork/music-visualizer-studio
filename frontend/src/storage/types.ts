import type { OutputMetadata, ProjectRecord, RenderRecord } from "../domain";

export const STORAGE_SCHEMA_VERSION = 1 as const;

export interface StoredOutput {
  readonly id: string;
  readonly projectId: string;
  readonly renderId: string;
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly blob: Blob;
  readonly metadata: OutputMetadata;
}

export interface StorageEstimate {
  readonly usageBytes?: number;
  readonly quotaBytes?: number;
  readonly availableBytes?: number;
}

export class StorageError extends Error {
  override readonly name: string = "StorageError";
}

export class StorageQuotaError extends StorageError {
  override readonly name: string = "StorageQuotaError";
  readonly cause: unknown;

  constructor(message = "Browser storage quota exceeded", cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export interface ProjectStorage {
  listProjects(): Promise<readonly ProjectRecord[]>;
  getProject(projectId: string): Promise<ProjectRecord | undefined>;
  saveProject(project: ProjectRecord): Promise<void>;
  deleteProject(projectId: string): Promise<void>;

  saveOutput(output: StoredOutput): Promise<void>;
  getOutput(projectId: string, renderId: string): Promise<StoredOutput | undefined>;
  deleteOutput(projectId: string, renderId: string): Promise<void>;

  estimateQuota(): Promise<StorageEstimate>;
  reconcileActiveRenders(now?: string): Promise<readonly ProjectRecord[]>;
}

export function outputId(projectId: string, renderId: string): string {
  return `${projectId}:${renderId}`;
}

/** Whitelist the persisted output shape so transient fields cannot enter IDB. */
export function normalizeStoredOutput(value: StoredOutput): StoredOutput {
  if (value.id !== outputId(value.projectId, value.renderId)) {
    throw new TypeError("Output id does not match its project and render");
  }
  if (
    value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    (typeof Blob === "undefined" ? !value.blob : !(value.blob instanceof Blob))
  ) {
    throw new TypeError("Invalid stored output");
  }
  return {
    id: value.id,
    projectId: value.projectId,
    renderId: value.renderId,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    blob: value.blob,
    metadata: {
      mimeType: "video/mp4",
      byteLength: value.metadata.byteLength,
      durationMs: value.metadata.durationMs,
      width: value.metadata.width,
      height: value.metadata.height,
      frameRate: value.metadata.frameRate,
      createdAt: value.metadata.createdAt,
    },
  };
}

export function isActiveRender(status: RenderRecord["status"]): boolean {
  return status === "queued" || status === "rendering";
}
