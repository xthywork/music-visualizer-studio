/** Typed browser client for the server-side render-job API. */

export type RenderJobState =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type RenderJobErrorCode =
  | "invalid_request"
  | "invalid_audio"
  | "invalid_image"
  | "invalid_subtitles"
  | "capacity_exceeded"
  | "worker_unavailable"
  | "decode_failed"
  | "render_failed"
  | "encode_failed"
  | "storage_failed"
  | "output_unavailable"
  | "cancelled"
  | "interrupted";

/** Matches app.render_jobs.models.RenderJobResponse. */
export interface RenderJob {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly state: RenderJobState;
  readonly progress: number;
  readonly frame: number;
  readonly totalFrames: number;
  readonly etaSeconds: number | null;
  readonly outputAvailable: boolean;
  readonly outputUrl: string | null;
  readonly error: { readonly code: RenderJobErrorCode; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Matches app.render_jobs.models.RenderCapabilitiesResponse. */
export interface RenderCapabilities {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly videoCodec: "h264_nvenc";
  readonly audioCodec: "aac";
  readonly container: "video/mp4";
  readonly pixelFormat: "yuv420p";
  readonly maxConcurrency: 1;
  readonly reason: string | null;
}

/** JSON configuration accepted by the Python RenderConfiguration model. */
export interface ServerRenderConfiguration {
  readonly schemaVersion: 1;
  readonly templateId:
    | "quiet-editorial"
    | "paper-resonance"
    | "panorama-lyrics"
    | "poetry-lyrics"
    | "night-orbit"
    | "dawn-spectrum";
  readonly text: { readonly title: string; readonly artist: string };
  readonly lyrics?: readonly { readonly start: number; readonly text: string }[];
  readonly templateSettings?: Readonly<Record<string, object>>;
  readonly output: {
    readonly aspectRatio: "16:9" | "9:16" | "1:1";
    readonly width: number;
    readonly height: number;
    readonly frameRate: 30 | 60;
  };
}

export interface CreateRenderJobInput {
  readonly configuration: ServerRenderConfiguration;
  readonly audio: File;
  readonly cover?: File;
  readonly background?: File;
  readonly subtitles?: File;
}

export interface RenderJobApi {
  capabilities(signal?: AbortSignal): Promise<RenderCapabilities>;
  create(input: CreateRenderJobInput, signal?: AbortSignal): Promise<RenderJob>;
  status(jobId: string, signal?: AbortSignal): Promise<RenderJob>;
  cancel(jobId: string, signal?: AbortSignal): Promise<RenderJob>;
  deleteOutput(jobId: string, signal?: AbortSignal): Promise<RenderJob>;
  deleteJob(jobId: string, signal?: AbortSignal): Promise<void>;
}

export class RenderJobHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RenderJobHttpError";
  }
}

export interface RenderJobHttpClientOptions {
  readonly apiRoot?: string;
  readonly fetch?: typeof fetch;
}

export class RenderJobHttpClient implements RenderJobApi {
  private readonly apiRoot: string;
  private readonly fetcher: typeof fetch;

  constructor(options: RenderJobHttpClientOptions = {}) {
    this.apiRoot = (options.apiRoot ?? "/api").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async capabilities(signal?: AbortSignal): Promise<RenderCapabilities> {
    const response = await this.fetcher(`${this.apiRoot}/render-capabilities`, { signal });
    return this.readJson<RenderCapabilities>(response);
  }

  async create(input: CreateRenderJobInput, signal?: AbortSignal): Promise<RenderJob> {
    const body = new FormData();
    body.set("config", JSON.stringify(input.configuration));
    body.set("audio", input.audio, input.audio.name);
    if (input.cover) body.set("cover", input.cover, input.cover.name);
    if (input.background) body.set("background", input.background, input.background.name);
    if (input.subtitles) body.set("subtitles", input.subtitles, input.subtitles.name);
    const response = await this.fetcher(`${this.apiRoot}/render-jobs`, {
      method: "POST",
      body,
      signal,
    });
    return this.readJson<RenderJob>(response);
  }

  async status(jobId: string, signal?: AbortSignal): Promise<RenderJob> {
    const response = await this.fetcher(`${this.apiRoot}/render-jobs/${encodeURIComponent(jobId)}`, { signal });
    return this.readJson<RenderJob>(response);
  }

  async cancel(jobId: string, signal?: AbortSignal): Promise<RenderJob> {
    const response = await this.fetcher(`${this.apiRoot}/render-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      signal,
    });
    return this.readJson<RenderJob>(response);
  }

  async deleteOutput(jobId: string, signal?: AbortSignal): Promise<RenderJob> {
    const response = await this.fetcher(`${this.apiRoot}/render-jobs/${encodeURIComponent(jobId)}/output`, {
      method: "DELETE",
      signal,
    });
    return this.readJson<RenderJob>(response);
  }

  async deleteJob(jobId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetcher(`${this.apiRoot}/render-jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      signal,
    });
    if (!response.ok) await this.readJson<never>(response);
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `Render request failed (${response.status}).`;
      let code: string | undefined;
      try {
        const payload = await response.json() as { error?: { code?: string; message?: string } };
        if (payload.error?.message) message = payload.error.message;
        code = payload.error?.code;
      } catch {
        // Keep the stable HTTP fallback when the server did not return JSON.
      }
      throw new RenderJobHttpError(message, response.status, code);
    }
    return await response.json() as T;
  }
}
