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
