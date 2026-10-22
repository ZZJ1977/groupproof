import { expect, test, type Page, type Route } from "@playwright/test";
import type { components } from "../packages/domain/api.generated";

// Authorized HTTP fixtures, not a live external SourcePort or real vendor credentials.
type Schema = components["schemas"];
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const pid = id(901), eid = id(902), sid = id(903), aid = id(904), tid = id(905), cid = id(906), original = id(907), former = id(908);
const stamp = "2026-10-14T08:00:00Z";
const base = `/api/v1/projects/${pid}`;
const context: Schema["CProjectContextDTO"] = {
  project: { id: pid, name: "授权来源核对项目", lifecycle: "active", setup_status: "frozen" },
  actor: { id: aid, is_member: true, is_leader: false, is_teacher: false },
  permissions: { can_manage_activity: true, can_manage_files: true, can_discuss: true, can_capture_evidence: true },
  tasks: [{ id: tid, title: "核对来源任务", status: "in_progress", can_associate: true, can_capture_evidence: true, criteria: [{ id: cid, text: "来源可核对", version: 1 }] }],
  members: [{ id: aid, title: "当前成员" }], evidence_authors: [{ id: aid, title: "当前成员" }, { id: former, title: "历史证据作者" }], requirements: [], modules: [], milestones: [],
};
const evidence: Schema["EvidenceDetailDTO"] = {
  id: eid, project_id: pid, task_id: tid, author_id: aid, title: "原始来源证据", description: "已保存的来源材料", source_type: "feishu", source_url: "https://example.feishu.cn/wiki/original", status: "formal", criterion_ids: [cid], source_changed: false, lock_version: 2, created_at: stamp, updated_at: stamp, effective: true, original_snapshot_id: original,
  source_snapshots: [
    { id: id(909), version_no: 2, source_identity: "document-original", source_revision: "r2", content_hash: "b".repeat(64), content: { source_id: id(999), availability: "available", source: { body: "第二版保存内容" } }, created_at: stamp },
    { id: original, version_no: 1, source_identity: "document-original", source_revision: "r1", content_hash: "a".repeat(64), content: { source_id: sid, availability: "available", source: { body: "第一版不可变内容" } }, created_at: stamp },
  ], decisions: [],
};
const success = (route: Route, data: unknown) => route.fulfill({ json: { data, meta: { request_id: "source-contract-fixture" } } });
const failure = (route: Route, status: number) => route.fulfill({ status, json: { error: { code: status === 503 ? "EXTERNAL_SOURCE_UNAVAILABLE" : status === 409 ? "VERSION_CONFLICT" : "EVIDENCE_DECISION_DENIED", message: "Source fixture failure" }, meta: { request_id: "source-failure" } } });
async function setup(page: Page, getEvidence: () => Schema["EvidenceDetailDTO"] = () => evidence, getContext: () => Schema["CProjectContextDTO"] = () => context) {
  await page.route(`**${base}/c-context`, (route) => success(route, getContext()));
  await page.route(`**${base}/evidence?**`, (route) => success(route, { items: [getEvidence()], page: 1, page_size: 10, total: 1, offset: 0, limit: 10 } satisfies Schema["EvidencePageDTO"]));
  await page.route(`**${base}/evidence/${eid}`, (route) => success(route, getEvidence()));
}
async function begin(page: Page) {
  await page.goto(`/projects/${pid}/evidence?evidence=${eid}`);
  await page.getByRole("button", { name: "检查证据来源", exact: true }).click();
}

test("C3 source check uses the original snapshot, explicit reason and CAS; changed sources retain history", async ({ page }) => {
  let current = structuredClone(evidence);
  await setup(page, () => current);
  const writes: { body: Schema["CheckEvidenceSource"]; key?: string }[] = [];
  await page.route(`**${base}/evidence/${eid}/check-source`, async (route) => {
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    current = { ...current, source_changed: true, effective: false, lock_version: 3 };
    await success(route, current);
  });
  await begin(page);
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.getByText("请填写本次来源检查的原因。", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("textbox", { name: "来源检查原因", exact: true }).fill("核对飞书编辑后的原始来源");
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.getByText("来源检查完成：该证据标记为来源已变化，不计入有效证据；原快照仍保留。", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({ source_id: sid, expected_version: 2, reason: "核对飞书编辑后的原始来源" });
  expect(writes[0].key).toBeTruthy();
  await page.locator("summary").filter({ hasText: "快照 v1" }).click();
  await expect(page.getByText("第一版不可变内容", { exact: true })).toBeVisible();
  await expect(page.getByText("当前不计入有效证据", { exact: true })).toBeVisible();
  await expect(page.getByText(sid, { exact: true })).toHaveCount(0);
});

test("C3 unavailable provider preserves reason and the exact retry key, without faking a completed check", async ({ page }) => {
  await setup(page);
  const writes: { body: unknown; key?: string }[] = [];
  await page.route(`**${base}/evidence/${eid}/check-source`, (route) => {
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    return writes.length === 1 ? failure(route, 503) : success(route, evidence);
  });
  await begin(page);
  await page.getByRole("textbox", { name: "来源检查原因", exact: true }).fill("来源未连通时保留核对理由");
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("服务暂不可用");
  await expect(page.getByRole("textbox", { name: "来源检查原因", exact: true })).toHaveValue("来源未连通时保留核对理由");
  await expect(page.getByText(/来源检查完成：/)).toHaveCount(0);
  await expect(page.getByText("当前可用于有效证据查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.getByText("来源检查完成：与已保存的来源快照一致。", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
});

test("C3 source-check conflict requires explicit version acknowledgement and preserves the reason", async ({ page }) => {
  let current = structuredClone(evidence);
  await setup(page, () => current);
  const writes: { body: Schema["CheckEvidenceSource"]; key?: string }[] = [];
  await page.route(`**${base}/evidence/${eid}/check-source`, (route) => {
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    current = { ...current, lock_version: 3 };
    return writes.length === 1 ? failure(route, 409) : success(route, current);
  });
  await begin(page);
  await page.getByRole("textbox", { name: "来源检查原因", exact: true }).fill("保留检查版本冲突的理由");
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认检查来源", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新并核对证据", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "来源检查原因", exact: true })).toHaveValue("保留检查版本冲突的理由");
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.getByText("来源检查完成：与已保存的来源快照一致。", { exact: true })).toBeVisible();
  expect(writes.map((entry) => entry.body.expected_version)).toEqual([2, 3]);
  expect(writes[1].key).not.toBe(writes[0].key);
  expect(writes[1].body.source_id).toBe(sid);
});

test("C3 source-check eligibility follows author/leader/teacher and project write permission", async ({ page }) => {
  let currentContext = { ...context, actor: { ...context.actor, id: former } };
  await setup(page, () => evidence, () => currentContext);
  await page.goto(`/projects/${pid}/evidence?evidence=${eid}`);
  await expect(page.getByRole("heading", { name: "原始来源证据", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toHaveCount(0);
  currentContext = { ...currentContext, actor: { ...currentContext.actor, is_leader: true } };
  await page.getByRole("button", { name: "刷新证据", exact: true }).click();
  await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toBeVisible();
  currentContext = { ...currentContext, actor: { ...currentContext.actor, is_leader: false, is_teacher: true } };
  await page.getByRole("button", { name: "刷新证据", exact: true }).click();
  await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toBeVisible();
  currentContext = { ...currentContext, permissions: { ...currentContext.permissions, can_capture_evidence: false } };
  await page.getByRole("button", { name: "刷新证据", exact: true }).click();
  await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toHaveCount(0);
});

test("C3 source-check permission loss hides both protected data and the draft", async ({ page }) => {
  await setup(page);
  await page.route(`**${base}/evidence/${eid}/check-source`, (route) => failure(route, 403));
  await begin(page);
  await page.getByRole("textbox", { name: "来源检查原因", exact: true }).fill("失权后应隐藏的理由");
  await page.getByRole("button", { name: "确认检查来源", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("当前访问权限已失效");
  await expect(page.getByText("原始来源证据", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "来源检查原因", exact: true })).toHaveCount(0);
});

test("C3 never substitutes a latest or URL source ID for a missing original; historical authors remain filterable", async ({ page }) => {
  const missing = { ...evidence, source_snapshots: evidence.source_snapshots.filter((snapshot) => snapshot.version_no !== 1) };
  await setup(page, () => missing);
  await page.goto(`/projects/${pid}/evidence?evidence=${eid}&source_id=${sid}&author=${former}`);
  await expect(page.getByText("原始来源标识不完整，暂不能检查来源；请刷新详情后重试。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "证据作者", exact: true })).toHaveValue(former);
  await expect(page.getByRole("combobox", { name: "证据作者", exact: true }).locator("option").filter({ hasText: "历史证据作者" })).toHaveCount(1);
  await page.getByRole("button", { name: "查询证据", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`author=${former}`));
  await page.reload();
  await expect(page.getByRole("combobox", { name: "证据作者", exact: true })).toHaveValue(former);
});

for (const linked of [true, false]) test(`C4 changed activity ${linked ? "links to its evidence" : "opens scoped evidence search without claiming a binding"}; source-page authors do not depend on membership`, async ({ page }) => {
  await setup(page);
  const activity: Schema["ActivityDTO"] = {
    record_id: id(910), project_id: pid, group_id: "authorized-group", source_type: "feishu", source_id: sid, status: "adopted", task_id: tid, evidence_id: linked ? eid : null, lock_version: 1,
    title: "发生变化的来源活动", summary: "新来源内容", author_id: former, author_name: "授权来源中的历史作者", occurred_at: stamp, kind: "document", source_identity: "document-original", source_revision: "r3", source_url: "https://example.feishu.cn/wiki/original", availability: "available", source_changed: true, suggested_task_ids: [],
  };
  await page.route(`**${base}/activities/feishu**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/history")) return success(route, { record_id: activity.record_id, project_id: pid, source_type: "feishu", source_id: sid, status: "adopted", task_id: tid, evidence_id: activity.evidence_id, lock_version: 1, decisions: [] } satisfies Schema["ActivityHistoryDTO"]);
    if (path.endsWith(`/${sid}`)) return success(route, activity);
    return success(route, { items: [activity], page: 1, page_size: 10, total: 1 } satisfies Schema["ActivityPageDTO"]);
  });
  let writes = 0;
  await page.route(`**${base}/evidence/${eid}/check-source`, (route) => { writes++; return success(route, evidence); });
  await page.goto(`/projects/${pid}/collaboration?record=${sid}&author=${former}`);
  await expect(page.getByRole("combobox", { name: "记录作者", exact: true })).toHaveValue(former);
  await expect(page.getByRole("combobox", { name: "记录作者", exact: true }).locator("option").filter({ hasText: "授权来源中的历史作者" })).toHaveCount(1);
  const link = page.getByRole("link", { name: linked ? "查看关联证据并检查来源" : "到证据中心查找相关来源", exact: true });
  await expect(link).toHaveAttribute("href", linked ? `/projects/${pid}/evidence?evidence=${eid}` : `/projects/${pid}/evidence?source=feishu&task=${tid}`);
  await link.click();
  if (!linked) {
    await expect(page.getByRole("combobox", { name: "证据来源", exact: true })).toHaveValue("feishu");
    await expect(page.getByRole("combobox", { name: "证据所属任务", exact: true })).toHaveValue(tid);
    await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "查看证据历史", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "检查证据来源", exact: true })).toBeVisible();
  expect(writes).toBe(0);
});
