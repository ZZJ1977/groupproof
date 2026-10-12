// Print service identities and readiness settings, never variables or credentials.
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(0, "utf8"));
function visit(value) {
  if (Array.isArray(value)) return value.forEach(visit);
  if (!value || typeof value !== "object") return;
  if (typeof value.id === "string" && typeof value.name === "string") {
    console.log(JSON.stringify({ id: value.id, name: value.name }));
  }
  for (const [key, field] of Object.entries(value)) {
    if (["domain", "rootDirectory", "healthcheckPath", "preDeployCommand"].includes(key) && typeof field === "string") {
      console.log(JSON.stringify({ [key]: field }));
    }
    if (!/variable|secret|token|password/i.test(key)) visit(field);
  }
}
visit(state);
