import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

// Contract fixtures only: this suite does not claim live A transport/provider access.
type Schema = components["schemas"];
const projectId = "00000000-0000-0000-0000-000000000301";
const taskId = "00000000-0000-0000-0000-000000000302";
const criterionId = "00000000-0000-0000-0000-000000000303";
const actorId = "00000000-0000-0000-0000-000000000304";
const sourceId = "00000000-0000-0000-0000-000000000305";
const fileId = "00000000-0000-0000-0000-000000000306";
const v1Id = "00000000-0000-0000-0000-000000000307";
const v2Id = "00000000-0000-0000-0000-000000000308";
const stamp = "2026-10-12T08:00:00Z";
const base = `/api/v1/projects/${projectId}`;
const context = {
  project: { id: projectId, name: "已授权的真实项目", lifecycle: "active", setup_status: "confirmed" },
  actor: { id: actorId, is_member: true, is_leader: false, is_teacher: false },
  permissions: { can_manage_activity: true, can_manage_files: true, can_discuss: true, can_capture_evidence: true },
  tasks: [{ id: taskId, title: "接口契约任务", status: "in_progress", can_associate: true, can_capture_evidence: true, criteria: [{ id: criterionId, text: "接口成功响应", version: 1 }] }],
  members: [{ id: actorId, title: "项目成员" }], requirements: [], modules: [], milestones: [],
} satisfies Schema["CProjectContextDTO"];
const activity: Schema["ActivityDTO"] = {
  record_id: null, project_id: projectId, group_id: null, source_type: "feishu", source_id: sourceId,
  status: "candidate", task_id: null, evidence_id: null, lock_version: 0,
  title: "接口讨论文档", summary: "来源服务返回的说明", author_id: actorId, author_name: "来源作者",
  occurred_at: stamp, kind: "document", source_identity: "document-1", source_revision: "r1",
  source_url: "https://example.feishu.cn/wiki/verified", availability: "available", source_changed: false, suggested_task_ids: [taskId],
};
const file: Schema["FileDetailDTO"] = {
  id: fileId, project_id: projectId, name: "真实需求说明", category: "documents", latest_version_no: 2,
  official_version_no: 1, lock_version: 2, created_by: actorId, created_at: stamp, updated_at: stamp,
  versions: [
    { id: v1Id, file_id: fileId, version_no: 1, original_name: "需求第一版.pdf", extension: "pdf", mime_type: "application/pdf", size_bytes: 1024, content_hash: "a".repeat(64), uploaded_by: actorId, status: "current", created_at: stamp },
    { id: v2Id, file_id: fileId, version_no: 2, original_name: "需求第二版.pdf", extension: "pdf", mime_type: "application/pdf", size_bytes: 2048, content_hash: "b".repeat(64), uploaded_by: actorId, status: "draft", created_at: stamp },
  ],
  decisions: [{ id: "00000000-0000-0000-0000-000000000309", actor_id: actorId, version_id: v1Id, action: "designated", reason: "保留原始发布记录", resulting_lock_version: 1, previous_official_version_no: null, created_at: stamp }],
};
const success = (route: Route, data: unknown) => route.fulfill({ json: { data, meta: { request_id: "contract-fixture" } } });
const failure = (route: Route, status: number) => route.fulfill({ status, json: { error: { code: status === 409 ? "VERSION_CONFLICT" : "UNAVAILABLE", message: "Fixture failure" }, meta: { request_id: "fixture-failure" } } });
function history(item: Schema["ActivityDTO"]): Schema["ActivityHistoryDTO"] {
  return { record_id: item.record_id, project_id: projectId, source_type: item.source_type, source_id: sourceId, status: item.status, task_id: item.task_id, evidence_id: item.evidence_id, lock_version: item.lock_version, decisions: [] };
}
function fileRows(detail: Schema["FileDetailDTO"]): Schema["FilePageDTO"] {
  return { items: detail.versions.filter((version) => version.status !== "superseded").map((version) => ({ ...version, project_id: projectId, name: detail.name, category: detail.category, lock_version: detail.lock_version })), total: detail.versions.filter((version) => version.status !== "superseded").length, page: 1, page_size: 10 };
}
async function contextRoute(page: Page, value: Schema["CProjectContextDTO"] = context) { await page.route(`**${base}/c-context`, (route) => success(route, value)); }
async function activityRoutes(page: Page, getItem: () => Schema["ActivityDTO"]) {
  const type = getItem().source_type;
  await page.route(`**${base}/activities/${type}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/history")) return success(route, history(getItem()));
    if (path.endsWith(`/${sourceId}`)) return success(route, getItem());
    if (path.endsWith(`/${type}`)) return success(route, { items: [getItem()], total: 1, page: 1, page_size: 10 } satisfies Schema["ActivityPageDTO"]);
    return failure(route, 404);
  });
}

test("C4 URL filters and pagination preserve canonical IDs; GitHub links reject another host", async ({ page }) => {
  await contextRoute(page);
  const requests: URL[] = [];
  const item = { ...activity, source_type: "github" as const, source_url: "https://github.com.evil.example/org/repo", kind: "commit" };
  await activityRoutes(page, () => item);
  await page.route(`**${base}/activities/github?**`, (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    const current = Number(url.searchParams.get("page") ?? 1);
    return success(route, { items: [{ ...item, title: `来源记录第 ${current} 页` }], total: 11, page: current, page_size: 10 });
  });
  await page.goto(`/projects/${projectId}/github`);
  await expect(page.getByText("来源记录第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("来源记录第 2 页", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索记录", exact: true }).fill("接口");
  await page.getByRole("combobox", { name: "记录类型", exact: true }).selectOption({ label: "提交记录" });
  await page.getByRole("combobox", { name: "关联任务", exact: true }).selectOption(taskId);
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-10-12");
  await page.getByRole("button", { name: "查询活动", exact: true }).click();
  await expect(page).toHaveURL(/date_from=2026-10-01/);
  await expect.poll(() => requests.at(-1)?.searchParams.get("until")).toBe("2026-10-12T23:59:59.999999Z");
  expect(requests.at(-1)?.searchParams.get("task_id")).toBe(taskId);
  expect(requests.at(-1)?.searchParams.get("kind")).toBe("commit");
  expect(requests.at(-1)?.searchParams.has("group_id")).toBe(false);
  expect(requests.at(-1)?.searchParams.get("page")).toBe("1");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "搜索记录", exact: true })).toHaveValue("接口");
  await expect(page.getByRole("combobox", { name: "记录类型", exact: true })).toHaveValue("commit");
  await page.getByRole("button", { name: "查看记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "接口讨论文档", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看原始来源", exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/record=/);
});

test("C4 Feishu group and kind filters use authorized page metadata, combine in the URL, and survive navigation", async ({ page }) => {
  await contextRoute(page);
  const groupA = "oc_authorized_group_a";
  const groupB = "oc_authorized/b?key=1&scope=ours";
  const items: Schema["ActivityDTO"][] = Array.from({ length: 12 }, (_, index) => ({
    ...activity, source_id: `00000000-0000-0000-0000-${String(400 + index).padStart(12, "0")}`,
    title: `群记录 ${index + 1}`, group_id: index < 10 ? groupA : groupB,
    kind: index < 10 ? "document" : "message", summary: index < 10 ? "甲组资料" : "乙组讨论",
  }));
  const requests: URL[] = [];
  await page.route(`**${base}/activities/feishu?**`, (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    const filtered = items.filter((item) => (!url.searchParams.get("group_id") || item.group_id === url.searchParams.get("group_id"))
      && (!url.searchParams.get("kind") || item.kind === url.searchParams.get("kind"))
      && (!url.searchParams.get("status") || item.status === url.searchParams.get("status"))
      && (!url.searchParams.get("q") || item.summary.includes(url.searchParams.get("q")!)));
    const current = Number(url.searchParams.get("page") ?? 1);
    return success(route, { items: filtered.slice((current - 1) * 10, current * 10), total: filtered.length, page: current, page_size: 10 } satisfies Schema["ActivityPageDTO"]);
  });
  await page.goto(`/projects/${projectId}/collaboration`);
  const group = page.getByRole("combobox", { name: "来源群组", exact: true });
  await expect(group.locator("option")).toHaveText(["全部群组", groupA]);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(group.locator("option")).toHaveText(["全部群组", groupB]);
  await group.selectOption(groupB);
  await page.getByRole("combobox", { name: "记录类型", exact: true }).selectOption({ label: "消息" });
  await page.getByRole("combobox", { name: "处理状态", exact: true }).selectOption("candidate");
  await page.getByRole("textbox", { name: "搜索记录", exact: true }).fill("乙组讨论");
  await page.getByRole("button", { name: "查询活动", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get("group_id")).toBe(groupB);
  expect(requests.at(-1)?.searchParams.get("kind")).toBe("message");
  expect(requests.at(-1)?.searchParams.get("status")).toBe("candidate");
  expect(requests.at(-1)?.searchParams.get("q")).toBe("乙组讨论");
  expect(requests.at(-1)?.searchParams.get("page")).toBe("1");
  expect(requests.at(-1)?.searchParams.has("scope")).toBe(false);
  await expect(group).toHaveValue(groupB);
  await expect(page.getByText("共 2 条 · 第 1 页", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("群记录 11", { exact: true })).toBeVisible();
  await expect(group).toHaveValue(groupB);
  await expect(page.getByRole("combobox", { name: "记录类型", exact: true })).toHaveValue("message");
  await page.goBack();
  await expect(page).toHaveURL(/page=2/);
  await expect(group).toHaveValue("");
  await page.goForward();
  await expect(group).toHaveValue(groupB);
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.has("group_id")).toBe(false);
  expect(requests.at(-1)?.searchParams.has("kind")).toBe(false);
  await expect(group.locator("option")).toHaveText(["全部群组", groupA]);
  // Each UI query is one bounded source-page request; there is no group-directory scan.
  expect(requests.every((url) => url.searchParams.get("page_size") === "10")).toBe(true);
});

test("C4 an empty linked group remains explicit, legacy group links work, and denied access clears group metadata", async ({ page }) => {
  await contextRoute(page);
  const requests: URL[] = [];
  await page.route(`**${base}/activities/feishu?**`, (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    return success(route, { items: url.searchParams.get("group_id") ? [] : [{ ...activity, group_id: "oc_visible_only" }], total: url.searchParams.get("group_id") ? 0 : 1, page: 1, page_size: 10 });
  });
  await page.goto(`/projects/${projectId}/collaboration?group=oc_empty&kind=message`);
  const group = page.getByRole("combobox", { name: "来源群组", exact: true });
  await expect(page.getByText("没有符合条件的来源记录", { exact: true })).toBeVisible();
  await expect(group).toHaveValue("oc_empty");
  await expect(group.locator("option")).toHaveText(["全部群组", "当前 URL 群组筛选（待来源核对）"]);
  expect(requests.at(-1)?.searchParams.get("group_id")).toBe("oc_empty");
  await page.getByRole("button", { name: "查询活动", exact: true }).click();
  await expect(page).toHaveURL(/group_id=oc_empty/);
  expect(new URL(page.url()).searchParams.has("group")).toBe(false);
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(group.locator("option")).toHaveText(["全部群组", "oc_visible_only"]);
  await page.route(`**${base}/c-context`, (route) => failure(route, 403));
  await page.getByRole("button", { name: "刷新活动", exact: true }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
  await expect(group).toHaveCount(0);
  await expect(page.locator("main").getByText("oc_visible_only", { exact: true })).toHaveCount(0);
});

test("C4 GitHub PR filter keeps its exact wire value and does not forward Feishu groups", async ({ page }) => {
  await contextRoute(page);
  const requests: URL[] = [];
  await page.route(`**${base}/activities/github?**`, (route) => {
    const url = new URL(route.request().url()); requests.push(url);
    return success(route, { items: [{ ...activity, source_type: "github", group_id: null, kind: "pr" }], total: 1, page: 1, page_size: 10 });
  });
  await page.goto(`/projects/${projectId}/github?kind=pr&group_id=oc_other_surface`);
  await expect(page.getByRole("combobox", { name: "记录类型", exact: true })).toHaveValue("pr");
  await expect(page.getByRole("combobox", { name: "来源群组", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "查询活动", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get("kind")).toBe("pr");
  expect(requests.every((url) => !url.searchParams.has("group_id"))).toBe(true);
  expect(new URL(page.url()).searchParams.has("group_id")).toBe(false);
  await expect(page.getByRole("combobox", { name: "记录类型", exact: true }).locator("option:checked")).toHaveText("拉取请求");
});

test("C4 Feishu adoption retains reason and the same retry key; only creates candidate evidence", async ({ page }) => {
  await contextRoute(page);
  let item = structuredClone(activity);
  await activityRoutes(page, () => item);
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route(`**${base}/activities/feishu/${sourceId}/decisions`, (route) => {
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts.length === 1) return failure(route, 503);
    item = { ...item, status: "adopted", task_id: taskId, evidence_id: "00000000-0000-0000-0000-000000000310", lock_version: 1 };
    return success(route, history(item));
  });
  await page.goto(`/projects/${projectId}/collaboration?record=${sourceId}`);
  await page.getByRole("button", { name: "采纳为候选证据", exact: true }).click();
  await page.getByRole("combobox", { name: "目标任务", exact: true }).selectOption(taskId);
  await page.getByRole("checkbox", { name: "接口成功响应", exact: true }).check();
  await page.getByRole("textbox", { name: "本次操作原因", exact: true }).fill("用于对应接口标准");
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "本次操作原因", exact: true })).toHaveValue("用于对应接口标准");
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByText("已生成候选证据，尚未成为正式证据。", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body).toEqual({ action: "adopt", expected_version: 0, reason: "用于对应接口标准", task_id: taskId, criterion_ids: [criterionId] });
});

test("C4 conflict requires an explicit refresh, keeps inputs, and uses a new key for the new version", async ({ page }) => {
  await contextRoute(page);
  let item = { ...activity, source_type: "github" as const, kind: "commit", source_url: "https://github.com/org/repo/commit/abc" };
  await activityRoutes(page, () => item);
  const attempts: { key: string | undefined; body: { expected_version: number; reason: string; task_id: string } }[] = [];
  await page.route(`**${base}/activities/github/${sourceId}/association`, (route) => {
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts.length === 1) { item = { ...item, lock_version: 2 }; return failure(route, 409); }
    item = { ...item, task_id: taskId, lock_version: 3 };
    return success(route, history(item));
  });
  await page.goto(`/projects/${projectId}/github?record=${sourceId}`);
  await expect(page.getByRole("link", { name: "查看原始来源", exact: true })).toHaveAttribute("href", item.source_url);
  await page.getByRole("button", { name: "关联任务", exact: true }).click();
  await page.getByRole("combobox", { name: "目标任务", exact: true }).selectOption(taskId);
  await page.getByRole("textbox", { name: "本次操作原因", exact: true }).fill("修复接口属于此任务");
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await page.getByRole("button", { name: "刷新并核对状态", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "本次操作原因", exact: true })).toHaveValue("修复接口属于此任务");
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByText("操作已保存，来源历史仍保留。", { exact: true })).toBeVisible();
  expect(attempts.map((attempt) => attempt.body.expected_version)).toEqual([0, 2]);
  expect(attempts[1].key).not.toEqual(attempts[0].key);
});

test("C4 ignored record restores with a reason, read-only context hides mutations, and unavailable source never falls back", async ({ page }) => {
  await contextRoute(page);
  let item = structuredClone(activity);
  await activityRoutes(page, () => item);
  const actions: string[] = [];
  await page.route(`**${base}/activities/feishu/${sourceId}/decisions`, (route) => {
    const input = route.request().postDataJSON(); actions.push(input.action);
    item = { ...item, status: input.action === "ignore" ? "ignored" : "candidate", lock_version: item.lock_version + 1 };
    return success(route, history(item));
  });
  await page.goto(`/projects/${projectId}/collaboration?record=${sourceId}`);
  for (const name of ["忽略记录", "恢复待处理"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("textbox", { name: "本次操作原因", exact: true }).fill(`${name}原因`);
    await page.getByRole("button", { name: "确认操作", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "本次操作原因", exact: true })).toHaveCount(0);
  }
  expect(actions).toEqual(["ignore", "restore"]);
  await contextRoute(page, { ...context, permissions: { ...context.permissions, can_manage_activity: false, can_capture_evidence: false } });
  await page.getByRole("button", { name: "刷新活动", exact: true }).click();
  await expect(page.getByText("当前活动记录只读。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "忽略记录", exact: true })).toHaveCount(0);
  await page.route(`**${base}/activities/feishu**`, (route) => failure(route, 503));
  await page.getByRole("button", { name: "刷新活动", exact: true }).click();
  await expect(page.locator("main").getByText("接口讨论文档", { exact: true })).toHaveCount(0);
});

test("C5 designation preserves earlier versions and retries the same payload after failure", async ({ page }) => {
  await contextRoute(page);
  let detail = structuredClone(file);
  await page.route(`**${base}/files**`, (route) => new URL(route.request().url()).pathname.endsWith(`/${fileId}`) ? success(route, detail) : success(route, fileRows(detail)));
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route(`**${base}/files/${fileId}/designate`, (route) => {
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts.length === 1) return failure(route, 503);
    detail = { ...detail, official_version_no: 2, lock_version: 3, versions: detail.versions.map((version) => ({ ...version, status: version.version_no === 2 ? "current" : "superseded" })) };
    return success(route, detail);
  });
  await page.goto(`/projects/${projectId}/files?file=${fileId}`);
  await expect(page.getByText(/真实文件上传尚未接入/)).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: "设为正式 v2", exact: true }).click();
  await page.getByRole("textbox", { name: "设为正式的原因", exact: true }).fill("确认课程要求的最终内容");
  await page.getByRole("button", { name: "确认设为正式", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "设为正式的原因", exact: true })).toHaveValue("确认课程要求的最终内容");
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认设为正式", exact: true }).click();
  await expect(page.getByText("v1 · 历史版本", { exact: true })).toBeVisible();
  await expect(page.getByText("v2 · 正式", { exact: true })).toBeVisible();
  await expect(page.getByText(/保留原始发布记录/)).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toBeTruthy(); expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body).toEqual({ version_id: v2Id, expected_version: 2, reason: "确认课程要求的最终内容" });
});

test("C5 signed links are validated, read-only files remain readable, and revocation clears previous content", async ({ page }) => {
  await contextRoute(page, { ...context, permissions: { ...context.permissions, can_manage_files: false } });
  await page.route(`**${base}/files**`, (route) => new URL(route.request().url()).pathname.endsWith(`/${fileId}`) ? success(route, file) : success(route, fileRows(file)));
  let linkUrl = "javascript:alert(1)";
  await page.route(`**${base}/files/${fileId}/versions/${v1Id}/link?**`, (route) => success(route, { version_id: v1Id, purpose: "download", url: linkUrl, expires_at: new Date(Date.now() + 60_000).toISOString() } satisfies Schema["SignedFileLinkDTO"]));
  await page.goto(`/projects/${projectId}/files?file=${fileId}`);
  await expect(page.getByText("当前项目资料只读。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "设为正式 v2", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "申请下载 v1", exact: true }).click();
  await expect(page.getByText("请求未成功，输入已保留。请重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载文件", exact: true })).toHaveCount(0);
  linkUrl = "https://storage.example.test/signed/file?token=fixture";
  await page.getByRole("button", { name: "申请下载 v1", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载文件", exact: true })).toHaveAttribute("href", linkUrl);
  await page.route(`**${base}/c-context`, (route) => failure(route, 403));
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
  await expect(page.getByText("真实需求说明", { exact: true })).toHaveCount(0);
  await expect(page.getByText("已授权的真实项目", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载文件", exact: true })).toHaveCount(0);
});

test("C5 file filters survive reload, and a denied project never renders another project's records", async ({ page }) => {
  await contextRoute(page);
  const requests: URL[] = [];
  await page.route(`**${base}/files?**`, (route) => { requests.push(new URL(route.request().url())); return success(route, fileRows(file)); });
  await page.goto(`/projects/${projectId}/files`);
  await page.getByRole("combobox", { name: "资料分类", exact: true }).selectOption("documents");
  await page.getByRole("textbox", { name: "文件名", exact: true }).fill("需求");
  await page.getByRole("textbox", { name: "文件类型", exact: true }).fill("pdf");
  await page.getByRole("button", { name: "查询资料", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get("q")).toBe("需求");
  expect(requests.at(-1)?.searchParams.get("category")).toBe("documents");
  expect(requests.at(-1)?.searchParams.get("file_type")).toBe("pdf");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "文件名", exact: true })).toHaveValue("需求");
  const otherId = "00000000-0000-0000-0000-000000000399";
  await page.route(`**/api/v1/projects/${otherId}/**`, (route) => failure(route, 403));
  await page.goto(`/projects/${otherId}/files`);
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
  await expect(page.getByText("真实需求说明", { exact: true })).toHaveCount(0);
  await expect(page.locator("main table")).toHaveCount(0);
});
