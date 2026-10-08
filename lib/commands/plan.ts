import { z } from "zod";
import type {
  AcceptanceCriterion,
  BaselinePayload,
  MockData,
  PlanPayload,
  PlanRevision,
  Task,
} from "@/types/domain";
import { can } from "../access/policy.ts";
import { confirmationsComplete, confirmedUserIds, confirmMember } from "../versioning.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";
import { assertProjectWritable } from "./project.ts";

/**
 * 任务规划与发布（阶段 08）。
 *
 * - 计划草稿绑定已发布 baselineRevisionId；当前发布必须基于仍生效的基线。
 * - 成员共同编辑草稿并确认自己的分配，确认绑定完整计划内容版本（含无分配责任的成员）。
 * - 正常/例外发布执行同等结构校验，原子生成 Task/AcceptanceCriterion 投影与正式计划快照；
 *   解锁创建新草稿，旧历史保留。
 */

export interface PlanValidationIssue {
  code: string;
  taskId?: string;
  field?: string;
  message: string;
}

const taskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  moduleId: z.string(),
  parentTaskId: z.string().optional(),
  requirementIds: z.array(z.string()),
  title: z.string().trim().min(1, "任务名称不能为空"),
  description: z.string(),
  responsibleIds: z.array(z.string()),
  priority: z.enum(["high", "medium", "low"]),
  weight: z.number().int().min(0).max(100),
  status: z.enum(["not_started", "in_progress", "pending_submission", "pending_verification", "completed"]),
  progress: z.number().min(0).max(100),
  milestoneIds: z.array(z.string()),
  criterionIds: z.array(z.string()),
  dependencyIds: z.array(z.string()),
  version: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

const criterionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  text: z.string().trim().min(1, "验收标准不能为空"),
  version: z.number().int().nonnegative(),
  result: z.enum(["passed", "partially_passed", "failed", "uncertain"]).optional(),
  humanConfirmedBy: z.array(z.string()),
});

export const planPayloadSchema = z.object({
  tasks: z.array(taskSchema),
  criteria: z.array(criterionSchema),
  milestoneLinks: z.array(z.object({ taskId: z.string().min(1), milestoneIds: z.array(z.string()) })),
});

export type PlanPayloadInput = z.infer<typeof planPayloadSchema>;

/** 结构校验：归属、负责人、标准、整数权重、父子树、依赖环（示例规则 + 扩展） */
export function validatePlan(
  payload: PlanPayloadInput,
  baseline: BaselinePayload | undefined,
  members: string[],
): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const tasks = payload.tasks;
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const criteriaByTask = new Map<string, number>();
  for (const criterion of payload.criteria) {
    criteriaByTask.set(criterion.taskId, (criteriaByTask.get(criterion.taskId) ?? 0) + 1);
    if (!byId.has(criterion.taskId)) {
      issues.push({ code: "dangling_criterion", taskId: criterion.taskId, field: "criteria", message: `验收标准 ${criterion.id} 引用了不存在的任务` });
    }
    if (!criterion.text.trim()) {
      issues.push({ code: "empty_criterion", taskId: criterion.taskId, field: "text", message: `验收标准 ${criterion.id} 内容为空` });
    }
  }

  const seen = new Set<string>();
  if (new Set(tasks.map((item) => item.projectId)).size > 1) {
    issues.push({ code: "cross_project_ref", field: "projectId", message: "任务集合包含多个项目的引用" });
  }
  for (const task of tasks) {
    if (seen.has(task.id)) issues.push({ code: "duplicate_id", taskId: task.id, field: "id", message: `任务 ID 重复：${task.id}` });
    seen.add(task.id);
    if (!Number.isInteger(task.weight) || task.weight < 0 || task.weight > 100) {
      issues.push({ code: "weight_not_integer", taskId: task.id, field: "weight", message: "任务权重需为 0–100 的整数" });
    }
    if (!task.responsibleIds.length) {
      issues.push({ code: "missing_responsible", taskId: task.id, field: "responsibleIds", message: `任务 ${task.id} 没有负责人` });
    }
    for (const memberId of task.responsibleIds) {
      if (!members.includes(memberId)) issues.push({ code: "invalid_responsible", taskId: task.id, field: "responsibleIds", message: `负责人 ${memberId} 不是有效成员` });
    }
    if (!(criteriaByTask.get(task.id) ?? 0)) {
      issues.push({ code: "missing_criteria", taskId: task.id, field: "criterionIds", message: `任务 ${task.id} 没有验收标准` });
    }
    if (baseline) {
      const moduleIds = new Set(baseline.modules.map((item) => item.id));
      const requirementIds = new Set(baseline.requirements.map((item) => item.id));
      if (task.moduleId && !moduleIds.has(task.moduleId)) {
        issues.push({ code: "unknown_module", taskId: task.id, field: "moduleId", message: `任务 ${task.id} 引用了基线外的模块` });
      }
      for (const id of task.requirementIds) {
        if (!requirementIds.has(id)) issues.push({ code: "unknown_requirement", taskId: task.id, field: "requirementIds", message: `任务 ${task.id} 引用了基线外的需求 ${id}` });
      }
    }
    if (task.parentTaskId) {
      if (!byId.has(task.parentTaskId)) {
        issues.push({ code: "unknown_parent", taskId: task.id, field: "parentTaskId", message: `任务 ${task.id} 的父任务不存在` });
      } else if (task.parentTaskId === task.id) {
        issues.push({ code: "self_reference", taskId: task.id, field: "parentTaskId", message: `任务 ${task.id} 不能引用自身为父任务` });
      } else {
        let cursor: string | undefined = task.parentTaskId;
        const chain = new Set<string>([task.id]);
        while (cursor) {
          if (chain.has(cursor)) { issues.push({ code: "parent_cycle", taskId: task.id, field: "parentTaskId", message: `任务 ${task.id} 的父子关系成环` }); break; }
          chain.add(cursor);
          cursor = byId.get(cursor)?.parentTaskId;
        }
      }
    }
    for (const depId of task.dependencyIds) {
      if (depId === task.id) {
        issues.push({ code: "self_dependency", taskId: task.id, field: "dependencyIds", message: `任务 ${task.id} 不能依赖自身` });
      } else if (!byId.has(depId)) {
        issues.push({ code: "unknown_dependency", taskId: task.id, field: "dependencyIds", message: `任务 ${task.id} 依赖了不存在的任务 ${depId}` });
      }
    }
  }
  for (const link of payload.milestoneLinks) {
    if (!byId.has(link.taskId)) {
      issues.push({ code: "dangling_milestone_link", taskId: link.taskId, field: "milestoneLinks", message: `里程碑关联引用了不存在的任务 ${link.taskId}` });
    }
  }

  // 依赖环校验（DFS）
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (id: string, path: string[]): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) { issues.push({ code: "dependency_cycle", taskId: id, field: "dependencyIds", message: `任务依赖成环：${[...path, id].join(" → ")}` }); return true; }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencyIds ?? []) if (byId.has(dep) && walk(dep, [...path, id])) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const task of tasks) walk(task.id, []);

  // 权重规则：顶层合计 100，子任务合计等于父权重
  const roots = tasks.filter((item) => !item.parentTaskId);
  const rootTotal = roots.reduce((sum, item) => sum + item.weight, 0);
  if (roots.length && rootTotal !== 100) {
    issues.push({ code: "root_weight_total", field: "weight", message: "顶层任务权重合计必须为 100%" });
  }
  for (const parent of tasks) {
    const children = tasks.filter((item) => item.parentTaskId === parent.id);
    if (children.length && children.reduce((sum, item) => sum + item.weight, 0) !== parent.weight) {
      issues.push({ code: "child_weight_total", taskId: parent.id, field: "weight", message: `${parent.id} 的子任务权重合计需等于父任务权重` });
    }
  }
  return issues;
}

/** 保存草稿时只阻断硬性引用问题；完整结构校验在发布时执行 */
const SAVE_BLOCKING = new Set([
  "duplicate_id", "cross_project_ref", "self_reference", "self_dependency",
  "parent_cycle", "dependency_cycle", "unknown_parent", "unknown_dependency",
  "dangling_criterion", "dangling_milestone_link", "unknown_module", "unknown_requirement",
]);

function findProjectOrThrow(data: MockData, projectId: string) {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  assertProjectWritable(project);
  return project;
}

function findRevisionOrThrow(data: MockData, projectId: string, revisionId: string): PlanRevision {
  const revision = data.planRevisions.find((item) => item.id === revisionId && item.projectId === projectId);
  if (!revision) throw new DomainError("NOT_FOUND", "计划版本不存在");
  return revision;
}

function checkVersion(project: { version: number }, expectedVersion: number): void {
  if (project.version !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
  }
}

function logEntry(context: CommandContext, action: string, target: string, detail: string) {
  return { id: context.logId, actorId: context.actorId, action, target, result: "success" as const, ip: "mock", createdAt: context.now, detail };
}

function assertMember(data: MockData, actorId: string, projectId: string): void {
  if (!can(data, actorId, "project.draft.edit", { kind: "project", id: projectId })) {
    throw new DomainError("FORBIDDEN", "只有项目成员可以编辑任务计划草稿");
  }
}

function currentPayload(data: MockData, projectId: string): PlanPayload {
  const tasks = data.tasks.filter((item) => item.projectId === projectId);
  return {
    tasks: tasks.map((item) => ({ ...item })),
    criteria: data.criteria.filter((item) => tasks.some((task) => task.id === item.taskId)).map((item) => ({ ...item })),
    milestoneLinks: tasks.map((item) => ({ taskId: item.id, milestoneIds: [...item.milestoneIds] })),
  };
}

// ── createPlanDraft ──────────────────────────────────────────────

export const createPlanDraftInput = z.object({
  projectId: z.string().min(1),
  baselineRevisionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type CreatePlanDraftInput = z.infer<typeof createPlanDraftInput>;

export const createPlanDraft: Command<CreatePlanDraftInput, PlanRevision> = {
  name: "project.draft.edit",
  input: createPlanDraftInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    assertMember(data, context.actorId, project.id);
    checkVersion(project, input.expectedVersion);
    const baseline = data.baselineRevisions.find((item) => item.id === input.baselineRevisionId && item.projectId === project.id);
    if (!baseline || baseline.status !== "published") {
      throw new DomainError("INVALID_STATE", "计划草稿必须绑定已发布的需求基线");
    }
    const existing = data.planRevisions.find((item) => item.projectId === project.id && item.status !== "published");
    if (existing) return { data, result: existing };

    const revision: PlanRevision = {
      id: `plan-${project.id}-${Date.now().toString(36)}`,
      projectId: project.id,
      number: Math.max(project.planVersion, 0) + 1,
      version: 1,
      contentVersion: 1,
      status: "draft",
      payload: currentPayload(data, project.id),
      memberRoster: [...project.memberIds],
      confirmations: [],
      baselineRevisionId: baseline.id,
    };
    return {
      data: { ...data, planRevisions: [...data.planRevisions, revision] },
      result: revision,
    };
  },
};

// ── savePlanDraft ────────────────────────────────────────────────

export const savePlanDraftInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  payload: planPayloadSchema,
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type SavePlanDraftInput = z.infer<typeof savePlanDraftInput>;

export const savePlanDraft: Command<SavePlanDraftInput, PlanRevision> = {
  name: "project.draft.edit",
  input: savePlanDraftInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    assertMember(data, context.actorId, project.id);
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    if (revision.status === "published") {
      throw new DomainError("INVALID_STATE", "正式计划不可原地编辑，请解锁创建新草稿");
    }
    const baseline = data.baselineRevisions.find((item) => item.id === revision.baselineRevisionId);
    const issues = validatePlan(input.payload, baseline?.payload, project.memberIds);
    const blocking = issues.filter((issue) => SAVE_BLOCKING.has(issue.code));
    if (blocking.length) {
      throw new DomainError("VALIDATION_ERROR", "任务关联校验未通过", {
        fieldErrors: Object.fromEntries(blocking.map((issue) => [`${issue.taskId ?? "plan"}.${issue.field ?? "structure"}`, [issue.message]])),
      });
    }
    // 维护父子/需求/模块关联与标准引用
    const criterionIdsByTask = new Map<string, string[]>();
    for (const criterion of input.payload.criteria) {
      criterionIdsByTask.set(criterion.taskId, [...(criterionIdsByTask.get(criterion.taskId) ?? []), criterion.id]);
    }
    const tasks: Task[] = input.payload.tasks.map((task) => ({
      ...task,
      projectId: project.id,
      criterionIds: criterionIdsByTask.get(task.id) ?? [],
      milestoneIds: input.payload.milestoneLinks.find((link) => link.taskId === task.id)?.milestoneIds ?? task.milestoneIds,
    }));
    const next: PlanRevision = {
      ...revision,
      payload: {
        tasks,
        criteria: input.payload.criteria.map((item) => ({ ...item })),
        milestoneLinks: input.payload.milestoneLinks.map((item) => ({ ...item, milestoneIds: [...item.milestoneIds] })),
      },
      contentVersion: revision.contentVersion + 1,
      confirmations: [],
      status: "draft",
      version: revision.version + 1,
    };
    return {
      data: {
        ...data,
        planRevisions: data.planRevisions.map((item) => (item.id === revision.id ? next : item)),
        logs: [...data.logs, logEntry(context, "任务计划草稿修改", revision.id, `内容版本 v${revision.contentVersion} → v${next.contentVersion}；任务 ${tasks.length} 个`)],
      },
      result: next,
    };
  },
};

// ── confirmAssignmentSelf ────────────────────────────────────────

export const confirmAssignmentSelfInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  contentVersion: z.number().int().positive(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type ConfirmAssignmentSelfInput = z.infer<typeof confirmAssignmentSelfInput>;

export const confirmAssignmentSelf: Command<ConfirmAssignmentSelfInput, PlanRevision> = {
  name: "project.confirm.self",
  input: confirmAssignmentSelfInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.confirm.self", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有项目成员可以确认任务分配");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    if (revision.status === "published") throw new DomainError("INVALID_STATE", "计划已发布，无需重复确认");
    if (!revision.memberRoster.includes(context.actorId)) {
      throw new DomainError("FORBIDDEN", "确认人不在本次确认名单内");
    }
    if (input.contentVersion !== revision.contentVersion) {
      throw new DomainError("INVALID_STATE", "确认内容版本已过期，请刷新后重新确认");
    }
    const next = confirmMember(revision, context.actorId, context.now);
    return {
      data: {
        ...data,
        planRevisions: data.planRevisions.map((item) => (item.id === revision.id ? next : item)),
        logs: next === revision ? data.logs : [...data.logs, logEntry(context, "任务分配个人确认", revision.id, `内容版本 v${revision.contentVersion}`)],
      },
      result: next,
    };
  },
};

// ── 发布 / 例外发布 / 解锁 ───────────────────────────────────────

function publishPlanProjection(
  data: MockData,
  context: CommandContext,
  project: ReturnType<typeof findProjectOrThrow>,
  revision: PlanRevision,
  override: { reason: string; unconfirmed: string[] } | undefined,
): { data: MockData; result: PlanRevision } {
  const published: PlanRevision = { ...revision, status: "published", version: revision.version + 1 };
  const tasks = revision.payload.tasks;
  const otherTasks = data.tasks.filter((item) => item.projectId !== project.id);
  const previousTaskIds = new Set(data.tasks.filter((item) => item.projectId === project.id).map((item) => item.id));
  const otherCriteria = data.criteria.filter((item) => !previousTaskIds.has(item.taskId));
  const nextProject = {
    ...project,
    activePlanRevisionId: published.id,
    planVersion: published.number,
    planConfirmed: true,
    progress: project.progress,
    version: project.version + 1,
  };
  return {
    data: {
      ...data,
      planRevisions: data.planRevisions.map((item) => (item.id === revision.id ? published : item)),
      projects: data.projects.map((item) => (item.id === project.id ? nextProject : item)),
      tasks: [...otherTasks, ...tasks.map((item) => ({ ...item, projectId: project.id }))],
      criteria: [...otherCriteria, ...revision.payload.criteria.map((item) => ({ ...item }))],
      logs: [...data.logs, logEntry(
        context,
        override ? "任务计划例外发布" : "任务计划发布",
        published.id,
        `计划修订 ${published.number}（内容 v${published.contentVersion}）；任务 ${tasks.length} 个` +
          (override ? `；原因：${override.reason}；未确认成员：${override.unconfirmed.join("、") || "无"}` : ""),
      )],
    },
    result: published,
  };
}

export const publishPlanInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type PublishPlanInput = z.infer<typeof publishPlanInput>;

function assertPublishable(data: MockData, project: ReturnType<typeof findProjectOrThrow>, revision: PlanRevision): void {
  if (revision.status === "published") throw new DomainError("INVALID_STATE", "该计划版本已发布");
  if (project.activeBaselineRevisionId !== revision.baselineRevisionId) {
    throw new DomainError("INVALID_STATE", "计划必须基于仍生效的需求基线，请重新核对");
  }
  const baseline = data.baselineRevisions.find((item) => item.id === revision.baselineRevisionId);
  const issues = validatePlan(revision.payload, baseline?.payload, project.memberIds);
  if (issues.length) {
    throw new DomainError("INVALID_STATE", `任务计划未通过结构校验：${issues[0].message}`, {
      fieldErrors: Object.fromEntries(issues.map((issue) => [`${issue.taskId ?? "plan"}.${issue.field ?? "structure"}`, [issue.message]])),
    });
  }
}

export const publishPlan: Command<PublishPlanInput, PlanRevision> = {
  name: "project.publish",
  input: publishPlanInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.publish", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以发布任务计划");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertPublishable(data, project, revision);
    if (!confirmationsComplete(revision)) {
      throw new DomainError("INVALID_STATE", "仍有成员尚未确认当前计划版本");
    }
    return publishPlanProjection(data, context, project, revision, undefined);
  },
};

export const forcePublishPlanInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  reason: z.string().trim().min(1, "请填写例外发布原因"),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type ForcePublishPlanInput = z.infer<typeof forcePublishPlanInput>;

export const forcePublishPlan: Command<ForcePublishPlanInput, PlanRevision> = {
  name: "project.publish.override",
  input: forcePublishPlanInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.publish.override", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以例外发布任务计划");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertPublishable(data, project, revision);
    const unconfirmed = revision.memberRoster.filter((userId) =>
      !revision.confirmations.some((item) => item.userId === userId && item.revisionId === revision.id && item.contentVersion === revision.contentVersion),
    );
    return publishPlanProjection(data, context, project, revision, { reason: input.reason, unconfirmed });
  },
};

export const unlockPlanInput = z.object({
  projectId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type UnlockPlanInput = z.infer<typeof unlockPlanInput>;

export const unlockPlan: Command<UnlockPlanInput, PlanRevision> = {
  name: "project.plan.unlock",
  input: unlockPlanInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.plan.unlock", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以解锁任务规划");
    }
    checkVersion(project, input.expectedVersion);
    const active = project.activePlanRevisionId
      ? data.planRevisions.find((item) => item.id === project.activePlanRevisionId)
      : undefined;
    if (!active) throw new DomainError("INVALID_STATE", "尚未发布任务计划，无需解锁");
    const draft: PlanRevision = {
      ...active,
      id: `plan-${project.id}-${Date.now().toString(36)}`,
      number: active.number + 1,
      version: 1,
      contentVersion: 1,
      status: "draft",
      payload: {
        tasks: active.payload.tasks.map((item) => ({ ...item })),
        criteria: active.payload.criteria.map((item) => ({ ...item })),
        milestoneLinks: active.payload.milestoneLinks.map((item) => ({ ...item, milestoneIds: [...item.milestoneIds] })),
      },
      memberRoster: [...project.memberIds],
      confirmations: [],
      basedOnRevisionId: active.id,
    };
    return {
      data: {
        ...data,
        planRevisions: [...data.planRevisions, draft],
        projects: data.projects.map((item) => (item.id === project.id ? { ...item, planConfirmed: false, planVersion: item.planVersion + 1, version: item.version + 1 } : item)),
        logs: [...data.logs, logEntry(context, "解锁任务规划", draft.id, `基于计划 ${active.id} 创建草稿 v${draft.number}；旧历史保留`)],
      },
      result: draft,
    };
  },
};
