import { expect, test, type Route } from "@playwright/test";

// B-3 pages 35/07/08 in bworkspace=real mode against a scripted API.
const me = "c-url-fixture"; // user id from the loopback session fixture
const course = "00000000-0000-0000-0000-0000000000a1";
const group = "00000000-0000-0000-0000-0000000000b2";
const project = "00000000-0000-0000-0000-0000000000c3";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const fail = (route: Route, status: number, code: string, details: Record<string, unknown> = {}) =>
  route.fulfill({ status, json: { error: { code, message: code, details }, meta } });
const person = (id: string, name: string) => ({ id, name });

const groupDetail = {
  id: group, course_id: course, name: "星火组", direction: null, leader: person(me, "我"), member_count: 2, max_group_size: 4,
  is_mine: true, full: false, lock_version: 0, formation_open: true, project_id: null, invitations: [], leader_change: null,
  members: [{ ...person(me, "我"), role: "leader", joined_at: "2026-11-01T00:00:00Z" }],
};

const overview = (overrides: Record<string, unknown> = {}) => ({
  id: project, name: "校园二手平台", description: "简介", course_id: course, group_id: group, setup_status: "draft", setup_step: 1,
  lifecycle: "active", entry: "setup", can_edit: true, is_leader: true, final_deadline: "2027-01-10T15:59:59Z",
  stats: { task_count: 2, completed_count: 1, progress: 50, progress_status: "available", member_count: 2, milestone_count: 1 },
  next_milestone: { id: "m1", title: "开题", deadline: "2026-11-20T00:00:00Z", status: "not_started" },
  members: [person(me, "我"), person("u2", "李同学")], lock_version: 3, ...overrides,
});

test("B3-01 向导每步存到服务端，刷新后停在原步骤；创建后跳到初始化页", async ({ page }) => {
  let draft = { group_id: group, payload: {}, step: 0, lock_version: 0, updated_at: null, project_id: null as string | null };
  const created: unknown[] = [];
  await page.route(`**/api/v1/courses/${course}/groups`, (route) => ok(route, { items: [], my_group_id: group, formation_open: true, formation_deadline: null }));
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, groupDetail));
  await page.route(`**/api/v1/groups/${group}/project-draft`, (route) => {
    if (route.request().method() === "GET") return ok(route, draft);
    const body = route.request().postDataJSON();
    draft = { ...draft, payload: body.payload, step: body.step, lock_version: draft.lock_version + 1 };
    return ok(route, draft);
  });
  await page.route(`**/api/v1/groups/${group}/projects`, (route) => { created.push(route.request().postDataJSON()); return ok(route, { project_id: project, href: `/projects/${project}/setup` }, 201); });
  await page.route(`**/api/v1/projects/${project}/setup`, (route) => ok(route, { project_id: project, name: "校园二手平台", project_type: "软件开发", description: null, start_date: null, end_date: null, course_deadline: "2027-01-10", setup_status: "draft", setup_step: 1, can_edit: true, materials: [], lock_version: 0 }));

  await page.goto(`/courses/${course}/projects/new`);
  await page.getByLabel("项目名称").fill("校园二手平台");
  await page.getByLabel("项目类型（可选）").fill("软件开发");
  await page.getByRole("button", { name: "保存并下一步" }).click();
  await expect(page.getByLabel("项目简介（可选）")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("项目简介（可选）")).toBeVisible();
  await page.getByRole("button", { name: "上一步" }).click();
  await expect(page.getByLabel("项目名称")).toHaveValue("校园二手平台");
  await page.getByRole("button", { name: "保存并下一步" }).click();
  await page.getByRole("button", { name: "保存并下一步" }).click();
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/setup$`));
  expect(created).toEqual([{ name: "校园二手平台", project_type: "软件开发" }]);
});

test("B3-01 本组已有项目时不再显示创建表单", async ({ page }) => {
  await page.route(`**/api/v1/courses/${course}/groups`, (route) => ok(route, { items: [], my_group_id: group, formation_open: true, formation_deadline: null }));
  await page.route(`**/api/v1/groups/${group}`, (route) => ok(route, { ...groupDetail, project_id: project }));
  await page.route(`**/api/v1/groups/${group}/project-draft`, (route) => ok(route, { group_id: group, payload: {}, step: 0, lock_version: 0, updated_at: null, project_id: project }));
  await page.goto(`/courses/${course}/projects/new`);
  await expect(page.getByText("本组已经创建了项目")).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "进入项目" })).toHaveAttribute("href", `/projects/${project}`);
});

for (const [entry, extra, action, href] of [
  ["setup", {}, "去初始化", `/projects/${project}/setup`],
  ["baseline", { setup_status: "frozen" }, "查看基线", `/projects/${project}/requirements`],
  ["readonly", { lifecycle: "archived", can_edit: false }, "查看项目", `/projects/${project}/setup`],
] as const) {
  test(`B3-02 总览按状态分流：${entry}`, async ({ page }) => {
    await page.route(`**/api/v1/projects/${project}/overview`, (route) => ok(route, overview({ entry, ...extra })));
    await page.goto(`/projects/${project}`);
    await expect(page.locator("main").getByRole("link", { name: action })).toHaveAttribute("href", href);
    await expect(page.locator("main")).toContainText("50%");
    if (entry === "readonly") {
      await expect(page.getByText("已归档 · 只读")).toBeVisible();
      await expect(page.getByText("你可以查看，但不能修改这个项目。")).toBeVisible();
    }
  });
}

test("B3-03 结束日期被拒时标出字段；保存成功进入资料步骤", async ({ page }) => {
  let saves = 0;
  const setup = { project_id: project, name: "校园二手平台", project_type: null, description: null, start_date: "2026-11-05", end_date: "2027-01-10", course_deadline: "2027-01-10", setup_status: "draft", setup_step: 1, can_edit: true, materials: [], lock_version: 0 };
  await page.route(`**/api/v1/projects/${project}/setup`, (route) => ok(route, setup));
  await page.route(`**/api/v1/projects/${project}/setup/basic`, (route) => {
    saves += 1;
    return saves === 1 ? fail(route, 422, "END_AFTER_COURSE_DEADLINE", { field: "end_date" }) : ok(route, { ...setup, setup_step: 2, lock_version: 1 });
  });
  await page.goto(`/projects/${project}/setup`);
  await page.getByLabel("结束日期").fill("2027-02-01");
  await page.getByRole("button", { name: "保存并下一步" }).click();
  await expect(page.getByText("结束日期不能晚于课程截止日期。")).toBeVisible();
  await expect(page.getByLabel("结束日期")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("结束日期").fill("2027-01-05");
  await page.getByRole("button", { name: "保存并下一步" }).click();
  await expect(page.getByRole("heading", { name: "添加文本资料" })).toBeVisible();
});

test("B3-04 文本资料显示全文；文件资料如实显示正文不可用", async ({ page }) => {
  const text = "课程要求\n第二段内容";
  const materials = [
    { id: "mt1", kind: "text", title: "课程要求", extract_status: "ready", extract_reason: null, text_length: text.length, text: null, created_by: person(me, "我"), created_at: "2026-11-05T00:00:00Z" },
    { id: "mt2", kind: "file", title: "需求说明.pdf", extract_status: "unavailable", extract_reason: "正文提取服务尚未接入。", text_length: 0, text: null, created_by: person(me, "我"), created_at: "2026-11-05T00:00:00Z" },
  ];
  await page.route(`**/api/v1/projects/${project}/setup`, (route) => ok(route, { project_id: project, name: "校园二手平台", project_type: null, description: null, start_date: "2026-11-05", end_date: "2027-01-10", course_deadline: "2027-01-10", setup_status: "draft", setup_step: 2, can_edit: true, materials, lock_version: 1 }));
  await page.route(`**/api/v1/projects/${project}/materials/mt1`, (route) => ok(route, { ...materials[0], text }));
  await page.goto(`/projects/${project}/setup`);
  await expect(page.getByText("需求说明.pdf")).toBeVisible();
  await expect(page.getByText("正文暂不可用", { exact: true })).toBeVisible();
  await expect(page.getByText("正文提取服务尚未接入。")).toBeVisible();
  await page.getByRole("button", { name: /查看正文/ }).click();
  await expect(page.getByTestId("b-material-text")).toHaveText(text);
});
