import { defineConfig } from "@playwright/test";
import base from "./playwright.c.config";

// Canonical read-only page contracts with intercepted API fixtures.
// Run sequentially with the other C suite; they share the loopback ports/cache.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  testMatch: "c-daily-api.spec.ts",
  testIgnore: [],
  webServer: servers.map((server) => ({
    ...server,
    env: { ...server.env, NEXT_PUBLIC_API_FEATURES: "admin=real,daily=real" },
  })),
});
