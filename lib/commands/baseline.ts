import { z } from "zod";
import type {
  BaselinePayload,
  BaselineRevision,
  FunctionalModule,
  MockData,
  Requirement,
} from "@/types/domain";
import { can } from "../access/policy.ts";
import {
  activeBaseline,
  confirmationsComplete,
  confirmedUserIds,
  confirmMember,
} from "../versioning.ts";
import { DomainError, type Command, type CommandContext } from "./core.ts";
import { assertProjectWritable } from "./project.ts";

/**
 * 需求基线管理（阶段 06）。
 *
 * - 正式版本不可原地编辑；新建/编辑进入独立草稿，修改草稿增加 contentVersion 并使确认失效。
 * - 确认仅属于当前会话成员及当前内容版本（idempotent，不伪造签名）。
 * - 正常发布需全 roster 确认；例外推进保存原因与未确认名单，同等硬校验不可跳过。
 * - 发布替换当前 Requirement/Module 投影、更新生效指针与兼容字段，保留所有旧快照；
 *   受影响任务的当前验收标记过期，引用旧基线的计划标记待复核。
 */

const requirementSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().trim().min(1, "需求名称不能为空"),
  description: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["draft", "confirmed", "in_progress", "implemented", "verified"]),
  moduleId: z.string().min(1),
  version: z.number().int().nonnegative(),
  source: z.string(),
});

const moduleSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().trim().min(1, "模块名称不能为空"),
  description: z.string(),
  requirementIds: z.array(z.string()),
  ownerId: z.string(),
  progress: z.number().min(0).max(100),
  core: z.boolean(),
});

export const baselinePayloadSchema = z.object({
  requirements: z.array(requirementSchema),
  modules: z.array(moduleSchema),
  sourceFileIds: z.array(z.string()),
});

export type BaselinePayloadInput = z.infer<typeof baselinePayloadSchema>;

export interface BaselineDiff {
  addedRequirementIds: string[];
  removedRequirementIds: string[];
  changedRequirements: { id: string; fields: string[] }[];
  moduleChanges: { id: string; fields: string[] }[];
  sourceFileChanges: { added: string[]; removed: string[] };
}

export function compareBaselines(
  data: MockData,
  fromRevisionId: string | undefined,
  toRevisionId: string,
): BaselineDiff {
  const to = data.baselineRevisions.find((item) => item.id === toRevisionId);
  if (!to) throw new DomainError("NOT_FOUND", "目标基线版本不存在");
  const from = fromRevisionId ? data.baselineRevisions.find((item) => item.id === fromRevisionId) : undefined;
  const diff: BaselineDiff = {
    addedRequirementIds: [],
    removedRequirementIds: [],
    changedRequirements: [],
    moduleChanges: [],
    sourceFileChanges: { added: [], removed: [] },
  };
  if (!from) {
    diff.addedRequirementIds = to.payload.requirements.map((item) => item.id);
    diff.sourceFileChanges.added = [...to.payload.sourceFileIds];
    return diff;
  }
  const fromReq = new Map(from.payload.requirements.map((item) => [item.id, item]));
  const toReq = new Map(to.payload.requirements.map((item) => [item.id, item]));
  for (const [id, item] of toReq) {
    const before = fromReq.get(id);
    if (!before) { diff.addedRequirementIds.push(id); continue; }
    const fields = (Object.keys(item) as (keyof Requirement)[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(item[key]));
    if (fields.length) diff.changedRequirements.push({ id, fields: fields.map(String) });
  }
  for (const id of fromReq.keys()) if (!toReq.has(id)) diff.removedRequirementIds.push(id);

  const fromMod = new Map(from.payload.modules.map((item) => [item.id, item]));
  for (const item of to.payload.modules) {
    const before = fromMod.get(item.id);
    if (!before) { diff.moduleChanges.push({ id: item.id, fields: ["added"] }); continue; }
    const fields = (Object.keys(item) as (keyof FunctionalModule)[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(item[key]));
    if (fields.length) diff.moduleChanges.push({ id: item.id, fields: fields.map(String) });
  }
  const fromFiles = new Set(from.payload.sourceFileIds);
  const toFiles = new Set(to.payload.sourceFileIds);
  for (const id of toFiles) if (!fromFiles.has(id)) diff.sourceFileChanges.added.push(id);
  for (const id of fromFiles) if (!toFiles.has(id)) diff.sourceFileChanges.removed.push(id);
  return diff;
}

export function getBaselineHistory(data: MockData, projectId: string): BaselineRevision[] {
  return data.baselineRevisions
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => b.number - a.number || b.contentVersion - a.contentVersion);
}

function findProjectOrThrow(data: MockData, projectId: string) {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new DomainError("NOT_FOUND", "项目不存在");
  assertProjectWritable(project);
  return project;
}

function findRevisionOrThrow(data: MockData, projectId: string, revisionId: string): BaselineRevision {
  const revision = data.baselineRevisions.find((item) => item.id === revisionId && item.projectId === projectId);
  if (!revision) throw new DomainError("NOT_FOUND", "基线版本不存在");
  return revision;
}

function assertEditable(revision: BaselineRevision): void {
  if (revision.status === "published") {
    throw new DomainError("INVALID_STATE", "正式版本不可原地编辑，请创建变更草稿");
  }
}

/** 内容与关联硬校验：其他项目的模块/文件不能作为关联输入；双向关联保持一致 */
function normalizeAndValidate(data: MockData, projectId: string, payload: BaselinePayloadInput): BaselinePayload {
  const fieldErrors: Record<string, string[]> = {};
  const moduleIds = new Set(payload.modules.map((item) => item.id));
  for (const requirement of payload.requirements) {
    if (requirement.projectId !== projectId) fieldErrors[`requirements.${requirement.id}`] = ["需求不属于该项目"];
    if (!moduleIds.has(requirement.moduleId)) fieldErrors[`requirements.${requirement.id}.moduleId`] = ["模块关联无效或来自其他项目"];
  }
  for (const entry of payload.modules) {
    if (entry.projectId !== projectId) fieldErrors[`modules.${entry.id}`] = ["模块不属于该项目"];
  }
  for (const fileId of payload.sourceFileIds) {
    const file = data.files.find((item) => item.id === fileId);
    if (!file || file.projectId !== projectId) fieldErrors[`sourceFileIds.${fileId}`] = ["资料不属于该项目"];
  }
  if (Object.keys(fieldErrors).length) {
    throw new DomainError("VALIDATION_ERROR", "基线内容或关联校验未通过", { fieldErrors });
  }
  // Requirement.moduleId ↔ Module.requirementIds 双向一致
  const modules = payload.modules.map((entry) => ({
    ...entry,
    requirementIds: payload.requirements.filter((item) => item.moduleId === entry.id).map((item) => item.id),
  }));
  return {
    requirements: payload.requirements.map((item) => ({ ...item })),
    modules,
    sourceFileIds: [...payload.sourceFileIds],
  };
}

function baselineSnapshotOf(data: MockData, projectId: string): BaselinePayload {
  return {
    requirements: data.requirements.filter((item) => item.projectId === projectId).map((item) => ({ ...item })),
    modules: data.modules.filter((item) => item.projectId === projectId).map((item) => ({ ...item, requirementIds: [...item.requirementIds] })),
    sourceFileIds: data.files.filter((item) => item.projectId === projectId).map((item) => item.id),
  };
}

function checkVersion(project: { version: number }, expectedVersion: number): void {
  if (project.version !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "项目已更新，请刷新后重试", { latestVersion: project.version });
  }
}

function logEntry(context: CommandContext, action: string, target: string, detail: string) {
  return { id: context.logId, actorId: context.actorId, action, target, result: "success" as const, ip: "mock", createdAt: context.now, detail };
}

// ── createBaselineDraft ──────────────────────────────────────────

export const createBaselineDraftInput = z.object({
  projectId: z.string().min(1),
  basedOnRevisionId: z.string().optional(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type CreateBaselineDraftInput = z.infer<typeof createBaselineDraftInput>;

export const createBaselineDraft: Command<CreateBaselineDraftInput, BaselineRevision> = {
  name: "project.draft.edit",
  input: createBaselineDraftInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.draft.edit", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有项目成员可以编辑基线草稿");
    }
    checkVersion(project, input.expectedVersion);
    const existing = data.baselineRevisions.find((item) => item.projectId === project.id && item.status !== "published");
    if (existing) return { data, result: existing };

    const base = input.basedOnRevisionId
      ? findRevisionOrThrow(data, project.id, input.basedOnRevisionId)
      : activeBaseline(data, project.id);
    const revision: BaselineRevision = {
      id: `baseline-${project.id}-${Date.now().toString(36)}`,
      projectId: project.id,
      number: (base?.number ?? Math.max(0, project.baselineVersion)) + 1,
      version: 1,
      contentVersion: 1,
      status: "draft",
      payload: base ? { requirements: base.payload.requirements.map((item) => ({ ...item })), modules: base.payload.modules.map((item) => ({ ...item })), sourceFileIds: [...base.payload.sourceFileIds] } : baselineSnapshotOf(data, project.id),
      memberRoster: [...project.memberIds],
      confirmations: [],
      basedOnRevisionId: base?.id,
    };
    return {
      data: { ...data, baselineRevisions: [...data.baselineRevisions, revision] },
      result: revision,
    };
  },
};

// ── saveBaselineDraft ────────────────────────────────────────────

export const saveBaselineDraftInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  payload: baselinePayloadSchema,
  reason: z.string().trim().min(1, "请填写变更原因"),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type SaveBaselineDraftInput = z.infer<typeof saveBaselineDraftInput>;

export const saveBaselineDraft: Command<SaveBaselineDraftInput, BaselineRevision> = {
  name: "project.draft.edit",
  input: saveBaselineDraftInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.draft.edit", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有项目成员可以编辑基线草稿");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertEditable(revision);
    const payload = normalizeAndValidate(data, project.id, input.payload);
    const next: BaselineRevision = {
      ...revision,
      payload,
      reason: input.reason,
      contentVersion: revision.contentVersion + 1,
      confirmations: [],
      status: "draft",
      version: revision.version + 1,
    };
    return {
      data: {
        ...data,
        baselineRevisions: data.baselineRevisions.map((item) => (item.id === revision.id ? next : item)),
        logs: [...data.logs, logEntry(context, "基线草稿修改", revision.id, `内容版本 v${revision.contentVersion} → v${next.contentVersion}；原因：${input.reason}`)],
      },
      result: next,
    };
  },
};

// ── submitBaselineForConfirmation ────────────────────────────────

export const submitBaselineForConfirmationInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type SubmitBaselineForConfirmationInput = z.infer<typeof submitBaselineForConfirmationInput>;

export const submitBaselineForConfirmation: Command<SubmitBaselineForConfirmationInput, BaselineRevision> = {
  name: "project.draft.edit",
  input: submitBaselineForConfirmationInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.draft.edit", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有项目成员可以提交基线确认");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertEditable(revision);
    const next: BaselineRevision = {
      ...revision,
      status: "confirming",
      confirmations: [],
      memberRoster: [...project.memberIds],
      version: revision.version + 1,
    };
    return {
      data: {
        ...data,
        baselineRevisions: data.baselineRevisions.map((item) => (item.id === revision.id ? next : item)),
        logs: [...data.logs, logEntry(context, "基线提交确认", revision.id, `内容版本 v${next.contentVersion}；确认名单 ${next.memberRoster.length} 人`)],
      },
      result: next,
    };
  },
};

// ── confirmBaselineSelf ──────────────────────────────────────────

export const confirmBaselineSelfInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  contentVersion: z.number().int().positive(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type ConfirmBaselineSelfInput = z.infer<typeof confirmBaselineSelfInput>;

export const confirmBaselineSelf: Command<ConfirmBaselineSelfInput, BaselineRevision> = {
  name: "project.confirm.self",
  input: confirmBaselineSelfInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.confirm.self", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有项目成员可以确认基线");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertEditable(revision);
    if (!revision.memberRoster.includes(context.actorId)) {
      throw new DomainError("FORBIDDEN", "确认人不在本次确认名单内");
    }
    if (input.contentVersion !== revision.contentVersion) {
      throw new DomainError("INVALID_STATE", "确认内容版本已过期，请刷新后重新确认");
    }
    const next = confirmMember(revision, context.actorId, context.now);
    const confirmedBy = [...new Set([...project.confirmedBy, context.actorId])];
    return {
      data: {
        ...data,
        baselineRevisions: data.baselineRevisions.map((item) => (item.id === revision.id ? next : item)),
        projects: data.projects.map((item) => (item.id === project.id ? { ...item, confirmedBy } : item)),
        logs: next === revision ? data.logs : [...data.logs, logEntry(context, "基线个人确认", revision.id, `内容版本 v${revision.contentVersion}`)],
      },
      result: next,
    };
  },
};

// ── 发布（正常 / 例外） ─────────────────────────────────────────

function publishProjection(
  data: MockData,
  context: CommandContext,
  project: ReturnType<typeof findProjectOrThrow>,
  revision: BaselineRevision,
  override: { reason: string; unconfirmed: string[] } | undefined,
): { data: MockData; result: BaselineRevision } {
  const previous = activeBaseline(data, project.id);
  const diff = compareBaselines(data, previous?.id, revision.id);
  const changedRequirementIds = new Set([
    ...diff.addedRequirementIds,
    ...diff.removedRequirementIds,
    ...diff.changedRequirements.map((item) => item.id),
  ]);
  for (const moduleChange of diff.moduleChanges) {
    for (const requirement of revision.payload.requirements.filter((item) => item.moduleId === moduleChange.id)) {
      changedRequirementIds.add(requirement.id);
    }
  }
  // 受影响任务的当前验收标记过期（保留历史）
  const affectedTaskIds = new Set(
    data.tasks
      .filter((item) => item.projectId === project.id && item.requirementIds.some((id) => changedRequirementIds.has(id)))
      .map((item) => item.id),
  );
  const verifications = data.verifications.map((item) =>
    item.status === "current" && affectedTaskIds.has(item.taskId) ? { ...item, status: "outdated" as const } : item,
  );
  // 引用旧基线的计划标记待复核
  const planRevisions = data.planRevisions.map((item) =>
    previous && item.baselineRevisionId === previous.id && item.status === "published"
      ? { ...item, status: "draft" as const, version: item.version + 1 }
      : item,
  );

  const published: BaselineRevision = {
    ...revision,
    status: "published",
    version: revision.version + 1,
  };
  const confirmedBy = override ? confirmedUserIds(revision) : [...revision.memberRoster];
  const nextProject = {
    ...project,
    activeBaselineRevisionId: published.id,
    baselineVersion: published.number,
    setupStatus: "frozen" as const,
    setupStep: 6,
    confirmedBy,
    planConfirmed: previous ? false : project.planConfirmed,
    version: project.version + 1,
  };
  const otherRequirements = data.requirements.filter((item) => item.projectId !== project.id);
  const otherModules = data.modules.filter((item) => item.projectId !== project.id);
  return {
    data: {
      ...data,
      baselineRevisions: data.baselineRevisions.map((item) => (item.id === revision.id ? published : item)),
      projects: data.projects.map((item) => (item.id === project.id ? nextProject : item)),
      requirements: [...otherRequirements, ...published.payload.requirements.map((item) => ({ ...item }))],
      modules: [...otherModules, ...published.payload.modules.map((item) => ({ ...item }))],
      verifications,
      planRevisions,
      logs: [...data.logs, logEntry(
        context,
        override ? "需求基线例外推进" : "需求基线发布",
        published.id,
        `修订 ${published.number}（内容 v${published.contentVersion}）` +
          `；影响任务 ${affectedTaskIds.size} 个` +
          (override ? `；原因：${override.reason}；未确认成员：${override.unconfirmed.join("、") || "无"}` : ""),
      )],
    },
    result: published,
  };
}

export const publishBaselineInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type PublishBaselineInput = z.infer<typeof publishBaselineInput>;

export const publishBaseline: Command<PublishBaselineInput, BaselineRevision> = {
  name: "project.publish",
  input: publishBaselineInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.publish", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以发布需求基线");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertEditable(revision);
    normalizeAndValidate(data, project.id, revision.payload);
    if (!confirmationsComplete(revision)) {
      throw new DomainError("INVALID_STATE", "仍有成员尚未确认当前版本");
    }
    return publishProjection(data, context, project, revision, undefined);
  },
};

export const forcePublishBaselineInput = z.object({
  projectId: z.string().min(1),
  revisionId: z.string().min(1),
  reason: z.string().trim().min(1, "请填写例外推进原因"),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type ForcePublishBaselineInput = z.infer<typeof forcePublishBaselineInput>;

export const forcePublishBaseline: Command<ForcePublishBaselineInput, BaselineRevision> = {
  name: "project.publish.override",
  input: forcePublishBaselineInput,
  apply(data, context, input) {
    const project = findProjectOrThrow(data, input.projectId);
    if (!can(data, context.actorId, "project.publish.override", { kind: "project", id: project.id })) {
      throw new DomainError("FORBIDDEN", "只有该项目组长可以例外推进");
    }
    checkVersion(project, input.expectedVersion);
    const revision = findRevisionOrThrow(data, project.id, input.revisionId);
    assertEditable(revision);
    normalizeAndValidate(data, project.id, revision.payload);
    const unconfirmed = revision.memberRoster.filter((userId) =>
      !revision.confirmations.some((item) => item.userId === userId && item.revisionId === revision.id && item.contentVersion === revision.contentVersion),
    );
    return publishProjection(data, context, project, revision, { reason: input.reason, unconfirmed });
  },
};
