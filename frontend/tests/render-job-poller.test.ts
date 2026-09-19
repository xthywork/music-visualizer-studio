import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreateRenderJobInput,
  RenderCapabilities,
  RenderJob,
  RenderJobApi,
} from "../src/api/render-jobs";
import { RenderJobPoller } from "../src/ui/render-job-poller";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function job(id: string, state: RenderJob["state"] = "running"): RenderJob {
  return {
    schemaVersion: 1,
    id,
    state,
    progress: 0.25,
    frame: 15,
    totalFrames: 60,
    etaSeconds: 3,
    outputAvailable: false,
    outputUrl: null,
    error: null,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:01Z",
  };
}

class DeferredRenderJobApi implements RenderJobApi {
  readonly creates: Array<{ deferred: Deferred<RenderJob>; signal?: AbortSignal }> = [];
  readonly statuses: Array<{ jobId: string; deferred: Deferred<RenderJob>; signal?: AbortSignal }> = [];
  readonly cancellations: Array<{ jobId: string; deferred: Deferred<RenderJob>; signal?: AbortSignal }> = [];

  capabilities(_signal?: AbortSignal): Promise<RenderCapabilities> {
    throw new Error("Not used by poller tests");
  }

  create(_input: CreateRenderJobInput, signal?: AbortSignal): Promise<RenderJob> {
    const request = deferred<RenderJob>();
    this.creates.push({ deferred: request, signal });
    return request.promise;
  }

  status(jobId: string, signal?: AbortSignal): Promise<RenderJob> {
    const request = deferred<RenderJob>();
    this.statuses.push({ jobId, deferred: request, signal });
    return request.promise;
  }

  cancel(jobId: string, signal?: AbortSignal): Promise<RenderJob> {
    const request = deferred<RenderJob>();
    this.cancellations.push({ jobId, deferred: request, signal });
    return request.promise;
  }

  deleteOutput(_jobId: string, _signal?: AbortSignal): Promise<RenderJob> {
    throw new Error("Not used by poller tests");
  }

  deleteJob(_jobId: string, _signal?: AbortSignal): Promise<void> {
    throw new Error("Not used by poller tests");
  }
}

const input = {} as CreateRenderJobInput;

afterEach(() => vi.useRealTimers());

describe("RenderJobPoller identity guards", () => {
  it("ignores a create response after the workspace changes", async () => {
    const api = new DeferredRenderJobApi();
    const received: RenderJob[] = [];
    const poller = new RenderJobPoller(api, { onJob: (_workspace, value) => received.push(value) });
    poller.setWorkspace("workspace-a");

    const creating = poller.create(input);
    poller.setWorkspace("workspace-b");
    api.creates[0]!.deferred.resolve(job("job-a"));

    await expect(creating).resolves.toBeUndefined();
    expect(received).toEqual([]);
    expect(api.creates[0]?.signal?.aborted).toBe(true);
  });

  it("lets the latest create win when an older create finishes last", async () => {
    const api = new DeferredRenderJobApi();
    const received: RenderJob[] = [];
    vi.useFakeTimers();
    const poller = new RenderJobPoller(api, { onJob: (_workspace, value) => received.push(value) }, 60_000);
    poller.setWorkspace("workspace-a");

    const older = poller.create(input);
    const newer = poller.create(input);
    api.creates[1]!.deferred.resolve(job("job-new"));
    await expect(newer).resolves.toMatchObject({ id: "job-new" });
    api.creates[0]!.deferred.resolve(job("job-old"));
    await expect(older).resolves.toBeUndefined();

    expect(received.map((value) => value.id)).toEqual(["job-new"]);
    expect(api.creates).toHaveLength(2);
    expect(api.creates[0]?.signal?.aborted).toBe(true);
  });

  it("ignores an old status response after a newer job is selected", async () => {
    const api = new DeferredRenderJobApi();
    const received: RenderJob[] = [];
    vi.useFakeTimers();
    const poller = new RenderJobPoller(api, { onJob: (_workspace, value) => received.push(value) }, 60_000);
    poller.setWorkspace("workspace-a");

    poller.open("job-old");
    await vi.advanceTimersByTimeAsync(0);
    poller.open("job-new");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.statuses.map((request) => request.jobId)).toEqual(["job-old", "job-new"]);
    expect(api.statuses[0]?.signal?.aborted).toBe(true);

    api.statuses[0]!.deferred.resolve(job("job-old", "completed"));
    api.statuses[1]!.deferred.resolve(job("job-new"));
    await vi.advanceTimersByTimeAsync(0);

    expect(received.map((value) => value.id)).toEqual(["job-new"]);
  });

  it("ignores an old cancellation response after the workspace changes", async () => {
    const api = new DeferredRenderJobApi();
    const received: Array<{ workspace: string; job: RenderJob }> = [];
    const poller = new RenderJobPoller(api, {
      onJob: (workspace, value) => received.push({ workspace, job: value }),
    });
    poller.setWorkspace("workspace-a");
    poller.open("job-a");

    const cancelling = poller.cancel();
    poller.setWorkspace("workspace-b");
    api.cancellations[0]!.deferred.resolve(job("job-a", "cancelled"));

    await expect(cancelling).resolves.toBeUndefined();
    expect(api.cancellations[0]?.signal?.aborted).toBe(true);
    expect(received).toEqual([]);
  });

  it("ignores an old cancellation response after a newer job is selected", async () => {
    const api = new DeferredRenderJobApi();
    const received: RenderJob[] = [];
    vi.useFakeTimers();
    const poller = new RenderJobPoller(api, { onJob: (_workspace, value) => received.push(value) }, 60_000);
    poller.setWorkspace("workspace-a");
    poller.open("job-old");

    const cancelling = poller.cancel();
    poller.open("job-new");
    api.cancellations[0]!.deferred.resolve(job("job-old", "cancelled"));
    await expect(cancelling).resolves.toBeUndefined();

    expect(api.cancellations[0]?.signal?.aborted).toBe(true);
    expect(received).toEqual([]);
  });

  it("aborts an in-flight multipart create when cancelled before a job id exists", async () => {
    const api = new DeferredRenderJobApi();
    const received: RenderJob[] = [];
    const poller = new RenderJobPoller(api, { onJob: (_workspace, value) => received.push(value) });
    poller.setWorkspace("workspace-a");

    const creating = poller.create(input);
    await expect(poller.cancel()).resolves.toBeUndefined();
    api.creates[0]!.deferred.resolve(job("job-orphan"));

    await expect(creating).resolves.toBeUndefined();
    expect(api.creates[0]?.signal?.aborted).toBe(true);
    expect(received).toEqual([]);
  });
});
