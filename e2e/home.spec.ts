import { expect, test } from "@playwright/test";

test("匿名用户可打开邮箱注册流程", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /以证据为核心的\s*小组项目协作平台/ })).toBeVisible();
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("第 1/3 步");
  await expect(page.getByRole("button", { name: "发送验证码", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/home$/);
});

test("匿名用户直达业务首页会被引导登录", async ({ page }) => {
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fhome$/);
  await expect(page.getByRole("button", { name: "注册账号", exact: true })).toBeVisible();
});

test("认证能力接口不可用时隐藏 Google 登录入口", async ({ page }) => {
  await page.route("**/api/v1/auth/capabilities", (route) => route.abort());
  await page.goto("/login");

  await expect(page.getByRole("button", { name: "使用 Google 登录", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("暂时无法连接");
});
