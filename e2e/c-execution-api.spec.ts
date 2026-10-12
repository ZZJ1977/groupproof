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
  tasks: [{ id: tid, title: "真实接口任务", status: "in_progress", can_associate: true, can_capture_evidence: true, criteria: [{ id: cid, text: "请求符合契约", version: 1 }] }],
  members: [{ id: aid, title: "成员甲" }], requirements: [{ id: id(411), title: "接口需求" }], modules: [{ id: id(412), title: "接口模块" }], milestones: [{ id: id(413), title: "首个里程碑" }],
};
const execution: Schema["TaskExecutionView"] = {
  task_id: tid, project_id: pid, status: "in_progress", progress: 30, version: 2, started_at: stamp, completed_at: null,
  responsible_ids: [aid], dependencies: [], project_progress: 30, module_progress: {}, can_start: false, can_update_progress: true, read_only: false,
};
const note: Schema["TaskNoteDTO"] = {
  id: id(414), project_id: pid, task_id: tid, lock_version: 1, current_version_no: 1,
  versions: [{ id: id(415), version_no: 1, title: "已有说明", body: "保留的说明原文", edited_by: aid, content_hash: "a".repeat(64), created_at: stamp }],
};
const evidence: Schema["EvidenceDetailDTO"] = {
  id: eid, project_id: pid, task_id: tid, author_id: aid, title: "契约验证候选", description: "真实来源的候选说明", source_type: "manual", source_url: null, status: "candidate", criterion_ids: [cid], source_changed: false, lock_version: 1, created_at: stamp, updated_at: stamp, effective: false, original_snapshot_id: id(416),
  source_snapshots: [{ id: id(416), version_no: 1, source_identity: "manual", source_revision: "1", content_hash: "b".repeat(64), content: { title: "不可变原始标题", body: "不可变原文" }, created_at: stamp }], decisions: [],
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
  await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, execution));
}

test("C2 start/progress use server permissions and CAS; 100 percent retains in-progress and history URL", async ({ page }) => {
  await setup(page);
  let state = { ...execution, status: "not_started" as Schema["TaskExecutionView"]["status"], progress: 0, version: 0, can_start: true, can_update_progress: false };
  await page.route(`**/api/v1/tasks/${tid}/execution`, (route) => success(route, state));
  await page.route(`**/api/v1/tasks/${tid}/start`, (route) => { expect(route.request().postDataJSON()).toEqual({ expected_version: 0 }); state = { ...state, status: "in_progress", version: 1, can_start: false, can_update_progress: true }; return success(route, state); });
  await page.route(`**/api/v1/tasks/${tid}/progress`, (route) => { expect(route.request().postDataJSON()).toEqual({ expected_version: 1, progress: 100, reason: "完成当前实现" }); state = { ...state, progress: 100, version: 2 }; return success(route, state); });
  await page.route(`**${base}/tasks/${tid}/progress-history?**`, (route) => success(route, { items: [{ id: id(417), actor_name: "成员甲", from_status: "in_progress", to_status: "in_progress", progress_before: 0, progress_after: 100, reason: "真实进度历史", created_at: stamp }], page: 1, page_size: 10, total: 1 } satisfies Schema["ProgressHistoryPageDTO"]));
  await page.route(`**${base}/discussions?**`, (route) => { expect(new URL(route.request().url()).searchParams.get("task_id")).toBe(tid); return success(route, { items: [], page: 1, page_size: 10, total: 0 }); });
  await page.goto(`/projects/${pid}/tasks/${tid}`);
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

test("C3 manual candidate validates URL, captures selected criteria, and adopts/withdraws without changing snapshots", async ({ page }) => {
  await setup(page);
  let item = structuredClone(evidence), added = false;
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
  await expect(page.getByText("不可变原始标题\n不可变原文", { exact: true })).toBeVisible();
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
