import { expect, test } from "@playwright/test";
const id = "00000000-0000-0000-0000-0000000000f1";
test("独立项目无需课程；创建失败保留输入，成功后进入项目和完整导航", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/v1/a/projects", route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ name: "我的独立项目", description: "无需课程" });
    attempts++;
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: { code: "UNAVAILABLE", message: "请重试" } } } : { status: 201, json: { data: { project_id: id, kind: "personal" } } });
  });
  await page.route(`**/api/v1/projects/${id}/overview`, route => route.fulfill({ json: { data: {
    id, name: "我的独立项目", course_id: null, group_id: null, setup_status: "draft", setup_step: 1, entry: "setup", lifecycle: "active", can_edit: true,
    stats: { task_count: 0, completed_count: 0, progress_status: "no_weighted_tasks", member_count: 1, milestone_count: 0 }, members: [{ id: "c-url-fixture", name: "我" }],
  } } }));
  await page.goto("/projects/new");
  await expect(page.getByRole("link", { name: "创建课程项目", exact: true })).toHaveAttribute("href", "/courses?intent=create-project");
  await page.getByLabel("项目名称", { exact: true }).fill("我的独立项目");
  await page.getByLabel("项目简介（选填）").fill("无需课程");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("请重试");
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("我的独立项目");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的独立项目", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "完善信息", exact: true })).toHaveAttribute("href", `/projects/${id}/setup#project-details`);
  for (const path of ["requirements", "tasks?view=tree", "milestones", "evidence", "github", "collaboration", "files", "discussions", "contribution"]) {
    await expect(page.locator(`nav a[href="/projects/${id}/${path}"]`)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "项目设置", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "项目报告", exact: true })).toHaveAttribute("href", `/projects/${id}/contribution?tab=report`);
  expect(attempts).toBe(2);
});

test("侧边栏我的项目页分离独立/课程项目，支持弹窗轻量化创建并直达项目", async ({ page }) => {
  const personalId = "00000000-0000-0000-0000-0000000000f2";
  const courseProjectId = "00000000-0000-0000-0000-0000000000f3";
  const courseId = "00000000-0000-0000-0000-0000000000c3";
  const createdId = "00000000-0000-0000-0000-0000000000f4";
  const envelope = (data: unknown) => ({ data, meta: { request_id: "my-projects-fixture" } });

  await page.route("**/api/v1/home/summary", (route) =>
    route.fulfill({
      json: envelope({
        course_count: 1,
        project_count: 2,
        my_task_count: 0,
        my_completed_tasks: 0,
        task_counts: { not_started: 0, in_progress: 0, pending_submission: 0, pending_verification: 0, completed: 0 },
        unread_notifications: 0,
        pending_action_items: 0,
        unavailable_sources: [],
        scope: "Current authenticated user",
        courses: [{ id: courseId, name: "软件工程实践", status: "active", href: `/courses/${courseId}/rules` }],
        projects: [
          { id: personalId, name: "独立探索项目", lifecycle: "active", progress: 40, progress_status: "available", href: `/projects/${personalId}` },
          { id: courseProjectId, name: "课程团队项目", lifecycle: "active", progress: 75, progress_status: "available", href: `/projects/${courseProjectId}` },
        ],
      }),
    }),
  );

  await page.route("**/api/v1/me/courses**", (route) =>
    route.fulfill({
      json: envelope({
        items: [
          {
            id: courseId,
            code: "SE101",
            name: "软件工程实践",
            semester: "2026 秋",
            college: "CS",
            status: "active",
            role: "student",
            joined_at: "2026-09-01T00:00:00Z",
            teacher: { id: "t1", name: "张老师" },
            formation_deadline: null,
            project_deadline: null,
            group: { id: "g1", name: "第一组" },
            project: { id: courseProjectId, name: "课程团队项目" },
            pending_count: 0,
          },
        ],
        total: 1,
        page: 1,
        page_size: 50,
        counts: { all: 1, active: 1, ended: 0 },
        pending_joins: [],
      }),
    }),
  );

  await page.route(`**/api/v1/projects/${personalId}/overview`, (route) =>
    route.fulfill({
      json: envelope({
        id: personalId,
        name: "独立探索项目",
        description: "自研小工具",
        course_id: null,
        group_id: null,
        setup_status: "frozen",
        setup_step: 6,
        entry: "baseline",
        lifecycle: "active",
        can_edit: true,
        is_leader: true,
        final_deadline: null,
        stats: { task_count: 5, completed_count: 2, progress: 40, progress_status: "available", member_count: 2, milestone_count: 1 },
        next_milestone: null,
        members: [{ id: "c-url-fixture", name: "我" }],
        lock_version: 1,
      }),
    }),
  );

  await page.route(`**/api/v1/projects/${courseProjectId}/overview`, (route) =>
    route.fulfill({
      json: envelope({
        id: courseProjectId,
        name: "课程团队项目",
        description: "课程大作业",
        course_id: courseId,
        group_id: "g1",
        setup_status: "frozen",
        setup_step: 6,
        entry: "baseline",
        lifecycle: "active",
        can_edit: true,
        is_leader: true,
        final_deadline: null,
        stats: { task_count: 4, completed_count: 3, progress: 75, progress_status: "available", member_count: 4, milestone_count: 2 },
        next_milestone: null,
        members: [{ id: "c-url-fixture", name: "我" }],
        lock_version: 1,
      }),
    }),
  );

  await page.route(`**/api/v1/projects/${createdId}/overview`, (route) =>
    route.fulfill({
      json: envelope({
        id: createdId,
        name: "弹窗新建项目",
        description: null,
        course_id: null,
        group_id: null,
        setup_status: "draft",
        setup_step: 1,
        entry: "setup",
        lifecycle: "active",
        can_edit: true,
        is_leader: true,
        final_deadline: null,
        stats: { task_count: 0, completed_count: 0, progress: null, progress_status: "no_weighted_tasks", member_count: 1, milestone_count: 0 },
        next_milestone: null,
        members: [{ id: "c-url-fixture", name: "我" }],
        lock_version: 1,
      }),
    }),
  );

  await page.route("**/api/v1/a/projects/**/github/repos", (route) => route.fulfill({ json: envelope([]) }));
  await page.route("**/api/v1/a/projects/**/feishu/chats", (route) => route.fulfill({ json: envelope([]) }));
  await page.route("**/api/v1/a/projects", (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ name: "弹窗新建项目" });
    return route.fulfill({ status: 201, json: envelope({ project_id: createdId, name: "弹窗新建项目", kind: "personal" }) });
  });

  await page.goto("/home");
  const projectsNav = page.locator('nav a[href="/projects"]');
  await expect(projectsNav).toBeVisible();
  await expect(projectsNav).toContainText("我的项目");
  await projectsNav.click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "我的项目", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "独立项目" }).getByText("独立探索项目", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "课程项目" }).getByText("课程团队项目", { exact: true })).toBeVisible();
  await expect(page.getByText("2 位成员", { exact: true })).toBeVisible();
  await expect(page.getByText("4 位成员", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /独立项目/ }).click();
  await expect(page.getByText("独立探索项目", { exact: true })).toBeVisible();
  await expect(page.getByText("课程团队项目", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /课程项目/ }).click();
  await expect(page.getByText("课程团队项目", { exact: true })).toBeVisible();
  await expect(page.getByText("独立探索项目", { exact: true })).toHaveCount(0);

  await page.locator(".gp-page-header").getByRole("button", { name: "创建项目", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("项目名称", { exact: true })).toBeFocused();
  await dialog.getByLabel("项目名称", { exact: true }).fill("弹窗新建项目");
  await dialog.getByLabel("项目名称", { exact: true }).press("Enter");

  await expect(page).toHaveURL(new RegExp(`/projects/${createdId}$`));
  await expect(page.getByRole("heading", { name: "弹窗新建项目", exact: true })).toBeVisible();
});
