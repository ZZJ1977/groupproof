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
  for (const path of ["requirements", "planning", "tasks?view=tree", "milestones", "evidence", "github", "collaboration", "files", "discussions", "contribution", "reports", "settings"]) {
    await expect(page.locator(`nav a[href="/projects/${id}/${path}"]`)).toBeVisible();
  }
  expect(attempts).toBe(2);
});
