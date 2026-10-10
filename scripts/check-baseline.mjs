import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import {
  compareBaselines,
  confirmBaselineSelf,
  createBaselineDraft,
  forcePublishBaseline,
  getBaselineHistory,
  publishBaseline,
  saveBaselineDraft,
  submitBaselineForConfirmation,
} from "../lib/commands/baseline.ts";
import { activeBaseline, confirmationsComplete, confirmedUserIds, draftBaseline } from "../lib/versioning.ts";

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
    makeLogId: () => `log-base-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const projectVersion = (repo, projectId = "project-1") => repo.data.projects.find((item) => item.id === projectId).version;
const payloadOf = (revision, overrides = {}) => ({ ...structuredClone(revision.payload), ...overrides });
const moveRequirement = (revision, requirementId, moduleId) => payloadOf(revision, {
  requirements: revision.payload.requirements.map((item) => item.id === requirementId ? { ...item, moduleId } : item),
});

// ── 草稿修改不改变已发布 v1 的 payload ────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const publishedBefore = JSON.stringify(activeBaseline(repo.data, "project-1"));
  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  ok("成员可创建变更草稿", created.ok === true);
  ok("草稿基于当前正式版本", created.result.basedOnRevisionId === activeBaseline(repo.data, "project-1").id);

  const draft = created.result;
  const edited = moveRequirement(draft, "req-1", draft.payload.modules[0].id);
  edited.requirements = edited.requirements.map((item) => item.id === "req-1" ? { ...item, title: "登录与身份（修订）" } : item);
  const saved = await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: edited, reason: "调整登录需求", expectedVersion: projectVersion(repo) });
  ok("草稿保存成功", saved.ok === true);
  check("草稿内容版本递增", saved.result.contentVersion, 2);
  check("草稿修改不改变已发布 v1", JSON.stringify(activeBaseline(repo.data, "project-1")), publishedBefore);
  ok("草稿记录变更原因", saved.result.reason === "调整登录需求");
}

// ── 其他项目的模块/文件不能作为关联输入 ───────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  const draft = created.result;

  const badRequirement = payloadOf(draft, {
    requirements: draft.payload.requirements.map((item) => item.id === "req-1" ? { ...item, projectId: "project-2" } : item),
  });
  const crossProject = await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: badRequirement, reason: "越权关联", expectedVersion: projectVersion(repo) });
  ok("其他项目需求被拒绝", crossProject.ok === false && crossProject.error.code === "VALIDATION_ERROR");

  const badModule = moveRequirement(draft, "req-1", "module-999");
  const crossModule = await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: badModule, reason: "无效关联", expectedVersion: projectVersion(repo) });
  ok("无效模块关联被拒绝", crossModule.ok === false && crossModule.error.code === "VALIDATION_ERROR");

  const badFile = payloadOf(draft, { sourceFileIds: ["file-4"] });
  const crossFile = await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: badFile, reason: "无效资料", expectedVersion: projectVersion(repo) });
  ok("其他归属资料被拒绝", crossFile.ok === false && crossFile.error.code === "VALIDATION_ERROR");
}

// ── 双向关联一致 + 需求移入模块 ──────────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  const draft = created.result;
  const moved = moveRequirement(draft, "req-3", "module-2");
  const saved = await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: moved, reason: "需求移入模块", expectedVersion: projectVersion(repo) });
  ok("移入模块保存成功", saved.ok === true);
  const module2 = saved.result.payload.modules.find((item) => item.id === "module-2");
  const module3 = saved.result.payload.modules.find((item) => item.id === "module-3");
  ok("Module.requirementIds 包含移入需求", module2.requirementIds.includes("req-3"));
  ok("原模块不再引用该需求", !module3.requirementIds.includes("req-3"));
  const req3 = saved.result.payload.requirements.find((item) => item.id === "req-3");
  check("Requirement.moduleId 指向新模块", req3.moduleId, "module-2");
  ok("双向一致（所有需求都被其模块引用）", saved.result.payload.requirements.every((item) => saved.result.payload.modules.find((module) => module.id === item.moduleId)?.requirementIds.includes(item.id)));
}

// ── 确认绑定内容版本；重复确认不重复签名 ──────────────────────────
{
  const { repo, state, run } = setup({ actorId: "member-1" });
  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  const draft = created.result;
  await run(submitBaselineForConfirmation, { projectId: "project-1", revisionId: draft.id, expectedVersion: projectVersion(repo) });

  const again = await run(confirmBaselineSelf, { projectId: "project-1", revisionId: draft.id, contentVersion: draft.contentVersion, expectedVersion: projectVersion(repo) });
  ok("本人确认成功", again.ok === true);
  const repeat = await run(confirmBaselineSelf, { projectId: "project-1", revisionId: draft.id, contentVersion: draft.contentVersion, expectedVersion: projectVersion(repo) });
  check("重复确认不重复签名", repeat.result.confirmations.length, 1);

  for (const actor of ["member-2", "member-3", "member-4"]) {
    state.actor = actor;
    const outcome = await run(confirmBaselineSelf, { projectId: "project-1", revisionId: draft.id, contentVersion: draft.contentVersion, expectedVersion: projectVersion(repo) });
    ok(`${actor} 确认成功`, outcome.ok === true);
  }
  const latest = draftBaseline(repo.data, "project-1");
  ok("全员确认完成", confirmationsComplete(latest));

  // 内容修改使旧确认失效
  state.actor = "member-1";
  const changed = await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: payloadOf(latest, { requirements: latest.payload.requirements.map((item) => ({ ...item })) }), reason: "再改内容", expectedVersion: projectVersion(repo) });
  ok("内容修改成功", changed.ok === true);
  check("内容修改清空确认", changed.result.confirmations, []);
  check("旧 contentVersion 确认不能用于新内容", confirmationsComplete(changed.result), false);
  const staleConfirm = await run(confirmBaselineSelf, { projectId: "project-1", revisionId: draft.id, contentVersion: latest.contentVersion, expectedVersion: projectVersion(repo) });
  ok("过期内容版本确认被拒绝", staleConfirm.ok === false && staleConfirm.error.code === "INVALID_STATE");
}

// ── 发布资格：普通成员拒绝、无全员确认拒绝、例外推进要原因和真实名单 ──
{
  const { repo, state, run } = setup({ actorId: "member-2" });
  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  const draft = created.result;
  await run(submitBaselineForConfirmation, { projectId: "project-1", revisionId: draft.id, expectedVersion: projectVersion(repo) });
  const byMember = await run(publishBaseline, { projectId: "project-1", revisionId: draft.id, expectedVersion: projectVersion(repo) });
  ok("普通成员不能发布", byMember.ok === false && byMember.error.code === "FORBIDDEN");

  state.actor = "member-1";
  await run(confirmBaselineSelf, { projectId: "project-1", revisionId: draft.id, contentVersion: draft.contentVersion, expectedVersion: projectVersion(repo) });
  const early = await run(publishBaseline, { projectId: "project-1", revisionId: draft.id, expectedVersion: projectVersion(repo) });
  ok("组长无全员确认时正常发布被拒绝", early.ok === false && early.error.code === "INVALID_STATE");

  const noReason = await run(forcePublishBaseline, { projectId: "project-1", revisionId: draft.id, reason: "", expectedVersion: projectVersion(repo) });
  ok("例外推进须有原因", noReason.ok === false && noReason.error.code === "VALIDATION_ERROR");

  const forced = await run(forcePublishBaseline, { projectId: "project-1", revisionId: draft.id, reason: "临近截止，先行推进", expectedVersion: projectVersion(repo) });
  ok("例外推进成功", forced.ok === true);
  check("兼容字段只记录真实确认人", forced.result && repo.data.projects.find((item) => item.id === "project-1").confirmedBy, ["member-1"]);
  const log = repo.data.logs.at(-1);
  check("日志记录未确认名单", ["member-2", "member-3", "member-4"].every((id) => log.detail.includes(id)), true);
  ok("例外推进写入审计", log.action === "需求基线例外推进");
}

// ── 发布 v2 保留 v1、验收过期、未受影响项目不被改写 ─────────────────
{
  const { repo, state, run } = setup({ actorId: "member-1" });
  const v1Before = JSON.stringify(activeBaseline(repo.data, "project-1"));
  const project3Before = JSON.stringify(repo.data.projects.find((item) => item.id === "project-3"));
  const verification1Before = repo.data.verifications.find((item) => item.id === "verification-1");

  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  const draft = created.result;
  const edited = payloadOf(draft, {
    requirements: draft.payload.requirements.map((item) => item.id === "req-1" ? { ...item, title: "登录与身份 v2" } : item),
  });
  await run(saveBaselineDraft, { projectId: "project-1", revisionId: draft.id, payload: edited, reason: "发布 v2", expectedVersion: projectVersion(repo) });
  await run(submitBaselineForConfirmation, { projectId: "project-1", revisionId: draft.id, expectedVersion: projectVersion(repo) });
  for (const actor of ["member-1", "member-2", "member-3", "member-4"]) {
    state.actor = actor;
    await run(confirmBaselineSelf, { projectId: "project-1", revisionId: draft.id, contentVersion: 2, expectedVersion: projectVersion(repo) });
  }
  state.actor = "member-1";
  const published = await run(publishBaseline, { projectId: "project-1", revisionId: draft.id, expectedVersion: projectVersion(repo) });
  ok("组长全员确认后发布成功", published.ok === true);
  ok("v1 历史保留", JSON.stringify(repo.data.baselineRevisions.find((item) => item.id === "baseline-project-1-legacy")) === v1Before);
  check("生效指针指向 v2", repo.data.projects.find((item) => item.id === "project-1").activeBaselineRevisionId, draft.id);
  check("baselineVersion 更新", repo.data.projects.find((item) => item.id === "project-1").baselineVersion, draft.number);
  check("setupStatus 冻结", repo.data.projects.find((item) => item.id === "project-1").setupStatus, "frozen");
  check("需求投影更新到 v2", repo.data.requirements.find((item) => item.id === "req-1").title, "登录与身份 v2");
  check("受影响任务（req-1）当前验收过期", repo.data.verifications.find((item) => item.id === "verification-2").status, "outdated");
  check("未受影响验收保持 current", repo.data.verifications.find((item) => item.id === "verification-1").status, verification1Before.status);
  check("未受影响项目不被改写", JSON.stringify(repo.data.projects.find((item) => item.id === "project-3")), project3Before);
  check("引用旧基线的计划标记待复核", repo.data.planRevisions.find((item) => item.id === "plan-project-1-legacy").status, "draft");
  check("计划确认状态回退", repo.data.projects.find((item) => item.id === "project-1").planConfirmed, false);

  const diff = compareBaselines(repo.data, "baseline-project-1-legacy", draft.id);
  check("差异与实际变化匹配（1 项修改）", diff.changedRequirements.map((item) => item.id), ["req-1"]);
  ok("差异字段包含 title", diff.changedRequirements[0].fields.includes("title"));
  check("历史包含两个版本", getBaselineHistory(repo.data, "project-1").length, 2);
  ok("发布日志记录影响任务数", repo.data.logs.some((item) => item.action === "需求基线发布" && item.detail.includes("影响任务")));
}

// Review regression: rejected stale baseline saves preserve the committed draft.
{
  const { repo, run } = setup();
  const created = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: projectVersion(repo) });
  const input = { projectId: "project-1", revisionId: created.result.id, payload: payloadOf(created.result), reason: "first", expectedVersion: projectVersion(repo) };
  const first = await run(saveBaselineDraft, input);
  ok("基线首次保存成功", first.ok);
  const before = JSON.stringify(draftBaseline(repo.data, "project-1"));
  const stale = await run(saveBaselineDraft, { ...input, reason: "stale" });
  ok("旧项目版本不能覆盖基线草稿", !stale.ok && stale.error.code === "VERSION_CONFLICT");
  check("基线冲突不写入", JSON.stringify(draftBaseline(repo.data, "project-1")), before);
}

console.log(`需求基线检查通过：${passed} 项断言全部符合预期。`);
