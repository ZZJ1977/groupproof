import { expect, test, type Route } from "@playwright/test";

// B-8 pages 18–19 in bworkspace=real mode against a scripted API.
const project = "00000000-0000-0000-0000-0000000000e8";
const ms = "00000000-0000-0000-0000-0000000000f1";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string, details: unknown = {}) => route.fulfill({ status, json: { error: { code, message: code, details }, meta } });
const file = { id: "f1", name: "中期报告.pdf", href: `/projects/${project}/files?file=f1` };

function milestone(state: { progress: number; done: boolean; history: unknown[]; status?: string; deadline?: string; changes?: unknown[]; lead?: boolean }) {
  return {
    id: ms, title: "中期检查", description: null, deadline: state.deadline ?? "2026-12-01T15:59:00Z", status: state.status ?? "in_progress", overdue: false,
    progress_percent: state.progress, task_count: 2, completed_task_count: state.progress === 100 ? 2 : 1, deliverables_done: state.done ? 1 : 0, deliverables_total: 1,
    risk: null, lock_version: 0, href: `/projects/${project}/milestones/${ms}`, can_lead: state.lead ?? true, files: [file],
    tasks: [
      { id: "t1", code: "T-001", title: "登录页", status: "completed", progress_percent: 100, weight: 60, assignees: [{ id: "u1", name: "张三" }], href: `/projects/${project}/tasks/t1` },
      { id: "t2", code: "T-002", title: "注册页", status: state.progress === 100 ? "completed" : "in_progress", progress_percent: state.progress === 100 ? 100 : 0, weight: 40, assignees: [], href: `/projects/${project}/tasks/t2` },
    ],
    deliverables: [{ id: "d1", title: "中期报告", done: state.done, done_by: state.done ? { id: "c-url-fixture", name: "组长" } : null, done_at: state.done ? "2026-11-05T02:00:00Z" : null, file: state.done ? file : null, lock_version: state.history.length, history: state.history }],
    date_changes: state.changes ?? [],
  };
}

test("B7-01 进度来自关联任务，风险在 D 没数据时只显示占位", async ({ page }) => {
  let progress = 60;
  await page.route(`**/api/v1/projects/${project}/milestones`, (route) => {
    const { tasks, deliverables, date_changes, files, can_lead, ...brief } = milestone({ progress, done: false, history: [] });
    void tasks; void deliverables; void date_changes; void files; void can_lead;
    return ok(route, { items: [brief], can_lead: true });
  });
  await page.goto(`/projects/${project}/milestones`);
  const card = page.getByTestId("milestone-card");
  await expect(card).toContainText("中期检查");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
  await expect(card.getByTestId("milestone-risk")).toHaveText("风险：暂无数据（由验收模块提供）");
  progress = 100;
  await page.reload();
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(card).toContainText("任务 2/2 完成");
});

test("B7-02 组长勾选交付物并关联文件，刷新还在，能看到谁勾的；非组长不能勾", async ({ page }) => {
  const state = { progress: 60, done: false, history: [] as unknown[], lead: true };
  const posts: unknown[] = [];
  await page.route(`**/api/v1/projects/${project}/milestones/${ms}`, (route) => ok(route, milestone(state)));
  await page.route(`**/api/v1/projects/${project}/milestones/${ms}/deliverables/d1/check`, (route) => {
    posts.push(route.request().postDataJSON());
    state.done = true;
    state.history = [{ action: "checked", actor: { id: "c-url-fixture", name: "组长" }, at: "2026-11-05T02:00:00Z", file }];
    return ok(route, milestone(state));
  });
  await page.goto(`/projects/${project}/milestones/${ms}`);
  await page.getByLabel("关联文件").selectOption("f1");
  // Controlled checkbox: it turns on only after the API accepts the change.
  await page.getByRole("checkbox", { name: "中期报告" }).click();
  await expect(page.getByTestId("milestone-notice")).toContainText("已勾选「中期报告」");
  expect(posts).toEqual([{ done: true, file_id: "f1", expected_version: 0 }]);
  await page.reload();
  const item = page.getByTestId("deliverable");
  await expect(item.getByRole("checkbox")).toBeChecked();
  await expect(item).toContainText("组长 于 2026-11-05 02:00 勾选");
  await expect(item.getByRole("link", { name: "中期报告.pdf" })).toHaveAttribute("href", file.href);
  await item.getByRole("button", { name: "记录" }).click();
  await expect(page.getByTestId("deliverable-history")).toContainText("勾选（中期报告.pdf）");
  state.lead = false;
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "中期报告" })).toBeDisabled();
  await expect(page.getByText("只有组长可以勾选交付物。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认阶段交付" })).toHaveCount(0);
});

test("B7-03 缺项时逐项列出；验收服务不可用时不允许跳过；齐了才完成", async ({ page }) => {
  let attempt = 0;
  const state: { progress: number; done: boolean; history: unknown[]; status?: string } = { progress: 60, done: false, history: [] };
  await page.route(`**/api/v1/projects/${project}/milestones/${ms}`, (route) => ok(route, milestone(state)));
  await page.route(`**/api/v1/projects/${project}/milestones/${ms}/complete`, (route) => {
    attempt += 1;
    if (attempt === 1) return fail(route, 503, "VERIFICATION_UNAVAILABLE");
    if (attempt === 2) return fail(route, 409, "MILESTONE_NOT_READY", { tasks: [{ id: "t2", code: "T-002", title: "注册页", state: "in_review" }], deliverables: [{ id: "d1", title: "中期报告" }] });
    Object.assign(state, { progress: 100, done: true, status: "completed" });
    return ok(route, milestone(state));
  });
  await page.goto(`/projects/${project}/milestones/${ms}`);
  const confirm = page.getByRole("button", { name: "确认阶段交付" });
  await confirm.click();
  await expect(page.getByTestId("milestone-notice")).toContainText("验收服务暂不可用，请稍后重试。");
  await confirm.click();
  const notice = page.getByTestId("milestone-notice");
  await expect(notice).toContainText("还不能确认交付");
  await expect(notice.getByRole("listitem")).toHaveText(["任务 T-002 注册页：正在验收", "交付物「中期报告」还没勾选"]);
  await confirm.click();
  await expect(notice).toContainText("阶段交付已确认，已通知课程老师");
  await expect(page.getByText("已交付").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "确认阶段交付" })).toHaveCount(0);
});

test("B7-04 不写原因改期被拒；改期后能看到改前、改后日期和原因", async ({ page }) => {
  const state = { progress: 60, done: false, history: [] as unknown[], changes: [] as unknown[], deadline: "2026-12-01T15:59:00Z" };
  const posts: { reason: string; deadline: string }[] = [];
  await page.route(`**/api/v1/projects/${project}/milestones/${ms}`, (route) => ok(route, milestone(state)));
  await page.route(`**/api/v1/projects/${project}/milestones/${ms}/reschedule`, (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (!body.reason.trim()) return fail(route, 422, "REASON_REQUIRED");
    state.changes = [{ old_deadline: state.deadline, new_deadline: body.deadline, reason: body.reason, changed_by: { id: "c-url-fixture", name: "组长" }, changed_at: "2026-11-05T03:00:00Z" }];
    state.deadline = body.deadline;
    return ok(route, milestone(state));
  });
  await page.goto(`/projects/${project}/milestones/${ms}`);
  await page.getByLabel("新的截止日期").fill("2026-12-10");
  await page.getByRole("button", { name: "改期" }).click();
  await expect(page.getByTestId("milestone-notice")).toContainText("请填写原因");
  await page.getByLabel("改期原因（必填）").fill("接口联调延期");
  await page.getByRole("button", { name: "改期" }).click();
  await expect(page.getByTestId("milestone-notice")).toContainText("已通知老师和全组");
  await expect(page.getByTestId("date-change")).toContainText("2026-12-01 →");
  await expect(page.getByTestId("date-change")).toContainText("原因：接口联调延期");
  expect(posts.map((p) => p.reason)).toEqual(["", "接口联调延期"]);
});
