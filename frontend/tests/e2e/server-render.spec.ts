import { expect, test } from "@playwright/test";
import { FakeRenderWorker, wavFixture } from "./fake-render-worker";

test("uploads audio, reports queued/running progress, resumes after reload and cancels the server job", async ({ page }) => {
  const worker = new FakeRenderWorker();
  await worker.install(page);
  await page.goto("/");

  await page.locator("#title-input").fill("Resumable server render");
  await page.locator("#audio-input").setInputFiles({
    name: "server-source.wav",
    mimeType: "audio/wav",
    buffer: wavFixture(0.4),
  });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await worker.waitForUpload();

  expect(worker.uploadedAudioNames).toContain("server-source.wav");
  await expect(page.locator("#render-status")).toContainText("排入伺服器佇列");
  await expect(page.locator("#progress-value")).toHaveText("0%");
  await expect(page.locator("#cancel-button")).toBeVisible();

  worker.setRunning(0.42, 126);
  await expect(page.locator("#render-status")).toContainText("正在渲染第 126/300 幀");
  await expect(page.locator("#progress-value")).toHaveText("42%");

  await page.reload();
  const project = page.locator(".project-item", { hasText: "Resumable server render" });
  await expect(project).toBeVisible();
  await project.click();
  await expect(page.locator("#render-status")).toContainText("正在渲染第 126/300 幀");
  await expect(page.locator("#cancel-button")).toBeVisible();

  await page.locator("#cancel-button").click();
  await expect(page.locator("#render-status")).toContainText("伺服器渲染已取消");
  await expect(page.locator("#cancel-button")).toBeHidden();
  expect(worker.calls).toContainEqual({ method: "POST", path: `/api/render-jobs/${worker.jobId}/cancel` });

  const row = page.locator(".project-row", { hasText: "Resumable server render" });
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator(".project-row")).toHaveCount(0);
  expect(worker.calls).toContainEqual({ method: "DELETE", path: `/api/render-jobs/${worker.jobId}` });
});

test("previews and downloads completed server output, then handles unavailable output and deletion", async ({ page }) => {
  const worker = new FakeRenderWorker();
  await worker.install(page);
  await page.goto("/");

  await page.locator("#title-input").fill("Completed server render");
  await page.locator("#audio-input").setInputFiles({
    name: "completed-source.wav",
    mimeType: "audio/wav",
    buffer: wavFixture(0.4),
  });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await worker.waitForUpload();
  worker.complete();

  await expect(page.locator("#output-preview")).toBeVisible();
  await expect(page.locator("#render-status")).toContainText("伺服器 MP4 已完成");
  await expect(page.locator("#download-link")).toHaveAttribute("href", `/api/render-jobs/${worker.jobId}/output`);
  const downloaded = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return new TextDecoder().decode(await response.arrayBuffer());
  }, `/api/render-jobs/${worker.jobId}/output`);
  expect(downloaded).toContain("fake-mp4-fixture");

  await page.locator("#delete-output").click();
  await expect(page.locator("#confirm-delete-output")).toBeVisible();
  await page.locator("#confirm-delete-output").click();
  await expect(page.locator("#output-preview")).toBeHidden();
  expect(worker.calls).toContainEqual({ method: "DELETE", path: `/api/render-jobs/${worker.jobId}/output` });

  worker.completeWithoutOutput();
  await page.reload();
  await page.locator(".project-item", { hasText: "Completed server render" }).click();
  await expect(page.locator("#output-preview")).toBeHidden();
  await expect(page.locator("#render-status")).toContainText("伺服器輸出目前不可用");
  await expect(page.locator("#download-link")).toHaveAttribute("aria-disabled", "true");

  const row = page.locator(".project-row", { hasText: "Completed server render" });
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator(".project-row")).toHaveCount(0);
  expect(worker.calls).toContainEqual({ method: "DELETE", path: `/api/render-jobs/${worker.jobId}` });
});

test("keeps a newly selected Audio B when the Audio A server render finishes", async ({ page }) => {
  const worker = new FakeRenderWorker();
  await worker.install(page);
  await page.goto("/");

  const audioInput = page.locator("#audio-input");
  await audioInput.setInputFiles({ name: "audio-a.wav", mimeType: "audio/wav", buffer: wavFixture(.4) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await worker.waitForUpload();
  await audioInput.setInputFiles({ name: "audio-b.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");

  worker.complete();
  await expect(page.locator("#render-status")).toContainText("伺服器 MP4 已完成");
  await expect(page.locator("#audio-drop-title")).toHaveText("audio-b.wav");
  await expect(page.locator("#audio-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成 MP4" })).toBeEnabled();
});

test("keeps preview and local project when server deletion fails, then allows retry", async ({ page }) => {
  const worker = new FakeRenderWorker();
  await worker.install(page);
  await page.goto("/");
  await page.locator("#title-input").fill("Retry server deletion");
  await page.locator("#audio-input").setInputFiles({ name: "retry.wav", mimeType: "audio/wav", buffer: wavFixture(.2) });
  await page.getByRole("button", { name: "生成 MP4" }).click();
  await worker.waitForUpload();
  worker.complete();
  await expect(page.locator("#output-preview")).toBeVisible();

  worker.failNextOutputDeletion();
  await page.locator("#delete-output").click();
  await page.locator("#confirm-delete-output").click();
  await expect(page.locator("#render-status")).toContainText("forced output deletion failure");
  await expect(page.locator("#output-preview")).toBeVisible();
  await expect(page.locator("#download-link")).toHaveAttribute("aria-disabled", "false");

  const row = page.locator(".project-row", { hasText: "Retry server deletion" });
  worker.failNextJobDeletion();
  await row.locator(".project-delete").click();
  await row.locator(".project-delete-confirm").click();
  await expect(page.locator("#render-status")).toContainText("已保留本機專案以供重試");
  await expect(page.locator(".project-row", { hasText: "Retry server deletion" })).toBeVisible();
  await expect(page.locator("#output-preview")).toBeVisible();

  await row.locator(".project-delete-confirm").click();
  await expect(page.locator(".project-row")).toHaveCount(0);
});
