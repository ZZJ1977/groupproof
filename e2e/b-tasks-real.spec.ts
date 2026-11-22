import { expect, test, type Page, type Route } from "@playwright/test";

// B-7 pages 11–13 in bworkspace=real mode against a scripted API.
const project = "00000000-0000-0000-0000-0000000000c7";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const columns = (rows: { status: string }[]) => ["not_started", "in_progress", "pending_submission", "pending_verification", "completed"].map((status) => ({
  status, label: { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" }[status], count: rows.filter((r) => r.status === status).length,
}));
const link = (id: string) => ({ detail: `/projects/${project}/tasks/${id}`, submit: `/projects/${project}/tasks/${id}/submit`, evidence: `/projects/${project}/evidence?task=${id}`, verification: `/projects/${project}/tasks/${id}/verification` });
const row = (id: string, code: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, code, title, module: { id: "m1", name: "登录" }, parent_task_id: null, assignees: [{ id: "u1", name: "张三" }], priority: "medium", weight: 50, status: "not_started",
  progress_percent: 0, milestone_ids: [], dependency_ids: [], dependencies_done: true, content_version: 1, lock_version: 3, updated_at: "2026-11-05T00:00:00Z",
  links: link(id), transitions: [], blocked_reason: null, matched: true, ...extra,
});
const startable = { to: "in_progress", kind: "api", method: "POST", path: "/api/v1/tasks/t1/start", href: null, expected_version: 3 };

async function serve(page: Page, rows: () => Record<string, unknown>[], seen: URLSearchParams[] = [], issues: unknown[] = []) {
  await page.route(`**/api/v1/projects/${project}/tasks?**`, (route) => {
    const url = new URL(route.request().url());
    seen.push(url.searchParams);
    const items = rows() as { status: string }[];
    const view = url.searchParams.get("view");
    return ok(route, {
      view, items, total: items.length, page: Number(url.searchParams.get("page") ?? 1), page_size: 20, lock_version: 7, plan_status: "frozen",
      integrity_issues: view === "tree" ? issues : [], columns: columns(items), modules: [{ id: "m1", name: "登录" }],
      members: [{ id: "u1", name: "张三" }, { id: "u2", name: "李四" }], milestones: [{ id: "ms1", name: "中期检查" }],
    });
  });
}

test("B6-01 筛选和展开状态写在 URL；另一个页面打开同一链接看到同样的筛选；坏数据被标出且页面不崩", async ({ page, context }) => {
  const seen: URLSearchParams[] = [];
  const rows = [
    row("p1", "T-001", "父任务"), row("c1", "T-002", "子任务", { parent_task_id: "p1" }),
    row("a", "T-003", "环 A", { parent_task_id: "b" }), row("b", "T-004", "环 B", { parent_task_id: "a" }), row("o", "T-005", "孤儿任务", { parent_task_id: "elsewhere" }),
  ];
  const issues = [
    { code: "parent_cycle", message: "父子关系成环：T-003 → T-004 → T-003", task_id: "a", field: "parent_id", task_ids: ["a", "b"] },
    { code: "unknown_parent", message: "T-005 的父任务不在本项目中。", task_id: "o", field: "parent_id", task_ids: [] },
  ];
  await serve(page, () => rows, seen, issues);
  await page.goto(`/projects/${project}/tasks`);
  await expect(page.getByTestId("tree-issues")).toContainText("任务数据有 2 处问题");
  await expect(page.getByTestId("tree-issues")).toContainText("T-005 的父任务不在本项目中。");
  await expect(page.getByTestId("tree-row")).toHaveCount(5);
  await expect(page.getByTestId("tree-row").filter({ hasText: "孤儿任务" })).toContainText("数据有问题");
  await expect(page.getByTestId("tree-row").filter({ hasText: "环 A" })).toContainText("数据有问题");
  await page.getByRole("button", { name: "收起 T-001" }).click();
  await expect(page.getByTestId("tree-row")).toHaveCount(4);
  await page.getByLabel("搜索", { exact: true }).fill("登录");
  await page.getByRole("button", { name: "查询" }).click();
  await page.getByLabel("负责人").selectOption("u2");
  await expect(page).toHaveURL(/collapsed=p1/);
  await expect(page).toHaveURL(/assignee=u2/);
  const last = seen.at(-1)!;
  expect([last.get("q"), last.get("assignee"), last.get("view")]).toEqual(["登录", "u2", "tree"]);
  const shared = await context.newPage();
  await serve(shared, () => rows, [], issues);
  await shared.goto(page.url());
  await expect(shared.getByLabel("搜索", { exact: true })).toHaveValue("登录");
  await expect(shared.getByLabel("负责人")).toHaveValue("u2");
  await expect(shared.getByTestId("tree-row")).toHaveCount(4); // still collapsed
});

test("B6-02 拖动先确认再调 C；C 拒绝时卡片留在原列并提示原因；不能动的卡片拖不动", async ({ page }) => {
  let status = "not_started";
  const starts: unknown[] = [];
  let reject = true;
  await serve(page, () => [
    row("t1", "T-001", "实现登录页", { status, transitions: status === "not_started" ? [startable] : [] }),
    row("t2", "T-002", "写测试报告", { blocked_reason: "前置任务未完成：T-001", dependencies_done: false }),
  ]);
  await page.route("**/api/v1/tasks/t1/start", (route) => {
    starts.push(route.request().postDataJSON());
    if (reject) return route.fulfill({ status: 409, json: { error: { code: "DEPENDENCIES_INCOMPLETE", message: "Complete blocking tasks first." }, meta } });
    status = "in_progress";
    return ok(route, { task_id: "t1", status: "in_progress" });
  });
  await page.goto(`/projects/${project}/tasks?view=board`);
  const todo = page.getByTestId("column-not_started");
  const doing = page.getByTestId("column-in_progress");
  await expect(todo.getByTestId("board-card").filter({ hasText: "写测试报告" })).toHaveAttribute("draggable", "false");
  await expect(todo.getByText("前置任务未完成：T-001")).toBeVisible();
  await todo.getByTestId("board-card").filter({ hasText: "实现登录页" }).dragTo(doing);
  await expect(page.getByRole("dialog", { name: "确认修改状态" })).toContainText("从“未开始”改为“进行中”");
  expect(starts).toEqual([]); // nothing sent before confirming
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByTestId("tasks-notice")).toContainText("没有改动：前置任务还没完成。");
  await expect(todo.getByText("实现登录页")).toBeVisible();
  expect(starts).toEqual([{ expected_version: 3 }]);
  reject = false;
  await todo.getByRole("button", { name: "移到“进行中”" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByTestId("tasks-notice")).toContainText("T-001 已改为“进行中”");
  await expect(doing.getByText("实现登录页")).toBeVisible();
});

test("B6-03 组合筛选 + 排序 + 分页随请求发送；行内按钮去 C、D 页面；看板改完切到列表立即一致", async ({ page }) => {
  let status = "not_started";
  const seen: URLSearchParams[] = [];
  await serve(page, () => [row("t1", "T-001", "实现登录页", { status, transitions: status === "not_started" ? [startable] : [] }), row("t2", "T-002", "商品列表", { status: "pending_verification" })], seen);
  await page.route("**/api/v1/tasks/t1/start", (route) => { status = "in_progress"; return ok(route, { task_id: "t1", status }); });
  await page.goto(`/projects/${project}/tasks?view=list`);
  const first = page.getByTestId("list-row").filter({ hasText: "实现登录页" });
  await expect(first.getByRole("link", { name: "开始任务" })).toHaveAttribute("href", `/projects/${project}/tasks/t1`);
  await expect(first.getByRole("link", { name: "查看证据" })).toHaveAttribute("href", `/projects/${project}/evidence?task=t1`);
  await expect(page.getByTestId("list-row").filter({ hasText: "商品列表" }).getByRole("link", { name: "查看验收" })).toHaveAttribute("href", `/projects/${project}/tasks/t2/verification`);
  await page.getByLabel("状态").selectOption("not_started");
  await page.getByLabel("模块").selectOption("m1");
  await page.getByLabel("排序").selectOption("-weight");
  await expect(page).toHaveURL(/sort=-weight/);
  const last = seen.at(-1)!;
  expect([last.get("status"), last.get("module"), last.get("sort"), last.get("page"), last.get("view")]).toEqual(["not_started", "m1", "-weight", "1", "list"]);
  await page.getByRole("button", { name: "清空" }).click();
  await page.getByRole("navigation", { name: "任务视图" }).getByRole("link", { name: "看板" }).click();
  await page.getByRole("button", { name: "移到“进行中”" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByTestId("tasks-notice")).toContainText("已改为“进行中”");
  await page.getByRole("navigation", { name: "任务视图" }).getByRole("link", { name: "列表" }).click();
  await expect(page.getByTestId("list-row").filter({ hasText: "实现登录页" })).toContainText("进行中");
  await expect(page.getByTestId("list-row").filter({ hasText: "实现登录页" }).getByRole("link", { name: "提交验收" })).toBeVisible();
});
