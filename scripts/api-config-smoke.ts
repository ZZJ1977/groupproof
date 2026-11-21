import assert from "node:assert/strict";
import { apiFeatures, parseFeatureOverrides, resolveApiEnvironment, resolveApiMode } from "../lib/api/config";

assert.deepEqual(parseFeatureOverrides("workspace=real,tasks:mock,ignored=real"), {
  workspace: "real",
  tasks: "mock",
});
assert.deepEqual(parseFeatureOverrides(undefined), {});
assert.deepEqual(parseFeatureOverrides("daily=real,workspace=mock"), { daily: "real", workspace: "mock" });
assert.deepEqual(parseFeatureOverrides("workspace=invalid,evidence=real"), { evidence: "real" });
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: true }), "mock");
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: false }), "real");
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: true, overrides: { workspace: "real" } }), "real");
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: false, overrides: { workspace: "mock" } }), "mock");
assert.equal(
  resolveApiMode("workspace", {
    globalMocksEnabled: true,
    overrides: { workspace: "mock" },
    productionLock: true,
  }),
  "real",
);
assert.equal(resolveApiMode("tasks", { globalMocksEnabled: true, productionLock: false }), "mock");

// Missing/empty configuration starts from real data, including local development.
for (const appEnv of [undefined, "", "development", "test"]) {
  for (const enableMocks of [undefined, "", "false"]) {
    const options = resolveApiEnvironment({ appEnv, enableMocks });
    for (const feature of apiFeatures) assert.equal(resolveApiMode(feature, options), "real");
  }
}
// Demo fixtures remain an explicit opt-in for isolated development and test harnesses.
for (const appEnv of ["development", "test"]) {
  assert.equal(resolveApiMode("workspace", resolveApiEnvironment({ appEnv, enableMocks: "true" })), "mock");
  assert.equal(resolveApiMode("workspace", resolveApiEnvironment({ appEnv, features: "workspace=mock" })), "mock");
}
// A stale Railway flag or per-feature override can never enable demo data on a deployed site.
for (const appEnv of ["staging", "production", " STAGING ", " Production "]) {
  const options = resolveApiEnvironment({
    appEnv,
    enableMocks: "true",
    features: apiFeatures.map((feature) => `${feature}=mock`).join(","),
  });
  for (const feature of apiFeatures) assert.equal(resolveApiMode(feature, options), "real");
}

console.log("API feature configuration parsing passed");
