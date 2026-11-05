import { expect, test, type Page, type Route } from "@playwright/test";

// B-1 pages 31/32/48 in bworkspace=real mode against a scripted API (no demo data).
const courseA = "00000000-0000-0000-0000-0000000000a1";
const courseB = "00000000-0000-0000-0000-0000000000a2";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string) => route.fulfill({ status, json: { error: { code, message: code }, meta } });

const course = (id: string, name: string, status: "active" | "ended") => ({
  id, code: id === courseA ? "SE26" : "DB26", name, semester: "2026 秋", college: "CS", status, role: "student", joined_at: "2026-09-01T00:00:00Z",
  teacher: { id: "t1", name: "李老师" }, formation_deadline: "2026-12-01T00:00:00Z", project_deadline: "2026-12-30T00:00:00Z",
  group: null, project: null, pending_count: status === "active" ? 2 : 0,
});
const all = [course(courseA, "软件工程实践", "active"), course(courseB, "数据库原理", "ended")];

async function mockMyCourses(page: Page, calls: string[] = []) {
  await page.route("**/api/v1/me/courses**", (route) => {
    const url = new URL(route.request().url());
    calls.push(url.search);
    const tab = url.searchParams.get("tab") ?? "all";
    const q = url.searchParams.get("q") ?? "";
    const items = all.filter((c) => (tab === "all" || c.status === tab) && c.name.includes(q));
    return ok(route, { items, total: items.length, page: 1, page_size: 10, counts: { all: 2, active: 1, ended: 1 }, pending_joins: [] });
  });
}

test("B1-01 我的课程只显示接口返回的课程，Tab 和搜索写进 URL 并随请求发送", async ({ page, context }) => {
  const calls: string[] = [];
  await mockMyCourses(page, calls);
  await page.goto("/courses");
  await expect(page.getByRole("heading", { name: "软件工程实践" })).toBeVisible();
  await expect(page.getByText("待处理 2 项")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("软件工程 · 2026"); // seed course never leaks
  await page.getByRole("tab", { name: /已结束/ }).click();
  await expect(page).toHaveURL(/tab=ended/);
  await expect(page.getByRole("heading", { name: "数据库原理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "软件工程实践" })).toHaveCount(0);
  await page.getByLabel("搜索课程").fill("数据库");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/q=%E6%95%B0%E6%8D%AE%E5%BA%93/);
  expect(calls.at(-1)).toContain("tab=ended");
  await page.reload();
  await expect(page.getByRole("tab", { name: /已结束/ })).toHaveAttribute("aria-selected", "true");
  const copied = await context.newPage();
  await mockMyCourses(copied);
  await copied.goto(page.url());
  await expect(copied.getByRole("heading", { name: "数据库原理" })).toBeVisible();
  await expect(copied.getByRole("tab", { name: /已结束/ })).toHaveAttribute("aria-selected", "true");
});

test("B1-02 三种错误分别提示；邮箱未验证时不能继续", async ({ page }) => {
  let next = "COURSE_INVITE_NOT_FOUND";
  await page.route("**/api/v1/course-joins/preview", (route) => fail(route, next === "COURSE_CLOSED" ? 409 : next === "EMAIL_NOT_VERIFIED" ? 403 : 404, next));
  await page.goto("/courses/join");
  const codeInput = page.getByLabel("输入教师提供的邀请码");
  await codeInput.fill("WRONG-CODE");
  await page.getByRole("button", { name: /下一步/ }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("邀请码不存在或已失效，请向老师确认。");
  next = "COURSE_CLOSED"; await codeInput.fill("ENDED-CODE");
  await page.getByRole("button", { name: /下一步/ }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("这门课程已经结束，不能再加入。");
  next = "EMAIL_NOT_VERIFIED"; await codeInput.fill("SOME-CODE");
  await page.getByRole("button", { name: /下一步/ }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("请先完成学校邮箱验证");
  await expect(page.getByRole("button", { name: /下一步/ })).toBeDisabled();
});

const preview = (mode: "direct" | "approval") => ({
  course_id: courseA, code: "SE26", name: "软件工程实践", semester: "2026 秋", college: "CS", teacher: { id: "t1", name: "李老师" },
  grouping_mode: "free", min_group_size: 3, max_group_size: 4, formation_deadline: "2026-12-01T00:00:00Z", project_deadline: "2026-12-30T00:00:00Z",
  join_mode: mode, already_member: false, pending_request_id: null,
});

test("B1-03 直接加入：连点两次只发同一个幂等键", async ({ page }) => {
  const keys: string[] = [];
  await page.route("**/api/v1/course-joins/preview", (route) => ok(route, preview("direct")));
  await page.route("**/api/v1/course-joins", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return ok(route, { status: "joined", course_id: courseA, request_id: null }, 201);
  });
  await page.goto("/courses/join");
  await page.getByLabel("输入教师提供的邀请码").fill("SE26-INVITE");
  await page.getByRole("button", { name: /下一步/ }).click();
  await expect(page.getByText("每组 3–4 人")).toBeVisible();
  await expect(page.getByText("确认后直接加入")).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认加入" });
  await confirm.dblclick();
  await expect(page.getByRole("heading", { name: "已加入《软件工程实践》" })).toBeVisible();
  expect(new Set(keys).size).toBe(1);
});

test("B1-03 审批模式：提交后显示等待审批", async ({ page }) => {
  await page.route("**/api/v1/course-joins/preview", (route) => ok(route, preview("approval")));
  await page.route("**/api/v1/course-joins", (route) => ok(route, { status: "pending", course_id: courseA, request_id: "r1" }, 201));
  await page.goto("/courses/join");
  await page.getByLabel("输入教师提供的邀请码").fill("SE26-INVITE");
  await page.getByRole("button", { name: /下一步/ }).click();
  await page.getByRole("button", { name: "提交加入申请" }).click();
  await expect(page.getByRole("heading", { name: "申请已提交" })).toBeVisible();
});

test("B1-03 老师在页面 48 批准申请；驳回必须写原因", async ({ page }) => {
  const pending = { id: "r1", course_id: courseA, student: { id: "s1", name: "王同学" }, student_email: "w@school.edu", student_number: "2201",
    status: "pending", message: "补选", created_at: "2026-11-05T08:00:00Z", decided_by: null, decided_at: null, decision_reason: null, lock_version: 0 };
  let items = [pending];
  const decisions: unknown[] = [];
  await page.route("**/api/v1/courses/*/join-requests**", (route) => ok(route, { items, total: items.length, page: 1, page_size: 20 }));
  await page.route("**/api/v1/courses/*/join-policy", (route) => ok(route, { course_id: courseA, mode: "approval", lock_version: 1 }));
  await page.route("**/api/v1/course-joins/r1/decision", (route) => {
    decisions.push(route.request().postDataJSON()); items = [];
    return ok(route, { ...pending, status: "approved", lock_version: 1 });
  });
  await page.goto(`/teacher/courses/${courseA}/member-changes`);
  await expect(page.getByText("王同学")).toBeVisible();
  await expect(page.getByRole("button", { name: "驳回" })).toBeDisabled();
  await page.getByRole("button", { name: "批准" }).click();
  await expect(page.getByText("已批准 王同学 加入课程")).toBeVisible();
  await expect(page.getByText("暂无待处理的加入申请")).toBeVisible();
  expect(decisions).toEqual([{ decision: "approve", expected_version: 0 }]);
});
