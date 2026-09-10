import {
  deserializeProject,
  serializeProject,
  type ProjectRecord,
  type RenderRecord,
} from "../domain";
import {
  outputId,
  type ProjectStorage,
  type StorageEstimate,
  type StoredOutput,
  StorageQuotaError,
  normalizeStoredOutput,
  isActiveRender,
} from "./types";

/** Deterministic storage double for unit tests and non-browser previews. */
export class InMemoryProjectStorage implements ProjectStorage {
  private readonly projects = new Map<string, string>();
  private readonly outputs = new Map<string, StoredOutput>();
  private readonly maxBytes?: number;

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes;
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    return [...this.projects.values()]
      .map(deserializeProject)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getProject(projectId: string): Promise<ProjectRecord | undefined> {
    const value = this.projects.get(projectId);
    return value === undefined ? undefined : deserializeProject(value);
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    const serialized = serializeProject(project);
    this.ensureCapacity(serialized.length, this.projects.get(project.id)?.length ?? 0);
    this.projects.set(project.id, serialized);
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);
    for (const [id, output] of this.outputs) {
      if (output.projectId === projectId) this.outputs.delete(id);
    }
  }

  async saveOutput(output: StoredOutput): Promise<void> {
    const normalized = normalizeStoredOutput(output);
    this.ensureCapacity(normalized.blob.size, this.outputs.get(normalized.id)?.blob.size ?? 0);
    this.outputs.set(normalized.id, normalized);
  }

  async getOutput(projectId: string, renderId: string): Promise<StoredOutput | undefined> {
    return this.outputs.get(outputId(projectId, renderId));
  }

  async deleteOutput(projectId: string, renderId: string): Promise<void> {
    this.outputs.delete(outputId(projectId, renderId));
    const project = await this.getProject(projectId);
    if (!project) return;
    const renders = project.renders.map((render) =>
      render.id === renderId ? withoutOutput(render) : render,
    );
    if (renders.some((render, index) => render !== project.renders[index])) {
      await this.saveProject({ ...project, renders, updatedAt: new Date().toISOString() });
    }
  }

  async estimateQuota(): Promise<StorageEstimate> {
    const usageBytes = this.currentBytes();
    return {
      usageBytes,
      ...(this.maxBytes === undefined ? {} : {
        quotaBytes: this.maxBytes,
        availableBytes: Math.max(0, this.maxBytes - usageBytes),
      }),
    };
  }

  async reconcileActiveRenders(now = new Date().toISOString()): Promise<readonly ProjectRecord[]> {
    const changed: ProjectRecord[] = [];
    for (const project of await this.listProjects()) {
      let didChange = false;
      const renders = project.renders.map((render) => {
        if (!isActiveRender(render.status)) return render;
        didChange = true;
        return {
          ...render,
          status: "interrupted" as const,
          updatedAt: now,
          error: { code: "render-interrupted", message: "Render was interrupted before completion." },
          output: undefined,
        };
      });
      if (didChange) {
        const updated = { ...project, renders, updatedAt: now };
        await this.saveProject(updated);
        for (const render of project.renders) {
          if (isActiveRender(render.status)) await this.deleteOutput(project.id, render.id);
        }
        changed.push(updated);
      }
    }
    return changed;
  }

  private currentBytes(): number {
    let bytes = 0;
    for (const project of this.projects.values()) bytes += project.length;
    for (const output of this.outputs.values()) bytes += output.blob.size;
    return bytes;
  }

  private ensureCapacity(incomingBytes: number, replacedBytes = 0): void {
    if (this.maxBytes !== undefined && this.currentBytes() - replacedBytes + incomingBytes > this.maxBytes) {
      throw new StorageQuotaError();
    }
  }
}

function withoutOutput(render: RenderRecord): RenderRecord {
  const { output: _output, ...without } = render;
  return without;
}
