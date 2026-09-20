import { expect, test, type Page } from "@playwright/test";
import { installFakeClientRenderer, installUnsupportedClientRenderer } from "./fake-client-renderer";
import { FakeRenderWorker, wavFixture } from "./fake-render-worker";

async function chooseClient(page: Page): Promise<void> {
  await page.locator(".render-location-options label", { hasText: "此裝置" }).click();
  await expect(page.getByRole("radio", { name: "此裝置" })).toBeChecked();
  await expect(page.locator("#capability")).toContainText("此裝置");
}

test("defaults to server and persists the accessible client mode selection", async ({ page }) => {
  const server = new FakeRenderWorker();
  await server.install(page);
  await installFakeClientRenderer(page);
  await page.goto("/");

  const serverRadio = page.getByRole("radio", { name: "伺服器" });
  const clientRadio = page.getByRole("radio", { name: "此裝置" });
  await expect(serverRadio).toBeChecked();
  await expect(page.locator("#render-location")).toBeVisible();
  await clientRadio.focus();
  await clientRadio.press("Space");
  await expect(clientRadio).toBeChecked();
  await expect(page.locator("#render-mode")).toContainText("Web Worker");

  await page.reload();
  await expect(clientRadio).toBeChecked();
  await expect(page.locator("#capability")).toContainText("WebCodecs 已就緒");
});

test("does not fall back when the selected client capability is unavailable", async ({ page }) => {
  const server = new FakeRenderWorker();
  await server.install(page);
  await installUnsupportedClientRenderer(page);
  await page.goto("/");
  await chooseClient(page);
  await expect(page.locator("#capability")).toContainText("No playable MP4 codec pair");

  await page.locator("#audio-input").setInputFiles({
    name: "unsupported.wav",
    mimeType: "audio/wav",
    buffer: wavFixture(.2),
  });
  await expect(page.getByRole("button", { name: "生成 MP4" })).toBeDisabled();
  expect(server.uploaded).toBe(false);
  await expect(page.getByRole("radio", { name: "此裝置" })).toBeChecked();
});

test("renders and downloads locally, preserves Audio B, then switches back to server", async ({ page }) => {
  const server = new FakeRenderWorker();
  await server.install(page);
  await installFakeClientRenderer(page, { completionDelayMs: 300 });
  await page.goto("/");
  await chooseClient(page);

  const audioInput = page.locator("#audio-input");
  await audioInput.setInputFiles({ name: "client-a.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.getByRole("radio", { name: "伺服器" })).toBeDisabled();
  await expect(page.locator("#render-status")).toContainText("3/6 幀");
  await audioInput.setInputFiles({ name: "client-b.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });

  await expect(page.locator("#render-status")).toContainText("保存在本機瀏覽器");
  await expect(page.locator("#output-preview")).toBeVisible();
  await expect(page.locator("#download-link")).toHaveAttribute("href", /blob:/);
  await expect(page.locator("#audio-drop-title")).toHaveText("client-b.wav");
  await expect(page.getByRole("button", { name: "生成 MP4" })).toBeEnabled();
  expect(server.uploaded).toBe(false);

  await page.locator(".render-location-options label", { hasText: "伺服器" }).click();
  await expect(page.locator("#capability")).toHaveText("伺服器 NVENC 已就緒");
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await server.waitForUpload();
  expect(server.uploadedAudioNames).toContain("client-b.wav");
  server.complete();
  await expect(page.locator("#render-status")).toContainText("伺服器 MP4 已完成");
  await page.locator("#delete-output").click();
  await page.locator("#confirm-delete-output").click();
  await expect.poll(() => server.calls).toContainEqual({ method: "DELETE", path: `/api/render-jobs/${server.jobId}/output` });
  const localOutputCount = await page.evaluate(async () => {
    const opened = indexedDB.open("music-visualizer");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const request = database.transaction("outputs", "readonly").objectStore("outputs").count();
    return new Promise<number>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  expect(localOutputCount).toBe(1);

  const row = page.locator(".project-row", { hasText: "Midnight Signal" });
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator(".project-row")).toHaveCount(0);
  await expect.poll(() => server.calls).toContainEqual({ method: "DELETE", path: `/api/render-jobs/${server.jobId}` });
});

test("cancels only the active client worker", async ({ page }) => {
  const server = new FakeRenderWorker();
  await server.install(page);
  await installFakeClientRenderer(page, { completionDelayMs: 5_000 });
  await page.goto("/");
  await chooseClient(page);
  await page.locator("#audio-input").setInputFiles({ name: "cancel-client.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#cancel-button")).toBeVisible();
  await page.locator("#cancel-button").click();
  await expect(page.locator("#render-status")).toContainText("渲染已取消");
  await expect(page.locator("#cancel-button")).toBeHidden();
  await expect(page.getByRole("radio", { name: "伺服器" })).toBeEnabled();
  expect(server.uploaded).toBe(false);
});

test("reports a client worker error without submitting to the server", async ({ page }) => {
  const server = new FakeRenderWorker();
  await server.install(page);
  await installFakeClientRenderer(page, { failureMessage: "forced client worker failure" });
  await page.goto("/");
  await chooseClient(page);
  await page.locator("#audio-input").setInputFiles({ name: "failure.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await expect(page.locator("#render-status")).toContainText("forced client worker failure");
  await expect(page.locator("#output-preview")).toBeHidden();
  await expect(page.getByRole("radio", { name: "伺服器" })).toBeEnabled();
  expect(server.uploaded).toBe(false);
});
