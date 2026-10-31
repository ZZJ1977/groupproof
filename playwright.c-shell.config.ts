import { defineConfig } from "@playwright/test";
import base from "./playwright.c.config";
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base, testMatch: "c-shell-api.spec.ts", testIgnore: [],
  webServer: servers.map((server) => ({ ...server, env: { ...server.env,
    NEXT_PUBLIC_APP_MODE: "real", NEXT_PUBLIC_ENABLE_MOCKS: "false",
    NEXT_PUBLIC_API_FEATURES: "", NEXT_PUBLIC_API_BASE_URL: "",
  } })),
});
