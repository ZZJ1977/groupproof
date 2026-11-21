import { expect, test } from "@playwright/test";

for (const identity of ["student", "teacher"] as const) {
  test(`${identity} 邮箱显示两种身份并校验切换后的邮箱要求`, async ({ page }) => {
    const email = identity === "student" ? "student@student.must.edu.mo" : "teacher@must.edu.mo";
    await page.route("**/api/v1/auth/email/registrations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/profile", (route) => route.fulfill({
      json: { data: { email, allowedIdentities: [identity] } },
    }));
    await page.route("**/api/v1/auth/email/registrations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/complete", (route) => route.fulfill({
      status: 503, json: { code: "SERVICE_UNAVAILABLE" },
    }));
    if (identity === "teacher") await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/register/profile?tx=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const role = page.getByRole("combobox", { name: "身份", exact: true });
    const studentId = page.getByLabel("学号", { exact: true });
    const submit = page.getByRole("button", { name: "完成注册", exact: true });
    await expect(role.locator("option")).toHaveText(["学生", "老师"]);
    await expect(role).toHaveValue(identity);
    await page.getByLabel("姓名", { exact: true }).fill("陈同学");

    await role.selectOption(identity === "student" ? "teacher" : "student");
    await expect(role).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("status")).toContainText("请使用对应身份的学校邮箱重新验证");
    await expect(page.getByRole("link", { name: "更换学校邮箱" })).toHaveAttribute("href", "/login");
    await expect(submit).toBeDisabled();
    if (identity === "student") {
      await expect(studentId).toHaveCount(0);
      await expect(page.getByText(/审核通过后即可进入教师工作区/)).toBeVisible();
    } else {
      await expect(studentId).toBeVisible();
      await expect(studentId).toHaveAttribute("required", "");
    }

    await role.selectOption(identity);
    await expect(page.getByRole("link", { name: "更换学校邮箱" })).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await expect(page.getByLabel("姓名", { exact: true })).toHaveValue("陈同学");
    if (identity === "student") await studentId.fill("1240035830");
    else await expect(studentId).toHaveCount(0);
    await page.getByLabel("账号密码", { exact: true }).fill("MacaoStudy42");
    await page.getByLabel("确认账号密码", { exact: true }).fill("MacaoStudy42");
    const requestPromise = page.waitForRequest("**/api/v1/auth/email/registrations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/complete");
    await submit.click();
    const body = (await requestPromise).postDataJSON();
    expect(body.requestedIdentity).toBe(identity);
    expect(body.studentId).toBe(identity === "student" ? "1240035830" : undefined);
    await expect(page.getByText("注册服务暂时不可用，请稍后重试。")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
