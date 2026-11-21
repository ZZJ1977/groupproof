import { expect, test, type Page, type Route } from "@playwright/test";
import type { MeDTO } from "../lib/api/auth-client";

function account(verified = false): MeDTO {
  return {
    user: {
      id: "account-fixture", name: "原有同学", username: "1240035830",
      studentId: "1240035830", college: "创新工程学院", requestedIdentity: "student",
      roles: verified ? ["student"] : [], preferredLocale: "zh-Hans", version: 1,
      passwordLoginEnabled: true,
    },
    schoolEmail: {
      verifiedEmail: verified ? "1240035830@student.must.edu.mo" : null,
      verifiedAt: verified ? "2026-11-21T00:00:00Z" : null,
      pendingEmail: verified ? null : "1240035830@student.must.edu.mo", verified,
    },
    registration: {
      profileComplete: verified, profileFieldErrors: {}, schoolEmailVerified: verified,
      identityConfirmed: verified, securityComplete: true, requiredCompletedCount: verified ? 3 : 0,
      canEnterWorkspace: verified, loginEmailVerified: true, teacherReviewStatus: null,
      academicIdentityStatus: "unverified", verificationBasis: [],
      accountState: verified ? "active" : "profile_required",
      nextAction: { type: verified ? "enter_workspace" : "complete_profile", href: verified ? "/home" : "/account/profile" },
    },
    teacherApplication: null,
    studentIdRule: { pattern: "^\\S{4,20}$", emailPrefixRule: "none", confirmedBySchool: false },
  };
}

async function setup(page: Page, current: () => MeDTO, save: (route: Route) => Promise<void>) {
  await page.context().addCookies([{ name: "gp_account_fixture", value: "onboarding", domain: "127.0.0.1", path: "/" }]);
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: { data: current() } }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { data: {
    authenticated: true, csrfToken: "account-fixture-csrf", authMethod: "password",
    sessionScope: current().registration.accountState === "active" ? "full" : "onboarding",
    accountState: current().registration.accountState, user: current().user,
  } } }));
  await page.route("**/api/v1/me/profile", save);
  await page.goto("/account/profile");
  await expect(page.getByRole("heading", { name: "完善个人信息", exact: true })).toBeVisible();
}

test("已有账号保留资料并防止重复保存，随后进入真实邮箱验证入口", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let me = account();
  let writes = 0;
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await setup(page, () => me, async (route) => {
    writes++;
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().headers()["x-csrf-token"]).toBe("account-fixture-csrf");
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ name: "更新后的姓名", studentId: "1240035830", expectedVersion: 1, requestedIdentity: "student", schoolEmail: "1240035830@student.must.edu.mo" });
    expect(body).not.toHaveProperty("username");
    await waiting;
    me = { ...me, user: { ...me.user, name: body.name, version: 2 }, registration: { ...me.registration, profileComplete: true, accountState: "email_required", nextAction: { type: "verify_email", href: "/account/email" } } };
    await route.fulfill({ json: { data: me } });
  });
  await expect(page.getByLabel("用户名", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("原有同学");
  await expect(page.getByLabel("学院（选填）", { exact: true })).toHaveValue("创新工程学院");
  await expect(page.getByLabel("学校邮箱", { exact: true })).toHaveValue("1240035830@student.must.edu.mo");
  await expect(page.getByLabel("学校邮箱", { exact: true })).toBeEditable();
  const role = page.getByRole("combobox", { name: "身份", exact: true });
  await expect(role.locator("option")).toHaveText(["学生", "老师"]);
  await role.selectOption("teacher");
  await expect(page.getByLabel("学号", { exact: true })).toHaveCount(0);
  await role.selectOption("student");
  await expect(page.getByLabel("学号", { exact: true })).toHaveValue("1240035830");
  await page.getByLabel("姓名", { exact: true }).fill("更新后的姓名");
  await page.screenshot({ path: testInfo.outputPath("account-profile-desktop.png"), fullPage: true });
  const continueButton = page.getByRole("button", { name: "保存并继续", exact: true });
  await continueButton.click();
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(page.getByLabel("姓名", { exact: true })).toBeDisabled();
  await expect.poll(() => writes).toBe(1);
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(writes).toBe(1);
  release();
  await expect(page).toHaveURL(/\/account\/email$/);
  await expect(page.getByRole("heading", { name: "验证学校邮箱", exact: true })).toBeVisible();
});

test("已验证账号在窄屏展示新版资料且不重新设置密码或身份", async ({ page }, testInfo) => {
  let me = account(true);
  await page.setViewportSize({ width: 360, height: 800 });
  await setup(page, () => me, async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ name: "更正姓名", expectedVersion: 1, studentId: "1240035830" });
    expect(body).not.toHaveProperty("username");
    expect(body).not.toHaveProperty("requestedIdentity");
    expect(body).not.toHaveProperty("schoolEmail");
    me = { ...me, user: { ...me.user, name: body.name, version: 2 } };
    await route.fulfill({ json: { data: me } });
  });
  await expect(page.getByLabel("学校邮箱", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByRole("combobox", { name: "身份", exact: true })).toBeDisabled();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "管理账号安全", exact: true })).toHaveAttribute("href", "/account/security");
  await expect(page.getByText(/^已设置登录密码/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("account-profile-mobile.png"), fullPage: true });
  await page.getByLabel("姓名", { exact: true }).fill("更正姓名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/已保存，你可以稍后/)).toBeVisible();
  await expect(page).toHaveURL(/\/account\/profile$/);
});

test("教师资料继续走审核入口并清除历史学号", async ({ page }) => {
  let me = account();
  await setup(page, () => me, async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ requestedIdentity: "teacher", studentId: null, schoolEmail: "teacher@must.edu.mo", expectedVersion: 1 });
    expect(body).not.toHaveProperty("username");
    me = {
      ...me, user: { ...me.user, requestedIdentity: "teacher", studentId: null, version: 2 },
      schoolEmail: { verified: true, verifiedEmail: "teacher@must.edu.mo", verifiedAt: "2026-11-21T00:00:00Z", pendingEmail: null },
      registration: { ...me.registration, profileComplete: true, schoolEmailVerified: true, teacherReviewStatus: "review_required", accountState: "review_required", nextAction: { type: "submit_review", href: "/account/status" } },
    };
    await route.fulfill({ json: { data: me } });
  });
  await page.getByRole("combobox", { name: "身份", exact: true }).selectOption("teacher");
  await expect(page.getByLabel("学号", { exact: true })).toHaveCount(0);
  await page.getByLabel("学校邮箱", { exact: true }).fill("teacher@must.edu.mo");
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/status$/);
  await expect(page.getByRole("button", { name: /提交.*审核/ })).toBeVisible();
});

test("资料版本冲突保留编辑内容并允许明确重新载入后保存", async ({ page }) => {
  let me = account();
  let writes = 0;
  await setup(page, () => me, async (route) => {
    writes++;
    const body = route.request().postDataJSON();
    if (writes === 1) {
      expect(body.expectedVersion).toBe(1);
      me = { ...me, user: { ...me.user, name: "另一处更新的姓名", version: 2 } };
      await route.fulfill({ status: 409, json: { error: { code: "VERSION_CONFLICT" } } });
      return;
    }
    expect(body).toMatchObject({ expectedVersion: 2, name: "核对后姓名" });
    me = { ...me, user: { ...me.user, name: body.name, version: 3 } };
    await route.fulfill({ json: { data: me } });
  });
  await page.getByLabel("姓名", { exact: true }).fill("保留中的修改");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("资料已被其他操作更新，请刷新后重试", { exact: true })).toBeVisible();
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("保留中的修改");
  await page.getByRole("button", { name: "重新载入资料", exact: true }).click();
  await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("另一处更新的姓名");
  await page.getByLabel("姓名", { exact: true }).fill("核对后姓名");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/已保存，你可以稍后/)).toBeVisible();
  expect(writes).toBe(2);
});
