// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOMAIN_SCHEMA_VERSION,
  deserializeProject,
  dimensionsForAspectRatio,
  serializeProject,
  type ProjectRecord,
} from "../src/domain";
import { InMemoryProjectStorage } from "../src/storage/in-memory";
import { IndexedDbProjectStorage } from "../src/storage/indexeddb";
import {
  outputId,
  STORAGE_SCHEMA_VERSION,
  StorageQuotaError,
  type StoredOutput,
} from "../src/storage";

const project: ProjectRecord = {
  schemaVersion: DOMAIN_SCHEMA_VERSION,
  id: "project-1",
  name: "Demo",
  configuration: {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    templateId: "spectrum-cover",
    text: { title: "Song", artist: "Artist" },
    coverImage: { kind: "data-url", value: "data:image/png;base64,abc", alt: "cover" },
    output: { aspectRatio: "16:9", width: 1920, height: 1080, frameRate: 60 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  renders: [
    {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      id: "render-1",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      output: {
        mimeType: "video/mp4",
        byteLength: 3,
        durationMs: 1000,
        width: 1920,
        height: 1080,
        frameRate: 60,
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    },
  ],
};

const output: StoredOutput = {
  id: outputId(project.id, "render-1"),
  projectId: project.id,
  renderId: "render-1",
  schemaVersion: STORAGE_SCHEMA_VERSION,
  blob: new Blob(["mp4"], { type: "video/mp4" }),
  metadata: project.renders[0].output!,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("versioned domain serialization", () => {
  it("round-trips all persisted fields and excludes accidental audio fields", () => {
    const tainted = { ...project, audio: new Uint8Array([1, 2, 3]), sourceAudio: "secret" } as ProjectRecord & {
      audio: Uint8Array;
      sourceAudio: string;
    };
    const roundTrip = deserializeProject(serializeProject(tainted));

    expect(roundTrip).toEqual(project);
    expect(serializeProject(tainted)).not.toContain("sourceAudio");
    expect(serializeProject(tainted)).not.toContain('"audio"');
  });

  it("calculates dimensions for every supported aspect ratio", () => {
    expect(dimensionsForAspectRatio("16:9", 1920)).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsForAspectRatio("9:16", 1920)).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsForAspectRatio("1:1", 1920)).toEqual({ width: 1920, height: 1920 });
  });
});

describe("in-memory local project storage", () => {
  it("supports project/output CRUD and output-only deletion", async () => {
    const storage = new InMemoryProjectStorage();
    await storage.saveProject(project);
    await storage.saveOutput(output);

    expect(await storage.getProject(project.id)).toEqual(project);
    expect(await storage.getOutput(project.id, "render-1")).toEqual(output);
    await storage.deleteOutput(project.id, "render-1");
    expect(await storage.getOutput(project.id, "render-1")).toBeUndefined();
    expect((await storage.getProject(project.id))?.configuration).toEqual(project.configuration);
    expect((await storage.getProject(project.id))?.renders[0].output).toBeUndefined();

    await storage.deleteProject(project.id);
    expect(await storage.listProjects()).toEqual([]);
  });

  it("reconciles queued/rendering records as interrupted without output", async () => {
    const storage = new InMemoryProjectStorage();
    const active = { ...project, renders: [{ ...project.renders[0], status: "rendering" as const }] };
    await storage.saveProject(active);
    await storage.saveOutput(output);

    const changed = await storage.reconcileActiveRenders("2026-01-02T00:00:00.000Z");
    expect(changed).toHaveLength(1);
    const saved = await storage.getProject(project.id);
    expect(saved?.renders[0].status).toBe("interrupted");
    expect(saved?.renders[0].output).toBeUndefined();
    expect(await storage.getOutput(project.id, "render-1")).toBeUndefined();
  });

  it("raises a typed quota error while preserving saved metadata", async () => {
    const storage = new InMemoryProjectStorage({ maxBytes: 10_000 });
    await storage.saveProject(project);
    const tooLarge = { ...output, blob: new Blob([new Uint8Array(20_000)], { type: "video/mp4" }) };
    await expect(storage.saveOutput(tooLarge)).rejects.toThrow(/quota/i);
    await expect(storage.saveOutput(tooLarge)).rejects.toBeInstanceOf(StorageQuotaError);
    expect(await storage.getProject(project.id)).toBeDefined();
  });
});

describe("IndexedDB local project storage", () => {
  it("round-trips project metadata and generated MP4 blobs", async () => {
    const databaseName = `music-visualizer-test-${crypto.randomUUID()}`;
    const storage = new IndexedDbProjectStorage(databaseName);
    await storage.saveProject(project);
    await storage.saveOutput(output);

    expect(await storage.getProject(project.id)).toEqual(project);
    expect((await storage.getOutput(project.id, "render-1"))?.blob.size).toBe(output.blob.size);
    await storage.deleteProject(project.id);
    expect(await storage.getProject(project.id)).toBeUndefined();
    expect(await storage.getOutput(project.id, "render-1")).toBeUndefined();
  });
});
