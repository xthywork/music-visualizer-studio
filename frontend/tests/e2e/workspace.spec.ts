import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

function wavFixture(seconds = 0.25, sampleRate = 48_000): Buffer {
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

async function storedProjects(page: import("@playwright/test").Page): Promise<Array<{ id: string; name: string; configuration: { text: { title: string }; coverImage?: { value: string } }; renders: Array<{ status: string }> }>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("music-visualizer");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("projects", "readonly");
    const allRequest = transaction.objectStore("projects").getAll();
    const records = await new Promise<Array<{ serialized: string }>>((resolve, reject) => {
      allRequest.onsuccess = () => resolve(allRequest.result);
      allRequest.onerror = () => reject(allRequest.error);
    });
    return records.map((record) => JSON.parse(record.serialized));
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Every Playwright test gets an isolated browser context. Waiting for the
  // async project-store/capability bootstrap avoids racing later form edits.
  await expect(page.locator("#capability")).toContainText("本機 MP4 編碼可用");
});

test("renders, stores, reopens, and downloads a local MP4", async ({ page }, testInfo) => {
  await expect(page.locator(".topbar")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "1. 歌曲與素材" })).toBeVisible();
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#audio-note")).toBeHidden();
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("E2E Signal");
  await page.locator("#audio-input").setInputFiles({ name: "signal.wav", mimeType: "audio/wav", buffer: wavFixture() });
  await expect(page.locator("#file-status")).toContainText("signal.wav");
  await expect(page.locator("#audio-note")).toBeVisible();
  await expect(page.locator("#audio-placeholder")).toBeHidden();
  await expect(page.locator("#audio-drop-title")).toHaveText("signal.wav");

  const generate = page.getByRole("button", { name: "生成 MP4" });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.locator("#output-actions")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#output-preview")).toBeVisible();
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#audio-note")).toBeHidden();
  const fittedOutput = await page.evaluate(() => {
    const video = document.querySelector("#output-preview")!.getBoundingClientRect();
    return document.scrollingElement!.scrollHeight <= innerHeight && video.bottom <= innerHeight;
  });
  expect(fittedOutput).toBe(true);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下載 MP4" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const downloadPath = testInfo.outputPath("e2e-signal.mp4");
  await download.saveAs(downloadPath);
  const mp4 = await readFile(downloadPath);
  const boxes = mp4.toString("latin1");
  expect(mp4.byteLength).toBeGreaterThan(1_000);
  expect(boxes).toContain("ftyp");
  expect(boxes).toContain("vide");
  expect(boxes).toContain("soun");

  await page.reload();
  await page.locator(".project-item", { hasText: "E2E Signal" }).click();
  await expect(page.locator("#output-actions")).toBeVisible();
  await expect(page.locator("#file-status")).toContainText("重新生成前請再次選擇原始音訊");

  const persisted = await page.evaluate(async () => {
    const request = indexedDB.open("music-visualizer");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("projects", "readonly");
    const allRequest = transaction.objectStore("projects").getAll();
    return new Promise<string>((resolve, reject) => {
      allRequest.onsuccess = () => resolve(JSON.stringify(allRequest.result)); allRequest.onerror = () => reject(allRequest.error);
    });
  });
  expect(persisted).not.toMatch(/sourceAudio|signal\.wav|audio\/wav|path|audioBytes|sourceAudioBytes|audioFile|handle|getFile/);
});

test("accepts audio and artwork by drag and drop", async ({ page }) => {
  const audioBase64 = wavFixture(.1).toString("base64");
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  await page.evaluate(({ audioBase64, pngBase64 }) => {
    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const drop = (selector: string, file: File) => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.querySelector(selector)?.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    };
    drop("#audio-dropzone", new File([decode(audioBase64)], "dropped.wav", { type: "audio/wav" }));
    drop("#cover-dropzone", new File([decode(pngBase64)], "cover.png", { type: "image/png" }));
    drop("#background-dropzone", new File([decode(pngBase64)], "background.png", { type: "image/png" }));
  }, { audioBase64, pngBase64 });

  await expect(page.locator("#file-status")).toContainText("dropped.wav");
  await expect(page.locator("#render-button")).toBeEnabled();
  await expect(page.locator("#audio-note")).toBeVisible();
  await expect(page.locator("#audio-placeholder")).toBeHidden();
  await expect(page.locator("#cover-name")).toHaveText("cover.png");
  await expect(page.locator("#background-name")).toHaveText("background.png");
  await expect(page.locator("#cover-preview-image")).toBeVisible();
  await expect(page.locator("#background-preview-image")).toBeVisible();
});

test("keeps the latest audio request and ignores completion from a previous workspace", async ({ page }) => {
  await page.addInitScript(() => {
    const pending: Array<{ audio: { duration: number; onloadedmetadata: (() => void) | null } }> = [];
    class ControlledAudio {
      duration = 0;
      preload = "";
      src = "";
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { pending.push({ audio: this }); }
      removeAttribute(): void { this.src = ""; }
      load(): void {}
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: ControlledAudio });
    Object.assign(window, {
      pendingAudioCount: () => pending.length,
      resolveAudio: (index: number, duration: number) => {
        pending[index].audio.duration = duration;
        pending[index].audio.onloadedmetadata?.();
      },
    });
  });
  await page.reload();
  await page.locator("#title-input").fill("Audio open target");
  await expect(page.locator(".project-row", { hasText: "Audio open target" })).toBeVisible();
  await page.getByRole("button", { name: "新增專案" }).click();
  const audioInput = page.locator("#audio-input");
  await audioInput.setInputFiles({ name: "audio-a.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await expect.poll(() => page.evaluate(() => (window as any).pendingAudioCount())).toBe(1);
  await audioInput.setInputFiles({ name: "audio-b.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await expect.poll(() => page.evaluate(() => (window as any).pendingAudioCount())).toBe(2);
  await page.evaluate(() => (window as any).resolveAudio(1, 2));
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");
  await page.evaluate(() => (window as any).resolveAudio(0, 1));
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");

  await audioInput.setInputFiles({ name: "stale-after-new.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await expect.poll(() => page.evaluate(() => (window as any).pendingAudioCount())).toBe(3);
  await page.getByRole("button", { name: "新增專案" }).click();
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await page.evaluate(() => (window as any).resolveAudio(2, 3));
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#audio-drop-title")).toHaveText("拖曳或點擊選擇");

  await audioInput.setInputFiles({ name: "stale-after-open.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await expect.poll(() => page.evaluate(() => (window as any).pendingAudioCount())).toBe(4);
  await page.locator(".project-item", { hasText: "Audio open target" }).click();
  await expect(page.locator("#title-input")).toHaveValue("Audio open target");
  await page.evaluate(() => (window as any).resolveAudio(3, 4));
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#audio-drop-title")).toHaveText("拖曳或點擊選擇");
});

test("keeps the latest image request and invalidates pending work on remove and New", async ({ page }) => {
  await page.addInitScript(() => {
    const pending: Array<(value: { width: number; height: number; close: () => void }) => void> = [];
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: () => new Promise((resolve) => pending.push(resolve)),
    });
    Object.assign(window, {
      pendingBitmapCount: () => pending.length,
      resolveBitmap: (index: number) => pending[index]({ width: 1, height: 1, close: () => undefined }),
    });
  });
  await page.reload();
  await page.locator("#title-input").fill("Image open target");
  await expect(page.locator(".project-row", { hasText: "Image open target" })).toBeVisible();
  await page.getByRole("button", { name: "新增專案" }).click();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const coverInput = page.locator("#cover-input");
  await coverInput.setInputFiles({ name: "cover-a.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => page.evaluate(() => (window as any).pendingBitmapCount())).toBe(1);
  await coverInput.setInputFiles({ name: "cover-b.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => page.evaluate(() => (window as any).pendingBitmapCount())).toBe(2);
  await page.evaluate(() => (window as any).resolveBitmap(1));
  await expect(page.locator("#cover-name")).toHaveText("cover-b.png");
  await page.evaluate(() => (window as any).resolveBitmap(0));
  await expect(page.locator("#cover-name")).toHaveText("cover-b.png");

  await coverInput.setInputFiles({ name: "removed.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => page.evaluate(() => (window as any).pendingBitmapCount())).toBe(3);
  await page.getByRole("button", { name: "移除封面圖" }).click();
  await page.evaluate(() => (window as any).resolveBitmap(2));
  await expect(page.locator("#cover-preview-image")).toBeHidden();

  await coverInput.setInputFiles({ name: "stale-after-new.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => page.evaluate(() => (window as any).pendingBitmapCount())).toBe(4);
  await page.getByRole("button", { name: "新增專案" }).click();
  await page.evaluate(() => (window as any).resolveBitmap(3));
  await expect(page.locator("#cover-preview-image")).toBeHidden();
  await expect(page.locator("#cover-name")).toHaveText("尚未選擇圖片");

  await coverInput.setInputFiles({ name: "stale-after-open.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => page.evaluate(() => (window as any).pendingBitmapCount())).toBe(5);
  await page.locator(".project-item", { hasText: "Image open target" }).click();
  await expect(page.locator("#title-input")).toHaveValue("Image open target");
  await page.evaluate(() => (window as any).resolveBitmap(4));
  await expect(page.locator("#cover-preview-image")).toBeHidden();
  await expect(page.locator("#cover-name")).toHaveText("尚未選擇圖片");
});

test("rejects SVG and oversized image headers before preview decode", async ({ page }) => {
  await page.locator("#cover-input").setInputFiles({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
  });
  await expect(page.locator("#file-status")).toContainText("PNG、JPEG 或 WebP");
  await expect(page.locator("#cover-preview-image")).toBeHidden();

  const oversizedPngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPngHeader, 0);
  oversizedPngHeader.write("IHDR", 12, "ascii");
  oversizedPngHeader.writeUInt32BE(7681, 16);
  oversizedPngHeader.writeUInt32BE(1, 20);
  await page.locator("#cover-input").setInputFiles({ name: "too-wide.png", mimeType: "image/png", buffer: oversizedPngHeader });
  await expect(page.locator("#file-status")).toContainText("圖片尺寸過大");
  await expect(page.locator("#cover-preview-image")).toBeHidden();
});

test("keeps a quota-rejected MP4 available for preview and download", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    (window as any).revokedObjectUrls = [];
    URL.revokeObjectURL = (url: string) => {
      (window as any).revokedObjectUrls.push(url);
      originalRevokeObjectUrl(url);
    };
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (this.name === "outputs") throw new DOMException("Test quota exhausted", "QuotaExceededError");
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  await page.reload();
  await expect(page.locator("#capability")).toContainText("本機 MP4 編碼可用");
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("Quota Project A");
  await page.locator("#audio-input").setInputFiles({ name: "quota.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await page.getByRole("button", { name: "生成 MP4" }).click();

  await expect(page.locator("#output-actions")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#output-preview")).toBeVisible();
  await expect(page.locator("#render-status")).toContainText("目前仍可預覽與下載");
  await expect(page.locator("#download-link")).toHaveAttribute("href", /^blob:/);
  const volatileUrl = await page.locator("#download-link").getAttribute("href");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-link").click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("quota-output.mp4");
  await download.saveAs(path);
  expect((await readFile(path)).byteLength).toBeGreaterThan(1_000);

  await page.getByRole("button", { name: "新增專案" }).click();
  expect(await page.evaluate(() => (window as any).revokedObjectUrls)).toContain(volatileUrl);
  const projectA = page.locator(".project-row", { hasText: "Quota Project A" });
  await expect(projectA.locator("small")).toHaveText("MP4 未保存");
  await projectA.locator(".project-item").click();
  await expect(page.locator("#output-preview")).toBeHidden();
  await expect(page.locator("#output-actions")).toBeHidden();
  await expect(page.locator("#render-status")).toContainText("本機 MP4 已不存在");

  await page.reload();
  await expect(page.locator(".project-row", { hasText: "Quota Project A" }).locator("small")).toHaveText("MP4 未保存");
});

test("cleans up the UI session after a Worker error", async ({ page }) => {
  await page.addInitScript(() => {
    class FailingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      postMessage(message: { type: string }): void {
        if (message.type === "start") queueMicrotask(() => this.onerror?.({ message: "forced worker failure" }));
      }
      terminate(): void { (window as typeof window & { workerTerminated?: boolean }).workerTerminated = true; }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: FailingWorker });
  });
  await page.reload();
  await expect(page.locator("#capability")).toContainText("本機 MP4 編碼可用");
  await page.locator("#audio-input").setInputFiles({ name: "failure.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#render-status")).toContainText("forced worker failure");
  await expect(page.locator("#cancel-button")).toBeHidden();
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#output-actions")).toBeHidden();
  expect(await page.evaluate(() => (window as typeof window & { workerTerminated?: boolean }).workerTerminated)).toBe(true);
});

test("labels an older saved MP4 when the newest output is unavailable", async ({ page }) => {
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  const audio = { name: "version.wav", mimeType: "audio/wav", buffer: wavFixture(.1) };
  await page.locator("#audio-input").setInputFiles(audio);
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#render-status")).toContainText("已生成並保存在", { timeout: 120_000 });

  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (this.name === "outputs") throw new DOMException("Test quota exhausted", "QuotaExceededError");
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  await page.locator("#audio-input").setInputFiles(audio);
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#render-status")).toContainText("本機空間不足", { timeout: 120_000 });

  await page.reload();
  await expect(page.locator("#capability")).toContainText("本機 MP4 編碼可用");
  await page.locator(".project-item").click();
  await expect(page.locator("#output-preview")).toBeVisible();
  await expect(page.locator("#render-status")).toContainText("較舊的已保存版本");
});

test("does not leave a ghost project when starting a new draft", async ({ page }) => {
  await page.locator("#title-input").fill("Abandoned draft");
  await page.getByRole("button", { name: "新增專案" }).click();
  await expect(page.locator("#title-input")).toHaveValue("Midnight Signal");
  await expect.poll(async () => (await storedProjects(page)).length).toBe(0);
});

test("flushes edits to an existing project before starting a new draft", async ({ page }) => {
  const title = page.locator("#title-input");
  await title.fill("Saved project");
  await expect(page.locator(".project-row", { hasText: "Saved project" })).toBeVisible();
  await title.fill("Pending edit before New");
  await page.getByRole("button", { name: "新增專案" }).click();
  await expect(title).toHaveValue("Midnight Signal");
  await expect.poll(async () => (await storedProjects(page)).map((project) => project.name)).toEqual(["Pending edit before New"]);
});

test("flushes a pending A snapshot before switching to B", async ({ page }) => {
  const title = page.locator("#title-input");
  await title.fill("Project A");
  await expect(page.locator(".project-item", { hasText: "Project A" })).toBeVisible();
  await page.getByRole("button", { name: "新增專案" }).click();
  await title.fill("Project B");
  await expect(page.locator(".project-item", { hasText: "Project B" })).toBeVisible();

  await page.locator(".project-item", { hasText: "Project A" }).click();
  await expect(title).toHaveValue("Project A");
  await title.fill("A pending title");
  await page.locator(".project-item", { hasText: "Project B" }).click();
  await expect(title).toHaveValue("Project B");

  await expect.poll(async () => (await storedProjects(page)).map((project) => project.configuration.text.title).sort()).toEqual(["A pending title", "Project B"]);
});

test("does not create duplicate projects when autosave and render overlap", async ({ page }) => {
  await page.locator("#title-input").fill("Render once");
  await page.locator("#audio-input").setInputFiles({ name: "render-once.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#output-actions")).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await storedProjects(page)).filter((project) => project.name === "Render once").length).toBe(1);
  await expect(page.locator(".project-row")).toHaveCount(1);
});

test("preserves edits and completed metadata when autosave runs during render", async ({ page }) => {
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("Before render");
  await page.locator("#audio-input").setInputFiles({ name: "overlap.wav", mimeType: "audio/wav", buffer: wavFixture(.5) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();
  await page.locator("#title-input").fill("Edited during render");
  await expect(page.locator("#render-status")).toContainText("已生成並保存在", { timeout: 120_000 });
  await expect.poll(async () => {
    const project = (await storedProjects(page))[0];
    return { title: project?.configuration.text.title, status: project?.renders.at(-1)?.status };
  }).toEqual({ title: "Edited during render", status: "completed" });
});

test("keeps Audio B when Audio A finishes rendering", async ({ page }) => {
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  const audioInput = page.locator("#audio-input");
  await audioInput.setInputFiles({ name: "audio-a.wav", mimeType: "audio/wav", buffer: wavFixture(1) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();

  await audioInput.setInputFiles({ name: "audio-b.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");
  await expect(page.locator("#render-status")).toContainText("已生成並保存在", { timeout: 120_000 });
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");
  await expect(page.locator("#audio-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成 MP4" })).toBeEnabled();

  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.locator("#cancel-button")).toBeHidden();
});

test("does not resurrect a project deleted while its save is pending", async ({ page }) => {
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

test("deleting another project does not discard the current project's pending autosave", async ({ page }) => {
  const title = page.locator("#title-input");
  await title.fill("Project A");
  await expect(page.locator(".project-row", { hasText: "Project A" })).toBeVisible();
  await page.getByRole("button", { name: "新增專案" }).click();
  await title.fill("Project B");
  await expect(page.locator(".project-row", { hasText: "Project B" })).toBeVisible();
  await title.fill("Project B pending");

  const rowA = page.locator(".project-row", { hasText: "Project A" });
  await rowA.locator(".project-delete").click();
  await rowA.locator(".project-delete-confirm").click();
  await expect.poll(async () => (await storedProjects(page)).map((project) => project.name)).toEqual(["Project B pending"]);
});

test("the latest Open request wins even when an earlier project image decodes later", async ({ page }) => {
  await page.locator("#title-input").fill("Image project A");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#6534ff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "large-cover.png", { type: "image/png" }));
    document.querySelector("#cover-dropzone")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator("#cover-preview-image")).toBeVisible();
  await expect.poll(async () => Boolean((await storedProjects(page)).find((project) => project.name === "Image project A")?.configuration.coverImage)).toBe(true);
  await page.getByRole("button", { name: "新增專案" }).click();
  await page.locator("#title-input").fill("Project B wins");
  await expect(page.locator(".project-row", { hasText: "Project B wins" })).toBeVisible();

  await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".project-item")];
    rows.find((row) => row.textContent?.includes("Image project A"))?.click();
    rows.find((row) => row.textContent?.includes("Project B wins"))?.click();
  });
  await expect(page.locator("#title-input")).toHaveValue("Project B wins");
  await expect(page.locator("#cover-preview-image")).toBeHidden();
});

test("starting a new project during render cancels the old session cleanly", async ({ page }) => {
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("Rendering project");
  await page.locator("#audio-input").setInputFiles({ name: "navigation.wav", mimeType: "audio/wav", buffer: wavFixture(10) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();
  await page.getByRole("button", { name: "新增專案" }).click();
  await expect(page.locator("#title-input")).toHaveValue("Midnight Signal");
  await expect(page.locator("#cancel-button")).toBeHidden();
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#output-actions")).toBeHidden();
  await expect.poll(async () => (await storedProjects(page)).find((project) => project.name === "Rendering project")?.renders.at(-1)?.status).toBe("cancelled");
});

test("opening another project during render cancels the old session without overwriting the opened UI", async ({ page }) => {
  await page.locator("#title-input").fill("Open target");
  await expect(page.locator(".project-row", { hasText: "Open target" })).toBeVisible();
  await page.getByRole("button", { name: "新增專案" }).click();
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("Rendering before Open");
  await page.locator("#audio-input").setInputFiles({ name: "open.wav", mimeType: "audio/wav", buffer: wavFixture(10) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();
  await page.locator(".project-item", { hasText: "Open target" }).click();
  await expect(page.locator("#title-input")).toHaveValue("Open target");
  await expect(page.locator("#cancel-button")).toBeHidden();
  await expect.poll(async () => (await storedProjects(page)).find((project) => project.name === "Rendering before Open")?.renders.at(-1)?.status).toBe("cancelled");
});

test("deleting the active render project cannot resurrect it", async ({ page }) => {
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("Delete active render");
  await page.locator("#audio-input").setInputFiles({ name: "delete-active.wav", mimeType: "audio/wav", buffer: wavFixture(10) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();
  const row = page.locator(".project-row", { hasText: "Delete active render" });
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator("#cancel-button")).toBeHidden();
  await expect(page.locator(".project-row")).toHaveCount(0);
  await expect.poll(async () => (await storedProjects(page)).length).toBe(0);
});

test("restores autosave and delete UI when project storage deletion fails", async ({ page }) => {
  await page.locator("#title-input").fill("Delete failure");
  const row = page.locator(".project-row", { hasText: "Delete failure" });
  await expect(row).toBeVisible();
  await page.evaluate(() => {
    const originalDelete = IDBObjectStore.prototype.delete;
    (window as any).failProjectDelete = true;
    IDBObjectStore.prototype.delete = function (query: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
      if (this.name === "projects" && (window as any).failProjectDelete) {
        throw new DOMException("forced delete failure", "UnknownError");
      }
      return originalDelete.call(this, query);
    };
  });
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator("#render-status")).toContainText("forced delete failure");
  await expect(page.locator(".project-row", { hasText: "Delete failure" })).toBeVisible();
  await page.evaluate(() => { (window as any).failProjectDelete = false; });
  await page.locator("#title-input").fill("Autosave restored");
  await expect.poll(async () => (await storedProjects(page)).map((project) => project.name)).toEqual(["Autosave restored"]);
});

test("reveals an accessible project delete action before deleting", async ({ page }) => {
  await page.locator("#title-input").fill("Delete me");
  await page.locator("#audio-input").setInputFiles({ name: "delete.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
  const row = page.locator(".project-row", { hasText: "Delete me" });
  await expect(row).toBeVisible();

  const toggle = row.locator(".project-delete");
  const confirm = row.locator(".project-delete-confirm");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(row).toHaveClass(/expanded/);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(confirm).toHaveAttribute("aria-hidden", "false");
  await expect(confirm).toHaveAttribute("tabindex", "0");

  await row.locator(".project-item").click();
  await expect(row).not.toHaveClass(/expanded/);
  await expect(page.locator("#title-input")).toHaveValue("Delete me");

  await toggle.click();
  await confirm.click();
  await expect(page.locator(".project-row")).toHaveCount(0);
  await expect(page.locator(".empty-projects")).toBeVisible();
});

test("fits the three-step workspace in a desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await expect(page.locator(".section-title h2")).toHaveText([
    "1. 歌曲與素材",
    "2. 動畫設定",
    "3. 輸出設定",
  ]);
  await expect(page.locator("#templates")).toBeVisible();
  await expect(page.locator(".output-settings")).toBeVisible();
  await expect(page.locator(".preview-slot")).toHaveCount(2);
  await expect(page.locator("#video-placeholder")).toBeVisible();
  const layout = await page.evaluate(() => {
    const slots = [...document.querySelectorAll(".media-slot")].map((element) => element.getBoundingClientRect().width);
    const previewSlots = [...document.querySelectorAll(".preview-slot")].map((element) => element.getBoundingClientRect());
    const renderButton = document.querySelector("#render-button")!.getBoundingClientRect();
    const stage = document.querySelector("#stage")!.getBoundingClientRect();
    const controlPanel = document.querySelector(".control-panel")!.getBoundingClientRect();
    const previewPanel = document.querySelector(".preview-panel")!.getBoundingClientRect();
    const outputActions = document.querySelector(".preview-output-actions")!.getBoundingClientRect();
    return {
      scrollHeight: document.scrollingElement!.scrollHeight,
      innerHeight,
      widths: slots,
      previewSlotHeights: previewSlots.map((slot) => slot.height),
      renderVisible: renderButton.bottom <= innerHeight,
      stageVisible: stage.top >= 0 && stage.bottom <= innerHeight,
      renderInControls: renderButton.left >= controlPanel.left && renderButton.right <= controlPanel.right,
      outputActionsInPreview: outputActions.left >= previewPanel.left && outputActions.right <= previewPanel.right,
    };
  });
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
  expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThan(1);
  expect(Math.abs(layout.previewSlotHeights[0] - layout.previewSlotHeights[1])).toBeLessThan(1);
  expect(layout.renderVisible).toBe(true);
  expect(layout.stageVisible).toBe(true);
  expect(layout.renderInControls).toBe(true);
  expect(layout.outputActionsInPreview).toBe(true);
});

test("contains the live preview canvas at the selected aspect ratio", async ({ page }) => {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1365, height: 768 },
    { width: 1280, height: 720 },
    { width: 1100, height: 700 },
  ];
  const ratios = [
    { value: "16:9", aspect: 16 / 9 },
    { value: "9:16", aspect: 9 / 16 },
    { value: "1:1", aspect: 1 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const ratio of ratios) {
      await page.locator("#ratio-select").selectOption(ratio.value);
      const layout = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const canvas = rect("#preview-canvas");
        const stage = rect("#stage");
        const wrap = rect(".stage-wrap");
        const slots = [...document.querySelectorAll<HTMLElement>(".preview-slot")].map((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        });
        return {
          canvas,
          stage,
          wrap,
          slots,
          scrollWidth: document.scrollingElement!.scrollWidth,
          scrollHeight: document.scrollingElement!.scrollHeight,
          innerWidth,
          innerHeight,
        };
      });
      const epsilon = 1;
      expect(Math.abs(layout.canvas.width / layout.canvas.height - ratio.aspect)).toBeLessThan(.01);
      expect(Math.abs(layout.stage.width / layout.stage.height - ratio.aspect)).toBeLessThan(.01);
      expect(Math.abs(layout.canvas.width - layout.stage.width)).toBeLessThan(epsilon);
      expect(Math.abs(layout.canvas.height - layout.stage.height)).toBeLessThan(epsilon);
      expect(layout.canvas.left).toBeGreaterThanOrEqual(layout.wrap.left - epsilon);
      expect(layout.canvas.top).toBeGreaterThanOrEqual(layout.wrap.top - epsilon);
      expect(layout.canvas.right).toBeLessThanOrEqual(layout.wrap.right + epsilon);
      expect(layout.canvas.bottom).toBeLessThanOrEqual(layout.wrap.bottom + epsilon);
      expect(Math.abs(layout.slots[0].height - layout.slots[1].height)).toBeLessThan(epsilon);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
      expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
    }
  }
});

for (const preset of [
  { ratio: "16:9", option: "16-9-720p", width: 1280, height: 720 },
  { ratio: "9:16", option: "9-16-720p", width: 720, height: 1280 },
  { ratio: "1:1", option: "1-1-720p", width: 720, height: 720 },
] as const) {
  test(`renders a playable ${preset.ratio} MP4 with expected metadata`, async ({ page }) => {
    await page.locator("#ratio-select").selectOption(preset.ratio);
    await page.locator("#resolution-select").selectOption(preset.option);
    await expect(page.locator("#dimensions-label")).toHaveText(`${preset.width} × ${preset.height}`);
    await page.locator("#audio-input").setInputFiles({ name: "ratio.wav", mimeType: "audio/wav", buffer: wavFixture(.1) });
    await page.getByRole("button", { name: "生成 MP4" }).click();
    const video = page.locator("#output-preview");
    await expect(video).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
    }))).toMatchObject({ width: preset.width, height: preset.height });
    const duration = await video.evaluate((element: HTMLVideoElement) => element.duration);
    expect(duration).toBeGreaterThan(0);
    const outputMetadata = await page.evaluate(async () => {
      const request = indexedDB.open("music-visualizer");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const allRequest = db.transaction("projects", "readonly").objectStore("projects").getAll();
      const stored = await new Promise<Array<{ serialized: string }>>((resolve, reject) => {
        allRequest.onsuccess = () => resolve(allRequest.result);
        allRequest.onerror = () => reject(allRequest.error);
      });
      const project = JSON.parse(stored[0].serialized) as { renders: Array<{ output?: unknown }> };
      return project.renders.at(-1)?.output;
    });
    expect(outputMetadata).toMatchObject({
      mimeType: "video/mp4",
      width: preset.width,
      height: preset.height,
      frameRate: 30,
      durationMs: 100,
    });
  });
}

test("keeps the interface responsive and cancels a worker render without output", async ({ page }) => {
  await page.locator("#ratio-select").selectOption("9:16");
  await page.locator("#resolution-select").selectOption("9-16-720p");
  await page.locator("#fps-select").selectOption("60");
  await page.locator("#audio-input").setInputFiles({ name: "cancel.wav", mimeType: "audio/wav", buffer: wavFixture(10) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  const cancel = page.getByRole("button", { name: "取消" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.locator("#render-status")).toContainText("渲染已取消", { timeout: 30_000 });
  await expect(page.locator("#output-actions")).toBeHidden();
  await expect(page.locator("#file-status")).toContainText("來源音訊已從工作階段釋放");
});

test("rejects an unsupported audio format", async ({ page }) => {
  await page.locator("#audio-input").setInputFiles({ name: "signal.flac", mimeType: "audio/flac", buffer: Buffer.from("not-audio") });
  await expect(page.locator("#file-status")).toContainText("僅支援 MP3、WAV 或 M4A");
  await expect(page.locator("#audio-placeholder")).toBeVisible();
  await expect(page.locator("#audio-note")).toBeHidden();
  await expect(page.getByRole("button", { name: "生成 MP4" })).toBeDisabled();
});
