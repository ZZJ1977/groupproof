import { expect, test, type Route } from "@playwright/test";

// B-5 page 09 in bworkspace=real mode against a scripted API.
const project = "00000000-0000-0000-0000-0000000000c3";
const meta = { request_id: "b-e2e" };
const ok = (route: Route, data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
const base = `**/api/v1/projects/${project}`;
const modules = [{ id: "m1", name: "登录" }, { id: "m2", name: "商城" }];
const item = (id: string, code: string, title: string, module = modules[0]) => ({ id, code, title, module, origin: "manual", status: "confirmed", priority: "medium", excluded: false, version_no: 1, task_count: 1, updated_at: "2026-11-05T00:00:00Z" });
const requirement = { id: "q1", code: "R-001", module_id: "m1", title: "用户可以登录", description: null, priority: "high", status: "confirmed", origin: "manual", edited_by_human: true, excluded: false, sources: [], lock_version: 1 };

test("B4-01 筛选写进 URL 并随请求发送，刷新后保持", async ({ page }) => {
  const seen: URLSearchParams[] = [];
  await page.route(`${base}/requirements?**`, (route) => {
    const url = new URL(route.request().url());
    seen.push(url.searchParams);
    const items = url.searchParams.get("module") === "m2" ? [item("q3", "R-003", "发布商品", modules[1])] : [item("q1", "R-001", "用户可以登录"), item("q3", "R-003", "发布商品", modules[1])];
    return ok(route, { items, total: items.length, page: 1, page_size: 20, modules });
  });
  await page.goto(`/projects/${project}/requirements`);
  await expect(page.getByText("共 2 条")).toBeVisible();
  await page.getByLabel("模块").selectOption("m2");
  await page.getByLabel("名称或说明").fill("商品");
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page).toHaveURL(/module=m2/);
  await expect(page).toHaveURL(/q=%E5%95%86%E5%93%81/);
  await expect(page.getByText("共 1 条")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("模块")).toHaveValue("m2");
  await expect(page.getByLabel("名称或说明")).toHaveValue("商品");
  const last = seen.at(-1)!;
  expect(last.get("module")).toBe("m2");
  expect(last.get("q")).toBe("商品");
});

test("B4-02 冻结后修改要写原因；保存前列出受影响的任务", async ({ page }) => {
  const saves: unknown[] = [];
  await page.route(`${base}/requirements?**`, (route) => ok(route, { items: [item("q1", "R-001", "用户可以登录")], total: 1, page: 1, page_size: 20, modules }));
  await page.route(`${base}/requirements/q1`, (route) => {
    if (route.request().method() === "PATCH") { saves.push(route.request().postDataJSON()); return ok(route, { ...requirement, lock_version: 2 }); }
    return ok(route, { requirement, module: modules[0], version_no: 1, baseline_frozen: true, can_edit: true, reason_required: true });
  });
  await page.route(`${base}/requirements/q1/impact-preview`, (route) => ok(route, { requirement_id: "q1", criteria_count: 2, tasks: [{ id: "t1", title: "实现登录页", status: "in_progress", href: `/projects/${project}/tasks/t1`, criteria: [{ id: "c1", key: "AC-1", text: "能登录", needs_recheck: false }, { id: "c2", key: "AC-2", text: "错误提示", needs_recheck: false }] }] }));
  await page.goto(`/projects/${project}/requirements?req=q1`);
  await page.getByRole("button", { name: "提出修改" }).click();
  await expect(page.getByTestId("b-impact")).toContainText("实现登录页（2 条验收标准将标记“需要重新检查”）");
  await page.getByLabel("需求标题").fill("用户可以用验证码登录");
  const save = page.getByRole("button", { name: "保存为新版本" });
  await expect(save).toBeDisabled();
  await page.getByLabel("修改原因（必填）").fill("老师要求加验证码");
  await save.click();
  await expect(page.getByText("已保存为新版本，2 条验收标准已标记“需要重新检查”")).toBeVisible();
  expect(saves).toEqual([{ module_id: "m1", title: "用户可以用验证码登录", priority: "high", reason: "老师要求加验证码", expected_version: 1 }]);
});

test("B4-03 证据链逐层可点；验收结果未接入时显示暂不可用；两个版本对比高亮差异", async ({ page }) => {
  await page.route(`${base}/requirements?**`, (route) => ok(route, { items: [item("q1", "R-001", "用户可以登录")], total: 1, page: 1, page_size: 20, modules }));
  await page.route(`${base}/requirements/q1`, (route) => ok(route, { requirement, module: modules[0], version_no: 2, baseline_frozen: true, can_edit: true, reason_required: true }));
  await page.route(`${base}/requirements/q1/trace`, (route) => ok(route, {
    requirement, module: modules[0], module_href: `/projects/${project}/requirements?module=m1`, evidence_status: "available", evidence_reason: null, verification_status: "unavailable",
    tasks: [{ id: "t1", title: "实现登录页", status: "in_progress", href: `/projects/${project}/tasks/t1`, verification: { status: "unavailable", state: null, href: `/projects/${project}/tasks/t1/verification` },
      criteria: [{ id: "c1", key: "AC-1", text: "能登录", needs_recheck: true, evidence: [{ id: "e1", title: "登录截图", status: "formal", href: `/projects/${project}/evidence?evidence=e1` }] }] }],
  }));
  await page.route(`${base}/requirements/q1/versions**`, (route) => {
    const url = new URL(route.request().url());
    const versions = [
      { version_no: 1, snapshot: { title: "用户可以登录" }, reason: null, after_freeze: false, created_by: null, created_at: "2026-11-01T00:00:00Z" },
      { version_no: 2, snapshot: { title: "用户可以用验证码登录" }, reason: "老师要求", after_freeze: true, created_by: null, created_at: "2026-11-05T00:00:00Z" },
    ];
    const compare = url.searchParams.get("from") ? { from: 1, to: 2, changes: [{ field: "title", label: "标题", before: "用户可以登录", after: "用户可以用验证码登录" }] } : null;
    return ok(route, { requirement_id: "q1", versions, compare });
  });
  await page.goto(`/projects/${project}/requirements?req=q1&tab=trace`);
  const trace = page.getByTestId("b-trace");
  await expect(trace.getByRole("link", { name: "登录", exact: true })).toHaveAttribute("href", `/projects/${project}/requirements?module=m1`);
  await expect(trace.getByRole("link", { name: "实现登录页" })).toHaveAttribute("href", `/projects/${project}/tasks/t1`);
  await expect(trace.getByRole("link", { name: "登录截图" })).toHaveAttribute("href", `/projects/${project}/evidence?evidence=e1`);
  await expect(trace.getByText("需要重新检查")).toBeVisible();
  await expect(trace.getByText("暂不可用（验收服务未接入）")).toBeVisible();
  await page.getByRole("tab", { name: "修改记录" }).click();
  await page.getByLabel(/^v1/).check();
  await page.getByLabel(/^v2/).check();
  const diff = page.getByTestId("b-version-diff");
  await expect(diff.locator("del")).toHaveText("用户可以登录");
  await expect(diff.locator("ins")).toHaveText("用户可以用验证码登录");
});
