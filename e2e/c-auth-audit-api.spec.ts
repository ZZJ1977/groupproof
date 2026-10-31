import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

// Explicit HTTP contract fixtures for the A-backed read view; no live production log claims.
type Schema = components["schemas"];
const actorId = "00000000-0000-0000-0000-000000001001";
const targetId = "00000000-0000-0000-0000-000000001002";
const logId = "auth_event_opaque-not-a-uuid";
const base = "/api/v1/admin/auth-audit-logs";
const envelope = (data: unknown) => ({ data, meta: { request_id: "auth-audit-fixture" } });
const ok = (route: Route, data: unknown) => route.fulfill({ json: envelope(data) });
const fail = (route: Route, status: number) => route.fulfill({ status, json: { error: { code: status === 403 ? "ADMIN_REQUIRED" : status === 404 ? "AUTH_AUDIT_NOT_FOUND" : "AUDIT_SOURCE_UNAVAILABLE", message: "Auth audit fixture failure" }, meta: { request_id: "auth-audit-failure" } } });
const user: Schema["AdminUserDTO"] = { id: actorId, name: "当前目录管理员", email: "admin@example.edu", email_verified: true, global_role: "admin", status: "active", username: "current-admin", student_id: null, college: "软件学院" };
const row: Schema["AuthAuditLogDTO"] = { id: logId, source: "auth_audit_events", scope: "authentication", action: "auth.password_login", actor_id: actorId, target_user_id: targetId, result: "success", occurred_at: "2026-10-15T08:00:00Z", changed_fields: ["session"], metadata_redacted: false };
const collection = (items: Schema["AuthAuditLogDTO"][], page = 1, total = items.length): Schema["AuthAuditPageDTO"] => ({ source: "auth_audit_events", scope: "authentication", items, page, page_size: 10, total });
async function users(page: Page, allowed: () => boolean = () => true) {
  await page.route(/\/api\/v1\/admin\/users(?:\?.*)?$/, (route) => allowed() ? ok(route, { items: [user, { ...user, id: targetId, name: "当前目标账号", global_role: "student" }], page: 1, page_size: 10, total: 2 }) : fail(route, 403));
  await page.route(`**/api/v1/admin/users/${actorId}`, (route) => allowed() ? ok(route, user) : fail(route, 403));
  await page.route(`**/api/v1/admin/users/${targetId}`, (route) => allowed() ? ok(route, { ...user, id: targetId, name: "当前目标账号", global_role: "student" }) : fail(route, 403));
}
async function routes(page: Page, getRow: () => Schema["AuthAuditLogDTO"] = () => row) {
  await users(page);
  await page.route(/\/api\/v1\/admin\/auth-audit-logs(?:\?.*)?$/, (route) => ok(route, collection([getRow()])));
  await page.route(`**${base}/${logId}`, (route) => ok(route, getRow()));
}

test("C7 authentication source stays distinct from unavailable all-site business audit", async ({ page }) => {
  await routes(page);
  const authQueries: URL[] = []; let businessQueries = 0;
  await page.route(/\/api\/v1\/admin\/auth-audit-logs(?:\?.*)?$/, (route) => { authQueries.push(new URL(route.request().url())); return ok(route, collection([row])); });
  await page.route(/\/api\/v1\/admin\/audit-logs(?:\?.*)?$/, (route) => { businessQueries++; return fail(route, 503); });
  await page.goto("/admin/logs?action=course.publish&actor_role=teacher&target_type=course&page=2");
  await expect(page.getByRole("heading", { name: "全站业务日志", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toContainText("所需服务尚不可用");
  await page.getByRole("button", { name: "认证日志", exact: true }).click();
  await expect(page).toHaveURL(/source=auth/);
  await expect(page.getByRole("heading", { name: "认证日志", exact: true })).toBeVisible();
  await expect(page.getByText("认证来源只记录事件、结果和变更字段名；操作时角色、操作理由、变更前后值均未记录。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看认证日志", exact: true })).toBeVisible();
  expect(authQueries.at(-1)?.searchParams.get("page")).toBe("1");
  for (const key of ["action", "actor_role", "target_type"]) expect(authQueries.at(-1)?.searchParams.has(key)).toBe(false);
  expect(businessQueries).toBe(1);
  await page.getByRole("button", { name: "全站业务日志", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("所需服务尚不可用");
  await expect(page.getByRole("button", { name: "查看认证日志", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("操作类型", { exact: true })).toHaveValue("course.publish");
});

test("C7 authentication combined filters, paging, reload and Back preserve URL scope and unsaved fields", async ({ page }) => {
  await routes(page); const queries: URL[] = [];
  await page.route(/\/api\/v1\/admin\/auth-audit-logs(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url()); queries.push(url);
    const current = Number(url.searchParams.get("page") ?? 1);
    return ok(route, collection([{ ...row, id: `${logId}-${current}` }], current, 11));
  });
  await page.goto("/admin/logs?source=auth");
  await page.getByRole("combobox", { name: "认证事件", exact: true }).selectOption("auth.password_login");
  await page.getByRole("combobox", { name: "认证结果", exact: true }).selectOption("success");
  await page.getByLabel("认证开始时间", { exact: true }).fill("2026-10-01T08:00");
  await page.getByLabel("认证结束时间", { exact: true }).fill("2026-10-16T08:00");
  await page.getByRole("combobox", { name: "认证操作人", exact: true }).selectOption(actorId);
  await expect.poll(() => queries.at(-1)?.searchParams.get("actor_id")).toBe(actorId);
  await expect(page.getByRole("combobox", { name: "认证事件", exact: true })).toHaveValue("auth.password_login");
  await page.getByRole("combobox", { name: "目标账号", exact: true }).selectOption(targetId);
  await expect.poll(() => queries.at(-1)?.searchParams.get("target_user_id")).toBe(targetId);
  await expect(page.getByLabel("认证开始时间", { exact: true })).toHaveValue("2026-10-01T08:00");
  await page.getByRole("button", { name: "查询认证日志", exact: true }).click();
  await expect.poll(() => queries.at(-1)?.searchParams.get("action")).toBe("auth.password_login");
  expect(queries.at(-1)?.searchParams.get("result")).toBe("success");
  expect(queries.at(-1)?.searchParams.get("since")).toMatch(/T.*Z$/);
  expect(queries.at(-1)?.searchParams.get("until")).toMatch(/T.*Z$/);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/auth_page=2/);
  await page.reload();
  await expect(page.getByText("共 11 条 · 第 2 页", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "认证事件", exact: true })).toHaveValue("auth.password_login");
  expect(queries.at(-1)?.searchParams.get("actor_id")).toBe(actorId);
  expect(queries.at(-1)?.searchParams.get("target_user_id")).toBe(targetId);
  await page.goBack(); await expect(page.getByText("共 11 条 · 第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置认证筛选", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "认证事件", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/admin\/logs\?source=auth$/);
  await page.getByRole("combobox", { name: "认证事件", exact: true }).selectOption("profile.updated");
  await page.getByRole("button", { name: "重置认证筛选", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "认证事件", exact: true })).toHaveValue("");
});

test("C7 authentication detail uses opaque IDs and recorded fields, never current roles or invented before/after", async ({ page }) => {
  await routes(page);
  await page.goto(`/admin/logs?source=auth&auth_log=${logId}`);
  await expect(page.getByRole("heading", { name: "认证日志详情", exact: true })).toBeVisible();
  await expect(page.getByText("session", { exact: true })).toBeVisible();
  await expect(page.getByText("操作时角色：未记录", { exact: true })).toBeVisible();
  await expect(page.getByText("操作理由：未记录", { exact: true })).toBeVisible();
  await expect(page.getByText("变更前值：未记录", { exact: true })).toBeVisible();
  await expect(page.getByText("变更后值：未记录", { exact: true })).toBeVisible();
  await expect(page.getByText(`记录的操作人标识：${actorId}`, { exact: true })).toBeVisible();
  await expect(page.locator("main pre")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "操作时角色", exact: true })).toHaveCount(0);
});

test("C7 system and unrecognized authentication metadata stay explicit, and no system user lookup is invented", async ({ page }) => {
  const unknown: Schema["AuthAuditLogDTO"] = { ...row, action: "unrecognized", actor_id: "system", target_user_id: null, result: "unknown", changed_fields: [], metadata_redacted: true };
  await routes(page, () => unknown); let systemLookups = 0;
  await page.route("**/api/v1/admin/users/system", (route) => { systemLookups++; return fail(route, 404); });
  await page.goto(`/admin/logs?source=auth&auth_actor=system&auth_log=${logId}`);
  await expect(page.getByRole("combobox", { name: "认证操作人", exact: true })).toHaveValue("system");
  await expect(page.getByText("事件：未识别认证事件", { exact: true })).toBeVisible();
  await expect(page.getByText("记录的操作人标识：系统", { exact: true })).toBeVisible();
  await expect(page.getByText("记录的目标账号标识：未记录", { exact: true })).toBeVisible();
  await expect(page.getByText("没有可展示的变更字段名；不能据此判断是否修改过数据。", { exact: true })).toBeVisible();
  await expect(page.getByText("部分来源元数据已隐藏，不显示其原始内容。", { exact: true })).toBeVisible();
  expect(systemLookups).toBe(0);
});

for (const deniedAt of ["list", "detail", "directory"] as const) test(`C7 authentication ${deniedAt} permission loss removes all protected records and selection`, async ({ page }) => {
  let allowed = true;
  await users(page, () => deniedAt !== "directory" || allowed);
  await page.route(/\/api\/v1\/admin\/auth-audit-logs(?:\?.*)?$/, (route) => deniedAt === "list" && !allowed ? fail(route, 403) : ok(route, collection([row])));
  await page.route(`**${base}/${logId}`, (route) => deniedAt === "detail" && !allowed ? fail(route, 403) : ok(route, row));
  await page.goto(`/admin/logs?source=auth&auth_log=${logId}`);
  await expect(page.getByText("session", { exact: true })).toBeVisible();
  allowed = false;
  if (deniedAt === "directory") await page.getByLabel("认证操作人搜索", { exact: true }).fill("重新核对权限");
  else await page.getByRole("button", { name: "刷新认证日志", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("当前账户无权");
  await expect(page.getByRole("button", { name: "查看认证日志", exact: true })).toHaveCount(0);
  await expect(page.getByText("session", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "认证操作人", exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/auth_log=/);
  allowed = true;
  await page.getByRole("button", { name: "刷新认证日志", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看认证日志", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "认证日志详情", exact: true })).toHaveCount(0);
});

test("C7 authentication refresh failure hides old results and 404 detail never reuses an old event", async ({ page }) => {
  await routes(page); let available = true; let exists = true;
  await page.route(/\/api\/v1\/admin\/auth-audit-logs(?:\?.*)?$/, (route) => available ? ok(route, collection([row])) : fail(route, 503));
  await page.route(`**${base}/${logId}`, (route) => exists ? ok(route, row) : fail(route, 404));
  await page.goto(`/admin/logs?source=auth&auth_log=${logId}`);
  await expect(page.getByText("session", { exact: true })).toBeVisible();
  available = false; await page.getByRole("button", { name: "刷新认证日志", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("所需服务尚不可用");
  await expect(page.getByText("session", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看认证日志", exact: true })).toHaveCount(0);
  available = true; exists = false;
  await page.getByRole("button", { name: "刷新认证日志", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试认证详情", exact: true })).toBeVisible();
  await expect(page.getByText("session", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看认证日志", exact: true })).toBeVisible();
});
