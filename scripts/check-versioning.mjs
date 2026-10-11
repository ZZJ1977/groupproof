import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import {
  CURRENT_SCHEMA_VERSION,
  activeBaseline,
  activePlan,
  applyContentChange,
  applyMemberRoster,
  confirmationsComplete,
  confirmMember,
  confirmedUserIds,
  draftBaseline,
  draftPlan,
  migrateWorkspace,
  validateWorkspace,
} from "../lib/versioning.ts";

let passed = 0;
function check(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  passed += 1;
}
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
}

/** 模拟旧浏览器数据：缺 schemaVersion 与全部新集合/新字段 */
function oldWorkspace() {
  const raw = structuredClone(seedData);
  delete raw.schemaVersion;
  delete raw.baselineRevisions;
  delete raw.planRevisions;
  delete raw.courseRuleRevisions;
  delete raw.ruleChangeReviews;
  raw.projects = raw.projects.map((project) => {
    const { activeBaselineRevisionId, activePlanRevisionId, appliedCourseRuleRevisionId, sourceProjectId, ...rest } = project;
    return rest;
  });
  return raw;
}

// ── 迁移：幂等、不修改输入、旧字段保留 ─────────────────────────────
const raw = oldWorkspace();
const rawBefore = JSON.stringify(raw);
const first = migrateWorkspace(raw);
ok("旧数据迁移成功并报告 migrated", first.migrated === true);
check("迁移不修改传入对象", JSON.stringify(raw), rawBefore);
check("迁移后 schemaVersion 为当前版本", first.data.schemaVersion, CURRENT_SCHEMA_VERSION);

const second = migrateWorkspace(first.data);
ok("重复迁移不再变更（幂等）", second.migrated === false);
check("重复读取不增加基线快照", second.data.baselineRevisions.length, first.data.baselineRevisions.length);
check("重复读取不增加计划快照", second.data.planRevisions.length, first.data.planRevisions.length);
check("重复读取不增加课程规则快照", second.data.courseRuleRevisions.length, first.data.courseRuleRevisions.length);
check("重复读取不改变修订编号", second.data.baselineRevisions.map((item) => item.number), first.data.baselineRevisions.map((item) => item.number));
check("重复读取不改变内容版本", second.data.baselineRevisions.map((item) => item.contentVersion), first.data.baselineRevisions.map((item) => item.contentVersion));

// ── 迁移：旧状态恢复、关联 ID 与历史数据保留 ──────────────────────
check("迁移后项目业务 ID 保留", first.data.projects.map((item) => item.id), raw.projects.map((item) => item.id));
check("迁移后任务业务 ID 保留", first.data.tasks.map((item) => item.id), raw.tasks.map((item) => item.id));
check("迁移后旧 confirmedBy 字段仍可读取", first.data.projects.find((item) => item.id === "project-1").confirmedBy, raw.projects.find((item) => item.id === "project-1").confirmedBy);
const migratedProject1 = first.data.projects.find((item) => item.id === "project-1");
ok("frozen 项目建立初始基线快照", Boolean(migratedProject1.activeBaselineRevisionId));
ok("planConfirmed 项目建立初始计划快照", Boolean(migratedProject1.activePlanRevisionId));
ok("项目记录已应用课程规则版本", Boolean(migratedProject1.appliedCourseRuleRevisionId));

const legacyBaseline = first.data.baselineRevisions.find((item) => item.id === migratedProject1.activeBaselineRevisionId);
check("旧基线保留已发布状态", legacyBaseline.status, "published");
check("旧 confirmedBy 存入 legacy 确认人", legacyBaseline.legacy.confirmedUserIds, raw.projects.find((item) => item.id === "project-1").confirmedBy);
check("历史确认标记时间未知", legacyBaseline.legacy.timestampUnknown, true);
check("不为历史确认伪造 MemberConfirmation", legacyBaseline.confirmations, []);
ok("基线快照保留需求关联", legacyBaseline.payload.requirements.every((item) => item.projectId === "project-1"));
const legacyPlan = first.data.planRevisions.find((item) => item.id === migratedProject1.activePlanRevisionId);
check("计划快照链接基线快照", legacyPlan.baselineRevisionId, legacyBaseline.id);
check("计划快照保留任务业务 ID", legacyPlan.payload.tasks.map((item) => item.id), raw.tasks.filter((item) => item.projectId === "project-1").map((item) => item.id));
check("历史计划确认不伪造时间", legacyPlan.confirmations, []);

// ── 草稿与正式快照分离 ───────────────────────────────────────────
const published = activeBaseline(first.data, "project-1");
const publishedBefore = JSON.stringify(published);
const draft = { ...structuredClone(published), id: "baseline-project-1-draft", status: "draft", basedOnRevisionId: published.id };
const edited = applyContentChange(draft, { ...draft.payload, requirements: [] });
check("修改草稿不改变正式快照", JSON.stringify(activeBaseline(first.data, "project-1")), publishedBefore);
check("草稿内容版本递增", edited.contentVersion, draft.contentVersion + 1);
check("内容修改清空旧确认", edited.confirmations, []);
check("内容修改后回到草稿态", edited.status, "draft");
ok("内容版本与并发版本分别递增", edited.version === draft.version + 1 && edited.contentVersion === draft.contentVersion + 1);

// ── 确认绑定 revisionId + contentVersion + memberRoster ───────────
const confirming = { ...draft, status: "confirming", confirmations: [] };
const once = confirmMember(confirming, "member-1", "2026-10-06T10:00:00Z");
check("重复个人确认不产生重复记录", confirmMember(once, "member-1", "2026-10-06T11:00:00Z").confirmations.length, 1);
check("普通确认不改变内容版本", once.contentVersion, confirming.contentVersion);
ok("普通确认增加实体并发版本", once.version === confirming.version + 1);
const stale = { ...confirming, confirmations: [{ userId: "member-1", revisionId: confirming.id, contentVersion: confirming.contentVersion - 1, confirmedAt: "2026-10-05T00:00:00Z" }] };
check("确认旧 contentVersion 不计入完成", confirmationsComplete(stale), false);
check("旧内容版本确认不视为该成员已确认", confirmedUserIds(stale), []);

const all = confirming.memberRoster.reduce((revision, userId) => confirmMember(revision, userId, "2026-10-06T10:00:00Z"), confirming);
check("全员有效确认后确认完成", confirmationsComplete(all), true);
const rosterChanged = applyMemberRoster(all, [...all.memberRoster, "member-99"]);
check("名单变化后旧确认失效", confirmationsComplete(rosterChanged), false);
check("名单变化清空确认记录", rosterChanged.confirmations, []);
check("名单未变时保持原修订", applyMemberRoster(all, [...all.memberRoster]), all);
check("空名单不算确认完成", confirmationsComplete({ ...confirming, memberRoster: [] }), false);

// ── 选择器 ───────────────────────────────────────────────────────
check("activeBaseline 读取生效版本", activeBaseline(first.data, "project-1")?.id, migratedProject1.activeBaselineRevisionId);
check("activePlan 读取生效计划", activePlan(first.data, "project-1")?.id, migratedProject1.activePlanRevisionId);
check("无草稿时 draftBaseline 为空", draftBaseline(first.data, "project-1"), undefined);
const withDraft = structuredClone(first.data);
withDraft.baselineRevisions.push({ ...draft, number: 2 });
check("draftBaseline 读取最新待确认草稿", draftBaseline(withDraft, "project-1")?.id, "baseline-project-1-draft");
const withPlanDraft = structuredClone(first.data);
withPlanDraft.planRevisions.push({ ...structuredClone(legacyPlan), id: "plan-project-1-draft", status: "draft", number: 4 });
check("draftPlan 读取计划草稿", draftPlan(withPlanDraft, "project-1")?.id, "plan-project-1-draft");

// ── 格式错误：报告并保留原始数据（不改写输入） ────────────────────
ok("缺失集合报告格式错误", Boolean(migrateWorkspace({ users: [] }).error));
ok("非对象报告格式错误", Boolean(migrateWorkspace(null).error));
ok("字段类型错误报告格式错误", Boolean(migrateWorkspace({ users: "bad", courses: [], groups: [], projects: [], tasks: [], requirements: [] }).error));
check("格式正确时校验通过", validateWorkspace(raw), { ok: true });

console.log(`版本模型检查通过：${passed} 项断言全部符合预期。`);
