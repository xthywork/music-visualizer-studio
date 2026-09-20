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
  type ServerRenderReference,
} from "./domain";
import {
  IndexedDbProjectStorage,
} from "./storage";
import { ProjectService } from "./ui/project-service";
import { ProjectSaveCoordinator } from "./ui/project-save-coordinator";
import { normalizeImageFile } from "./ui/image-assets";
import { LatestRequestGate } from "./ui/latest-request";
import { renderProgressMessage } from "./ui/render-progress";
import {
  RenderCapabilityGate,
  readRenderMode,
  writeRenderMode,
  type RenderMode,
} from "./ui/render-mode";
import { detectCapabilities } from "./render/capabilities";
import { renderConfigFromDomain } from "./render/domain-adapter";
import { createScene } from "./render/scenes";
import type { AudioAnalysis } from "./render/types";
import { RenderController, type RenderUpdate } from "./workers/orchestrator";
import type { LyricCue, TemplateSettings, TemplateSettingsMap } from "./domain/models";
import { defaultSettings, isLyricTemplate, SETTING_RANGES, PALETTES } from "./domain/template-settings";
import { MAX_SRT_BYTES, parseSrt } from "./domain/subtitles";
import { RenderJobHttpClient, type RenderJob, type ServerRenderConfiguration } from "./api/render-jobs";
import { RenderJobPoller } from "./ui/render-job-poller";
import { deleteProjectWithServerJobs } from "./ui/server-deletion";

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
  lyrics: readonly LyricCue[];
  templateSettings: TemplateSettingsMap;
}

const state: DraftState = {
  templateId: "quiet-editorial",
  aspectRatio: "16:9",
  presetId: "16-9-1080p",
  frameRate: 30,
  title: "Midnight Signal",
  artist: "Your Artist",
  audioFile: null,
  duration: null,
  coverUrl: null,
  backgroundUrl: null,
  lyrics: [],
  templateSettings: {},
};
const STATIC_PREVIEW_TIME_SECONDS = 2;
const demoLyrics: readonly LyricCue[] = [
  { start: 0, text: "讓光落在此刻" }, { start: 2.5, text: "聽見時間緩緩走過" },
  { start: 5, text: "把故事留在旋律裡" }, { start: 7.5, text: "向著遠方，繼續唱著" },
];

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
// Static editor-only sample; final frames and audio analysis are server-rendered.
const editorialPreviewAnalysis: AudioAnalysis = {
  ...previewAnalysis,
  temporal: {
    frameRate: 30, frameCount: 240, spectrumBands: 64,
    amplitude: Float32Array.from({ length: 240 }, (_, i) => .3 + .2 * Math.sin(i / 30 * Math.PI)),
    low: Float32Array.from({ length: 240 }, (_, i) => .3 + .2 * Math.sin(i / 30 * Math.PI)),
    mid: new Float32Array(240).fill(.3),
    high: new Float32Array(240).fill(.2),
    spectrum: Float32Array.from({ length: 240 * 64 }, (_, i) => {
      const band = i % 64;
      const time = Math.floor(i / 64) / 30;
      return (.2 + .18 * Math.sin(time * Math.PI + band * .28)) * (1 - band / 90);
    }),
  },
};
const projectService = new ProjectService(new IndexedDbProjectStorage());
const renderJobApi = new RenderJobHttpClient();
const renderJobPoller = new RenderJobPoller(renderJobApi, {
  onJob: enqueueServerJob,
  onError: handleServerJobError,
});
let currentProjectId: string | null = null;
let saveTimer: number | undefined;
let workspaceToken = 0;
let workspaceNavigationToken = 0;
let expandedProjectId: string | null = null;
interface RenderSessionBase {
  readonly workspaceToken: number;
  readonly sourceAudio?: File;
  projectId?: string;
  renderId?: string;
  cancelRequested: boolean;
  finalized: boolean;
  updates: Promise<void>;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
}
interface ServerRenderSession extends RenderSessionBase {
  readonly mode: "server";
  serverJobId?: string;
}
interface ClientRenderSession extends RenderSessionBase {
  readonly mode: "client";
  controller?: RenderController;
}
type ActiveRenderSession = ServerRenderSession | ClientRenderSession;
interface VolatileOutput {
  readonly renderId: string;
  readonly blob: Blob;
  readonly projectName: string;
}
let activeRenderSession: ActiveRenderSession | null = null;
const volatileOutputs = new Map<string, VolatileOutput>();
let renderCapabilityReady = false;
const capabilityRequests = new RenderCapabilityGate();
let preferenceStorage: Storage | undefined;
try { preferenceStorage = window.localStorage; } catch { preferenceStorage = undefined; }
let renderMode: RenderMode = readRenderMode(preferenceStorage);
const audioRequests = new LatestRequestGate();
const subtitleRequests = new LatestRequestGate();
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
      <fieldset class="render-location" id="render-location">
        <legend>渲染位置</legend>
        <div class="render-location-options">
          <label><input type="radio" name="render-location" value="server" /><span>伺服器</span></label>
          <label><input type="radio" name="render-location" value="client" /><span>此裝置</span></label>
        </div>
      </fieldset>
    </aside>
    <section class="workspace">
      <div class="layout">
        <section class="panel control-panel"><div class="panel-body" tabindex="0" aria-label="編輯設定，可捲動">
          <div class="section">
            <div class="section-title"><h2>1. 歌曲與素材</h2><span>即時預覽</span></div>
            <div class="fields song-fields">
              <label class="field">歌名<input id="title-input" value="${state.title}" maxlength="80" /></label>
              <label class="field">藝人<input id="artist-input" value="${state.artist}" maxlength="80" /></label>
            </div>
            <div class="media-grid">
              <div class="media-slot audio-slot">
                <span class="media-label">音訊</span>
                <label class="dropzone" id="audio-dropzone"><input id="audio-input" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" /><span class="audio-preview" id="audio-preview"><span class="audio-placeholder" id="audio-placeholder">＋</span><span class="audio-note" id="audio-note" hidden>♪</span></span><span class="audio-drop-copy"><strong id="audio-drop-title">拖曳或點擊選擇</strong><small id="audio-drop-meta">MP3 · WAV · M4A</small><span class="file-status" id="file-status" role="status">尚未選擇音訊</span></span></label>
              </div>
              <div class="media-slot subtitle-slot">
                <span class="media-label">字幕 SRT</span>
                <label class="dropzone" id="subtitle-dropzone"><input id="subtitle-input" type="file" accept=".srt" aria-label="匯入 SRT 字幕" /><span class="audio-preview">文</span><span class="audio-drop-copy"><strong>拖曳或點擊選擇</strong><small>UTF-8 · SRT</small><span class="file-status" id="subtitle-status" role="status">字幕模板需匯入 SRT</span></span></label>
                <button class="image-remove" id="subtitle-remove" type="button" hidden>移除字幕</button>
              </div>
              <div class="media-slot image-field">
                <span class="media-label">封面圖</span>
                <label class="image-dropzone" id="cover-dropzone"><input id="cover-input" type="file" accept="image/png,image/jpeg,image/webp" /><span class="image-preview" id="cover-preview"><span class="image-placeholder">＋</span><img id="cover-preview-image" alt="封面圖預覽" hidden /></span><span class="image-drop-copy"><strong>拖曳或點擊選擇</strong><small id="cover-name">尚未選擇圖片</small></span></label>
                <button class="image-remove" id="cover-remove" type="button" hidden>移除封面圖</button>
              </div>
              <div class="media-slot image-field">
                <span class="media-label">底圖</span>
                <label class="image-dropzone" id="background-dropzone"><input id="background-input" type="file" accept="image/png,image/jpeg,image/webp" /><span class="image-preview" id="background-preview"><span class="image-placeholder">＋</span><img id="background-preview-image" alt="背景圖預覽" hidden /></span><span class="image-drop-copy"><strong>拖曳或點擊選擇</strong><small id="background-name">尚未選擇圖片</small></span></label>
                <button class="image-remove" id="background-remove" type="button" hidden>移除背景圖</button>
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-title"><h2>2. 動畫設定</h2><span>選擇視覺風格</span></div>
            <div class="setting-block">
              <div class="templates" id="templates"></div>
              <button class="edit-template" id="edit-template" type="button" aria-expanded="false" aria-controls="template-editor">編輯模板</button>
              <div id="template-editor" class="template-editor" hidden></div>
              <p id="subtitle-hint" class="file-status" hidden>匯入 SRT 後即可生成；未匯入時只展示示例歌詞。</p>
            </div>
          </div>
          <div class="section">
              <div class="section-title"><h2>3. 輸出設定</h2><span id="output-mode-label">伺服器處理</span></div>
            <div class="setting-block output-settings">
              <div class="subsection-title"><strong>輸出規格</strong><span id="dimensions-label">1920 × 1080</span></div>
              <div class="fields output-fields">
                <label class="field">比例<select id="ratio-select"></select></label>
                <label class="field">解析度<select id="resolution-select"></select></label>
                <label class="field">影格率<select id="fps-select"></select></label>
              </div>
              <p class="render-mode" id="render-mode" role="status"></p>
            </div>
          </div>
        </div><div class="render-controls">
            <div class="status-row"><span id="render-status">選擇音訊後即可生成</span><span id="progress-value">0%</span></div>
            <div class="progress-track"><div class="progress-bar" id="progress-bar"></div></div>
            <div class="actions"><button class="primary" id="render-button" disabled>生成 MP4</button><button class="secondary" id="cancel-button" hidden>取消</button></div>
          </div>
        </section>
        <section class="panel preview-panel">
          <div class="preview-head"><span>輸出預覽</span><span class="capability-wrap"><span class="capability" id="capability">伺服器渲染</span></span></div>
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
            <div class="output-actions" id="output-actions"><a id="download-link" role="link" aria-disabled="true" tabindex="-1" download="music-visualizer.mp4">下載 MP4</a><div class="output-delete-wrap"><button id="delete-output" type="button" disabled aria-expanded="false" aria-controls="confirm-delete-output">刪除輸出</button><button id="confirm-delete-output" type="button" hidden>確認刪除</button></div></div>
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
const renderModeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="render-location"]')];
const renderModeDescription = document.querySelector<HTMLParagraphElement>("#render-mode")!;
const outputModeLabel = document.querySelector<HTMLSpanElement>("#output-mode-label")!;

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
  stage.dataset.scene = state.templateId;
  stage.dataset.theme = currentSettings().theme;
  document.querySelector(".stage-overlay span")!.textContent = isLyricTemplate(state.templateId) && !state.lyrics.length ? "字幕示意" : "靜態示意";
  document.querySelector<HTMLElement>("#subtitle-hint")!.hidden = !isLyricTemplate(state.templateId) || state.lyrics.length > 0;
  templatesElement.innerHTML = TEMPLATES.map((template) => `
    <button class="template-card ${template.id === state.templateId ? "active" : ""}" data-template="${template.id}" style="--template-accent:${template.accent}">
      <span class="template-swatch" aria-hidden="true"></span><span class="template-copy"><strong>${template.name}</strong><span class="template-description">${template.description}</span></span>
    </button>`).join("");
  templatesElement.querySelectorAll<HTMLButtonElement>("[data-template]").forEach((button) => {
    button.addEventListener("click", () => {
      state.templateId = button.dataset.template as TemplateId;
      renderTemplateCards();
      drawPreview();
      scheduleProjectSave();
    });
  });
  renderTemplateEditor();
  updateRenderAvailability();
}

function currentSettings(): TemplateSettings { return state.templateSettings[state.templateId] ?? defaultSettings(state.templateId); }
function updateRenderAvailability() {
  renderButton.disabled = !state.audioFile || !renderCapabilityReady || Boolean(activeRenderSession) || (isLyricTemplate(state.templateId) && !state.lyrics.length);
  for (const input of renderModeInputs) input.disabled = Boolean(activeRenderSession);
}

function outputCapabilityKey(): string {
  const output = configurationFromState().output;
  return `${output.width}x${output.height}@${output.frameRate}`;
}

function syncRenderModeUi(): void {
  for (const input of renderModeInputs) input.checked = input.value === renderMode;
  const server = renderMode === "server";
  outputModeLabel.textContent = server ? "伺服器處理" : "此裝置處理";
  renderModeDescription.textContent = server
    ? "渲染模式：伺服器 CPU 繪製 · NVIDIA NVENC 編碼"
    : "渲染模式：此裝置 Web Worker 繪製 · WebCodecs 編碼";
}

async function refreshRenderCapability(): Promise<void> {
  const mode = renderMode;
  const request = capabilityRequests.begin(mode, outputCapabilityKey());
  renderCapabilityReady = false;
  updateRenderAvailability();
  capability.textContent = mode === "server" ? "正在檢查伺服器渲染能力…" : "正在檢查此裝置編碼能力…";
  try {
    if (mode === "server") {
      const result = await renderJobApi.capabilities();
      if (!capabilityRequests.isCurrent(request)) return;
      renderCapabilityReady = result.ready;
      capability.textContent = result.ready
        ? "伺服器 NVENC 已就緒"
        : result.reason ?? "伺服器渲染工作者目前不可用";
    } else {
      const result = await detectCapabilities(renderConfigFromDomain(configurationFromState()).output);
      if (!capabilityRequests.isCurrent(request)) return;
      renderCapabilityReady = result.supported;
      capability.textContent = result.supported
        ? `此裝置 WebCodecs 已就緒 · ${result.codecPath ?? "MP4"}`
        : `此裝置不可用：${result.reasons.join(" ")}`;
    }
    capability.style.color = renderCapabilityReady ? "#64f0d0" : "#ff6f88";
  } catch (error) {
    if (!capabilityRequests.isCurrent(request)) return;
    renderCapabilityReady = false;
    const target = mode === "server" ? "伺服器" : "此裝置";
    capability.textContent = error instanceof Error ? `無法確認${target}能力：${error.message}` : `無法確認${target}渲染能力`;
    capability.style.color = "#ff6f88";
  }
  updateRenderAvailability();
}
function renderTemplateEditor() {
  const editor = document.querySelector<HTMLDivElement>("#template-editor")!;
  const settings = currentSettings();
  const paper = ["paper-resonance", "poetry-lyrics"].includes(state.templateId);
  const labels: Record<keyof typeof SETTING_RANGES, string> = { motion: "動畫強度", background: "底圖亮度", coverScale: "封面大小", coverX: "封面 X 位移 (%)", coverY: "封面 Y 位移 (%)", imageWidth: "影像區域寬度 (%)", imageZoom: "底圖縮放", imageX: "底圖 X 位移 (%)", imageY: "底圖 Y 位移 (%)", lineCount: "波線數量", lyricSize: "歌詞字級", lineGap: "歌詞行距", fade: "周圍歌詞不透明度" };
  const keys = (Object.keys(SETTING_RANGES) as (keyof typeof SETTING_RANGES)[]).filter(key => (isLyricTemplate(state.templateId) || !["lyricSize", "lineGap", "fade"].includes(key)) && (paper || !["imageWidth", "imageZoom", "imageX", "imageY", "lineCount"].includes(key)));
  editor.innerHTML = `<div class="fields"><label class="field">明暗模式<select id="setting-theme"><option value="light">淺色</option><option value="dark">深色</option></select></label><label class="field">強調色<input id="setting-accent" type="color" value="${settings.accent}" /></label>${paper ? `<label class="field">波線配色色卡<select id="setting-palette">${Object.entries(PALETTES).map(([id, palette]) => `<option value="${id}">${palette.name}</option>`).join("")}</select></label>` : ""}${keys.map(key => `<label class="field">${labels[key]}<span class="range-control"><input aria-label="${labels[key]}" data-setting="${key}" type="range" min="${SETTING_RANGES[key][0]}" max="${key === "imageWidth" && state.templateId === "poetry-lyrics" ? 60 : SETTING_RANGES[key][1]}" step="${["coverX", "coverY", "imageWidth", "imageX", "imageY", "lineCount"].includes(key) ? 1 : .05}" value="${settings[key]}" /><output>${settings[key]}</output></span></label>`).join("")}</div><p class="hint">封面位移以畫面寬高為基準；底圖位移調整裁切位置，正值向右／下。${paper ? "影像區域靠右對齊；直式詩頁會縮窄影像帶以保留閱讀空間。" : ""}</p><button class="image-remove" id="reset-template" type="button">重設此模板設定</button>`;
  const theme = editor.querySelector<HTMLSelectElement>("#setting-theme")!;
  theme.value = settings.theme;
  const update = (patch: Partial<TemplateSettings>) => {
    state.templateSettings = { ...state.templateSettings, [state.templateId]: { ...currentSettings(), ...patch } };
    stage.dataset.theme = currentSettings().theme;
    drawPreview(); scheduleProjectSave();
  };
  theme.addEventListener("change", () => update({ theme: theme.value as TemplateSettings["theme"] }));
  const palette = editor.querySelector<HTMLSelectElement>("#setting-palette");
  if (palette) {
    palette.value = settings.palette;
    palette.addEventListener("change", () => {
      const accent = PALETTES[palette.value as keyof typeof PALETTES].colors[0] ?? currentSettings().accent;
      update({ palette: palette.value, accent });
      editor.querySelector<HTMLInputElement>("#setting-accent")!.value = accent;
    });
  }
  editor.querySelector<HTMLInputElement>("#setting-accent")!.addEventListener("input", event => update({ accent: (event.target as HTMLInputElement).value }));
  editor.querySelectorAll<HTMLInputElement>("[data-setting]").forEach(input => input.addEventListener("input", () => { input.parentElement!.querySelector("output")!.textContent = input.value; update({ [input.dataset.setting!]: Number(input.value) }); }));
  editor.querySelector("#reset-template")!.addEventListener("click", () => { update(defaultSettings(state.templateId)); renderTemplateEditor(); });
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
    lyrics: state.lyrics,
    templateSettings: state.templateSettings,
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
    if (latest.server) {
      if (!latest.server.statusConfirmed) return [project.id, "伺服器狀態未確認"] as const;
      if (latest.server.state === "queued") return [project.id, "等待伺服器渲染"] as const;
      if (latest.server.state === "running") return [project.id, "伺服器渲染中"] as const;
      if (latest.server.state === "completed") {
        return [project.id, latest.server.outputAvailable ? "伺服器 MP4 可用" : "伺服器輸出不可用"] as const;
      }
      return [project.id, latest.server.state] as const;
    }
    if (latest.status !== "completed" || !latest.output) return [project.id, latest.status] as const;
    const output = await projectService.getOutput(project.id, latest.id);
    return [project.id, output ? "本機 MP4 已生成" : "本機 MP4 未保存"] as const;
  })));
  const list = document.querySelector<HTMLDivElement>("#project-list")!;
  list.innerHTML = projects.length ? projects.map((project) => {
    const status = statuses.get(project.id) ?? "尚未生成";
    const actionId = `project-actions-${project.id}`;
    return `<div class="project-row" data-project-row="${project.id}"><button class="project-item" data-project-id="${project.id}" aria-controls="${actionId}"><strong>${escapeHtml(project.name)}</strong><small>${status}</small></button><div class="project-actions" id="${actionId}"><button class="project-delete" type="button" data-delete-project="${project.id}" aria-label="展開刪除 ${escapeHtml(project.name)}" aria-expanded="false" aria-controls="${actionId}">×</button><button class="project-delete-confirm" type="button" data-confirm-delete="${project.id}" aria-label="確認刪除 ${escapeHtml(project.name)}" aria-hidden="true" tabindex="-1">刪除</button></div></div>`;
  }).join("") : '<p class="empty-projects">專案設定儲存在這個瀏覽器。</p>';
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
    let recoverySnapshot: ReturnType<typeof captureProjectSaveSnapshot> | undefined;
    let savesCancelled = false;
    try {
      await cancelActiveRenderForNavigation(id);
      recoverySnapshot = currentProjectId === id ? captureProjectSaveSnapshot() : undefined;
      await cancelProjectSaves(id);
      savesCancelled = true;
      const project = await projectService.reopenProject(id);
      if (project) {
        await deleteProjectWithServerJobs(renderJobApi, project, () => projectService.deleteProject(id));
      } else {
        await projectService.deleteProject(id);
      }
    } catch (error) {
      if (savesCancelled) projectSaveCoordinator.restoreProject(id);
      if (recoverySnapshot && currentProjectId === id) scheduleProjectSave();
      expandedProjectId = id;
      button.disabled = false;
      let message = error instanceof Error
        ? `無法完整刪除伺服器資料，已保留本機專案以供重試：${error.message}`
        : "無法完整刪除伺服器資料，已保留本機專案以供重試。";
      try {
        await refreshProjects();
      } catch (refreshError) {
        const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
        message = `${message}（專案列表更新失敗：${detail}）`;
      }
      renderStatus.textContent = message;
      return;
    }
    releaseVolatileOutput(id);
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
    releaseVolatileOutput(previousProjectId);
    clearOutputPreview();
  }
  state.templateId = config.templateId;
  state.lyrics = config.lyrics ?? [];
  state.templateSettings = config.templateSettings ?? {};
  updateSubtitleStatus();
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
  updateAudioPicker(null);
  setFileStatus("重新生成前請再次選擇原始音訊。");
  renderTemplateCards(); populateOutputControls(); updateOutputLabels();
  renderJobPoller.setWorkspace(project.id);
  let latestProject = project;
  const latestRender = project.renders.at(-1);
  if (latestRender?.server) {
    await projectSaveCoordinator.runExclusive(() => projectService.markServerStatusUnconfirmed(project.id, latestRender.id));
    latestProject = (await projectService.reopenProject(project.id)) ?? project;
    const current = latestProject.renders.find((render) => render.id === latestRender.id) ?? latestRender;
    if (current.server && ["queued", "running"].includes(current.server.state)) {
      activeRenderSession = createActiveRenderSession("server", workspaceToken, project.id, current.id);
      pausePreview();
      cancelButton.hidden = false;
    }
    renderJobPoller.open(latestRender.server.jobId);
  }
  updateRenderAvailability();
  await showLatestOutput(latestProject);
}

async function showLatestOutput(project: ProjectRecord): Promise<void> {
  if (currentProjectId !== project.id) return;
  const volatile = volatileOutputs.get(project.id);
  if (volatile) {
    presentOutputBlob(project.id, volatile.renderId, volatile.blob, volatile.projectName);
    renderStatus.textContent = "最新生成版本僅保留在此分頁，可預覽或下載；關閉分頁前請先下載。";
    return;
  }
  const latest = project.renders.at(-1);
  if (latest?.server) {
    if (latest.server.statusConfirmed && latest.server.state === "completed" && latest.server.outputAvailable && latest.server.outputUrl) {
      presentOutputUrl(project.id, latest.id, latest.server.outputUrl, project.name);
      renderStatus.textContent = "伺服器 MP4 已完成，可預覽與下載。";
    } else {
      const message = !latest.server.statusConfirmed
        ? "最新伺服器輸出狀態尚未確認；目前顯示較舊的本機版本。"
        : latest.server.state === "completed"
          ? "渲染已完成，但伺服器輸出目前不可用；目前顯示較舊的本機版本。"
          : latest.server.state === "queued"
            ? "工作已排入伺服器佇列；目前顯示較舊的本機版本。"
            : latest.server.state === "running"
              ? "伺服器正在渲染新版本；目前顯示較舊的本機版本。"
              : `${latest.error?.message ?? `伺服器工作${latest.server.state}`}；目前顯示較舊的本機版本。`;
      if (!await showOlderLocalOutput(project, latest.id, message)) {
        clearOutputPreview();
        renderStatus.textContent = message.replace("；目前顯示較舊的本機版本。", "。");
      }
    }
    return;
  }
  const completed = [...project.renders].reverse().filter((render) => render.status === "completed");
  if (!completed.length) { clearOutputPreview(); return; }
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
  renderStatus.textContent = "本機 MP4 已不存在；請重新上傳音訊生成。";
}

async function showOlderLocalOutput(project: ProjectRecord, latestRenderId: string, message: string): Promise<boolean> {
  for (const render of [...project.renders].reverse()) {
    if (render.id === latestRenderId || render.status !== "completed" || !render.output || render.server) continue;
    const stored = await projectService.getOutput(project.id, render.id);
    if (currentProjectId !== project.id) return false;
    if (!stored) continue;
    presentOutputBlob(project.id, render.id, stored.blob, project.name);
    renderStatus.textContent = message;
    return true;
  }
  return false;
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
  actions.dataset.outputSource = "local";
  link.setAttribute("aria-disabled", "false"); link.tabIndex = 0;
  document.querySelector<HTMLButtonElement>("#delete-output")!.disabled = false;
  closeOutputDeleteConfirmation();
}

function presentOutputUrl(projectId: string, renderId: string, url: string, projectName: string): void {
  if (currentProjectId !== projectId) return;
  const actions = document.querySelector<HTMLDivElement>("#output-actions")!;
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  const link = document.querySelector<HTMLAnchorElement>("#download-link")!;
  const placeholder = document.querySelector<HTMLDivElement>("#video-placeholder")!;
  revokeCurrentOutputUrl();
  currentOutputUrl = url;
  link.href = url; link.download = `${safeFileName(projectName)}.mp4`;
  video.src = url; video.hidden = false; placeholder.hidden = true;
  actions.dataset.renderId = renderId; actions.dataset.outputSource = "server"; actions.hidden = false;
  link.setAttribute("aria-disabled", "false"); link.tabIndex = 0;
  document.querySelector<HTMLButtonElement>("#delete-output")!.disabled = false;
  closeOutputDeleteConfirmation();
}

function revokeCurrentOutputUrl(): void {
  if (currentOutputUrl?.startsWith("blob:")) URL.revokeObjectURL(currentOutputUrl);
  currentOutputUrl = null;
}

function clearOutputPreview(): void {
  revokeCurrentOutputUrl();
  const video = document.querySelector<HTMLVideoElement>("#output-preview")!;
  const placeholder = document.querySelector<HTMLDivElement>("#video-placeholder")!;
  video.pause(); video.removeAttribute("src"); video.load(); video.hidden = true; placeholder.hidden = false;
  document.querySelector<HTMLAnchorElement>("#download-link")!.removeAttribute("href");
  const link = document.querySelector<HTMLAnchorElement>("#download-link")!;
  link.setAttribute("aria-disabled", "true"); link.tabIndex = -1;
  document.querySelector<HTMLButtonElement>("#delete-output")!.disabled = true;
  delete document.querySelector<HTMLElement>("#output-actions")!.dataset.renderId;
  delete document.querySelector<HTMLElement>("#output-actions")!.dataset.outputSource;
  closeOutputDeleteConfirmation();
}

function releaseVolatileOutput(projectId: string): void {
  if (!volatileOutputs.delete(projectId)) return;
  if (currentProjectId === projectId) clearOutputPreview();
  const row = document.querySelector<HTMLElement>(`.project-row[data-project-row="${projectId}"] small`);
  if (row) row.textContent = "本機 MP4 未保存";
}

function resetDraft(): void {
  if (currentProjectId) releaseVolatileOutput(currentProjectId);
  renderJobPoller.setWorkspace(null);
  workspaceNavigationToken += 1;
  invalidateMediaRequests();
  abandonPendingSave();
  currentProjectId = null; state.templateId = "quiet-editorial"; state.aspectRatio = "16:9"; state.presetId = "16-9-1080p"; state.frameRate = 30;
  state.lyrics = []; state.templateSettings = {}; updateSubtitleStatus();
  state.title = "Midnight Signal"; state.artist = "Your Artist"; state.audioFile = null; state.duration = null; state.coverUrl = null; state.backgroundUrl = null;
  document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
  updateAudioPicker(null);
  previewAssets.cover = null; previewAssets.background = null;
  updateImagePicker("coverUrl", null);
  updateImagePicker("backgroundUrl", null);
  document.querySelector<HTMLInputElement>("#cover-input")!.value = "";
  document.querySelector<HTMLInputElement>("#background-input")!.value = "";
  document.querySelector<HTMLInputElement>("#title-input")!.value = state.title; document.querySelector<HTMLInputElement>("#artist-input")!.value = state.artist;
  renderButton.disabled = true; clearOutputPreview();
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

function setRenderProgress(progress: number, message: string): void {
  const percentage = Math.max(0, Math.min(100, Math.round(progress * 100)));
  progressValue.textContent = `${percentage}%`;
  progressBar.style.width = `${percentage}%`;
  renderStatus.textContent = message;
  const frames = /\d+\/\d+(?= 幀)/.exec(message);
  if (frames) {
    const counter = document.createElement("span");
    counter.className = "render-frame-count";
    counter.textContent = frames[0];
    counter.style.minWidth = `${frames[0].split("/")[1].length * 2 + 1}ch`;
    renderStatus.replaceChildren(message.slice(0, frames.index), counter, message.slice(frames.index + frames[0].length));
  }
}

function createActiveRenderSession(
  mode: RenderMode,
  token: number,
  projectId: string,
  renderId: string,
  sourceAudio?: File,
): ActiveRenderSession {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  return {
    mode,
    workspaceToken: token,
    ...(sourceAudio ? { sourceAudio } : {}),
    projectId,
    renderId,
    cancelRequested: false,
    finalized: false,
    updates: Promise.resolve(),
    finished,
    resolveFinished,
  };
}

function serverConfiguration(configuration: RenderConfiguration): ServerRenderConfiguration {
  if (!FRAME_RATES.includes(configuration.output.frameRate as (typeof FRAME_RATES)[number])) {
    throw new Error("伺服器渲染僅支援 30 或 60 fps。");
  }
  return {
    schemaVersion: 1,
    templateId: configuration.templateId,
    text: configuration.text,
    ...(configuration.lyrics ? { lyrics: configuration.lyrics } : {}),
    ...(configuration.templateSettings ? { templateSettings: configuration.templateSettings } : {}),
    output: { ...configuration.output, frameRate: configuration.output.frameRate as 30 | 60 },
  };
}

async function imageUploadFile(reference: RenderConfiguration["coverImage"], name: string): Promise<File | undefined> {
  if (!reference) return undefined;
  const response = await fetch(reference.value);
  if (!response.ok) throw new Error(`無法讀取${name}圖片以供上傳。`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`${name}圖片格式無效。`);
  const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1] || "png";
  return new File([blob], `${name}.${extension}`, { type: blob.type });
}

async function startRender(): Promise<void> {
  if (isLyricTemplate(state.templateId) && !state.lyrics.length) { renderStatus.textContent = "請先匯入 SRT 字幕。"; return; }
  if (!state.audioFile || activeRenderSession) return;
  const sourceAudio = state.audioFile;
  const mode = renderMode;
  const session = createActiveRenderSession(mode, workspaceToken, currentProjectId ?? "", "", sourceAudio);
  activeRenderSession = session;
  pausePreview();
  updateRenderAvailability();
  try {
    renderButton.disabled = true;
    cancelButton.hidden = false;
    setRenderProgress(0, mode === "server" ? "正在準備上傳素材…" : "正在準備本機渲染…");
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
    if (session.mode === "client") {
      await startClientRender(session, project.configuration, sourceAudio);
      return;
    }
    setRenderProgress(0, "正在準備伺服器上傳…");
    const [cover, background] = await Promise.all([
      imageUploadFile(project.configuration.coverImage, "cover"),
      imageUploadFile(project.configuration.backgroundImage, "background"),
    ]);
    if (session.finalized) return;
    if (session.cancelRequested) {
      await cancelRenderSession(session);
      return;
    }
    renderJobPoller.setWorkspace(project.id);
    setRenderProgress(0, "正在上傳素材至伺服器…");
    const job = await renderJobPoller.create({
      configuration: serverConfiguration(project.configuration),
      audio: sourceAudio,
      ...(cover ? { cover } : {}),
      ...(background ? { background } : {}),
    });
    if (session.finalized || !job) return;
    session.serverJobId = job.id;
    await applyServerJob(project.id, job);
  } catch (error) {
    await failRenderSession(
      session,
      error instanceof Error ? error : new Error(String(error)),
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "render-start",
    );
  }
}

async function decodeAudioForRender(file: File, isCurrent: () => boolean): Promise<AudioBuffer> {
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

async function startClientRender(
  session: ClientRenderSession,
  configuration: RenderConfiguration,
  sourceAudio: File,
): Promise<void> {
  setRenderProgress(0, "正在此裝置解碼音訊…");
  const audioBuffer = await decodeAudioForRender(sourceAudio, () => (
    activeRenderSession === session
    && session.workspaceToken === workspaceToken
    && !session.finalized
  ));
  if (session.finalized) return;
  if (session.cancelRequested) {
    await cancelRenderSession(session);
    return;
  }
  const renderConfig = renderConfigFromDomain(configuration);
  const currentCapability = await detectCapabilities(renderConfig.output);
  if (session.finalized) return;
  if (!currentCapability.supported) throw new Error(currentCapability.reasons.join(" "));
  if (session.cancelRequested) {
    await cancelRenderSession(session);
    return;
  }
  const worker = new Worker(new URL("./workers/render-worker.ts", import.meta.url), { type: "module" });
  worker.onerror = (event) => enqueueClientRenderUpdate(session, () => failRenderSession(
    session,
    new Error(event.message || "渲染 Worker 發生錯誤。"),
    "worker-error",
  ));
  const controller = new RenderController(worker);
  session.controller = controller;
  controller.onUpdate((update) => enqueueClientRenderUpdate(session, () => handleClientRenderUpdate(session, update)));
  controller.startFromAudioBuffer(renderConfig, audioBuffer, session.renderId);
}

function enqueueClientRenderUpdate(session: ClientRenderSession, operation: () => Promise<void>): void {
  session.updates = session.updates.then(operation).catch((error) => failRenderSession(
    session,
    error instanceof Error ? error : new Error(String(error)),
    "render-update",
  ));
}

async function handleClientRenderUpdate(session: ClientRenderSession, update: RenderUpdate): Promise<void> {
  if (activeRenderSession !== session || session.finalized || !session.projectId || !session.renderId) return;
  if (update.response.type === "start") {
    await projectSaveCoordinator.runExclusive(() => projectService.markRendering(session.projectId!, session.renderId!));
    setRenderProgress(0, "正在此裝置生成 MP4…");
    return;
  }
  if (update.response.type === "progress") {
    setRenderProgress(
      update.response.progress,
      renderProgressMessage(update.response.frame, update.response.totalFrames, update.response.etaMs),
    );
    return;
  }
  if (update.response.type === "complete") {
    if (!claimRenderSession(session)) return;
    const { output, metadata } = update.response;
    const projectName = state.title.trim() || "Untitled Project";
    volatileOutputs.set(session.projectId, { renderId: session.renderId, blob: output, projectName });
    presentOutputBlob(session.projectId, session.renderId, output, projectName);
    let message = "MP4 已生成，但未能保存到本機；目前仍可預覽與下載，關閉分頁前請先下載。";
    try {
      const result = await projectSaveCoordinator.runExclusive(() => projectService.recordCompletedRender(
        session.projectId!,
        session.renderId!,
        output,
        {
          mimeType: "video/mp4",
          byteLength: output.size,
          durationMs: metadata.duration * 1000,
          width: metadata.width,
          height: metadata.height,
          frameRate: metadata.frameRate,
          createdAt: new Date().toISOString(),
        },
      ));
      if (result.outputSaved) {
        volatileOutputs.delete(session.projectId);
        message = "MP4 已由此裝置生成並保存在本機瀏覽器。";
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

function serverReference(job: RenderJob): ServerRenderReference {
  return {
    jobId: job.id,
    state: job.state,
    outputAvailable: job.outputAvailable,
    statusConfirmed: true,
    updatedAt: job.updatedAt,
    ...(job.outputUrl ? { outputUrl: job.outputUrl } : {}),
  };
}

function enqueueServerJob(workspaceId: string, job: RenderJob): void {
  void applyServerJob(workspaceId, job).catch((error) => {
    if (currentProjectId === workspaceId) {
      renderStatus.textContent = error instanceof Error
        ? `伺服器狀態無法保存：${error.message}`
        : "伺服器狀態無法保存。";
    }
  });
}

async function applyServerJob(workspaceId: string, job: RenderJob): Promise<void> {
  const session = activeRenderSession;
  if (session?.mode === "server" && session.projectId === workspaceId && session.renderId && (!session.serverJobId || session.serverJobId === job.id)) {
    session.serverJobId = job.id;
  }
  const sessionRenderId = session?.mode === "server" && session.projectId === workspaceId && session.serverJobId === job.id
    ? session.renderId
    : undefined;
  const result = await projectSaveCoordinator.runExclusive(async () => {
    const project = await projectService.reopenProject(workspaceId);
    if (!project) return undefined;
    const render = project.renders.find((candidate) => candidate.server?.jobId === job.id)
      ?? (sessionRenderId
        ? project.renders.find((candidate) => candidate.id === sessionRenderId)
        : undefined);
    if (!render) return undefined;
    return projectService.updateServerRender(workspaceId, render.id, serverReference(job), job.error ?? undefined);
  });
  if (!result) return;
  await refreshProjects();
  if (currentProjectId === workspaceId) {
    if (job.state === "queued") {
      setRenderProgress(job.progress, `工作已排入伺服器佇列，等待可用的渲染工作者…${olderLocalPreviewSuffix(result.id)}`);
    } else if (job.state === "running") {
      setRenderProgress(job.progress, `${renderProgressMessage(job.frame, job.totalFrames, job.etaSeconds == null ? undefined : job.etaSeconds * 1000)}${olderLocalPreviewSuffix(result.id)}`);
    } else if (job.state === "completed" && job.outputAvailable && job.outputUrl) {
      volatileOutputs.delete(workspaceId);
      presentOutputUrl(workspaceId, result.id, job.outputUrl, (await projectService.reopenProject(workspaceId))?.name ?? "Music Visualizer");
      setRenderProgress(1, "伺服器 MP4 已完成，可預覽與下載。");
    } else {
      const project = await projectService.reopenProject(workspaceId);
      if (project) await showLatestOutput(project);
      if (job.state === "completed") {
        progressValue.textContent = "100%";
        progressBar.style.width = "100%";
      } else if (job.state === "cancelled") {
        renderStatus.textContent = `伺服器渲染已取消，專案設定仍保留。${olderLocalPreviewSuffix(result.id)}`;
      } else if (job.state === "failed" || job.state === "interrupted") {
        renderStatus.textContent = `${job.error?.message ?? `伺服器渲染${job.state}。`}${olderLocalPreviewSuffix(result.id)}`;
      }
    }
  }
  if (session?.mode === "server" && session.projectId === workspaceId && session.serverJobId === job.id
    && ["completed", "cancelled", "failed", "interrupted"].includes(job.state)) {
    const message = job.state === "completed"
      ? job.outputAvailable ? "伺服器 MP4 已完成，可預覽與下載。" : "渲染已完成，但伺服器輸出目前不可用。"
      : job.error?.message ?? `伺服器渲染${job.state}。`;
    await finishRenderSession(session, message, job.state === "completed");
  }
}

function olderLocalPreviewSuffix(latestRenderId: string): string {
  const actions = document.querySelector<HTMLElement>("#output-actions")!;
  return actions.dataset.outputSource === "local" && actions.dataset.renderId !== latestRenderId
    ? "；目前預覽為較舊的本機版本"
    : "";
}

function handleServerJobError(workspaceId: string, error: unknown): void {
  void projectSaveCoordinator.runExclusive(async () => {
    const project = await projectService.reopenProject(workspaceId);
    if (!project) return;
    const active = activeRenderSession?.mode === "server" && activeRenderSession.projectId === workspaceId
      ? activeRenderSession
      : undefined;
    if (active?.renderId && !active.serverJobId) return;
    const jobId = active?.serverJobId;
    const render = (jobId ? project.renders.find((candidate) => candidate.server?.jobId === jobId) : undefined)
      ?? [...project.renders].reverse().find((candidate) => candidate.server);
    if (render) await projectService.markServerStatusUnconfirmed(workspaceId, render.id);
  }).then(() => refreshProjects()).catch(() => undefined);
  if (currentProjectId === workspaceId) {
    const detail = error instanceof Error ? error.message : String(error);
    renderStatus.textContent = `無法確認伺服器工作狀態（${detail}）；系統會繼續重試。${olderLocalPreviewSuffix(activeRenderSession?.renderId ?? "")}`;
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
    if (session.mode === "client") {
      try {
        session.controller?.dispose();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        message = `${message}（Worker 清理失敗：${detail}）`;
      }
      session.controller = undefined;
    }
    if (activeRenderSession === session) { activeRenderSession = null; resumePreview(); }
    const ownsWorkspace = session.workspaceToken === workspaceToken;
    cancelButton.hidden = true;
    if (ownsWorkspace) {
      setRenderProgress(completed ? 1 : 0, message);
      if (session.sourceAudio && state.audioFile === session.sourceAudio) {
        state.audioFile = null;
        state.duration = null;
        document.querySelector<HTMLInputElement>("#audio-input")!.value = "";
        updateAudioPicker(null);
        setFileStatus("來源音訊已從工作階段釋放；重新生成時請再次選擇。", completed ? "success" : "");
      }
      updateRenderAvailability();
    } else {
      updateRenderAvailability();
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
  if (session.mode === "client") {
    session.controller?.cancel();
    if (session.renderId) await cancelRenderSession(session);
    else if (claimRenderSession(session)) await finishRenderSession(session, "已停止本機渲染。", false);
    await session.finished;
    return;
  }
  if (session.serverJobId && projectId) {
    await renderJobPoller.cancel();
    await session.finished;
    return;
  }
  if (session.serverJobId) {
    renderJobPoller.setWorkspace(null);
    if (claimRenderSession(session)) await finishRenderSession(session, "伺服器工作仍在執行；重新開啟專案可查看進度。", false);
    return;
  }
  // No job id exists yet, so invalidate the multipart request before marking
  // the local placeholder cancelled; a late create response must not revive it.
  renderJobPoller.setWorkspace(null);
  if (session.renderId) await cancelRenderSession(session);
  else if (claimRenderSession(session)) await finishRenderSession(session, "已停止素材上傳。", false);
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
  drawPreview();
  void refreshRenderCapability();
}

function drawPreview(): void {
  if (activeRenderSession) return;
  const { width, height } = canvas;
  const lyrics = state.lyrics.length ? state.lyrics : demoLyrics;
  const duration = state.duration ?? (isLyricTemplate(state.templateId) ? Math.max(10, (lyrics.at(-1)?.start ?? 0) + 4) : 8);
  const offset = isLyricTemplate(state.templateId) ? Math.max(0, (lyrics[0]?.start ?? 0) - 1) : 0;
  const previewTime = Math.min(duration, offset + STATIC_PREVIEW_TIME_SECONDS);
  const scene = createScene(state.templateId, {
    title: state.title,
    artist: state.artist,
    lyrics,
    settings: currentSettings(),
    assets: {
      coverImage: previewAssets.cover?.complete ? previewAssets.cover : undefined,
      backgroundImage: previewAssets.background?.complete ? previewAssets.background : undefined,
    },
  });
  scene.render(context, {
    time: previewTime,
    analysisTime: STATIC_PREVIEW_TIME_SECONDS % previewAnalysis.duration,
    frame: Math.floor(STATIC_PREVIEW_TIME_SECONDS * state.frameRate),
    progress: previewTime / duration,
    width,
    height,
    analysis: { ...editorialPreviewAnalysis, duration },
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
    updateRenderAvailability();
    setFileStatus(`${file.name} · ${formatBytes(file.size)} · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}`, "success");
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
  subtitleRequests.begin();
  audioRequests.begin();
  cancelPendingAudioInspection?.();
  cancelPendingAudioInspection = null;
  imageRequests.coverUrl.begin();
  imageRequests.backgroundUrl.begin();
}

function updateSubtitleStatus() {
  const status = document.querySelector<HTMLElement>("#subtitle-status")!;
  status.className = "file-status";
  status.textContent = state.lyrics.length ? `${state.lyrics.length} 句字幕 · 依開始時間滾動` : "字幕模板需匯入 SRT";
  document.querySelector<HTMLButtonElement>("#subtitle-remove")!.hidden = !state.lyrics.length;
  document.querySelector<HTMLInputElement>("#subtitle-input")!.value = "";
}
async function importSubtitles(file: File) {
  const token = subtitleRequests.begin();
  try {
    if (!/\.srt$/i.test(file.name)) throw new Error("請選擇 .srt 字幕檔");
    if (file.size > MAX_SRT_BYTES) throw new Error("SRT 檔案不可超過 1 MB");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error("請使用 UTF-8 編碼的 SRT 字幕檔"); }
    if (!subtitleRequests.isCurrent(token)) return;
    const lyrics = parseSrt(text);
    state.lyrics = lyrics;
    updateSubtitleStatus(); renderTemplateCards(); scheduleProjectSave();
  } catch (error) {
    if (!subtitleRequests.isCurrent(token)) return;
    const status = document.querySelector<HTMLElement>("#subtitle-status")!;
    status.className = "file-status error";
    status.textContent = (error instanceof Error ? error.message : "無法讀取字幕") + (state.lyrics.length ? "；保留原字幕。" : "");
  } finally {
    if (subtitleRequests.isCurrent(token)) document.querySelector<HTMLInputElement>("#subtitle-input")!.value = "";
  }
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
      drawPreview();
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
    drawPreview();
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
document.querySelector<HTMLInputElement>("#title-input")!.addEventListener("input", (event) => { state.title = (event.target as HTMLInputElement).value; drawPreview(); scheduleProjectSave(); });
document.querySelector<HTMLInputElement>("#artist-input")!.addEventListener("input", (event) => { state.artist = (event.target as HTMLInputElement).value; drawPreview(); scheduleProjectSave(); });
attachImageInput("coverUrl");
attachImageInput("backgroundUrl");
document.querySelector<HTMLInputElement>("#subtitle-input")!.addEventListener("change", event => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void importSubtitles(file); });
const subtitleDropzone = document.querySelector<HTMLLabelElement>("#subtitle-dropzone")!;
for (const name of ["dragenter", "dragover"]) subtitleDropzone.addEventListener(name, event => { event.preventDefault(); subtitleDropzone.classList.add("dragging"); });
for (const name of ["dragleave", "drop"]) subtitleDropzone.addEventListener(name, event => { event.preventDefault(); subtitleDropzone.classList.remove("dragging"); });
subtitleDropzone.addEventListener("drop", event => { const file = event.dataTransfer?.files[0]; if (file) void importSubtitles(file); });
document.querySelector("#subtitle-remove")!.addEventListener("click", () => { subtitleRequests.begin(); state.lyrics = []; updateSubtitleStatus(); renderTemplateCards(); scheduleProjectSave(); });
document.querySelector("#edit-template")!.addEventListener("click", () => {
  const editor = document.querySelector<HTMLElement>("#template-editor")!;
  editor.hidden = !editor.hidden;
  document.querySelector("#edit-template")!.setAttribute("aria-expanded", String(!editor.hidden));
});
ratioSelect.addEventListener("change", () => { state.aspectRatio = ratioSelect.value as AspectRatio; updateResolutionOptions(); scheduleProjectSave(); });
resolutionSelect.addEventListener("change", () => { state.presetId = resolutionSelect.value; updateOutputLabels(); scheduleProjectSave(); });
fpsSelect.addEventListener("change", () => { state.frameRate = Number(fpsSelect.value); updateOutputLabels(); scheduleProjectSave(); });
for (const input of renderModeInputs) input.addEventListener("change", () => {
  if (!input.checked || activeRenderSession) {
    syncRenderModeUi();
    return;
  }
  renderMode = input.value as RenderMode;
  writeRenderMode(preferenceStorage, renderMode);
  syncRenderModeUi();
  void refreshRenderCapability();
});
document.querySelector<HTMLButtonElement>("#new-project")!.addEventListener("click", () => {
  void startNewDraft().catch((error) => {
    renderStatus.textContent = error instanceof Error ? error.message : "無法切換到新專案。";
  });
});
let outputDeleteTarget: { projectId: string; renderId: string; source: "local" | "server" } | undefined;
function closeOutputDeleteConfirmation() {
  outputDeleteTarget = undefined;
  document.querySelector<HTMLButtonElement>("#confirm-delete-output")!.hidden = true;
  document.querySelector<HTMLButtonElement>("#delete-output")!.setAttribute("aria-expanded", "false");
}
document.querySelector<HTMLAnchorElement>("#download-link")!.addEventListener("click", event => {
  if (!currentOutputUrl) event.preventDefault();
});
document.querySelector<HTMLButtonElement>("#delete-output")!.addEventListener("click", () => {
  if (outputDeleteTarget) { closeOutputDeleteConfirmation(); return; }
  const actions = document.querySelector<HTMLElement>("#output-actions")!;
  const source = actions.dataset.outputSource;
  const renderId = actions.dataset.renderId;
  if (source !== "local" && source !== "server") return;
  if (!currentProjectId || !currentOutputUrl || !renderId) return;
  outputDeleteTarget = { projectId: currentProjectId, renderId, source };
  document.querySelector<HTMLButtonElement>("#confirm-delete-output")!.hidden = false;
  document.querySelector<HTMLButtonElement>("#delete-output")!.setAttribute("aria-expanded", "true");
  document.querySelector<HTMLButtonElement>("#confirm-delete-output")!.focus();
});
document.addEventListener("click", event => {
  if (!(event.target as Element).closest(".output-delete-wrap")) closeOutputDeleteConfirmation();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && outputDeleteTarget) {
    closeOutputDeleteConfirmation(); document.querySelector<HTMLButtonElement>("#delete-output")!.focus();
  }
});
document.querySelector<HTMLButtonElement>("#confirm-delete-output")!.addEventListener("click", async () => {
  const target = outputDeleteTarget;
  const actions = document.querySelector<HTMLElement>("#output-actions")!;
  if (!target || target.projectId !== currentProjectId || target.renderId !== actions.dataset.renderId || target.source !== actions.dataset.outputSource) return;
  closeOutputDeleteConfirmation();
  const button = document.querySelector<HTMLButtonElement>("#delete-output")!;
  button.disabled = true;
  try {
    if (target.source === "server") {
      const project = await projectService.reopenProject(target.projectId);
      const render = project?.renders.find((candidate) => candidate.id === target.renderId);
      if (!render?.server) throw new Error("找不到對應的伺服器輸出紀錄。");
      const job = await renderJobApi.deleteOutput(render.server.jobId);
      try {
        await projectSaveCoordinator.runExclusive(() => projectService.updateServerRender(
          target.projectId,
          target.renderId,
          serverReference(job),
          job.error ?? undefined,
        ));
      } catch (error) {
        if (currentProjectId === target.projectId) {
          clearOutputPreview();
          const detail = error instanceof Error ? error.message : String(error);
          renderStatus.textContent = `伺服器輸出已刪除，但本機狀態更新失敗：${detail}`;
        }
        return;
      }
    } else {
      await projectSaveCoordinator.runExclusive(() => projectService.deleteOutput(target.projectId, target.renderId));
      if (volatileOutputs.get(target.projectId)?.renderId === target.renderId) {
        volatileOutputs.delete(target.projectId);
      }
    }
    if (currentProjectId === target.projectId && document.querySelector<HTMLElement>("#output-actions")!.dataset.renderId === target.renderId) {
      clearOutputPreview(); renderStatus.textContent = "已刪除輸出影片，專案與素材設定仍保留。";
    }
    await refreshProjects();
  } catch (error) {
    if (currentProjectId === target.projectId) renderStatus.textContent = error instanceof Error ? `無法刪除輸出：${error.message}` : "無法刪除輸出";
  } finally { button.disabled = !document.querySelector<HTMLElement>("#output-actions")!.dataset.outputSource; }
});

renderButton.addEventListener("click", () => void startRender());
cancelButton.addEventListener("click", () => {
  const session = activeRenderSession;
  if (!session || session.finalized) return;
  session.cancelRequested = true;
  renderStatus.textContent = "正在取消渲染…";
  if (session.mode === "client") {
    session.controller?.cancel();
    enqueueClientRenderUpdate(session, () => cancelRenderSession(session));
  } else if (session.serverJobId) {
    void renderJobPoller.cancel().catch(() => undefined);
  } else {
    renderJobPoller.setWorkspace(null);
    if (session.renderId) void cancelRenderSession(session);
  }
});

renderTemplateCards();
populateOutputControls();
syncRenderModeUi();
drawPreview();
function pausePreview() {
  stage.dataset.previewPaused = "true";
}
function resumePreview() {
  if (activeRenderSession) return;
  stage.dataset.previewPaused = "false";
  drawPreview();
}
window.addEventListener("beforeunload", () => { stageResizeObserver?.disconnect(); revokeCurrentOutputUrl(); });
void projectService.reconcileInterruptedRenders().then(refreshProjects).catch((error) => {
  document.querySelector("#storage-usage")!.textContent = error instanceof Error ? error.message : "無法開啟本機資料庫";
});
