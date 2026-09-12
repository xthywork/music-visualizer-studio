// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ProjectSaveCoordinator, type ProjectSaveSnapshot } from "../src/ui/project-save-coordinator";

interface Project { readonly id: string; }
interface Configuration { readonly title: string; }

function snapshot(projectId: string | null, title: string, workspaceToken = 0): ProjectSaveSnapshot<Configuration> {
  return { projectId, configuration: { title }, name: title, workspaceToken };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  let valueToResolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { valueToResolve = resolveValue; });
  resolve = (value: T) => { valueToResolve(value); };
  return { promise, started, markStarted, resolve };
}

function harness() {
  let currentProjectId: string | null = null;
  let workspaceToken = 0;
  const created: Project[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const applied: string[] = [];
  let sequence = 0;
  const coordinator = new ProjectSaveCoordinator<Configuration, Project>({
    create: async (_value) => { const project = { id: `project-${++sequence}` }; created.push(project); return project; },
    update: async (value) => { updated.push(value.projectId!); return { id: value.projectId! }; },
    remove: async (projectId) => { removed.push(projectId); },
  }, {
    currentProjectId: () => currentProjectId,
    workspaceToken: () => workspaceToken,
    applyCurrentProject: (project) => { currentProjectId = project.id; applied.push(project.id); },
  });
  return {
    coordinator,
    created,
    updated,
    removed,
    applied,
    get currentProjectId() { return currentProjectId; },
    set currentProjectId(value: string | null) { currentProjectId = value; },
    get workspaceToken() { return workspaceToken; },
    set workspaceToken(value: number) { workspaceToken = value; },
  };
}

describe("ProjectSaveCoordinator", () => {
  it("serializes two concurrent manual null snapshots into one create", async () => {
    const state = harness();
    await Promise.all([
      state.coordinator.saveCurrent(() => snapshot(state.currentProjectId, "Manual")),
      state.coordinator.saveCurrent(() => snapshot(state.currentProjectId, "Manual")),
    ]);
    expect(state.created).toHaveLength(1);
    expect(state.currentProjectId).toBe("project-1");
  });

  it("serializes concurrent autosave and manual save without duplicate null creates", async () => {
    const state = harness();
    const auto = state.coordinator.flush.bind(state.coordinator);
    state.coordinator.schedule(snapshot(null, "Draft"));
    const autosave = auto();
    const manual = (async () => {
      await state.coordinator.flush();
      return state.coordinator.saveCurrent(() => snapshot(state.currentProjectId, "Draft"));
    })();
    await Promise.all([autosave, manual]);
    expect(state.created).toHaveLength(1);
    expect(state.applied).toEqual(["project-1", "project-1"]);
    expect(state.currentProjectId).toBe("project-1");
  });

  it("cleans up a stale in-flight null create without applying it", async () => {
    const state = harness();
    const create = deferred<Project>();
    const adapter = {
      create: async (_value: ProjectSaveSnapshot<Configuration>) => { create.markStarted(); return create.promise; },
      update: async (value: ProjectSaveSnapshot<Configuration>) => ({ id: value.projectId! }),
      remove: async (projectId: string) => { state.removed.push(projectId); },
    };
    const coordinator = new ProjectSaveCoordinator<Configuration, Project>(adapter, {
      currentProjectId: () => state.currentProjectId,
      workspaceToken: () => state.workspaceToken,
      applyCurrentProject: (project) => { state.currentProjectId = project.id; state.applied.push(project.id); },
    });
    coordinator.schedule(snapshot(null, "Abandoned"));
    const save = coordinator.flush();
    await create.started;
    state.workspaceToken = 1;
    create.resolve({ id: "stale-project" });
    expect(await save).toBeUndefined();
    expect(state.removed).toEqual(["stale-project"]);
    expect(state.applied).toEqual([]);
  });

  it("does not apply a stale existing-project completion to the newly opened project", async () => {
    const state = harness();
    state.currentProjectId = "project-a";
    const update = deferred<Project>();
    const coordinator = new ProjectSaveCoordinator<Configuration, Project>({
      create: async () => ({ id: "unexpected" }),
      update: async () => { update.markStarted(); return update.promise; },
      remove: async (projectId) => { state.removed.push(projectId); },
    }, {
      currentProjectId: () => state.currentProjectId,
      workspaceToken: () => state.workspaceToken,
      applyCurrentProject: (project) => { state.currentProjectId = project.id; state.applied.push(project.id); },
    });
    coordinator.schedule(snapshot("project-a", "A pending"));
    const save = coordinator.flush();
    await update.started;
    state.currentProjectId = "project-b";
    state.workspaceToken = 1;
    update.resolve({ id: "project-a" });
    expect(await save).toEqual({ id: "project-a" });
    expect(state.currentProjectId).toBe("project-b");
    expect(state.applied).toEqual([]);
  });

  it("invalidates a pending project update and waits for an in-flight save before deletion", async () => {
    const state = harness();
    state.currentProjectId = "project-a";
    const update = deferred<Project>();
    const adapter = {
      create: async (_value: ProjectSaveSnapshot<Configuration>) => ({ id: "new-project" }),
      update: async (_value: ProjectSaveSnapshot<Configuration>) => { update.markStarted(); return update.promise; },
      remove: async (projectId: string) => { state.removed.push(projectId); },
    };
    const coordinator = new ProjectSaveCoordinator<Configuration, Project>(adapter, {
      currentProjectId: () => state.currentProjectId,
      workspaceToken: () => state.workspaceToken,
      applyCurrentProject: (project) => { state.currentProjectId = project.id; state.applied.push(project.id); },
    });
    coordinator.schedule(snapshot("project-a", "Edited"));
    const save = coordinator.flush();
    await update.started;
    state.workspaceToken = 1;
    const cancel = coordinator.cancelProject("project-a");
    expect(state.removed).toEqual([]);
    update.resolve({ id: "project-a" });
    await cancel;
    await save;
    await adapter.remove("project-a");
    expect(state.updated).toEqual([]);
    expect(state.removed).toEqual(["project-a"]);
    expect(state.applied).toEqual([]);
  });

  it("keeps another project's pending snapshot when an unrelated project is deleted", async () => {
    const state = harness();
    state.currentProjectId = "project-b";
    state.coordinator.schedule(snapshot("project-b", "B pending"));
    await state.coordinator.cancelProject("project-a");
    await state.coordinator.flush();
    expect(state.updated).toEqual(["project-b"]);
    expect(state.currentProjectId).toBe("project-b");
  });

  it("serializes a render metadata mutation behind an autosave", async () => {
    const events: string[] = [];
    let currentProjectId: string | null = "project-a";
    const coordinator = new ProjectSaveCoordinator<Configuration, Project>({
      create: async () => ({ id: "unexpected" }),
      update: async (value) => { events.push(`save:${value.configuration.title}`); return { id: value.projectId! }; },
      remove: async () => undefined,
    }, {
      currentProjectId: () => currentProjectId,
      workspaceToken: () => 0,
      applyCurrentProject: (project) => { currentProjectId = project.id; },
    });
    coordinator.schedule(snapshot("project-a", "edited"));
    await Promise.all([
      coordinator.flush(),
      coordinator.runExclusive(async () => { events.push("render:completed"); }),
    ]);
    expect(events).toEqual(["save:edited", "render:completed"]);
  });

  it("restores autosave eligibility when the caller rolls back a failed delete", async () => {
    const state = harness();
    state.currentProjectId = "project-a";
    await state.coordinator.cancelProject("project-a");
    state.coordinator.restoreProject("project-a");
    state.coordinator.schedule(snapshot("project-a", "Still editable"));
    await state.coordinator.flush();
    expect(state.updated).toEqual(["project-a"]);
  });
});
