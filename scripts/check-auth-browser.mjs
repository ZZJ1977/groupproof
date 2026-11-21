import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { assertCaptureApi, readCapturedCode } from "./browser-check.mjs";

// Run against an isolated loopback web app with a disposable PostgreSQL database.
// The API container must publish port 8000 to loopback and run with APP_MODE=dev,
// MAIL_MODE=capture, APP_ORIGIN matching GP_BASE_URL, and DATABASE_URL pointing to
// groupproof_signup_test. Apply Alembic migrations before running this check.
// Start Next with API_INTERNAL_URL=http://127.0.0.1:<test-api-port> and skip predev
// (for example, npx next dev --hostname 127.0.0.1 --port 13009).
const origin = new URL(process.env.GP_BASE_URL ?? "http://localhost:13009");
assert(["localhost", "127.0.0.1"].includes(origin.hostname), "Browser checks require loopback");
const dbContainer = process.env.GP_AUTH_TEST_DB_CONTAINER ?? "gp-signup-browser-test-db";
const database = "groupproof_signup_test";
const registrationPath = "/api/v1/auth/email/registrations";
const mePath = "/api/v1/me";
const password = "MacaoStudy42";
const stamp = Date.now().toString().slice(-9) + randomInt(100, 1000);
const shots = process.env.GP_AUTH_TEST_SCREENSHOTS;
const deadline = { timeout: 20_000 };

async function payload(response) {
  const body = await response.json();
  return body.data ?? body;
}

function query(sql, email) {
  return execFileSync("docker", [
    "exec", "-i", dbContainer, "psql", "-XAt", "-U", "groupproof", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-v", `mail=${email}`,
  ], { encoding: "utf8", input: `${sql}\n` }).trim();
}

async function screenshot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

async function signup(page, context, email, { checkInputErrors = false } = {}) {
  await page.goto("/login");
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const address = dialog.getByRole("textbox", { name: "学校邮箱", exact: true });
  await expect(address).toBeFocused(deadline);
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  if (checkInputErrors) {
    await address.fill(`outside-${stamp}@example.invalid`);
    await dialog.getByRole("button", { name: "发送验证码" }).click();
    await expect(dialog.getByRole("alert")).toContainText(/学校邮箱|学校域名/, deadline);
  }
  await address.fill(email);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === registrationPath),
    dialog.getByRole("button", { name: "发送验证码" }).click(),
  ]);
  assert.equal(response.status(), 200, "School email registration request should succeed");
  const tx = await payload(response);
  assert.equal(tx.status, "captured", "Mail should stay in the isolated capture database");
  const profilePath = `${registrationPath}/${tx.id}/profile`;
  assert.equal((await context.request.get(profilePath)).ok(), false, "Profile data is gated on OTP verification");
  const otp = dialog.locator('input[autocomplete="one-time-code"]');
  await expect(otp).toBeVisible(deadline);
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);

  const code = readCapturedCode(email);
  assert.match(code, /^\d{6}$/, "Capture store should contain a six-digit registration code");
  if (checkInputErrors) {
    await otp.fill(code === "000000" ? "111111" : "000000");
    await dialog.getByRole("button", { name: "验证邮箱" }).click();
    await expect(dialog.getByText(/验证码不正确/)).toBeVisible(deadline);
  }
  await otp.fill(code);
  await dialog.getByRole("button", { name: "验证邮箱" }).click();
  await expect(page).toHaveURL(/\/register\/profile\?tx=/, deadline);
  await expect(page.getByRole("heading", { name: /完善个人/ })).toBeVisible(deadline);
  await expect(dialog).toHaveCount(0);
  const profile = await context.request.get(profilePath);
  assert.equal(profile.status(), 200);
  assert.equal((await payload(profile)).email, email);
  return profilePath;
}

async function fillProfile(page, email, identity, { checkInputErrors = false } = {}) {
  await expect(page.getByLabel("学校邮箱", { exact: true })).toHaveValue(email, deadline);
  await expect(page.getByLabel("学校邮箱", { exact: true })).toHaveAttribute("readonly", "", deadline);
  await expect(page.getByLabel("用户名", { exact: true })).toHaveCount(0);
  await page.getByLabel("姓名", { exact: true }).fill(identity === "student" ? "周同学" : "陈老师");
  const studentId = page.getByLabel("学号", { exact: true });
  if (identity === "student") await studentId.fill(stamp);
  else await expect(studentId).toHaveCount(0);
  await expect(page.getByLabel(/GitHub 用户名|飞书账号/)).toHaveCount(0);
  await page.getByLabel("账号密码", { exact: true }).fill(password);
  const confirmation = page.getByLabel("确认账号密码", { exact: true });
  const submit = page.getByRole("button", { name: "完成注册" });
  if (checkInputErrors) {
    await confirmation.fill(`${password}x`);
    await submit.click();
    await expect(page.getByText(/两次.*密码.*不一致|密码.*一致/)).toBeVisible(deadline);
    await expect(page).toHaveURL(/\/register\/profile/);
  }
  await confirmation.fill(password);
  await submit.click();
}

async function verifyPersonalGithubEntry(page) {
  const response = await page.request.get(`${mePath}/identities/github`);
  assert.equal(response.status(), 200);
  const identity = await payload(response);
  assert.equal(identity.login, null, "Signup must not create a GitHub binding");
  await page.goto("/account/security#github-identity");
  const panel = page.locator("#github-identity");
  await expect(panel).toBeVisible(deadline);
  if (identity.available) {
    await expect(panel.getByRole("button", { name: "授权绑定 GitHub" })).toBeEnabled(deadline);
  } else {
    await expect(panel.getByText("此环境的 GitHub 个人授权暂不可用。")).toBeVisible(deadline);
  }
}

await assertCaptureApi(origin.origin);
const browser = await chromium.launch({ channel: process.platform === "darwin" ? "chrome" : undefined });
try {
  const student = await browser.newContext({ locale: "zh-CN", baseURL: origin.origin, viewport: { width: 1440, height: 900 } });
  const studentPage = await student.newPage();
  const studentEmail = `${stamp}@student.must.edu.mo`;
  const profilePath = await signup(studentPage, student, studentEmail, { checkInputErrors: true });
  const stranger = await browser.newContext({ baseURL: origin.origin });
  assert.equal((await stranger.request.get(profilePath)).ok(), false, "A second browser cannot use the verified signup grant");
  await stranger.close();
  await studentPage.reload();
  await expect(studentPage.getByLabel("学校邮箱", { exact: true })).toHaveValue(studentEmail, deadline);
  await screenshot(studentPage, "signup-profile-desktop");
  await fillProfile(studentPage, studentEmail, "student", { checkInputErrors: true });
  await expect(studentPage).toHaveURL(/\/home(?:\?|$)/, deadline);
  const me = await payload(await student.request.get(mePath));
  assert.equal(me.schoolEmail.verified, true);
  assert.equal(me.user.githubUsername, null);
  assert.equal(me.user.feishuAccount, null);
  await verifyPersonalGithubEntry(studentPage);
  assert.equal(query("SELECT count(*) FROM email_outbox WHERE to_email = :'mail';", studentEmail), "1", "Reuse the first school email verification");

  const returning = await browser.newContext({ locale: "zh-CN", baseURL: origin.origin });
  const login = await returning.newPage();
  await login.goto("/login");
  await login.getByLabel("用户名或邮箱", { exact: true }).fill(studentEmail);
  await login.getByLabel("密码", { exact: true }).fill(password);
  await login.getByRole("button", { name: "登录", exact: true }).click();
  await expect(login).toHaveURL(/\/home(?:\?|$)/, deadline);

  await login.goto("/login");
  await login.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(login.getByRole("dialog").getByLabel("学校邮箱", { exact: true })).toBeFocused();
  await login.keyboard.press("Escape");
  await expect(login.getByRole("dialog")).toHaveCount(0);
  await login.getByRole("button", { name: "忘记密码" }).click();
  const recovery = login.getByRole("dialog");
  await recovery.getByLabel("登录邮箱", { exact: true }).fill(`unknown-${stamp}@example.invalid`);
  await recovery.getByRole("button", { name: "发送重置链接" }).click();
  await expect(recovery.getByText(/如果该邮箱符合恢复条件/)).toBeVisible(deadline);

  await login.goto("/reset-password");
  await expect(login.getByText(/重置链接无效或不完整/)).toBeVisible(deadline);
  await login.goto("/reset-password#token=definitely-not-valid");
  await login.reload();
  await login.getByLabel("新密码", { exact: true }).fill("local-recovery-test-password");
  await login.getByLabel("确认新密码", { exact: true }).fill("local-recovery-test-password");
  await login.getByRole("button", { name: "重置密码", exact: true }).click();
  await expect(login.getByRole("main").getByRole("alert")).toContainText(/重置链接无效或已使用/, deadline);
  await expect(login).toHaveURL(/\/reset-password$/);
  await returning.close();
  await student.close();
  console.log("PASS 学生邮箱验证、资料页刷新、浏览器隔离、确认密码、进入工作区和邮箱登录");
  console.log("PASS 注册无需协作账号，个人中心提供独立的 GitHub 授权入口");
  console.log("PASS 注册弹窗键盘关闭、找回密码及处理无效重置链接");

  const teacher = await browser.newContext({ locale: "zh-CN", baseURL: origin.origin, viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const teacherPage = await teacher.newPage();
  const teacherEmail = `teacher-${stamp}@must.edu.mo`;
  await signup(teacherPage, teacher, teacherEmail);
  assert(await teacherPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Profile should fit a 360px viewport");
  await screenshot(teacherPage, "signup-profile-mobile");
  await fillProfile(teacherPage, teacherEmail, "teacher");
  await expect(teacherPage).toHaveURL(/\/account\/status/, deadline);
  const response = await teacher.request.get("/api/v1/auth/session");
  const session = await payload(response);
  assert.equal(session.accountState, "review_required");
  const teacherProfile = await payload(await teacher.request.get(mePath));
  assert.equal(teacherProfile.user.githubUsername, null);
  assert.equal(teacherProfile.user.feishuAccount, null);
  await teacherPage.goto("/home");
  await expect(teacherPage).toHaveURL(/\/account\/status/, deadline);
  await teacher.close();
  console.log("PASS 360px 教师注册、学号字段按身份显示、工作区门禁");
} finally {
  await browser.close();
}
