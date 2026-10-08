import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { deriveProgress, getProjectOverview, getProjectSummary, weightedProgress } from "../lib/overview.ts";

let passed = 0;
function check(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  passed += 1;
}
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
}

function mutate(changes) {
  const data = structuredClone(seedData);
  return changes(data);
}
const task = (id, weight, progress, overrides = {}) => ({ id, weight, progress, parentTaskId: undefined, ...overrides });

// ── weightedProgress：分母为 0 返回 null ──────────────────────────
check("空任务集合为暂无计划", weightedProgress([]), null);
check("权重合计 0 为暂无计划", weightedProgress([task("a", 0, 50)]), null);
check("加权进度按权重计算", weightedProgress([task("a", 60, 50), task("b", 40, 0)]), 30);
check("取整", weightedProgress([task("a", 3, 50), task("b", 1, 0)]), 38);

// ── 父子任务不重复计权；根任务更新后总览一致 ───────────────────────
{
  const base = deriveProgress(seedData, "project-1");
  check("总进度按顶层任务权重派生", base.overall, 76);
  check("核心进度只算核心模块根任务", base.core, 82);

  const childChanged = mutate((data) => {
    data.tasks = data.tasks.map((item) => item.id === "task-1a" ? { ...item, weight: 999, progress: 0 } : item);
    return data;
  });
  check("子任务变化不重复计权", deriveProgress(childChanged, "project-1").overall, 76);

  const rootChanged = mutate((data) => {
    data.tasks = data.tasks.map((item) => item.id === "task-1" ? { ...item, progress: 100 } : item);
    return data;
  });
  check("根任务更新后总览同步", deriveProgress(rootChanged, "project-1").overall, 80);

  const nonCoreChanged = mutate((data) => {
    data.tasks = data.tasks.map((item) => item.id === "task-4" ? { ...item, progress: 100 } : item);
    return data;
  });
  check("普通模块变化不误改核心进度", deriveProgress(nonCoreChanged, "project-1").core, 82);
  ok("普通模块变化只影响总进度", deriveProgress(nonCoreChanged, "project-1").overall !== 76);
}

// ── 无任务项目显示暂无计划 ───────────────────────────────────────
{
  const progress = deriveProgress(seedData, "project-2");
  check("无任务项目总进度为暂无计划", progress.overall, null);
  check("无任务项目核心进度为暂无计划", progress.core, null);
  const summary = getProjectSummary(seedData, "member-1", "project-2");
  check("公开 DTO 保留进度快照字段", summary.progress, 0);
}

// ── 公开 DTO 五字段；私有接口按 content.read 拒绝 ──────────────────
{
  const summary = getProjectSummary(seedData, "member-21", "project-1");
  check("同课其他组只得到五个公开字段", Object.keys(summary).sort().join(","), "description,id,lifecycle,name,progress");
  ok("不含任务/成员/确认集合", !("tasks" in summary) && !("memberIds" in summary) && !("confirmedBy" in summary));
  ok("公开总览使用统一派生进度", summary.progress === 76);
  let denied = false;
  try { getProjectOverview(seedData, "member-21", "project-1"); } catch (error) { denied = error.code === "FORBIDDEN"; }
  ok("私有总览拒绝公开读者", denied);

  const model = getProjectOverview(seedData, "teacher-1", "project-1");
  check("教学人员只读视图", model.isStaff, true);
  check("教学人员不显示本人学生任务", model.myTasks, []);
  const memberModel = getProjectOverview(seedData, "member-1", "project-1");
  ok("成员可见本人任务", memberModel.myTasks.length > 0 && memberModel.myTasks.every((item) => item.responsibleIds.includes("member-1")));
}

// ── 状态与入口随版本/生命周期/规则复核变化 ─────────────────────────
{
  const confirmed = getProjectOverview(seedData, "member-1", "project-1");
  check("已确认计划状态", confirmed.planState, "confirmed");
  check("正式计划统计非预览", confirmed.preview, false);
  check("基线版本展示", confirmed.baselineRevision?.id, "baseline-project-1-legacy");
  check("计划版本展示", confirmed.planRevision?.id, "plan-project-1-legacy");
  check("规则版本展示", confirmed.appliedCourseRuleRevisionId, "course-rule-course-1-legacy");

  const reviewState = mutate((data) => {
    data.projects = data.projects.map((item) => item.id === "project-1" ? { ...item, planConfirmed: false } : item);
    data.planRevisions = data.planRevisions.map((item) => item.id === "plan-project-1-legacy" ? { ...item, status: "draft" } : item);
    return data;
  });
  check("计划复核中状态", getProjectOverview(reviewState, "member-1", "project-1").planState, "review");

  const archived = mutate((data) => {
    data.projects = data.projects.map((item) => item.id === "project-1" ? { ...item, lifecycle: "archived" } : item);
    return data;
  });
  check("归档状态进入公开摘要", getProjectSummary(archived, "member-21", "project-1").lifecycle, "archived");

  const reopened = mutate((data) => {
    data.projects = data.projects.map((item) => item.id === "project-2" ? { ...item, sourceProjectId: "project-9", activePlanRevisionId: undefined } : item);
    return data;
  });
  const reopenedModel = getProjectOverview(reopened, "member-1", "project-2");
  check("修订来源进入模型", reopenedModel.sourceProjectId, "project-9");
  check("无计划时草稿统计标为预览", reopenedModel.preview, true);
  check("无计划状态", reopenedModel.planState, "none");
}

console.log(`项目总览与统计检查通过：${passed} 项断言全部符合预期。`);
