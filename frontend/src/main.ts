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
import { IndexedDbProjectStorage } from "./storage";
import { ProjectService } from "./ui/project-service";
import { renderProgressMessage } from "./ui/render-progress";
import { detectCapabilities } from "./render/capabilities";
import { renderConfigFromDomain } from "./render/domain-adapter";
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
const projectService = new ProjectService(new IndexedDbProjectStorage());
let currentProjectId: string | null = null;
let saveTimer: number | undefined;
let activeProjectId: string | null = null;
let activeRenderId: string | null = null;
let renderController: RenderController | null = null;
let cancelRequested = false;
let capabilitySupported = false;

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
      <header class="topbar">
        <div><span class="eyebrow">Browser-rendered video</span><h1>讓聲音變得看得見。</h1></div>
        <div class="privacy-chip">音訊不會上傳或保存</div>
      </header>
      <div class="layout">
        <section class="panel"><div class="panel-body">
          <div class="section">
            <div class="section-title"><h2>1. 選擇音訊</h2><span>MP3 · WAV · M4A · 最長 10 分鐘</span></div>
            <label class="dropzone"><input id="audio-input" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" /><span class="upload-icon">♪</span><strong>點擊選擇音訊</strong><small>檔案只在目前的瀏覽器工作階段中使用</small></label>
            <p class="file-status" id="file-status">尚未選擇音訊</p>
          </div>
          <div class="section">
            <div class="section-title"><h2>2. 選擇動畫</h2><span>3 個模板</span></div>
            <div class="templates" id="templates"></div>
          </div>
          <div class="section">
            <div class="section-title"><h2>3. 自訂內容</h2><span>即時預覽</span></div>
            <div class="fields">
              <label class="field">歌名<input id="title-input" value="${state.title}" maxlength="80" /></label>
              <label class="field">藝人<input id="artist-input" value="${state.artist}" maxlength="80" /></label>
              <label class="field">封面圖<span class="file-button"><span id="cover-name">選擇圖片</span><input id="cover-input" type="file" accept="image/png,image/jpeg,image/webp" /></span></label>
              <label class="field">背景圖<span class="file-button"><span id="background-name">選擇圖片</span><input id="background-input" type="file" accept="image/png,image/jpeg,image/webp" /></span></label>
            </div>
          </div>
          <div class="section">
            <div class="section-title"><h2>4. 輸出設定</h2><span id="dimensions-label">1920 × 1080</span></div>
            <div class="fields">
              <label class="field">比例<select id="ratio-select"></select></label>
              <label class="field">解析度<select id="resolution-select"></select></label>
              <label class="field">影格率<select id="fps-select"></select></label>
              <label class="field">渲染模式<select disabled><option>自動（瀏覽器優先）</option></select></label>
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
  state.coverUrl = config.coverImage?.value ?? null; state.backgroundUrl = config.backgroundImage?.value ?? null;
  previewAssets.cover = state.coverUrl ? await loadPreviewImage(state.coverUrl).catch(() => null) : null;
  previewAssets.background = state.backgroundUrl ? await loadPreviewImage(state.backgroundUrl).catch(() => null) : null;
  document.querySelector<HTMLInputElement>("#title-input")!.value = state.title;
  document.querySelector<HTMLInputElement>("#artist-input")!.value = state.artist;
  renderButton.disabled = true; setFileStatus("重新生成前請再次選擇原始音訊。");
  renderTemplateCards(); populateOutputControls(); updateOutputLabels();
  await showLatestOutput(project);
}

async function showLatestOutput(project: ProjectRecord): Promise<void> {
  const latest = [...project.renders].reverse().find((render) => render.status === "completed");
  const actions = document.querySelector<HTMLDivElement>("#output-actions")!;
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  if (!latest) { actions.hidden = true; video.hidden = true; return; }
  const stored = await projectService.getOutput(project.id, latest.id);
  if (!stored) { actions.hidden = true; video.hidden = true; document.querySelector("#render-status")!.textContent = "本機 MP4 已不存在；請重新上傳音訊生成。"; return; }
  const link = document.querySelector<HTMLAnchorElement>("#download-link")!;
  if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(stored.blob); link.download = `${safeFileName(project.name)}.mp4`;
  video.src = link.href; video.hidden = false;
  actions.dataset.renderId = latest.id; actions.hidden = false;
  document.querySelector("#render-status")!.textContent = "本機 MP4 可預覽與下載";
}

function resetDraft(): void {
  currentProjectId = null; state.templateId = "spectrum-cover"; state.aspectRatio = "16:9"; state.presetId = "16-9-1080p"; state.frameRate = 30;
  state.title = "Midnight Signal"; state.artist = "Your Artist"; state.audioFile = null; state.duration = null; state.coverUrl = null; state.backgroundUrl = null;
  previewAssets.cover = null; previewAssets.background = null;
  document.querySelector<HTMLInputElement>("#title-input")!.value = state.title; document.querySelector<HTMLInputElement>("#artist-input")!.value = state.artist;
  renderButton.disabled = true; document.querySelector<HTMLDivElement>("#output-actions")!.hidden = true; document.querySelector<HTMLVideoElement>("#output-preview")!.hidden = true;
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
  const gradient = context.createLinearGradient(0, 0, width, height);
  if (state.templateId === "vinyl-particle") {
    gradient.addColorStop(0, "#17111e"); gradient.addColorStop(1, "#08090f");
  } else if (state.templateId === "abstract-pulse") {
    gradient.addColorStop(0, "#201858"); gradient.addColorStop(0.55, "#10192f"); gradient.addColorStop(1, "#08100f");
  } else {
    gradient.addColorStop(0, "#0f1720"); gradient.addColorStop(1, "#080a10");
  }
  context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  if (previewAssets.background?.complete) {
    context.save();
    context.globalAlpha = 0.3;
    context.drawImage(previewAssets.background, 0, 0, width, height);
    context.restore();
  }
  context.save();
  if (state.templateId === "vinyl-particle") {
    const radius = Math.min(width, height) * 0.25;
    context.translate(width * .5, height * .44); context.rotate(time * .18);
    context.fillStyle = "#11131a"; context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "rgba(255,255,255,.1)";
    for (let index = 1; index < 9; index++) { context.beginPath(); context.arc(0, 0, radius * index / 9, 0, Math.PI * 2); context.stroke(); }
    context.fillStyle = "#ff7a9c"; context.beginPath(); context.arc(0, 0, radius * .26, 0, Math.PI * 2); context.fill();
    if (previewAssets.cover?.complete) {
      context.save();
      context.beginPath(); context.arc(0, 0, radius * .24, 0, Math.PI * 2); context.clip();
      context.drawImage(previewAssets.cover, -radius * .24, -radius * .24, radius * .48, radius * .48);
      context.restore();
    }
  } else {
    context.strokeStyle = state.templateId === "abstract-pulse" ? "#a99dff" : "#64f0d0";
    context.lineWidth = Math.max(2, width / 420); context.beginPath();
    for (let x = 0; x <= width; x += Math.max(2, width / 180)) {
      const y = height * .58 + Math.sin(x * .035 + time * 2) * height * .065 * (0.6 + .4 * Math.sin(x * .009));
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
    if (state.templateId === "spectrum-cover" && previewAssets.cover?.complete) {
      const size = Math.min(width, height) * .34;
      context.save(); context.globalAlpha = .84;
      context.drawImage(previewAssets.cover, width / 2 - size / 2, height * .41 - size / 2, size, size);
      context.restore();
    }
  }
  context.restore();
  context.textAlign = "center"; context.fillStyle = "#fff";
  context.font = `600 ${Math.max(18, width * .038)}px Space Grotesk`; context.fillText(state.title || "Untitled", width / 2, height * .78);
  context.fillStyle = "rgba(255,255,255,.62)"; context.font = `500 ${Math.max(11, width * .018)}px DM Sans`; context.fillText(state.artist || "Unknown Artist", width / 2, height * .84);
}

function setFileStatus(message: string, kind = ""): void {
  const element = document.querySelector<HTMLParagraphElement>("#file-status")!;
  element.textContent = message; element.className = `file-status ${kind}`;
}

async function inspectAudio(file: File): Promise<void> {
  const problem = validateAudioFile(file);
  if (problem) { state.audioFile = null; renderButton.disabled = true; setFileStatus(problem, "error"); return; }
  const url = URL.createObjectURL(file);
  const audio = new Audio(); audio.preload = "metadata"; audio.src = url;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(audio.duration);
      audio.onerror = () => reject(new Error("無法解碼這個音訊檔案。"));
    });
    const durationProblem = validateAudioDuration(duration);
    if (durationProblem) throw new Error(durationProblem);
    state.audioFile = file; state.duration = duration; renderButton.disabled = false;
    setFileStatus(`${file.name} · ${formatBytes(file.size)} · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}`, "success");
    await refreshCapability();
  } catch (error) {
    state.audioFile = null; state.duration = null; renderButton.disabled = true;
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

function attachImageInput(id: string, nameId: string, target: "coverUrl" | "backgroundUrl"): void {
  document.querySelector<HTMLInputElement>(id)!.addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    try {
      const dataUrl = await readDataUrl(file);
      state[target] = dataUrl;
      const image = await loadPreviewImage(dataUrl);
      if (target === "coverUrl") previewAssets.cover = image; else previewAssets.background = image;
      document.querySelector(nameId)!.textContent = file.name;
      drawPreview(performance.now() / 1000);
      scheduleProjectSave();
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : "無法讀取圖片。", "error");
    }
  });
}

document.querySelector<HTMLInputElement>("#audio-input")!.addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]; if (file) void inspectAudio(file);
});
document.querySelector<HTMLInputElement>("#title-input")!.addEventListener("input", (event) => { state.title = (event.target as HTMLInputElement).value; drawPreview(performance.now() / 1000); scheduleProjectSave(); });
document.querySelector<HTMLInputElement>("#artist-input")!.addEventListener("input", (event) => { state.artist = (event.target as HTMLInputElement).value; drawPreview(performance.now() / 1000); scheduleProjectSave(); });
attachImageInput("#cover-input", "#cover-name", "coverUrl");
attachImageInput("#background-input", "#background-name", "backgroundUrl");
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
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!; video.pause(); video.removeAttribute("src"); video.load(); video.hidden = true;
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
window.addEventListener("beforeunload", () => cancelAnimationFrame(animationFrame));
void projectService.reconcileInterruptedRenders().then(refreshProjects).catch((error) => {
  document.querySelector("#storage-usage")!.textContent = error instanceof Error ? error.message : "無法開啟本機資料庫";
});
