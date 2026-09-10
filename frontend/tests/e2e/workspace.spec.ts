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
  await expect(page.getByRole("heading", { name: "讓聲音變得看得見。" })).toBeVisible();
  await page.locator("#ratio-select").selectOption("1:1");
  await page.locator("#resolution-select").selectOption("1-1-720p");
  await page.locator("#title-input").fill("E2E Signal");
  await page.locator("#audio-input").setInputFiles({ name: "signal.wav", mimeType: "audio/wav", buffer: wavFixture() });
  await expect(page.locator("#file-status")).toContainText("signal.wav");

  const generate = page.getByRole("button", { name: "生成 MP4" });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.locator("#output-actions")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#output-preview")).toBeVisible();

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
  await expect(page.locator("#file-status")).toContainText("再次選擇原始音訊");

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
  expect(persisted).not.toMatch(/sourceAudio|audioFile|"audio"/);
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
  await expect(page.getByRole("button", { name: "生成 MP4" })).toBeDisabled();
});
