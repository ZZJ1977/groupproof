import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const mode = process.env.TW_E2E_MODE === "real" ? "real" : "mock";
const isReal = mode === "real";
const baselineOnly = process.env.TW_BASELINE_ONLY === "1";

const webPort = 13009;
const apiPort = 18009;
const distDir = isReal ? ".next-teacher-workbench-real" : ".next-teacher-workbench";

function detectPython(): string {
  if (process.env.TW_E2E_PYTHON) return process.env.TW_E2E_PYTHON;
  const candidates =
    process.platform === "win32"
      ? [
          "services/api/.venv/Scripts/python.exe",
        ]
      : [
          "services/api/.venv/bin/python",
        ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

if (isReal) {
  process.env.TW_E2E_CONTROL_TOKEN ??= randomUUID() + randomUUID();
}

const realUpstreamEnv: Record<string, string> = {
  APP_ENV: "test",
  TW_E2E_TEST: "1",
  TW_E2E_PORT: String(apiPort),
  TW_E2E_WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
  TW_E2E_CONTROL_TOKEN: process.env.TW_E2E_CONTROL_TOKEN ?? "",
  TW_E2E_DATABASE_URL: process.env.TW_E2E_DATABASE_URL ?? "",
  TW_E2E_SQLITE:
    process.env.TW_E2E_SQLITE ??
    (process.env.TW_E2E_DATABASE_URL ? "0" : "1"),
  GROUPPROOF_ENV_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
};

const mockUpstreamEnv: Record<string, string> = {
  TW_AUTH_PORT: String(apiPort),
};

const nextWebServerEnv: Record<string, string> = {
  API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
  NEXT_DIST_DIR: distDir,
  NODE_OPTIONS: "--require ./e2e/skip-next-version-check.cjs",
  NEXT_PUBLIC_APP_ENV: "development",
  NEXT_PUBLIC_APP_MODE: "real",
  NEXT_PUBLIC_ENABLE_MOCKS: "false",
  NEXT_PUBLIC_API_FEATURES: "",
  NEXT_PUBLIC_API_BASE_URL: "",
  GROUPPROOF_SKIP_BACKEND: "1",
  NEXT_TELEMETRY_DISABLED: "1",
};

const upstreamWebServer = isReal
  ? {
      command: `"${detectPython()}" e2e/fixtures/teacher-workbench-server.py`,
      url: `http://127.0.0.1:${apiPort}/__test/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: realUpstreamEnv,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
    }
  : {
      command: "node e2e/fixtures/teacher-workbench-auth-fixture.mjs",
      url: `http://127.0.0.1:${apiPort}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: mockUpstreamEnv,
    };

export default defineConfig({
  testDir: "./e2e",
  testMatch: "teacher-workbench-t*.spec.ts",
  outputDir: "test-results/teacher-workbench",
  globalTeardown: "./e2e/fixtures/teacher-workbench-teardown.mjs",
  grepInvert: baselineOnly ? /\[post-m[234]\]/ : undefined,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    channel: process.platform === "darwin" ? "chrome" : undefined,
  },
  webServer: [
    upstreamWebServer,
    {
      command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}/api/v1/auth/session`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: nextWebServerEnv,
    },
  ],
});
