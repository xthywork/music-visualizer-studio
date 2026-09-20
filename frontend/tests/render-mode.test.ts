// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_MODE,
  RENDER_MODE_STORAGE_KEY,
  RenderCapabilityGate,
  readRenderMode,
  writeRenderMode,
} from "../src/ui/render-mode";

class MemoryStorage {
  value: string | null = null;
  getItem(key: string): string | null {
    expect(key).toBe(RENDER_MODE_STORAGE_KEY);
    return this.value;
  }
  setItem(key: string, value: string): void {
    expect(key).toBe(RENDER_MODE_STORAGE_KEY);
    this.value = value;
  }
}

describe("render mode preference", () => {
  it("defaults missing and invalid values to server", () => {
    const storage = new MemoryStorage();
    expect(readRenderMode(storage)).toBe(DEFAULT_RENDER_MODE);
    storage.value = "elsewhere";
    expect(readRenderMode(storage)).toBe("server");
  });

  it("round-trips both valid modes", () => {
    const storage = new MemoryStorage();
    expect(writeRenderMode(storage, "client")).toBe(true);
    expect(readRenderMode(storage)).toBe("client");
    expect(writeRenderMode(storage, "server")).toBe(true);
    expect(readRenderMode(storage)).toBe("server");
  });

  it("falls back without throwing when storage access fails", () => {
    const broken = {
      getItem(): string | null { throw new Error("blocked"); },
      setItem(): void { throw new Error("blocked"); },
    };
    expect(readRenderMode(broken)).toBe("server");
    expect(writeRenderMode(broken, "client")).toBe(false);
    expect(readRenderMode(undefined)).toBe("server");
  });
});

describe("RenderCapabilityGate", () => {
  it("rejects stale mode and output responses", () => {
    const gate = new RenderCapabilityGate();
    const server = gate.begin("server", "1920x1080@30");
    const client = gate.begin("client", "1920x1080@30");
    expect(gate.isCurrent(server)).toBe(false);
    expect(gate.isCurrent(client)).toBe(true);

    const resized = gate.begin("client", "3840x2160@60");
    expect(gate.isCurrent(client)).toBe(false);
    expect(gate.isCurrent(resized)).toBe(true);
  });
});
