import { z } from "zod";
import type { MockData, SetupDraft } from "@/types/domain";
import { can } from "../access/policy.ts";
import { appliedCourseRule } from "../versioning.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";
import { assertProjectWritable } from "./project.ts";

/**
 * 项目初始化六步编排（阶段 07）。
 *
 * - 向导字段、处理选择保存到 SetupDraft，刷新可恢复；未保存内容只保留在表单层。
 * - 课程硬约束不可通过信息表单绕开。
 * - Mock 分析明确标记演示；分析产物写入 06 的基线草稿，重复执行不产生重复正式数据。
 * - 冲突项由实际分析结果生成；没有真实冲突时可跳过冲突选择。
 * - 第六步完成依据 activeBaselineRevisionId，不按页面内 ready 布尔值判断。
 */

const formSchema = z.object({
  name: z.string().trim().min(2, "项目名称至少需要 2 个字符"),
  description: z.string().trim().min(1, "请填写项目简介"),
  type: z.string().trim().min(1),
  finalDeadline: z.string().regex(/^\d{4}-\d{2}/, "请填写日期"),
});

const conflictSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  choices: z.array(z.string()),
  selected: z.string().optional(),
});

export const saveSetupDraftInput = z.object({
  projectId: z.string().min(1),
  step: z.number().int().min(1).max(6),
  form: formSchema,
  selectedFileIds: z.array(z.string()),
  pastedSources: z.array(z.object({ id: z.string().min(1), title: z.string(), text: z.string() })),
  conflicts: z.array(conflictSchema),
  baselineDraftId: z.string().optional(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type SaveSetupDraftInput = z.infer<typeof saveSetupDraftInput>;

function findProjectOrThrow(data: MockData, projectId: string) {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  assertProjectWritable(project);
  return project;
}

function assertMember(data: MockData, actorId: string, projectId: string): void {
  if (!can(data, actorId, "project.draft.edit", { kind: "project", id: projectId })) {
    throw new DomainError("FORBIDDEN", "只有项目成员可以编辑初始化草稿");
  }
}

function checkVersion(project: { version: number }, expectedVersion: number): void {
  if (project.version !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
  }
}

function upsertDraft(data: MockData, draft: SetupDraft): MockData {
  const kept = data.setupDrafts.filter((item) => item.projectId !== draft.projectId);
  return { ...data, setupDrafts: [...kept, draft] };
}

export function conflictsResolved(conflicts: SetupDraft["conflicts"]): boolean {
  return conflicts.every((item) => item.selected !== undefined && item.choices.includes(item.selected));
}

export const saveSetupDraft: Command<SaveSetupDraftInput, SetupDraft> = {
  name: "project.draft.edit",
  input: saveSetupDraftInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    assertMember(data, context.actorId, project.id);
    checkVersion(project, input.expectedVersion);
    // 课程硬约束：项目截止不能晚于所采用课程规则的项目截止
    const rule = appliedCourseRule(data, project.id);
    const limit = rule?.snapshot.projectDeadline ?? (project.courseId ? data.courses.find((item) => item.id === project.courseId)?.projectDeadline : undefined);
    if (limit && input.form.finalDeadline > limit) {
      throw new DomainError("VALIDATION_ERROR", "课程硬约束：项目截止日期不能晚于课程要求", {
        fieldErrors: { "form.finalDeadline": [`不晚于 ${limit}`] },
      });
    }
    const current = data.setupDrafts.find((item) => item.projectId === project.id);
    const draft: SetupDraft = {
      projectId: project.id,
      step: input.step as SetupDraft["step"],
      form: { ...input.form },
      selectedFileIds: [...input.selectedFileIds],
      pastedSources: input.pastedSources.map((item) => ({ ...item })),
      analysis: current?.analysis ?? { status: "idle" },
      conflicts: input.conflicts.map((item) => ({ ...item, choices: [...item.choices] })),
      baselineDraftId: input.baselineDraftId ?? current?.baselineDraftId,
      version: (current?.version ?? 0) + 1,
    };
    return {
      data: {
        ...data,
        setupDrafts: data.setupDrafts.filter((item) => item.projectId !== project.id).concat(draft),
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "保存初始化草稿",
          target: project.id,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `步骤 ${draft.step}；资料 ${draft.selectedFileIds.length} 份；粘贴来源 ${draft.pastedSources.length} 条`,
        }],
      },
      result: draft,
    };
  },
};

export const advanceSetupStepInput = z.object({
  projectId: z.string().min(1),
  toStep: z.number().int().min(1).max(6),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type AdvanceSetupStepInput = z.infer<typeof advanceSetupStepInput>;

export const advanceSetupStep: Command<AdvanceSetupStepInput, SetupDraft> = {
  name: "project.draft.edit",
  input: advanceSetupStepInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    assertMember(data, context.actorId, project.id);
    checkVersion(project, input.expectedVersion);
    const draft = data.setupDrafts.find((item) => item.projectId === project.id);
    if (!draft) throw new DomainError("NOT_FOUND", "尚未保存初始化草稿");
    const step = draft.step;

    // 前进按当前步骤校验条件；后退不限制
    if (input.toStep > step) {
      if (step === 2 && input.toStep >= 3) {
        const validFiles = draft.selectedFileIds.filter((id) => data.files.some((item) => item.id === id && item.projectId === project.id));
        if (!validFiles.length && !draft.pastedSources.length) {
          throw new DomainError("INVALID_STATE", "没有有效资料不能进入分析");
        }
      }
      if (step === 3 && input.toStep >= 4 && draft.analysis.status !== "succeeded") {
        throw new DomainError("INVALID_STATE", "请先完成需求分析");
      }
      if (step === 4 && input.toStep >= 5 && !conflictsResolved(draft.conflicts)) {
        throw new DomainError("INVALID_STATE", "请逐项确定冲突的官方内容");
      }
      if (step === 5 && input.toStep >= 6) {
        const revision = draft.baselineDraftId ? data.baselineRevisions.find((item) => item.id === draft.baselineDraftId) : undefined;
        const requirements = revision?.payload.requirements ?? data.requirements.filter((item) => item.projectId === project.id);
        const modules = revision?.payload.modules ?? data.modules.filter((item) => item.projectId === project.id);
        if (!requirements.length) throw new DomainError("INVALID_STATE", "请至少保留一条需求");
        if (!modules.length) throw new DomainError("INVALID_STATE", "需求分析需要完整的功能模块");
      }
    }
    const next: SetupDraft = { ...draft, step: input.toStep as SetupDraft["step"], version: draft.version + 1 };
    return {
      data: {
        ...data,
        setupDrafts: data.setupDrafts.filter((item) => item.projectId !== project.id).concat(next),
        logs: [...data.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "初始化步骤推进",
          target: project.id,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `步骤 ${step} → ${input.toStep}`,
        }],
      },
      result: next,
    };
  },
};

export const runMockRequirementAnalysisInput = z.object({
  projectId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type RunMockRequirementAnalysisInput = z.infer<typeof runMockRequirementAnalysisInput>;

/** 模拟分析：从已保存来源生成确定性需求/模块草稿与真实冲突项（演示，不解析文件字节） */
function analyzeSources(data: MockData, draft: SetupDraft) {
  const sources = [
    ...draft.selectedFileIds
      .filter((id) => data.files.some((item) => item.id === id))
      .map((id) => ({ key: id, title: data.files.find((item) => item.id === id)?.name ?? id, text: `资料 ${id} 的要点` })),
    ...draft.pastedSources.map((item) => ({ key: item.id, title: item.title, text: item.text })),
  ];
  const usable = sources.filter((item) => item.text.trim().length >= 10);
  const requirements = usable.map((item, index) => ({
    id: `req-setup-${item.key}`,
    projectId: draft.projectId,
    title: item.title.slice(0, 40) || `分析需求 ${index + 1}`,
    description: item.text.slice(0, 160),
    priority: "medium" as const,
    status: "draft" as const,
    moduleId: "module-setup-1",
    version: 1,
    source: item.title,
  }));
  const modules = usable.length ? [{
    id: "module-setup-1",
    projectId: draft.projectId,
    name: "核心业务流程",
    description: "由项目目标和导入资料提取的核心模块（演示分析）",
    requirementIds: requirements.map((item) => item.id),
    ownerId: "",
    progress: 0,
    core: true,
  }] : [];
  // 冲突项由实际分析结果生成：来源中出现与课程截止不同的日期时产生冲突
  const rule = appliedCourseRule(data, draft.projectId);
  const officialDeadline = rule?.snapshot.projectDeadline ?? "";
  const conflicts: SetupDraft["conflicts"] = [];
  for (const item of usable) {
    const dates = item.text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    for (const date of dates) {
      if (officialDeadline && date !== officialDeadline && !conflicts.some((entry) => entry.field === "finalDeadline" && entry.choices.includes(date))) {
        conflicts.push({ id: `conflict-finalDeadline-${date}`, field: "finalDeadline", choices: [officialDeadline, date] });
      }
    }
    if (/格式|format/i.test(item.text) && !conflicts.some((entry) => entry.field === "format")) {
      conflicts.push({ id: "conflict-format", field: "format", choices: ["课程文件", "项目草案"] });
    }
  }
  return { sources, usable, requirements, modules, conflicts };
}

export const runMockRequirementAnalysis: Command<RunMockRequirementAnalysisInput, SetupDraft> = {
  name: "project.draft.edit",
  input: runMockRequirementAnalysisInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    assertMember(data, context.actorId, project.id);
    checkVersion(project, input.expectedVersion);
    const draft = data.setupDrafts.find((item) => item.projectId === project.id);
    if (!draft) throw new DomainError("NOT_FOUND", "尚未保存初始化草稿");
    const validFiles = draft.selectedFileIds.filter((id) => data.files.some((item) => item.id === id && item.projectId === project.id));
    if (!validFiles.length && !draft.pastedSources.length) {
      throw new DomainError("INVALID_STATE", "没有有效资料不能进入分析");
    }

    const { usable, requirements, modules, conflicts } = analyzeSources(data, draft);
    if (!usable.length) {
      const failed: SetupDraft = { ...draft, analysis: { status: "failed" }, version: draft.version + 1 };
      return {
        data: upsertDraft(data, failed),
        result: failed,
      };
    }

    // 结果写入 06 的基线草稿；重复执行使用稳定 ID，不产生重复正式数据
    let revision = draft.baselineDraftId ? data.baselineRevisions.find((item) => item.id === draft.baselineDraftId) : undefined;
    let nextData = data;
    const payload = {
      requirements,
      modules,
      sourceFileIds: validFiles,
    };
    if (!revision) {
      revision = {
        id: `baseline-${project.id}-setup`,
        projectId: project.id,
        number: Math.max(1, project.baselineVersion + 1),
        version: 1,
        contentVersion: 1,
        status: "draft",
        payload,
        memberRoster: [...project.memberIds],
        confirmations: [],
        reason: "初始化分析草稿（演示）",
      };
      nextData = { ...nextData, baselineRevisions: [...nextData.baselineRevisions, revision] };
    } else {
      // 内容修改递增 contentVersion 并使旧确认失效
      revision = {
        ...revision,
        payload,
        contentVersion: revision.contentVersion + 1,
        confirmations: [],
        status: "draft",
        version: revision.version + 1,
        reason: "重新运行初始化分析（演示）",
      };
      nextData = { ...nextData, baselineRevisions: nextData.baselineRevisions.map((item) => (item.id === revision!.id ? revision! : item)) };
    }

    const next: SetupDraft = {
      ...draft,
      analysis: { status: "succeeded", jobId: `analysis-${context.logId}` },
      conflicts,
      baselineDraftId: revision.id,
      version: draft.version + 1,
    };
    return {
      data: {
        ...upsertDraft(nextData, next),
        logs: [...nextData.logs, {
          id: context.logId,
          actorId: context.actorId,
          action: "运行需求分析（演示）",
          target: project.id,
          result: "success",
          ip: "mock",
          createdAt: context.now,
          detail: `生成需求 ${requirements.length} 条、模块 ${modules.length} 个、冲突 ${conflicts.length} 项；写入基线草稿 ${revision.id} v${revision.contentVersion}`,
        }],
      },
      result: next,
    };
  },
};
