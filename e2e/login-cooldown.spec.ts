import { expect, test } from "@playwright/test";

test("登录限流倒计时期间阻止重复提交，到期恢复登录并保留后续凭据错误", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/v1/auth/password/login", (route) => {
    attempts += 1;
    return route.fulfill({
      status: attempts === 1 ? 429 : 401,
      json: {
        error: {
          code: attempts === 1 ? "RATE_LIMITED" : "INVALID_CREDENTIALS",
          details: attempts === 1 ? { retryAfterSeconds: 3 } : {},
        },
        meta: { request_id: "login-cooldown-test" },
      },
    });
  });
  await page.goto("/login");
  await page.getByLabel("用户名或邮箱", { exact: true }).fill("student@student.must.edu.mo");
  await page.getByLabel("密码", { exact: true }).fill("ExamplePassword42");
  const now = new Date("2026-11-21T08:00:00Z");
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1_000));
  const submit = page.getByRole("button", { name: "登录", exact: true });
  await submit.click();
  const feedback = page.locator("form").getByRole("alert");
  await expect(feedback).toContainText("3 秒");
  await expect(submit).toBeDisabled();

  // Enter or programmatic form submission must respect the same cooldown.
  await page.locator("form").dispatchEvent("submit");
  await page.clock.runFor(1_000);
  await expect(feedback).toContainText("2 秒");
  expect(attempts).toBe(1);

  // A background-tab time jump should expire from the deadline, not tick count.
  await page.clock.fastForward(5_000);
  await expect(submit).toBeEnabled();
  await expect(feedback).toHaveCount(0);
  await submit.click();
  await expect(feedback).toContainText("用户名或密码错误");
  expect(attempts).toBe(2);
  await page.clock.fastForward(10_000);
  await expect(feedback).toContainText("用户名或密码错误");
  await expect(submit).toBeEnabled();
});
