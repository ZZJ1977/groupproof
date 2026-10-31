import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { migrateWorkspace } from "../lib/versioning.ts";
import { canManageEvidence, decideEvidence, evidenceDecisionBlockReason, evidenceSourceChanged } from "../features/c/evidence-decisions.ts";

let passed = 0;
function check(message, actual, expected) { assert.deepEqual(actual, expected, message); passed += 1; }
function setup(actorId = "member-1") {
  let data = structuredClone(seedData);
  let failNext = false;
  const saved = [];
  const run = createCommandRunner({
    repository: {
      read: async () => structuredClone(data),
      save: async (next) => { if (failNext) { failNext = false; throw new Error("quota"); } data = structuredClone(next); },
    },
    currentActorId: () => actorId,
    now: () => "2026-10-11T13:00:00Z",
    onSaved: (next) => saved.push(next),
  });
  return { run, saved, get data() { return data; }, failNextSave() { failNext = true; }, migrate() { data = migrateWorkspace(data).data; } };
}
const adopt = { projectId: "project-1", evidenceId: "evidence-4", action: "adopt", reason: "截图覆盖首项验收标准", expectedVersion: 1, idempotencyKey: "adopt-1" };
const withdrawal = { ...adopt, action: "withdraw", reason: "已有新截图，旧证据撤回", expectedVersion: 2, idempotencyKey: "withdraw-1" };
const evidence = (s, id = adopt.evidenceId) => s.data.evidence.find((item) => item.id === id);

{
  const s = setup();
  evidence(s).sourceSnapshot = { source: "screenshot", record: { file: "immutable.png" } };
  const source = JSON.stringify(evidence(s).sourceSnapshot);
  const dRecords = JSON.stringify([s.data.verifications, s.data.contributions, s.data.notifications]);
  const originalLogs = s.data.logs.length;
  const [first, second] = await Promise.all([s.run(decideEvidence, adopt), s.run(decideEvidence, adopt)]);
  check("重复采纳返回成功", [first.ok, second.ok], [true, true]);
  check("同一采纳只有一条决策", evidence(s).cDecisionHistory.length, 1);
  check("同一采纳只有一条日志", s.data.logs.length, originalLogs + 1);
  check("采纳只增加一次版本", [evidence(s).status, evidence(s).version], ["formal", 2]);
  check("决策保留真实身份原因与前后版本", evidence(s).cDecisionHistory[0], {
    idempotencyKey: "adopt-1", action: "adopt", actorId: "member-1", reason: adopt.reason,
    expectedVersion: 1, resultVersion: 2, fromStatus: "candidate", toStatus: "formal", decidedAt: "2026-10-11T13:00:00Z",
  });
  check("复用提交标识改原因冲突", (await s.run(decideEvidence, { ...adopt, reason: "换原因" })).error.code, "VERSION_CONFLICT");
  check("复用提交标识改版本冲突", (await s.run(decideEvidence, { ...adopt, expectedVersion: 2 })).error.code, "VERSION_CONFLICT");
  check("复用提交标识改目标冲突", (await s.run(decideEvidence, { ...adopt, evidenceId: "evidence-6" })).error.code, "VERSION_CONFLICT");
  const [withdrawn, duplicate] = await Promise.all([s.run(decideEvidence, withdrawal), s.run(decideEvidence, withdrawal)]);
  check("重复撤回返回成功", [withdrawn.ok, duplicate.ok], [true, true]);
  check("撤回软保留并增加一次决策版本", [s.data.evidence.length, evidence(s).status, evidence(s).version, evidence(s).cDecisionHistory.length], [seedData.evidence.length, "withdrawn", 3, 2]);
  check("撤回只追加一次日志", s.data.logs.length, originalLogs + 2);
  check("任何决策都不改原来源快照", JSON.stringify(evidence(s).sourceSnapshot), source);
  check("历史采纳重试不能复活已撤回证据", (await s.run(decideEvidence, adopt)).result.status, "withdrawn");
  check("决策不伪造D验收贡献或通知", JSON.stringify([s.data.verifications, s.data.contributions, s.data.notifications]), dRecords);
  check("刷新后保留完整历史原因", JSON.parse(JSON.stringify(s.data)).evidence.find((item) => item.id === adopt.evidenceId).cDecisionHistory.map((item) => item.reason), [adopt.reason, withdrawal.reason]);
}

for (const actorId of ["member-1", "member-2", "teacher-1"]) {
  const s = setup(actorId);
  check("作者组长所属教师有资格", canManageEvidence(s.data, actorId, evidence(s)), true);
  check("作者组长所属教师可以采纳", (await s.run(decideEvidence, adopt)).ok, true);
  check("作者组长所属教师可以撤回", (await s.run(decideEvidence, withdrawal)).ok, true);
}
for (const actorId of ["member-3", "member-4", "member-5", "teacher-2", "ta-1", "admin-1", "missing"]) {
  const s = setup(actorId);
  const before = JSON.stringify(s.data);
  check("普通成员和外组角色不能决策", canManageEvidence(s.data, actorId, evidence(s)), false);
  check("绕过页面采纳也拒绝", (await s.run(decideEvidence, adopt)).error.code, "FORBIDDEN");
  check("拒绝决策不产生任何变化", JSON.stringify(s.data), before);
  check("绕过页面撤回也拒绝", (await s.run(decideEvidence, { ...withdrawal, evidenceId: "evidence-1", expectedVersion: 1 })).error.code, "FORBIDDEN");
}
for (const condition of ["unverified", "disabled", "archived", "finalized", "course-ended", "course-draft", "removed-member", "reassigned-teacher"]) {
  const s = setup(condition === "reassigned-teacher" ? "teacher-1" : "member-1");
  const project = s.data.projects.find((item) => item.id === "project-1");
  const actor = s.data.users.find((item) => item.id === "member-1");
  const course = s.data.courses.find((item) => item.id === "course-1");
  if (condition === "unverified") actor.verified = false;
  if (condition === "disabled") actor.status = "disabled";
  if (condition === "archived" || condition === "finalized") project.lifecycle = condition;
  if (condition === "course-ended" || condition === "course-draft") course.status = condition === "course-ended" ? "ended" : "draft";
  if (condition === "removed-member") project.memberIds = project.memberIds.filter((id) => id !== actor.id);
  if (condition === "reassigned-teacher") course.teacherId = "teacher-2";
  check("最新身份与生命周期边界拒绝", (await s.run(decideEvidence, adopt)).error.code, "FORBIDDEN");
}
for (const condition of ["unfrozen", "plan-unlocked", "source-changed", "missing-task", "cross-project-task", "no-criteria", "foreign-criterion", "already-formal", "withdrawn"]) {
  const s = setup();
  if (condition === "unfrozen") s.data.projects[0].setupStatus = "draft";
  if (condition === "plan-unlocked") s.data.projects[0].planConfirmed = false;
  if (condition === "source-changed") evidence(s).sourceChanged = true;
  if (condition === "missing-task") evidence(s).taskId = "missing";
  if (condition === "cross-project-task") s.data.tasks.find((item) => item.id === evidence(s).taskId).projectId = "project-2";
  if (condition === "no-criteria") evidence(s).criterionIds = [];
  if (condition === "foreign-criterion") evidence(s).criterionIds = ["task-1-ac-1"];
  if (condition === "already-formal") evidence(s).status = "formal";
  if (condition === "withdrawn") evidence(s).status = "withdrawn";
  check("非法采纳状态被命令拒绝", (await s.run(decideEvidence, adopt)).error.code, "INVALID_STATE");
  check("界面与命令采纳限制一致", Boolean(evidenceDecisionBlockReason(s.data, "member-1", evidence(s), "adopt")), true);
}
{
  const s = setup();
  s.migrate();
  check("已迁移的发布计划允许采纳", (await s.run(decideEvidence, adopt)).ok, true);
  const project = s.data.projects[0];
  const active = s.data.planRevisions.find((item) => item.id === project.activePlanRevisionId);
  s.data.planRevisions.push({ ...structuredClone(active), id: "unlocked-plan", number: active.number + 1, status: "draft" });
  check("旧planConfirmed不能绕过新草稿", (await s.run(decideEvidence, { ...adopt, evidenceId: "evidence-6", idempotencyKey: "new" })).error.code, "INVALID_STATE");
  project.planConfirmed = false;
  evidence(s).sourceChanged = true;
  check("解锁计划和来源变化不阻挡撤回旧正式证据", (await s.run(decideEvidence, withdrawal)).ok, true);
}
for (const condition of ["missing-active", "draft-active", "task-not-in-snapshot", "criterion-not-in-snapshot"]) {
  const s = setup(); s.migrate();
  const active = s.data.planRevisions.find((item) => item.id === s.data.projects[0].activePlanRevisionId);
  if (condition === "missing-active") s.data.projects[0].activePlanRevisionId = "missing";
  if (condition === "draft-active") active.status = "draft";
  if (condition === "task-not-in-snapshot") active.payload.tasks = active.payload.tasks.filter((item) => item.id !== "task-3");
  if (condition === "criterion-not-in-snapshot") active.payload.criteria = active.payload.criteria.filter((item) => item.id !== "task-3-ac-1");
  check("发布快照与证据范围必须一致", (await s.run(decideEvidence, adopt)).error.code, "INVALID_STATE");
}
{
  const s = setup();
  const before = JSON.stringify(s.data);
  s.failNextSave();
  check("保存失败明确返回错误", (await s.run(decideEvidence, adopt)).error.code, "STORAGE_ERROR");
  check("失败不改证据历史日志或状态", JSON.stringify(s.data), before);
  check("失败不回写缓存", s.saved.length, 0);
  check("保留原因与提交标识可重试", (await s.run(decideEvidence, adopt)).ok, true);
  s.failNextSave();
  check("撤回保存失败也是错误", (await s.run(decideEvidence, withdrawal)).error.code, "STORAGE_ERROR");
  check("撤回失败保持正式证据及原历史", [evidence(s).status, evidence(s).cDecisionHistory.length], ["formal", 1]);
  check("撤回同一提交可以重试", (await s.run(decideEvidence, withdrawal)).ok, true);
}
{
  const s = setup();
  const concurrent = await Promise.all([s.run(decideEvidence, adopt), s.run(decideEvidence, { ...adopt, idempotencyKey: "competing" })]);
  check("同版本竞争仅一次成功", concurrent.map((item) => item.ok), [true, false]);
  check("竞争版本返回409语义", concurrent[1].error.code, "VERSION_CONFLICT");
  check("竞争不追加第二次决策", evidence(s).cDecisionHistory.length, 1);
}
{
  const s = setup();
  for (const input of [{ ...adopt, reason: "   " }, { ...adopt, reason: "a".repeat(2001) }, { ...adopt, authorId: "teacher-1" }, { ...adopt, expectedVersion: -1 }, { ...adopt, idempotencyKey: "" }]) {
    check("缺原因或伪造身份输入拒绝", (await s.run(decideEvidence, input)).error.code, "VALIDATION_ERROR");
  }
  check("跨项目目标拒绝", (await s.run(decideEvidence, { ...adopt, projectId: "project-2" })).error.code, "NOT_FOUND");
  check("来源扩展字段缺省安全", evidenceSourceChanged(evidence(s)), false);
  evidence(s).sourceChanged = true;
  check("来源扩展字段被识别", evidenceSourceChanged(evidence(s)), true);
}
console.log(`C evidence decisions: ${passed} assertions passed.`);
