import { expect, test, type Page, type Route } from "@playwright/test";

// B-6 page 10 in bworkspace=real mode against a scripted API.
const project = "00000000-0000-0000-0000-0000000000c6";
const me = "c-url-fixture"; // user id from the loopback session fixture
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string, details: unknown = {}) =>
  route.fulfill({ status, json: { error: { code, message: code, details }, meta } });
const base = `**/api/v1/projects/${project}/plan`;
const members = [{ id: me, name: "我" }, { id: "u2", name: "李四" }];
const task = (id: string, code: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, code, title, description: "", module_id: "m1", parent_task_id: null, requirement_ids: ["q1"], assignees: [members[1]], dependency_ids: [], milestone_ids: [],
  priority: "medium", weight: 50, criteria: [{ id: `${id}-c1`, key: "AC-1", text: "能登录", needs_recheck: false }], status: "not_started", progress_percent: 0,
  content_version: 1, origin: "manual", href: `/projects/${project}/tasks/${id}`, ...extra,
});
const plan = (extra: Record<string, unknown> = {}) => ({
  project_id: project, id: "p1", version_no: 1, status: "draft", lock_version: 3, baseline_frozen: true, baseline_version_no: 1, frozen_at: null,
  tasks: [task("t1", "T-001", "实现登录页"), task("t2", "T-002", "实现注册页", { assignees: [{ id: me, name: "我" }] })],
  issues: [], confirmations: [{ user: members[0], state: "pending", confirmed_at: null, task_count: 1 }, { user: members[1], state: "stale", confirmed_at: null, task_count: 1 }],
  my_task_versions: { t2: 1 }, my_state: "pending", can_edit: true, can_lead: true, root_weight_total: 100,
  modules: [{ id: "m1", name: "登录" }], requirements: [{ id: "q1", name: "用户可以登录", code: "R-001", module_id: "m1" }], milestones: [{ id: "ms1", name: "中期检查" }], members,
  history: [{ id: "p1", version_no: 1, status: "draft", frozen_at: null, created_at: "2026-11-05T00:00:00Z" }], ...extra,
});

async function stubSuggestions(page: Page, items: unknown[] = []) {
  await page.route(`${base}/suggestions`, (route) => (route.request().method() === "GET" ? ok(route, items) : route.fallback()));
}

test("B5-01 保存时环形依赖被拒，页面列出环上的任务；保存成功后版本号加一", async ({ page }) => {
  const puts: Record<string, unknown>[] = [];
  let current = plan();
  await page.route(base, (route) => ok(route, current));
  await stubSuggestions(page);
  await page.route(`${base}/tasks/t1`, (route) => {
    const sent = route.request().postDataJSON();
    puts.push(sent);
    if ((sent.dependency_ids as string[]).includes("t2")) {
      return fail(route, 422, "PLAN_VALIDATION_FAILED", { issues: [{ code: "dependency_cycle", message: "前置任务成环：T-001 → T-002 → T-001", task_id: "t1", field: "dependency_ids", task_ids: ["t1", "t2"] }] });
    }
    current = plan({ tasks: [task("t1", "T-001", String(sent.title), { content_version: 2 }), current.tasks[1]] });
    return ok(route, current.tasks[0]);
  });
  await page.goto(`/projects/${project}/planning?task=t1`);
  const editor = page.locator("form").filter({ has: page.getByLabel("任务名称") });
  await editor.getByRole("checkbox", { name: "T-002 实现注册页" }).check();
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(page.getByTestId("plan-notice")).toContainText("前置任务成环：T-001 → T-002 → T-001");
  await editor.getByRole("checkbox", { name: "T-002 实现注册页" }).uncheck();
  await page.getByLabel("任务名称").fill("实现登录页和找回密码");
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(page.getByText("已保存 T-001（v2）")).toBeVisible();
  expect(puts.at(-1)).toMatchObject({ title: "实现登录页和找回密码", expected_version: 1, dependency_ids: [], criteria: [{ id: "t1-c1", text: "能登录" }] });
});

test("B5-02/B5-05 冻结被拒时列出缺验收标准的任务和未确认的人；冻结后全部只读", async ({ page }) => {
  let current = plan();
  await page.route(base, (route) => ok(route, current));
  await stubSuggestions(page);
  let attempts = 0;
  await page.route(`${base}/freeze`, (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({ expected_version: 3 });
    if (attempts === 1) {
      return fail(route, 409, "PLAN_NOT_READY", { issues: [{ code: "missing_criteria", message: "T-002 没有验收标准。", task_id: "t2", field: "criteria", task_ids: [] }], unconfirmed: [{ id: "u2", name: "李四" }] });
    }
    current = plan({ status: "frozen", can_edit: false, lock_version: 4, frozen_at: "2026-11-05T08:00:00Z" });
    return ok(route, current);
  });
  await page.goto(`/projects/${project}/planning`);
  await page.getByRole("button", { name: "冻结计划" }).click();
  const alert = page.getByTestId("plan-notice");
  await expect(alert).toContainText("T-002 没有验收标准。");
  await expect(alert).toContainText("李四 还没确认任务分配");
  await page.getByRole("button", { name: "冻结计划" }).click();
  await expect(page.getByText("任务计划已冻结，全组都收到了通知。")).toBeVisible();
  await expect(page.getByText("计划已冻结，任务只读。")).toBeVisible();
  await expect(page.getByRole("button", { name: "新建任务" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "生成建议" })).toHaveCount(0);
  await page.getByText("实现登录页").click();
  await expect(page.getByLabel("任务名称")).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存任务" })).toHaveCount(0);
});

test("B5-03 AI 建议先列出，采纳才进入计划；重复生成提示跳过", async ({ page }) => {
  const suggestion = { id: "s1", requirement_id: "q1", requirement_code: "R-001", requirement_title: "用户可以登录", title: "【示例】实现：用户可以登录", description: "", acceptance_criteria: ["可以登录"], status: "pending", is_placeholder: true, adopted_task_id: null, created_at: "2026-11-05T00:00:00Z" };
  let pending = [suggestion];
  const adopted: unknown[] = [];
  await page.route(base, (route) => ok(route, plan()));
  await page.route(`${base}/suggestions`, (route) => route.request().method() === "GET" ? ok(route, pending)
    : ok(route, { created: 0, duplicates: 1, uncovered_requirement_ids: [], is_placeholder: true, suggestions: pending }));
  await page.route(`${base}/suggestions/s1/adopt`, (route) => { adopted.push(route.request().postDataJSON()); pending = []; return ok(route, task("t3", "T-003", suggestion.title, { origin: "ai" }), 201); });
  await page.goto(`/projects/${project}/planning`);
  await expect(page.getByTestId("plan-suggestion")).toContainText("【示例】实现：用户可以登录");
  await expect(page.getByTestId("plan-suggestion")).toContainText("示例结果");
  await page.getByRole("button", { name: "生成建议" }).click();
  await expect(page.getByText("新增 0 条建议，1 条与已有建议重复已跳过")).toBeVisible();
  await expect(page.getByTestId("plan-suggestion")).toHaveCount(1);
  await page.getByRole("button", { name: "采纳" }).click();
  await expect(page.getByText("已采纳为 T-003")).toBeVisible();
  expect(adopted).toEqual([{ weight: 1 }]);
  await expect(page.getByTestId("plan-suggestion")).toHaveCount(0);
});

test("B5-04 分配变化后显示需重新确认；确认时带上看到的任务版本", async ({ page }) => {
  const confirms: unknown[] = [];
  let current = plan();
  await page.route(base, (route) => ok(route, current));
  await stubSuggestions(page);
  await page.route(`${base}/confirmations/me`, (route) => {
    confirms.push(route.request().postDataJSON());
    current = plan({ my_state: "confirmed", confirmations: [{ user: members[0], state: "confirmed", confirmed_at: "2026-11-05T08:00:00Z", task_count: 1 }, current.confirmations[1]] });
    return ok(route, current);
  });
  await page.goto(`/projects/${project}/planning`);
  const rows = page.getByTestId("plan-confirmation");
  await expect(rows.filter({ hasText: "李四" })).toContainText("分配有变化，需重新确认");
  await page.getByRole("button", { name: "确认我的分配" }).click();
  await expect(page.getByText("已确认你的任务分配。")).toBeVisible();
  await expect(rows.filter({ hasText: "我" }).first()).toContainText("已确认");
  expect(confirms).toEqual([{ task_versions: { t2: 1 } }]);
  await expect(page.getByRole("button", { name: "确认我的分配" })).toHaveCount(0);
});

test("B5-05 解锁要写原因，解锁后回到草稿", async ({ page }) => {
  const unlocks: unknown[] = [];
  let current = plan({ status: "frozen", can_edit: false, lock_version: 4 });
  await page.route(base, (route) => ok(route, current));
  await stubSuggestions(page);
  await page.route(`${base}/unlock`, (route) => {
    const sent = route.request().postDataJSON();
    unlocks.push(sent);
    if (!sent.reason) return fail(route, 422, "REASON_REQUIRED", { field: "reason" });
    current = plan({ version_no: 2, history: [{ id: "p2", version_no: 2, status: "draft", frozen_at: null, created_at: "2026-11-05T09:00:00Z" }, { id: "p1", version_no: 1, status: "archived", frozen_at: "2026-11-05T08:00:00Z", created_at: "2026-11-05T00:00:00Z" }] });
    return ok(route, current);
  });
  await page.goto(`/projects/${project}/planning`);
  await page.getByRole("button", { name: "解锁修改" }).click();
  await page.getByRole("button", { name: "确认解锁" }).click();
  await expect(page.getByTestId("plan-notice")).toContainText("请填写原因");
  await page.getByLabel("解锁原因（必填，全组都会看到）").fill("老师要求加一个模块");
  await page.getByRole("button", { name: "确认解锁" }).click();
  await expect(page.getByText("计划已解锁，已生成新草稿")).toBeVisible();
  await expect(page.getByText("计划 v2 · 草稿")).toBeVisible();
  expect(unlocks.at(-1)).toEqual({ expected_version: 4, reason: "老师要求加一个模块" });
});
