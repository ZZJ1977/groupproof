import assert from "node:assert/strict";
import { parseFeatureOverrides, resolveApiMode } from "../lib/api/config";

assert.deepEqual(parseFeatureOverrides("workspace=real,tasks:mock,ignored=real"), {
  workspace: "real",
  tasks: "mock",
});
assert.deepEqual(parseFeatureOverrides(undefined), {});
assert.deepEqual(parseFeatureOverrides("workspace=invalid,evidence=real"), { evidence: "real" });
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: true }), "mock");
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: false }), "real");
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: true, overrides: { workspace: "real" } }), "real");
assert.equal(resolveApiMode("workspace", { globalMocksEnabled: false, overrides: { workspace: "mock" } }), "mock");

console.log("API feature configuration parsing passed");
