import { z } from "zod";
import type {
  CourseRuleRevision,
  CourseRuleSnapshot,
  Milestone,
  MockData,
  Project,
  RuleChangeReview,
} from "@/types/domain";
import { can } from "../access/policy.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";

/**
 * 课程规则变更处理（阶段 09）。
 *
 * - 比较项目已适用规则与待复核规则的真实快照；只按实际变化分类，不写固定文案。
 * - 截止改变不自动移动里程碑；受影响内容生成带目标 ID 的待调整事项，由所属命令落实。
 * - 只有该项目组长确认适用版本；不静默覆盖正式需求/计划。
 * - 同版本重复确认不重复生成记录；错过多个版本时直接比较已采用版与目标版。
 */

export interface RuleChangeImpact {
  fromRevisionId: string;
  toRevisionId: string;
  changedFields: { field: string; before: unknown; after: unknown }[];
  deadlineChange?: { before: string; after: string };
  conflictingMilestoneIds: string[];
  materialChanges: string[];
  baselineReviewRequired: boolean;
  planReviewRequired: boolean;
  rosterReviewRequired: boolean;
}

const fieldName: Partial<Record<keyof CourseRuleSnapshot, string>> = {
  projectDeadline: "项目截止",
  formationDeadline: "组队截止",
  groupingMode: "组队方式",
  minGroupSize: "最少人数",
  maxGroupSize: "最多人数",
  githubRequired: "GitHub 要求",
  aiAllowed: "AI 使用",
  gradingNotes: "评分说明",
};

/** 纯比较器：结构化字段与材料集合的真实新增/删除/变更 */
export function compareCourseRuleSnapshots(
  from: CourseRuleRevision,
  to: CourseRuleRevision,
  milestones: Milestone[],
): RuleChangeImpact {
  const changedFields: RuleChangeImpact["changedFields"] = [];
  const keys: (keyof CourseRuleSnapshot)[] = ["projectDeadline", "formationDeadline", "groupingMode", "minGroupSize", "maxGroupSize", "githubRequired", "aiAllowed", "gradingNotes"];
  for (const key of keys) {
    const before = from.snapshot[key];
    const after = to.snapshot[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changedFields.push({ field: fieldName[key] ?? String(key), before, after });
    }
  }
  const fromRules = new Set(from.rulesText);
  const toRules = new Set(to.rulesText);
  const addedRules = [...toRules].filter((item) => !fromRules.has(item));
  const removedRules = [...fromRules].filter((item) => !toRules.has(item));
  if (addedRules.length) changedFields.push({ field: "规则条目（新增）", before: [], after: addedRules });
  if (removedRules.length) changedFields.push({ field: "规则条目（移除）", before: removedRules, after: [] });

  const fromTemplate = from.snapshot.milestoneTemplate ?? [];
  const toTemplate = to.snapshot.milestoneTemplate ?? [];
  const templateChanged = JSON.stringify(fromTemplate) !== JSON.stringify(toTemplate);
  if (templateChanged) changedFields.push({ field: "里程碑模板", before: fromTemplate.map((item) => item.title), after: toTemplate.map((item) => item.title) });

  const fromFiles = from.snapshot.requiredFiles;
  const toFiles = to.snapshot.requiredFiles;
  const materialChanges = [
    ...toFiles.filter((item) => !fromFiles.includes(item)).map((item) => `新增必交材料：${item}`),
    ...fromFiles.filter((item) => !toFiles.includes(item)).map((item) => `移除必交材料：${item}`),
  ];

  const deadlineChange = from.snapshot.projectDeadline !== to.snapshot.projectDeadline
    ? { before: from.snapshot.projectDeadline, after: to.snapshot.projectDeadline }
    : undefined;
  // 只报告真实超期里程碑，不自动改日期
  const conflictingMilestoneIds = milestones
    .filter((item) => item.deadline > to.snapshot.projectDeadline)
    .map((item) => item.id);

  const rosterChanged = from.snapshot.groupingMode !== to.snapshot.groupingMode
    || from.snapshot.minGroupSize !== to.snapshot.minGroupSize
    || from.snapshot.maxGroupSize !== to.snapshot.maxGroupSize;

  return {
    fromRevisionId: from.id,
    toRevisionId: to.id,
    changedFields,
    deadlineChange,
    conflictingMilestoneIds,
    materialChanges,
    baselineReviewRequired: Boolean(deadlineChange) || materialChanges.length > 0 || templateChanged || changedFields.some((item) => item.field === "GitHub 要求" || item.field === "AI 使用"),
    planReviewRequired: Boolean(deadlineChange) || templateChanged,
    rosterReviewRequired: rosterChanged,
  };
}

export function getRuleChangeImpact(data: MockData, projectId: string, toRevisionId: string): RuleChangeImpact {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  const from = project.appliedCourseRuleRevisionId
    ? data.courseRuleRevisions.find((item) => item.id === project.appliedCourseRuleRevisionId)
    : undefined;
  const to = data.courseRuleRevisions.find((item) => item.id === toRevisionId);
  if (!to) throw new DomainError("NOT_FOUND", "待复核的规则版本不存在");
  if (!from) {
    // 未记录已采用版本时，以目标版本为准列出全部生效内容
    return compareCourseRuleSnapshots(to, to, data.milestones.filter((item) => item.projectId === project.id));
  }
  return compareCourseRuleSnapshots(from, to, data.milestones.filter((item) => item.projectId === project.id));
}

export function summarizeImpact(impact: RuleChangeImpact): string {
  const parts = impact.changedFields.map((item) => `${item.field}: ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`);
  if (impact.materialChanges.length) parts.push(...impact.materialChanges);
  if (impact.conflictingMilestoneIds.length) parts.push(`超期里程碑 ${impact.conflictingMilestoneIds.join("、")}`);
  return parts.join("；") || "无字段变化";
}

function logEntry(context: CommandContext, action: string, target: string, detail: string) {
  return { id: context.logId, actorId: context.actorId, action, target, result: "success" as const, ip: "mock", createdAt: context.now, detail };
}

export const applyCourseRuleChangeInput = z.object({
  projectId: z.string().min(1),
  toRevisionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type ApplyCourseRuleChangeInput = z.infer<typeof applyCourseRuleChangeInput>;

export const applyCourseRuleChange: Command<ApplyCourseRuleChangeInput, RuleChangeReview> = {
  name: "project.rules.apply",
  input: applyCourseRuleChangeInput,
  apply(data, context, input) {
    const project = data.projects.find((item) => item.id === input.projectId);
    if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
    if (!can(data, context.actorId, "project.rules.apply", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以确认适用课程规则");
    }
    if (project.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
    }
    const to = data.courseRuleRevisions.find((item) => item.id === input.toRevisionId);
    if (!to) throw new DomainError("NOT_FOUND", "待复核的规则版本不存在");
    if (to.status !== "published") {
      throw new DomainError("INVALID_STATE", "目标规则版本尚未发布或已失效");
    }
    const existing = data.ruleChangeReviews.find((item) => item.projectId === project.id && item.courseRuleRevisionId === to.id);
    if (existing) {
      // 同版本重复确认不重复生成记录
      return { data, result: existing };
    }

    const impact = getRuleChangeImpact(data, project.id, to.id);
    const review: RuleChangeReview = {
      id: `rule-review-${project.id}-${to.id}`,
      projectId: project.id,
      courseRuleRevisionId: to.id,
      previousCourseRuleRevisionId: project.appliedCourseRuleRevisionId,
      impact: summarizeImpact(impact),
      confirmedBy: context.actorId,
      confirmedAt: context.now,
    };

    // 更新适用指针与课程级约束（项目截止）；不改写正式需求/计划/里程碑日期
    const nextProject: Project = {
      ...project,
      appliedCourseRuleRevisionId: to.id,
      finalDeadline: to.snapshot.projectDeadline,
      version: project.version + 1,
    };

    // 完成对应复核待处理项（本项目/小组）
    const actionItems = data.actionItems.map((item) => {
      const isReview = item.type === `rule-review:${to.id}`;
      const forProject = item.projectId === project.id || (project.groupId ? item.groupId === project.groupId : false);
      return isReview && forProject && item.status === "pending" ? { ...item, status: "completed" as const } : item;
    });

    // 受影响内容生成带目标 ID 的待调整事项（实际修改通过所属命令）
    const additions: MockData["actionItems"] = [];
    const projectFiles = data.files.filter((item) => item.projectId === project.id).map((item) => item.name.replace(/\.[^.]+$/, ""));
    for (const change of impact.materialChanges) {
      if (!change.startsWith("新增必交材料：")) continue;
      const name = change.replace("新增必交材料：", "");
      if (projectFiles.some((file) => file.includes(name))) continue;
      additions.push({
        id: `${context.logId}-material-${additions.length}`,
        assigneeId: context.actorId,
        courseId: project.courseId,
        projectId: project.id,
        groupId: project.groupId,
        type: `rule-material:${review.id}`,
        title: `补充必交材料：${name}`,
        description: `规则版本 v${to.number} 新增必交材料 ${name}，请在资料页上传并关联。`,
        status: "pending",
        dueAt: to.snapshot.projectDeadline,
        href: `/projects/${project.id}/files`,
        priority: "medium",
      });
    }
    if (impact.conflictingMilestoneIds.length) {
      additions.push({
        id: `${context.logId}-milestone`,
        assigneeId: context.actorId,
        courseId: project.courseId,
        projectId: project.id,
        groupId: project.groupId,
        type: `rule-milestone:${review.id}`,
        title: "复核超期里程碑",
        description: `以下里程碑截止晚于新项目截止 ${to.snapshot.projectDeadline}：${impact.conflictingMilestoneIds.join("、")}。需通过里程碑调整处理，不自动顺延。`,
        status: "pending",
        dueAt: to.snapshot.projectDeadline,
        href: `/projects/${project.id}/milestones`,
        priority: "high",
      });
    }
    if (impact.planReviewRequired) {
      additions.push({
        id: `${context.logId}-plan`,
        assigneeId: context.actorId,
        courseId: project.courseId,
        projectId: project.id,
        groupId: project.groupId,
        type: `rule-plan:${review.id}`,
        title: "复核任务计划",
        description: `规则版本 v${to.number} 影响计划约束，请通过任务规划命令调整并重新发布。`,
        status: "pending",
        dueAt: to.snapshot.projectDeadline,
        href: `/projects/${project.id}/planning`,
        priority: "medium",
      });
    }

    // 需要需求变动时创建/链接基线变更草稿
    let nextData: MockData = {
      ...data,
      projects: data.projects.map((item) => (item.id === project.id ? nextProject : item)),
      ruleChangeReviews: [...data.ruleChangeReviews, review],
      actionItems: [...actionItems, ...additions],
      logs: [...data.logs, logEntry(context, "确认适用课程规则", project.id, `适用 ${to.id}（v${to.number}）；${review.impact}`)],
    };
    if (impact.baselineReviewRequired && !nextData.baselineRevisions.some((item) => item.projectId === project.id && item.status !== "published")) {
      const draft = {
        id: `baseline-${project.id}-${to.id}`,
        projectId: project.id,
        number: Math.max(project.baselineVersion, 0) + 1,
        version: 1,
        contentVersion: 1,
        status: "draft" as const,
        payload: {
          requirements: nextData.requirements.filter((item) => item.projectId === project.id).map((item) => ({ ...item })),
          modules: nextData.modules.filter((item) => item.projectId === project.id).map((item) => ({ ...item, requirementIds: [...item.requirementIds] })),
          sourceFileIds: nextData.files.filter((item) => item.projectId === project.id).map((item) => item.id),
        },
        memberRoster: [...project.memberIds],
        confirmations: [],
        basedOnRevisionId: project.activeBaselineRevisionId,
        reason: `课程规则 ${to.id} 变更影响复核`,
      };
      nextData = {
        ...nextData,
        baselineRevisions: [...nextData.baselineRevisions, draft],
        actionItems: [...nextData.actionItems, {
          id: `${context.logId}-baseline`,
          assigneeId: context.actorId,
          courseId: project.courseId,
          projectId: project.id,
          groupId: project.groupId,
          type: `rule-baseline:${review.id}`,
          title: "复核需求基线",
          description: `规则版本 v${to.number} 变更需要需求复核；已创建基线变更草稿 ${draft.id}。`,
          status: "pending",
          dueAt: to.snapshot.projectDeadline,
          href: `/projects/${project.id}/requirements`,
          priority: "medium",
        }],
      };
    }
    return { data: nextData, result: review };
  },
};
