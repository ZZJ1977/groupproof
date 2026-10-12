import { expect, test, type Page } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

type Schema = components["schemas"];
const teacherId = "00000000-0000-0000-0000-000000000701";
const courseId = "00000000-0000-0000-0000-000000000702";
const requestId = "00000000-0000-0000-0000-000000000703";
const projectId = "00000000-0000-0000-0000-000000000704";
const applicantId = "00000000-0000-0000-0000-000000000705";
const logId = "00000000-0000-0000-0000-000000000706";
const teacher: Schema["AdminUserDTO"] = { id: teacherId, name: "服务端教师", email: "teacher@example.edu", email_verified: true, global_role: "teacher", status: "active", username: "teacher", student_id: null, college: "软件学院" };
const course: Schema["CourseDetailDTO"] = { id: courseId, code: "CANONICAL101", name: "服务器课程", college: "软件学院", semester: "2027春", owner_id: teacherId, status: "draft", grouping_mode: "free", min_group_size: 2, max_group_size: 6, formation_deadline: "2027-01-01T00:00:00Z", project_deadline: "2027-06-01T00:00:00Z", lock_version: 0, invite_code: null, invite_revoked_at: null, history: [] };
const access: Schema["AccessRequestDetailDTO"] = { id: requestId, applicant_id: applicantId, reason: "核对范围内的任务实现", scope: { project_id: projectId, resource_type: "project", resource_id: projectId, operation: "read" }, status: "pending", lock_version: 0, requested_expires_at: "2027-12-01T00:00:00Z", approved_expires_at: null, approval_expired: false, authorization_receipt: null, authorization_state: "not_activated", history: [], created_at: "2026-10-12T00:00:00Z" };
const audit: Schema["AuditRecord"] = { id: logId, actor_id: teacherId, actor_role: "teacher", action: "course.publish", result: "success", occurred_at: "2026-10-12T00:00:00Z", target_type: "course", target_id: courseId, reason: "可追溯发布理由", before: { status: "draft" }, after: { status: "<img src=x onerror=alert(1)>" } };
const counts = { requests: 3, succeeded: 2, failed: 1, input_tokens: 140, output_tokens: 70, cost_by_currency: { USD: "0.030000", CNY: "0.100000" } };
const usage: Schema["UsageSummaryDTO"] = { ...counts, days: 7, since: "2026-10-06T00:00:00Z", until: "2026-10-12T12:00:00Z", source_snapshot_id: "fixture-real-contract", daily: [{ ...counts, date: "2026-10-12" }], by_feature: [{ ...counts, key: "review" }], by_model: [{ ...counts, key: "fixture-model" }], aggregation_scope: "显式 API 测试样本，不代表生产用量" };
const envelope = (data: unknown) => ({ data, meta: { request_id: "governance-fixture" } });
const failure = (code: string) => ({ error: { code, message: code }, meta: { request_id: "governance-failure" } });
const courseList = /\/api\/v1\/admin\/courses(?:\?.*)?$/;
const accessList = /\/api\/v1\/admin\/access-requests(?:\?.*)?$/;

async function users(page: Page, eligible = true) {
  await page.route(/\/api\/v1\/admin\/users(?:\?.*)?$/, (route) => route.fulfill({ json: envelope({ items: [{ ...teacher, email_verified: eligible }], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/users/${teacherId}`, (route) => route.fulfill({ json: envelope({ ...teacher, email_verified: eligible }) }));
}

test("C7-04 course filters/page survive reload and Back; denied refresh removes records", async ({ page }) => {
  let allowed = true; const queries: URL[] = [];
  await page.route(courseList, (route) => {
    const url = new URL(route.request().url()); queries.push(url);
    return route.fulfill(allowed ? { json: envelope({ items: [course], page: Number(url.searchParams.get("page") ?? 1), page_size: 10, total: 11 }) } : { status: 403, json: failure("ADMIN_REQUIRED") });
  });
  await page.goto("/admin/courses");
  await expect(page.getByText("服务器课程", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByLabel("搜索课程", { exact: true }).fill("CANONICAL");
  await page.getByLabel("筛选学期", { exact: true }).fill("2027春");
  await page.getByRole("combobox", { name: "课程状态", exact: true }).selectOption("draft");
  await page.getByRole("button", { name: "查询课程", exact: true }).click();
  await expect(page).toHaveURL(/status=draft/); await expect(page).not.toHaveURL(/page=2/);
  await page.reload(); await expect(page.getByLabel("搜索课程", { exact: true })).toHaveValue("CANONICAL");
  expect(queries.at(-1)?.searchParams.get("semester")).toBe("2027春");
  await page.getByRole("button", { name: "重置", exact: true }).click(); await page.goBack();
  await expect(page).toHaveURL(/status=draft/);
  allowed = false; await page.getByRole("button", { name: "刷新课程", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("无权");
  await expect(page.getByText("服务器课程", { exact: true })).toHaveCount(0);
});

test("C7-04 create selects a canonical teacher and retries the same command key", async ({ page }) => {
  await users(page); const keys: string[] = []; let row = course;
  await page.route(courseList, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: envelope({ items: [], page: 1, page_size: 10, total: 0 }) });
    const body = route.request().postDataJSON(); keys.push(route.request().headers()["idempotency-key"]);
    expect(body.owner_id).toBe(teacherId); expect(body.reason).toBe("确认课程设置");
    if (keys.length === 1) return route.fulfill({ status: 503, json: failure("TEMPORARILY_UNAVAILABLE") });
    row = { ...course, name: body.name }; return route.fulfill({ status: 201, json: envelope(row) });
  });
  await page.route(`**/api/v1/admin/courses/${courseId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.goto("/admin/courses"); await page.getByRole("button", { name: "新建课程", exact: true }).click();
  await page.getByLabel("课程编号", { exact: true }).fill("CANONICAL101");
  await page.getByLabel("课程名称", { exact: true }).fill("新建服务器课程");
  await page.getByLabel("学院", { exact: true }).fill("软件学院");
  await page.getByLabel("学期", { exact: true }).fill("2027春");
  await page.getByRole("combobox", { name: "负责教师", exact: true }).selectOption(teacherId);
  await page.getByLabel("项目截止时间", { exact: true }).fill("2027-06-01T08:00");
  await page.getByLabel("创建理由", { exact: true }).fill("确认课程设置");
  await page.getByRole("button", { name: "刷新课程", exact: true }).click();
  await expect(page.getByLabel("课程名称", { exact: true })).toHaveValue("新建服务器课程");
  await expect(page.getByLabel("创建理由", { exact: true })).toHaveValue("确认课程设置");
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("服务尚不可用");
  await expect(page.getByLabel("创建理由", { exact: true })).toHaveValue("确认课程设置");
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新建服务器课程", exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
});

test("C7-04 no eligible teacher cannot create a course", async ({ page }) => {
  await users(page, false);
  await page.route(courseList, (route) => route.fulfill({ json: envelope({ items: [], page: 1, page_size: 10, total: 0 }) }));
  await page.goto("/admin/courses?create=1");
  await expect(page.getByText(/当前查询没有可选用户/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "负责教师", exact: true }).locator("option")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "创建草稿", exact: true })).toBeDisabled();
});

test("C7-04 conflict preserves reason; refreshed version publishes once and end revokes invite", async ({ page }) => {
  let row = course; let writes = 0;
  await page.route(courseList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/courses/${courseId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/courses/${courseId}/transitions`, (route) => {
    writes++; const body = route.request().postDataJSON();
    if (writes === 1) { row = { ...row, lock_version: 1 }; return route.fulfill({ status: 409, json: failure("VERSION_CONFLICT") }); }
    expect(body.expected_version).toBe(row.lock_version);
    row = { ...row, status: body.action === "publish" ? "active" : "ended", lock_version: row.lock_version + 1, invite_code: "fixture-unique-invite", invite_revoked_at: body.action === "end" ? "2026-10-12T01:00:00Z" : null };
    return route.fulfill({ json: envelope(row) });
  });
  await page.goto(`/admin/courses?course=${courseId}`);
  await page.getByLabel("变更理由", { exact: true }).fill("发布前已核对设置");
  await page.getByRole("button", { name: "确认发布课程", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("记录已变更");
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("发布前已核对设置");
  await expect(page.getByRole("button", { name: "确认发布课程", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新详情", exact: true }).click();
  await page.getByRole("button", { name: "确认发布课程", exact: true }).click();
  await expect(page.getByText("fixture-unique-invite", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始结束确认", exact: true }).click();
  await page.getByLabel("变更理由", { exact: true }).fill("课程教学工作结束");
  await page.getByRole("button", { name: "确认结束课程", exact: true }).click();
  await expect(page.getByText(/（已撤销）/)).toBeVisible(); expect(writes).toBe(3);
});

test("C7-04 a background course version change requires explicit refresh before publishing", async ({ page }) => {
  let row = course; let writes = 0;
  await page.route(courseList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/courses/${courseId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/courses/${courseId}/transitions`, (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ action: "publish", expected_version: 1, reason: "已核对发布设置" });
    row = { ...row, status: "active", lock_version: 2, invite_code: "published-after-review" };
    return route.fulfill({ json: envelope(row) });
  });
  await page.goto(`/admin/courses?course=${courseId}`);
  await page.getByLabel("变更理由", { exact: true }).fill("已核对发布设置");
  row = { ...course, lock_version: 1 };
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByText("课程状态或版本已变化，当前操作已暂停。请刷新详情并核对；填写的理由已保留。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认发布课程", exact: true })).toBeDisabled();
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("已核对发布设置");
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "刷新详情", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认发布课程", exact: true })).toBeEnabled();
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("已核对发布设置");
  await page.getByRole("button", { name: "确认发布课程", exact: true }).click();
  await expect(page.getByText("published-after-review", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("C7-04 another administrator publishing cannot turn the old publish reason into an end command", async ({ page }) => {
  let row = course; let writes = 0;
  await page.route(courseList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/courses/${courseId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/courses/${courseId}/transitions`, (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ action: "end", expected_version: 1, reason: "重新核对后确认结束教学" });
    row = { ...row, status: "ended", lock_version: 2, invite_revoked_at: "2026-10-12T01:00:00Z" };
    return route.fulfill({ json: envelope(row) });
  });
  await page.goto(`/admin/courses?course=${courseId}`);
  await page.getByLabel("变更理由", { exact: true }).fill("旧的发布理由不能结束课程");
  row = { ...course, status: "active", lock_version: 1, invite_code: "published-by-other-admin" };
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByText("published-by-other-admin", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认发布课程", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认结束课程", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("旧的发布理由不能结束课程");
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "刷新详情", exact: true }).click();
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "开始结束确认", exact: true }).click();
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "确认结束课程", exact: true })).toBeDisabled();
  await page.getByLabel("变更理由", { exact: true }).fill("重新核对后确认结束教学");
  await page.getByRole("button", { name: "确认结束课程", exact: true }).click();
  await expect(page.getByText(/（已撤销）/)).toBeVisible();
  expect(writes).toBe(1);
});

test("C7-04 a committed publish with a 503 response stays a publish attempt until refreshed", async ({ page }) => {
  let row = course; const actions: string[] = [];
  await page.route(courseList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/courses/${courseId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/courses/${courseId}/transitions`, (route) => {
    const body = route.request().postDataJSON(); actions.push(body.action);
    expect(body).toEqual({ action: "publish", expected_version: 0, reason: "发布设置已核对" });
    row = { ...course, status: "active", lock_version: 1, invite_code: "committed-despite-response-failure" };
    return route.fulfill({ status: 503, json: failure("RESPONSE_UNAVAILABLE") });
  });
  await page.goto(`/admin/courses?course=${courseId}`);
  await page.getByLabel("变更理由", { exact: true }).fill("发布设置已核对");
  await page.getByRole("button", { name: "确认发布课程", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("服务尚不可用");
  await page.evaluate(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  await expect(page.getByText("committed-despite-response-failure", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认发布课程", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认结束课程", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("发布设置已核对");
  await page.getByRole("button", { name: "刷新详情", exact: true }).click();
  await expect(page.getByText("课程已经发布，原发布确认已关闭。若需结束课程，请开始新的结束确认。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认结束课程", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "开始结束确认", exact: true }).click();
  await expect(page.getByLabel("变更理由", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "确认结束课程", exact: true })).toBeDisabled();
  expect(actions).toEqual(["publish"]);
});

test("C7-07 unavailable activation retains pending and reason; retry preserves exact scope/key", async ({ page }) => {
  let row = access; const keys: string[] = [];
  await page.route(accessList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}/decisions`, (route) => {
    const body = route.request().postDataJSON(); keys.push(route.request().headers()["idempotency-key"]);
    expect(body).toEqual({ decision: "approved", reason: "核对只读范围和时限", expected_version: 0, expires_at: access.requested_expires_at.replace("Z", ".000Z") });
    if (keys.length === 1) return route.fulfill({ status: 503, json: failure("ACCESS_AUTHORIZATION_UNAVAILABLE") });
    row = { ...row, status: "approved", lock_version: 1, approved_expires_at: body.expires_at, authorization_receipt: { grant_id: "fixture-grant" }, authorization_state: "receipt_recorded_current_access_not_checked" };
    return route.fulfill({ json: envelope(row) });
  });
  await page.goto(`/admin/access-requests?request=${requestId}&status=pending`);
  await page.getByLabel("审批理由", { exact: true }).fill("核对只读范围和时限");
  await page.getByRole("button", { name: "确认审批决定", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("服务尚不可用");
  await expect(page.getByText(/状态：待审批/)).toBeVisible();
  await expect(page.getByLabel("审批理由", { exact: true })).toHaveValue("核对只读范围和时限");
  await page.getByRole("button", { name: "确认审批决定", exact: true }).click();
  await expect(page.getByText(/实际访问还需通过权限检查/)).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
});

test("C7-07 conflict requires a fresh version before rejection and preserves the draft", async ({ page }) => {
  let row = access; let writes = 0;
  await page.route(accessList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}/decisions`, (route) => {
    writes++; if (writes === 1) { row = { ...row, lock_version: 2 }; return route.fulfill({ status: 409, json: failure("VERSION_CONFLICT") }); }
    expect(route.request().postDataJSON()).toEqual({ decision: "rejected", expected_version: 2, reason: "申请范围不必要", expires_at: null });
    row = { ...row, status: "rejected", lock_version: 3 }; return route.fulfill({ json: envelope(row) });
  });
  await page.goto(`/admin/access-requests?request=${requestId}`);
  await page.getByRole("combobox", { name: "审批决定", exact: true }).selectOption("rejected");
  await page.getByLabel("审批理由", { exact: true }).fill("申请范围不必要");
  await page.getByRole("button", { name: "确认审批决定", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认审批决定", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新详情", exact: true }).click();
  await expect(page.getByLabel("审批理由", { exact: true })).toHaveValue("申请范围不必要");
  await page.getByRole("button", { name: "确认审批决定", exact: true }).click();
  await expect(page.getByText(/状态：已拒绝/)).toBeVisible(); expect(writes).toBe(2);
});

test("C7-07 an expired pending request cannot be approved but can be rejected with a reason", async ({ page }) => {
  let row: Schema["AccessRequestDetailDTO"] = { ...access, requested_expires_at: "2000-01-01T00:00:00Z" };
  let writes = 0;
  await page.route(accessList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}`, (route) => route.fulfill({ json: envelope(row) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}/decisions`, (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ decision: "rejected", expected_version: 0, reason: "原申请期限已过，请重新申请", expires_at: null });
    row = { ...row, status: "rejected", lock_version: 1 };
    return route.fulfill({ json: envelope(row) });
  });
  await page.goto(`/admin/access-requests?request=${requestId}`);
  await expect(page.getByText("申请期限已过，无法批准；可填写理由拒绝此申请。", { exact: true })).toBeVisible();
  await page.getByLabel("审批理由", { exact: true }).fill("原申请期限已过，请重新申请");
  await expect(page.getByRole("button", { name: "确认审批决定", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "审批决定", exact: true }).locator('option[value="approved"]')).toBeDisabled();
  await expect(page.getByLabel("批准截止时间", { exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  await page.getByRole("combobox", { name: "审批决定", exact: true }).selectOption("rejected");
  await page.getByLabel("审批理由", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "确认审批决定", exact: true })).toBeDisabled();
  await page.getByLabel("审批理由", { exact: true }).fill("原申请期限已过，请重新申请");
  await page.getByRole("button", { name: "确认审批决定", exact: true }).click();
  await expect(page.getByText(/状态：已拒绝/)).toBeVisible();
  expect(writes).toBe(1);
});

test("C7-07 an open approval form expires without discarding its reason", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-12T00:00:00Z") });
  const row = { ...access, requested_expires_at: "2026-10-12T00:01:00Z" };
  await page.route(accessList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
  await page.route(`**/api/v1/admin/access-requests/${requestId}`, (route) => route.fulfill({ json: envelope(row) }));
  let writes = 0;
  await page.route(`**/api/v1/admin/access-requests/${requestId}/decisions`, (route) => { writes++; return route.fulfill({ status: 422, json: failure("ACCESS_EXPIRY_INVALID") }); });
  await page.goto(`/admin/access-requests?request=${requestId}`);
  await page.getByLabel("审批理由", { exact: true }).fill("正在核对申请范围");
  await expect(page.getByRole("button", { name: "确认审批决定", exact: true })).toBeEnabled();
  await page.clock.fastForward(60_001);
  await expect(page.getByText("申请期限已过，无法批准；可填写理由拒绝此申请。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认审批决定", exact: true })).toBeDisabled();
  await expect(page.getByLabel("审批理由", { exact: true })).toHaveValue("正在核对申请范围");
  expect(writes).toBe(0);
});

test("C7-05 audit filters and pagination use canonical users, and detail renders metadata as text", async ({ page }) => {
  await users(page); const requests: URL[] = [];
  await page.route(/\/api\/v1\/admin\/audit-logs(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    return route.fulfill({ json: envelope({ items: [audit], page: Number(url.searchParams.get("page") ?? 1), page_size: 10, total: 11 }) });
  });
  await page.route(`**/api/v1/admin/audit-logs/${logId}`, (route) => route.fulfill({ json: envelope(audit) }));
  await page.goto("/admin/logs");
  await page.getByRole("combobox", { name: "操作人", exact: true }).selectOption(teacherId);
  await page.getByRole("combobox", { name: "操作时角色", exact: true }).selectOption("teacher");
  await page.getByRole("combobox", { name: "对象类型", exact: true }).selectOption("course");
  await page.getByLabel("操作类型", { exact: true }).fill("course.publish");
  await page.getByRole("combobox", { name: "操作结果", exact: true }).selectOption("success");
  await page.getByRole("button", { name: "查询日志", exact: true }).click();
  await page.getByRole("button", { name: "筛选此对象", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.reload(); await expect(page).toHaveURL(/page=2/);
  await expect(page.getByLabel("操作类型", { exact: true })).toHaveValue("course.publish");
  expect(requests.at(-1)?.searchParams.get("actor_id")).toBe(teacherId);
  expect(requests.at(-1)?.searchParams.get("actor_role")).toBe("teacher");
  expect(requests.at(-1)?.searchParams.get("target_type")).toBe("course");
  expect(requests.at(-1)?.searchParams.get("target_id")).toBe(courseId);
  await page.getByRole("button", { name: "查看日志", exact: true }).click();
  await expect(page.locator("pre").filter({ hasText: "<img src=x onerror=alert(1)>" })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test("C7-06 true sample totals preserve currencies and URL period; 503 hides the old totals", async ({ page }) => {
  await users(page); let available = true; const queries: URL[] = [];
  await page.route("**/api/v1/admin/ai-usage**", (route) => {
    const url = new URL(route.request().url()); queries.push(url);
    return route.fulfill(available ? { json: envelope({ ...usage, days: Number(url.searchParams.get("days") ?? 7) }) } : { status: 503, json: failure("USAGE_SOURCE_UNAVAILABLE") });
  });
  await page.goto("/admin/ai-usage");
  await expect(page.getByText("请求总数：3 · 成功：2 · 失败：1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "最近 30 天", exact: true }).click();
  await page.getByLabel("功能", { exact: true }).fill("review");
  await page.getByRole("button", { name: "查询用量", exact: true }).click();
  await page.reload(); await expect(page.getByRole("button", { name: "最近 30 天", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(queries.at(-1)?.searchParams.get("feature")).toBe("review");
  await expect(page.getByText("费用：USD 0.030000 / CNY 0.100000", { exact: true })).toBeVisible();
  available = false; await page.getByRole("button", { name: "刷新用量", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("服务尚不可用");
  await expect(page.getByText("请求总数：3 · 成功：2 · 失败：1", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "用量汇总", exact: true })).toHaveCount(0);
  available = true; await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("heading", { name: "用量汇总", exact: true })).toBeVisible();
});

for (const target of ["course", "access"] as const) {
  test(`C7 ${target} write permission loss clears records and drafts until fresh authorization`, async ({ page }) => {
    const isCourse = target === "course";
    const row = isCourse ? { ...course, status: "active", invite_code: "sensitive-course-invite" } : access;
    const base = isCourse ? "/api/v1/admin/courses" : "/api/v1/admin/access-requests";
    const id = isCourse ? courseId : requestId;
    await page.route(isCourse ? courseList : accessList, (route) => route.fulfill({ json: envelope({ items: [row], page: 1, page_size: 10, total: 1 }) }));
    await page.route(`**${base}/${id}`, (route) => route.fulfill({ json: envelope(row) }));
    await page.route(`**${base}/${id}/${isCourse ? "transitions" : "decisions"}`, (route) => route.fulfill({ status: 403, json: failure("ADMIN_REQUIRED") }));
    await page.goto(isCourse ? `/admin/courses?course=${id}` : `/admin/access-requests?request=${id}`);
    const label = isCourse ? "变更理由" : "审批理由";
    await page.getByLabel(label, { exact: true }).fill("尚未提交的敏感理由");
    await page.getByRole("button", { name: isCourse ? "确认结束课程" : "确认审批决定", exact: true }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("无权");
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
    await expect(page.getByText(isCourse ? "sensitive-course-invite" : access.reason, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  });
}

test("C7 user lookup permission loss hides a previously selected name and email", async ({ page }) => {
  let allowed = true;
  await page.route(/\/api\/v1\/admin\/users(?:\?.*)?$/, (route) => route.fulfill(allowed ? { json: envelope({ items: [teacher], total: 1, page: 1, page_size: 10 }) } : { status: 403, json: failure("ADMIN_REQUIRED") }));
  await page.route(`**/api/v1/admin/users/${teacherId}`, (route) => route.fulfill({ json: envelope(teacher) }));
  await page.route(/\/api\/v1\/admin\/audit-logs(?:\?.*)?$/, (route) => route.fulfill({ json: envelope({ items: [], total: 0, page: 1, page_size: 10 }) }));
  await page.goto("/admin/logs");
  const picker = page.getByRole("combobox", { name: "操作人", exact: true });
  await picker.selectOption(teacherId);
  await expect(picker).toHaveValue(teacherId);
  allowed = false; await page.getByLabel("操作人搜索", { exact: true }).fill("重新查询");
  await expect(page.locator("main").getByRole("alert")).toContainText("无权");
  await expect(picker.locator("option")).toHaveCount(1);
  await expect(picker.locator("option")).not.toContainText(teacher.email ?? "");
});
