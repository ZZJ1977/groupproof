import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";
import { storageRoutes } from "./c-upload-fixture";

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
  source_url: "https://example.feishu.cn/wiki/verified", availability: "available", source_changed: false, snapshot_complete: true, suggested_task_ids: [taskId],
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

test("C4-03 lists bound groups with no messages and preserves historical group filters", async ({ page }) => {
  await contextRoute(page, { ...context, actor: { ...context.actor, is_leader: true } });
  const endpoint = `**/api/v1/a/projects/${projectId}/feishu/chats`;
  let linked = [{ chat_id: "oc_without_messages", linked_at: stamp }];
  await page.route(endpoint, (route) => success(route, linked));
  await activityRoutes(page, () => ({ ...activity, group_id: "oc_historical" }));
  await page.goto(`/projects/${projectId}/collaboration`);
  const section = page.getByRole("region", { name: "项目绑定状态" });
  await expect(section).toContainText("已绑定 1 个飞书群");
  await expect(section.getByRole("link", { name: "管理飞书群绑定" })).toHaveAttribute("href", `/feishu/${projectId}`);
  const groups = page.getByRole("combobox", { name: "来源群组" });
  await expect(groups.locator("option")).toHaveText(["全部群组", "oc_without_messages", "oc_historical"]);
  linked = [];
  await page.getByRole("button", { name: "刷新活动" }).click();
  await expect(section).toContainText("此项目尚未绑定飞书群");
  await expect(groups.locator("option")).toHaveText(["全部群组", "oc_historical"]);
  await page.route(endpoint, (route) => failure(route, 403));
  await page.getByRole("button", { name: "刷新活动" }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。")).toBeVisible();
  await expect(groups).toHaveCount(0);
});

test("C4 shows A's GitHub binding independently of commit records and distinguishes unavailable from unbound", async ({ page }) => {
  await contextRoute(page, { ...context, actor: { ...context.actor, is_leader: true } });
  const endpoint = `**/api/v1/a/projects/${projectId}/github/repos`;
  await page.route(endpoint, (route) => failure(route, 503));
  await page.route(`**${base}/activities/github?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0 }));
  await page.goto(`/projects/${projectId}/github`);
  const section = page.getByRole("region", { name: "项目绑定状态" });
  await expect(section).toContainText("暂时无法读取绑定状态");
  await expect(section).not.toContainText("尚未绑定");
  await page.route(endpoint, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "gateway unavailable" }));
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/github/repos")),
    section.getByRole("button", { name: "重试绑定查询" }).click(),
  ]);
  await expect(section).toContainText("暂时无法读取绑定状态");
  await expect(section).not.toContainText("尚未绑定");
  await page.route(endpoint, (route) => success(route, [{ owner: "ZZJ1977", repo: "groupproof", default_branch: "develop", linked_at: stamp, last_synced_at: stamp }]));
  await section.getByRole("button", { name: "重试绑定查询" }).click();
  await expect(section.getByRole("link", { name: "ZZJ1977/groupproof" })).toHaveAttribute("href", "https://github.com/ZZJ1977/groupproof");
  await expect(section.getByRole("link", { name: "管理 GitHub 仓库绑定" })).toHaveAttribute("href", `/github/${projectId}`);
  await expect(section).toContainText("仓库文件与开发活动上次同步");
  await expect(section).toContainText("分页总数按当前筛选统计本项目已同步的活动快照");
  await expect(page.getByText("没有符合条件的来源记录")).toBeVisible();
  await contextRoute(page);
  await page.reload();
  await expect(section.getByRole("link", { name: "ZZJ1977/groupproof" })).toBeVisible();
  await expect(section.getByRole("link", { name: "管理 GitHub 仓库绑定" })).toHaveCount(0);
});

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
  // A single real feature can coexist with a mock workspace without seed navigation.
  await expect(page.locator("aside nav").getByRole("link", { name: "GitHub" })).toHaveAttribute("href", `/projects/${projectId}/github`);
  await expect(page.locator('a[href*="project-1"],a[href*="course-1"]')).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "全局搜索" })).toBeEnabled();
  await expect(page.getByText("来源记录第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("来源记录第 2 页", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查询活动", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重置", exact: true })).toHaveCount(0);
  const filterControls = [
    page.getByRole("textbox", { name: "搜索记录", exact: true }),
    page.getByRole("combobox", { name: "记录类型", exact: true }),
    page.getByRole("combobox", { name: "处理状态", exact: true }),
    page.getByRole("combobox", { name: "关联任务", exact: true }),
    page.getByRole("combobox", { name: "记录作者", exact: true }),
    page.getByLabel("开始日期", { exact: true }),
    page.getByLabel("结束日期", { exact: true }),
  ];
  const boxes = await Promise.all(filterControls.map((locator) => locator.boundingBox()));
  expect(boxes.every((box) => box !== null && box.height <= 40)).toBe(true);
  const firstY = boxes[0]!.y;
  expect(boxes.every((box) => Math.abs(box!.y - firstY) <= 4)).toBe(true);
  await page.getByRole("textbox", { name: "搜索记录", exact: true }).fill("接口");
  await page.getByRole("combobox", { name: "记录类型", exact: true }).selectOption({ label: "提交记录" });
  await page.getByRole("combobox", { name: "关联任务", exact: true }).selectOption(taskId);
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-10-12");
  await expect(page).toHaveURL(/date_from=2026-10-01/);
  await expect.poll(() => requests.at(-1)?.searchParams.get("q")).toBe("接口");
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
  await expect.poll(() => requests.at(-1)?.searchParams.get("q")).toBe("乙组讨论");
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
  for (let i = 0; i < 4; i += 1) {
    await page.goBack();
  }
  await expect(page).toHaveURL(/page=2/);
  await expect(group).toHaveValue("");
  for (let i = 0; i < 4; i += 1) {
    await page.goForward();
  }
  await expect(group).toHaveValue(groupB);
  await group.selectOption("");
  await page.getByRole("combobox", { name: "记录类型", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "处理状态", exact: true }).selectOption("");
  await page.getByRole("textbox", { name: "搜索记录", exact: true }).fill("");
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
  await page.getByRole("combobox", { name: "记录类型", exact: true }).selectOption("");
  await expect(page).toHaveURL(/group_id=oc_empty/);
  expect(new URL(page.url()).searchParams.has("group")).toBe(false);
  await group.selectOption("");
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
  await page.getByRole("textbox", { name: "搜索记录", exact: true }).press("Enter");
  await expect.poll(() => requests.at(-1)?.searchParams.get("kind")).toBe("pr");
  expect(requests.every((url) => !url.searchParams.has("group_id"))).toBe(true);
  expect(new URL(page.url()).searchParams.has("group_id")).toBe(false);
  await expect(page.getByRole("combobox", { name: "记录类型", exact: true }).locator("option:checked")).toHaveText("拉取请求");
});

test("C4 incomplete Feishu messages support triage while evidence capture waits for full text", async ({ page }) => {
  await contextRoute(page);
  await activityRoutes(page, () => ({ ...activity, snapshot_complete: false }));
  await page.goto(`/projects/${projectId}/collaboration?record=${sourceId}`);
  await expect(page.getByText("当前来源仅提供摘要，获得完整正文后才可采纳为候选证据。")).toBeVisible();
  await expect(page.getByRole("button", { name: "采纳为候选证据", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "忽略记录", exact: true })).toBeEnabled();
});

test("C4 Feishu attachment verification enables adoption after detail refresh", async ({ page }) => {
  await contextRoute(page);
  let verified = false;
  const attachmentId = "00000000-0000-0000-0000-000000000399";
  await activityRoutes(page, () => ({ ...activity, snapshot_complete: verified, feishu_attachments: [{
    id: attachmentId, kind: "file", name: "报告.pdf", sha256: verified ? "a".repeat(64) : null,
    size_bytes: verified ? 12 : null, verified,
  }] }));
  await page.route(`**/api/v1/a/projects/${projectId}/feishu/attachments/${attachmentId}/verify`, (route) => {
    expect(route.request().method()).toBe("POST");
    verified = true;
    return success(route, {});
  });
  await page.goto(`/projects/${projectId}/collaboration?record=${sourceId}`);
  const adopt = page.getByRole("button", { name: "采纳为候选证据", exact: true });
  await expect(adopt).toBeDisabled();
  await page.getByRole("button", { name: "核验附件指纹" }).click();
  await expect(page.getByText(/已核验 · 12 字节 · SHA-256/)).toBeVisible();
  await expect(adopt).toBeEnabled();
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

function linkRoutes(page: Page, targetFileId = fileId, urlFor: (versionId: string, purpose: "preview" | "download") => string = (vid, purpose) => `https://storage.example.test/${targetFileId}/${vid}?purpose=${purpose}`) {
  return page.route(`**${base}/files/${targetFileId}/versions/*/link**`, (route) => {
    const reqUrl = new URL(route.request().url());
    const versionId = reqUrl.pathname.split("/").at(-2) ?? "";
    const purpose = reqUrl.searchParams.get("purpose") === "download" ? "download" : "preview";
    return success(route, { version_id: versionId, purpose, url: urlFor(versionId, purpose), expires_at: new Date(Date.now() + 60_000).toISOString() } satisfies Schema["SignedFileLinkDTO"]);
  });
}

test("C5-02 project upload verifies bytes before registration and reuses the receipt after an uncertain save", async ({ page }) => {
  await contextRoute(page);
  const { payload, stage, receipt } = await storageRoutes(page, "project", projectId);
  const keys: string[] = [];
  await page.route(`**${base}/files**`, (route) => {
    if (route.request().method() === "GET") return success(route, fileRows(file));
    expect(stage.checked).toBeGreaterThan(0);
    expect(route.request().postDataJSON()).toEqual({ receipt_id: receipt, reason: "新增说明", category: "documents" });
    keys.push(route.request().headers()["idempotency-key"]);
    return keys.length === 1 ? failure(route, 503) : success(route, file);
  });
  await page.goto(`/projects/${projectId}/files`);
  await expect(page.getByLabel("选择文件", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(payload);
  await page.getByLabel("版本说明", { exact: true }).fill("新增说明");
  const submit = page.getByRole("button", { name: "上传并保存草稿", exact: true });
  await submit.click();
  await expect(page.getByText("上传服务暂不可用，请稍后重试。", { exact: true })).toBeVisible();
  await submit.click();
  await expect(page.getByText("文件草稿版本已保存。", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(stage.issued).toBe(1); expect(stage.put).toBe(1);
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
});

for (const failureCase of ["different bytes of the same size", "missing stored object"] as const) {
  test(`C5-02 rejects ${failureCase} and uploads again before appending a version`, async ({ page }) => {
    await contextRoute(page);
    const { payload, stage } = await storageRoutes(page, "project", projectId);
    if (failureCase === "missing stored object") stage.storedBytes = null;
    else {
      stage.storedBytes = Buffer.from(payload.buffer);
      stage.storedBytes[0] ^= 1;
    }
    let appends = 0;
    await page.route(`**${base}/files**`, (route) => {
      if (route.request().method() === "POST") {
        appends++;
        return success(route, file);
      }
      return success(route, new URL(route.request().url()).pathname.endsWith(`/${fileId}`) ? file : fileRows(file));
    });
    await linkRoutes(page);
    await page.goto(`/projects/${projectId}/files?file=${fileId}`);
    await page.getByRole("button", { name: /版本与历史/ }).click();
    await page.getByLabel("选择文件", { exact: true }).setInputFiles(payload);
    await page.getByLabel("版本说明", { exact: true }).fill("追加说明");
    const submit = page.getByRole("button", { name: "上传并保存草稿", exact: true });
    await submit.click();
    const message = failureCase === "missing stored object" ? "还没有收到文件" : "存储内容与所选文件不一致";
    await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
    expect(appends).toBe(0);
    await expect(page.getByRole("link", { name: "下载", exact: true })).toBeVisible();
    stage.storedBytes = payload.buffer;
    await submit.click();
    await expect(page.getByText("文件草稿版本已保存。", { exact: true })).toBeVisible();
    expect(appends).toBe(1);
    expect(stage).toMatchObject({ issued: 2, put: 2, checked: 2 });
  });
}

test("C5-02 permissions revoked during upload prevent file registration and hide the editor", async ({ page }) => {
  await contextRoute(page);
  const { payload, stage } = await storageRoutes(page, "project", projectId);
  stage.denyCompletion = true;
  let mutations = 0;
  await page.route(`**${base}/files**`, (route) => {
    if (route.request().method() !== "GET") mutations++;
    return success(route, fileRows(file));
  });
  await page.goto(`/projects/${projectId}/files`);
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await page.getByLabel("选择文件", { exact: true }).setInputFiles(payload);
  await page.getByLabel("版本说明", { exact: true }).fill("新增说明");
  await page.getByRole("button", { name: "上传并保存草稿" }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("选择文件", { exact: true })).toHaveCount(0);
  expect(mutations).toBe(0); expect(stage.put).toBe(1);
});

test("C5 designation preserves earlier versions and retries the same payload after failure", async ({ page }) => {
  await contextRoute(page);
  let detail = structuredClone(file);
  await page.route(`**${base}/files**`, (route) => new URL(route.request().url()).pathname.endsWith(`/${fileId}`) ? success(route, detail) : success(route, fileRows(detail)));
  await linkRoutes(page);
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route(`**${base}/files/${fileId}/designate`, (route) => {
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts.length === 1) return failure(route, 503);
    const input = route.request().postDataJSON() as Schema["DesignateFileVersion"];
    detail = { ...detail, official_version_no: 2, lock_version: 3,
      versions: detail.versions.map((version) => ({ ...version, status: version.version_no === 2 ? "current" : "superseded" })),
      decisions: [...detail.decisions, { ...detail.decisions[0], id: "00000000-0000-0000-0000-000000000310",
        version_id: input.version_id, reason: input.reason, previous_official_version_no: 1, resulting_lock_version: 3 }] };
    return success(route, detail);
  });
  await page.goto(`/projects/${projectId}/files?file=${fileId}`);
  await page.getByRole("button", { name: /版本与历史/ }).click();
  await expect(page.getByLabel("选择文件", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "上传并保存草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "设为正式 v2", exact: true }).click();
  await page.getByRole("textbox", { name: "设为正式的原因", exact: true }).fill("确认课程要求的最终内容");
  await page.getByRole("button", { name: "确认设为正式", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "设为正式的原因", exact: true })).toHaveValue("确认课程要求的最终内容");
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认设为正式", exact: true }).click();
  await expect(page.getByText("v1 · 历史版本", { exact: true })).toBeVisible();
  await expect(page.getByText("v2 · 正式", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /版本与历史/ }).click();
  const firstHistory = page.getByRole("list", { name: "v1 操作历史", exact: true });
  const secondHistory = page.getByRole("list", { name: "v2 操作历史", exact: true });
  await expect(firstHistory).toContainText("保留原始发布记录");
  await expect(firstHistory).not.toContainText("确认课程要求的最终内容");
  await expect(secondHistory).toContainText("设为正式 · 确认课程要求的最终内容");
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toBeTruthy(); expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body).toEqual({ version_id: v2Id, expected_version: 2, reason: "确认课程要求的最终内容" });
});

test("C5-02 returning to an evidence file reference discards a pending download for another version", async ({ page }) => {
  await contextRoute(page);
  await page.route(`**${base}/files**`, (route) => new URL(route.request().url()).pathname.endsWith(`/${fileId}`) ? success(route, file) : success(route, fileRows(file)));
  await page.route(`**${base}/files/${fileId}/versions/${v1Id}/link?**`, (route) => {
    const purpose = new URL(route.request().url()).searchParams.get("purpose") ?? "preview";
    return success(route, { version_id: v1Id, purpose, url: `https://storage.example.test/v1?purpose=${purpose}`, expires_at: new Date(Date.now() + 60_000).toISOString() });
  });
  const signature = `${base}/files/${fileId}/versions/${v2Id}/link`;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${signature}?**`, async (route) => {
    const purpose = new URL(route.request().url()).searchParams.get("purpose") ?? "preview";
    if (purpose === "download") await pending;
    return success(route, { version_id: v2Id, purpose, url: `https://fixture.invalid/v2?purpose=${purpose}`, expires_at: new Date(Date.now() + 60_000).toISOString() });
  });
  await page.goto(`/projects/${projectId}/files?file=${fileId}&version=${v1Id}`);
  const oldVersion = page.getByRole("article", { name: "证据引用的版本 v1" });
  await expect(oldVersion).toBeFocused();
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === signature && new URL(request.url()).searchParams.get("purpose") === "download");
  await page.getByRole("combobox", { name: "切换版本", exact: true }).selectOption(v2Id);
  await requested;
  const responded = page.waitForResponse((response) => new URL(response.url()).pathname === signature && new URL(response.url()).searchParams.get("purpose") === "download");
  try {
    await page.goBack();
    await expect(oldVersion).toBeFocused();
  } finally {
    release();
  }
  await (await responded).finished();
  await expect(page.getByRole("combobox", { name: "切换版本", exact: true })).toHaveValue(v1Id);
  await expect(page.getByRole("link", { name: "下载", exact: true })).toHaveAttribute("href", "https://storage.example.test/v1?purpose=download");
});

test("C5 signed links are validated, read-only files remain readable, and revocation clears previous content", async ({ page }) => {
  await contextRoute(page, { ...context, permissions: { ...context.permissions, can_manage_files: false } });
  await page.route(`**${base}/files**`, (route) => new URL(route.request().url()).pathname.endsWith(`/${fileId}`) ? success(route, file) : success(route, fileRows(file)));
  let linkUrl = "javascript:alert(1)";
  await page.route(`**${base}/files/${fileId}/versions/${v1Id}/link?**`, (route) => {
    const purpose = new URL(route.request().url()).searchParams.get("purpose") === "download" ? "download" : "preview";
    return success(route, { version_id: v1Id, purpose, url: linkUrl, expires_at: new Date(Date.now() + 60_000).toISOString() } satisfies Schema["SignedFileLinkDTO"]);
  });
  await page.goto(`/projects/${projectId}/files?file=${fileId}`);
  await expect(page.getByText("当前项目资料只读。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "上传文件", exact: true })).toHaveCount(0);
  await expect(page.getByText("请求未成功，输入已保留。请重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /版本与历史/ }).click();
  await expect(page.getByRole("button", { name: "设为正式 v2", exact: true })).toHaveCount(0);
  linkUrl = "https://storage.example.test/signed/file?token=fixture";
  await page.getByRole("button", { name: "重新获取预览", exact: true }).click();
  await expect(page.getByRole("link", { name: "下载", exact: true })).toHaveAttribute("href", linkUrl);
  await expect(page.locator("iframe[title='需求第一版.pdf PDF 预览']")).toHaveAttribute("src", linkUrl);
  await page.getByRole("button", { name: "关闭" }).click();
  await page.route(`**${base}/c-context`, (route) => failure(route, 403));
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
  await expect(page.getByText("真实需求说明", { exact: true })).toHaveCount(0);
  await expect(page.getByText("已授权的真实项目", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载", exact: true })).toHaveCount(0);
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

test("C5 inline preview renders markdown safely, image, code, and binary metadata inside the viewer drawer", async ({ page }) => {
  await contextRoute(page);
  const mdId = "00000000-0000-0000-0000-000000000311";
  const imgId = "00000000-0000-0000-0000-000000000312";
  const jsonId = "00000000-0000-0000-0000-000000000313";
  const binId = "00000000-0000-0000-0000-000000000314";
  const makeDetail = (id: string, vid: string, name: string, original: string, ext: string, mime: string): Schema["FileDetailDTO"] => ({
    id, project_id: projectId, name, category: "documents", latest_version_no: 1, official_version_no: 1, lock_version: 1,
    created_by: actorId, created_at: stamp, updated_at: stamp, decisions: [],
    versions: [{ id: vid, file_id: id, version_no: 1, original_name: original, extension: ext, mime_type: mime, size_bytes: 512, content_hash: "c".repeat(64), uploaded_by: actorId, status: "current", created_at: stamp }],
  });
  const mdDetail = makeDetail(mdId, "00000000-0000-0000-0000-000000000321", "README.md", "README.md", "md", "text/markdown");
  const imgDetail = makeDetail(imgId, "00000000-0000-0000-0000-000000000322", "架构图", "arch.png", "png", "image/png");
  const jsonDetail = makeDetail(jsonId, "00000000-0000-0000-0000-000000000323", "config.json", "config.json", "json", "application/json");
  const binDetail = makeDetail(binId, "00000000-0000-0000-0000-000000000324", "打包产物", "bundle.zip", "zip", "application/zip");
  const details = new Map([[mdId, mdDetail], [imgId, imgDetail], [jsonId, jsonDetail], [binId, binDetail]]);
  const mdBody = "# 周报标题\n\n包含 **加粗** 与 `inline_code` 和 [安全链接](https://example.com) 及 [危险脚本](javascript:alert(1))\n\n<script>window.__xss=1</script>\n\n- 列表项一\n\n| 列A | 列B |\n| --- | --- |\n| 值1 | 值2 |\n";
  await page.route(`https://preview.example.test/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/md")) return route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: mdBody });
    if (pathname.endsWith("/json")) return route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
    return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
  });
  await page.route(`**${base}/files**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const segments = pathname.split("/");
    if (segments.at(-2) === "versions" || segments.at(-1) === "link") {
      const targetFileId = segments.at(-4) ?? "";
      const versionId = segments.at(-2) ?? "";
      const purpose = new URL(route.request().url()).searchParams.get("purpose") ?? "preview";
      const suffix = targetFileId === mdId ? "md" : targetFileId === jsonId ? "json" : targetFileId === imgId ? "png" : "zip";
      return success(route, { version_id: versionId, purpose, url: `https://preview.example.test/${suffix}?purpose=${purpose}`, expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    const maybeId = segments.at(-1) ?? "";
    if (details.has(maybeId)) return success(route, details.get(maybeId));
    return success(route, { items: [...details.values()].map((d) => ({ ...d.versions[0], project_id: projectId, name: d.name, category: d.category, lock_version: d.lock_version })), total: 4, page: 1, page_size: 10 } satisfies Schema["FilePageDTO"]);
  });
  await page.goto(`/projects/${projectId}/files`);
  await expect(page.locator("tbody tr").first().getByText("README.md", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  const mdPreview = page.getByTestId("markdown-preview");
  await expect(mdPreview.getByRole("heading", { name: "周报标题" })).toBeVisible();
  await expect(mdPreview.getByRole("link", { name: "安全链接" })).toHaveAttribute("href", "https://example.com/");
  await expect(mdPreview.getByRole("link", { name: "危险脚本" })).toHaveCount(0);
  await expect(mdPreview.locator("script")).toHaveCount(0);
  await expect(mdPreview.getByText("<script>window.__xss=1</script>")).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "查看内容", exact: true }).nth(1).click();
  await expect(page.getByRole("img", { name: "arch.png" })).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "config.json", exact: true }).click();
  await expect(page.getByTestId("text-preview")).toContainText("\"ok\": true");
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "查看内容", exact: true }).nth(3).click();
  await expect(page.getByText("此类型文件暂不支持在线预览。", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载文件", exact: true })).toBeVisible();
});
