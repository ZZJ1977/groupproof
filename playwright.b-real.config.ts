import { defineConfig } from "@playwright/test";
import base from "./playwright.b.config";

// Same fixture with `bworkspace=real`: B pages must show "接口未接入", never demo data.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  testMatch: "b-*-real.spec.ts",
  testIgnore: [],
  webServer: servers.map((server) => ({ ...server, env: { ...server.env, NEXT_PUBLIC_API_FEATURES: "bworkspace=real" } })),
});
