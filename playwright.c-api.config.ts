import { defineConfig } from "@playwright/test";
import base from "./playwright.c.config";

// Browser tests exercise real API page branches with explicit intercepted fixtures.
// Run serially with the other C suites because the loopback ports are shared.
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  testMatch: ["c-project-api.spec.ts", "c-course-files-api.spec.ts", "c-execution-api.spec.ts", "c-governance-api.spec.ts", "c-identity-api.spec.ts", "c-inbox-api.spec.ts", "c-proxy-api.spec.ts", "c-evidence-source-api.spec.ts"],
  testIgnore: [],
  webServer: servers.map((server) => ({
    ...server,
    env: { ...server.env, NEXT_PUBLIC_API_FEATURES: "admin=real,cworkspace=real,coursefiles=real,cidentity=real,governance=real,inbox=real" },
  })),
});
