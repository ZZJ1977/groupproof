import { defineConfig } from "@playwright/test";

// C UI regression against explicit mock business data, not production acceptance.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "c-*.spec.ts",
  testIgnore: ["c-*-api.spec.ts"],
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:13006",
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
      command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 13006",
      url: "http://127.0.0.1:13006/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_INTERNAL_URL: "http://127.0.0.1:18006",
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_APP_MODE: "mock",
        NEXT_PUBLIC_ENABLE_MOCKS: "true",
        NEXT_PUBLIC_API_FEATURES: "admin=real",
        NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:13006",
      },
    },
  ],
});
