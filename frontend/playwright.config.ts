import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:34388",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "uv run --directory .. music-visualizer",
    url: "http://127.0.0.1:34388/health",
    reuseExistingServer: true,
    timeout: 30_000,
    env: { VISUALIZER_HOST: "127.0.0.1" },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
