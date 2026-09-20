import { LatestRequestGate } from "./latest-request";

export type RenderMode = "server" | "client";

export const DEFAULT_RENDER_MODE: RenderMode = "server";
export const RENDER_MODE_STORAGE_KEY = "music-visualizer.render-mode.v1";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readRenderMode(storage: PreferenceStorage | undefined): RenderMode {
  if (!storage) return DEFAULT_RENDER_MODE;
  try {
    const value = storage.getItem(RENDER_MODE_STORAGE_KEY);
    return value === "server" || value === "client" ? value : DEFAULT_RENDER_MODE;
  } catch {
    return DEFAULT_RENDER_MODE;
  }
}

export function writeRenderMode(storage: PreferenceStorage | undefined, mode: RenderMode): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RENDER_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export interface CapabilityRequestIdentity {
  readonly generation: number;
  readonly mode: RenderMode;
  readonly outputKey: string;
}

/** Rejects async capability results from an older mode or output selection. */
export class RenderCapabilityGate {
  private readonly requests = new LatestRequestGate();
  private currentMode: RenderMode = DEFAULT_RENDER_MODE;
  private currentOutputKey = "";

  begin(mode: RenderMode, outputKey: string): CapabilityRequestIdentity {
    this.currentMode = mode;
    this.currentOutputKey = outputKey;
    return { generation: this.requests.begin(), mode, outputKey };
  }

  isCurrent(request: CapabilityRequestIdentity): boolean {
    return this.requests.isCurrent(request.generation)
      && request.mode === this.currentMode
      && request.outputKey === this.currentOutputKey;
  }
}
