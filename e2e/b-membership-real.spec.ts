import { expect, test, type Route } from "@playwright/test";

// B-8 pages 34 (remove), 37 (leave) and 48 (teacher) in bworkspace=real mode against a scripted API.
const me = "c-url-fixture";
const course = "00000000-0000-0000-0000-0000000000a8";
const group = "00000000-0000-0000-0000-0000000000b8";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string) => route.fulfill({ status, json: { error: { code, message: code }, meta } });
const person = (id: string, name: string) => ({ id, name });

const groupDetail = (leader: string) => ({
  id: group, course_id: course, name: "星火组", direction: null, leader: person(leader, "组长"), member_count: 3, max_group_size: 4,
  is_mine: true, full: false, lock_version: 0, formation_open: false, project_id: "p1", invitations: [], leader_change: null,
  members: [me, "u2", "u3"].map((id) => ({ ...person(id, id === me ? "我" : id === "u2" ? "李同学" : "王同学"), role: id === leader ? "leader" : "member", joined_at: "2026-11-01T00:00:00Z" })),
});
const openTasks = (member: { id: string; name: string }, immediate: boolean) => ({
  member, applies_immediately: immediate, is_leader: true,
  candidates: [person(me, "我"), person("u2", "李同学"), person("u3", "王同学")].filter((p) => p.id !== member.id),
  tasks: [
    { id: "t1", project_id: "p1", code: "T-001", title: "登录页", status: "in_progress", href: "/projects/p1/tasks/t1" },
    { id: "t2", project_id: "p1", code: "T-002", title: "测试报告", status: "not_started", href: "/projects/p1/tasks/t2" },
  ],
});
const change = (overrides: Record<string, unknown> = {}) => ({
  id: "r1", course_id: course, group_id: group, group_name: "星火组", project_id: "p1", change_type: "remove", member: person("u2", "李同学"),
  requested_by: person(me, "我"), status: "pending", reason: "长期不参与", teacher_comment: null, decided_by: null, decided_at: null, applied_at: null,
  created_at: "2026-11-05T00:00:00Z", lock_version: 0, can_edit: false,
  handovers: [{ task_id: "t1", code: "T-001", title: "登录页", status: "in_progress", from_user: person("u2", "李同学"), to_user: person("u3", "王同学"), applied_at: null }],
  ...overrides,
});

test("B2-04 组长移出：每个未完成任务都指定接手人前按钮不可点；接手人里没有被移出的人", async ({ page }) => {
  const posts: unknown[] = [];
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, groupDetail(me)));
  await page.route(`**/api/v1/courses/${course}/ungrouped-students**`, (route) => ok(route, []));
  await page.route(`**/api/v1/groups/${group}/membership-changes`, (route) => {
    if (route.request().method() === "GET") return ok(route, posts.length ? [change()] : []);
    posts.push(route.request().postDataJSON());
    return ok(route, change(), 201);
  });
  await page.route(`**/api/v1/groups/${group}/members/u2/open-tasks`, (route) => ok(route, openTasks(person("u2", "李同学"), false)));
  await page.goto(`/courses/${course}/groups/${group}`);
  const remove = page.getByRole("button", { name: "移出" });
  await page.getByLabel("要移出的成员").selectOption("u2");
  await expect(page.getByTestId("handover-row")).toHaveCount(2);
  await expect(page.getByLabel("T-001 的接手人").locator("option")).toHaveText(["选择接手人", "我", "王同学"]);
  await page.getByLabel("原因（必填）").fill("长期不参与");
  await page.getByLabel("T-001 的接手人").selectOption("u3");
  await expect(remove).toBeDisabled(); // T-002 still has no receiver
  await page.getByLabel("T-002 的接手人").selectOption(me);
  await expect(page.getByText("组队已截止，提交后需要老师审批")).toBeVisible();
  await remove.click();
  await expect(page.getByText("已提交给老师审批，批准前成员仍在组内")).toBeVisible();
  expect(posts).toEqual([{ change_type: "remove", member_id: "u2", reason: "长期不参与", handovers: [{ task_id: "t1", to_user_id: "u3" }, { task_id: "t2", to_user_id: me }] }]);
  await expect(page.getByTestId("membership-change")).toContainText("等待老师审批");
});

test("B2-06 成员退出：截止前提交立即生效；组长要先转让", async ({ page }) => {
  let leader = "u2";
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, groupDetail(leader)));
  await page.route(`**/api/v1/groups/${group}/members/${me}/open-tasks`, (route) => ok(route, openTasks(person(me, "我"), true)));
  await page.route(`**/api/v1/groups/${group}/membership-changes`, (route) => {
    if (route.request().method() === "GET") return ok(route, []);
    return ok(route, change({ change_type: "leave", member: person(me, "我"), status: "applied", applied_at: "2026-11-05T01:00:00Z" }), 201);
  });
  await page.goto(`/courses/${course}/groups/${group}/leave`);
  await expect(page.getByText("组队截止前提交会立即生效")).toBeVisible();
  const submit = page.getByRole("button", { name: "提交退出" });
  await page.getByLabel("T-001 的接手人").selectOption("u2");
  await page.getByLabel("T-002 的接手人").selectOption("u3");
  await expect(submit).toBeDisabled(); // reason missing
  await page.getByLabel("退出原因（必填）").fill("转专业");
  await submit.click();
  await expect(page.getByTestId("leave-notice")).toContainText("你已退出小组，任务已转给接手人");
  leader = me;
  await page.reload();
  await expect(page.getByText("你是组长，需要先把组长交给其他成员才能退出。")).toBeVisible();
  await expect(page.getByRole("button", { name: "提交退出" })).toHaveCount(0);
});

test("B2-07 老师批准失败时提示原因；要求补充需要写意见；批准后从列表消失", async ({ page }) => {
  let rows = [change()];
  let attempt = 0;
  const decisions: unknown[] = [];
  await page.route(`**/api/v1/courses/${course}/join-requests**`, (route) => ok(route, { items: [], total: 0, page: 1, page_size: 20 }));
  await page.route(`**/api/v1/courses/${course}/group-invitations`, (route) => ok(route, []));
  await page.route(`**/api/v1/courses/${course}/membership-changes**`, (route) => ok(route, rows));
  await page.route("**/api/v1/membership-changes/r1/decide", (route) => {
    const body = route.request().postDataJSON();
    decisions.push(body);
    attempt += 1;
    if (attempt === 1) return fail(route, 409, "HANDOVER_TARGET_LEFT");
    rows = [];
    return ok(route, change({ status: body.decision === "approve" ? "applied" : body.decision }));
  });
  await page.goto(`/teacher/courses/${course}/member-changes`);
  const row = page.getByTestId("membership-request");
  await expect(row).toContainText("组长 我 申请移出 李同学");
  await expect(row).toContainText("T-001 登录页 → 王同学");
  await expect(row.getByRole("button", { name: "要求补充" })).toBeDisabled();
  await row.getByRole("button", { name: "批准" }).click();
  await expect(page.getByTestId("membership-notice")).toContainText("有接手人已经不在本组，成员和任务都没有改动。");
  await row.getByLabel("老师意见").fill("请重新指定接手人");
  await row.getByRole("button", { name: "要求补充" }).click();
  await expect(page.getByTestId("membership-notice")).toContainText("已要求补充，申请人会收到通知");
  await expect(page.getByText("暂无需要审批的成员变动")).toBeVisible();
  expect(decisions).toEqual([{ decision: "approve", expected_version: 0 }, { decision: "needs_info", comment: "请重新指定接手人", expected_version: 0 }]);
});
