import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

// This rollout is deliberately bound to the existing, isolated staging project.
const projectId = "8f89e295-3661-47a7-aee7-b4b26b2f5b06";
const environmentId = "ec92103f-adb3-4971-98c8-3293ca9f5409";
const environment = "production"; // Railway's name inside the staging project.
const apiId = "b43a1be8-b13c-4398-8b1e-e37a99d7da72";
const identityId = "ace63816-4094-48e5-b9ff-45d7dfa44d06";
const webId = "78e3189c-8a18-406d-9c64-f5f8ceb7db53";
const postgresId = "2cb64317-f619-4e7b-bbe6-3ae3180ad3c8";
const origin = "https://groupproof-staging-production.up.railway.app";
const checkOnly = process.argv.includes("--check-only");
assert.equal(process.env.RAILWAY_PROJECT_ID, projectId, "Expected the existing staging project");
assert(process.env.RAILWAY_API_TOKEN, "Railway credential is required");
if (!checkOnly) {
  assert.equal(process.env.GITHUB_REF, "refs/heads/develop", "Deploy only from reviewed develop");
  assert(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME));
  assert.equal(process.env.RAILWAY_SERVICE_ID, webId, "Unexpected staging Web service");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nodes = (connection) => (connection?.edges ?? []).map((edge) => edge.node);
function railway(args, json = false) {
  const result = spawnSync("railway", args, { encoding: "utf8", stdio: json ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.status !== 0) {
    // The CLI's stderr names the cause (expired token, missing project access); it never echoes the token itself.
    const reason = (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Railway ${args[0]} failed: ${reason}`);
  }
  return json ? JSON.parse(result.stdout) : null;
}
async function graphql(query, variables = {}) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.errors) {
    // Railway error messages name the failing operation/permission; tokens and variable values never appear in them.
    const reasons = (result.errors ?? []).map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(`Railway API operation failed (HTTP ${response.status}${reasons ? `: ${reasons}` : ""}); no deployment will proceed`);
  }
  return result.data;
}
async function variablesFor(serviceId) {
  const data = await graphql("query($projectId:String!,$environmentId:String!,$serviceId:String){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}", { projectId, environmentId, serviceId });
  return data.variables;
}
async function setVariables(serviceId, variables) {
  const data = await graphql("mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}", { input: { projectId, environmentId, serviceId, variables, skipDeploys: true } });
  assert.equal(data.variableCollectionUpsert, true, "Settings were not applied");
}
const state = railway(["status", "--project", projectId, "--environment", environment, "--json"], true);
assert.equal(state.name, "groupproof-staging");
const target = nodes(state.environments).find((node) => node.id === environmentId);
assert(target, "Staging environment is missing");
const services = nodes(target.serviceInstances);
assert.equal(services.find((node) => node.serviceId === apiId)?.serviceName, "groupproof");
assert.equal(services.find((node) => node.serviceId === webId)?.serviceName, "groupproof-staging");
const volume = nodes(target.volumeInstances).find((node) => node.serviceId === postgresId);
assert(volume, "Staging PostgreSQL volume is missing");
for (const serviceId of [apiId, webId]) {
  const deployments = railway(["deployment", "list", "--project", projectId, "--environment", environment, "--service", serviceId, "--limit", "1", "--json"], true);
  assert(Array.isArray(deployments), "Unexpected deployment-list contract");
}
const schema = await graphql('query{workflow:__type(name:"WorkflowResult"){fields{name}} states:__type(name:"WorkflowStatus"){enumValues{name}} backup:__type(name:"VolumeInstanceBackup"){fields{name}} variables:__type(name:"VariableCollectionUpsertInput"){inputFields{name}}}');
assert(schema.workflow.fields.some((field) => field.name === "status"));
assert(schema.backup.fields.some((field) => field.name === "id"));
assert(schema.variables.inputFields.some((field) => field.name === "skipDeploys"));
const apiVars = await variablesFor(apiId);
const identityVars = await variablesFor(identityId);
assert(apiVars.DATABASE_URL, "Unified API database is not configured");
const before = await graphql("query($id:String!){volumeInstanceBackupList(volumeInstanceId:$id){id}}", { id: volume.id });
console.log(JSON.stringify({ project: state.name, api: "groupproof", web: "groupproof-staging", postgresVolume: volume.id, existingBackups: before.volumeInstanceBackupList.length, resendConfigured: Boolean(apiVars.RESEND_API_KEY || identityVars.RESEND_API_KEY), workflowStates: schema.states.enumValues.map((value) => value.name) }));
if (checkOnly) process.exit(0);

// Snapshot stays in Railway. No account rows or database dumps are exported to CI.
const name = `before-unified-auth-${process.env.GITHUB_SHA?.slice(0, 12)}`;
const backup = await graphql("mutation($id:String!,$name:String){volumeInstanceBackupCreate(volumeInstanceId:$id,name:$name)}", { id: volume.id, name });
const workflowId = backup.volumeInstanceBackupCreate;
assert(workflowId, "Backup was not accepted");
let backedUp = false;
for (let attempt = 0; attempt < 60; attempt++) {
  const data = await graphql("query($id:String!){workflowStatus(workflowId:$id){status}}", { id: workflowId });
  const status = data.workflowStatus.status.toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE"].includes(status)) { backedUp = true; break; }
  if (["FAILED", "ERROR", "CANCELLED", "CANCELED", "TERMINATED"].includes(status)) throw new Error(`Database backup failed (${status})`);
  await sleep(5000);
}
assert(backedUp, "Backup did not complete; migration and deployment stopped");
const after = await graphql("query($id:String!){volumeInstanceBackupList(volumeInstanceId:$id){id}}", { id: volume.id });
const priorIds = new Set(before.volumeInstanceBackupList.map((item) => item.id));
assert(after.volumeInstanceBackupList.some((item) => !priorIds.has(item.id)), "Completed backup is not listed");
console.log(`Staging database backup completed: ${workflowId}`);

// Preserve the team's database connection and existing credentials. Never copy old
// sessions, acceptance tokens, debug switches or a separate identity database name.
const authVariables = {};
for (const key of ["RESEND_API_KEY", "MAIL_FROM", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "STUDENT_EMAIL_DOMAIN", "TEACHER_EMAIL_DOMAIN", "STUDENT_ID_PATTERN", "STUDENT_ID_EMAIL_RULE"]) {
  if (apiVars[key] || identityVars[key]) authVariables[key] = apiVars[key] || identityVars[key];
}
Object.assign(authVariables, {
  APP_ENV: "staging", APP_MODE: apiVars.APP_MODE || identityVars.APP_MODE || "dev",
  APP_ORIGIN: origin, PORT: "8000", MAIL_MODE: "resend", MAIL_PUBLIC_ENABLED: "false",
  AUTH_GOOGLE_ENABLED: "true", AUTH_PASSWORD_ENABLED: "true",
  AUTH_EMAIL_SIGNUP_ENABLED: "true", AUTH_PASSWORD_RESET_ENABLED: "true",
  DEBUG_ENDPOINTS: "false", ENABLE_DEMO_AUTH: "false", ACCEPTANCE_TEST_TOKEN: "",
  EMAIL_CHALLENGE_HMAC_KEY: apiVars.EMAIL_CHALLENGE_HMAC_KEY || identityVars.EMAIL_CHALLENGE_HMAC_KEY || randomBytes(32).toString("hex"),
});
await setVariables(apiId, authVariables);
await graphql("mutation($s:String!,$e:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$input)}", {
  s: apiId, e: environmentId, input: { rootDirectory: "services/api", railwayConfigFile: "/services/api/railway.toml", builder: "DOCKERFILE", dockerfilePath: "Dockerfile", preDeployCommand: ["alembic upgrade head"], preDeployTimeoutSeconds: 300, healthcheckPath: "/readyz", healthcheckTimeout: 120, startCommand: "uvicorn app.main:app --host 0.0.0.0 --port $PORT" },
});
async function deploy(serviceId, label) {
  const args = ["--project", projectId, "--environment", environment, "--service", serviceId];
  const previous = railway(["deployment", "list", ...args, "--limit", "1", "--json"], true)[0]?.id;
  railway(["up", "--ci", ...args, "--message", `Reviewed develop ${process.env.GITHUB_SHA} (${label})`]);
  for (let attempt = 0; attempt < 120; attempt++) {
    const latest = railway(["deployment", "list", ...args, "--limit", "1", "--json"], true)[0];
    if (latest && latest.id !== previous) {
      if (latest.status === "SUCCESS") { console.log(`${label} is ready: ${latest.id}`); return; }
      if (["FAILED", "CRASHED", "REMOVED", "CANCELED"].includes(latest.status)) throw new Error(`${label} deployment failed (${latest.status})`);
    }
    await sleep(5000);
  }
  throw new Error(`${label} did not become ready`);
}
await deploy(apiId, "Unified API");
await setVariables(webId, { API_INTERNAL_URL: "http://groupproof.railway.internal:8000", NEXT_PUBLIC_APP_ENV: "staging" });
await deploy(webId, "Web");
const session = await fetch(`${origin}/api/v1/auth/session`, { signal: AbortSignal.timeout(30_000) });
assert.equal(session.status, 200);
assert.equal((await session.json()).data.authenticated, false);
const capabilities = await fetch(`${origin}/api/v1/auth/capabilities`);
assert.equal(capabilities.status, 200);
const settings = (await capabilities.json()).data;
assert.equal(settings.password.available, true);
assert.equal(settings.emailSignup.available, false);
assert.equal(settings.passwordReset.available, false);
assert.equal(settings.acceptanceTest.enabled, false);
assert.equal((await fetch(`${origin}/api/v1/me`)).status, 401);
const home = await fetch(`${origin}/home`, { redirect: "manual" });
assert([302, 303, 307, 308].includes(home.status));
assert.equal(new URL(home.headers.get("location"), origin).pathname, "/login");
assert.equal((await fetch(`${origin}/login`)).status, 200);
console.log(`Verified staging: ${origin}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Staging deployed and anonymous authentication checks passed: [Open test site](${origin}).\n\nDatabase backup workflow: ${workflowId}. Public mail remains disabled.\n`);
