import { z } from "zod";
import type { MockData, Project } from "@/types/domain";
import { can } from "../access/policy.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";

/** 归档/定稿对象拒绝业务写入（阶段 11）；迁移的写命令统一调用 */
export function assertProjectWritable(project: { id: string; lifecycle: Project["lifecycle"] }): void {
  if (project.lifecycle !== "active") {
    throw new DomainError("INVALID_STATE", "项目已定稿或归档，不再接受业务写入");
  }
}

/**
 * 项目域命令。归档是第一条完整链路（校验 → 权限 → 版本 → 状态 → 日志 → 原子保存）。
 * 其他领域命令由 04–11 各阶段在 registry 注册实现。
 */

export const archiveProjectInput = z.object({
  projectId: z.string().min(1, "缺少项目 ID"),
  expectedVersion: z.number().int().nonnegative("缺少当前版本号"),
}).strict("包含不允许的字段");

export type ArchiveProjectInput = z.infer<typeof archiveProjectInput>;

export function applyArchive(
  data: MockData,
  context: CommandContext,
  input: ArchiveProjectInput,
): { data: MockData; result: Project } {
  const project = data.projects.find((item) => item.id === input.projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  if (!can(data, context.actorId, "project.archive", { kind: "project", id: project.id })) {
    throw new DomainError("FORBIDDEN", "当前用户不能归档此项目");
  }
  if (project.version !== input.expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
  }
  if (project.lifecycle !== "finalized") {
    throw new DomainError("INVALID_STATE", "项目必须先定稿才能归档");
  }

  const archived: Project = { ...project, lifecycle: "archived", version: project.version + 1 };
  return {
    data: {
      ...data,
      projects: data.projects.map((item) => (item.id === project.id ? archived : item)),
      logs: [...data.logs, {
        id: context.logId,
        actorId: context.actorId,
        action: "归档项目",
        target: project.id,
        result: "success",
        ip: "mock",
        createdAt: context.now,
        detail: `归档版本 v${project.version}`,
      }],
    },
    result: archived,
  };
}

export const archiveProject: Command<ArchiveProjectInput, Project> = {
  name: "project.archive",
  input: archiveProjectInput,
  apply: applyArchive,
};

// ── updateProjectSettings（字段白名单） ────────────────────────────

export const updateProjectSettingsInput = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(2, "项目名称至少需要 2 个字符"),
  language: z.enum(["zh", "en"]),
  visibility: z.enum(["members", "course"]),
  expectedVersion: z.number().int().nonnegative(),
}).strict("包含白名单之外的字段");

export type UpdateProjectSettingsInput = z.infer<typeof updateProjectSettingsInput>;

export const updateProjectSettings: Command<UpdateProjectSettingsInput, Project> = {
  name: "project.settings.update",
  input: updateProjectSettingsInput,
  apply(data, context, input) {
    const project = data.projects.find((item) => item.id === input.projectId);
    if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
    if (!can(data, context.actorId, "project.settings.update", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以修改项目设置");
    }
    if (project.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
    }
    assertProjectWritable(project);
    const next: Project = {
      ...project,
      name: input.name,
      language: input.language,
      visibility: input.visibility,
      version: project.version + 1,
    };
    return {
      data: {
        ...data,
        projects: data.projects.map((item) => (item.id === project.id ? next : item)),
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "修改项目设置",
          target: project.id,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `v${project.version} → v${next.version}；名称 ${project.name} → ${next.name}；可见范围 ${project.visibility ?? "members"} → ${next.visibility}`,
        }],
      },
      result: next,
    };
  },
};

// ── reopenProject（独立修订，完整 ID 映射） ────────────────────────

export const reopenProjectInput = z.object({
  projectId: z.string().min(1),
  revisionLabel: z.string().trim().min(1, "请填写修订标签"),
  reason: z.string().trim().min(1, "请填写重新开启原因"),
  retainTasksAndEvidence: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type ReopenProjectInput = z.infer<typeof reopenProjectInput>;

export const reopenProject: Command<ReopenProjectInput, Project> = {
  name: "project.reopen",
  input: reopenProjectInput,
  apply(data, context, input) {
    const source = data.projects.find((item) => item.id === input.projectId);
    if (!source) throw new DomainError("NOT_FOUND", "项目不存在");
    if (!can(data, context.actorId, "project.reopen", { kind: "project", id: source.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以重新开启项目");
    }
    if (source.version !== input.expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: source.version });
    }
    if (source.lifecycle === "active") {
      throw new DomainError("INVALID_STATE", "进行中的项目不能重新开启；请先定稿或归档");
    }
    // 重复重开请求不生成多份：返回已有 active 修订
    const existing = data.projects.find((item) => item.sourceProjectId === source.id && item.lifecycle === "active");
    if (existing) return { data, result: existing };

    const newProjectId = `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let seq = 0;
    const mapFor = (prefix: string) => () => `${prefix}-${newProjectId}-${++seq}`;
    const moduleIdMap = new Map<string, string>();
    const requirementIdMap = new Map<string, string>();
    const taskIdMap = new Map<string, string>();
    const criterionIdMap = new Map<string, string>();
    const milestoneIdMap = new Map<string, string>();
    const evidenceIdMap = new Map<string, string>();
    const verificationIdMap = new Map<string, string>();
    const allocate = (map: Map<string, string>, prefix: string, oldId: string) => {
      if (!map.has(oldId)) map.set(oldId, mapFor(prefix)());
      return map.get(oldId)!;
    };

    const sourceModules = data.modules.filter((item) => item.projectId === source.id);
    const sourceRequirements = data.requirements.filter((item) => item.projectId === source.id);
    const sourceTasks = data.tasks.filter((item) => item.projectId === source.id);
    const sourceCriteria = data.criteria.filter((item) => sourceTasks.some((task) => task.id === item.taskId));
    const sourceMilestones = data.milestones.filter((item) => item.projectId === source.id);
    const sourceEvidence = data.evidence.filter((item) => item.projectId === source.id);
    const sourceVerifications = data.verifications.filter((item) => item.projectId === source.id);

    const modules = sourceModules.map((item) => ({
      ...item,
      id: allocate(moduleIdMap, "module", item.id),
      projectId: newProjectId,
      requirementIds: item.requirementIds.map((id) => allocate(requirementIdMap, "requirement", id)),
    }));
    const requirements = sourceRequirements.map((item) => ({
      ...item,
      id: allocate(requirementIdMap, "requirement", item.id),
      projectId: newProjectId,
      moduleId: allocate(moduleIdMap, "module", item.moduleId),
      version: 1,
    }));
    const criteria = sourceCriteria.map((item) => ({
      ...item,
      id: allocate(criterionIdMap, "criterion", item.id),
      taskId: allocate(taskIdMap, "task", item.taskId),
      version: 1,
      result: undefined,
      humanConfirmedBy: [],
    }));
    const tasks = sourceTasks.map((item) => ({
      ...item,
      id: allocate(taskIdMap, "task", item.id),
      projectId: newProjectId,
      moduleId: allocate(moduleIdMap, "module", item.moduleId),
      parentTaskId: item.parentTaskId ? allocate(taskIdMap, "task", item.parentTaskId) : undefined,
      requirementIds: item.requirementIds.map((id) => allocate(requirementIdMap, "requirement", id)),
      criterionIds: item.criterionIds.map((id) => allocate(criterionIdMap, "criterion", id)),
      dependencyIds: item.dependencyIds.map((id) => allocate(taskIdMap, "task", id)),
      milestoneIds: item.milestoneIds.map((id) => allocate(milestoneIdMap, "milestone", id)),
      version: 1,
    }));
    const milestones = sourceMilestones.map((item) => ({
      ...item,
      id: allocate(milestoneIdMap, "milestone", item.id),
      projectId: newProjectId,
      taskIds: item.taskIds.map((id) => allocate(taskIdMap, "task", id)),
    }));
    const evidence = input.retainTasksAndEvidence ? sourceEvidence.map((item) => ({
      ...item,
      id: allocate(evidenceIdMap, "evidence", item.id),
      projectId: newProjectId,
      taskId: allocate(taskIdMap, "task", item.taskId),
      criterionIds: item.criterionIds.map((id) => criterionIdMap.get(id) ?? id),
      version: 1,
    })) : [];
    // 复制的验收标为 outdated 并清空新修订的人为确认
    const verifications = input.retainTasksAndEvidence ? sourceVerifications.map((item) => ({
      ...item,
      id: allocate(verificationIdMap, "verification", item.id),
      projectId: newProjectId,
      taskId: allocate(taskIdMap, "task", item.taskId),
      criterionResults: item.criterionResults.map((result) => ({
        ...result,
        criterionId: criterionIdMap.get(result.criterionId) ?? result.criterionId,
        evidenceIds: result.evidenceIds.map((id) => evidenceIdMap.get(id) ?? id),
      })),
      status: "outdated" as const,
      humanConfirmedBy: [],
      version: 1,
    })) : [];

    const project: Project = {
      ...source,
      id: newProjectId,
      sourceProjectId: source.id,
      name: source.name,
      description: `${source.description}\n修订 ${input.revisionLabel}：${input.reason}`,
      lifecycle: "active",
      setupStatus: "pending_confirmation",
      setupStep: 6,
      baselineVersion: 0,
      planVersion: 0,
      planConfirmed: false,
      confirmedBy: [],
      activeBaselineRevisionId: undefined,
      activePlanRevisionId: undefined,
      progress: input.retainTasksAndEvidence ? source.progress : 0,
      coreProgress: input.retainTasksAndEvidence ? source.coreProgress : 0,
      memberIds: [...source.memberIds],
      version: 1,
    };

    // 新修订的基线/计划为草稿并清空确认；历史复制带来源，不把旧签名当新签名
    const baselineDraft = {
      id: `baseline-${newProjectId}-draft`,
      projectId: newProjectId,
      number: 1,
      version: 1,
      contentVersion: 1,
      status: "draft" as const,
      payload: {
        requirements: requirements.map((item) => ({ ...item })),
        modules: modules.map((item) => ({ ...item })),
        sourceFileIds: [],
      },
      memberRoster: [...source.memberIds],
      confirmations: [],
      basedOnRevisionId: source.activeBaselineRevisionId,
      reason: `重新开启（${input.revisionLabel}）：${input.reason}`,
    };
    const planDraft = input.retainTasksAndEvidence ? {
      id: `plan-${newProjectId}-draft`,
      projectId: newProjectId,
      number: 1,
      version: 1,
      contentVersion: 1,
      status: "draft" as const,
      payload: {
        tasks: tasks.map((item) => ({ ...item })),
        criteria: criteria.map((item) => ({ ...item })),
        milestoneLinks: tasks.map((item) => ({ taskId: item.id, milestoneIds: [...item.milestoneIds] })),
      },
      memberRoster: [...source.memberIds],
      confirmations: [],
      baselineRevisionId: baselineDraft.id,
      basedOnRevisionId: source.activePlanRevisionId,
    } : undefined;

    return {
      data: {
        ...data,
        projects: [...data.projects, project],
        modules: [...data.modules, ...modules],
        requirements: [...data.requirements, ...requirements],
        tasks: [...data.tasks, ...tasks],
        criteria: [...data.criteria, ...criteria],
        milestones: [...data.milestones, ...milestones],
        evidence: [...data.evidence, ...evidence],
        verifications: [...data.verifications, ...verifications],
        baselineRevisions: [...data.baselineRevisions, baselineDraft],
        planRevisions: planDraft ? [...data.planRevisions, planDraft] : data.planRevisions,
        groups: source.groupId ? data.groups.map((item) => (item.id === source.groupId ? { ...item, projectId: newProjectId, version: item.version + 1 } : item)) : data.groups,
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "项目重新开启",
          target: newProjectId,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `源 ${source.id} v${source.version}（${source.lifecycle}）；修订 ${input.revisionLabel}；原因：${input.reason}；${input.retainTasksAndEvidence ? "保留任务与证据历史（验收标为待复核）" : "仅复制需求基线与设置"}`,
        }],
      },
      result: project,
    };
  },
};
