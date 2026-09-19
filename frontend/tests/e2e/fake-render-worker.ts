import type { Page, Route } from "@playwright/test";

const CREATED_AT = "2026-09-19T12:00:00Z";
const FAKE_MP4 = Buffer.from("fake-mp4-fixture:ftyp-isom/moov/mdat", "ascii");

/**
 * Deterministic HTTP fake for the server worker API used by Playwright.
 * The browser still uploads a real audio File and exercises the production
 * render-job client, poller, persistence and UI. Tests advance worker state
 * explicitly, so no NVIDIA device, FFmpeg timing or encoder is involved.
 */
export class FakeRenderWorker {
  readonly jobId = "e2e-fake-job-1";
  readonly uploadedAudioNames: string[] = [];
  readonly calls: Array<{ method: string; path: string }> = [];

  private state: "queued" | "running" | "completed" | "cancelled" = "queued";
  private progress = 0;
  private frame = 0;
  private outputAvailable = false;
  private outputDeletionFailure: string | undefined;
  private jobDeletionFailure: string | undefined;
  private created = false;
  private resolveCreated!: () => void;
  private createdPromise = new Promise<void>((resolve) => { this.resolveCreated = resolve; });

  async install(page: Page): Promise<void> {
    await page.route("**/api/render-capabilities", async (route) => {
      await route.fulfill({
        json: {
          schemaVersion: 1,
          ready: true,
          videoCodec: "h264_nvenc",
          audioCodec: "aac",
          container: "video/mp4",
          pixelFormat: "yuv420p",
          maxConcurrency: 1,
          reason: null,
        },
      });
    });
    await page.route("**/api/render-jobs**", (route) => this.handle(route));
  }

  async waitForUpload(): Promise<void> {
    await this.createdPromise;
  }

  setRunning(progress = 0.42, frame = 126): void {
    this.state = "running";
    this.progress = progress;
    this.frame = frame;
  }

  complete(): void {
    this.state = "completed";
    this.progress = 1;
    this.frame = 300;
    this.outputAvailable = true;
  }

  completeWithoutOutput(): void {
    this.state = "completed";
    this.progress = 1;
    this.frame = 300;
    this.outputAvailable = false;
  }

  failNextOutputDeletion(message = "forced output deletion failure"): void {
    this.outputDeletionFailure = message;
  }

  failNextJobDeletion(message = "forced job deletion failure"): void {
    this.jobDeletionFailure = message;
  }

  get uploaded(): boolean {
    return this.created;
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    this.calls.push({ method, path });

    if (path === "/api/render-jobs" && method === "POST") {
      const body = request.postData() ?? "";
      const audioName = /filename="([^"]+\.wav)"/i.exec(body)?.[1];
      if (audioName) this.uploadedAudioNames.push(audioName);
      this.created = true;
      this.resolveCreated();
      await route.fulfill({ status: 201, json: this.response() });
      return;
    }

    if (path === `/api/render-jobs/${this.jobId}/cancel` && method === "POST") {
      this.state = "cancelled";
      this.outputAvailable = false;
      await route.fulfill({ json: this.response() });
      return;
    }

    if (path === `/api/render-jobs/${this.jobId}/output` && method === "GET") {
      await route.fulfill({
        status: this.outputAvailable ? 200 : 404,
        contentType: this.outputAvailable ? "video/mp4" : "application/json",
        body: this.outputAvailable ? FAKE_MP4 : JSON.stringify({ error: { code: "output_unavailable", message: "Output unavailable." } }),
      });
      return;
    }

    if (path === `/api/render-jobs/${this.jobId}/output` && method === "DELETE") {
      if (this.outputDeletionFailure) {
        const message = this.outputDeletionFailure;
        this.outputDeletionFailure = undefined;
        await route.fulfill({ status: 503, json: { error: { code: "storage_failed", message } } });
        return;
      }
      this.outputAvailable = false;
      await route.fulfill({ json: this.response() });
      return;
    }

    if (path === `/api/render-jobs/${this.jobId}` && method === "DELETE") {
      if (this.jobDeletionFailure) {
        const message = this.jobDeletionFailure;
        this.jobDeletionFailure = undefined;
        await route.fulfill({ status: 503, json: { error: { code: "storage_failed", message } } });
        return;
      }
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (path === `/api/render-jobs/${this.jobId}` && method === "GET") {
      await route.fulfill({ json: this.response() });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: `Unhandled fake worker request: ${method} ${path}` } });
  }

  private response() {
    return {
      schemaVersion: 1,
      id: this.jobId,
      state: this.state,
      progress: this.progress,
      frame: this.frame,
      totalFrames: 300,
      etaSeconds: this.state === "running" ? 12 : null,
      outputAvailable: this.outputAvailable,
      outputUrl: this.outputAvailable ? `/api/render-jobs/${this.jobId}/output` : null,
      error: this.state === "cancelled"
        ? { code: "cancelled", message: "伺服器渲染已取消。" }
        : null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
  }
}

export function wavFixture(seconds = 0.25, sampleRate = 48_000): Buffer {
  const frames = Math.floor(seconds * sampleRate);
  const channels = 2;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 220 * frame / sampleRate) * 0x2fff);
    for (let channel = 0; channel < channels; channel++) buffer.writeInt16LE(sample, 44 + (frame * channels + channel) * bytesPerSample);
  }
  return buffer;
}
