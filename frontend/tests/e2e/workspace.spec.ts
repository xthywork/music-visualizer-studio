import { expect, test, type Page } from "@playwright/test";
import { wavFixture } from "./fake-render-worker";

async function installReadyCapability(page: Page): Promise<void> {
  await page.route("**/api/render-capabilities", (route) => route.fulfill({
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
  }));
}

async function storedProjects(page: Page): Promise<Array<{ id: string; name: string; configuration: { text: { title: string } } }>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("music-visualizer");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = db.transaction("projects", "readonly").objectStore("projects").getAll();
    const records = await new Promise<Array<{ serialized: string }>>((resolve, reject) => {
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => reject(all.error);
    });
    return records.map((record) => JSON.parse(record.serialized));
  });
}

test.beforeEach(async ({ page }) => {
  await installReadyCapability(page);
  await page.goto("/");
  await expect(page.locator("#capability")).toHaveText("伺服器 NVENC 已就緒");
});

test("keeps pending edits when creating and switching projects", async ({ page }) => {
  const title = page.locator("#title-input");
  await title.fill("Project A");
  await expect(page.locator(".project-item", { hasText: "Project A" })).toBeVisible();
  await title.fill("Project A pending");
  await page.getByRole("button", { name: "新增專案" }).click();
  await expect(title).toHaveValue("Midnight Signal");

  await title.fill("Project B");
  await expect(page.locator(".project-item", { hasText: "Project B" })).toBeVisible();
  await page.locator(".project-item", { hasText: "Project A pending" }).click();
  await expect(title).toHaveValue("Project A pending");
  await title.fill("Project A final");
  await page.locator(".project-item", { hasText: "Project B" }).click();
  await expect(title).toHaveValue("Project B");

  await expect.poll(async () => (await storedProjects(page)).map((project) => project.name).sort())
    .toEqual(["Project A final", "Project B"]);
});

test("does not resurrect a project deleted while autosave is pending", async ({ page }) => {
  const title = page.locator("#title-input");
  await title.fill("Delete me");
  const row = page.locator(".project-row", { hasText: "Delete me" });
  await expect(row).toBeVisible();
  await title.fill("Delete me pending");
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator(".project-row")).toHaveCount(0);
  await expect.poll(async () => (await storedProjects(page)).length).toBe(0);
});

test("accepts audio and artwork by drag and drop and rejects SVG", async ({ page }) => {
  const audioBase64 = wavFixture(.1).toString("base64");
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await page.evaluate(({ audioBase64, pngBase64 }) => {
    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const drop = (selector: string, file: File) => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.querySelector(selector)?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    };
    drop("#audio-dropzone", new File([decode(audioBase64)], "dropped.wav", { type: "audio/wav" }));
    drop("#cover-dropzone", new File([decode(pngBase64)], "cover.png", { type: "image/png" }));
    drop("#background-dropzone", new File([decode(pngBase64)], "background.png", { type: "image/png" }));
  }, { audioBase64, pngBase64 });

  await expect(page.locator("#audio-drop-title")).toHaveText("dropped.wav");
  await expect(page.locator("#cover-name")).toHaveText("cover.png");
  await expect(page.locator("#background-name")).toHaveText("background.png");
  await expect(page.locator("#render-button")).toBeEnabled();

  await page.locator("#cover-input").setInputFiles({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(page.locator("#file-status")).toContainText("PNG、JPEG 或 WebP");
  await expect(page.locator("#cover-name")).toHaveText("cover.png");
});

test("ignores stale audio metadata after a newer selection and New", async ({ page }) => {
  await page.addInitScript(() => {
    const pending: Array<{ duration: number; onloadedmetadata: (() => void) | null }> = [];
    class ControlledAudio {
      duration = 0;
      preload = "";
      src = "";
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { pending.push(this); }
      removeAttribute(): void { this.src = ""; }
      load(): void {}
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: ControlledAudio });
    Object.assign(window, {
      pendingAudioCount: () => pending.length,
      resolveAudio: (index: number, duration: number) => {
        pending[index]!.duration = duration;
        pending[index]!.onloadedmetadata?.();
      },
    });
  });
  await page.reload();
  const input = page.locator("#audio-input");
  await input.setInputFiles({ name: "audio-a.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await input.setInputFiles({ name: "audio-b.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await expect.poll(() => page.evaluate(() => (window as any).pendingAudioCount())).toBe(2);
  await page.evaluate(() => (window as any).resolveAudio(1, 2));
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");
  await page.evaluate(() => (window as any).resolveAudio(0, 1));
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");

  await input.setInputFiles({ name: "stale.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await page.getByRole("button", { name: "新增專案" }).click();
  await page.evaluate(() => (window as any).resolveAudio(2, 3));
  await expect(page.locator("#audio-drop-title")).toHaveText("拖曳或點擊選擇");
});

test("keeps a no-scroll responsive editor with a static canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await expect(page.locator(".section-title h2")).toHaveText(["1. 歌曲與素材", "2. 動畫設定", "3. 輸出設定"]);
  await expect(page.locator(".stage-overlay span").first()).toHaveText("靜態示意");
  const layout = await page.evaluate(() => ({
    scrollHeight: document.scrollingElement!.scrollHeight,
    innerHeight,
    previewSlots: document.querySelectorAll(".preview-slot").length,
  }));
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
  expect(layout.previewSlots).toBe(2);
});
