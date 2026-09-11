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
