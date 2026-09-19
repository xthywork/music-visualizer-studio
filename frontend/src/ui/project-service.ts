import {
  DOMAIN_SCHEMA_VERSION,
  type OutputMetadata,
  type ProjectRecord,
  type ProjectRenderStatus,
  type RenderConfiguration,
  type RenderError,
  type RenderRecord,
  type ServerRenderReference,
} from "../domain";
import {
  outputId,
  StorageQuotaError,
  type ProjectStorage,
  type StoredOutput,
  STORAGE_SCHEMA_VERSION,
} from "../storage";

export interface ProjectServiceOptions {
  /** Injectable clock and ID source make lifecycle behavior deterministic in tests. */
  readonly now?: () => string;
  readonly createId?: () => string;
}

export interface CompletedRenderResult {
  readonly project: ProjectRecord;
  readonly outputSaved: boolean;
  readonly quotaError?: StorageQuotaError;
}

/**
 * Coordinates project metadata and render records without ever accepting an
 * audio value. Audio belongs to the transient worker session, not this API.
 */
export class ProjectService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly storage: ProjectStorage,
    options: ProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultId;
  }

  async createProject(name: string, configuration: RenderConfiguration): Promise<ProjectRecord> {
    const timestamp = this.now();
    const project: ProjectRecord = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: this.createId(),
      name,
      configuration,
      createdAt: timestamp,
      updatedAt: timestamp,
      renders: [],
    };
    await this.storage.saveProject(project);
    return project;
  }

  async updateProject(
    projectId: string,
    configuration: RenderConfiguration,
    name?: string,
  ): Promise<ProjectRecord> {
    const project = await this.requireProject(projectId);
    const updated: ProjectRecord = {
      ...project,
      ...(name === undefined ? {} : { name }),
      configuration,
      updatedAt: this.now(),
    };
    await this.storage.saveProject(updated);
    return updated;
  }

  async queueRender(projectId: string, renderId = this.createId()): Promise<RenderRecord> {
    return this.updateRender(projectId, {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: renderId,
      status: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
    });
  }

  async markRendering(projectId: string, renderId: string): Promise<RenderRecord> {
    return this.updateRenderStatus(projectId, renderId, "rendering");
  }

  async recordCompletedRender(
    projectId: string,
    renderId: string,
    blob: Blob,
    metadata: OutputMetadata,
  ): Promise<CompletedRenderResult> {
    if (typeof Blob !== "undefined" && !(blob instanceof Blob)) {
      throw new TypeError("Completed output must be an MP4 Blob");
    }
    const completedAt = this.now();
    const render = await this.requireRender(projectId, renderId);
    const completed: RenderRecord = {
      ...render,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      error: undefined,
      output: metadata,
    };
    // Save metadata first. If the Blob exceeds quota the project remains
    // reopenable and the UI can offer output deletion/retry.
    const project = await this.replaceRender(projectId, completed);
    const output: StoredOutput = {
      id: outputId(projectId, renderId),
      projectId,
      renderId,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      blob,
      metadata,
    };
    try {
      await this.storage.saveOutput(output);
      return { project, outputSaved: true };
    } catch (error) {
      if (!(error instanceof StorageQuotaError)) throw error;
      return { project, outputSaved: false, quotaError: error };
    }
  }

  async markFailed(
    projectId: string,
    renderId: string,
    error: RenderError,
  ): Promise<RenderRecord> {
    const render = await this.updateRenderStatus(projectId, renderId, "failed", error);
    await this.storage.deleteOutput(projectId, renderId);
    return render;
  }

  async markCancelled(projectId: string, renderId: string): Promise<RenderRecord> {
    const render = await this.updateRenderStatus(projectId, renderId, "cancelled");
    await this.storage.deleteOutput(projectId, renderId);
    return render;
  }

  /** Persist the latest server-authoritative state without storing an MP4 Blob. */
  async updateServerRender(
    projectId: string,
    renderId: string,
    server: ServerRenderReference,
    error?: RenderError,
  ): Promise<RenderRecord> {
    const status = server.state === "running" ? "rendering" : server.state;
    const render = await this.requireRender(projectId, renderId);
    const updated: RenderRecord = {
      ...render,
      status,
      updatedAt: this.now(),
      server,
      output: undefined,
      ...(status === "completed" ? { completedAt: render.completedAt ?? server.updatedAt } : {}),
      ...(error === undefined ? { error: undefined } : { error }),
    };
    await this.replaceRender(projectId, updated);
    return updated;
  }

  /** Mark a saved server reference stale after a status request cannot reach the server. */
  async markServerStatusUnconfirmed(projectId: string, renderId: string): Promise<RenderRecord> {
    const render = await this.requireRender(projectId, renderId);
    if (!render.server) return render;
    const updated: RenderRecord = {
      ...render,
      updatedAt: this.now(),
      server: { ...render.server, statusConfirmed: false },
    };
    await this.replaceRender(projectId, updated);
    return updated;
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    return this.storage.listProjects();
  }

  async reopenProject(projectId: string): Promise<ProjectRecord | undefined> {
    return this.storage.getProject(projectId);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.storage.deleteProject(projectId);
  }

  async deleteOutput(projectId: string, renderId: string): Promise<void> {
    await this.storage.deleteOutput(projectId, renderId);
  }

  async getOutput(projectId: string, renderId: string): Promise<StoredOutput | undefined> {
    return this.storage.getOutput(projectId, renderId);
  }

  async estimateQuota() {
    return this.storage.estimateQuota();
  }

  async reconcileInterruptedRenders(): Promise<readonly ProjectRecord[]> {
    return this.storage.reconcileActiveRenders(this.now());
  }

  private async updateRenderStatus(
    projectId: string,
    renderId: string,
    status: ProjectRenderStatus,
    error?: RenderError,
  ): Promise<RenderRecord> {
    const render = await this.requireRender(projectId, renderId);
    const updated: RenderRecord = {
      ...render,
      status,
      updatedAt: this.now(),
      ...(error === undefined ? {} : { error }),
      ...(status === "failed" || status === "cancelled" ? { output: undefined } : {}),
    };
    await this.replaceRender(projectId, updated);
    return updated;
  }

  private async updateRender(projectId: string, render: RenderRecord): Promise<RenderRecord> {
    const project = await this.requireProject(projectId);
    if (project.renders.some((candidate) => candidate.id === render.id)) {
      throw new Error(`Render ${render.id} already exists`);
    }
    await this.replaceRender(projectId, render);
    return render;
  }

  private async replaceRender(projectId: string, render: RenderRecord): Promise<ProjectRecord> {
    const project = await this.requireProject(projectId);
    const found = project.renders.some((candidate) => candidate.id === render.id);
    const renders = found
      ? project.renders.map((candidate) => candidate.id === render.id ? render : candidate)
      : [...project.renders, render];
    const updated: ProjectRecord = { ...project, renders, updatedAt: this.now() };
    await this.storage.saveProject(updated);
    return updated;
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.storage.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} was not found`);
    return project;
  }

  private async requireRender(projectId: string, renderId: string): Promise<RenderRecord> {
    const project = await this.requireProject(projectId);
    const render = project.renders.find((candidate) => candidate.id === renderId);
    if (!render) throw new Error(`Render ${renderId} was not found`);
    return render;
  }
}

function defaultId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
