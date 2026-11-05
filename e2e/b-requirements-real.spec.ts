import { expect, test, type Page, type Route } from "@playwright/test";

// B-4 page 08 steps 3–5 in bworkspace=real mode against a scripted API.
const me = "c-url-fixture"; // user id from the loopback session fixture
const project = "00000000-0000-0000-0000-0000000000c3";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string) => route.fulfill({ status, json: { error: { code, message: code }, meta } });
const person = (id: string, name: string) => ({ id, name });
const base = `**/api/v1/projects/${project}`;

const setup = (step: number, status = "draft") => ({ project_id: project, name: "校园二手平台", project_type: null, description: null, start_date: "2026-11-05", end_date: "2027-01-10", course_deadline: "2027-01-10", setup_status: status, setup_step: step, can_edit: status === "draft", materials: [], lock_version: 2 });
const moduleRow = (owner: ReturnType<typeof person> | null = null) => ({ id: "m1", name: "交易模块", description: null, owner, origin: "ai", requirement_count: 1, lock_version: 0 });
const req = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, module_id: "m1", title, description: null, priority: "medium", status: "draft", origin: "ai", edited_by_human: false, excluded: false, sources: [{ material_id: "mt1", material_title: "课程要求", segment_id: "p1", quote: "学生可以发布商品" }], lock_version: 0, ...extra });
const board = (extra: Record<string, unknown> = {}) => ({ project_id: project, setup_status: "draft", setup_step: 3, editable: true, latest_run: null, modules: [], requirements: [], conflicts: [], open_conflicts: 0, ...extra });
const overview = { id: project, name: "校园二手平台", description: null, course_id: null, group_id: null, setup_status: "draft", setup_step: 5, lifecycle: "active", entry: "setup", can_edit: true, is_leader: true, final_deadline: null, stats: { task_count: 0, completed_count: 0, progress: null, progress_status: "no_weighted_tasks", member_count: 2, milestone_count: 0 }, next_milestone: null, members: [person(me, "我"), person("u2", "李同学")], lock_version: 2 };

async function mockSetup(page: Page, step: number, status = "draft") {
  await page.route(`${base}/setup`, (route) => ok(route, setup(step, status)));
  await page.route(`${base}/overview`, (route) => ok(route, { ...overview, setup_status: status }));
}

test("B3-05 开始分析后显示处理中，完成后显示需求和出处", async ({ page }) => {
  await mockSetup(page, 3);
  let phase: "idle" | "processing" | "done" = "idle";
  let polls = 0;
  const run = (status: string) => ({ id: "r1", status, error_code: null, error_message: null, summary: status === "succeeded" ? { requirements_added: 1, conflicts_added: 0, requirements_kept: 0 } : null, is_placeholder: true, created_at: "2026-11-05T00:00:00Z", finished_at: null });
  await page.route(`${base}/setup/requirements`, (route) => {
    if (phase === "processing" && ++polls > 1) phase = "done";
    if (phase === "idle") return ok(route, board());
    if (phase === "processing") return ok(route, board({ latest_run: run("processing") }));
    return ok(route, board({ latest_run: run("succeeded"), modules: [moduleRow()], requirements: [req("q1", "发布二手商品")] }));
  });
  await page.route(`${base}/analysis`, (route) => { phase = "processing"; return ok(route, run("processing"), 202); });
  await page.goto(`/projects/${project}/setup`);
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByText("正在分析资料，处理中…")).toBeVisible();
  await expect(page.getByText("发布二手商品")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/出处：课程要求 · 第 1 段/)).toBeVisible();
  await expect(page.getByText("（当前是示例结果，接入真实 AI 后会替换）", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新分析" })).toBeVisible();
});

test("B3-05 AI 不可用时提示并可以手动录入", async ({ page }) => {
  await mockSetup(page, 3);
  const modules: unknown[] = [];
  const requirements: unknown[] = [];
  const unavailable = { id: "r1", status: "unavailable", error_code: "AI_UNAVAILABLE", error_message: "AI 暂不可用", summary: null, is_placeholder: false, created_at: "2026-11-05T00:00:00Z", finished_at: "2026-11-05T00:00:01Z" };
  await page.route(`${base}/setup/requirements`, (route) => ok(route, board({ latest_run: unavailable, modules, requirements })));
  await page.route(`${base}/modules`, (route) => { const row = { ...moduleRow(), origin: "manual", requirement_count: 0, name: route.request().postDataJSON().name }; modules.push(row); return ok(route, row, 201); });
  await page.route(`${base}/requirements`, (route) => { const body = route.request().postDataJSON(); const row = req("q9", body.title, { origin: "manual", edited_by_human: true, sources: [] }); requirements.push(row); return ok(route, row, 201); });
  await page.goto(`/projects/${project}/setup`);
  await expect(page.getByText("AI 暂不可用，请在下面手动录入模块和需求，流程可以照常走完。")).toBeVisible();
  await page.getByLabel("新模块名称").fill("账号模块");
  await page.getByRole("button", { name: "添加模块" }).click();
  await page.getByLabel("需求标题").fill("用户可以注册");
  await page.getByRole("button", { name: "添加需求" }).click();
  await expect(page.getByText("用户可以注册")).toBeVisible();
  await expect(page.getByText("手工录入")).toBeVisible();
});

test("B3-06 有未处理冲突时不能继续；不写理由不能提交处理", async ({ page }) => {
  await mockSetup(page, 4);
  const conflict = { id: "c1", left: req("q1", "商品需审核"), right: req("q2", "商品直接上架"), description: "两份资料对上架流程说法不一致", status: "open", resolution: null };
  await page.route(`${base}/setup/requirements`, (route) => ok(route, board({ setup_step: 4, modules: [moduleRow()], requirements: [conflict.left, conflict.right], conflicts: [conflict], open_conflicts: 1 })));
  await page.route(`${base}/setup/advance`, (route) => fail(route, 409, "CONFLICTS_UNRESOLVED"));
  await page.goto(`/projects/${project}/setup`);
  await expect(page.getByText("两份资料对上架流程说法不一致")).toBeVisible();
  await page.getByRole("button", { name: "保存并继续" }).click();
  await expect(page.getByText("还有冲突没有处理，处理完才能继续。")).toBeVisible();
  const resolve = page.getByRole("button", { name: "确认处理" });
  await expect(resolve).toBeDisabled();
  await page.getByLabel("理由（必填）").fill("以课程要求为准");
  await expect(resolve).toBeEnabled();
});

test("B3-07 清单未满足时“请大家确认”不可用", async ({ page }) => {
  await mockSetup(page, 5);
  await page.route(`${base}/setup/requirements`, (route) => ok(route, board({ setup_step: 5, modules: [moduleRow()], requirements: [req("q1", "发布二手商品")] })));
  await page.route(`${base}/baselines/current`, (route) => ok(route, null));
  await page.route(`${base}/baseline/checklist`, (route) => ok(route, { project_id: project, ready: false, in_scope: "", out_of_scope: "", scope_version: 0, items: [
    { key: "scope_filled", label: "项目范围已填写", kind: "rule", passed: false, detail: null, checked_by: null },
    { key: "modules_have_owners", label: "每个模块都有负责人", kind: "rule", passed: false, detail: "交易模块", checked_by: null },
    { key: "requirements_reviewed", label: "组员已逐条看过需求清单", kind: "manual", passed: false, detail: null, checked_by: null },
  ] }));
  await page.goto(`/projects/${project}/setup`);
  await expect(page.getByText("每个模块都有负责人（未满足）：交易模块")).toBeVisible();
  await expect(page.getByRole("button", { name: "请大家确认" })).toBeDisabled();
});

test("B3-08 待确认时本人可以确认；组长强推必须写原因；冻结后显示基线", async ({ page }) => {
  await mockSetup(page, 5, "pending_confirmation");
  let frozen = false;
  const decisions: unknown[] = [];
  const baseline = () => ({
    id: "b1", version_no: 1, status: frozen ? "frozen" : "draft", created_by: person(me, "我"), created_at: "2026-11-05T00:00:00Z", frozen_at: frozen ? "2026-11-05T01:00:00Z" : null, lock_version: 0,
    confirmations: [{ user: person(me, "我"), status: frozen ? "confirmed" : "pending", comment: null, confirmed_at: null }, { user: person("u2", "李同学"), status: "pending", comment: null, confirmed_at: null }],
    waiting_for: frozen ? [] : [person(me, "我"), person("u2", "李同学")], snapshot: { requirements: [{ id: "q1", title: "发布二手商品" }], modules: [{ id: "m1", name: "交易模块" }] },
  });
  await page.route(`${base}/setup/requirements`, (route) => ok(route, board({ setup_status: "pending_confirmation", editable: false, modules: [moduleRow(person(me, "我"))] })));
  await page.route(`${base}/baseline/checklist`, (route) => ok(route, { project_id: project, ready: true, in_scope: "交易", out_of_scope: "", scope_version: 1, items: [] }));
  await page.route(`${base}/baselines/current`, (route) => ok(route, baseline()));
  await page.route(`${base}/baselines/b1/confirmations/${me}`, (route) => { decisions.push(route.request().postDataJSON()); return ok(route, baseline()); });
  await page.route(`${base}/baselines/b1/force-freeze`, (route) => { frozen = true; return ok(route, baseline()); });
  await page.goto(`/projects/${project}/setup`);
  await expect(page.getByText("还需确认：我、李同学")).toBeVisible();
  await page.getByRole("button", { name: "确认基线" }).click();
  await expect.poll(() => decisions).toEqual([{ decision: "confirm" }]);
  const forceButton = page.getByRole("button", { name: "强制冻结" });
  await expect(forceButton).toBeDisabled();
  await page.getByLabel("原因（必填）").fill("截止前必须冻结");
  await forceButton.click();
  await expect(page.getByText("需求基线 v1 已冻结")).toBeVisible();
  await expect(page.getByText(/共 1 条需求、1 个模块/)).toBeVisible();
});
