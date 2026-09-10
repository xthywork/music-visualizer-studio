// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DOMAIN_SCHEMA_VERSION, deserializeProject, serializeProject, type ProjectRecord } from "../src/domain";
import {
  AudioSourcePermissionError,
  FileSystemAccessUnavailableError,
  fileFromAudioHandle,
  hasFileSystemAccessPicker,
  pickAudioSource,
  selectionFromInput,
  sourceAudioMetadataFromFile,
} from "../src/storage/audio-source";
import { InMemoryProjectStorage } from "../src/storage/in-memory";
import { IndexedDbProjectStorage } from "../src/storage/indexeddb";
import { ProjectService } from "../src/ui/project-service";

const project: ProjectRecord = {
  schemaVersion: DOMAIN_SCHEMA_VERSION,
  id: "audio-project",
  name: "Audio project",
  configuration: {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    templateId: "spectrum-cover",
    text: { title: "Title", artist: "Artist" },
    output: { aspectRatio: "16:9", width: 1280, height: 720, frameRate: 30 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  renders: [],
};

describe("safe audio source metadata", () => {
  it("persists identity metadata but strips paths and bytes", () => {
    const withSource = {
      ...project,
      configuration: {
        ...project.configuration,
        sourceAudio: { filename: "/private/music/track.mp3", size: 42, lastModified: 10, type: "audio/mpeg" },
      },
    };
    const serialized = serializeProject(withSource);
    const reopened = deserializeProject(serialized);
    expect(reopened.configuration.sourceAudio).toEqual({ filename: "track.mp3", size: 42, lastModified: 10, type: "audio/mpeg" });
    expect(serialized).not.toMatch(/private|music|ArrayBuffer|audioBytes|sourceAudioBytes/);
  });

  it("supports ordinary input fallback and derives only File metadata", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "track.wav", { type: "audio/wav", lastModified: 123 });
    expect(selectionFromInput(file)).toEqual({ file, metadata: { filename: "track.wav", size: 3, lastModified: 123, type: "audio/wav" } });
    expect(sourceAudioMetadataFromFile({ name: "C:\\music\\track.m4a", size: 5, lastModified: 2, type: "audio/mp4" })).toEqual({ filename: "track.m4a", size: 5, lastModified: 2, type: "audio/mp4" });
  });
});

describe("File System Access audio source", () => {
  it("uses a picker handle when supplied and returns the transient File", async () => {
    const file = new File(["audio"], "track.mp3", { type: "audio/mpeg", lastModified: 123 });
    const handle = { kind: "file" as const, name: "track.mp3", getFile: async () => file };
    const selected = await pickAudioSource(async () => [handle]);
    expect(selected.file).toBe(file);
    expect(selected.handle).toBe(handle);
    expect(hasFileSystemAccessPicker()).toBe(false);
  });

  it("reports unsupported picker and denied permission as actionable fallback states", async () => {
    await expect(pickAudioSource(undefined)).rejects.toBeInstanceOf(FileSystemAccessUnavailableError);
    const handle = {
      getFile: async () => new File(["audio"], "track.mp3"),
      queryPermission: async () => "denied" as const,
      requestPermission: async () => "denied" as const,
    };
    await expect(fileFromAudioHandle(handle)).rejects.toBeInstanceOf(AudioSourcePermissionError);
  });
});

describe("audio handle lifecycle", () => {
  it("stores handles separately, retains them through terminal renders, and deletes them with a project", async () => {
    const storage = new InMemoryProjectStorage();
    const service = new ProjectService(storage, { now: () => "2026-01-01T00:00:00.000Z", createId: () => "audio-project" });
    const created = await service.createProject("Audio", project.configuration);
    const file = new File(["audio"], "track.mp3", { type: "audio/mpeg", lastModified: 123 });
    const handle = { getFile: async () => file, queryPermission: async () => "granted" as const };
    await service.attachAudioSource(created.id, sourceAudioMetadataFromFile(file), handle);
    const reopened = await service.reopenProject(created.id);
    const serialized = JSON.stringify(reopened);
    expect(serialized).not.toContain("getFile");
    expect(reopened?.configuration.sourceAudio).toEqual({ filename: "track.mp3", size: 5, lastModified: 123, type: "audio/mpeg" });
    expect(await storage.getAudioHandle(created.id)).toBeDefined();
    const render = await service.queueRender(created.id, "render-1");
    await service.markCancelled(created.id, render.id);
    expect(await storage.getAudioHandle(created.id)).toBeDefined();
    expect((await service.reopenAudioSource(created.id))?.file.name).toBe("track.mp3");
    await service.deleteProject(created.id);
    expect(await storage.getAudioHandle(created.id)).toBeUndefined();
  });

  it("creates the separate handle store through a safe IndexedDB schema upgrade", async () => {
    const databaseName = `music-visualizer-migration-${crypto.randomUUID()}`;
    const storage = new IndexedDbProjectStorage(databaseName);
    expect(await storage.getAudioHandle("missing-project")).toBeUndefined();
    const request = indexedDB.open(databaseName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect([...db.objectStoreNames]).toContain("audioHandles");
    db.close();
  });
});
