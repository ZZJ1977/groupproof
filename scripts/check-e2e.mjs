import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { publishCourseRules, saveCourseRuleDraft } from "../lib/commands/course.ts";
import { createCourseProject } from "../lib/commands/project-create.ts";
import { advanceSetupStep, runMockRequirementAnalysis, saveSetupDraft } from "../lib/commands/setup.ts";
import { confirmBaselineSelf, publishBaseline, forcePublishBaseline } from "../lib/commands/baseline.ts";
import { confirmAssignmentSelf, createPlanDraft, publishPlan, savePlanDraft } from "../lib/commands/plan.ts";
import { applyCourseRuleChange, getRuleChangeImpact } from "../lib/commands/rule-change.ts";
import { uploadProjectFile, replaceProjectFile } from "../lib/commands/files.ts";
import { archiveProject, reopenProject, updateProjectSettings } from "../lib/commands/project.ts";
import { currentTasks, deriveProgress, getProjectOverview } from "../lib/overview.ts";
import { publishedCourseRule } from "../lib/versioning.ts";

/**
 * 端到端走查（服务层夹具）：教师规则 → 创建 → 初始化 → 确认 → 计划
 * → 执行视图一致性 → 规则变更 → 设置/归档/重开。
 * 浏览器交互无法在本环境脚本化，按阶段 13 约定以服务层夹具验证并在此记录。
 */
let passed = 0;
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

const repo = memoryRepository(seedData);
const state = { actor: "teacher-1", logSeq: 0 };
const run = createCommandRunner({
  repository: repo,
  currentActorId: () => state.actor,
  now: () => "2026-10-06T12:00:00.000Z",
  makeLogId: () => `log-e2e-${++state.logSeq}`,
});
const versionOf = (projectId) => repo.data.projects.find((item) => item.id === projectId).version;
const courseVersion = () => repo.data.courses.find((item) => item.id === "course-1").version;

// ── 1. 教师发布课程规则 ──────────────────────────────────────────
{
  const course = repo.data.courses.find((item) => item.id === "course-1");
  const draft = await run(saveCourseRuleDraft, {
    courseId: "course-1",
    payload: {
      projectDeadline: "2026-12-15", formationDeadline: course.formationDeadline, groupingMode: course.groupingMode,
      minGroupSize: course.minGroupSize, maxGroupSize: course.maxGroupSize,
      requiredFiles: [...course.requiredFiles], gradingNotes: "按证据与验收结果计分",
      githubRequired: true, aiAllowed: true,
      rulesText: [...course.rules, "演示视频需随最终报告提交"],
      milestoneTemplate: (course.milestoneTemplate ?? []).map((item) => ({ ...item })),
    },
    reason: "补充演示视频要求并提前截止",
    expectedVersion: courseVersion(),
  });
  ok("1a 教师保存规则草稿", draft.ok === true);
  const published = await run(publishCourseRules, { courseId: "course-1", revisionId: draft.result.id, expectedVersion: courseVersion() });
  ok("1b 教师发布规则版本", published.ok === true && published.result.status === "published");
  ok("1c 发布生成小组复核提醒", repo.data.actionItems.some((item) => item.type === `rule-review:${published.result.id}`));
}

// ── 2. 组长创建课程项目（套用规则版本） ───────────────────────────
let projectId = "";
{
  state.actor = "member-12";
  const created = await run(createCourseProject, {
    groupId: "group-4",
    name: "学习辅助平台",
    description: "面向学习辅助场景的课程项目",
    templateMode: "course",
    expectedGroupVersion: repo.data.groups.find((item) => item.id === "group-4").version,
    expectedCourseRuleRevisionId: publishedCourseRule(repo.data, "course-1").id,
  });
  ok("2a 组长创建课程项目", created.ok === true && created.result.alreadyExists === false);
  projectId = created.result.project.id;
  ok("2b 记录采用的规则版本", created.result.project.appliedCourseRuleRevisionId === publishedCourseRule(repo.data, "course-1").id);
  ok("2c 模板里程碑归属新项目", repo.data.milestones.filter((item) => item.projectId === projectId).length > 0);
}

// ── 3. 六步初始化与基线发布 ──────────────────────────────────────
{
  const projectVersion = () => versionOf(projectId);
  ok("3a 保存初始化草稿", (await run(saveSetupDraft, {
    projectId,
    step: 2,
    form: { name: "学习辅助平台", description: "面向学习辅助场景的课程项目", type: "课程项目", finalDeadline: "2026-12-15" },
    selectedFileIds: [],
    pastedSources: [{ id: "src-1", title: "课程要求", text: "必须绑定 GitHub 仓库并提交最终报告与演示视频" }],
    conflicts: [],
    expectedVersion: projectVersion(),
  })).ok === true);
  ok("3b 模拟分析写入基线草稿", (await run(runMockRequirementAnalysis, { projectId, expectedVersion: projectVersion() })).ok === true);
  const draftId = repo.data.setupDrafts.find((item) => item.projectId === projectId).baselineDraftId;
  ok("3c 进入团队确认", (await run(saveSetupDraft, {
    projectId,
    step: 6,
    form: { name: "学习辅助平台", description: "面向学习辅助场景的课程项目", type: "课程项目", finalDeadline: "2026-12-15" },
    selectedFileIds: [],
    pastedSources: [{ id: "src-1", title: "课程要求", text: "必须绑定 GitHub 仓库并提交最终报告与演示视频" }],
    conflicts: [],
    baselineDraftId: draftId,
    expectedVersion: projectVersion(),
  })).ok === true);
  for (const actor of ["member-12", "member-13", "member-14"]) {
    state.actor = actor;
    ok(`3d ${actor} 确认基线`, (await run(confirmBaselineSelf, { projectId, revisionId: draftId, contentVersion: 1, expectedVersion: projectVersion() })).ok === true);
  }
  state.actor = "member-12";
  const baseline = await run(publishBaseline, { projectId, revisionId: draftId, expectedVersion: projectVersion() });
  ok("3e 组长发布基线并冻结", baseline.ok === true && baseline.result.status === "published");
  ok("3f 初始化冻结", repo.data.projects.find((item) => item.id === projectId).setupStatus === "frozen");
}

// ── 4. 计划草稿 → 责任确认 → 发布 ────────────────────────────────
{
  const projectVersion = () => versionOf(projectId);
  const baselineId = repo.data.projects.find((item) => item.id === projectId).activeBaselineRevisionId;
  const created = await run(createPlanDraft, { projectId, baselineRevisionId: baselineId, expectedVersion: projectVersion() });
  ok("4a 创建计划草稿", created.ok === true);
  const draft = created.result;
  const baselinePayload = repo.data.baselineRevisions.find((item) => item.id === baselineId).payload;
  const moduleId = baselinePayload.modules[0]?.id ?? "";
  const req1 = baselinePayload.requirements[0]?.id;
  const req2 = baselinePayload.requirements[1]?.id;
  const tasks = [
    { id: `${projectId}-t1`, projectId, moduleId, requirementIds: req1 ? [req1] : [], title: "T-01 核心流程", description: "", responsibleIds: ["member-12"], priority: "high", weight: 60, status: "not_started", progress: 0, milestoneIds: [], criterionIds: [`${projectId}-t1-ac`], dependencyIds: [], version: 1, updatedAt: "2026-10-06T00:00:00Z" },
    { id: `${projectId}-t2`, projectId, moduleId, requirementIds: req2 ? [req2] : [], title: "T-02 验收材料", description: "", responsibleIds: ["member-13"], priority: "medium", weight: 40, status: "not_started", progress: 0, milestoneIds: [], criterionIds: [`${projectId}-t2-ac`], dependencyIds: [], version: 1, updatedAt: "2026-10-06T00:00:00Z" },
  ];
  const saved = await run(savePlanDraft, {
    projectId,
    revisionId: draft.id,
    payload: {
      tasks,
      criteria: [
        { id: `${projectId}-t1-ac`, taskId: `${projectId}-t1`, text: "核心流程可运行", version: 1, humanConfirmedBy: [] },
        { id: `${projectId}-t2-ac`, taskId: `${projectId}-t2`, text: "验收材料完整", version: 1, humanConfirmedBy: [] },
      ],
      milestoneLinks: tasks.map((item) => ({ taskId: item.id, milestoneIds: [] })),
    },
    expectedVersion: projectVersion(),
  });
  ok("4b 保存计划草稿（结构校验通过）", saved.ok === true);
  for (const actor of ["member-12", "member-13", "member-14"]) {
    state.actor = actor;
    ok(`4c ${actor} 确认任务分配`, (await run(confirmAssignmentSelf, { projectId, revisionId: draft.id, contentVersion: saved.result.contentVersion, expectedVersion: projectVersion() })).ok === true);
  }
  state.actor = "member-12";
  const plan = await run(publishPlan, { projectId, revisionId: draft.id, expectedVersion: projectVersion() });
  ok("4d 发布正式计划", plan.ok === true && plan.result.status === "published");
  ok("4e 计划确认生效", repo.data.projects.find((item) => item.id === projectId).planConfirmed === true);
}

// ── 5. 执行视图一致性（树/看板/列表同源） ─────────────────────────
{
  const model = getProjectOverview(repo.data, "member-12", projectId);
  const projectionIds = repo.data.tasks.filter((item) => item.projectId === projectId).map((item) => item.id).sort();
  const viewIds = currentTasks(repo.data, projectId).map((item) => item.id).sort();
  ok("5a 执行视图与正式计划同源", JSON.stringify(projectionIds) === JSON.stringify(viewIds));
  ok("5b 总览统计与执行视图一致", model.progress.overall === deriveProgress(repo.data, projectId).overall);
  ok("5c 正式计划统计非预览", model.preview === false && model.planState === "confirmed");
}

// ── 6. 规则变更：真实差异 → 组长确认适用 ──────────────────────────
{
  state.actor = "teacher-1";
  const course = repo.data.courses.find((item) => item.id === "course-1");
  const draft = await run(saveCourseRuleDraft, {
    courseId: "course-1",
    payload: {
      projectDeadline: "2026-12-05", formationDeadline: course.formationDeadline, groupingMode: course.groupingMode,
      minGroupSize: 2, maxGroupSize: course.maxGroupSize,
      requiredFiles: [...course.requiredFiles, "部署说明"], gradingNotes: "按证据与验收结果计分",
      githubRequired: true, aiAllowed: true,
      rulesText: [...course.rules],
      milestoneTemplate: (course.milestoneTemplate ?? []).map((item) => ({ ...item })),
    },
    reason: "进一步提前截止并新增材料",
    expectedVersion: courseVersion(),
  });
  ok("6a 教师保存变更草稿", draft.ok === true);
  const published = await run(publishCourseRules, { courseId: "course-1", revisionId: draft.result.id, expectedVersion: courseVersion() });
  ok("6b 发布新规则版本", published.ok === true);

  state.actor = "member-12";
  const impact = getRuleChangeImpact(repo.data, projectId, published.result.id);
  ok("6c 差异包含真实截止变化", impact.deadlineChange?.after === "2026-12-05");
  ok("6d 差异包含材料变化", impact.materialChanges.some((item) => item.includes("部署说明")));
  const applied = await run(applyCourseRuleChange, { projectId, toRevisionId: published.result.id, expectedVersion: versionOf(projectId) });
  ok("6e 组长确认适用规则", applied.ok === true);
  ok("6f 生成调整待办", repo.data.actionItems.some((item) => item.projectId === projectId && item.type.startsWith("rule-")));
  ok("6g 适用指针与截止一致", repo.data.projects.find((item) => item.id === projectId).finalDeadline === "2026-12-05");
}

// ── 7. 资料版本 → 设置 → 归档 → 重开 ─────────────────────────────
{
  const projectVersion = () => versionOf(projectId);
  const uploaded = await run(uploadProjectFile, { projectId, name: "部署说明.md", mimeType: "text/markdown", sizeBytes: 2048, expectedVersion: projectVersion() });
  ok("7a 上传资料（版本 1）", uploaded.ok === true && uploaded.result.version === 1);
  const replaced = await run(replaceProjectFile, { projectId, name: "部署说明.md", mimeType: "text/markdown", sizeBytes: 4096, expectedVersion: projectVersion(), replacesFileId: uploaded.result.id });
  ok("7b 替换生成版本 2", replaced.ok === true && replaced.result.version === 2);

  const settings = await run(updateProjectSettings, { projectId, name: "学习辅助平台 v2", language: "zh", visibility: "course", expectedVersion: projectVersion() });
  ok("7c 更新项目设置", settings.ok === true);

  repo.failNextSaves(1);
  const failedSave = await run(uploadProjectFile, { projectId, name: "失败.md", mimeType: "text/markdown", sizeBytes: 10, expectedVersion: projectVersion() });
  ok("7d 存储失败不产生记录", failedSave.ok === false && failedSave.error.code === "STORAGE_ERROR" && !repo.data.files.some((item) => item.name === "失败.md"));

  const data = repo.data;
  repo.data = { ...data, projects: data.projects.map((item) => item.id === projectId ? { ...item, lifecycle: "finalized" } : item) };
  const archived = await run(archiveProject, { projectId, expectedVersion: projectVersion() });
  ok("7e finalized 归档成功", archived.ok === true && archived.result.lifecycle === "archived");
  const writeAfter = await run(uploadProjectFile, { projectId, name: "归档后.md", mimeType: "text/markdown", sizeBytes: 10, expectedVersion: projectVersion() });
  ok("7f 归档后写入拒绝", writeAfter.ok === false && writeAfter.error.code === "INVALID_STATE");

  const reopened = await run(reopenProject, { projectId, revisionLabel: "v2.0", reason: "补充材料并复核", retainTasksAndEvidence: true, expectedVersion: projectVersion() });
  ok("7g 重新开启创建修订", reopened.ok === true && reopened.result.sourceProjectId === projectId);
  ok("7h 修订外键自洽", currentTasks(repo.data, reopened.result.id).every((item) => item.projectId === reopened.result.id));
  ok("7i 原正式结果保留", repo.data.projects.find((item) => item.id === projectId).lifecycle === "archived");
}

console.log(`功能验收端到端走查通过：${passed} 项断言全部符合预期。`);
