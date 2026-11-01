import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

if (!process.env.C_BROWSER_DATABASE_URL) throw new Error("Set C_BROWSER_DATABASE_URL to isolated loopback PostgreSQL.");
process.env.C_BROWSER_CONTROL_TOKEN ??= randomUUID() + randomUUID();
const python = process.env.C_BROWSER_PYTHON ?? (process.platform === "win32" && existsSync("services/api/.venv/Scripts/python.exe") ? "services/api/.venv/Scripts/python.exe" : "python");

export default defineConfig({
  testDir: "./e2e", testMatch: "c-integration-api.spec.ts",
  workers: 1, retries: 0, forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:13007", locale: "zh-CN",
    channel: process.platform === "win32" ? "msedge" : undefined,
    trace: "retain-on-failure", screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `"${python}" services/api/tests/c_browser_server.py`,
      url: "http://127.0.0.1:18007/__test/health", reuseExistingServer: false,
      timeout: 120_000,
      env: {
        APP_ENV: "test", C_BROWSER_TEST: "1",
        C_BROWSER_DATABASE_URL: process.env.C_BROWSER_DATABASE_URL,
        C_BROWSER_CONTROL_TOKEN: process.env.C_BROWSER_CONTROL_TOKEN,
        GROUPPROOF_ENV_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 13007",
      url: "http://127.0.0.1:13007/healthz", reuseExistingServer: false, timeout: 120_000,
      env: {
        API_INTERNAL_URL: "http://127.0.0.1:18007", NEXT_DIST_DIR: ".next-c-integration",
        NEXT_PUBLIC_APP_MODE: "real", NEXT_PUBLIC_ENABLE_MOCKS: "false",
        NEXT_PUBLIC_API_FEATURES: "", NEXT_PUBLIC_API_BASE_URL: "",
        GROUPPROOF_SKIP_BACKEND: "1", NEXT_TELEMETRY_DISABLED: "1", npm_config_registry: "http://127.0.0.1:9",
      },
    },
  ],
});
