// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DOMAIN_SCHEMA_VERSION, type RenderConfiguration } from "../src/domain";
import { InMemoryProjectStorage } from "../src/storage/in-memory";
import { ProjectService } from "../src/ui/project-service";

const configuration: RenderConfiguration = {
  schemaVersion: DOMAIN_SCHEMA_VERSION,
  templateId: "quiet-editorial",
  text: { title: "Test", artist: "Artist" },
  output: { aspectRatio: "1:1", width: 1080, height: 1080, frameRate: 30 },
};

function serviceFor(storage: InMemoryProjectStorage): ProjectService {
  let sequence = 0;
  return new ProjectService(storage, {
    now: () => "2026-01-01T00:00:00.000Z",
    createId: () => `id-${++sequence}`,
  });
}

describe("ProjectService", () => {
  it("persists project configuration and every render lifecycle state", async () => {
    const service = serviceFor(new InMemoryProjectStorage());
    const project = await service.createProject("Demo", configuration);
    const queued = await service.queueRender(project.id, "render-1");
    expect(queued.status).toBe("queued");
    expect((await service.markRendering(project.id, queued.id)).status).toBe("rendering");
    const completed = await service.recordCompletedRender(
      project.id,
      queued.id,
      new Blob(["mp4"], { type: "video/mp4" }),
      {
        mimeType: "video/mp4",
        byteLength: 3,
        durationMs: 1000,
        width: 1080,
        height: 1080,
        frameRate: 30,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(completed.outputSaved).toBe(true);
    expect((await service.reopenProject(project.id))?.renders[0].status).toBe("completed");
    expect(await service.getOutput(project.id, queued.id)).toBeDefined();

    const second = await service.queueRender(project.id, "render-2");
    expect((await service.markFailed(project.id, second.id, { code: "decode", message: "bad audio" })).status).toBe("failed");
    const third = await service.queueRender(project.id, "render-3");
    expect((await service.markCancelled(project.id, third.id)).status).toBe("cancelled");
  });

  it("retains metadata and returns a retryable result when MP4 quota is exceeded", async () => {
    const storage = new InMemoryProjectStorage({ maxBytes: 2_000 });
    const service = serviceFor(storage);
    const project = await service.createProject("Quota", configuration);
    const render = await service.queueRender(project.id, "render-1");
    const result = await service.recordCompletedRender(
      project.id,
      render.id,
      new Blob([new Uint8Array(4_000)], { type: "video/mp4" }),
      {
        mimeType: "video/mp4",
        byteLength: 4_000,
        durationMs: 1000,
        width: 1080,
        height: 1080,
        frameRate: 30,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(result.outputSaved).toBe(false);
    expect(result.quotaError).toBeDefined();
    expect((await service.reopenProject(project.id))?.renders[0].status).toBe("completed");
    expect(await service.getOutput(project.id, render.id)).toBeUndefined();
  });

  it("persists authoritative server state and output URLs without saving a Blob", async () => {
    const service = serviceFor(new InMemoryProjectStorage());
    const project = await service.createProject("Server render", configuration);
    const render = await service.queueRender(project.id, "render-server");
    const queued = await service.updateServerRender(project.id, render.id, {
      jobId: "job-server",
      state: "queued",
      outputAvailable: false,
      statusConfirmed: true,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(queued.status).toBe("queued");

    const completed = await service.updateServerRender(project.id, render.id, {
      jobId: "job-server",
      state: "completed",
      outputAvailable: true,
      statusConfirmed: true,
      updatedAt: "2026-01-01T00:00:02.000Z",
      outputUrl: "/api/render-jobs/job-server/output",
    });
    expect(completed.status).toBe("completed");
    expect(completed.output).toBeUndefined();
    expect(completed.server?.outputUrl).toBe("/api/render-jobs/job-server/output");
    expect(await service.getOutput(project.id, render.id)).toBeUndefined();

    const unconfirmed = await service.markServerStatusUnconfirmed(project.id, render.id);
    expect(unconfirmed.server?.state).toBe("completed");
    expect(unconfirmed.server?.outputAvailable).toBe(true);
    expect(unconfirmed.server?.statusConfirmed).toBe(false);
  });

  it("lists, reopens, deletes output only, and then deletes projects", async () => {
    const service = serviceFor(new InMemoryProjectStorage());
    const project = await service.createProject("Controls", configuration);
    const render = await service.queueRender(project.id, "render-1");
    await service.recordCompletedRender(project.id, render.id, new Blob(["mp4"]), {
      mimeType: "video/mp4", byteLength: 3, durationMs: 1000, width: 1080, height: 1080,
      frameRate: 30, createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await service.listProjects())).toHaveLength(1);
    await service.deleteOutput(project.id, render.id);
    expect((await service.reopenProject(project.id))?.configuration).toEqual(configuration);
    expect((await service.reopenProject(project.id))?.renders[0].output).toBeUndefined();
    await service.deleteProject(project.id);
    expect(await service.listProjects()).toEqual([]);
  });
});
