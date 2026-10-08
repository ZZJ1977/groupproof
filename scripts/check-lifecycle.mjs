import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { archiveProject, reopenProject, updateProjectSettings } from "../lib/commands/project.ts";
import { saveBaselineDraft, createBaselineDraft } from "../lib/commands/baseline.ts";
import { uploadProjectFile } from "../lib/commands/files.ts";

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
  let failSaves = 0;
  return {
    read: async () => structuredClone(data),
    save: async (next) => {
      if (failSaves > 0) { failSaves -= 1; throw new Error("storage unavailable"); }
      data = structuredClone(next);
    },
    get data() { return data; },
    set data(value) { data = structuredClone(value); },
    failNextSaves(count) { failSaves = count; },
  };
}

function setup({ actorId = "member-1" } = {}) {
  const repo = memoryRepository(seedData);
  const state = { actor: actorId, logSeq: 0 };
  const run = createCommandRunner({
    repository: repo,
    currentActorId: () => state.actor,
    now: () => "2026-10-06T12:00:00.000Z",
    makeLogId: () => `log-life-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const version = (repo, projectId = "project-1") => repo.data.projects.find((item) => item.id === projectId).version;
const settingsInput = (repo, overrides = {}) => ({ projectId: "project-1", name: "GroupProof 平台", language: "en", visibility: "course", expectedVersion: version(repo), ...overrides });

// ── 设置：资格、白名单、版本 ──────────────────────────────────────
{
  const { repo, state, run } = setup({ actorId: "member-2" });
  const byMember = await run(updateProjectSettings, settingsInput(repo));
  ok("普通成员不能改设置", byMember.ok === false && byMember.error.code === "FORBIDDEN");
  state.actor = "member-5";
  const byOtherLeader = await run(updateProjectSettings, settingsInput(repo));
  ok("其他项目组长不能改设置", byOtherLeader.ok === false && byOtherLeader.error.code === "FORBIDDEN");

  state.actor = "member-1";
  const whitelist = await run(updateProjectSettings, settingsInput(repo, { memberIds: ["member-9"] }));
  ok("白名单拒绝任意字段", whitelist.ok === false && whitelist.error.code === "VALIDATION_ERROR");
  const stale = await run(updateProjectSettings, settingsInput(repo, { expectedVersion: 0 }));
  ok("过期版本拒绝", stale.ok === false && stale.error.code === "VERSION_CONFLICT");

  const saved = await run(updateProjectSettings, settingsInput(repo));
  ok("组长保存设置成功", saved.ok === true);
  check("设置写入白名单字段", [saved.result.name, saved.result.language, saved.result.visibility], ["GroupProof 平台", "en", "course"]);
  ok("设置变更写入日志", repo.data.logs.some((item) => item.action === "修改项目设置"));
  check("成员/归属未被表单改写", saved.result.memberIds, seedData.projects.find((item) => item.id === "project-1").memberIds);
}

// ── 归档：仅 finalized；归档后写命令拒绝 ───────────────────────────
{
  const { repo, run } = setup();
  const active = await run(archiveProject, { projectId: "project-1", expectedVersion: version(repo) });
  ok("active 项目归档被拒绝", active.ok === false && active.error.code === "INVALID_STATE");

  const data = repo.data;
  repo.data = { ...data, projects: data.projects.map((item) => item.id === "project-1" ? { ...item, lifecycle: "finalized" } : item) };
  const archived = await run(archiveProject, { projectId: "project-1", expectedVersion: version(repo) });
  ok("finalized 归档成功", archived.ok === true && archived.result.lifecycle === "archived");

  const draft = await run(createBaselineDraft, { projectId: "project-1", expectedVersion: version(repo) });
  ok("归档后基线写入拒绝", draft.ok === false && draft.error.code === "INVALID_STATE");
  const upload = await run(uploadProjectFile, { projectId: "project-1", name: "归档后.md", mimeType: "text/markdown", sizeBytes: 10, expectedVersion: version(repo) });
  ok("归档后资料写入拒绝", upload.ok === false && upload.error.code === "INVALID_STATE");
  const settings = await run(updateProjectSettings, settingsInput(repo));
  ok("归档后设置写入拒绝", settings.ok === false && settings.error.code === "INVALID_STATE");
  void saveBaselineDraft;
}

// ── 重开：资格、源状态、外键完整、确认清空、历史不覆盖 ──────────────
{
  const { repo, state, run } = setup();
  const reportsBefore = JSON.stringify(repo.data.reports);
  const contributionsBefore = JSON.stringify(repo.data.contributions);
  const groupBefore = repo.data.groups.find((item) => item.id === "group-1").projectId;

  state.actor = "member-2";
  const byMember = await run(reopenProject, { projectId: "project-1", revisionLabel: "v2.0", reason: "越权", retainTasksAndEvidence: true, expectedVersion: version(repo) });
  ok("普通成员不能重新开启", byMember.ok === false && byMember.error.code === "FORBIDDEN");

  state.actor = "member-1";
  const activeSource = await run(reopenProject, { projectId: "project-1", revisionLabel: "v2.0", reason: "active 源", retainTasksAndEvidence: true, expectedVersion: version(repo) });
  ok("active 源不能重新开启", activeSource.ok === false && activeSource.error.code === "INVALID_STATE");

  const data = repo.data;
  repo.data = { ...data, projects: data.projects.map((item) => item.id === "project-1" ? { ...item, lifecycle: "archived" } : item) };
  const sourceBefore = JSON.stringify(repo.data.projects.find((item) => item.id === "project-1"));
  const reopened = await run(reopenProject, { projectId: "project-1", revisionLabel: "v2.0", reason: "根据教师反馈进行修改", retainTasksAndEvidence: true, expectedVersion: version(repo) });
  ok("重新开启成功", reopened.ok === true);
  const created = reopened.result;
  check("新修订为 active", created.lifecycle, "active");
  check("记录来源项目", created.sourceProjectId, "project-1");
  check("新修订重新确认基线", [created.setupStatus, created.planConfirmed, created.confirmedBy], ["pending_confirmation", false, []]);
  ok("进度快照保留但待复核", created.progress === seedData.projects.find((item) => item.id === "project-1").progress && created.activeBaselineRevisionId === undefined);

  const newTasks = repo.data.tasks.filter((item) => item.projectId === created.id);
  const newTaskIds = new Set(newTasks.map((item) => item.id));
  const newModuleIds = new Set(repo.data.modules.filter((item) => item.projectId === created.id).map((item) => item.id));
  const newRequirementIds = new Set(repo.data.requirements.filter((item) => item.projectId === created.id).map((item) => item.id));
  const newCriterionIds = new Set(repo.data.criteria.filter((item) => newTaskIds.has(item.taskId)).map((item) => item.id));
  const newMilestoneIds = new Set(repo.data.milestones.filter((item) => item.projectId === created.id).map((item) => item.id));
  ok("任务数量与源一致", newTasks.length === seedData.tasks.filter((item) => item.projectId === "project-1").length);
  ok("任务外键指向新修订", newTasks.every((task) => newModuleIds.has(task.moduleId) && task.requirementIds.every((id) => newRequirementIds.has(id)) && task.criterionIds.every((id) => newCriterionIds.has(id)) && task.milestoneIds.every((id) => newMilestoneIds.has(id)) && (!task.parentTaskId || newTaskIds.has(task.parentTaskId)) && task.dependencyIds.every((id) => newTaskIds.has(id))));
  const newEvidence = repo.data.evidence.filter((item) => item.projectId === created.id);
  ok("证据引用新任务/标准", newEvidence.every((item) => newTaskIds.has(item.taskId) && item.criterionIds.every((id) => newCriterionIds.has(id))));
  const newVerifications = repo.data.verifications.filter((item) => item.projectId === created.id);
  ok("验收引用新任务/标准", newVerifications.every((item) => newTaskIds.has(item.taskId) && item.criterionResults.every((result) => newCriterionIds.has(result.criterionId))));
  check("复制验收标为待复核", newVerifications.every((item) => item.status === "outdated"), true);
  check("复制验收清空人为确认", newVerifications.every((item) => item.humanConfirmedBy.length === 0), true);
  ok("里程碑归属新修订", repo.data.milestones.filter((item) => item.projectId === created.id).every((item) => item.taskIds.every((id) => newTaskIds.has(id))));

  const newBaselineDraft = repo.data.baselineRevisions.find((item) => item.projectId === created.id && item.status === "draft");
  const newPlanDraft = repo.data.planRevisions.find((item) => item.projectId === created.id && item.status === "draft");
  ok("新基线为草稿且确认为空", newBaselineDraft && newBaselineDraft.confirmations.length === 0);
  ok("新计划为草稿且确认为空", newPlanDraft && newPlanDraft.confirmations.length === 0 && newPlanDraft.baselineRevisionId === newBaselineDraft.id);
  check("源项目保持原位", JSON.stringify(repo.data.projects.find((item) => item.id === "project-1")), sourceBefore);
  check("旧报告未被覆盖", JSON.stringify(repo.data.reports), reportsBefore);
  check("旧贡献未被覆盖", JSON.stringify(repo.data.contributions), contributionsBefore);
  check("Group.projectId 指向新修订", repo.data.groups.find((item) => item.id === "group-1").projectId, created.id);
  ok("Group 旧指针发生变化", groupBefore !== created.id);
  ok("重开写入日志", repo.data.logs.some((item) => item.action === "项目重新开启" && item.target === created.id && item.detail.includes("v2.0")));

  const repeat = await run(reopenProject, { projectId: "project-1", revisionLabel: "v2.1", reason: "重复请求", retainTasksAndEvidence: true, expectedVersion: version(repo) });
  ok("重复重开返回同一修订", repeat.ok === true && repeat.result.id === created.id);
  check("重复重开不生成多份", repo.data.projects.filter((item) => item.sourceProjectId === "project-1").length, 1);
}

// ── 保存失败不改变原项目或 Group.projectId ─────────────────────────
{
  const { repo, run } = setup();
  const data = repo.data;
  repo.data = { ...data, projects: data.projects.map((item) => item.id === "project-1" ? { ...item, lifecycle: "archived" } : item) };
  const groupBefore = repo.data.groups.find((item) => item.id === "group-1").projectId;
  repo.failNextSaves(1);
  const failed = await run(reopenProject, { projectId: "project-1", revisionLabel: "v3.0", reason: "保存失败", retainTasksAndEvidence: true, expectedVersion: version(repo) });
  ok("保存失败返回 STORAGE_ERROR", failed.ok === false && failed.error.code === "STORAGE_ERROR");
  check("失败不改变 Group.projectId", repo.data.groups.find((item) => item.id === "group-1").projectId, groupBefore);
  check("失败不留下新修订", repo.data.projects.filter((item) => item.sourceProjectId === "project-1").length, 0);
}

// ── 不保留任务/证据时仅复制基线与设置 ──────────────────────────────
{
  const { repo, run } = setup();
  const data = repo.data;
  repo.data = { ...data, projects: data.projects.map((item) => item.id === "project-4" ? { ...item, lifecycle: "finalized" } : item) };
  const outcome = await run(reopenProject, { projectId: "project-4", revisionLabel: "v2.0", reason: "补充材料", retainTasksAndEvidence: false, expectedVersion: version(repo, "project-4") });
  ok("重开成功（不保留执行历史）", outcome.ok === true);
  check("新修订无复制任务", repo.data.tasks.filter((item) => item.projectId === outcome.result.id), []);
  check("新修订无复制验收", repo.data.verifications.filter((item) => item.projectId === outcome.result.id), []);
  ok("仍生成基线草稿", repo.data.baselineRevisions.some((item) => item.projectId === outcome.result.id && item.status === "draft"));
}

console.log(`项目设置与生命周期检查通过：${passed} 项断言全部符合预期。`);
