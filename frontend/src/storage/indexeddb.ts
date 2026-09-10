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
  StorageQuotaError,
  type StoredOutput,
  type FileSystemFileHandleLike,
  type StoredAudioHandle,
  isActiveRender,
  normalizeStoredOutput,
} from "./types";

const DEFAULT_DATABASE_NAME = "music-visualizer";
const DATABASE_VERSION = 2;
const PROJECTS_STORE = "projects";
const OUTPUTS_STORE = "outputs";
const AUDIO_HANDLES_STORE = "audioHandles";

interface StoredProject {
  readonly id: string;
  readonly serialized: string;
}

interface StoredOutputRecord extends StoredOutput {
  readonly id: string;
}

/** IndexedDB-backed implementation of the local project/output contract. */
export class IndexedDbProjectStorage implements ProjectStorage {
  private readonly databaseName: string;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(databaseName = DEFAULT_DATABASE_NAME) {
    this.databaseName = databaseName;
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    const db = await this.database();
    const records = await request<StoredProject[]>(db.transaction(PROJECTS_STORE, "readonly").objectStore(PROJECTS_STORE).getAll());
    return records.map((record) => deserializeProject(record.serialized)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getProject(projectId: string): Promise<ProjectRecord | undefined> {
    const db = await this.database();
    const record = await request<StoredProject | undefined>(db.transaction(PROJECTS_STORE, "readonly").objectStore(PROJECTS_STORE).get(projectId));
    return record ? deserializeProject(record.serialized) : undefined;
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    const db = await this.database();
    const serialized = serializeProject(project);
    try {
      await request(db.transaction(PROJECTS_STORE, "readwrite").objectStore(PROJECTS_STORE).put({ id: project.id, serialized } satisfies StoredProject));
    } catch (error) {
      throw asStorageError(error);
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    const db = await this.database();
    const transaction = db.transaction([PROJECTS_STORE, OUTPUTS_STORE, AUDIO_HANDLES_STORE], "readwrite");
    transaction.objectStore(PROJECTS_STORE).delete(projectId);
    const outputStore = transaction.objectStore(OUTPUTS_STORE);
    const index = outputStore.index("projectId");
    await cursorDelete(index.openCursor(IDBKeyRange.only(projectId)), outputStore);
    transaction.objectStore(AUDIO_HANDLES_STORE).delete(projectId);
    await transactionDone(transaction);
  }

  async saveAudioHandle(projectId: string, handle: FileSystemFileHandleLike): Promise<void> {
    const db = await this.database();
    try {
      await request(db.transaction(AUDIO_HANDLES_STORE, "readwrite").objectStore(AUDIO_HANDLES_STORE).put({ projectId, handle } satisfies StoredAudioHandle));
    } catch (error) {
      throw asStorageError(error);
    }
  }

  async getAudioHandle(projectId: string): Promise<StoredAudioHandle | undefined> {
    const db = await this.database();
    return request<StoredAudioHandle | undefined>(db.transaction(AUDIO_HANDLES_STORE, "readonly").objectStore(AUDIO_HANDLES_STORE).get(projectId));
  }

  async deleteAudioHandle(projectId: string): Promise<void> {
    const db = await this.database();
    await request(db.transaction(AUDIO_HANDLES_STORE, "readwrite").objectStore(AUDIO_HANDLES_STORE).delete(projectId));
  }

  async saveOutput(output: StoredOutput): Promise<void> {
    const normalized = normalizeStoredOutput(output);
    const db = await this.database();
    try {
      await request(db.transaction(OUTPUTS_STORE, "readwrite").objectStore(OUTPUTS_STORE).put(normalized satisfies StoredOutputRecord));
    } catch (error) {
      throw asStorageError(error);
    }
  }

  async getOutput(projectId: string, renderId: string): Promise<StoredOutput | undefined> {
    const db = await this.database();
    return request<StoredOutput | undefined>(db.transaction(OUTPUTS_STORE, "readonly").objectStore(OUTPUTS_STORE).get(outputId(projectId, renderId)));
  }

  async deleteOutput(projectId: string, renderId: string): Promise<void> {
    const db = await this.database();
    const transaction = db.transaction([PROJECTS_STORE, OUTPUTS_STORE], "readwrite");
    transaction.objectStore(OUTPUTS_STORE).delete(outputId(projectId, renderId));
    const projectStore = transaction.objectStore(PROJECTS_STORE);
    const existing = await request<StoredProject | undefined>(projectStore.get(projectId));
    if (existing) {
      const project = deserializeProject(existing.serialized);
      const renders = project.renders.map((render) => render.id === renderId ? withoutOutput(render) : render);
      if (renders.some((render, index) => render !== project.renders[index])) {
        const updated = { ...project, renders, updatedAt: new Date().toISOString() };
        projectStore.put({ id: projectId, serialized: serializeProject(updated) } satisfies StoredProject);
      }
    }
    await transactionDone(transaction);
  }

  async estimateQuota(): Promise<StorageEstimate> {
    const estimate = typeof navigator !== "undefined" && navigator.storage?.estimate
      ? await navigator.storage.estimate()
      : {};
    const usageBytes = estimate.usage;
    const quotaBytes = estimate.quota;
    return {
      ...(usageBytes === undefined ? {} : { usageBytes }),
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      ...(usageBytes !== undefined && quotaBytes !== undefined
        ? { availableBytes: Math.max(0, quotaBytes - usageBytes) }
        : {}),
    };
  }

  async reconcileActiveRenders(now = new Date().toISOString()): Promise<readonly ProjectRecord[]> {
    const projects = await this.listProjects();
    const changed: ProjectRecord[] = [];
    for (const project of projects) {
      const active = project.renders.filter((render) => isActiveRender(render.status));
      if (active.length === 0) continue;
      const renders = project.renders.map((render) => active.some((candidate) => candidate.id === render.id)
        ? {
            ...render,
            status: "interrupted" as const,
            updatedAt: now,
            error: { code: "render-interrupted", message: "Render was interrupted before completion." },
            output: undefined,
          }
        : render);
      const updated = { ...project, renders, updatedAt: now };
      await this.saveProject(updated);
      for (const render of active) await this.deleteOutput(project.id, render.id);
      changed.push(updated);
    }
    return changed;
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
    this.databasePromise = new Promise((resolve, reject) => {
      const requestOpen = indexedDB.open(this.databaseName, DATABASE_VERSION);
      requestOpen.onupgradeneeded = () => {
        const db = requestOpen.result;
        if (!db.objectStoreNames.contains(PROJECTS_STORE)) db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(OUTPUTS_STORE)) {
          const outputs = db.createObjectStore(OUTPUTS_STORE, { keyPath: "id" });
          outputs.createIndex("projectId", "projectId", { unique: false });
        }
        // Version 2 adds handles without touching existing project/output data.
        if (!db.objectStoreNames.contains(AUDIO_HANDLES_STORE)) db.createObjectStore(AUDIO_HANDLES_STORE, { keyPath: "projectId" });
      };
      requestOpen.onsuccess = () => resolve(requestOpen.result);
      requestOpen.onerror = () => reject(requestOpen.error ?? new Error("Unable to open IndexedDB"));
      requestOpen.onblocked = () => reject(new Error("IndexedDB upgrade is blocked"));
    });
    return this.databasePromise;
  }
}

function withoutOutput(render: RenderRecord): RenderRecord {
  const { output: _output, ...without } = render;
  return without;
}

function asStorageError(error: unknown): Error {
  if (error instanceof StorageQuotaError) return error;
  if (error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
    return new StorageQuotaError(undefined, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function request<T = unknown>(requestValue: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    requestValue.onsuccess = () => resolve(requestValue.result);
    requestValue.onerror = () => reject(requestValue.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function cursorDelete(cursorRequest: IDBRequest<IDBCursorWithValue | null>, store: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("IndexedDB cursor failed"));
  });
}
