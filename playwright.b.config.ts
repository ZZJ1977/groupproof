import { defineConfig } from "@playwright/test";

// B browser checks. The authenticated session comes from C's loopback identity
// fixture (no database, SMTP or OAuth); business data is the explicit mock workspace.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "b-*.spec.ts",
  testIgnore: ["b-*-real.spec.ts"],
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:13008",
    locale: "zh-CN",
    channel: process.platform === "win32" ? "msedge" : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node e2e/c-auth-fixture.mjs",
      url: "http://127.0.0.1:18006/healthz",
      reuseExistingServer: false,
    },
    {
      command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 13008",
      url: "http://127.0.0.1:13008/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_INTERNAL_URL: "http://127.0.0.1:18006",
        NEXT_DIST_DIR: ".next-e2e",
        NODE_OPTIONS: "--require ./e2e/skip-next-version-check.cjs",
        NEXT_PUBLIC_APP_MODE: "mock",
        NEXT_PUBLIC_ENABLE_MOCKS: "true",
        NEXT_PUBLIC_API_FEATURES: "",
        NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:13008",
      },
    },
  ],
});
