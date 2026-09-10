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
let activeProjectId: string | null = null;
let activeRenderId: string | null = null;
let renderController: RenderController | null = null;
let cancelRequested = false;
let capabilitySupported = false;
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
        </div></section>
        <section class="panel preview-panel">
          <div class="preview-head"><span>輸出預覽</span><span class="capability" id="capability">正在檢查編碼能力…</span></div>
          <div class="stage-wrap"><div class="stage" id="stage" data-ratio="16:9"><canvas id="preview-canvas" width="960" height="540"></canvas><div class="stage-overlay"><span>PREVIEW</span><span id="preview-meta">16:9 · 1080p · 30fps</span></div></div></div>
          <div class="render-controls">
            <div class="status-row"><span id="render-status">選擇音訊後即可生成</span><span id="progress-value">0%</span></div>
            <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
            <div class="actions"><button class="primary" id="render-button" disabled>生成 MP4</button><button class="secondary" id="cancel-button" hidden>取消</button></div>
            <div class="output-actions" id="output-actions" hidden><a id="download-link" download="music-visualizer.mp4">下載 MP4</a><button id="delete-output">刪除輸出</button></div>
            <video class="output-preview" id="output-preview" controls playsinline hidden></video>
          </div>
        </section>
      </div>
    </section>
  </main>`;

const canvas = document.querySelector<HTMLCanvasElement>("#preview-canvas")!;
const context = canvas.getContext("2d")!;
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

function scheduleProjectSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveProject().catch((error) => {
    renderStatus.textContent = error instanceof Error ? `無法保存專案：${error.message}` : "無法保存專案";
  }), 250);
}

async function saveProject(): Promise<ProjectRecord> {
  const configuration = configurationFromState();
  const name = state.title.trim() || "Untitled Project";
  const project = currentProjectId
    ? await projectService.updateProject(currentProjectId, configuration, name)
    : await projectService.createProject(name, configuration);
  currentProjectId = project.id;
  await refreshProjects();
  return project;
}

async function refreshProjects(): Promise<void> {
  const projects = await projectService.listProjects();
  const list = document.querySelector<HTMLDivElement>("#project-list")!;
  list.innerHTML = projects.length ? projects.map((project) => {
    const latest = project.renders.at(-1);
    const status = latest?.status === "completed" && latest.output ? "MP4 已生成" : latest?.status ?? "尚未生成";
    return `<div class="project-row"><button class="project-item" data-project-id="${project.id}"><strong>${escapeHtml(project.name)}</strong><small>${status}</small></button><button class="project-delete" data-delete-project="${project.id}" aria-label="刪除 ${escapeHtml(project.name)}">×</button></div>`;
  }).join("") : '<p class="empty-projects">專案與輸出只會儲存在這個瀏覽器。</p>';
  list.querySelectorAll<HTMLButtonElement>("[data-project-id]").forEach((button) => button.addEventListener("click", () => void openProject(button.dataset.projectId!)));
  list.querySelectorAll<HTMLButtonElement>("[data-delete-project]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.deleteProject!;
    if (!window.confirm("刪除這個專案與本機 MP4？此操作無法復原。")) return;
    await projectService.deleteProject(id);
    if (currentProjectId === id) resetDraft();
    await refreshProjects();
  }));
  const estimate = await projectService.estimateQuota();
  document.querySelector("#storage-usage")!.textContent = estimate.quotaBytes
    ? `本機儲存 ${formatBytes(estimate.usageBytes ?? 0)} / ${formatBytes(estimate.quotaBytes)}`
    : "本機瀏覽器儲存";
}

async function openProject(projectId: string): Promise<void> {
  const project = await projectService.reopenProject(projectId); if (!project) return;
  currentProjectId = project.id;
  const config = project.configuration;
  state.templateId = config.templateId;
  state.title = config.text.title; state.artist = config.text.artist;
  state.aspectRatio = config.output.aspectRatio; state.frameRate = config.output.frameRate;
  const preset = OUTPUT_PRESETS[state.aspectRatio].find((item) => item.width === config.output.width && item.height === config.output.height);
  state.presetId = preset?.id ?? OUTPUT_PRESETS[state.aspectRatio][0].id;
  state.audioFile = null; state.duration = null;
  document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
  state.coverUrl = config.coverImage?.value ?? null; state.backgroundUrl = config.backgroundImage?.value ?? null;
  previewAssets.cover = state.coverUrl ? await loadPreviewImage(state.coverUrl).catch(() => null) : null;
  previewAssets.background = state.backgroundUrl ? await loadPreviewImage(state.backgroundUrl).catch(() => null) : null;
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
  const latest = [...project.renders].reverse().find((render) => render.status === "completed");
  const actions = document.querySelector<HTMLDivElement>("#output-actions")!;
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  if (!latest) { clearOutputPreview(); actions.hidden = true; return; }
  const stored = await projectService.getOutput(project.id, latest.id);
  if (!stored) { clearOutputPreview(); actions.hidden = true; document.querySelector("#render-status")!.textContent = "本機 MP4 已不存在；請重新上傳音訊生成。"; return; }
  const link = document.querySelector<HTMLAnchorElement>("#download-link")!;
  revokeCurrentOutputUrl();
  currentOutputUrl = URL.createObjectURL(stored.blob);
  link.href = currentOutputUrl; link.download = `${safeFileName(project.name)}.mp4`;
  video.src = currentOutputUrl; video.hidden = false;
  actions.dataset.renderId = latest.id; actions.hidden = false;
  document.querySelector("#render-status")!.textContent = "本機 MP4 可預覽與下載";
}

function revokeCurrentOutputUrl(): void {
  if (currentOutputUrl) URL.revokeObjectURL(currentOutputUrl);
  currentOutputUrl = null;
}

function clearOutputPreview(): void {
  revokeCurrentOutputUrl();
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  video.pause(); video.removeAttribute("src"); video.load(); video.hidden = true;
  document.querySelector<HTMLAnchorElement>("#download-link")!.removeAttribute("href");
}

function resetDraft(): void {
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function safeFileName(value: string): string { return value.trim().replace(/[^a-z0-9\-_]+/gi, "-").replace(/^-|-$/g, "") || "music-visualizer"; }

async function decodeAudioForRender(file: File): Promise<AudioBuffer> {
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("瀏覽器無法解碼音訊。請改用最新版 Chrome 或 Edge。");
  const audioContext = new AudioContextCtor();
  try {
    return await audioContext.decodeAudioData(await file.arrayBuffer());
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
  if (!state.audioFile || !capabilitySupported || renderController) return;
  cancelRequested = false;
  const sourceAudio = state.audioFile;
  let project: ProjectRecord | undefined;
  let renderId: string | undefined;
  try {
    renderButton.disabled = true;
    cancelButton.hidden = false;
    setRenderProgress(0, "正在解碼音訊…");
    project = await saveProject();
    const renderRecord = await projectService.queueRender(project.id);
    renderId = renderRecord.id;
    activeProjectId = project.id;
    activeRenderId = renderId;
    const audioBuffer = await decodeAudioForRender(sourceAudio);
    const renderConfig = renderConfigFromDomain(project.configuration);
    const currentCapability = await detectCapabilities(renderConfig.output);
    if (!currentCapability.supported) throw new Error(currentCapability.reasons.join(" "));
    if (cancelRequested) {
      await projectService.markCancelled(project.id, renderId);
      await finishRenderSession("渲染已取消，專案設定仍保留。", false);
      return;
    }
    const worker = new Worker(new URL("./workers/render-worker.ts", import.meta.url), { type: "module" });
    worker.onerror = (event) => void handleRenderFailure(new Error(event.message || "渲染 Worker 發生錯誤。"));
    renderController = new RenderController(worker);
    renderController.onUpdate((update) => void handleRenderUpdate(update));
    renderController.startFromAudioBuffer(renderConfig, audioBuffer, renderId);
  } catch (error) {
    if (project && renderId) {
      await projectService.markFailed(project.id, renderId, {
        code: "render-start",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await finishRenderSession(error instanceof Error ? error.message : "無法開始渲染。", false);
  }
}

async function handleRenderUpdate(update: RenderUpdate): Promise<void> {
  if (!activeProjectId || !activeRenderId) return;
  if (update.response.type === "start") {
    await projectService.markRendering(activeProjectId, activeRenderId);
    setRenderProgress(0, "正在瀏覽器中生成 MP4…");
    return;
  }
  if (update.response.type === "progress") {
    setRenderProgress(update.response.progress, renderProgressMessage(update.response.frame, update.response.totalFrames, update.response.etaMs));
    return;
  }
  if (update.response.type === "complete") {
    const { output, metadata } = update.response;
    const result = await projectService.recordCompletedRender(activeProjectId, activeRenderId, output, {
      mimeType: "video/mp4",
      byteLength: output.size,
      durationMs: metadata.duration * 1000,
      width: metadata.width,
      height: metadata.height,
      frameRate: metadata.frameRate,
      createdAt: new Date().toISOString(),
    });
    const project = await projectService.reopenProject(activeProjectId);
    if (project) await showLatestOutput(project);
    await finishRenderSession(
      result.outputSaved
        ? "MP4 已生成並保存在本機瀏覽器"
        : "MP4 已生成，但本機空間不足；請直接下載並刪除舊輸出。",
      true,
    );
    return;
  }
  if (update.response.type === "cancel") {
    await projectService.markCancelled(activeProjectId, activeRenderId);
    await finishRenderSession("渲染已取消，專案設定仍保留。", false);
    return;
  }
  if (update.response.type === "error") {
    await projectService.markFailed(activeProjectId, activeRenderId, update.response.error);
    await finishRenderSession(update.response.error.message, false);
  }
}

async function handleRenderFailure(error: Error): Promise<void> {
  if (activeProjectId && activeRenderId) {
    await projectService.markFailed(activeProjectId, activeRenderId, {
      code: "worker-error",
      message: error.message,
    }).catch(() => undefined);
  }
  await finishRenderSession(error.message, false);
}

async function finishRenderSession(message: string, completed: boolean): Promise<void> {
  renderController?.dispose();
  renderController = null;
  cancelRequested = false;
  activeProjectId = null;
  activeRenderId = null;
  state.audioFile = null;
  state.duration = null;
  document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
  updateAudioPicker(null);
  cancelButton.hidden = true;
  renderButton.disabled = true;
  setRenderProgress(completed ? 1 : 0, message);
  setFileStatus("來源音訊已從工作階段釋放；重新生成時請再次選擇。", completed ? "success" : "");
  await refreshProjects();
}

function currentPreset() {
  return OUTPUT_PRESETS[state.aspectRatio].find((preset) => preset.id === state.presetId) ?? OUTPUT_PRESETS[state.aspectRatio][0];
}

function updateOutputLabels(): void {
  const preset = currentPreset();
  document.querySelector("#dimensions-label")!.textContent = `${preset.width} × ${preset.height}`;
  document.querySelector("#preview-meta")!.textContent = `${state.aspectRatio} · ${preset.label} · ${state.frameRate}fps`;
  const stage = document.querySelector<HTMLDivElement>("#stage")!;
  stage.dataset.ratio = state.aspectRatio;
  const scale = Math.min(960 / preset.width, 600 / preset.height);
  canvas.width = Math.round(preset.width * scale);
  canvas.height = Math.round(preset.height * scale);
  drawPreview(performance.now() / 1000);
  void refreshCapability();
}

async function refreshCapability(): Promise<void> {
  capability.textContent = "正在檢查編碼能力…";
  try {
    const result = await detectCapabilities(renderConfigFromDomain(configurationFromState()).output);
    capabilitySupported = result.supported;
    capability.textContent = result.supported ? "本機 MP4 編碼可用" : result.reasons.join(" ");
    capability.style.color = result.supported ? "#64f0d0" : "#ff6f88";
  } catch (error) {
    capabilitySupported = false;
    capability.textContent = error instanceof Error ? error.message : "無法檢查編碼能力";
    capability.style.color = "#ff6f88";
  }
  renderButton.disabled = !state.audioFile || !capabilitySupported || Boolean(renderController);
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
  const problem = validateAudioFile(file);
  if (problem) { state.audioFile = null; state.duration = null; renderButton.disabled = true; updateAudioPicker(null); setFileStatus(problem, "error"); return; }
  const url = URL.createObjectURL(file);
  const audio = new Audio(); audio.preload = "metadata"; audio.src = url;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(audio.duration);
      audio.onerror = () => reject(new Error("無法解碼這個音訊檔案。"));
    });
    const durationProblem = validateAudioDuration(duration);
    if (durationProblem) throw new Error(durationProblem);
    state.audioFile = file; state.duration = duration;
    updateAudioPicker(file);
    renderButton.disabled = false;
    setFileStatus(`${file.name} · ${formatBytes(file.size)} · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}`, "success");
    await refreshCapability();
    scheduleProjectSave();
  } catch (error) {
    state.audioFile = null; state.duration = null; renderButton.disabled = true; updateAudioPicker(null);
    setFileStatus(error instanceof Error ? error.message : "無法讀取音訊。", "error");
  } finally { URL.revokeObjectURL(url); audio.removeAttribute("src"); audio.load(); }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("無法讀取圖片。"));
    reader.onerror = () => reject(reader.error ?? new Error("無法讀取圖片。"));
    reader.readAsDataURL(file);
  });
}

function loadPreviewImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("無法顯示圖片。")); image.src = url;
  });
}

type ImageTarget = "coverUrl" | "backgroundUrl";

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
    if (!file.type.startsWith("image/")) {
      setFileStatus("請選擇 PNG、JPEG 或 WebP 圖片。", "error");
      return;
    }
    try {
      const dataUrl = await readDataUrl(file);
      const image = await loadPreviewImage(dataUrl);
      state[target] = dataUrl;
      if (target === "coverUrl") previewAssets.cover = image; else previewAssets.background = image;
      updateImagePicker(target, image, file.name);
      drawPreview(performance.now() / 1000);
      scheduleProjectSave();
    } catch (error) {
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
document.querySelector<HTMLButtonElement>("#new-project")!.addEventListener("click", resetDraft);
document.querySelector<HTMLButtonElement>("#delete-output")!.addEventListener("click", async () => {
  if (!currentProjectId) return;
  const renderId = document.querySelector<HTMLDivElement>("#output-actions")!.dataset.renderId;
  if (!renderId) return;
  await projectService.deleteOutput(currentProjectId, renderId);
  document.querySelector<HTMLDivElement>("#output-actions")!.hidden = true;
  clearOutputPreview();
  await refreshProjects();
});

renderButton.addEventListener("click", () => void startRender());
cancelButton.addEventListener("click", () => {
  cancelRequested = true;
  renderStatus.textContent = "正在取消渲染…";
  renderController?.cancel();
});

renderTemplateCards();
populateOutputControls();
drawPreview(0);
let animationFrame = 0;
function animate(now: number): void { drawPreview(now / 1000); animationFrame = requestAnimationFrame(animate); }
animationFrame = requestAnimationFrame(animate);
window.addEventListener("beforeunload", () => { cancelAnimationFrame(animationFrame); revokeCurrentOutputUrl(); });
void projectService.reconcileInterruptedRenders().then(refreshProjects).catch((error) => {
  document.querySelector("#storage-usage")!.textContent = error instanceof Error ? error.message : "無法開啟本機資料庫";
});
