import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Isolated UI contract test: real Next + Chrome, memory-only identity fixture.
// No PostgreSQL, SMTP, live accounts or real credentials are accessed.
const port = 13120;
const apiPort = 18120;
process.env.GP_BASE_URL = `http://localhost:${port}`;
const { launchChrome, closeChrome, openTab, sleep } = await import("./browser-check.mjs");
let generation = 1;
let disabled = true;
let authenticated = true;
let changed = 0;
let preferenceWrites = 0;
let deniedWrites = 0;
const state = () => disabled ? "disabled" : "active";
const session = () => authenticated ? {
  authenticated: true, sessionScope: disabled ? "status_only" : "full", authMethod: "password",
  user: { id: "review-ui", name: "Review User", preferredLocale: "zh-Hans" },
  accountState: state(), csrfToken: `csrf-${generation}`,
  nextAction: { href: disabled ? "/account/status" : "/home" },
} : { authenticated: false };
const me = () => disabled ? { user: { id: "review-ui", name: "Review User" }, registration: { accountState: "disabled", nextAction: { href: "/account/status" } } } : {
  user: { id: "review-ui", name: "Review User", username: "review_user", roles: ["student"], requestedIdentity: "student", studentId: "20231234", college: "", preferredLocale: "zh-Hans", version: 1, googleEmailBound: false, passwordLoginEnabled: true },
  schoolEmail: { verified: true, verifiedEmail: "review@student.must.edu.mo", verifiedAt: "2026-10-10T00:00:00Z", pendingEmail: null },
  registration: { profileComplete: true, profileFieldErrors: {}, schoolEmailVerified: true, identityConfirmed: true, securityComplete: true, requiredCompletedCount: 3, canEnterWorkspace: true, loginEmailVerified: true, teacherReviewStatus: null, academicIdentityStatus: "unverified", verificationBasis: [{ kind: "password_auth" }], accountState: "active", nextAction: { href: "/home" } },
  teacherApplication: null, studentIdRule: { pattern: "^.+$", emailPrefixRule: "none", confirmedBySchool: false },
};
const api = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  const send = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (req.method !== "GET") {
    for await (const _chunk of req) { /* drain body; never log passwords */ }
    const valid = req.headers["x-csrf-token"] === `csrf-${generation}` && req.headers.cookie?.includes(`gp_session=review-${generation}`);
    if (!valid) { deniedWrites++; return send({ code: "CSRF_INVALID" }, 403); }
  }
  if (path === "/api/v1/auth/session") return send(session());
  if (path === "/api/v1/auth/capabilities") return send({ acceptanceTest: { enabled: false }, google: { enabled: false, available: false }, password: { enabled: true, available: true }, emailSignup: { enabled: true, available: true }, passwordReset: { enabled: true, available: true } });
  if (path === "/api/v1/me") return send(me());
  if (path === "/api/v1/me/password") {
    generation++; changed++;
    res.setHeader("Set-Cookie", `gp_session=review-${generation}; Path=/; HttpOnly; SameSite=Lax`);
    return send({ changed: true });
  }
  if (path === "/api/v1/me/preferences") { preferenceWrites++; return send({ saved: true }); }
  if (path === "/api/v1/auth/session/refresh") return send(session());
  if (path === "/api/v1/auth/logout") { authenticated = false; return send({}); }
  return send({ code: "NOT_FOUND" }, 404);
});
await new Promise((resolve, reject) => { api.once("error", reject); api.listen(apiPort, "127.0.0.1", resolve); });
const originalTsconfig = readFileSync("tsconfig.json", "utf8");
let next;
let tab;
let output = "";
try {
  const build = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, NEXT_DIST_DIR: ".next-review", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  build.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
  build.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
  assert.equal(await new Promise((resolve, reject) => { build.on("error", reject); build.on("exit", resolve); }), 0, "isolated build succeeds");
  next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, NEXT_DIST_DIR: ".next-review", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
  next.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${process.env.GP_BASE_URL}/healthz`)).ok) { ready = true; break; } } catch { /* cold start */ }
    await sleep(500);
  }
  assert(ready, "isolated Next server starts");
  await launchChrome();
  tab = await openTab();
  await tab.send("Network.setCookie", { name: "gp_session", value: "review-1", url: process.env.GP_BASE_URL, httpOnly: true });
  await tab.send("Network.setCookie", { name: "gp_locale", value: "zh-Hans", url: process.env.GP_BASE_URL });
  for (const path of ["profile", "email", "status", "security"]) {
    await tab.goto(`/account/${path}`);
    await tab.waitFor(`document.querySelector('[role="status"]') && document.body.textContent.includes('停用')`, 30000);
    assert(!(await tab.text()).includes("Application error"), `disabled ${path} renders`);
    assert(await tab.evaluate("document.querySelector('.gp-enter-button')?.disabled"), "disabled cannot enter");
  }
  disabled = false;
  await tab.goto("/account/profile");
  await tab.waitFor("!!document.querySelector('form')", 30000);
  assert(!(await tab.text()).includes("Google 账号"), "password-only profile does not claim Google binding");
  await tab.goto("/account/security");
  await tab.waitFor("!!document.querySelector('input[autocomplete=\"current-password\"]')", 30000);
  for (let i = 1; i <= 2; i++) {
    await tab.type('input[autocomplete="current-password"]', `example-password-${i}`);
    await tab.type('input[autocomplete="new-password"]', `example-password-${i + 1}`);
    await tab.clickByText("修改密码", "button");
    await tab.waitFor("document.querySelector('input[autocomplete=\"current-password\"]').value === ''", 10000);
    assert.equal(changed, i, "consecutive password changes use the rotated session");
  }
  await tab.clickByText("简体中文", "button");
  await tab.clickByText("English", '[role="menuitemradio"]');
  for (let i = 0; i < 30 && preferenceWrites === 0; i++) await sleep(200);
  assert.equal(preferenceWrites, 1, "locale preference uses current CSRF after rotation");
  await tab.waitFor("document.documentElement.lang === 'en'", 15000);
  await tab.clickByText("Sign out", "button");
  await tab.waitFor("location.pathname === '/login'", 15000);
  assert.equal(authenticated, false, "logout invalidates the current session");
  assert.equal(deniedWrites, 0, "no stale CSRF requests");
  console.log("Account review UI passed: four disabled pages, Google binding state, two password rotations, locale persistence and logout.");
} catch (error) {
  console.error("UI failure context:", await tab?.evaluate("({path: location.pathname, text: document.body.innerText.slice(0, 1400)})").catch(() => null));
  throw error;
} finally {
  writeFileSync("tsconfig.json", originalTsconfig);
  writeFileSync("/tmp/groupproof-account-review-next.log", output);
  tab?.ws.close();
  closeChrome();
  next?.kill("SIGTERM");
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
}
