import { defineConfig } from "@playwright/test";

// Only run explicitly against the team's documented test deployment.
export default defineConfig({
  testDir: "./e2e/staging",
  testMatch: "*.staging.ts",
  globalSetup: "./e2e/staging/staging-env.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "./test-results/c5-staging",
  // Failure snapshots can include signed URLs and the test account's project contents.
  preserveOutput: "never",
  use: {
    baseURL: "https://groupproof-staging-production.up.railway.app",
    storageState: process.env.C5_STAGING_STORAGE_STATE,
    locale: "zh-CN",
    channel: process.platform === "win32" ? "msedge" : undefined,
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
