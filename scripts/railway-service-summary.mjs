// Print service identities and readiness settings, never variables or credentials.
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(0, "utf8"));
const allowed = new Set(["id", "name", "serviceName", "serviceId", "environmentId", "volumeId", "domain", "rootDirectory", "healthcheckPath", "preDeployCommand", "status", "branch", "repo"]);
function filtered(value) {
  if (Array.isArray(value)) return value.map(filtered).filter(Boolean);
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [key, field] of Object.entries(value)) {
    if (/variable|secret|token|password/i.test(key)) continue;
    if (allowed.has(key) && ["string", "number", "boolean"].includes(typeof field)) result[key] = field;
    else if (typeof field === "object") {
      const child = filtered(field);
      if (child && Object.keys(child).length) result[key] = child;
    }
  }
  return Object.keys(result).length ? result : null;
}
console.log(JSON.stringify(filtered(state), null, 2));
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
