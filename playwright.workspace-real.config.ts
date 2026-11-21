import { defineConfig } from "@playwright/test";

// A staging build must ignore even accidentally enabled demo flags. HTTP responses
// below come from isolated loopback/browser fixtures; no live account is modified.
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["workspace-real.spec.ts", "b-*-real.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  // Dynamic business pages compile on first use in the isolated Next dev server.
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:13008",
    locale: "zh-CN",
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
      // Compile the real same-origin session proxy before any CSRF-protected writes.
      url: "http://127.0.0.1:13008/api/v1/auth/session",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_INTERNAL_URL: "http://127.0.0.1:18006",
        NEXT_DIST_DIR: ".next-workspace-real",
        NODE_OPTIONS: "--require ./e2e/skip-next-version-check.cjs",
        NEXT_PUBLIC_APP_ENV: "staging",
        NEXT_PUBLIC_APP_MODE: "mock",
        NEXT_PUBLIC_ENABLE_MOCKS: "true",
        NEXT_PUBLIC_API_FEATURES: "workspace=mock,daily=mock,inbox=mock,cworkspace=mock,courses=mock,projects=mock",
        NEXT_PUBLIC_API_BASE_URL: "",
      },
    },
  ],
});
