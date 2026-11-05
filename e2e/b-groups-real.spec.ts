import { expect, test, type Route } from "@playwright/test";

// B-2 pages 33/34/36 in bworkspace=real mode against a scripted API.
const me = "c-url-fixture"; // user id from the loopback session fixture
const course = "00000000-0000-0000-0000-0000000000a1";
const group = "00000000-0000-0000-0000-0000000000b2";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string) => route.fulfill({ status, json: { error: { code, message: code }, meta } });
const person = (id: string, name: string) => ({ id, name });

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: group, course_id: course, name: "星火组", direction: "校园服务", leader: person(me, "我"), member_count: 2, max_group_size: 4,
  is_mine: true, full: false, lock_version: 0, formation_open: true, project_id: null, invitations: [], leader_change: null,
  members: [{ ...person(me, "我"), role: "leader", joined_at: "2026-11-01T00:00:00Z" }, { ...person("u2", "李同学"), role: "member", joined_at: "2026-11-02T00:00:00Z" }],
  ...overrides,
});

test("B2-01 建组失败时保留表单，成功后进入小组详情且创建人是组长", async ({ page }) => {
  let attempts = 0;
  await page.route(`**/api/v1/courses/${course}/groups`, (route) => {
    if (route.request().method() === "GET") return ok(route, { items: [], my_group_id: null, formation_open: true, formation_deadline: "2026-12-01T00:00:00Z" });
    attempts += 1;
    return attempts === 1 ? fail(route, 409, "GROUP_NAME_TAKEN") : ok(route, detail({ members: [{ ...person(me, "我"), role: "leader", joined_at: "2026-11-05T00:00:00Z" }], member_count: 1 }), 201);
  });
  await page.route("**/api/v1/me/group-invitations", (route) => ok(route, []));
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, detail({ members: [{ ...person(me, "我"), role: "leader", joined_at: "2026-11-05T00:00:00Z" }], member_count: 1 })));
  await page.route(`**/api/v1/courses/${course}/ungrouped-students**`, (route) => ok(route, []));
  await page.goto(`/courses/${course}/groups`);
  await page.getByRole("button", { name: "创建小组" }).click();
  await page.getByLabel("小组名称").fill("星火组");
  await page.getByLabel("项目方向（可选）").fill("校园服务");
  await page.getByRole("button", { name: "创建小组" }).last().click();
  await expect(page.getByText("本课程已有同名小组，请换一个名称。")).toBeVisible();
  await expect(page.getByLabel("小组名称")).toHaveValue("星火组");
  await expect(page.getByLabel("项目方向（可选）")).toHaveValue("校园服务");
  await page.getByRole("button", { name: "创建小组" }).last().click();
  await expect(page).toHaveURL(new RegExp(`/courses/${course}/groups/${group}$`));
  await expect(page.getByRole("heading", { name: "星火组" })).toBeVisible();
  await expect(page.locator("main").getByRole("listitem").filter({ hasText: "我" }).getByText("组长", { exact: true })).toBeVisible();
});

test("B2-02 加入被拒时显示具体原因；已满的小组加入按钮不可点", async ({ page }) => {
  const groups = [
    { id: group, course_id: course, name: "满员组", direction: null, leader: person("u9", "王同学"), member_count: 4, max_group_size: 4, is_mine: false, full: true, lock_version: 0 },
    { id: "00000000-0000-0000-0000-0000000000b3", course_id: course, name: "开放组", direction: null, leader: person("u8", "赵同学"), member_count: 1, max_group_size: 4, is_mine: false, full: false, lock_version: 0 },
  ];
  await page.route(`**/api/v1/courses/${course}/groups`, (route) => ok(route, { items: groups, my_group_id: null, formation_open: true, formation_deadline: "2026-12-01T00:00:00Z" }));
  await page.route("**/api/v1/me/group-invitations", (route) => ok(route, []));
  await page.route("**/api/v1/groups/*/join", (route) => fail(route, 409, "FORMATION_CLOSED"));
  await page.goto(`/courses/${course}/groups`);
  const joinButtons = page.getByRole("button", { name: "加入", exact: true });
  await expect(joinButtons.first()).toBeDisabled();
  await joinButtons.nth(1).click();
  await expect(page.getByText("组队已截止或名单已冻结。")).toBeVisible();
});

test("B2-03 截止后邀请提示需要老师批准", async ({ page }) => {
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, detail({ formation_open: false })));
  await page.route(`**/api/v1/courses/${course}/ungrouped-students**`, (route) => ok(route, [{ id: "u5", name: "周同学", student_number: "2205" }]));
  await page.route(`**/api/v1/groups/${group}/invitations`, (route) => ok(route, { id: "i1", group_id: group, group_name: "星火组", course_id: course, inviter: person(me, "我"), invitee: person("u5", "周同学"), status: "awaiting_teacher", created_at: "2026-11-05T00:00:00Z", decided_at: null, decision_reason: null, lock_version: 0 }, 201));
  await page.goto(`/courses/${course}/groups/${group}`);
  await expect(page.getByText("组队已截止，邀请需要老师批准后才生效。")).toBeVisible();
  await page.getByRole("button", { name: "邀请" }).click();
  await expect(page.getByText("组队已截止，邀请 周同学 需要老师批准，已提交给老师")).toBeVisible();
});

test("B2-05 发起组长变更需要选人并写原因；待确认的组员看到同意/不同意", async ({ page }) => {
  let state: "none" | "pending" = "none";
  const change = { id: "lc1", group_id: group, requested_by: person("u2", "李同学"), previous_leader: person(me, "我"), candidate: person("u2", "李同学"), reason: "时间冲突", status: "pending", created_at: "2026-11-05T00:00:00Z", completed_at: null, confirmations: {}, waiting_for: [person(me, "我")] };
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, detail({ leader_change: state === "pending" ? change : null })));
  await page.route(`**/api/v1/groups/${group}/leader-changes`, (route) => { state = "pending"; return ok(route, change, 201); });
  const decisions: unknown[] = [];
  await page.route("**/api/v1/leader-changes/lc1/confirmations", (route) => { decisions.push(route.request().postDataJSON()); return ok(route, { ...change, status: "approved", waiting_for: [] }); });
  await page.goto(`/courses/${course}/groups/${group}/change-leader`);
  const submit = page.getByRole("button", { name: "发起，请组员确认" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("新组长").selectOption("u2");
  await expect(submit).toBeDisabled();
  await page.getByLabel("原因（必填）").fill("时间冲突");
  await submit.click();
  await expect(page.getByText("还需确认：我")).toBeVisible();
  await page.getByRole("button", { name: "同意", exact: true }).click();
  await expect(page.getByText("所有组员已确认，组长已更换")).toBeVisible();
  expect(decisions).toEqual([{ decision: "confirm" }]);
});
