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
    return route.fulfill({ json: { data: { items: [{ ...activity, title: `动态第 ${currentPage} 页` }], page: currentPage, page_size: 10, total: 11, scope: "Self only", unavailable_sources: ["github", "feishu"] }, meta: { request_id: "activity-fixture" } } });
  });
  await page.goto("/activity");
  await expect(page.getByRole("link", { name: "动态第 1 页", exact: true })).toHaveAttribute("href", activity.href);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("link", { name: "动态第 2 页", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole("button", { name: "任务执行", exact: true }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-10-12");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/date_from=2026-10-01/);
  await page.reload();
  await expect(page.getByRole("button", { name: "任务执行", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("开始日期", { exact: true })).toHaveValue("2026-10-01");
  await expect(page.getByRole("link", { name: "动态第 1 页", exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("category")).toBe("development");
  expect(requests.at(-1)?.searchParams.get("date_to")).toBe("2026-10-12");
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(page).not.toHaveURL(/date_from=/);
  await page.goBack();
  await expect(page).toHaveURL(/date_from=2026-10-01/);
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
