import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import {
  confirmAssignmentSelf,
  createPlanDraft,
  forcePublishPlan,
  publishPlan,
  savePlanDraft,
  unlockPlan,
  validatePlan,
} from "../lib/commands/plan.ts";
import { activePlan, confirmedUserIds, draftPlan } from "../lib/versioning.ts";

let passed = 0;
function check(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  passed += 1;
}
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
}

function memoryRepository(initial) {
  let data = structuredClone(initial);
  return {
    read: async () => structuredClone(data),
    save: async (next) => { data = structuredClone(next); },
    get data() { return data; },
    set data(value) { data = structuredClone(value); },
  };
}

function setup({ actorId = "member-1" } = {}) {
  const repo = memoryRepository(seedData);
  const state = { actor: actorId, logSeq: 0 };
  const run = createCommandRunner({
    repository: repo,
    currentActorId: () => state.actor,
    now: () => "2026-10-06T12:00:00.000Z",
    makeLogId: () => `log-plan-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const version = (repo) => repo.data.projects.find((item) => item.id === "project-1").version;
const BASELINE = "baseline-project-1-legacy";
const task = (overrides = {}) => ({
  id: "tp-a", projectId: "project-1", moduleId: "module-1", requirementIds: ["req-1"],
  title: "T-01 账号体系", description: "", responsibleIds: ["member-1"], priority: "high",
  weight: 60, status: "not_started", progress: 0, milestoneIds: ["milestone-1"],
  criterionIds: ["tp-a-ac-1"], dependencyIds: [], version: 1, updatedAt: "2026-10-06T00:00:00Z", ...overrides,
});
const validPayload = (overrides = {}) => ({
  tasks: [task(), task({ id: "tp-b", moduleId: "module-2", requirementIds: ["req-2"], title: "T-02 基线工具", responsibleIds: ["member-2"], priority: "medium", weight: 40, criterionIds: ["tp-b-ac-1"], dependencyIds: ["tp-a"] })],
  criteria: [
    { id: "tp-a-ac-1", taskId: "tp-a", text: "登录流程可用", version: 1, humanConfirmedBy: [] },
    { id: "tp-b-ac-1", taskId: "tp-b", text: "基线可冻结", version: 1, humanConfirmedBy: [] },
  ],
  milestoneLinks: [{ taskId: "tp-a", milestoneIds: ["milestone-1"] }, { taskId: "tp-b", milestoneIds: [] }],
  ...overrides,
});
const codes = (payload) => validatePlan(payload, seedData.baselineRevisions.find((item) => item.id === BASELINE).payload, ["member-1", "member-2", "member-3", "member-4"]).map((item) => item.code);
const has = (list, code) => list.includes(code);

// ── validatePlan：权重与完整性 ───────────────────────────────────
{
  ok("合法计划无校验问题", codes(validPayload()).length === 0);
  ok("顶层权重≠100 被识别", has(codes(validPayload({ tasks: [task({ weight: 55 }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "root_weight_total"));
  ok("非整数权重被识别", has(codes(validPayload({ tasks: [task({ weight: 10.5 }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "weight_not_integer"));
  const withChild = validPayload({ tasks: [task(), task({ id: "tp-child", parentTaskId: "tp-a", weight: 50, criterionIds: ["tp-child-ac-1"], responsibleIds: ["member-3"], moduleId: "module-1", requirementIds: ["req-1"], title: "T-01.1", dependencyIds: [] })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-child-ac-1", taskId: "tp-child", text: "c", version: 1, humanConfirmedBy: [] }] });
  ok("子任务权重合计≠父权重被识别", has(codes(withChild), "child_weight_total"));
  ok("无负责人被识别", has(codes(validPayload({ tasks: [task({ responsibleIds: [] }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "missing_responsible"));
  ok("无验收标准被识别", has(codes(validPayload({ criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }] })), "missing_criteria"));
  ok("无效负责人被识别", has(codes(validPayload({ tasks: [task({ responsibleIds: ["ghost-9"] }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "invalid_responsible"));
}

// ── validatePlan：引用与环 ───────────────────────────────────────
{
  ok("自依赖被识别", has(codes(validPayload({ tasks: [task({ dependencyIds: ["tp-a"] }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02", dependencyIds: [] })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "self_dependency"));
  ok("依赖环被识别", has(codes(validPayload({ tasks: [task({ dependencyIds: ["tp-b"] }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02", dependencyIds: ["tp-a"] })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "dependency_cycle"));
  ok("父子环被识别", has(codes(validPayload({ tasks: [task({ parentTaskId: "tp-b" }), task({ id: "tp-b", parentTaskId: "tp-a", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02", dependencyIds: [] })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "parent_cycle"));
  ok("自引用父任务被识别", has(codes(validPayload({ tasks: [task({ parentTaskId: "tp-a" }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "self_reference"));
  ok("跨项目引用被识别", has(codes(validPayload({ tasks: [task(), task({ id: "tp-b", projectId: "project-2", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "cross_project_ref"));
  ok("悬空验收标准被识别", has(codes(validPayload({ criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "ghost-ac", taskId: "ghost", text: "x", version: 1, humanConfirmedBy: [] }] })), "dangling_criterion"));
  ok("基线外模块被识别", has(codes(validPayload({ tasks: [task({ moduleId: "module-999" }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] })), "unknown_module"));
}

// ── 草稿：创建/保存硬校验/确认失效与持久 ──────────────────────────
{
  const { repo, state, run } = setup({ actorId: "member-1" });
  const created = await run(createPlanDraft, { projectId: "project-1", baselineRevisionId: BASELINE, expectedVersion: version(repo) });
  ok("创建计划草稿成功", created.ok === true);
  check("草稿绑定已发布基线", created.result.baselineRevisionId, BASELINE);

  const hardBad = validPayload({ tasks: [task({ dependencyIds: ["tp-b"] }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02", dependencyIds: ["tp-a"] })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] });
  const rejected = await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: hardBad, expectedVersion: version(repo) });
  ok("硬性引用错误（依赖环）保存被拒绝", rejected.ok === false && rejected.error.code === "VALIDATION_ERROR");

  const saved = await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: validPayload(), expectedVersion: version(repo) });
  ok("合法草稿保存成功", saved.ok === true);
  check("保存递增内容版本", saved.result.contentVersion, 2);

  state.actor = "member-2";
  const confirm = await run(confirmAssignmentSelf, { projectId: "project-1", revisionId: created.result.id, contentVersion: 2, expectedVersion: version(repo) });
  ok("成员确认分配成功", confirm.ok === true);
  const repeat = await run(confirmAssignmentSelf, { projectId: "project-1", revisionId: created.result.id, contentVersion: 2, expectedVersion: version(repo) });
  check("重复确认不重复签名", repeat.result.confirmations.length, 1);
  check("确认持久化于版本记录", confirmedUserIds(repo.data.planRevisions.find((item) => item.id === created.result.id)), ["member-2"]);

  state.actor = "member-1";
  const stale = await run(confirmAssignmentSelf, { projectId: "project-1", revisionId: created.result.id, contentVersion: 1, expectedVersion: version(repo) });
  ok("过期内容版本确认被拒绝", stale.ok === false && stale.error.code === "INVALID_STATE");

  const changed = await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: validPayload(), expectedVersion: version(repo) });
  check("保存后旧确认失效", changed.result.confirmations, []);
}

// ── 发布：资格、确认、结构校验、投影、例外、解锁 ────────────────────
{
  const { repo, state, run } = setup({ actorId: "member-1" });
  const created = await run(createPlanDraft, { projectId: "project-1", baselineRevisionId: BASELINE, expectedVersion: version(repo) });
  await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: validPayload(), expectedVersion: version(repo) });

  state.actor = "member-2";
  const byMember = await run(publishPlan, { projectId: "project-1", revisionId: created.result.id, expectedVersion: version(repo) });
  ok("非组长不能发布", byMember.ok === false && byMember.error.code === "FORBIDDEN");

  state.actor = "member-1";
  const early = await run(publishPlan, { projectId: "project-1", revisionId: created.result.id, expectedVersion: version(repo) });
  ok("缺确认时正常发布拒绝", early.ok === false && early.error.code === "INVALID_STATE");

  // 结构校验在例外发布时同样执行
  await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: validPayload({ tasks: [task({ weight: 30 }), task({ id: "tp-b", weight: 40, criterionIds: ["tp-b-ac-1"], responsibleIds: ["member-2"], moduleId: "module-2", requirementIds: ["req-2"], title: "T-02" })], criteria: [{ id: "tp-a-ac-1", taskId: "tp-a", text: "a", version: 1, humanConfirmedBy: [] }, { id: "tp-b-ac-1", taskId: "tp-b", text: "b", version: 1, humanConfirmedBy: [] }] }), expectedVersion: version(repo) });
  const forcedBad = await run(forcePublishPlan, { projectId: "project-1", revisionId: created.result.id, reason: "赶进度", expectedVersion: version(repo) });
  ok("例外发布不绕过结构校验", forcedBad.ok === false && forcedBad.error.code === "INVALID_STATE");
  const noReason = await run(forcePublishPlan, { projectId: "project-1", revisionId: created.result.id, reason: "", expectedVersion: version(repo) });
  ok("例外发布须有原因", noReason.ok === false && noReason.error.code === "VALIDATION_ERROR");

  await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: validPayload(), expectedVersion: version(repo) });
  state.actor = "member-1";
  await run(confirmAssignmentSelf, { projectId: "project-1", revisionId: created.result.id, contentVersion: 4, expectedVersion: version(repo) });
  const forced = await run(forcePublishPlan, { projectId: "project-1", revisionId: created.result.id, reason: "临近截止，先行发布", expectedVersion: version(repo) });
  ok("例外发布成功", forced.ok === true);
  check("例外发布保留真实签名", confirmedUserIds(forced.result), ["member-1"]);
  ok("例外发布记录未确认名单", repo.data.logs.at(-1).detail.includes("member-2") && repo.data.logs.at(-1).detail.includes("临近截止"));
  const project = repo.data.projects.find((item) => item.id === "project-1");
  check("发布后计划确认", project.planConfirmed, true);
  check("生效计划指针", project.activePlanRevisionId, created.result.id);
  const taskIds = repo.data.tasks.filter((item) => item.projectId === "project-1").map((item) => item.id).sort();
  check("投影任务集合与草稿一致且无重复", taskIds, ["tp-a", "tp-b"]);
  const criteriaIds = repo.data.criteria.filter((item) => ["tp-a", "tp-b"].includes(item.taskId)).map((item) => item.id).sort();
  check("无悬空标准 ID", criteriaIds, ["tp-a-ac-1", "tp-b-ac-1"]);

  state.actor = "member-2";
  const unlockByMember = await run(unlockPlan, { projectId: "project-1", expectedVersion: version(repo) });
  ok("非组长不能解锁", unlockByMember.ok === false && unlockByMember.error.code === "FORBIDDEN");
  state.actor = "member-1";
  const unlocked = await run(unlockPlan, { projectId: "project-1", expectedVersion: version(repo) });
  ok("组长解锁创建新草稿", unlocked.ok === true);
  check("新草稿编号递增", unlocked.result.number, forced.result.number + 1);
  ok("旧正式计划保留", repo.data.planRevisions.some((item) => item.id === created.result.id && item.status === "published"));
  check("解锁后计划待确认", repo.data.projects.find((item) => item.id === "project-1").planConfirmed, false);
  ok("执行视图读取同一正式计划", activePlan(repo.data, "project-1")?.id === created.result.id);
  ok("草稿可被规划页读取", draftPlan(repo.data, "project-1")?.id === unlocked.result.id);
}

// ── 发布必须基于仍生效的基线 ─────────────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const created = await run(createPlanDraft, { projectId: "project-1", baselineRevisionId: BASELINE, expectedVersion: version(repo) });
  await run(savePlanDraft, { projectId: "project-1", revisionId: created.result.id, payload: validPayload(), expectedVersion: version(repo) });
  const data = repo.data;
  repo.data = {
    ...data,
    projects: data.projects.map((item) => item.id === "project-1" ? { ...item, activeBaselineRevisionId: "baseline-other" } : item),
  };
  const outcome = await run(publishPlan, { projectId: "project-1", revisionId: created.result.id, expectedVersion: version(repo) });
  ok("基线失效后计划不能发布", outcome.ok === false && outcome.error.code === "INVALID_STATE");
}

console.log(`任务规划与发布检查通过：${passed} 项断言全部符合预期。`);
