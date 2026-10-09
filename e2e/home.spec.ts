import { expect, test } from "@playwright/test";

test("用户可以从登录页进入首页", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /以证据为核心的\s*小组项目协作平台/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /使用 Google 登录/ }).click();

  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "首页" })).toBeVisible();
});
