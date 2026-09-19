// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  RenderJobHttpError,
  type CreateRenderJobInput,
  type RenderCapabilities,
  type RenderJob,
  type RenderJobApi,
} from "../src/api/render-jobs";
import { DOMAIN_SCHEMA_VERSION, type ProjectRecord } from "../src/domain";
import { deleteProjectWithServerJobs } from "../src/ui/server-deletion";

function projectWithJobs(...jobIds: string[]): ProjectRecord {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    id: "project-a",
    name: "Project A",
    configuration: {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      templateId: "quiet-editorial",
      text: { title: "Title", artist: "Artist" },
      output: { aspectRatio: "16:9", width: 1920, height: 1080, frameRate: 30 },
    },
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    renders: jobIds.map((jobId, index) => ({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: `render-${index}`,
      status: "completed",
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      server: {
        jobId,
        state: "completed",
        outputAvailable: true,
        statusConfirmed: true,
        updatedAt: "2026-09-19T00:00:00Z",
      },
    })),
  };
}

function apiWithDelete(deleteJob: (jobId: string) => Promise<void>): RenderJobApi {
  return {
    capabilities: async () => ({} as RenderCapabilities),
    create: async (_input: CreateRenderJobInput) => ({} as RenderJob),
    status: async () => ({} as RenderJob),
    cancel: async () => ({} as RenderJob),
    deleteOutput: async () => ({} as RenderJob),
    deleteJob,
  };
}

describe("coordinated server/local deletion", () => {
  it("keeps the local project when deleting a server job fails", async () => {
    const deleteLocal = vi.fn(async () => undefined);
    const api = apiWithDelete(async () => {
      throw new RenderJobHttpError("worker is still stopping", 409, "cancelled");
    });

    await expect(deleteProjectWithServerJobs(api, projectWithJobs("job-a"), deleteLocal))
      .rejects.toThrow("worker is still stopping");
    expect(deleteLocal).not.toHaveBeenCalled();
  });

  it("is retry-safe after a server job was already deleted", async () => {
    const deleted: string[] = [];
    const api = apiWithDelete(async (jobId) => {
      deleted.push(jobId);
      if (jobId === "job-a") throw new RenderJobHttpError("not found", 404, "invalid_request");
    });
    const deleteLocal = vi.fn(async () => undefined);

    await deleteProjectWithServerJobs(api, projectWithJobs("job-a", "job-b", "job-b"), deleteLocal);

    expect(deleted).toEqual(["job-a", "job-b"]);
    expect(deleteLocal).toHaveBeenCalledOnce();
  });
});
