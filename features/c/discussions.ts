import { z } from "zod";
import { can } from "@/lib/access/policy";
import { DomainError, type Command } from "@/lib/commands/core";
import type { Discussion, Evidence, MockData } from "@/types/domain";

const optionalId = z.string().trim().min(1).optional();
const createSchema = z.object({
  projectId: z.string().min(1), id: z.string().min(1),
  title: z.string().trim().min(1).max(240), body: z.string().trim().min(1).max(30000),
  taskId: optionalId, requirementId: optionalId, moduleId: optionalId, milestoneId: optionalId,
}).strict();
const replySchema = z.object({
  projectId: z.string().min(1), discussionId: z.string().min(1), replyId: z.string().min(1),
  text: z.string().trim().min(1).max(10000), mentionedUserIds: z.array(z.string().min(1)).max(100),
}).strict();
const importantSchema = z.object({ projectId: z.string().min(1), discussionId: z.string().min(1), important: z.boolean(), reason: z.string().trim().min(1).max(2000) }).strict();
const evidenceSchema = z.object({
  projectId: z.string().min(1), discussionId: z.string().min(1), evidenceId: z.string().min(1),
  taskId: z.string().min(1), criterionIds: z.array(z.string().min(1)).min(1).max(100),
}).strict();

export type CreateDiscussionInput = z.infer<typeof createSchema>;
export type ReplyDiscussionInput = z.infer<typeof replySchema>;
export type DiscussionEvidence = Evidence & {
  sourceRecordId: string;
  sourceRecordUrl: string;
  sourceSnapshot: { source: "discussion"; record: Discussion };
  sourceChanged?: boolean;
};

export function canWriteDiscussion(data: MockData, actorId: string, projectId: string): boolean {
  const project = data.projects.find((item) => item.id === projectId);
  const actor = data.users.find((item) => item.id === actorId);
  const course = data.courses.find((item) => item.id === project?.courseId);
  if (!project || !actor?.verified || project.lifecycle !== "active" || (course && course.status !== "active")) return false;
  const target = { kind: "project" as const, id: projectId };
  return can(data, actorId, "project.content.read", target)
    && (can(data, actorId, "project.draft.edit", target) || actor.role === "teacher");
}

export function discussionMentionTargets(data: MockData, projectId: string) {
  return data.users.filter((user) => can(data, user.id, "project.content.read", { kind: "project", id: projectId }));
}

export function canMarkDiscussionImportant(data: MockData, actorId: string, thread: Discussion): boolean {
  return canWriteDiscussion(data, actorId, thread.projectId)
    && (thread.authorId === actorId || data.users.find((item) => item.id === actorId)?.role === "teacher"
      || can(data, actorId, "project.settings.update", { kind: "project", id: thread.projectId }));
}

function requireWrite(data: MockData, actorId: string, projectId: string) {
  if (!canWriteDiscussion(data, actorId, projectId)) throw new DomainError("FORBIDDEN", "当前账号或项目状态不允许修改讨论。");
}

function findDiscussion(data: MockData, projectId: string, discussionId: string): Discussion {
  const thread = data.discussions.find((item) => item.id === discussionId && item.projectId === projectId);
  if (!thread) throw new DomainError("NOT_FOUND", "讨论不存在或不属于当前项目。");
  return thread;
}

function validateLinks(data: MockData, input: CreateDiscussionInput) {
  const links = [
    [input.taskId, data.tasks], [input.requirementId, data.requirements],
    [input.moduleId, data.modules], [input.milestoneId, data.milestones],
  ] as const;
  if (links.some(([selected, records]) => selected && !records.some((item) => item.id === selected && item.projectId === input.projectId))) {
    throw new DomainError("VALIDATION_ERROR", "关联对象必须存在且属于同一项目。");
  }
}

function invalidateDiscussionSource(data: MockData, threadId: string): Evidence[] {
  return data.evidence.map((item) => {
    const linked = item as Partial<DiscussionEvidence>;
    return item.source === "discussion" && linked.sourceRecordId === threadId && !linked.sourceChanged
      ? { ...item, sourceChanged: true, version: item.version + 1 }
      : item;
  });
}

export const createDiscussion: Command<CreateDiscussionInput, Discussion> = {
  name: "c.discussion.create", input: createSchema,
  apply(data, context, input) {
    requireWrite(data, context.actorId, input.projectId);
    validateLinks(data, input);
    const existing = data.discussions.find((item) => item.id === input.id);
    if (existing) {
      const same = existing.projectId === input.projectId && existing.authorId === context.actorId
        && (["title", "body", "taskId", "requirementId", "moduleId", "milestoneId"] as const).every((key) => existing[key] === input[key]);
      if (!same) throw new DomainError("VERSION_CONFLICT", "这次发布标识已用于不同讨论，请重新创建。");
      return { data, result: existing };
    }
    const thread: Discussion = { ...input, authorId: context.actorId, replies: [], important: false, createdAt: context.now, updatedAt: context.now, version: 1 };
    return { data: { ...data, discussions: [...data.discussions, thread] }, result: thread };
  },
};

export const replyDiscussion: Command<ReplyDiscussionInput, Discussion> = {
  name: "c.discussion.reply", input: replySchema,
  apply(data, context, input) {
    requireWrite(data, context.actorId, input.projectId);
    const thread = findDiscussion(data, input.projectId, input.discussionId);
    const mentionedUserIds = [...new Set(input.mentionedUserIds)].sort();
    const allowed = new Set(discussionMentionTargets(data, input.projectId).map((user) => user.id));
    if (mentionedUserIds.some((id) => !allowed.has(id))) throw new DomainError("VALIDATION_ERROR", "不能提及无权访问本项目的账号。");
    const duplicate = data.discussions.flatMap((item) => item.replies.map((reply) => ({ threadId: item.id, reply }))).find((entry) => entry.reply.id === input.replyId);
    if (duplicate) {
      if (duplicate.threadId !== thread.id || duplicate.reply.authorId !== context.actorId || duplicate.reply.text !== input.text || JSON.stringify([...(duplicate.reply.mentionedUserIds ?? [])].sort()) !== JSON.stringify(mentionedUserIds)) {
        throw new DomainError("VERSION_CONFLICT", "这次回复标识已用于不同内容，请重新发送。");
      }
      return { data, result: thread };
    }
    const next: Discussion = { ...thread, replies: [...thread.replies, { id: input.replyId, authorId: context.actorId, text: input.text, at: context.now, mentionedUserIds }], updatedAt: context.now, version: (thread.version ?? 0) + 1 };
    return { data: { ...data, discussions: data.discussions.map((item) => item.id === thread.id ? next : item), evidence: invalidateDiscussionSource(data, thread.id) }, result: next };
  },
};

export const markDiscussionImportant: Command<z.infer<typeof importantSchema>, Discussion> = {
  name: "c.discussion.important", input: importantSchema,
  apply(data, context, input) {
    requireWrite(data, context.actorId, input.projectId);
    const thread = findDiscussion(data, input.projectId, input.discussionId);
    if (!canMarkDiscussionImportant(data, context.actorId, thread)) throw new DomainError("FORBIDDEN", "只有讨论作者、项目组长或所属教师可以修改重要标记。");
    if (Boolean(thread.important) === input.important) return { data, result: thread };
    const next = { ...thread, important: input.important, importantReason: input.reason, updatedAt: context.now, version: (thread.version ?? 0) + 1 };
    return { data: { ...data, discussions: data.discussions.map((item) => item.id === thread.id ? next : item), evidence: invalidateDiscussionSource(data, thread.id) }, result: next };
  },
};

/** Browser-local candidate only. The immutable capture is not an A/D integration. */
export const discussionAsEvidence: Command<z.infer<typeof evidenceSchema>, DiscussionEvidence> = {
  name: "c.discussion.evidence", input: evidenceSchema,
  apply(data, context, input) {
    requireWrite(data, context.actorId, input.projectId);
    const thread = findDiscussion(data, input.projectId, input.discussionId);
    if (!thread.important) throw new DomainError("INVALID_STATE", "请先将讨论标记为重要。");
    const task = data.tasks.find((item) => item.id === input.taskId && item.projectId === input.projectId);
    if (!task || (task.status !== "in_progress" && task.status !== "pending_submission")) throw new DomainError("INVALID_STATE", "请选择本项目进行中或待提交的任务。");
    const project = data.projects.find((item) => item.id === input.projectId)!;
    if (project.setupStatus !== "frozen" || !project.planConfirmed) throw new DomainError("INVALID_STATE", "任务计划确认后才能添加候选证据。");
    const criterionIds = [...new Set(input.criterionIds)];
    if (criterionIds.some((id) => !data.criteria.some((item) => item.id === id && item.taskId === task.id))) throw new DomainError("VALIDATION_ERROR", "验收标准必须属于所选任务。");
    const existing = data.evidence.find((item) => item.id === input.evidenceId) as DiscussionEvidence | undefined;
    if (existing) {
      if (existing.projectId !== input.projectId || existing.taskId !== task.id || existing.authorId !== context.actorId || existing.sourceRecordId !== thread.id || JSON.stringify([...existing.criterionIds].sort()) !== JSON.stringify([...criterionIds].sort())) throw new DomainError("VERSION_CONFLICT", "此证据标识已被其他内容使用。");
      return { data, result: existing };
    }
    const evidence: DiscussionEvidence = {
      id: input.evidenceId, projectId: input.projectId, taskId: task.id, authorId: context.actorId,
      title: `重要讨论：${thread.title}`, description: thread.body, criterionIds,
      source: "discussion", status: "candidate", createdAt: context.now, version: 1,
      sourceRecordId: thread.id,
      sourceRecordUrl: `/projects/${encodeURIComponent(input.projectId)}/discussions?discussion=${encodeURIComponent(thread.id)}`,
      sourceSnapshot: { source: "discussion", record: structuredClone(thread) },
      sourceChanged: false,
    };
    return {
      data: { ...data, evidence: [...data.evidence, evidence] },
      result: evidence,
    };
  },
};
