import { expect, test, type Page } from "@playwright/test";

const project = "00000000-0000-0000-0000-000000000123";
const course = "00000000-0000-0000-0000-000000000456";
async function setup(page: Page, roles: string[] = ["student"]) {
  const state = { unread: 2, denied: false, denyWrite: false };
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: { data: { user: { roles } } } }));
  await page.route("**/api/v1/me/notifications**", (route) => {
    if (state.denied || (state.denyWrite && route.request().method() === "POST")) return route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN" }, meta: { request_id: "shell" } } });
    if (route.request().method() === "POST") state.unread = 0;
    return route.fulfill({ json: { data: { items: [], total: 0, total_all: 2, unread_total: state.unread,
      page: 1, page_size: 10, inbox_version: 0, snapshot_id: project }, meta: { request_id: "shell" } } });
  });
  await page.route("**/api/v1/projects/**", (route) => route.fulfill({ status: 403,
    json: { error: { code: "FORBIDDEN" }, meta: { request_id: "shell" } } }));
  await page.route("**/api/v1/courses/**", (route) => route.fulfill({ status: 403,
    json: { error: { code: "FORBIDDEN" }, meta: { request_id: "shell" } } }));
  return state;
}

test("C real shell retains UUID project links without seed data or demo search", async ({ page }) => {
  await setup(page); await page.goto(`/projects/${project}/evidence`);
  await expect(page.locator("aside nav").getByRole("link", { name: "GitHub" })).toHaveAttribute("href", `/projects/${project}/github`);
  await expect(page.locator('input[placeholder="请使用页面内筛选"]')).toBeDisabled();
  await expect(page.locator('a[href*="project-1"],a[href*="course-1"]')).toHaveCount(0);
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.locator("select[title]")).toHaveCount(0);
});

test("C denied notification write clears an earlier successful badge until permission recheck", async ({ page }) => {
  const state = await setup(page); await page.goto("/notifications");
  await expect(page.getByTestId("unread-notification-dot")).toBeVisible();
  state.denyWrite = true;
  await page.getByRole("button", { name: "全部标为已读", exact: true }).click();
  await page.getByRole("button", { name: "确认全部已读", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("unread-notification-dot")).toHaveCount(0);
  await expect(page.locator('a[title="未读数暂不可用"]')).toBeVisible();
  await page.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(page.getByTestId("unread-notification-dot")).toBeVisible();
});

test("C teacher shell takes course from the real route", async ({ page }) => {
  await setup(page, ["teacher"]); await page.goto(`/teacher/courses/${course}/files`);
  const links = page.locator("aside nav a");
  await expect(links.first()).toHaveAttribute("href", `/teacher/courses/${course}`);
  for (const href of await links.evaluateAll((items) => items.map((item) => item.getAttribute("href")))) expect(href).toContain(course);
  await expect(page.locator('a[href*="course-1"]')).toHaveCount(0);
});

test("C real notification badge follows successful reads and hides unavailable counts", async ({ page }) => {
  const state = await setup(page); await page.goto("/notifications");
  await expect(page.getByTestId("unread-notification-dot")).toBeVisible();
  await page.getByRole("button", { name: "全部标为已读", exact: true }).click();
  await page.getByRole("button", { name: "确认全部已读", exact: true }).click();
  await expect(page.getByTestId("unread-notification-dot")).toHaveCount(0);
  state.denied = true; await page.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.locator('a[title="未读数暂不可用"]')).toBeVisible();
  await expect(page.getByTestId("unread-notification-dot")).toHaveCount(0);
});
