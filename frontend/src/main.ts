import "./styles.css";
import {
  FRAME_RATES,
  OUTPUT_PRESETS,
  TEMPLATES,
  type AspectRatio,
  type TemplateId,
  formatBytes,
  validateAudioDuration,
  validateAudioFile,
} from "./config";
import {
  DOMAIN_SCHEMA_VERSION,
  type ProjectRecord,
  type RenderConfiguration,
} from "./domain";
import {
  IndexedDbProjectStorage,
} from "./storage";
import { ProjectService } from "./ui/project-service";
import { ProjectSaveCoordinator } from "./ui/project-save-coordinator";
import { normalizeImageFile } from "./ui/image-assets";
import { LatestRequestGate } from "./ui/latest-request";
import { renderProgressMessage } from "./ui/render-progress";
import { detectCapabilities } from "./render/capabilities";
import { renderConfigFromDomain } from "./render/domain-adapter";
import { createScene } from "./render/scenes";
import type { AudioAnalysis } from "./render/types";
import { RenderController, type RenderUpdate } from "./workers/orchestrator";

interface DraftState {
  templateId: TemplateId;
  aspectRatio: AspectRatio;
  presetId: string;
  frameRate: number;
  title: string;
  artist: string;
  audioFile: File | null;
  duration: number | null;
  coverUrl: string | null;
  backgroundUrl: string | null;
}

const state: DraftState = {
  templateId: "spectrum-cover",
  aspectRatio: "16:9",
  presetId: "16-9-1080p",
  frameRate: 30,
  title: "Midnight Signal",
  artist: "Your Artist",
  audioFile: null,
  duration: null,
  coverUrl: null,
  backgroundUrl: null,
};

const previewAssets: { cover: HTMLImageElement | null; background: HTMLImageElement | null } = {
  cover: null,
  background: null,
};
const previewAnalysis: AudioAnalysis = {
  duration: 8,
  sampleRate: 48_000,
  waveform: Float32Array.from({ length: 256 }, (_, index) => .5 + .28 * Math.sin(index * .21) + .12 * Math.sin(index * .061)),
  spectrum: Float32Array.from({ length: 64 }, (_, index) => .16 + .5 * (0.5 + 0.5 * Math.sin(index * .47)) * (0.72 + 0.28 * Math.sin(index * .13))),
  beats: Float32Array.from([.6, 1.85, 3.1, 4.45, 5.9, 7.2]),
};
const projectService = new ProjectService(new IndexedDbProjectStorage());
let currentProjectId: string | null = null;
let saveTimer: number | undefined;
let workspaceToken = 0;
let workspaceNavigationToken = 0;
let expandedProjectId: string | null = null;
interface ActiveRenderSession {
  readonly workspaceToken: number;
  readonly sourceAudio: File;
  projectId?: string;
  renderId?: string;
  controller?: RenderController;
  cancelRequested: boolean;
  finalized: boolean;
  updates: Promise<void>;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
}
interface VolatileOutput {
  readonly renderId: string;
  readonly blob: Blob;
  readonly projectName: string;
}
let activeRenderSession: ActiveRenderSession | null = null;
const volatileOutputs = new Map<string, VolatileOutput>();
let capabilitySupported = false;
const capabilityRequests = new LatestRequestGate();
const audioRequests = new LatestRequestGate();
const imageRequests: Record<ImageTarget, LatestRequestGate> = {
  coverUrl: new LatestRequestGate(),
  backgroundUrl: new LatestRequestGate(),
};
let cancelPendingAudioInspection: (() => void) | null = null;
let currentOutputUrl: string | null = null;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root is missing");

app.innerHTML = `
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">M</span><span>Visualizer Studio</span></div>
      <button class="new-project" id="new-project">＋ 新增專案</button>
      <p class="side-label">本機專案</p>
      <div class="project-list" id="project-list"><p class="empty-projects">專案與輸出只會儲存在這個瀏覽器。</p></div>
      <p class="storage-usage" id="storage-usage">正在讀取本機用量…</p>
    </aside>
    <section class="workspace">
      <div class="layout">
        <section class="panel control-panel"><div class="panel-body">
          <div class="section">
            <div class="section-title"><h2>1. 歌曲與素材</h2><span>即時預覽</span></div>
            <div class="fields song-fields">
              <label class="field">歌名<input id="title-input" value="${state.title}" maxlength="80" /></label>
              <label class="field">藝人<input id="artist-input" value="${state.artist}" maxlength="80" /></label>
            </div>
            <div class="media-grid">
              <div class="media-slot audio-slot">
                <span class="media-label">音訊</span>
                <label class="dropzone" id="audio-dropzone"><input id="audio-input" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" /><span class="audio-preview" id="audio-preview"><span class="audio-placeholder" id="audio-placeholder">＋</span><span class="audio-note" id="audio-note" hidden>♪</span></span><span class="audio-drop-copy"><strong id="audio-drop-title">拖曳或點擊選擇</strong><small id="audio-drop-meta">MP3 · WAV · M4A</small></span></label>
                <p class="file-status" id="file-status">尚未選擇音訊</p>
              </div>
              <div class="media-slot image-field">
                <span class="media-label">封面圖</span>
                <label class="image-dropzone" id="cover-dropzone"><input id="cover-input" type="file" accept="image/png,image/jpeg,image/webp" /><span class="image-preview" id="cover-preview"><span class="image-placeholder">＋</span><img id="cover-preview-image" alt="封面圖預覽" hidden /></span><span class="image-drop-copy"><strong>拖曳或點擊選擇</strong><small id="cover-name">尚未選擇圖片</small></span></label>
                <button class="image-remove" id="cover-remove" type="button" hidden>移除封面圖</button>
              </div>
              <div class="media-slot image-field">
                <span class="media-label">背景圖</span>
                <label class="image-dropzone" id="background-dropzone"><input id="background-input" type="file" accept="image/png,image/jpeg,image/webp" /><span class="image-preview" id="background-preview"><span class="image-placeholder">＋</span><img id="background-preview-image" alt="背景圖預覽" hidden /></span><span class="image-drop-copy"><strong>拖曳或點擊選擇</strong><small id="background-name">尚未選擇圖片</small></span></label>
                <button class="image-remove" id="background-remove" type="button" hidden>移除背景圖</button>
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-title"><h2>2. 動畫設定</h2><span>選擇視覺風格</span></div>
            <div class="setting-block">
              <div class="templates" id="templates"></div>
            </div>
          </div>
          <div class="section">
            <div class="section-title"><h2>3. 輸出設定</h2><span>瀏覽器處理</span></div>
            <div class="setting-block output-settings">
              <div class="subsection-title"><strong>輸出規格</strong><span id="dimensions-label">1920 × 1080</span></div>
              <div class="fields">
                <label class="field">比例<select id="ratio-select"></select></label>
                <label class="field">解析度<select id="resolution-select"></select></label>
                <label class="field">影格率<select id="fps-select"></select></label>
                <label class="field">渲染模式<select disabled><option>自動（瀏覽器優先）</option></select></label>
              </div>
            </div>
          </div>
          <div class="render-controls">
            <div class="status-row"><span id="render-status">選擇音訊後即可生成</span><span id="progress-value">0%</span></div>
            <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
            <div class="actions"><button class="primary" id="render-button" disabled>生成 MP4</button><button class="secondary" id="cancel-button" hidden>取消</button></div>
          </div>
        </div></section>
        <section class="panel preview-panel">
          <div class="preview-head"><span>輸出預覽</span><span class="capability" id="capability">正在檢查編碼能力…</span></div>
          <div class="preview-stack">
            <div class="preview-slot live-preview-slot">
              <div class="stage-wrap"><div class="stage" id="stage" data-ratio="16:9"><canvas id="preview-canvas" width="960" height="540"></canvas><div class="stage-overlay"><span>PREVIEW</span><span id="preview-meta">16:9 · 1080p · 30fps</span></div></div></div>
            </div>
            <div class="preview-slot video-preview-slot">
              <div class="video-placeholder" id="video-placeholder"><span class="video-placeholder-icon">▶</span><strong>影片預覽</strong><small>生成 MP4 後會顯示在這裡</small></div>
              <video class="output-preview" id="output-preview" controls playsinline hidden></video>
            </div>
          </div>
          <div class="preview-output-actions">
            <div class="output-actions" id="output-actions" hidden><a id="download-link" download="music-visualizer.mp4">下載 MP4</a><button id="delete-output">刪除輸出</button></div>
          </div>
        </section>
      </div>
    </section>
  </main>`;

const canvas = document.querySelector<HTMLCanvasElement>("#preview-canvas")!;
const context = canvas.getContext("2d")!;
const stage = document.querySelector<HTMLDivElement>("#stage")!;
const stageWrap = document.querySelector<HTMLDivElement>(".stage-wrap")!;
const templatesElement = document.querySelector<HTMLDivElement>("#templates")!;
const ratioSelect = document.querySelector<HTMLSelectElement>("#ratio-select")!;
const resolutionSelect = document.querySelector<HTMLSelectElement>("#resolution-select")!;
const fpsSelect = document.querySelector<HTMLSelectElement>("#fps-select")!;
const renderButton = document.querySelector<HTMLButtonElement>("#render-button")!;
const capability = document.querySelector<HTMLSpanElement>("#capability")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel-button")!;
const renderStatus = document.querySelector<HTMLSpanElement>("#render-status")!;
const progressValue = document.querySelector<HTMLSpanElement>("#progress-value")!;
const progressBar = document.querySelector<HTMLDivElement>("#progress-bar")!;

function fitPreviewStage(): void {
  const bounds = stageWrap.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const [ratioWidth, ratioHeight] = state.aspectRatio.split(":").map(Number);
  const aspect = ratioWidth / ratioHeight;
  const width = Math.min(bounds.width, bounds.height * aspect);
  const height = width / aspect;
  stage.style.width = `${Math.max(0, width)}px`;
  stage.style.height = `${Math.max(0, height)}px`;
}

const stageResizeObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver(() => fitPreviewStage())
  : null;
stageResizeObserver?.observe(stageWrap);

function renderTemplateCards(): void {
  templatesElement.innerHTML = TEMPLATES.map((template) => `
    <button class="template-card ${template.id === state.templateId ? "active" : ""}" data-template="${template.id}" style="--template-accent:${template.accent}">
      <span class="template-swatch"></span><strong>${template.name}</strong><span>${template.description}</span>
    </button>`).join("");
  templatesElement.querySelectorAll<HTMLButtonElement>("[data-template]").forEach((button) => {
    button.addEventListener("click", () => {
      state.templateId = button.dataset.template as TemplateId;
      renderTemplateCards();
      drawPreview(performance.now() / 1000);
      scheduleProjectSave();
    });
  });
}

function populateOutputControls(): void {
  ratioSelect.innerHTML = (["16:9", "9:16", "1:1"] as AspectRatio[]).map((ratio) => `<option value="${ratio}">${ratio}</option>`).join("");
  ratioSelect.value = state.aspectRatio;
  fpsSelect.innerHTML = FRAME_RATES.map((fps) => `<option value="${fps}">${fps} fps</option>`).join("");
  fpsSelect.value = String(state.frameRate);
  updateResolutionOptions();
}

function updateResolutionOptions(): void {
  const presets = OUTPUT_PRESETS[state.aspectRatio];
  if (!presets.some((preset) => preset.id === state.presetId)) state.presetId = presets[1]?.id ?? presets[0].id;
  resolutionSelect.innerHTML = presets.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("");
  resolutionSelect.value = state.presetId;
  updateOutputLabels();
}

function configurationFromState(): RenderConfiguration {
  const preset = currentPreset();
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    templateId: state.templateId,
    text: { title: state.title, artist: state.artist },
    ...(state.coverUrl ? { coverImage: { kind: "data-url" as const, value: state.coverUrl, alt: "Cover art" } } : {}),
    ...(state.backgroundUrl ? { backgroundImage: { kind: "data-url" as const, value: state.backgroundUrl, alt: "Background" } } : {}),
    output: {
      aspectRatio: state.aspectRatio,
      width: preset.width,
      height: preset.height,
      frameRate: state.frameRate as 30 | 60,
    },
  };
}

function captureProjectSaveSnapshot() {
  return {
    projectId: currentProjectId,
    configuration: configurationFromState(),
    name: state.title.trim() || "Untitled Project",
    workspaceToken,
  };
}

const projectSaveCoordinator = new ProjectSaveCoordinator<RenderConfiguration, ProjectRecord>({
  create: (snapshot) => projectService.createProject(snapshot.name, snapshot.configuration),
  update: (snapshot) => projectService.updateProject(snapshot.projectId!, snapshot.configuration, snapshot.name),
  remove: (projectId) => projectService.deleteProject(projectId),
}, {
  currentProjectId: () => currentProjectId,
  workspaceToken: () => workspaceToken,
  applyCurrentProject: async (project) => {
    currentProjectId = project.id;
    await refreshProjects();
  },
});

function scheduleProjectSave(): void {
  window.clearTimeout(saveTimer);
  projectSaveCoordinator.schedule(captureProjectSaveSnapshot());
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void projectSaveCoordinator.flush().catch((error) => {
      renderStatus.textContent = error instanceof Error ? `無法保存專案：${error.message}` : "無法保存專案";
    });
  }, 250);
}

function flushPendingSave(): Promise<ProjectRecord | undefined> {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  return projectSaveCoordinator.flush();
}

async function saveProject(): Promise<ProjectRecord> {
  await flushPendingSave();
  const project = await projectSaveCoordinator.saveCurrent(captureProjectSaveSnapshot);
  if (!project) throw new Error("專案保存已取消。");
  return project;
}

function abandonPendingSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  projectSaveCoordinator.abandonPending();
  workspaceToken += 1;
}

function cancelProjectSaves(projectId: string): Promise<void> {
  if (currentProjectId === projectId) workspaceToken += 1;
  return projectSaveCoordinator.cancelProject(projectId);
}

function setProjectRowExpanded(row: HTMLElement, expanded: boolean): void {
  row.classList.toggle("expanded", expanded);
  const projectId = row.dataset.projectRow ?? null;
  if (expanded) expandedProjectId = projectId;
  else if (expandedProjectId === projectId) expandedProjectId = null;
  const toggle = row.querySelector<HTMLButtonElement>(".project-delete");
  const confirm = row.querySelector<HTMLButtonElement>(".project-delete-confirm");
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(expanded));
    const projectName = row.querySelector<HTMLElement>(".project-item strong")?.textContent ?? "專案";
    toggle.setAttribute("aria-label", `${expanded ? "收回刪除" : "展開刪除"} ${projectName}`);
  }
  if (confirm) {
    confirm.setAttribute("aria-hidden", String(!expanded));
    confirm.tabIndex = expanded ? 0 : -1;
  }
}

function collapseProjectRows(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".project-row.expanded").forEach((row) => {
    if (row !== except) setProjectRowExpanded(row, false);
  });
}

async function refreshProjects(): Promise<void> {
  const projects = await projectService.listProjects();
  const statuses = new Map(await Promise.all(projects.map(async (project) => {
    const latest = project.renders.at(-1);
    if (!latest) return [project.id, "尚未生成"] as const;
    if (latest.status !== "completed" || !latest.output) return [project.id, latest.status] as const;
    if (volatileOutputs.get(project.id)?.renderId === latest.id) {
      return [project.id, "MP4 已生成（僅此分頁）"] as const;
    }
    const output = await projectService.getOutput(project.id, latest.id);
    return [project.id, output ? "MP4 已生成" : "MP4 未保存"] as const;
  })));
  const list = document.querySelector<HTMLDivElement>("#project-list")!;
  list.innerHTML = projects.length ? projects.map((project) => {
    const status = statuses.get(project.id) ?? "尚未生成";
    const actionId = `project-actions-${project.id}`;
    return `<div class="project-row" data-project-row="${project.id}"><button class="project-item" data-project-id="${project.id}" aria-controls="${actionId}"><strong>${escapeHtml(project.name)}</strong><small>${status}</small></button><div class="project-actions" id="${actionId}"><button class="project-delete" type="button" data-delete-project="${project.id}" aria-label="展開刪除 ${escapeHtml(project.name)}" aria-expanded="false" aria-controls="${actionId}">×</button><button class="project-delete-confirm" type="button" data-confirm-delete="${project.id}" aria-label="確認刪除 ${escapeHtml(project.name)}" aria-hidden="true" tabindex="-1">刪除</button></div></div>`;
  }).join("") : '<p class="empty-projects">專案與輸出只會儲存在這個瀏覽器。</p>';
  list.querySelectorAll<HTMLButtonElement>("[data-project-id]").forEach((button) => button.addEventListener("click", () => {
    const row = button.closest<HTMLElement>(".project-row");
    if (!row) return;
    if (row.classList.contains("expanded")) {
      setProjectRowExpanded(row, false);
      return;
    }
    collapseProjectRows();
    void openProject(button.dataset.projectId!);
  }));
  list.querySelectorAll<HTMLButtonElement>("[data-delete-project]").forEach((button) => button.addEventListener("click", async () => {
    const row = button.closest<HTMLElement>(".project-row");
    if (!row) return;
    const expanded = row.classList.contains("expanded");
    collapseProjectRows(row);
    setProjectRowExpanded(row, !expanded);
  }));
  list.querySelectorAll<HTMLButtonElement>("[data-confirm-delete]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.confirmDelete!;
    button.disabled = true;
    workspaceNavigationToken += 1;
    if (currentProjectId === id) invalidateMediaRequests();
    await cancelActiveRenderForNavigation(id);
    const recoverySnapshot = currentProjectId === id ? captureProjectSaveSnapshot() : undefined;
    await cancelProjectSaves(id);
    try {
      await projectService.deleteProject(id);
    } catch (error) {
      projectSaveCoordinator.restoreProject(id);
      if (recoverySnapshot && currentProjectId === id) scheduleProjectSave();
      expandedProjectId = id;
      button.disabled = false;
      let message = error instanceof Error ? `無法刪除專案：${error.message}` : "無法刪除專案。";
      try {
        await refreshProjects();
      } catch (refreshError) {
        const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
        message = `${message}（專案列表更新失敗：${detail}）`;
      }
      renderStatus.textContent = message;
      return;
    }
    volatileOutputs.delete(id);
    if (currentProjectId === id) resetDraft();
    try {
      await refreshProjects();
    } catch (error) {
      renderStatus.textContent = error instanceof Error
        ? `專案已刪除，但列表更新失敗：${error.message}`
        : "專案已刪除，但列表更新失敗。";
    }
  }));
  if (expandedProjectId) {
    const expandedRow = list.querySelector<HTMLElement>(`.project-row[data-project-row="${expandedProjectId}"]`);
    if (expandedRow) setProjectRowExpanded(expandedRow, true);
    else expandedProjectId = null;
  }
  const estimate = await projectService.estimateQuota();
  document.querySelector("#storage-usage")!.textContent = estimate.quotaBytes
    ? `本機儲存 ${formatBytes(estimate.usageBytes ?? 0)} / ${formatBytes(estimate.quotaBytes)}`
    : "本機瀏覽器儲存";
}

async function openProject(projectId: string): Promise<void> {
  const navigationToken = ++workspaceNavigationToken;
  invalidateMediaRequests();
  await cancelActiveRenderForNavigation();
  if (navigationToken !== workspaceNavigationToken) return;
  await flushPendingSave();
  if (navigationToken !== workspaceNavigationToken) return;
  const project = await projectService.reopenProject(projectId);
  if (!project || navigationToken !== workspaceNavigationToken) return;
  const config = project.configuration;
  const coverUrl = config.coverImage?.value ?? null;
  const backgroundUrl = config.backgroundImage?.value ?? null;
  const [cover, background] = await Promise.all([
    coverUrl ? loadPreviewImage(coverUrl).catch(() => null) : null,
    backgroundUrl ? loadPreviewImage(backgroundUrl).catch(() => null) : null,
  ]);
  if (navigationToken !== workspaceNavigationToken) return;
  const previousProjectId = currentProjectId;
  workspaceToken += 1;
  currentProjectId = project.id;
  if (previousProjectId && previousProjectId !== project.id) {
    releaseVolatileOutputOnLeave(previousProjectId);
    clearOutputPreview();
  }
  state.templateId = config.templateId;
  state.title = config.text.title; state.artist = config.text.artist;
  state.aspectRatio = config.output.aspectRatio; state.frameRate = config.output.frameRate;
  const preset = OUTPUT_PRESETS[state.aspectRatio].find((item) => item.width === config.output.width && item.height === config.output.height);
  state.presetId = preset?.id ?? OUTPUT_PRESETS[state.aspectRatio][0].id;
  state.audioFile = null; state.duration = null;
  document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
  state.coverUrl = coverUrl; state.backgroundUrl = backgroundUrl;
  previewAssets.cover = cover;
  previewAssets.background = background;
  updateImagePicker("coverUrl", previewAssets.cover, config.coverImage ? "已保存封面圖" : undefined);
  updateImagePicker("backgroundUrl", previewAssets.background, config.backgroundImage ? "已保存背景圖" : undefined);
  document.querySelector<HTMLInputElement>("#cover-input")!.value = "";
  document.querySelector<HTMLInputElement>("#background-input")!.value = "";
  document.querySelector<HTMLInputElement>("#title-input")!.value = state.title;
  document.querySelector<HTMLInputElement>("#artist-input")!.value = state.artist;
  renderButton.disabled = true;
  updateAudioPicker(null);
  setFileStatus("重新生成前請再次選擇原始音訊。");
  renderTemplateCards(); populateOutputControls(); updateOutputLabels();
  await showLatestOutput(project);
}

async function showLatestOutput(project: ProjectRecord): Promise<void> {
  if (currentProjectId !== project.id) return;
  const actions = document.querySelector<HTMLDivElement>("#output-actions")!;
  const volatile = volatileOutputs.get(project.id);
  if (volatile) {
    presentOutputBlob(project.id, volatile.renderId, volatile.blob, volatile.projectName);
    renderStatus.textContent = "最新生成版本僅保留在此分頁，可預覽或下載；關閉分頁前請先下載。";
    return;
  }
  const completed = [...project.renders].reverse().filter((render) => render.status === "completed");
  if (!completed.length) { clearOutputPreview(); actions.hidden = true; return; }
  for (const [index, render] of completed.entries()) {
    const stored = await projectService.getOutput(project.id, render.id);
    if (currentProjectId !== project.id) return;
    if (!stored) continue;
    presentOutputBlob(project.id, render.id, stored.blob, project.name);
    renderStatus.textContent = index === 0
      ? "本機 MP4 可預覽與下載"
      : "最新版本未保存在本機；目前顯示的是較舊的已保存版本。";
    return;
  }
  if (currentProjectId !== project.id) return;
  clearOutputPreview();
  actions.hidden = true;
  renderStatus.textContent = "本機 MP4 已不存在；請重新上傳音訊生成。";
}

function presentOutputBlob(projectId: string, renderId: string, blob: Blob, projectName: string): void {
  if (currentProjectId !== projectId) return;
  const actions = document.querySelector<HTMLDivElement>("#output-actions")!;
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  const link = document.querySelector<HTMLAnchorElement>("#download-link")!;
  const placeholder = document.querySelector<HTMLDivElement>("#video-placeholder")!;
  revokeCurrentOutputUrl();
  currentOutputUrl = URL.createObjectURL(blob);
  link.href = currentOutputUrl; link.download = `${safeFileName(projectName)}.mp4`;
  video.src = currentOutputUrl; video.hidden = false; placeholder.hidden = true;
  actions.dataset.renderId = renderId; actions.hidden = false;
}

function revokeCurrentOutputUrl(): void {
  if (currentOutputUrl) URL.revokeObjectURL(currentOutputUrl);
  currentOutputUrl = null;
}

function clearOutputPreview(): void {
  revokeCurrentOutputUrl();
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  const placeholder = document.querySelector<HTMLDivElement>("#video-placeholder")!;
  video.pause(); video.removeAttribute("src"); video.load(); video.hidden = true; placeholder.hidden = false;
  document.querySelector<HTMLAnchorElement>("#download-link")!.removeAttribute("href");
}

function releaseVolatileOutputOnLeave(projectId: string): void {
  if (!volatileOutputs.delete(projectId)) return;
  const row = [...document.querySelectorAll<HTMLElement>(".project-row")]
    .find((candidate) => candidate.dataset.projectRow === projectId);
  const status = row?.querySelector<HTMLElement>("small");
  if (status) status.textContent = "MP4 未保存";
}

function resetDraft(): void {
  if (currentProjectId) releaseVolatileOutputOnLeave(currentProjectId);
  workspaceNavigationToken += 1;
  invalidateMediaRequests();
  abandonPendingSave();
  currentProjectId = null; state.templateId = "spectrum-cover"; state.aspectRatio = "16:9"; state.presetId = "16-9-1080p"; state.frameRate = 30;
  state.title = "Midnight Signal"; state.artist = "Your Artist"; state.audioFile = null; state.duration = null; state.coverUrl = null; state.backgroundUrl = null;
  document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
  updateAudioPicker(null);
  previewAssets.cover = null; previewAssets.background = null;
  updateImagePicker("coverUrl", null);
  updateImagePicker("backgroundUrl", null);
  document.querySelector<HTMLInputElement>("#cover-input")!.value = "";
  document.querySelector<HTMLInputElement>("#background-input")!.value = "";
  document.querySelector<HTMLInputElement>("#title-input")!.value = state.title; document.querySelector<HTMLInputElement>("#artist-input")!.value = state.artist;
  renderButton.disabled = true; document.querySelector<HTMLDivElement>("#output-actions")!.hidden = true; clearOutputPreview();
  setFileStatus("尚未選擇音訊"); renderTemplateCards(); populateOutputControls(); updateOutputLabels();
}

async function startNewDraft(): Promise<void> {
  const navigationToken = ++workspaceNavigationToken;
  invalidateMediaRequests();
  await cancelActiveRenderForNavigation();
  if (navigationToken !== workspaceNavigationToken) return;
  if (currentProjectId) await flushPendingSave();
  if (navigationToken !== workspaceNavigationToken) return;
  resetDraft();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function safeFileName(value: string): string { return value.trim().replace(/[^a-z0-9\-_]+/gi, "-").replace(/^-|-$/g, "") || "music-visualizer"; }

async function decodeAudioForRender(file: File, isCurrent: () => boolean): Promise<AudioBuffer> {
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("瀏覽器無法解碼音訊。請改用最新版 Chrome 或 Edge。");
  const audioContext = new AudioContextCtor();
  try {
    const bytes = await file.arrayBuffer();
    if (!isCurrent()) throw new Error("音訊解碼請求已失效。");
    const decoded = await audioContext.decodeAudioData(bytes);
    if (!isCurrent()) throw new Error("音訊解碼請求已失效。");
    return decoded;
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

function setRenderProgress(progress: number, message: string): void {
  const percentage = Math.max(0, Math.min(100, Math.round(progress * 100)));
  progressValue.textContent = `${percentage}%`;
  progressBar.style.width = `${percentage}%`;
  renderStatus.textContent = message;
}

async function startRender(): Promise<void> {
  if (!state.audioFile || !capabilitySupported || activeRenderSession) return;
  const sourceAudio = state.audioFile;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const session: ActiveRenderSession = {
    workspaceToken,
    sourceAudio,
    ...(currentProjectId ? { projectId: currentProjectId } : {}),
    cancelRequested: false,
    finalized: false,
    updates: Promise.resolve(),
    finished,
    resolveFinished,
  };
  activeRenderSession = session;
  try {
    renderButton.disabled = true;
    cancelButton.hidden = false;
    setRenderProgress(0, "正在解碼音訊…");
    const project = await saveProject();
    if (session.finalized) return;
    session.projectId = project.id;
    if (session.cancelRequested) {
      await cancelRenderSession(session);
      return;
    }
    const renderRecord = await projectSaveCoordinator.runExclusive(() => projectService.queueRender(project.id));
    if (session.finalized) return;
    session.renderId = renderRecord.id;
    if (session.cancelRequested) {
      await cancelRenderSession(session);
      return;
    }
    const audioBuffer = await decodeAudioForRender(sourceAudio, () => (
      activeRenderSession === session && session.workspaceToken === workspaceToken && !session.finalized
    ));
    if (session.finalized) return;
    if (session.cancelRequested) {
      await cancelRenderSession(session);
      return;
    }
    const renderConfig = renderConfigFromDomain(project.configuration);
    const currentCapability = await detectCapabilities(renderConfig.output);
    if (session.finalized) return;
    if (!currentCapability.supported) throw new Error(currentCapability.reasons.join(" "));
    if (session.cancelRequested) {
      await cancelRenderSession(session);
      return;
    }
    const worker = new Worker(new URL("./workers/render-worker.ts", import.meta.url), { type: "module" });
    worker.onerror = (event) => enqueueRenderUpdate(session, () => failRenderSession(
      session,
      new Error(event.message || "渲染 Worker 發生錯誤。"),
      "worker-error",
    ));
    const controller = new RenderController(worker);
    session.controller = controller;
    controller.onUpdate((update) => enqueueRenderUpdate(session, () => handleRenderUpdate(session, update)));
    controller.startFromAudioBuffer(renderConfig, audioBuffer, renderRecord.id);
  } catch (error) {
    await failRenderSession(
      session,
      error instanceof Error ? error : new Error(String(error)),
      "render-start",
    );
  }
}

function enqueueRenderUpdate(session: ActiveRenderSession, operation: () => Promise<void>): void {
  session.updates = session.updates.then(operation).catch((error) => failRenderSession(
    session,
    error instanceof Error ? error : new Error(String(error)),
    "render-update",
  ));
}

async function handleRenderUpdate(session: ActiveRenderSession, update: RenderUpdate): Promise<void> {
  if (activeRenderSession !== session || session.finalized || !session.projectId || !session.renderId) return;
  if (update.response.type === "start") {
    await projectSaveCoordinator.runExclusive(() => projectService.markRendering(session.projectId!, session.renderId!));
    setRenderProgress(0, "正在瀏覽器中生成 MP4…");
    return;
  }
  if (update.response.type === "progress") {
    setRenderProgress(update.response.progress, renderProgressMessage(update.response.frame, update.response.totalFrames, update.response.etaMs));
    return;
  }
  if (update.response.type === "complete") {
    if (!claimRenderSession(session)) return;
    const { output, metadata } = update.response;
    const projectName = state.title.trim() || "Untitled Project";
    volatileOutputs.delete(session.projectId);
    volatileOutputs.set(session.projectId, { renderId: session.renderId, blob: output, projectName });
    presentOutputBlob(session.projectId, session.renderId, output, projectName);
    let message = "MP4 已生成，但未能保存到本機；目前仍可預覽與下載，關閉分頁前請先下載。";
    try {
      const result = await projectSaveCoordinator.runExclusive(() => projectService.recordCompletedRender(session.projectId!, session.renderId!, output, {
        mimeType: "video/mp4",
        byteLength: output.size,
        durationMs: metadata.duration * 1000,
        width: metadata.width,
        height: metadata.height,
        frameRate: metadata.frameRate,
        createdAt: new Date().toISOString(),
      }));
      if (result.outputSaved) {
        volatileOutputs.delete(session.projectId);
        message = "MP4 已生成並保存在本機瀏覽器";
      } else {
        message = "MP4 已生成，但本機空間不足；目前仍可預覽與下載，關閉分頁前請先下載。";
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message = `MP4 已生成，但保存失敗（${detail}）；目前仍可預覽與下載。`;
    } finally {
      await finishRenderSession(session, message, true);
    }
    return;
  }
  if (update.response.type === "cancel") {
    await cancelRenderSession(session);
    return;
  }
  if (update.response.type === "error") {
    await failRenderSession(session, new Error(update.response.error.message), update.response.error.code);
  }
}

function claimRenderSession(session: ActiveRenderSession): boolean {
  if (activeRenderSession !== session || session.finalized) return false;
  session.finalized = true;
  return true;
}

async function cancelRenderSession(session: ActiveRenderSession): Promise<void> {
  if (!claimRenderSession(session)) return;
  let message = "渲染已取消，專案設定仍保留。";
  try {
    if (session.projectId && session.renderId) {
      await projectSaveCoordinator.runExclusive(() => projectService.markCancelled(session.projectId!, session.renderId!));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    message = `渲染已取消，但無法更新本機紀錄：${detail}`;
  } finally {
    await finishRenderSession(session, message, false);
  }
}

async function failRenderSession(session: ActiveRenderSession, error: Error, code: string): Promise<void> {
  if (!claimRenderSession(session)) return;
  let message = error.message;
  try {
    if (session.projectId && session.renderId) {
      await projectSaveCoordinator.runExclusive(() => projectService.markFailed(session.projectId!, session.renderId!, { code, message: error.message }));
    }
  } catch (storageError) {
    const detail = storageError instanceof Error ? storageError.message : String(storageError);
    message = `${error.message}（無法更新本機紀錄：${detail}）`;
  } finally {
    await finishRenderSession(session, message, false);
  }
}

async function finishRenderSession(session: ActiveRenderSession, message: string, completed: boolean): Promise<void> {
  try {
    try {
      session.controller?.dispose();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message = `${message}（Worker 清理失敗：${detail}）`;
    }
    session.controller = undefined;
    if (activeRenderSession === session) activeRenderSession = null;
    const ownsWorkspace = session.workspaceToken === workspaceToken;
    cancelButton.hidden = true;
    if (ownsWorkspace) {
      setRenderProgress(completed ? 1 : 0, message);
      if (state.audioFile === session.sourceAudio) {
        state.audioFile = null;
        state.duration = null;
        document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
        updateAudioPicker(null);
        renderButton.disabled = true;
        setFileStatus("來源音訊已從工作階段釋放；重新生成時請再次選擇。", completed ? "success" : "");
      } else {
        renderButton.disabled = !state.audioFile || !capabilitySupported;
      }
    } else {
      renderButton.disabled = !state.audioFile || !capabilitySupported;
    }
    try {
      await refreshProjects();
    } catch (error) {
      if (ownsWorkspace) {
        const detail = error instanceof Error ? error.message : String(error);
        renderStatus.textContent = `${message}（專案列表更新失敗：${detail}）`;
      }
    }
  } finally {
    session.resolveFinished();
  }
}

async function cancelActiveRenderForNavigation(projectId?: string): Promise<void> {
  const session = activeRenderSession;
  if (!session || (projectId && session.projectId !== projectId)) return;
  if (session.finalized) {
    await session.finished;
    return;
  }
  session.cancelRequested = true;
  if (!session.renderId) {
    await session.finished;
    return;
  }
  session.controller?.cancel();
  enqueueRenderUpdate(session, () => cancelRenderSession(session));
  await session.finished;
}

function currentPreset() {
  return OUTPUT_PRESETS[state.aspectRatio].find((preset) => preset.id === state.presetId) ?? OUTPUT_PRESETS[state.aspectRatio][0];
}

function updateOutputLabels(): void {
  const preset = currentPreset();
  document.querySelector("#dimensions-label")!.textContent = `${preset.width} × ${preset.height}`;
  document.querySelector("#preview-meta")!.textContent = `${state.aspectRatio} · ${preset.label} · ${state.frameRate}fps`;
  stage.dataset.ratio = state.aspectRatio;
  fitPreviewStage();
  const scale = Math.min(960 / preset.width, 600 / preset.height);
  canvas.width = Math.round(preset.width * scale);
  canvas.height = Math.round(preset.height * scale);
  drawPreview(performance.now() / 1000);
  void refreshCapability();
}

async function refreshCapability(): Promise<void> {
  const requestToken = capabilityRequests.begin();
  capability.textContent = "正在檢查編碼能力…";
  try {
    const result = await detectCapabilities(renderConfigFromDomain(configurationFromState()).output);
    if (!capabilityRequests.isCurrent(requestToken)) return;
    capabilitySupported = result.supported;
    capability.textContent = result.supported ? "本機 MP4 編碼可用" : result.reasons.join(" ");
    capability.style.color = result.supported ? "#64f0d0" : "#ff6f88";
  } catch (error) {
    if (!capabilityRequests.isCurrent(requestToken)) return;
    capabilitySupported = false;
    capability.textContent = error instanceof Error ? error.message : "無法檢查編碼能力";
    capability.style.color = "#ff6f88";
  }
  renderButton.disabled = !state.audioFile || !capabilitySupported || Boolean(activeRenderSession);
}

function drawPreview(time: number): void {
  const { width, height } = canvas;
  const scene = createScene(state.templateId, {
    title: state.title,
    artist: state.artist,
    assets: {
      coverImage: previewAssets.cover?.complete ? previewAssets.cover : undefined,
      backgroundImage: previewAssets.background?.complete ? previewAssets.background : undefined,
    },
  });
  scene.render(context, {
    time,
    frame: Math.floor(time * state.frameRate),
    progress: (time % previewAnalysis.duration) / previewAnalysis.duration,
    width,
    height,
    analysis: previewAnalysis,
  });
}

function setFileStatus(message: string, kind = ""): void {
  const element = document.querySelector<HTMLParagraphElement>("#file-status")!;
  element.textContent = message; element.className = `file-status ${kind}`;
}

function updateAudioPicker(file: File | null): void {
  const placeholder = document.querySelector<HTMLSpanElement>("#audio-placeholder");
  const note = document.querySelector<HTMLSpanElement>("#audio-note");
  const title = document.querySelector<HTMLElement>("#audio-drop-title");
  const meta = document.querySelector<HTMLElement>("#audio-drop-meta");
  if (!placeholder || !note || !title || !meta) return;
  if (file) {
    placeholder.hidden = true;
    note.hidden = false;
    title.textContent = file.name;
    const format = file.type.split("/").at(-1)?.toUpperCase() || file.name.split(".").at(-1)?.toUpperCase() || "AUDIO";
    meta.textContent = `${format} · ${formatBytes(file.size)}`;
  } else {
    placeholder.hidden = false;
    note.hidden = true;
    title.textContent = "拖曳或點擊選擇";
    meta.textContent = "MP3 · WAV · M4A";
  }
}

async function inspectAudio(file: File): Promise<void> {
  const requestId = audioRequests.begin();
  cancelPendingAudioInspection?.();
  const requestWorkspace = workspaceToken;
  const isCurrent = () => audioRequests.isCurrent(requestId) && workspaceToken === requestWorkspace;
  const problem = validateAudioFile(file);
  if (problem) {
    if (isCurrent()) { state.audioFile = null; state.duration = null; renderButton.disabled = true; updateAudioPicker(null); setFileStatus(problem, "error"); }
    return;
  }
  const url = URL.createObjectURL(file);
  const audio = new Audio(); audio.preload = "metadata"; audio.src = url;
  let cancelInspection: (() => void) | undefined;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (value: number | Error): void => {
        if (settled) return;
        settled = true;
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      cancelInspection = () => finish(new Error("音訊 metadata 請求已失效。"));
      cancelPendingAudioInspection = cancelInspection;
      audio.onloadedmetadata = () => finish(audio.duration);
      audio.onerror = () => finish(new Error("無法解碼這個音訊檔案。"));
    });
    if (!isCurrent()) return;
    const durationProblem = validateAudioDuration(duration);
    if (durationProblem) throw new Error(durationProblem);
    state.audioFile = file; state.duration = duration;
    updateAudioPicker(file);
    renderButton.disabled = false;
    setFileStatus(`${file.name} · ${formatBytes(file.size)} · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}`, "success");
    await refreshCapability();
    if (!isCurrent()) return;
    scheduleProjectSave();
  } catch (error) {
    if (!isCurrent()) return;
    state.audioFile = null; state.duration = null; renderButton.disabled = true; updateAudioPicker(null);
    setFileStatus(error instanceof Error ? error.message : "無法讀取音訊。", "error");
  } finally {
    if (cancelInspection && cancelPendingAudioInspection === cancelInspection) cancelPendingAudioInspection = null;
    URL.revokeObjectURL(url); audio.removeAttribute("src"); audio.load();
  }
}

function loadPreviewImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("無法顯示圖片。")); image.src = url;
  });
}

type ImageTarget = "coverUrl" | "backgroundUrl";

function invalidateMediaRequests(): void {
  audioRequests.begin();
  cancelPendingAudioInspection?.();
  cancelPendingAudioInspection = null;
  imageRequests.coverUrl.begin();
  imageRequests.backgroundUrl.begin();
}

function imagePickerIds(target: ImageTarget): { dropzone: string; input: string; preview: string; name: string; remove: string } {
  return target === "coverUrl"
    ? { dropzone: "#cover-dropzone", input: "#cover-input", preview: "#cover-preview", name: "#cover-name", remove: "#cover-remove" }
    : { dropzone: "#background-dropzone", input: "#background-input", preview: "#background-preview", name: "#background-name", remove: "#background-remove" };
}

function updateImagePicker(target: ImageTarget, image: HTMLImageElement | null, filename?: string): void {
  const ids = imagePickerIds(target);
  const preview = document.querySelector<HTMLSpanElement>(ids.preview);
  const imageElement = document.querySelector<HTMLImageElement>(`${ids.preview}-image`);
  const placeholder = preview?.querySelector<HTMLSpanElement>(".image-placeholder");
  const name = document.querySelector<HTMLElement>(ids.name);
  const remove = document.querySelector<HTMLButtonElement>(ids.remove);
  if (!preview || !imageElement || !placeholder || !name || !remove) return;
  if (image) {
    imageElement.src = image.src;
    imageElement.hidden = false;
    placeholder.hidden = true;
    preview.classList.add("has-image");
    name.textContent = filename ?? "已選擇圖片";
    remove.hidden = false;
  } else {
    imageElement.removeAttribute("src");
    imageElement.hidden = true;
    placeholder.hidden = false;
    preview.classList.remove("has-image");
    name.textContent = "尚未選擇圖片";
    remove.hidden = true;
  }
}

function attachImageInput(target: ImageTarget): void {
  const ids = imagePickerIds(target);
  const input = document.querySelector<HTMLInputElement>(ids.input)!;
  const dropzone = document.querySelector<HTMLElement>(ids.dropzone)!;
  const remove = document.querySelector<HTMLButtonElement>(ids.remove)!;
  const applyFile = async (file: File): Promise<void> => {
    const requestId = imageRequests[target].begin();
    const requestWorkspace = workspaceToken;
    const isCurrent = () => imageRequests[target].isCurrent(requestId) && workspaceToken === requestWorkspace;
    try {
      const normalized = await normalizeImageFile(file, { isCurrent });
      if (!isCurrent()) {
        normalized.image.src = "";
        return;
      }
      state[target] = normalized.dataUrl;
      if (target === "coverUrl") previewAssets.cover = normalized.image; else previewAssets.background = normalized.image;
      updateImagePicker(target, normalized.image, normalized.resized ? `${file.name}（已縮放）` : file.name);
      drawPreview(performance.now() / 1000);
      scheduleProjectSave();
    } catch (error) {
      if (!isCurrent()) return;
      setFileStatus(error instanceof Error ? error.message : "無法讀取圖片。", "error");
    }
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void applyFile(file);
  });
  ["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  }));
  dropzone.addEventListener("drop", (event) => {
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (file) void applyFile(file);
  });
  remove.addEventListener("click", () => {
    imageRequests[target].begin();
    state[target] = null;
    if (target === "coverUrl") previewAssets.cover = null; else previewAssets.background = null;
    input.value = "";
    updateImagePicker(target, null);
    drawPreview(performance.now() / 1000);
    scheduleProjectSave();
  });
}

document.querySelector<HTMLInputElement>("#audio-input")!.addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]; if (file) void inspectAudio(file);
});
const audioDropzone = document.querySelector<HTMLElement>("#audio-dropzone")!;
["dragenter", "dragover"].forEach((eventName) => audioDropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  audioDropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => audioDropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  audioDropzone.classList.remove("dragging");
}));
audioDropzone.addEventListener("drop", (event) => {
  const file = (event as DragEvent).dataTransfer?.files?.[0];
  if (file) void inspectAudio(file);
});
document.querySelector<HTMLInputElement>("#title-input")!.addEventListener("input", (event) => { state.title = (event.target as HTMLInputElement).value; drawPreview(performance.now() / 1000); scheduleProjectSave(); });
document.querySelector<HTMLInputElement>("#artist-input")!.addEventListener("input", (event) => { state.artist = (event.target as HTMLInputElement).value; drawPreview(performance.now() / 1000); scheduleProjectSave(); });
attachImageInput("coverUrl");
attachImageInput("backgroundUrl");
ratioSelect.addEventListener("change", () => { state.aspectRatio = ratioSelect.value as AspectRatio; updateResolutionOptions(); scheduleProjectSave(); });
resolutionSelect.addEventListener("change", () => { state.presetId = resolutionSelect.value; updateOutputLabels(); scheduleProjectSave(); });
fpsSelect.addEventListener("change", () => { state.frameRate = Number(fpsSelect.value); updateOutputLabels(); scheduleProjectSave(); });
document.querySelector<HTMLButtonElement>("#new-project")!.addEventListener("click", () => {
  void startNewDraft().catch((error) => {
    renderStatus.textContent = error instanceof Error ? error.message : "無法切換到新專案。";
  });
});
document.querySelector<HTMLButtonElement>("#delete-output")!.addEventListener("click", async () => {
  if (!currentProjectId) return;
  const projectId = currentProjectId;
  const renderId = document.querySelector<HTMLDivElement>("#output-actions")!.dataset.renderId;
  if (!renderId) return;
  await projectSaveCoordinator.runExclusive(() => projectService.deleteOutput(projectId, renderId));
  if (volatileOutputs.get(projectId)?.renderId === renderId) volatileOutputs.delete(projectId);
  if (currentProjectId !== projectId) return;
  document.querySelector<HTMLDivElement>("#output-actions")!.hidden = true;
  clearOutputPreview();
  await refreshProjects();
});

renderButton.addEventListener("click", () => void startRender());
cancelButton.addEventListener("click", () => {
  const session = activeRenderSession;
  if (!session || session.finalized) return;
  session.cancelRequested = true;
  renderStatus.textContent = "正在取消渲染…";
  session.controller?.cancel();
});

renderTemplateCards();
populateOutputControls();
drawPreview(0);
let animationFrame = 0;
function animate(now: number): void { drawPreview(now / 1000); animationFrame = requestAnimationFrame(animate); }
animationFrame = requestAnimationFrame(animate);
window.addEventListener("beforeunload", () => { cancelAnimationFrame(animationFrame); stageResizeObserver?.disconnect(); revokeCurrentOutputUrl(); });
void projectService.reconcileInterruptedRenders().then(refreshProjects).catch((error) => {
  document.querySelector("#storage-usage")!.textContent = error instanceof Error ? error.message : "無法開啟本機資料庫";
});
