import { expect, test } from "@playwright/test";
import { seedData } from "../mocks/seed";

test.beforeEach(async ({ page }) => {
  const data = structuredClone(seedData); data.currentUserId = "admin-1"; data.currentRole = "admin";
  await page.addInitScript((data) => { localStorage.setItem("groupproof-v1-workspace:c-url-fixture", JSON.stringify(data)); }, data);
});

test("C7-01 real-mode directory reads API pages and filters without mock fallback", async ({ page }) => {
  const user = { id: "00000000-0000-0000-0000-000000000001", name: "Directory user", username: "directory", email: "directory@example.test", student_id: "TEST1", college: "IT", global_role: "student", status: "active", email_verified: true };
  const requests: URL[] = [];
  await page.route("**/api/v1/admin/users**", async (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    const detail = url.pathname.endsWith(user.id);
    await route.fulfill({ json: { data: detail ? { ...user, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", lock_version: 0 } : { items: [{ ...user, name: url.searchParams.get("page") === "2" ? "Second page user" : user.name }], page: Number(url.searchParams.get("page") ?? 1), page_size: 10, total: 11 }, meta: { request_id: "browser-directory" } } });
  });
  await page.goto("/admin/users");
  await expect(page.getByRole("cell", { name: "Directory user", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "系统管理员", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole("cell", { name: "Second page user", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "学院", exact: true }).fill("IT");
  await page.getByRole("combobox", { name: "角色", exact: true }).selectOption("student");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/college=IT/);
  await expect(page.getByRole("cell", { name: "Directory user", exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("role")).toBe("student");
  expect(requests.at(-1)?.searchParams.get("page")).toBe("1");
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await expect(page.getByText("已验证", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "学院", exact: true })).toHaveValue("IT");
});

test("C7-01 authorization failure hides data and never shows seed accounts", async ({ page }) => {
  await page.route("**/api/v1/admin/users**", (route) => route.fulfill({ status: 403, json: { error: { code: "ADMIN_REQUIRED", message: "Forbidden" }, meta: { request_id: "denied" } } }));
  await page.goto("/admin/users");
  await expect(page.getByText("只有有效的管理员账户可以读取用户目录。", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加用户", exact: true })).toHaveCount(0);
});

test("C7-06 missing timestamped usage does not display fabricated trends or service health", async ({ page }) => {
  await page.goto("/admin/ai-usage");
  await expect(page.getByText(/AI 用量记录尚未接入/)).toBeVisible();
  await page.getByRole("button", { name: "近 30 天", exact: true }).click();
  await expect(page.getByText(/无法计算近 30 天/)).toBeVisible();
  await expect(page.getByText("运行正常", { exact: true })).toHaveCount(0);
  await expect(page.getByText("可用", { exact: true })).toHaveCount(0);
  await expect(page.getByText("暂无带时间戳的调用记录。", { exact: true })).toBeVisible();
});
