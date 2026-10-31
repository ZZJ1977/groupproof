import { expect, test, type Page } from "@playwright/test";
import type { IdentityAdminUser, IdentityTeacherApplication } from "../lib/api/c-identity-client";

const target: IdentityAdminUser = { id: "identity-student", name: "真实账号", studentId: "S123", college: "计算机学院", roles: ["student"], status: "enabled", version: 3, schoolEmail: "student@must.edu.mo", schoolEmailVerified: true, canDisable: true };
const application: IdentityTeacherApplication = { id: "identity-application", userId: "identity-teacher", name: "申请教师", college: "计算机学院", applicationVersion: 4, status: "pending", createdAt: "2026-10-12T00:00:00Z", emailVerified: true, emailDomain: "must.edu.mo" };
async function session(page: Page, actor = () => "c-url-fixture") {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: {
    authenticated: true, sessionScope: "full", accountState: "active", canEnterWorkspace: true,
    csrfToken: "identity-fixture-csrf", user: { id: actor(), name: "管理员", preferredLocale: "zh-Hans" },
  } }));
}

test("C7-01/02 identity filters survive refresh and disabling uses current version and CSRF", async ({ page }) => {
  await session(page);
  let disabled = false;
  await page.route("**/api/v1/c-admin/users?**", (route) => route.fulfill({ json: { items: [{ ...target, status: disabled ? "disabled" : "enabled", canDisable: !disabled, version: disabled ? 4 : 3 }], total: 1, page: 1, pageSize: 10 } }));
  let writes = 0;
  await page.route("**/api/v1/c-admin/users/identity-student/disable", (route) => {
    writes++;
    expect(route.request().headers()["x-csrf-token"]).toBe("identity-fixture-csrf");
    expect(route.request().postDataJSON()).toEqual({ expectedVersion: 3, reason: "已核对停用原因" });
    disabled = true;
    return route.fulfill({ json: { id: target.id, status: "disabled", version: 4 } });
  });
  await page.goto("/admin/users");
  await expect(page.getByText("真实账号", { exact: true })).toBeVisible();
  await page.getByLabel("姓名、邮箱或学号", { exact: true }).fill("真实");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await page.reload();
  await expect(page.getByLabel("姓名、邮箱或学号", { exact: true })).toHaveValue("真实");
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认停用", exact: true })).toBeDisabled();
  await page.getByLabel("处理原因", { exact: true }).fill("已核对停用原因");
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await expect(page.getByText("决定已保存。", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("再次点击");
  await expect(page.getByRole("button", { name: "确认停用", exact: true })).toBeDisabled();
});

test("C7-02 a changed identity session cannot submit the previous account's decision", async ({ page }) => {
  let actor = "c-url-fixture"; await session(page, () => actor);
  await page.route("**/api/v1/c-admin/users?**", (route) => route.fulfill({ json: { items: [target], total: 1, page: 1, pageSize: 10 } }));
  let writes = 0;
  await page.route("**/api/v1/c-admin/users/identity-student/disable", (route) => { writes++; return route.fulfill({ json: {} }); });
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("会话切换前的输入");
  actor = "another-identity-admin";
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await expect(page.getByText(/登录已失效或没有管理权限/)).toBeVisible();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveCount(0);
  await expect(page.getByText("真实账号", { exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
});

test("C7-01 authorization failure removes user data after a refresh", async ({ page }) => {
  await session(page); let allowed = true;
  await page.route("**/api/v1/c-admin/users?**", (route) => route.fulfill(allowed
    ? { json: { items: [target], total: 1, page: 1, pageSize: 10 } }
    : { status: 403, json: { code: "FORBIDDEN" } }));
  await page.goto("/admin/users");
  await expect(page.getByText("真实账号", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("权限撤销前的敏感理由");
  allowed = false;
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("没有管理权限");
  await expect(page.getByText("真实账号", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveCount(0);
  allowed = true;
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveValue("");
});

test("C7-01 a background version change requires explicit refresh and preserves the reason", async ({ page }) => {
  await session(page);
  let row = target;
  await page.route("**/api/v1/c-admin/users?**", (route) => route.fulfill({ json: { items: [row], total: 1, page: 1, pageSize: 10 } }));
  let writes = 0;
  await page.route("**/api/v1/c-admin/users/identity-student/disable", (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ expectedVersion: 4, reason: "保留正在核对的理由" });
    row = { ...row, status: "disabled", canDisable: false, version: 5 };
    return route.fulfill({ json: { id: row.id, status: row.status, version: row.version } });
  });
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("保留正在核对的理由");
  row = { ...target, version: 4, schoolEmail: "changed@must.edu.mo" };
  // React Query refetches on reconnect without invoking the page's manual refresh handler.
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByText(/changed@must\.edu\.mo/)).toBeVisible();
  await expect(page.getByText("此记录已被其他人修改，请刷新列表并核对后再提交；处理原因已保留。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveValue("保留正在核对的理由");
  await expect(page.getByRole("button", { name: "确认停用", exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveValue("保留正在核对的理由");
  await expect(page.getByRole("button", { name: "确认停用", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await expect(page.getByText("决定已保存。", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("C7-01 a disappeared selection stays closed if the same row later returns", async ({ page }) => {
  await session(page); let present = true;
  await page.route("**/api/v1/c-admin/users?**", (route) => route.fulfill({ json: { items: present ? [target] : [], total: present ? 1 : 0, page: 1, pageSize: 10 } }));
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("待确认记录的理由");
  present = false;
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByText("没有符合条件的记录", { exact: true })).toBeVisible();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveCount(0);
  present = true;
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByRole("button", { name: "查看", exact: true })).toBeVisible();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveCount(0);
});

for (const teachers of [false, true]) {
  test(`C7 ${teachers ? "teacher review" : "user disable"} write 404 closes the deleted record after retaining a temporary-failure draft`, async ({ page }) => {
    await session(page);
    const row = teachers ? application : target;
    const resource = teachers ? "teacher-applications" : "users";
    const action = teachers ? "review" : "disable";
    let present = true;
    let reads = 0;
    await page.route(`**/api/v1/c-admin/${resource}?**`, (route) => {
      reads++;
      return route.fulfill({ json: { items: present ? [row] : [], total: present ? 1 : 0, page: 1, pageSize: 10 } });
    });
    let writes = 0;
    await page.route(`**/api/v1/c-admin/${resource}/${row.id}/${action}`, (route) => {
      writes++;
      expect(route.request().postDataJSON()).toEqual(teachers
        ? { decision: "approve", expectedVersion: application.applicationVersion, reason: "删除前正在核对的理由" }
        : { expectedVersion: target.version, reason: "删除前正在核对的理由" });
      if (writes === 1) return route.fulfill({ status: 503, json: { code: "SERVICE_UNAVAILABLE" } });
      present = false;
      return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
    });
    await page.goto(teachers ? "/admin/teacher-verifications" : "/admin/users");
    await page.getByRole("button", { name: "查看", exact: true }).click();
    const reason = page.getByLabel("处理原因", { exact: true });
    const confirm = page.getByRole("button", { name: teachers ? "通过" : "确认停用", exact: true });
    await reason.fill("删除前正在核对的理由");
    await confirm.click();
    await expect(page.getByText("暂不能确认操作结果，请检查输入并刷新核对后重试。", { exact: true })).toBeVisible();
    await expect(reason).toHaveValue("删除前正在核对的理由");
    const readsBeforeDeletion = reads;
    await confirm.click();
    await expect(page.getByText("这条记录已不存在，详情已关闭。", { exact: true })).toBeVisible();
    await expect(page.getByText("没有符合条件的记录", { exact: true })).toBeVisible();
    await expect(reason).toHaveCount(0);
    await expect(confirm).toHaveCount(0);
    expect(reads).toBeGreaterThan(readsBeforeDeletion);
    expect(writes).toBe(2);
    present = true;
    await page.getByRole("button", { name: "刷新列表", exact: true }).click();
    await expect(page.getByRole("button", { name: "查看", exact: true })).toBeVisible();
    await expect(reason).toHaveCount(0);
    await page.getByRole("button", { name: "查看", exact: true }).click();
    await expect(reason).toHaveValue("");
    await expect(confirm).toBeDisabled();
    expect(writes).toBe(2);
  });
}

test("C7-01 directory remains usable on a narrow screen with keyboard controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await session(page);
  await page.route("**/api/v1/c-admin/users?**", (route) => route.fulfill({ json: { items: [target], total: 1, page: 1, pageSize: 10 } }));
  await page.goto("/admin/users");
  const view = page.getByRole("button", { name: "查看", exact: true });
  await view.focus(); await page.keyboard.press("Enter");
  await expect(page.getByLabel("处理原因", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "取消", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveCount(0);
});

test("C7-03 teacher approval preserves reasons on a conflict and never approves unverified email", async ({ page }) => {
  await session(page); let verified = false; let version = 4;
  await page.route("**/api/v1/c-admin/teacher-applications?**", (route) => route.fulfill({ json: { items: [{ ...application, emailVerified: verified, applicationVersion: version }], total: 1, page: 1, pageSize: 10 } }));
  let writes = 0;
  await page.route("**/api/v1/c-admin/teacher-applications/identity-application/review", (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ decision: "approve", reason: "已核对申请", expectedVersion: version });
    if (writes === 2) return route.fulfill({ json: { id: application.id, status: "approved" } });
    return route.fulfill({ status: 409, json: { code: "CONFLICT" } });
  });
  await page.goto("/admin/teacher-verifications");
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("已核对申请");
  await expect(page.getByRole("button", { name: "通过", exact: true })).toBeDisabled();
  verified = true;
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await page.getByLabel("处理原因", { exact: true }).fill("已核对申请");
  await page.getByRole("button", { name: "通过", exact: true }).click();
  await expect(page.getByText(/记录已变化，请刷新后重新确认/)).toBeVisible();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveValue("已核对申请");
  expect(writes).toBe(1);
  await expect(page.getByRole("button", { name: "通过", exact: true })).toBeDisabled();
  version = 5;
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.getByLabel("处理原因", { exact: true })).toHaveValue("已核对申请");
  await page.getByRole("button", { name: "通过", exact: true }).click();
  await expect(page.getByText("决定已保存。", { exact: true })).toBeVisible();
  expect(writes).toBe(2);
});
