import { expect, test } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

const projectId = "00000000-0000-0000-0000-000000000101";
const courseId = "00000000-0000-0000-0000-000000000102";
const taskId = "00000000-0000-0000-0000-000000000103";
const summary = {
  course_count: 1, project_count: 1, my_task_count: 3, my_completed_tasks: 1,
  task_counts: { not_started: 0, in_progress: 2, pending_submission: 0, pending_verification: 0, completed: 1 },
  unread_notifications: null, pending_action_items: null,
  unavailable_sources: ["notifications", "action_items", "github", "feishu"], scope: "Fixture scope",
  projects: [{ id: projectId, name: "数据库项目", lifecycle: "active", progress: 25, progress_status: "available", href: `/projects/${projectId}` }],
  courses: [{ id: courseId, name: "数据库课程", status: "active", href: `/courses/${courseId}/rules` }],
} satisfies components["schemas"]["DailyHomeDTO"];
const activity = {
  id: "progress-1", category: "development", event_type: "task_progress", project_id: projectId,
  project_name: "数据库项目", object_type: "task", object_id: taskId, title: "保存任务进度",
  occurred_at: "2026-10-12T00:00:00Z", href: `/projects/${projectId}/tasks/${taskId}?tab=history`,
} satisfies components["schemas"]["DailyActivityDTO"];

test("C7-07 submits only the requested task scope and refreshes the applicant's own requests", async ({ page }) => {
  const envelope = (data: unknown) => ({ data, meta: { request_id: "access-test" } });
  await page.route("**/api/v1/home/summary", (route) => route.fulfill({ json: envelope(summary) }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { authenticated: true, csrfToken: "access-csrf" } }));
  let submitted = false;
  const scope = { project_id: projectId, resource_type: "task", resource_id: taskId, operation: "read" };
  await page.route(/\/api\/v1\/me\/access-requests(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.scope).toEqual(scope);
      expect(body.reason).toBe("查看当前任务");
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      expect(route.request().headers()["x-csrf-token"]).toBe("access-csrf");
      submitted = true;
      return route.fulfill({ status: 201, json: envelope({ id: taskId }) });
    }
    return route.fulfill({ json: envelope({ page: 1, total: Number(submitted), page_size: 10,
      items: submitted ? [{ id: taskId, scope, status: "pending", reason: "查看当前任务" }] : [] }) });
  });
  await page.goto("/home");
  await page.getByRole("button", { name: "我的访问申请" }).click();
  await page.getByLabel("所属项目 ID", { exact: true }).fill(projectId);
  await page.getByLabel("任务 ID", { exact: true }).fill(taskId);
  await page.getByLabel("截止时间", { exact: true }).fill("2099-12-31T18:00");
  await page.getByLabel("申请理由", { exact: true }).fill("查看当前任务");
  await page.getByRole("button", { name: "提交只读申请" }).click();
  await expect(page.getByText("申请已提交，等待管理员审批。")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: taskId })).toContainText("待审批");
});

test("C1-01 canonical home refreshes real counts and preserves project/course IDs", async ({ page }) => {
  let completed = 1;
  await page.route("**/api/v1/home/summary", (route) => route.fulfill({ json: { data: { ...summary, my_completed_tasks: completed }, meta: { request_id: "home-fixture" } } }));
  await page.goto("/home");
  await expect(page.getByText("数据库项目", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "进入项目", exact: true })).toHaveAttribute("href", `/projects/${projectId}`);
  await expect(page.getByRole("link", { name: "查看课程", exact: true })).toHaveAttribute("href", `/courses/${courseId}/rules`);
  const completedCard = page.locator(".gp-stat").filter({ hasText: "我的已完成任务" });
  await expect(completedCard.locator(".gp-stat-value")).toHaveText("1");
  completed = 2;
  await page.getByRole("button", { name: "刷新统计", exact: true }).click();
  await expect(completedCard.locator(".gp-stat-value")).toHaveText("2");
  await expect(page.getByRole("link", { name: "待处理事项：暂不可用", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "未读通知：暂不可用", exact: true })).toBeVisible();
  await expect(page.getByText("+7%", { exact: true })).toHaveCount(0);
});

test("C1-01 failed refresh hides old statistics and retries without seed fallback", async ({ page }) => {
  let allowed = true;
  await page.route("**/api/v1/home/summary", (route) => route.fulfill(allowed
    ? { json: { data: summary, meta: { request_id: "home-ok" } } }
    : { status: 403, json: { error: { code: "ACCOUNT_INACTIVE", message: "Denied" }, meta: { request_id: "home-denied" } } }));
  await page.goto("/home");
  await expect(page.getByText("数据库项目", { exact: true })).toBeVisible();
  allowed = false;
  await page.getByRole("button", { name: "刷新统计", exact: true }).click();
  await expect(page.getByText("你目前没有权限读取这些数据。", { exact: true })).toBeVisible();
  await expect(page.locator(".gp-stat")).toHaveCount(0);
  await expect(page.getByText("数据库项目", { exact: true })).toHaveCount(0);
  allowed = true;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("数据库项目", { exact: true })).toBeVisible();
});

test("C1-01 inbox counts refresh independently and distinguish zero from unavailable", async ({ page }) => {
  let pending: number | null = 5;
  let unread: number | null = 3;
  await page.route("**/api/v1/home/summary", (route) => route.fulfill({ json: {
    data: { ...summary, pending_action_items: pending, unread_notifications: unread,
      unavailable_sources: ["github", "feishu", ...(pending === null ? ["action_items"] : [])] },
    meta: { request_id: "home-inbox" },
  } }));
  await page.goto("/home");
  await expect(page.getByRole("link", { name: "未读通知：3", exact: true })).toHaveAttribute("href", "/notifications");
  await expect(page.getByRole("link", { name: "待处理事项：5", exact: true })).toHaveAttribute("href", "/action-items");
  unread = 0; pending = null;
  await page.getByRole("button", { name: "刷新统计", exact: true }).click();
  await expect(page.getByRole("link", { name: "未读通知：0", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "待处理事项：暂不可用", exact: true })).toBeVisible();
  await expect(page.getByText("数据库项目", { exact: true })).toBeVisible();
});

test("C1-04 API categories, UTC dates and page survive reload and Back", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/v1/me/activity**", (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    const currentPage = Number(url.searchParams.get("page") ?? 1);
    const record = currentPage === 1 ? activity : {
      ...activity, id: `github_ci_run:${taskId}`, event_type: "github_ci_run",
      object_type: "github", href: `/projects/${projectId}/github?record=${taskId}`,
    } satisfies components["schemas"]["DailyActivityDTO"];
    return route.fulfill({ json: { data: { items: [{ ...record, title: `动态第 ${currentPage} 页` }], page: currentPage, page_size: 10, total: 11, scope: "Self only", unavailable_sources: ["feishu"] }, meta: { request_id: "activity-fixture" } } });
  });
  await page.goto("/activity");
  await expect(page.getByRole("link", { name: "动态第 1 页", exact: true })).toHaveAttribute("href", activity.href);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("link", { name: "动态第 2 页", exact: true })).toHaveAttribute("href", `/projects/${projectId}/github?record=${taskId}`);
  await expect(page.getByText(/GitHub CI 运行 · 数据库项目/)).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole("button", { name: "开发", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-10-12");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/date_from=2026-10-01/);
  await page.reload();
  await expect(page.getByRole("button", { name: "开发", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("开始日期", { exact: true })).toHaveValue("2026-10-01");
  await expect(page.getByRole("link", { name: "动态第 1 页", exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("category")).toBe("development");
  expect(requests.at(-1)?.searchParams.get("date_to")).toBe("2026-10-12");
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(page).not.toHaveURL(/date_from=/);
  await page.goBack();
  await expect(page).toHaveURL(/date_from=2026-10-01/);
});

test("C1-04 saves and clears the current user's GitHub attribution", async ({ page }) => {
  const envelope = (data: unknown) => ({ data, meta: { request_id: "github-author-test" } });
  await page.route("**/api/v1/me/activity**", (route) => route.fulfill({ json: envelope({
    items: [], page: 1, page_size: 10, total: 0, scope: "Self only", unavailable_sources: ["feishu"],
  }) }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { authenticated: true, csrfToken: "github-csrf" } }));
  const received: Array<string | null> = [];
  await page.route("**/api/v1/a/me/github-login", (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe("github-csrf");
    const body = route.request().postDataJSON();
    expect(Object.keys(body)).toEqual(["login"]);
    received.push(body.login);
    if (body.login === "taken") return route.fulfill({ status: 409, json: {
      error: { code: "GITHUB_LOGIN_TAKEN", message: "这个 GitHub 用户名已经被其他账号使用。" },
    } });
    return route.fulfill({ json: envelope({ login: body.login?.toLowerCase() ?? null }) });
  });
  await page.goto("/activity");
  await page.getByText("设置个人 GitHub 用户名", { exact: true }).click();
  const login = page.getByLabel("GitHub 用户名", { exact: true });
  await login.fill("taken");
  await page.getByRole("button", { name: "保存用户名" }).click();
  await expect(page.getByText("这个 GitHub 用户名已经被其他账号使用。", { exact: true })).toBeVisible();
  await login.fill("ExampleDev");
  await page.getByRole("button", { name: "保存用户名" }).click();
  await expect(page.getByText("已保存 GitHub 用户名 @exampledev。")).toBeVisible();
  await page.getByRole("button", { name: "清除作者映射" }).click();
  await expect(page.getByText("已清除 GitHub 用户名映射。")).toBeVisible();
  expect(received).toEqual(["taken", "ExampleDev", null]);
});

test("C1-04 unavailable and empty responses never show local personal records", async ({ page }) => {
  let allowed = false;
  await page.route("**/api/v1/me/activity**", (route) => route.fulfill(allowed
    ? { json: { data: { items: [], page: 1, page_size: 10, total: 0, scope: "Self only", unavailable_sources: ["github", "feishu"] }, meta: { request_id: "empty" } } }
    : { status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Login required" }, meta: { request_id: "denied" } } }));
  await page.goto("/activity");
  await expect(page.getByText(/当前登录身份暂时无法读取此服务/)).toBeVisible();
  await expect(page.locator("main article")).toHaveCount(0);
  allowed = true;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("没有符合条件的个人动态", { exact: true })).toBeVisible();
  await expect(page.locator("main article")).toHaveCount(0);
});
