import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

// Explicit API contract fixtures. The production authentication/provider boundary stays closed.
type Schema = components["schemas"];
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const pid = id(401), tid = id(402), aid = id(403), cid = id(404), did = id(405), eid = id(406);
const base = `/api/v1/projects/${pid}`;
const stamp = "2026-10-12T08:00:00Z";
const context: Schema["CProjectContextDTO"] = {
  project: { id: pid, name: "授权执行项目", lifecycle: "active", setup_status: "frozen" },
  actor: { id: aid, is_member: true, is_leader: false, is_teacher: false },
  permissions: { can_manage_activity: true, can_manage_files: true, can_discuss: true, can_capture_evidence: true },
  tasks: [{ id: tid, title: "真实接口任务", description: "按真实任务描述实现请求校验，并保留原始结果。", status: "in_progress", can_associate: true, can_capture_evidence: true, criteria: [{ id: cid, text: "请求符合契约", version: 1 }] }],
  members: [{ id: aid, title: "成员甲" }], requirements: [{ id: id(411), title: "接口需求" }], modules: [{ id: id(412), title: "接口模块" }], milestones: [{ id: id(413), title: "首个里程碑" }],
  mention_targets: [{ id: aid, title: "成员甲" }, { id: id(490), title: "所属教师" }, { id: id(491), title: "课程助教" }],
  evidence_authors: [{ id: aid, title: "成员甲" }],
};
const execution: Schema["TaskExecutionView"] = {
  task_id: tid, project_id: pid, status: "in_progress", progress: 30, version: 2, started_at: stamp, completed_at: null,
  responsible_ids: [aid], dependencies: [], project_progress: 30, module_progress: {}, can_start: false, can_update_progress: true, read_only: false, temporary_read: false,
};
const note: Schema["TaskNoteDTO"] = {
  id: id(414), project_id: pid, task_id: tid, lock_version: 1, current_version_no: 1,
  versions: [{ id: id(415), version_no: 1, title: "已有说明", body: "保留的说明原文", edited_by: aid, content_hash: "a".repeat(64), created_at: stamp }],
};
const evidence: Schema["EvidenceDetailDTO"] = {
  id: eid, project_id: pid, task_id: tid, author_id: aid, title: "契约验证候选", description: "真实来源的候选说明", source_type: "manual", source_url: null, status: "candidate", criterion_ids: [cid], source_changed: false, lock_version: 1, created_at: stamp, updated_at: stamp, effective: false, original_snapshot_id: id(416),
  source_snapshots: [{ id: id(416), version_no: 1, source_identity: eid, source_revision: "1", content_hash: "b".repeat(64), content: { source_id: null, availability: "available", source: { title: "契约验证候选", body: "真实来源的候选说明", provenance: "user_submitted_manual_content" } }, created_at: stamp }], decisions: [],
};
const discussion: Schema["DiscussionDTO"] = {
  id: did, project_id: pid, author_id: aid, task_id: tid, requirement_id: id(411), module_id: id(412), milestone_id: id(413), title: "真实接口讨论", body: "讨论原始正文", is_important: false, status: "open", lock_version: 1, mention_user_ids: [aid], reply_count: 0, created_at: stamp, updated_at: stamp, last_activity_at: stamp, evidence_source_id: null, source_snapshot_id: null,
};
const success = (route: Route, data: unknown) => route.fulfill({ json: { data, meta: { request_id: "execution-fixture" } } });
const failure = (route: Route, status: number) => route.fulfill({ status, json: { error: { code: "FIXTURE_FAILURE", message: "Unavailable" }, meta: { request_id: "failure-fixture" } } });
const emptyEvidence: Schema["EvidencePageDTO"] = { items: [], page: 1, page_size: 10, total: 0, offset: 0, limit: 10 };
async function setup(page: Page, readContext: () => Schema["CProjectContextDTO"] = () => context) {
  await page.route(`**${base}/c-context`, (route) => success(route, readContext()));
  await page.route(`**${base}/evidence?**`, (route) => success(route, emptyEvidence));
  await page.route(`**${base}/tasks/${tid}/note?**`, (route) => success(route, note));
  await page.route(`**${base}/plan/tasks/${tid}/versions`, (route) => success(route, []));
  await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, execution));
}

test("C7-07 a scoped reader opens one task or evidence without the project catalogue", async ({ page }) => {
  await setup(page);
  const deny = (route: Route) => route.fulfill({status: 403, json: {
    error: {code: "PROJECT_ACCESS_DENIED", message: "Project access is denied."}, meta: {request_id: "scope"},
  }});
  await page.route(`**${base}/c-context`, deny);
  await page.route(`**${base}/evidence?**`, deny);
  await page.route(`**/api/v1/tasks/${tid}/execution`, route => success(route, {
    ...execution, title: "限时评阅任务", temporary_read: true, read_only: true, can_update_progress: false,
  }));
  await page.goto(`/projects/${pid}/tasks/${tid}`);
  await expect(page.getByRole("heading", {name: "限时评阅任务"})).toBeVisible();
  await expect(page.getByText("临时只读访问")).toBeVisible();
  await page.route(`**${base}/evidence/${eid}`, route => success(route, evidence));
  await page.goto(`/projects/${pid}/evidence?evidence=${eid}`);
  await expect(page.getByText(evidence.description, {exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "采纳为正式证据"})).toHaveCount(0);
  await page.route(`**${base}/evidence/${eid}`, deny);
  await page.getByRole("button", {name: "刷新证据"}).click();
  await expect(page.getByText(evidence.description, {exact: true})).toHaveCount(0);
});

test("C2-06 Feishu evidence picker resolves a list excerpt before saving", async ({ page }) => {
  await setup(page);
  const sourceId = id(850);
  const item = { source_id: sourceId, title: "飞书确认记录", summary: "列表摘要", availability: "available", kind: "message", snapshot_complete: false };
  await page.route(`**${base}/activities/feishu?**`, (route) => success(route, { items: [item], total: 1, page: 1, page_size: 10 }));
  await page.route(`**${base}/activities/feishu/${sourceId}`, (route) => success(route, { ...item, summary: "取得完整的飞书详情", snapshot_complete: true }));
  await page.route(`**${base}/evidence`, (route) => {
    expect(route.request().postDataJSON().source_id).toBe(sourceId);
    return success(route, {});
  });
  await page.goto(`/projects/${pid}/tasks/${tid}/submit`);
  await page.getByRole("combobox", { name: "来源类型" }).selectOption("feishu");
  await page.getByRole("combobox", { name: "来源记录" }).selectOption(sourceId);
  await expect(page.getByText("取得完整的飞书详情")).toBeVisible();
  await page.getByRole("textbox", { name: "证据标题" }).fill("协作证据");
  await page.getByRole("textbox", { name: "证据说明" }).fill("核对已保存的原文");
  await page.getByRole("checkbox", { name: "请求符合契约" }).check();
  await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
  await expect(page.getByText("候选证据已保存，需经采纳后才是正式证据。")).toBeVisible();
});

test("C4 task evidence opens the associated commit and PR from the task-scoped activity page", async ({ page }) => {
  await setup(page);
  const commitUrl = "https://github.com/sample/group/commit/128aee";
  const pullUrl = "https://github.com/sample/group/pull/17";
  const record: Schema["ActivityDTO"] = {
    record_id: id(810), project_id: pid, source_type: "github", source_id: id(811),
    source_identity: "commit-128aee", source_revision: "1", status: "candidate", task_id: tid,
    evidence_id: null, lock_version: 1, title: "修复任务记录", summary: "", author_id: aid,
    author_name: "成员甲", occurred_at: stamp, kind: "commit", group_id: null,
    source_url: commitUrl, availability: "available", snapshot_complete: true, source_changed: false, suggested_task_ids: [],
  };
  let requests = 0;
  await page.route(`**${base}/activities/github?**`, (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("task_id")).toBe(tid);
    requests++;
    return success(route, { items: [record,
      { ...record, source_id: id(812), title: "合并任务修复", kind: "pull_request", source_url: pullUrl },
      { ...record, source_id: id(813), title: "不可用链接", source_url: "https://other.example/commit/123" },
      { ...record, source_id: id(814), title: "已删除活动", availability: "deleted" },
    ], page: 1, page_size: 10, total: 4 });
  });
  await page.goto(`/projects/${pid}/tasks/${tid}`);
  const tab = page.getByRole("button", { name: "任务证据", exact: true });
  await expect(tab).toBeVisible();
  expect(requests).toBe(0);
  await tab.click();
  await expect(page.getByRole("link", { name: record.title })).toHaveAttribute("href", commitUrl);
  const pr = page.getByRole("link", { name: "合并任务修复" });
  await expect(pr).toHaveAttribute("href", pullUrl);
  await expect(pr).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("link", { name: /不可用链接|已删除活动/ })).toHaveCount(0);
});

test("C4 task evidence conceals foreign activity rows and handles lost access", async ({ page }) => {
  await setup(page);
  let denied = false;
  await page.route(`**${base}/activities/github?**`, (route) => denied ? failure(route, 403) : success(route, {
    items: [{ project_id: pid, task_id: id(999), source_type: "github", title: "另一个任务的提交" }],
    page: 1, page_size: 10, total: 1,
  }));
  await page.goto(`/projects/${pid}/tasks/${tid}?tab=evidence`);
  await expect(page.getByText("无法核对这些记录的任务归属。")).toBeVisible();
  await expect(page.getByText("另一个任务的提交")).toHaveCount(0);
  denied = true;
  await page.reload();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。")).toBeVisible();
  await expect(page.getByText("任务：真实接口任务")).toHaveCount(0);
});

test("C2 criteria fetch B's active rechecks on demand and refresh after B becomes available", async ({ page }) => {
  await setup(page);
  let requests = 0;
  await page.route(`**${base}/criteria-rechecks?**`, (route) => {
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).searchParams.get("task_id")).toBe(tid);
    requests++;
    if (requests === 1) return failure(route, 404);
    return success(route, [{
      task_id: tid, criterion_id: cid, requirement_id: id(411), requirement_version_no: 3,
      reason: "接口返回字段发生变更", flagged_at: stamp, verification_notified: false,
    }]);
  });
  await page.goto(`/projects/${pid}/tasks/${tid}`);
  const tab = page.getByRole("button", { name: "验收标准", exact: true });
  await expect(tab).toBeVisible();
  expect(requests).toBe(0);
  await tab.click();
  await expect(page.getByText("请求符合契约", { exact: true })).toBeVisible();
  await expect(page.getByText("暂时无法读取验收标准的复核状态。")).toBeVisible();
  await page.getByRole("button", { name: "重试复核记录" }).click();
  const criterion = page.getByRole("listitem").filter({ hasText: "请求符合契约" });
  await expect(criterion.getByText("需要重新检查", { exact: true })).toBeVisible();
  await expect(criterion.getByText("接口需求 · 需求版本 3")).toBeVisible();
  await expect(criterion.getByText("接口返回字段发生变更")).toBeVisible();
  await expect(criterion.getByText("待通知验收方", { exact: true })).toBeVisible();
});

test("C2 criteria reject a mismatched task response and hide task data on denied access", async ({ page }) => {
  await setup(page);
  let denied = false;
  await page.route(`**${base}/criteria-rechecks?**`, (route) => denied ? failure(route, 403) : success(route, [{
    task_id: id(999), criterion_id: cid, requirement_id: id(411), requirement_version_no: 3,
    reason: "其他任务的修改", flagged_at: stamp, verification_notified: true,
  }]));
  await page.goto(`/projects/${pid}/tasks/${tid}?tab=criteria`);
  await expect(page.getByText("暂时无法读取验收标准的复核状态。")).toBeVisible();
  await expect(page.getByText("其他任务的修改")).toHaveCount(0);
  denied = true;
  await page.getByRole("button", { name: "重试复核记录" }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。")).toBeVisible();
  await expect(page.getByText("请求符合契约", { exact: true })).toHaveCount(0);
});

test("C2 screenshot evidence selects an image version and clears it on source switch", async ({ page }) => {
  await setup(page);
  const imageVersion = id(840);
  const file = { id: imageVersion, file_id: id(841), project_id: pid, name: "界面截图", original_name: "登录.png",
    version_no: 2, status: "draft", mime_type: "image/png", size_bytes: 100, content_hash: "a".repeat(64),
    extension: "png", uploaded_by: aid, created_at: stamp, category: "images", lock_version: 1 };
  await page.route(`**${base}/files?**`, (route) => success(route, {
    items: [file, { ...file, id: id(842), name: "项目说明", mime_type: "application/pdf", extension: "pdf" }],
    page: 1, page_size: 10, total: 2,
  }));
  const writes: Schema["CreateEvidence"][] = [];
  await page.route(`**${base}/evidence`, (route) => {
    writes.push(route.request().postDataJSON());
    return success(route, { ...evidence, source_type: "screenshot" });
  });
  await page.goto(`/projects/${pid}/tasks/${tid}/submit`);
  const kind = page.getByRole("combobox", { name: "来源类型" });
  await kind.selectOption("screenshot");
  const picker = page.getByRole("combobox", { name: "来源记录" });
  await picker.selectOption(imageVersion);
  await expect(picker.getByRole("option", { name: "项目说明 · v2" })).toHaveCount(0);
  await kind.selectOption("file");
  await expect(picker).toHaveValue("");
  await kind.selectOption("screenshot");
  await picker.selectOption(imageVersion);
  await page.getByRole("textbox", { name: "证据标题" }).fill("登录截图");
  await page.getByRole("textbox", { name: "证据说明" }).fill("展示已验证的登录结果");
  await page.getByRole("checkbox", { name: "请求符合契约" }).check();
  await page.getByRole("button", { name: "保存候选证据" }).click();
  await expect(page.getByText("候选证据已保存，需经采纳后才是正式证据。", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ task_id: tid, source_type: "screenshot", source_id: imageVersion, criterion_ids: [cid] });
});

test("C2 a concealed B project hides previously loaded task details", async ({ page }) => {
  await setup(page);
  await page.route(`**${base}/criteria-rechecks?**`, (route) => route.fulfill({
    status: 404,
    json: { error: { code: "PROJECT_NOT_FOUND", message: "项目不存在。" }, meta: { request_id: "b-permission" } },
  }));
  await page.goto(`/projects/${pid}/tasks/${tid}`);
  await expect(page.getByText(context.tasks[0].description!, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "验收标准", exact: true }).click();
  await expect(page.getByText("这条记录不存在，或已不在当前项目中。", { exact: true })).toBeVisible();
  await expect(page.getByText("请求符合契约", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更新进度" })).toHaveCount(0);
});

test("C2 history reads B's saved task plan and historical criteria on demand", async ({ page }) => {
  await setup(page);
  const version = { version_no: 2, created_at: stamp, created_by: { id: aid, name: "成员甲" },
    snapshot: { title: "修订后的契约测试", description: "此次保存的任务范围", criteria: [{ id: cid, text: "修订后的校验标准" }] } };
  let requests = 0;
  await page.route(`**${base}/plan/tasks/${tid}/versions`, (route) => {
    expect(route.request().method()).toBe("GET");
    requests++;
    return success(route, [version, { ...version, version_no: 1, created_by: null,
      snapshot: { title: "初始契约计划", description: "最初的实现范围", criteria: [{ id: cid, text: "旧版验收标准" }] } }]);
  });
  await page.route(`**${base}/tasks/${tid}/progress-history?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0 }));
  await page.goto(`/projects/${pid}/tasks/${tid}`);
  const tab = page.getByRole("button", { name: "执行历史", exact: true });
  await expect(tab).toBeVisible();
  expect(requests).toBe(0);
  await tab.click();
  await page.locator("summary").filter({ hasText: "v1 · 初始契约计划" }).click();
  await expect(page.getByText("旧版验收标准", { exact: true })).toBeVisible();
  await expect(page.getByText("最初的实现范围", { exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "v2 · 修订后的契约测试" }).click();
  await expect(page.getByText("修订后的校验标准", { exact: true })).toBeVisible();
  await expect(page.getByText("保存人：成员甲", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "执行历史", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("summary").filter({ hasText: "v2 · 修订后的契约测试" })).toBeVisible();
});

test("C2 plan history distinguishes missing integration from a concealed task", async ({ page }) => {
  await setup(page);
  let concealed = false;
  await page.route(`**${base}/plan/tasks/${tid}/versions`, (route) => concealed ? route.fulfill({
    status: 404, json: { error: { code: "TASK_NOT_FOUND", message: "任务不存在。" }, meta: { request_id: "b-task" } },
  }) : failure(route, 404));
  await page.route(`**${base}/tasks/${tid}/progress-history?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0 }));
  await page.goto(`/projects/${pid}/tasks/${tid}?tab=history`);
  await expect(page.getByText("暂时无法读取任务计划版本。")).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: "已有说明" })).toBeVisible();
  concealed = true;
  await page.getByRole("button", { name: "重试计划版本" }).click();
  await expect(page.getByText("这条记录不存在，或已不在当前项目中。")).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: "已有说明" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更新进度" })).toHaveCount(0);
});

test("C2 start/progress use server permissions and CAS; 100 percent retains in-progress and history URL", async ({ page }) => {
  await setup(page);
  let state = { ...execution, status: "not_started" as Schema["TaskExecutionView"]["status"], progress: 0, version: 0, can_start: true, can_update_progress: false };
  await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, state));
  await page.route(`**/api/v1/tasks/${tid}/start`, (route) => { expect(route.request().postDataJSON()).toEqual({ expected_version: 0 }); state = { ...state, status: "in_progress", version: 1, can_start: false, can_update_progress: true }; return success(route, state); });
  await page.route(`**/api/v1/tasks/${tid}/progress`, (route) => { expect(route.request().postDataJSON()).toEqual({ expected_version: 1, progress: 100, reason: "完成当前实现" }); state = { ...state, progress: 100, version: 2 }; return success(route, state); });
  await page.route(`**${base}/tasks/${tid}/progress-history?**`, (route) => success(route, { items: [{ id: id(417), actor_name: "成员甲", from_status: "in_progress", to_status: "in_progress", progress_before: 0, progress_after: 100, reason: "真实进度历史", created_at: stamp }], page: 1, page_size: 10, total: 1 } satisfies Schema["ProgressHistoryPageDTO"]));
  await page.route(`**${base}/discussions?**`, (route) => { expect(new URL(route.request().url()).searchParams.get("task_id")).toBe(tid); return success(route, { items: [], page: 1, page_size: 10, total: 0 }); });
  await page.goto(`/projects/${pid}/tasks/${tid}`);
  await expect(page.getByText("按真实任务描述实现请求校验，并保留原始结果。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await page.getByRole("button", { name: "更新进度", exact: true }).click();
  await page.getByRole("spinbutton", { name: "任务进度", exact: true }).fill("100");
  await page.getByRole("textbox", { name: "进度变更原因", exact: true }).fill("完成当前实现");
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  await expect(page.getByText("状态：进行中 · 进度：100%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "执行历史", exact: true }).click();
  await expect(page.getByText("真实进度历史", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/tab=history/);
  await page.reload();
  await expect(page.getByRole("button", { name: "执行历史", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "任务验收", exact: true }).click();
  await expect(page.getByText(/验收查询和结论服务尚未接入/)).toBeVisible();
  await page.getByRole("button", { name: "任务讨论", exact: true }).click();
  await expect(page.getByText("没有符合条件的讨论", { exact: true })).toBeVisible();
  state = { ...state, can_update_progress: false, read_only: true };
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await expect(page.getByRole("button", { name: "更新进度", exact: true })).toHaveCount(0);
});

test("C2 note retries keep the input/key and submission preparation stays out of mock verification", async ({ page }) => {
  await setup(page);
  let saved = structuredClone(note), state = structuredClone(execution);
  await page.route(`**${base}/tasks/${tid}/note?**`, (route) => success(route, saved));
  await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, state));
  const attempts: { key: string | undefined; body: Schema["SaveTaskNote"] }[] = [];
  await page.route(`**${base}/tasks/${tid}/note`, (route) => {
    const body = route.request().postDataJSON(); attempts.push({ key: route.request().headers()["idempotency-key"], body });
    if (attempts.length === 1) return failure(route, 503);
    saved = { ...saved, lock_version: 2, current_version_no: 2, versions: [{ ...note.versions[0], id: id(418), version_no: 2, title: body.title, body: body.body }, ...note.versions] }; return success(route, saved);
  });
  await page.route(`**/api/v1/tasks/${tid}/prepare-submission`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ expected_version: 2, note: null });
    state = { ...state, status: "pending_submission", version: 3 }; return success(route, { execution: state, note: saved });
  });
  await page.goto(`/projects/${pid}/tasks/${tid}/submit`);
  await page.getByRole("button", { name: "编辑任务说明", exact: true }).click();
  await page.getByRole("textbox", { name: "说明正文", exact: true }).fill("失败重试仍保留的新说明");
  await page.getByRole("button", { name: "保存说明新版本", exact: true }).click();
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "说明正文", exact: true })).toHaveValue("失败重试仍保留的新说明");
  await page.getByRole("button", { name: "保存说明新版本", exact: true }).click();
  await expect(page.locator("summary").filter({ hasText: "v2 · 已有说明" })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toBeTruthy(); expect(attempts[1]).toEqual(attempts[0]);
  await page.getByRole("button", { name: "准备提交", exact: true }).click();
  await page.getByRole("button", { name: "确认保存提交准备", exact: true }).click();
  await expect(page.getByText(/提交准备已保存，任务处于待提交状态/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/tasks/${tid}/submit$`));
  await expect(page.getByRole("link", { name: /验收/ })).toHaveCount(0);
});

test("C2 completeness check saves the draft before opening page 16 and restores it on return", async ({ page }) => {
  await setup(page);
  let saved = structuredClone(note), state = structuredClone(execution);
  await page.route(`**${base}/tasks/${tid}/note?**`, (route) => success(route, saved));
  await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, state));
  const writes: { body: unknown; key?: string }[] = [];
  await page.route(`**/api/v1/tasks/${tid}/prepare-submission`, (route) => {
    const input: Schema["PrepareSubmissionRequest"] = route.request().postDataJSON();
    writes.push({ body: input, key: route.request().headers()["idempotency-key"] });
    if (writes.length === 1) return failure(route, 503);
    if (writes.length === 2) return success(route, { execution: { ...state, task_id: id(999), status: "pending_submission" }, note: null });
    expect(input.expected_version).toBe(2);
    expect(input.note?.body).toBe("完整性检查前的草稿");
    saved = { ...saved, current_version_no: 2, lock_version: 2, versions: [
      { ...saved.versions[0], id: id(419), version_no: 2, body: input.note!.body }, ...saved.versions,
    ] };
    state = { ...state, status: "pending_submission", version: 3 };
    return success(route, { execution: state, note: saved });
  });
  const submitPath = `/projects/${pid}/tasks/${tid}/submit`;
  await page.goto(submitPath);
  await page.getByRole("button", { name: "编辑任务说明", exact: true }).click();
  const body = page.getByRole("textbox", { name: "说明正文", exact: true });
  await body.fill("完整性检查前的草稿");
  const candidateTitle = page.getByRole("textbox", { name: "证据标题", exact: true });
  await candidateTitle.fill("仍在编辑的候选证据");
  const check = page.getByRole("button", { name: "检查完整性", exact: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await check.click();
  expect(writes).toHaveLength(0);
  await expect(candidateTitle).toHaveValue("仍在编辑的候选证据");
  await candidateTitle.fill("");
  await check.click();
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await expect(body).toHaveValue("完整性检查前的草稿");
  await check.click();
  await expect(page.getByText("请求未成功，输入已保留。请重试。", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${submitPath}$`));
  await check.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${tid}/evidence-check$`));
  await expect(page.getByRole("heading", { name: "证据完整性检查" })).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(writes[0].key).toBeTruthy();
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[2]).toEqual(writes[0]);
  await page.getByRole("link", { name: "返回提交草稿" }).click();
  await expect(page).toHaveURL(new RegExp(`${submitPath}$`));
  await page.getByRole("button", { name: "编辑任务说明", exact: true }).click();
  await expect(body).toHaveValue("完整性检查前的草稿");
});

test("C3 manual candidate validates URL, captures selected criteria, and adopts/withdraws without changing snapshots", async ({ page }) => {
  await setup(page);
  let item = structuredClone(evidence), added = false;
  item.source_url = "https://example.test/source";
  item.source_snapshots[0].content.source = {
    title: item.title, body: item.description, provenance: "user_submitted_manual_content", source_url: item.source_url,
  };
  await page.route(`**${base}/evidence?**`, (route) => success(route, { ...emptyEvidence, items: added ? [item] : [], total: added ? 1 : 0 }));
  await page.route(`**${base}/evidence/${eid}`, (route) => success(route, item));
  let creates = 0;
  await page.route(`**${base}/evidence`, (route) => { creates++; expect(route.request().postDataJSON()).toMatchObject({ task_id: tid, source_type: "manual", criterion_ids: [cid], source_url: "https://example.test/source" }); added = true; return success(route, item); });
  await page.route(`**${base}/evidence/${eid}/adopt`, (route) => { expect(route.request().postDataJSON()).toEqual({ expected_version: 1, reason: "证据符合本次标准" }); item = { ...item, status: "formal", effective: true, lock_version: 2 }; return success(route, item); });
  await page.route(`**${base}/evidence/${eid}/withdraw`, (route) => { expect(route.request().postDataJSON()).toEqual({ expected_version: 2, reason: "更新内容后重新提交" }); item = { ...item, status: "withdrawn", effective: false, lock_version: 3 }; return success(route, item); });
  await page.goto(`/projects/${pid}/evidence`);
  await page.getByRole("button", { name: "添加候选证据", exact: true }).click();
  await page.getByRole("combobox", { name: "证据任务", exact: true }).selectOption(tid);
  await page.getByRole("textbox", { name: "证据标题", exact: true }).fill("契约验证候选");
  await page.getByRole("textbox", { name: "证据说明", exact: true }).fill("真实来源的候选说明");
  await page.getByRole("textbox", { name: "来源链接（可选）", exact: true }).fill("https://user:password@example.test/source");
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("task_note");
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("manual");
  await expect(page.getByRole("textbox", { name: "来源链接（可选）", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "来源链接（可选）", exact: true }).fill("https://user:password@example.test/source");
  await page.getByRole("checkbox", { name: "请求符合契约", exact: true }).check();
  await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
  await expect(page.getByText("来源链接须为不含登录凭据的 HTTPS 地址。", { exact: true })).toBeVisible(); expect(creates).toBe(0);
  await page.getByRole("textbox", { name: "来源链接（可选）", exact: true }).fill("https://example.test/source");
  await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
  await page.getByRole("button", { name: "查看证据历史", exact: true }).click();
  await page.getByRole("button", { name: "采纳为正式证据", exact: true }).click();
  await page.getByRole("textbox", { name: "证据决定原因", exact: true }).fill("证据符合本次标准");
  await page.getByRole("button", { name: "确认决定", exact: true }).click();
  await expect(page.getByText("当前可用于有效证据查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "撤回证据", exact: true }).click();
  await page.getByRole("textbox", { name: "证据决定原因", exact: true }).fill("更新内容后重新提交");
  await page.getByRole("button", { name: "确认决定", exact: true }).click();
  await expect(page.getByText("证据已撤回，历史和快照仍保留。", { exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "快照 v1" }).click();
  await expect(page.getByText("契约验证候选\n真实来源的候选说明", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "打开提交时的网址" })).toHaveAttribute("href", item.source_url);
});

test("C3 another author cannot decide; revoked context clears evidence and never shows local seed", async ({ page }) => {
  await setup(page);
  const foreign = { ...evidence, author_id: id(499) };
  await page.route(`**${base}/evidence?**`, (route) => success(route, { ...emptyEvidence, items: [foreign], total: 1 }));
  await page.route(`**${base}/evidence/${eid}`, (route) => success(route, foreign));
  await page.goto(`/projects/${pid}/evidence?evidence=${eid}`);
  await expect(page.getByRole("heading", { name: "契约验证候选", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "采纳为正式证据", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "撤回证据", exact: true })).toHaveCount(0);
  await page.route(`**${base}/c-context`, (route) => failure(route, 403));
  await page.getByRole("button", { name: "刷新证据", exact: true }).click();
  await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
  await expect(page.getByText("契约验证候选", { exact: true })).toHaveCount(0);
});

test("C6 new discussion binds four canonical selectors and mentions, retries safely, and confirms cancel", async ({ page }) => {
  await setup(page);
  let created = false;
  await page.route(`**${base}/discussions?**`, (route) => success(route, { items: created ? [discussion] : [], page: 1, page_size: 10, total: created ? 1 : 0 }));
  await page.route(`**${base}/discussions/${did}`, (route) => success(route, discussion));
  await page.route(`**${base}/discussions/${did}/replies?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0, discussion_lock_version: 1 }));
  const attempts: { key: string | undefined; body: Schema["CreateDiscussion"] }[] = [];
  await page.route(`**${base}/discussions`, (route) => { attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() }); if (attempts.length === 1) return failure(route, 503); created = true; return success(route, discussion); });
  await page.goto(`/projects/${pid}/discussions`);
  await page.getByRole("button", { name: "新建讨论", exact: true }).click();
  await page.getByRole("textbox", { name: "讨论标题", exact: true }).fill("真实接口讨论");
  await page.getByRole("textbox", { name: "讨论正文", exact: true }).fill("讨论原始正文");
  for (const [name, value] of [["新讨论关联任务", tid], ["新讨论关联需求", id(411)], ["新讨论关联模块", id(412)], ["新讨论关联里程碑", id(413)]]) await page.getByRole("combobox", { name, exact: true }).selectOption(value);
  await page.getByRole("checkbox", { name: "成员甲", exact: true }).check();
  await page.getByRole("button", { name: "取消新讨论", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "讨论正文", exact: true })).toHaveValue("讨论原始正文");
  await page.getByRole("button", { name: "发布讨论", exact: true }).click();
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发布讨论", exact: true }).click();
  await expect(page.getByRole("heading", { name: "真实接口讨论", exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toBeTruthy(); expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body).toMatchObject({ expected_version: 0, task_id: tid, requirement_id: id(411), module_id: id(412), milestone_id: id(413), mention_user_ids: [aid] });
});

test("C6 reply retains concurrent replies, important changes use reason/CAS, then read-only authority hides writes", async ({ page }) => {
  let access = structuredClone(context), item = structuredClone(discussion);
  await setup(page, () => access);
  let replies: Schema["DiscussionReplyDTO"][] = [{ id: id(420), discussion_id: did, author_id: aid, body: "另一条已保存回复", mention_user_ids: [], created_at: stamp, updated_at: stamp }];
  await page.route(`**${base}/discussions?**`, (route) => success(route, { items: [item], page: 1, page_size: 10, total: 1 }));
  await page.route(`**${base}/discussions/${did}`, (route) => success(route, item));
  await page.route(`**${base}/discussions/${did}/replies?**`, (route) => success(route, { items: replies, page: 1, page_size: 10, total: replies.length, discussion_lock_version: item.lock_version }));
  await page.route(`**${base}/discussions/${did}/replies`, (route) => { const input = route.request().postDataJSON(); expect(input.expected_version).toBe(1); const reply = { ...replies[0], id: id(421), body: input.body }; replies = [...replies, reply]; item = { ...item, reply_count: 2 }; return success(route, { discussion: item, reply }); });
  const marks: { is_important: boolean; expected_version: number; reason: string }[] = [];
  await page.route(`**${base}/discussions/${did}/important`, (route) => { const input = route.request().postDataJSON(); marks.push(input); item = { ...item, is_important: input.is_important, lock_version: item.lock_version + 1 }; return success(route, item); });
  await page.goto(`/projects/${pid}/discussions?discussion=${did}`);
  await page.getByRole("button", { name: "回复讨论", exact: true }).click();
  await page.getByRole("textbox", { name: "回复正文", exact: true }).fill("新增回复保留所有旧回复");
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect(page.getByText("另一条已保存回复", { exact: true })).toBeVisible();
  await expect(page.getByText("新增回复保留所有旧回复", { exact: true })).toBeVisible();
  for (const name of ["标记为重要", "取消重要标记"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("textbox", { name: "重要标记原因", exact: true }).fill(`${name}的原因`);
    await page.getByRole("button", { name: "确认重要标记变更", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "重要标记原因", exact: true })).toHaveCount(0);
  }
  expect(marks.map((mark) => mark.expected_version)).toEqual([1, 2]); expect(marks.map((mark) => mark.is_important)).toEqual([true, false]);
  access = { ...access, permissions: { ...access.permissions, can_discuss: false } };
  await page.getByRole("button", { name: "刷新讨论", exact: true }).click();
  await expect(page.getByText("当前项目讨论只读。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "回复讨论", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "标记为重要", exact: true })).toHaveCount(0);
});

for (const action of ["save", "prepare"] as const) {
  test(`C2 ${action} refreshes the shared note source without losing the candidate draft`, async ({ page }) => {
    await setup(page);
    let saved = structuredClone(note), state = structuredClone(execution);
    await page.route(`**${base}/tasks/${tid}/note?**`, (route) => success(route, saved));
    await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, state));
    function saveVersion(input: Schema["SaveTaskNote"]) {
      expect(input.expected_version).toBe(1);
      saved = { ...saved, lock_version: 2, current_version_no: 2, versions: [{ ...note.versions[0], id: id(450), version_no: 2, title: input.title, body: input.body }, ...note.versions] };
    }
    await page.route(`**${base}/tasks/${tid}/note`, (route) => { saveVersion(route.request().postDataJSON()); return success(route, saved); });
    await page.route(`**/api/v1/tasks/${tid}/prepare-submission`, (route) => {
      const input = route.request().postDataJSON();
      expect(input.expected_version).toBe(execution.version); saveVersion(input.note);
      state = { ...state, status: "pending_submission", version: 3 };
      return success(route, { execution: state, note: saved });
    });
    const creates: Schema["CreateEvidence"][] = [];
    await page.route(`**${base}/evidence`, (route) => { const input = route.request().postDataJSON(); creates.push(input); expect(input.source_id).toBe(id(450)); return success(route, { ...evidence, source_type: "task_note" }); });
    await page.goto(`/projects/${pid}/tasks/${tid}/submit`);
    await page.getByRole("textbox", { name: "证据标题", exact: true }).fill("保留候选标题");
    await page.getByRole("textbox", { name: "证据说明", exact: true }).fill("保留候选说明");
    await page.getByRole("checkbox", { name: "请求符合契约", exact: true }).check();
    await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("task_note");
    await page.getByRole("combobox", { name: "来源记录", exact: true }).selectOption(note.versions[0].id);
    await page.getByRole("button", { name: "编辑任务说明", exact: true }).click();
    await page.getByRole("textbox", { name: "说明正文", exact: true }).fill("保存后的第二版原文");
    if (action === "save") await page.getByRole("button", { name: "保存说明新版本", exact: true }).click();
    else {
      await page.getByRole("button", { name: "准备提交", exact: true }).click();
      await page.getByRole("button", { name: "确认保存提交准备", exact: true }).click();
    }
    await expect(page.locator("summary").filter({ hasText: "v2 · 已有说明" })).toBeVisible();
    const source = page.getByRole("combobox", { name: "来源记录", exact: true });
    await expect(source).toHaveValue("");
    await expect(source.locator("option")).toHaveText(["请选择来源", "已有说明 · v2"]);
    await expect(page.getByRole("textbox", { name: "证据标题", exact: true })).toHaveValue("保留候选标题");
    await expect(page.getByRole("textbox", { name: "证据说明", exact: true })).toHaveValue("保留候选说明");
    await expect(page.getByRole("checkbox", { name: "请求符合契约", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
    await expect(page.getByText("请从已授权的来源列表选择记录。", { exact: true })).toBeVisible();
    expect(creates).toHaveLength(0);
    await source.selectOption(id(450));
    await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
    await expect(page.getByText("候选证据已保存，需经采纳后才是正式证据。", { exact: true })).toBeVisible();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ source_type: "task_note", title: "保留候选标题", description: "保留候选说明", criterion_ids: [cid] });
  });
}

test("C3 source conflict refreshes the authoritative note version and keeps the evidence draft", async ({ page }) => {
  await setup(page);
  let saved = structuredClone(note);
  await page.route(`**${base}/tasks/${tid}/note?**`, (route) => success(route, saved));
  const attempts: { key: string | undefined; body: Schema["CreateEvidence"] }[] = [];
  await page.route(`**${base}/evidence`, (route) => {
    const body = route.request().postDataJSON(); attempts.push({ key: route.request().headers()["idempotency-key"], body });
    if (attempts.length === 1) {
      saved = { ...note, current_version_no: 2, lock_version: 2, versions: [{ ...note.versions[0], id: id(451), version_no: 2 }, ...note.versions] };
      return route.fulfill({ status: 409, json: { error: { code: "SOURCE_NOT_CURRENT", message: "Use the current version." }, meta: { request_id: "note-conflict" } } });
    }
    expect(body.source_id).toBe(id(451)); return success(route, evidence);
  });
  await page.goto(`/projects/${pid}/tasks/${tid}/submit`);
  await page.getByRole("textbox", { name: "证据标题", exact: true }).fill("并发保存后保留标题");
  await page.getByRole("textbox", { name: "证据说明", exact: true }).fill("并发保存后保留说明");
  await page.getByRole("checkbox", { name: "请求符合契约", exact: true }).check();
  await page.getByRole("combobox", { name: "来源类型", exact: true }).selectOption("task_note");
  await page.getByRole("combobox", { name: "来源记录", exact: true }).selectOption(note.versions[0].id);
  await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
  await page.getByRole("button", { name: "刷新并核对来源", exact: true }).click();
  const source = page.getByRole("combobox", { name: "来源记录", exact: true });
  await expect(source).toHaveValue("");
  await expect(source.locator("option")).toHaveText(["请选择来源", "已有说明 · v2"]);
  await expect(page.getByRole("textbox", { name: "证据标题", exact: true })).toHaveValue("并发保存后保留标题");
  await expect(page.getByRole("textbox", { name: "证据说明", exact: true })).toHaveValue("并发保存后保留说明");
  await expect(page.getByRole("checkbox", { name: "请求符合契约", exact: true })).toBeChecked();
  await source.selectOption(id(451));
  await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
  await expect(page.getByText("候选证据已保存，需经采纳后才是正式证据。", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0].key).toBeTruthy(); expect(attempts[1].key).not.toBe(attempts[0].key);
});

for (const sourceType of ["task_note", "discussion"] as const) {
  test(`C3 ${sourceType} renders canonical nested immutable snapshots and preserves original content`, async ({ page }) => {
    await setup(page);
    const originalReply = { id: id(452), discussion_id: did, author_id: aid, body: "快照中已有的回复", mention_user_ids: [], created_at: stamp, updated_at: stamp };
    const laterReply = { ...originalReply, id: id(453), body: "来源变化后的新增回复" };
    const discussionSource: Record<string, unknown> = { ...discussion, is_important: true, replies: [originalReply] };
    delete discussionSource.evidence_source_id; delete discussionSource.source_snapshot_id;
    const originalSource = sourceType === "task_note"
      ? { note_id: note.id, note_version_id: note.versions[0].id, version_no: 1, title: "第一版说明标题", body: "说明不可变原文" }
      : discussionSource;
    const currentSource = sourceType === "task_note"
      ? { ...originalSource, note_version_id: id(454), version_no: 2, title: "第二版说明标题", body: "说明当前新原文" }
      : { ...discussionSource, is_important: false, replies: [originalReply, laterReply], reply_count: 2 };
    const sourceId = sourceType === "task_note" ? note.versions[0].id : did;
    const snapshot = evidence.source_snapshots[0];
    const item: Schema["EvidenceDetailDTO"] = {
      ...evidence, source_type: sourceType, status: "formal", source_changed: true, effective: false,
      source_snapshots: [
        { ...snapshot, source_identity: sourceType === "task_note" ? note.id : did, source_revision: sourceType === "task_note" ? note.versions[0].id : id(456), content: { source_id: sourceId, availability: "available", source: originalSource } },
        { ...snapshot, id: id(455), version_no: 2, source_identity: sourceType === "task_note" ? note.id : did, source_revision: sourceType === "task_note" ? id(454) : id(457), content: { source_id: sourceId, availability: "available", source: currentSource } },
      ],
    };
    await page.route(`**${base}/evidence/${eid}`, (route) => success(route, item));
    await page.goto(`/projects/${pid}/evidence?evidence=${eid}`);
    await expect(page.getByText("来源已变化，原快照保留；该证据当前不计入有效证据。", { exact: true })).toBeVisible();
    const original = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "快照 v1" }) });
    const current = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "快照 v2" }) });
    await original.locator("summary").click(); await current.locator("summary").click();
    if (sourceType === "task_note") {
      await expect(original.getByText("第一版说明标题\n说明不可变原文", { exact: true })).toBeVisible();
      await expect(current.getByText("第二版说明标题\n说明当前新原文", { exact: true })).toBeVisible();
      await expect(original.getByText("任务说明 v1", { exact: true })).toBeVisible();
      await expect(current.getByText("任务说明 v2", { exact: true })).toBeVisible();
    } else {
      await expect(original.getByText("真实接口讨论\n讨论原始正文", { exact: true })).toBeVisible();
      await expect(original.getByText(originalReply.body, { exact: true })).toBeVisible();
      await expect(original.getByText(laterReply.body, { exact: true })).toHaveCount(0);
      await expect(current.getByText(laterReply.body, { exact: true })).toBeVisible();
      await expect(current.getByText("此快照中的讨论已取消重要标记。", { exact: true })).toBeVisible();
    }
    await expect(page.getByText("该来源快照不包含可直接展示的文字。", { exact: true })).toHaveCount(0);
    await expect(page.getByText(sourceId, { exact: true })).toHaveCount(0);
    if (sourceType === "task_note") {
      const version = note.versions[0].id;
      const history = `/projects/${pid}/tasks/${tid}?tab=history&note=`;
      await expect(original.getByRole("link", { name: "查看此版本的任务说明" })).toHaveAttribute("href", `${history}${version}#note-${version}`);
      await expect(current.getByRole("link", { name: "查看此版本的任务说明" })).toHaveAttribute("href", `${history}${id(454)}#note-${id(454)}`);
      await page.route(`**${base}/tasks/${tid}/progress-history?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0 }));
      await original.getByRole("link", { name: "查看此版本的任务说明" }).click();
      await expect(page.locator(`#note-${version}`)).toBeFocused();
    } else {
      await expect(current.getByRole("link", { name: "查看原讨论串" })).toHaveAttribute("href", `/projects/${pid}/discussions?discussion=${did}`);
      await page.route(`**${base}/discussions?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0 }));
      await page.route(`**${base}/discussions/${did}`, (route) => success(route, discussion));
      await page.route(`**${base}/discussions/${did}/replies?**`, (route) => success(route, { items: [], page: 1, page_size: 10, total: 0, discussion_lock_version: 1 }));
      await original.getByRole("link", { name: "查看原讨论串" }).click();
      await expect(page.getByText(discussion.body, { exact: true })).toBeVisible();
    }
    await page.route(`**${base}/c-context`, (route) => failure(route, 403));
    await page.reload();
    await expect(page.getByText("当前访问权限已失效，项目数据已隐藏。", { exact: true })).toBeVisible();
    await expect(page.getByText(sourceType === "task_note" ? note.versions[0].body : discussion.body, { exact: true })).toHaveCount(0);
  });
}

test("C6 a failed reply retries its receipt, but a later identical reply creates a new append", async ({ page }) => {
  await setup(page);
  const replies: Schema["DiscussionReplyDTO"][] = [];
  const receipts = new Map<string, Schema["DiscussionReplyDTO"]>();
  const attempts: { key: string; body: Schema["ReplyDiscussion"] }[] = [];
  const item = () => ({ ...discussion, reply_count: replies.length });
  await page.route(`**${base}/discussions?**`, (route) => success(route, { items: [item()], page: 1, page_size: 10, total: 1 }));
  await page.route(`**${base}/discussions/${did}`, (route) => success(route, item()));
  await page.route(`**${base}/discussions/${did}/replies?**`, (route) => success(route, { items: replies, page: 1, page_size: 10, total: replies.length, discussion_lock_version: 1 }));
  await page.route(`**${base}/discussions/${did}/replies`, (route) => {
    const key = route.request().headers()["idempotency-key"], body = route.request().postDataJSON();
    expect(key).toBeTruthy(); expect(body).toEqual({ expected_version: 1, body: "同意", mention_user_ids: [] });
    attempts.push({ key, body });
    let reply = receipts.get(key);
    if (!reply) {
      reply = { id: id(460 + replies.length), discussion_id: did, author_id: aid, body: body.body, mention_user_ids: [], created_at: stamp, updated_at: stamp };
      replies.push(reply); receipts.set(key, reply);
    }
    // Simulate a committed append whose first response failed. A retry must not append again.
    if (attempts.length === 1) return failure(route, 503);
    return success(route, { discussion: item(), reply });
  });
  await page.goto(`/projects/${pid}/discussions?discussion=${did}`);
  await page.getByRole("button", { name: "回复讨论", exact: true }).click();
  await page.getByRole("textbox", { name: "回复正文", exact: true }).fill("同意");
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect(page.getByText("服务暂不可用，暂不能确认结果。请稍后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "回复正文", exact: true })).toHaveValue("同意");
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "回复正文", exact: true })).toHaveCount(0);
  await expect(page.locator('article[id^="reply-"]').getByText("同意", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "回复讨论", exact: true }).click();
  await page.getByRole("textbox", { name: "回复正文", exact: true }).fill("同意");
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "回复正文", exact: true })).toHaveCount(0);
  await expect(page.locator('article[id^="reply-"]').getByText("同意", { exact: true })).toHaveCount(2);
  expect(attempts).toHaveLength(3); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[2].body).toEqual(attempts[0].body); expect(attempts[2].key).not.toBe(attempts[0].key);
  expect(replies).toHaveLength(2);
});

test("C3 confirmed identical candidate captures use distinct command keys", async ({ page }) => {
  await setup(page);
  const captures = new Map<string, Schema["CreateEvidence"]>();
  await page.route(`**${base}/evidence`, (route) => {
    const key = route.request().headers()["idempotency-key"];
    expect(key).toBeTruthy(); captures.set(key, route.request().postDataJSON()); return success(route, evidence);
  });
  await page.goto(`/projects/${pid}/tasks/${tid}/submit`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("textbox", { name: "证据标题", exact: true }).fill("再次提交相同说明");
    await page.getByRole("textbox", { name: "证据说明", exact: true }).fill("每次确认成功代表一次候选记录");
    await page.getByRole("checkbox", { name: "请求符合契约", exact: true }).check();
    await page.getByRole("button", { name: "保存候选证据", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "证据标题", exact: true })).toHaveValue("");
    await expect(page.getByText("候选证据已保存，需经采纳后才是正式证据。", { exact: true })).toBeVisible();
  }
  expect(captures.size).toBe(2);
  expect([...captures.values()][0]).toEqual([...captures.values()][1]);
});

test("C1 task activity links open the exact note version and ask the server for the current progress page", async ({ page }) => {
  await setup(page);
  const earlier = { ...note.versions[0], id: id(480), version_no: 1, title: "历史说明", body: "动态定位的历史说明原文" };
  const latest = { ...note.versions[0], id: id(481), version_no: 2, title: "最新说明", body: "另一版说明" };
  await page.route(`**${base}/tasks/${tid}/note?**`, (route) => success(route, { ...note, lock_version: 2, current_version_no: 2, versions: [latest, earlier] }));
  const target = { id: id(482), actor_name: "成员甲", from_status: "in_progress", to_status: "in_progress", progress_before: 20, progress_after: 30, reason: "动态定位的历史进度原因", created_at: stamp } satisfies Schema["ProgressHistoryEventDTO"];
  const queries: URLSearchParams[] = [];
  await page.route(`**${base}/tasks/${tid}/progress-history?**`, (route) => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    if (query.get("focus_event_id") === target.id) return success(route, { items: [target], page: 3, page_size: 10, total: 25 });
    return success(route, { items: [], page: Number(query.get("page") ?? 1), page_size: 10, total: 25 });
  });
  await page.goto(`/projects/${pid}/tasks/${tid}?tab=history&note=${earlier.id}#note-${earlier.id}`);
  const noteTarget = page.locator(`#note-${earlier.id}`);
  await expect(noteTarget).toHaveAttribute("open", "");
  await expect(noteTarget).toBeFocused();
  await expect(noteTarget.getByText(earlier.body, { exact: true })).toBeVisible();
  await expect(page.locator(`#note-${latest.id}`)).not.toHaveAttribute("open", "");
  await page.goto(`/projects/${pid}/tasks/${tid}?tab=history&progress=${target.id}#progress-${target.id}`);
  await expect(page.getByText("共 25 条 · 第 3 页", { exact: true })).toBeVisible();
  await expect(page.locator(`#progress-${target.id}`)).toBeFocused();
  await expect(page.getByText(target.reason, { exact: true })).toBeVisible();
  expect(queries.some((query) => query.get("focus_event_id") === target.id)).toBe(true);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByText("共 25 条 · 第 2 页", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]progress=/);
  expect(queries.at(-1)?.get("focus_event_id")).toBeNull();
});

test("C6 mentions authorized teacher and TA and locates a newly saved reply beyond the first page", async ({ page }) => {
  await setup(page);
  const replies: Schema["DiscussionReplyDTO"][] = Array.from({ length: 10 }, (_, index) => ({ id: id(500 + index), discussion_id: did, author_id: aid, body: `已有回复 ${index + 1}`, mention_user_ids: [], created_at: stamp, updated_at: stamp }));
  const item = () => ({ ...discussion, reply_count: replies.length });
  const focusQueries: string[] = [];
  await page.route(`**${base}/discussions?**`, (route) => success(route, { items: [item()], page: 1, page_size: 10, total: 1 }));
  await page.route(`**${base}/discussions/${did}`, (route) => success(route, item()));
  await page.route(`**${base}/discussions/${did}/replies?**`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const focus = query.get("focus_reply_id");
    if (focus) focusQueries.push(focus);
    const number = focus === id(510) ? 2 : Number(query.get("page") ?? 1);
    return success(route, { items: replies.slice((number - 1) * 10, number * 10), page: number, page_size: 10, total: replies.length, discussion_lock_version: 1 });
  });
  await page.route(`**${base}/discussions/${did}/replies`, (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({ expected_version: 1, body: "第十一条保存后立即定位", mention_user_ids: [id(490), id(491)] });
    const reply = { id: id(510), discussion_id: did, author_id: aid, body: body.body, mention_user_ids: body.mention_user_ids, created_at: stamp, updated_at: stamp };
    replies.push(reply); return success(route, { discussion: item(), reply });
  });
  await page.goto(`/projects/${pid}/discussions?discussion=${did}`);
  await expect(page.getByText("已有回复 10", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "回复讨论", exact: true }).click();
  await page.getByRole("checkbox", { name: "所属教师", exact: true }).check();
  await page.getByRole("checkbox", { name: "课程助教", exact: true }).check();
  await page.getByRole("textbox", { name: "回复正文", exact: true }).fill("第十一条保存后立即定位");
  await page.getByRole("button", { name: "保存回复", exact: true }).click();
  await expect(page.getByText("共 11 条 · 第 2 页", { exact: true })).toBeVisible();
  await expect(page.locator(`#reply-${id(510)}`)).toBeFocused();
  await expect(page.getByText("第十一条保存后立即定位", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`reply=${id(510)}`));
  expect(focusQueries).toContain(id(510));
  const replyPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "讨论内容与回复", exact: true }) });
  await replyPanel.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByText("已有回复 10", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]reply=/);
});
