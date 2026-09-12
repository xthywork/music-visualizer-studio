export interface ProjectSaveSnapshot<Configuration> {
  readonly projectId: string | null;
  readonly configuration: Configuration;
  readonly name: string;
  readonly workspaceToken: number;
}

export interface ProjectSaveAdapter<Configuration, Project extends { readonly id: string }> {
  readonly create: (snapshot: ProjectSaveSnapshot<Configuration>) => Promise<Project>;
  readonly update: (snapshot: ProjectSaveSnapshot<Configuration>) => Promise<Project>;
  readonly remove: (projectId: string) => Promise<void>;
}

export interface ProjectSaveCoordinatorOptions<Project extends { readonly id: string }> {
  readonly currentProjectId: () => string | null;
  readonly workspaceToken: () => number;
  readonly applyCurrentProject: (project: Project) => Promise<void> | void;
}

/** Serializes autosave and manual saves while binding each write to its draft identity. */
export class ProjectSaveCoordinator<Configuration, Project extends { readonly id: string }> {
  private pending: ProjectSaveSnapshot<Configuration> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly invalidatedProjectIds = new Set<string>();

  constructor(
    private readonly adapter: ProjectSaveAdapter<Configuration, Project>,
    private readonly options: ProjectSaveCoordinatorOptions<Project>,
  ) {}

  schedule(snapshot: ProjectSaveSnapshot<Configuration>): void {
    this.pending = snapshot;
  }

  abandonPending(): void {
    this.pending = null;
  }

  async flush(): Promise<Project | undefined> {
    const snapshot = this.pending;
    this.pending = null;
    const result = snapshot ? this.enqueue(() => this.persist(snapshot)) : Promise.resolve(undefined);
    await this.queue;
    return result;
  }

  /** Capture a current snapshot inside the serialized queue to avoid concurrent null creates. */
  saveCurrent(capture: () => ProjectSaveSnapshot<Configuration>): Promise<Project | undefined> {
    return this.enqueue(() => this.persist(capture()));
  }

  /** Serialize related project mutations such as render status/output writes with autosave. */
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.enqueue(operation);
  }

  async cancelProject(projectId: string): Promise<void> {
    this.invalidatedProjectIds.add(projectId);
    if (this.pending?.projectId === projectId) this.pending = null;
    await this.queue;
  }

  /** Roll back invalidation when the storage-layer delete did not succeed. */
  restoreProject(projectId: string): void {
    this.invalidatedProjectIds.delete(projectId);
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async persist(snapshot: ProjectSaveSnapshot<Configuration>): Promise<Project | undefined> {
    if (snapshot.projectId && this.invalidatedProjectIds.has(snapshot.projectId)) return undefined;
    if (!snapshot.projectId && snapshot.workspaceToken !== this.options.workspaceToken()) return undefined;
    const project = snapshot.projectId
      ? await this.adapter.update(snapshot)
      : await this.adapter.create(snapshot);
    const isCurrent = snapshot.workspaceToken === this.options.workspaceToken()
      && this.options.currentProjectId() === snapshot.projectId;
    if (snapshot.projectId && !isCurrent) return project;
    if (!snapshot.projectId && !isCurrent) {
      await this.adapter.remove(project.id);
      return undefined;
    }
    await this.options.applyCurrentProject(project);
    return project;
  }
}
