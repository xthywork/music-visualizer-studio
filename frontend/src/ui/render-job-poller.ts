import {
  type CreateRenderJobInput,
  type RenderJob,
  type RenderJobApi,
} from "../api/render-jobs";

export interface RenderJobPollerCallbacks {
  /** Called only while both the selected workspace and active job still match. */
  readonly onJob: (workspaceId: string, job: RenderJob) => void;
  readonly onError?: (workspaceId: string, error: unknown) => void;
}

interface ActiveSession {
  readonly workspaceId: string;
  readonly generation: number;
  jobId?: string;
  requestId: number;
  request?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

const TERMINAL_STATES = new Set<RenderJob["state"]>([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);

/**
 * Owns at most one server render session and one status poll at a time.
 * Workspace switches, replacement jobs, and cancellation invalidate both the
 * old timer and every async response started by the previous identity.
 */
export class RenderJobPoller {
  private workspaceId: string | null = null;
  private generation = 0;
  private active?: ActiveSession;

  constructor(
    private readonly api: RenderJobApi,
    private readonly callbacks: RenderJobPollerCallbacks,
    private readonly pollIntervalMs = 1_000,
  ) {}

  setWorkspace(workspaceId: string | null): void {
    if (workspaceId === this.workspaceId) return;
    this.workspaceId = workspaceId;
    this.invalidateActive();
  }

  /** Start an upload for the current workspace, replacing any older session. */
  async create(input: CreateRenderJobInput): Promise<RenderJob | undefined> {
    const session = this.beginSession();
    const requestId = this.beginRequest(session);
    const controller = session.request!;
    try {
      const job = await this.api.create(input, controller.signal);
      if (!this.isCurrent(session, requestId)) return undefined;
      session.jobId = job.id;
      this.publish(session, job);
      if (!TERMINAL_STATES.has(job.state)) this.schedulePoll(session, 0);
      return job;
    } catch (error) {
      if (this.isCurrent(session, requestId) && !isAbortError(error)) {
        this.callbacks.onError?.(session.workspaceId, error);
        throw error;
      }
      return undefined;
    } finally {
      if (session.request === controller) session.request = undefined;
    }
  }

  /** Select/resume a known server job in the current workspace. */
  open(jobId: string): void {
    const session = this.beginSession();
    session.jobId = jobId;
    this.schedulePoll(session, 0);
  }

  async cancel(): Promise<RenderJob | undefined> {
    const session = this.active;
    if (!session || !this.isCurrent(session)) return undefined;
    // There is no server job id until the multipart request succeeds. Aborting
    // that request gives Cancel a consistent meaning during upload as well.
    if (!session.jobId) {
      this.invalidateActive();
      return undefined;
    }
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    const requestId = this.beginRequest(session);
    const controller = session.request!;
    try {
      const job = await this.api.cancel(session.jobId, controller.signal);
      if (!this.isCurrent(session, requestId)) return undefined;
      this.publish(session, job);
      if (!TERMINAL_STATES.has(job.state)) this.schedulePoll(session, this.pollIntervalMs);
      return job;
    } catch (error) {
      if (this.isCurrent(session, requestId) && !isAbortError(error)) {
        this.callbacks.onError?.(session.workspaceId, error);
        this.schedulePoll(session, this.pollIntervalMs);
        throw error;
      }
      return undefined;
    } finally {
      if (session.request === controller) session.request = undefined;
    }
  }

  dispose(): void {
    this.workspaceId = null;
    this.invalidateActive();
  }

  private beginSession(): ActiveSession {
    if (!this.workspaceId) throw new Error("A workspace must be selected before starting a render job.");
    this.invalidateActive();
    const session: ActiveSession = {
      workspaceId: this.workspaceId,
      generation: ++this.generation,
      requestId: 0,
    };
    this.active = session;
    return session;
  }

  private beginRequest(session: ActiveSession): number {
    session.request?.abort();
    session.request = new AbortController();
    session.requestId += 1;
    return session.requestId;
  }

  private schedulePoll(session: ActiveSession, delayMs: number): void {
    if (!this.isCurrent(session) || !session.jobId) return;
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void this.poll(session);
    }, delayMs);
  }

  private async poll(session: ActiveSession): Promise<void> {
    if (!this.isCurrent(session) || !session.jobId) return;
    const requestId = this.beginRequest(session);
    const controller = session.request!;
    try {
      const job = await this.api.status(session.jobId, controller.signal);
      if (!this.isCurrent(session, requestId)) return;
      this.publish(session, job);
      if (!TERMINAL_STATES.has(job.state)) this.schedulePoll(session, this.pollIntervalMs);
    } catch (error) {
      if (this.isCurrent(session, requestId) && !isAbortError(error)) {
        this.callbacks.onError?.(session.workspaceId, error);
        this.schedulePoll(session, this.pollIntervalMs);
      }
    } finally {
      if (session.request === controller) session.request = undefined;
    }
  }

  private publish(session: ActiveSession, job: RenderJob): void {
    if (this.isCurrent(session) && session.jobId === job.id) {
      this.callbacks.onJob(session.workspaceId, job);
    }
  }

  private isCurrent(session: ActiveSession, requestId?: number): boolean {
    return this.active === session
      && this.workspaceId === session.workspaceId
      && session.generation === this.generation
      && (requestId === undefined || session.requestId === requestId);
  }

  private invalidateActive(): void {
    this.generation += 1;
    const session = this.active;
    this.active = undefined;
    if (!session) return;
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.request?.abort();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
