import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// These services are provisioned by the Railway owner. This script configures and
// deploys them only after the API migration has succeeded in the existing workflow.
const projectId = process.env.RAILWAY_PROJECT_ID;
const environment = process.env.RAILWAY_ENVIRONMENT || "production";
const checkOnly = process.argv.includes("--check-only");
const targets = [
  {
    name: "groupproof-report-worker",
    command: "celery -A app.modules.d.report_tasks:celery_app worker --loglevel=info",
    needsRedis: true,
  },
  {
    name: "groupproof-risk-scheduler",
    command: "python -m scripts.daily_risks --loop",
  },
];

assert(projectId, "RAILWAY_PROJECT_ID is required");
assert(process.env.RAILWAY_API_TOKEN, "RAILWAY_API_TOKEN is required");
assert(["refs/heads/develop", "refs/heads/main"].includes(process.env.GITHUB_REF));
assert(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME));

function railway(args, json = false) {
  const result = spawnSync("railway", args, {
    encoding: "utf8",
    stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) throw new Error(`Railway ${args[0]} failed`);
  return json ? JSON.parse(result.stdout) : null;
}

async function graphql(query, variables) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.errors) {
    throw new Error(`Railway API request failed (HTTP ${response.status})`);
  }
  return result.data;
}

const state = railway(["status", "--project", projectId, "--environment", environment, "--json"], true);
const nodes = (connection) => (connection?.edges ?? []).map((edge) => edge.node);
const instance = nodes(state.environments).find((node) => node.name === environment);
assert(instance, `Railway environment ${environment} was not found`);
const environmentId = instance.id;
const services = nodes(instance.serviceInstances);
const api = services.find((service) => service.serviceName === "groupproof");
assert(api, "Unified API service was not found");

// Check every dependency before changing any service configuration.
for (const target of targets) {
  target.id = services.find((service) => service.serviceName === target.name)?.serviceId;
  assert(target.id, `Provision Railway service ${target.name} before deploying`);
  const data = await graphql(
    "query($projectId:String!,$environmentId:String!,$serviceId:String){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}",
    { projectId, environmentId, serviceId: target.id },
  );
  assert(data.variables.DATABASE_URL, `${target.name} needs DATABASE_URL`);
  if (target.needsRedis) assert(data.variables.REDIS_URL, `${target.name} needs REDIS_URL`);
}
console.log(`Validated D workers in ${state.name}/${environment}`);
if (checkOnly) process.exit(0);

for (const target of targets) {
  await graphql(
    "mutation($s:String!,$e:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$input)}",
    {
      s: target.id,
      e: environmentId,
      input: {
        rootDirectory: "services/api",
        dockerfilePath: "Dockerfile",
        startCommand: target.command,
      },
    },
  );
  const args = ["--project", projectId, "--environment", environment, "--service", target.id];
  const previous = railway(["deployment", "list", ...args, "--limit", "1", "--json"], true)[0]?.id;
  railway(["up", "--ci", ...args, "--message", `Reviewed ${process.env.GITHUB_SHA} (${target.name})`]);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const latest = railway(["deployment", "list", ...args, "--limit", "1", "--json"], true)[0];
    if (latest?.id !== previous) {
      if (latest?.status === "SUCCESS") { ready = true; break; }
      if (["FAILED", "CRASHED", "REMOVED", "CANCELED"].includes(latest?.status)) {
        throw new Error(`${target.name} deployment failed (${latest.status})`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert(ready, `${target.name} did not become ready`);
  console.log(`${target.name} is ready`);
}
