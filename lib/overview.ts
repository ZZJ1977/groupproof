import type {
  ActionItem,
  Milestone,
  MockData,
  Project,
  ProjectSummary,
  Task,
} from "@/types/domain";
import { can } from "./access/policy.ts";
import { activeBaseline, activePlan, appliedCourseRule, draftPlan } from "./versioning.ts";
import { DomainError } from "./commands/core.ts";

/**
 * 项目总览与统计（阶段 12）。
 *
 * - 进度从 active 计划/当前任务集合统一派生：子任务先汇总到父任务，不重复计权；
 *   核心进度只筛选 core 模块的根任务并重新归一。
 * - 分母为 0 返回 null（页面显示“暂无计划”），不显示虚构完成度。
 * - 公开 DTO 只有五个允许字段；私有 OverviewModel 按 content.read 读取。
 */

export interface ProgressSummary {
  overall: number | null;
  core: number | null;
}

export function weightedProgress(tasks: Task[]): number | null {
  const total = tasks.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return null;
  return Math.round(tasks.reduce((sum, item) => sum + item.weight * item.progress, 0) / total);
}

/** 当前正式计划的任务集合（读执行投影进度）；无计划时用当前任务投影 */
export function currentTasks(data: MockData, projectId: string): Task[] {
  const plan = activePlan(data, projectId);
  const projected = data.tasks.filter((item) => item.projectId === projectId);
  if (!plan) return projected;
  const ids = new Set(plan.payload.tasks.map((item) => item.id));
  return projected.filter((item) => ids.has(item.id));
}

export function deriveProgress(data: MockData, projectId: string): ProgressSummary {
  const tasks = currentTasks(data, projectId);
  const roots = tasks.filter((item) => !item.parentTaskId);
  const coreModuleIds = new Set(data.modules.filter((item) => item.projectId === projectId && item.core).map((item) => item.id));
  return {
    overall: weightedProgress(roots),
    core: weightedProgress(roots.filter((item) => coreModuleIds.has(item.moduleId))),
  };
}

function findProjectOrThrow(data: MockData, projectId: string): Project {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  return project;
}

/** 公开总览：先用统一派生进度填充投影，再返回白名单 DTO（不含任务/成员/确认/资料） */
export function getProjectSummary(data: MockData, actorId: string, projectId: string): ProjectSummary {
  const project = findProjectOrThrow(data, projectId);
  if (!can(data, actorId, "project.summary.read", { kind: "project", id: projectId })) {
    throw new DomainError("FORBIDDEN", "无权读取该项目公开总览");
  }
  const { overall } = deriveProgress(data, projectId);
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    progress: overall ?? project.progress,
    lifecycle: project.lifecycle,
  };
}

export type PlanState = "none" | "draft" | "review" | "confirmed";

export interface ProjectOverviewModel {
  summary: ProjectSummary;
  progress: ProgressSummary;
  /** 草稿统计为预览口径 */
  preview: boolean;
  setupState: Project["setupStatus"];
  planState: PlanState;
  baselineRevision?: { id: string; number: number };
  planRevision?: { id: string; number: number };
  appliedCourseRuleRevisionId?: string;
  sourceProjectId?: string;
  milestones: Milestone[];
  myTasks: Task[];
  actionItems: ActionItem[];
  activity: { id: string; title: string; kind: string; at: string }[];
  /** 教学人员只读视图：不展示学生本人操作 */
  isStaff: boolean;
}

export function getProjectOverview(data: MockData, actorId: string, projectId: string): ProjectOverviewModel {
  const project = findProjectOrThrow(data, projectId);
  if (!can(data, actorId, "project.content.read", { kind: "project", id: projectId })) {
    throw new DomainError("FORBIDDEN", "无权读取该项目总览");
  }
  const plan = activePlan(data, projectId);
  const draft = draftPlan(data, projectId);
  const baseline = activeBaseline(data, projectId);
  const tasks = currentTasks(data, projectId);
  const progress = deriveProgress(data, projectId);
  const planState: PlanState = project.planConfirmed && plan ? "confirmed" : draft ? (plan ? "review" : "draft") : plan ? "review" : "none";
  const isStaff = !project.memberIds.includes(actorId);

  return {
    summary: getProjectSummary(data, actorId, projectId),
    progress,
    preview: !plan,
    setupState: project.setupStatus,
    planState,
    baselineRevision: baseline ? { id: baseline.id, number: baseline.number } : undefined,
    planRevision: plan ? { id: plan.id, number: plan.number } : undefined,
    appliedCourseRuleRevisionId: appliedCourseRule(data, projectId)?.id ?? project.appliedCourseRuleRevisionId,
    sourceProjectId: project.sourceProjectId,
    milestones: data.milestones.filter((item) => item.projectId === projectId),
    myTasks: isStaff ? [] : tasks.filter((item) => item.responsibleIds.includes(actorId) && item.status !== "completed").slice(0, 5),
    actionItems: data.actionItems.filter((item) => item.projectId === projectId && item.status === "pending"),
    activity: [
      ...data.github.filter((item) => item.projectId === projectId).map((item) => ({ id: item.id, title: item.title, kind: "GitHub", at: item.timestamp })),
      ...data.evidence.filter((item) => item.projectId === projectId).map((item) => ({ id: item.id, title: `提交了 ${item.title}`, kind: "证据", at: item.createdAt })),
      ...data.logs.filter((item) => item.target === projectId || item.target.startsWith(projectId)).map((item) => ({ id: item.id, title: item.action, kind: "日志", at: item.createdAt })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5),
    isStaff,
  };
}
