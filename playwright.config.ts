import { defineConfig } from "@playwright/test";

// Isolated anonymous identity fixture: no live database, SMTP or OAuth credentials.
const webPort = 13005;
const identityPort = 18005;

export default defineConfig({
  testDir: "./e2e",
  // C's authenticated mock-workspace cases use their own loopback identity fixture.
  testIgnore: "c-*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    locale: "zh-CN",
    channel: process.platform === "darwin" ? "chrome" : undefined,
  },
  webServer: [
    {
      command: "node e2e/auth-fixture.mjs",
      url: `http://127.0.0.1:${identityPort}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --hostname 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_INTERNAL_URL: `http://127.0.0.1:${identityPort}`,
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_ENABLE_MOCKS: "true",
      },
    },
  ],
});
