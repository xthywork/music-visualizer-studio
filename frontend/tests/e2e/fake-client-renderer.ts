import type { Page } from "@playwright/test";

export async function installFakeClientRenderer(
  page: Page,
  options: { completionDelayMs?: number; failureMessage?: string } = {},
): Promise<void> {
  const completionDelayMs = options.completionDelayMs ?? 20;
  const failureMessage = options.failureMessage;
  await page.addInitScript(({ completionDelayMs, failureMessage }) => {
    class FakeAudioContext {
      async decodeAudioData(): Promise<AudioBuffer> {
        const samples = new Float32Array(9_600);
        return {
          sampleRate: 48_000,
          numberOfChannels: 1,
          duration: .2,
          getChannelData: () => samples,
        } as unknown as AudioBuffer;
      }
      async close(): Promise<void> {}
    }

    class SupportedEncoder {
      static async isConfigSupported(config: unknown): Promise<{ supported: true; config: unknown }> {
        return { supported: true, config };
      }
    }

    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      private jobId = "";
      private terminal = false;

      constructor(_url: URL | string, _options?: WorkerOptions) {}

      postMessage(message: { type: string; jobId: string }): void {
        if (message.type === "cancel") {
          if (this.terminal) return;
          this.terminal = true;
          window.setTimeout(() => this.emit({ type: "cancel", jobId: message.jobId }), 0);
          return;
        }
        if (message.type !== "start") return;
        this.jobId = message.jobId;
        this.emit({ type: "start", jobId: this.jobId });
        window.setTimeout(() => {
          if (this.terminal) return;
          this.emit({ type: "progress", jobId: this.jobId, progress: .5, frame: 3, totalFrames: 6, elapsedMs: 10, etaMs: 10 });
        }, 5);
        window.setTimeout(() => {
          if (this.terminal) return;
          this.terminal = true;
          if (failureMessage) {
            this.emit({ type: "error", jobId: this.jobId, error: { code: "FAKE_CLIENT_ERROR", message: failureMessage } });
            return;
          }
          this.emit({
            type: "complete",
            jobId: this.jobId,
            output: new Blob(["fake-client-mp4:ftyp-isom/moov/mdat"], { type: "video/mp4" }),
            metadata: { width: 1920, height: 1080, frameRate: 30, duration: .2, hasAudio: true, hasVideo: true },
          });
        }, completionDelayMs);
      }

      terminate(): void { this.terminal = true; }

      private emit(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent);
      }
    }

    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "VideoEncoder", { configurable: true, value: SupportedEncoder });
    Object.defineProperty(window, "AudioEncoder", { configurable: true, value: SupportedEncoder });
    Object.defineProperty(window, "Worker", { configurable: true, value: FakeWorker });
  }, { completionDelayMs, failureMessage });
}

export async function installUnsupportedClientRenderer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "VideoEncoder", { configurable: true, value: undefined });
    Object.defineProperty(window, "AudioEncoder", { configurable: true, value: undefined });
  });
}
