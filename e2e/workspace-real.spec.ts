import { expect, test, type Page } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";
import { seedData } from "../mocks/seed";

type Schema = components["schemas"];
const userId = "c-url-fixture";
const projectId = "00000000-0000-0000-0000-000000000101";
const courseId = "00000000-0000-0000-0000-000000000102";
const emptySummary: Schema["DailyHomeDTO"] = {
  course_count: 0, project_count: 0, my_task_count: 0, my_completed_tasks: 0,
  task_counts: { not_started: 0, in_progress: 0, pending_submission: 0, pending_verification: 0, completed: 0 },
  unread_notifications: 0, pending_action_items: 0, unavailable_sources: [],
  scope: "Current authenticated user", courses: [], projects: [],
};
const envelope = (data: unknown) => ({ data, meta: { request_id: "workspace-real-fixture" } });
const demoTitles = ["校园服务导航", "软件工程 · 2026", "数据结构与算法 · 2026", "人工智能基础 · 2025", "T-18 需要补充证据", "仓库活动同步"];

async function setup(page: Page) {
  const state: { summary: Schema["DailyHomeDTO"]; failHome: boolean; homeRequests: number } = {
    summary: emptySummary, failHome: false, homeRequests: 0,
  };
  await page.route(/\/api\/v1\/me$/, (route) => route.fulfill({ json: envelope({ user: { id: userId, name: "C test", roles: ["student"] } }) }));
  await page.route("**/api/v1/home/summary", (route) => {
    state.homeRequests++;
    return route.fulfill(state.failHome
      ? { status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "首页服务暂不可用，请重试。" }, meta: { request_id: "workspace-real-failed" } } }
      : { json: envelope(state.summary) });
  });
  await page.route("**/api/v1/me/courses**", (route) => route.fulfill(state.failHome
    ? { status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "课程服务暂不可用" }, meta: { request_id: "courses-failed" } } }
    : { json: envelope({ items: state.summary.courses.map(course => ({ ...course, code: "ACTUAL", semester: "2026", college: "CS", role: "student", joined_at: "2026-11-01", teacher: null, formation_deadline: null, project_deadline: null, group: null, project: null, pending_count: 0 })), total: state.summary.courses.length, page: 1, page_size: 10, counts: { all: state.summary.course_count, active: state.summary.course_count, ended: 0 }, pending_joins: [] }) }));
  await page.route("**/api/v1/projects/project-1/overview", (route) => route.fulfill({ status: 404, json: { error: { code: "PROJECT_NOT_FOUND", message: "项目不存在" }, meta: { request_id: "missing-project" } } }));
  await page.route("**/api/v1/me/notifications**", (route) => route.fulfill({ json: envelope({
    items: [], total: 0, total_all: 0, unread_total: 0, page: 1, page_size: 10,
    inbox_version: 0, snapshot_id: "00000000-0000-0000-0000-000000000103",
  } satisfies Schema["NotificationPageDTO"]) }));
  await page.route("**/api/v1/me/action-items**", (route) => route.fulfill({ json: envelope({
    items: [], total: 0, page: 1, page_size: 10,
  } satisfies Schema["ActionItemPageDTO"]) }));
  await page.route("**/api/v1/me/activity**", (route) => route.fulfill({ json: envelope({
    items: [], total: 0, page: 1, page_size: 10, scope: "Current authenticated user", unavailable_sources: [],
  }) }));
  await page.route("**/api/v1/me/access-requests**", (route) => route.fulfill({ json: envelope({ items: [], total: 0, page: 1, page_size: 10 }) }));
  return state;
}

async function noDemoData(page: Page) {
  for (const title of demoTitles) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await expect(page.locator('main a[href*="project-1"], main a[href*="course-1"]')).toHaveCount(0);
  await expect(page.getByTestId("unread-notification-dot")).toHaveCount(0);
}

test("staging ignores demo flags, clears old workspace caches, and preserves other browser data", async ({ page }) => {
  const state = await setup(page);
  await page.addInitScript(({ seed, actorId }) => {
    localStorage.setItem(`groupproof-v1-workspace:${actorId}`, JSON.stringify(seed));
    localStorage.setItem("groupproof-v1-workspace:old-test-account", JSON.stringify(seed));
    localStorage.setItem("groupproof-v1-workspace", JSON.stringify(seed));
    localStorage.setItem("groupproof-v1-workspace-legacy-backup", JSON.stringify(seed));
    localStorage.setItem("groupproof-preferences", "keep-my-preferences");
    localStorage.setItem("real-api-cache", "keep-real-data");
  }, { seed: seedData, actorId: userId });
  await page.goto("/home");
  await expect(page.locator(".gp-stat-value")).toHaveText(["0", "0", "0", "0"]);
  expect(state.homeRequests).toBeGreaterThan(0);
  await noDemoData(page);
  const readStorage = () => page.evaluate(() => ({
    legacy: Object.keys(localStorage).filter((key) => key.startsWith("groupproof-v1-workspace")),
    preferences: localStorage.getItem("groupproof-preferences"),
    realData: localStorage.getItem("real-api-cache"),
  }));
  await expect.poll(readStorage).toEqual({ legacy: [], preferences: "keep-my-preferences", realData: "keep-real-data" });
  await page.reload();
  await expect(page.locator(".gp-stat-value")).toHaveText(["0", "0", "0", "0"]);
  await noDemoData(page);
  await expect.poll(readStorage).toEqual({ legacy: [], preferences: "keep-my-preferences", realData: "keep-real-data" });
});

test("empty API responses leave every student workspace entry free of demonstration records", async ({ page }) => {
  await setup(page);
  await page.goto("/home");
  await expect(page.locator(".gp-stat-value")).toHaveText(["0", "0", "0", "0"]);
  await noDemoData(page);
  await page.goto("/courses");
  await expect(page.getByRole("heading", { name: "我的课程", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "用邀请码加入课程", exact: true })).toBeVisible();
  await noDemoData(page);
  await page.goto("/courses/join");
  await expect(page.getByLabel("输入教师提供的邀请码")).toBeVisible();
  await expect(page.getByRole("button", { name: /下一步/ })).toBeEnabled();
  await expect(page.getByText(/加入课程前需要验证学校邮箱/)).toHaveCount(0);
  await noDemoData(page);
  await page.goto("/projects/project-1");
  await expect(page.locator("main").getByRole("status")).toContainText("项目不存在");
  await noDemoData(page);
  for (const [path, emptyText] of [
    ["/notifications", "没有符合条件的通知"],
    ["/action-items", "没有符合条件的待办"],
    ["/activity", "没有符合条件的个人动态"],
  ]) {
    await page.goto(path);
    await expect(page.getByText(emptyText, { exact: true })).toBeVisible();
    await noDemoData(page);
    await page.reload();
    await expect(page.getByText(emptyText, { exact: true })).toBeVisible();
    await noDemoData(page);
  }
});

test("actual records remain visible, while failed refresh shows an error without zero or seed fallback", async ({ page }) => {
  const state = await setup(page);
  state.summary = {
    ...emptySummary, course_count: 1, project_count: 1,
    courses: [{ id: courseId, name: "真实接口课程", status: "active", href: `/courses/${courseId}/rules` }],
    projects: [{ id: projectId, name: "真实接口项目", lifecycle: "active", progress: 0, progress_status: "available", href: `/projects/${projectId}` }],
  };
  await page.goto("/home");
  await expect(page.getByText("真实接口课程", { exact: true })).toBeVisible();
  await expect(page.getByText("真实接口项目", { exact: true })).toBeVisible();
  await expect(page.locator(".gp-stat-value")).toHaveText(["1", "1", "0", "0"]);
  state.failHome = true;
  await page.getByRole("button", { name: "刷新统计", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "首页服务暂不可用，请重试。" })).toBeVisible();
  await expect(page.locator(".gp-stat")).toHaveCount(0);
  await expect(page.getByText("真实接口项目", { exact: true })).toHaveCount(0);
  await noDemoData(page);
  state.failHome = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("真实接口项目", { exact: true })).toBeVisible();
  await expect(page.locator(".gp-stat-value")).toHaveText(["1", "1", "0", "0"]);
  await page.goto("/courses");
  await expect(page.getByText("真实接口课程", { exact: true })).toBeVisible();
  state.failHome = true;
  await page.reload();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByText("真实接口课程", { exact: true })).toHaveCount(0);
  await expect(page.getByText("暂无课程", { exact: true })).toHaveCount(0);
  await noDemoData(page);
});


test("clearing demonstration data keeps creation and enrollment actions available", async ({ page }) => {
  await setup(page);
  await page.goto("/home");
  await expect(page.locator(".gp-stat-value")).toHaveText(["0", "0", "0", "0"]);
  const header = page.locator(".gp-page-header");
  await expect(header.getByRole("link", { name: "创建项目", exact: true })).toHaveAttribute("href", "/courses?intent=create-project");
  await expect(header.getByRole("link", { name: "加入课程", exact: true })).toHaveAttribute("href", "/courses/join");
  await expect(page.getByRole("link", { name: "创建项目", exact: true })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "加入课程", exact: true })).toHaveCount(2);
  await header.getByRole("link", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创建项目", exact: true })).toBeVisible();
  await expect(page.getByText("先加入课程，再与同学组队创建项目。", { exact: true })).toBeVisible();
  await page.locator(".gp-page-header").getByRole("link", { name: "加入课程", exact: true }).click();
  await expect(page.getByLabel("输入教师提供的邀请码")).toBeVisible();
  await expect(page.getByRole("button", { name: /下一步/ })).toBeEnabled();
  await noDemoData(page);
});

test("empty workspace actions remain usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto("/home");
  await expect(page.locator(".gp-stat-value")).toHaveText(["0", "0", "0", "0"]);
  const actions = page.locator(".gp-page-header");
  await expect(actions.getByRole("link", { name: "创建项目", exact: true })).toBeVisible();
  await expect(actions.getByRole("link", { name: "加入课程", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await actions.getByRole("link", { name: "加入课程", exact: true }).click();
  await expect(page.getByLabel("输入教师提供的邀请码")).toBeVisible();
  await expect(page.getByRole("button", { name: /下一步/ })).toBeVisible();
});
