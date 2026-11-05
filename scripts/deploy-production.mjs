import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Production rollout for the Railway project "groupproof-production" (Web + FastAPI API + Postgres + Redis + worker).
// Unlike the staging script, nothing is hard-coded: services and the Postgres volume are resolved by name
// from the project that GitHub Environment `production` points at, and the script refuses to run anywhere else.
//
// It never writes mail, Google, HMAC or database credentials. An operator sets those in Railway; this script
// only verifies they are present (failing before any deployment) and then applies the service settings,
// backs up the database when the plan allows it, deploys the API (its pre-deploy command runs the Alembic
// migrations) and the Web service, and checks the result without needing a signed-in user.
//
//   node scripts/deploy-production.mjs --check-only   # read-only: resolves services, validates variables
const API_SERVICE = "groupproof";
const WEB_SERVICE = "groupproof-production";
const PROJECT_NAME = "groupproof-production";
const environment = process.env.RAILWAY_ENVIRONMENT || "production"; // Railway's environment name inside the project.
const projectId = process.env.RAILWAY_PROJECT_ID;
const checkOnly = process.argv.includes("--check-only");
assert(projectId, "RAILWAY_PROJECT_ID is required");
assert(process.env.RAILWAY_API_TOKEN, "Railway credential is required");
if (!checkOnly) {
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Production deploys only from reviewed main");
  assert(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME), "Unexpected trigger for a production deploy");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nodes = (connection) => (connection?.edges ?? []).map((edge) => edge.node);
function railway(args, json = false) {
  const result = spawnSync("railway", args, { encoding: "utf8", stdio: json ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.status !== 0) {
    const detail = json ? String(result.stderr || result.error?.message || "").trim().slice(0, 300) : "";
    throw new Error(`Railway ${args[0]} failed${detail ? `: ${detail}` : ""}`);
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

const state = railway(["status", "--project", projectId, "--environment", environment, "--json"], true);
assert.equal(state.name, PROJECT_NAME, `Expected the ${PROJECT_NAME} project`);
const target = nodes(state.environments).find((node) => node.name === environment);
assert(target, `Environment ${environment} is missing`);
const environmentId = target.id;
const services = nodes(target.serviceInstances);
const apiId = services.find((node) => node.serviceName === API_SERVICE)?.serviceId;
const webId = services.find((node) => node.serviceName === WEB_SERVICE)?.serviceId;
assert(apiId, `Service ${API_SERVICE} (API) was not found`);
assert(webId, `Service ${WEB_SERVICE} (Web) was not found`);
if (!checkOnly) assert.equal(process.env.RAILWAY_SERVICE_ID, webId, "RAILWAY_SERVICE_ID must be the production Web service");
const postgresId = services.find((node) => /^postgres/i.test(node.serviceName))?.serviceId;
const volume = nodes(target.volumeInstances).find((node) => node.serviceId === postgresId);
assert(volume, "Production PostgreSQL volume is missing");

async function variablesFor(serviceId) {
  const data = await graphql("query($projectId:String!,$environmentId:String!,$serviceId:String){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}", { projectId, environmentId, serviceId });
  return data.variables;
}
async function setVariables(serviceId, variables) {
  const data = await graphql("mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}", { input: { projectId, environmentId, serviceId, variables, skipDeploys: true } });
  assert.equal(data.variableCollectionUpsert, true, "Settings were not applied");
}

// ---- Validate the operator-managed configuration before touching anything. ----
const apiVars = await variablesFor(apiId);
const problems = [];
const need = (name, ok = Boolean(apiVars[name]), hint = "") => { if (!ok) problems.push(`${name}${hint ? ` ${hint}` : ""}`); };
need("DATABASE_URL");
need("APP_MODE", apiVars.APP_MODE === "real", "must be real");
need("APP_ORIGIN", /^https:\/\/[^/]+$/.test(apiVars.APP_ORIGIN ?? ""), "must be the production https origin without a trailing slash");
need("EMAIL_CHALLENGE_HMAC_KEY");
const mailMode = apiVars.MAIL_MODE;
need("MAIL_MODE", ["resend", "brevo", "smtp"].includes(mailMode), "must be resend, brevo or smtp (never capture)");
if (mailMode === "resend") need("RESEND_API_KEY");
if (mailMode === "brevo") need("BREVO_API_KEY");
need("MAIL_FROM");
const googleEnabled = apiVars.AUTH_GOOGLE_ENABLED !== "false";
if (googleEnabled) {
  need("GOOGLE_CLIENT_ID");
  need("GOOGLE_CLIENT_SECRET");
  need("GOOGLE_REDIRECT_URI", apiVars.GOOGLE_REDIRECT_URI === `${apiVars.APP_ORIGIN}/api/v1/auth/google/callback`, "must equal APP_ORIGIN + /api/v1/auth/google/callback");
}
need("ACCEPTANCE_TEST_TOKEN", !apiVars.ACCEPTANCE_TEST_TOKEN, "must be empty in production");
need("DEBUG_ENDPOINTS", apiVars.DEBUG_ENDPOINTS !== "true", "must not be true in production");
if (problems.length) {
  console.error("Production configuration is incomplete; nothing was deployed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const origin = apiVars.APP_ORIGIN;
const mailPublic = apiVars.MAIL_PUBLIC_ENABLED === "true";
console.log(JSON.stringify({ project: state.name, api: API_SERVICE, web: WEB_SERVICE, origin, mailMode, mailPublic, google: googleEnabled, checkOnly }));
if (checkOnly) process.exit(0);

// ---- Database snapshot (Pro workspaces only; any other backup failure stops the rollout). ----
const name = `before-production-${process.env.GITHUB_SHA?.slice(0, 12)}`;
let workflowId = null;
try {
  const backup = await graphql("mutation($id:String!,$name:String){volumeInstanceBackupCreate(volumeInstanceId:$id,name:$name){workflowId}}", { id: volume.id, name });
  workflowId = backup.volumeInstanceBackupCreate.workflowId;
} catch (error) {
  if (!/only available for Pro/i.test(String(error?.message))) throw error;
  console.warn("Railway workspace does not support manual backups; continuing WITHOUT a database snapshot.");
}
if (workflowId) {
  let backedUp = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const data = await graphql("query($id:String!){workflowStatus(workflowId:$id){status}}", { id: workflowId });
    const status = data.workflowStatus.status.toUpperCase();
    if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE"].includes(status)) { backedUp = true; break; }
    if (["FAILED", "ERROR", "CANCELLED", "CANCELED", "TERMINATED"].includes(status)) throw new Error(`Database backup failed (${status})`);
    await sleep(5000);
  }
  assert(backedUp, "Backup did not complete; migration and deployment stopped");
  console.log(`Production database backup completed: ${workflowId}`);
}

// ---- Service settings. Railway runs a Dockerfile start command in exec form, so wrap it to expand $PORT. ----
const API_START_COMMAND = `sh -c 'exec uvicorn app.main:app --host 0.0.0.0 --port "\${PORT:-8000}"'`;
await setVariables(apiId, { APP_ENV: "production", PORT: "8000", DATABASE_TIMEZONE: apiVars.DATABASE_TIMEZONE || "Asia/Shanghai" });
await graphql("mutation($s:String!,$e:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$input)}", {
  s: apiId, e: environmentId, input: { rootDirectory: "services/api", dockerfilePath: "Dockerfile", preDeployCommand: ["alembic upgrade head"], preDeployTimeoutSeconds: 300, healthcheckPath: "/readyz", healthcheckTimeout: 120, startCommand: API_START_COMMAND },
});
async function deploy(serviceId, label) {
  const args = ["--project", projectId, "--environment", environment, "--service", serviceId];
  const previous = railway(["deployment", "list", ...args, "--limit", "1", "--json"], true)[0]?.id;
  railway(["up", "--ci", ...args, "--message", `Reviewed main ${process.env.GITHUB_SHA} (${label})`]);
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
await setVariables(webId, { API_INTERNAL_URL: `http://${API_SERVICE}.railway.internal:8000`, NEXT_PUBLIC_APP_ENV: "production" });
await deploy(webId, "Web");

// ---- Post-deploy checks that need no signed-in user. ----
const session = await fetch(`${origin}/api/v1/auth/session`, { signal: AbortSignal.timeout(30_000) });
assert.equal(session.status, 200);
assert.equal((await session.json()).data.authenticated, false);
const capabilities = await fetch(`${origin}/api/v1/auth/capabilities`);
assert.equal(capabilities.status, 200);
const settings = (await capabilities.json()).data;
assert.equal(settings.password.available, true);
assert.equal(settings.acceptanceTest.enabled, false);
assert.equal(settings.emailSignup.available, mailPublic);
assert.equal(settings.schoolEmailVerification.available, mailPublic);
if (googleEnabled) {
  assert.equal(settings.google.available, true);
  const googleStart = await fetch(`${origin}/api/v1/auth/google/start`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  assert.equal(googleStart.status, 302, "Google authorization could not be started");
  const authorization = new URL(googleStart.headers.get("location"));
  assert.equal(authorization.hostname, "accounts.google.com", "Google authorization endpoint is unexpected");
  assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/api/v1/auth/google/callback`);
}
assert.equal((await fetch(`${origin}/api/v1/me`)).status, 401);
const home = await fetch(`${origin}/home`, { redirect: "manual" });
assert([302, 303, 307, 308].includes(home.status));
assert.equal(new URL(home.headers.get("location"), origin).pathname, "/login");
assert.equal((await fetch(`${origin}/login`)).status, 200);
console.log(`Verified production: ${origin}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Production deployed and anonymous authentication checks passed: [Open site](${origin}).\n\n${workflowId ? `Database backup workflow: ${workflowId}.` : "No database snapshot was taken (Railway manual backups need a Pro workspace)."} Public mail is ${mailPublic ? "enabled" : "disabled"}.\n`);
