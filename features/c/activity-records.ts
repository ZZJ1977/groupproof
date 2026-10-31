import { z } from "zod";
import { can } from "@/lib/access/policy";
import { DomainError, type Command } from "@/lib/commands/core";
import type { FeishuRecord, GithubActivity, MockData } from "@/types/domain";
import { buildCandidateEvidence, draftFromFeishu, type SourcedEvidence } from "./evidence-source";
import { evidenceDecisionBlockReason } from "./evidence-decisions";

const pageSize = 10;
type QueryReader = Pick<URLSearchParams, "get">;
export type ActivityOperation = "link" | "adopt" | "ignore" | "restore";
export interface ActivityHistory {
  idempotencyKey: string;
  fingerprint: string;
  action: ActivityOperation;
  actorId: string;
  reason: string;
  expectedVersion: number;
  resultVersion: number;
  at: string;
  previousTaskId?: string;
  taskId?: string;
  fromStatus?: FeishuRecord["status"];
  toStatus?: FeishuRecord["status"];
  evidenceId?: string;
}
/** C metadata only: these versions do not claim to be A's source revisions. */
export type ManagedActivity<T extends GithubActivity | FeishuRecord> = T & { cVersion?: number; cOperationHistory?: ActivityHistory[] };
export const activityVersion = (record: GithubActivity | FeishuRecord): number => (record as ManagedActivity<typeof record>).cVersion ?? 0;
export const activityHistory = (record: GithubActivity | FeishuRecord): ActivityHistory[] => (record as ManagedActivity<typeof record>).cOperationHistory ?? [];

function choice<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}
function pageNumber(value: string | null): number { return value && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1; }
export function githubActivityFilters(query: QueryReader) {
  return {
    kind: choice(query.get("kind"), ["all", "commit", "pr", "ci", "sync"] as const, "all"),
    days: choice(query.get("days"), ["all", "7", "30"] as const, "all"),
    author: query.get("author") || "all", task: query.get("task") || "all",
    q: query.get("q") ?? "", page: pageNumber(query.get("page")),
  };
}
export function feishuActivityFilters(query: QueryReader) {
  return {
    group: query.get("group") || "all",
    status: choice(query.get("status"), ["all", "candidate", "adopted", "ignored"] as const, "all"),
    author: query.get("author") || "all", task: query.get("task") || "all",
    q: query.get("q") ?? "", page: pageNumber(query.get("page")),
  };
}
function paginate<T>(items: T[], requestedPage: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, totalPages, pageSize };
}
const taskMatches = (taskId: string | undefined, filter: string) => filter === "all" || (filter === "unlinked" ? !taskId : taskId === filter);
function newestFirst(a: { timestamp: string; id: string }, b: { timestamp: string; id: string }) {
  const aTime = Date.parse(a.timestamp), bTime = Date.parse(b.timestamp);
  return ((Number.isFinite(bTime) ? bTime : -Infinity) - (Number.isFinite(aTime) ? aTime : -Infinity)) || a.id.localeCompare(b.id);
}
export function queryGithubActivities(data: MockData, projectId: string, filters: ReturnType<typeof githubActivityFilters>, now = Date.now()) {
  if (!can(data, data.currentUserId, "project.content.read", { kind: "project", id: projectId })) return paginate<GithubActivity>([], 1);
  const q = filters.q.trim().toLocaleLowerCase();
  return paginate(data.github.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return item.projectId === projectId && (filters.kind === "all" || item.type === filters.kind)
      && (filters.days === "all" || (timestamp <= now && now - timestamp <= Number(filters.days) * 86400000))
      && (filters.author === "all" || item.authorId === filters.author) && taskMatches(item.taskId, filters.task)
      && (!q || `${item.title} ${item.repository} ${data.users.find((user) => user.id === item.authorId)?.name ?? item.authorId}`.toLocaleLowerCase().includes(q));
  }).sort(newestFirst), filters.page);
}
export function queryFeishuActivities(data: MockData, projectId: string, filters: ReturnType<typeof feishuActivityFilters>) {
  if (!can(data, data.currentUserId, "project.content.read", { kind: "project", id: projectId })) return paginate<FeishuRecord>([], 1);
  const q = filters.q.trim().toLocaleLowerCase();
  return paginate(data.feishu.filter((item) => item.projectId === projectId
    && (filters.group === "all" || item.groupName === filters.group)
    && (filters.status === "all" || item.status === filters.status)
    && (filters.author === "all" || item.authorId === filters.author) && taskMatches(item.taskId, filters.task)
    && (!q || `${item.summary} ${item.groupName} ${data.users.find((user) => user.id === item.authorId)?.name ?? item.authorId}`.toLocaleLowerCase().includes(q)))
    .sort(newestFirst), filters.page);
}

/** Match only explicit task identifiers in task titles; do not invent codes from IDs. */
export function githubTaskSuggestions(data: MockData, record: GithubActivity) {
  if (!can(data, data.currentUserId, "project.content.read", { kind: "project", id: record.projectId })) return [];
  const mentioned = new Set(record.title.toUpperCase().match(/(?<![A-Z0-9])T-\d+(?:\.\d+)*(?![A-Z0-9.])/g) ?? []);
  const candidates = data.tasks.filter((task) => task.projectId === record.projectId).map((task) => ({ task, code: task.title.toUpperCase().match(/^T-\d+(?:\.\d+)*(?=\s|$)/)?.[0] }));
  return candidates.filter((entry) => entry.code && mentioned.has(entry.code) && candidates.filter((other) => other.code === entry.code).length === 1).map((entry) => entry.task);
}

export function canManageActivity(data: MockData, actorId: string, projectId: string): boolean {
  const project = data.projects.find((item) => item.id === projectId);
  const actor = data.users.find((item) => item.id === actorId);
  const course = data.courses.find((item) => item.id === project?.courseId);
  const target = { kind: "project" as const, id: projectId };
  return Boolean(project && actor?.verified && project.lifecycle === "active" && (!project.courseId || course?.status === "active")
    && can(data, actorId, "project.content.read", target)
    && (can(data, actorId, "project.draft.edit", target) || (actor.role === "teacher" && actor.teacherStatus === "approved" && course?.teacherId === actorId)));
}
function requireWriter(data: MockData, actorId: string, projectId: string) {
  if (!canManageActivity(data, actorId, projectId)) throw new DomainError("FORBIDDEN", "仅已验证的本项目成员或所属教师可以在活动项目中处理记录。");
}
const common = {
  projectId: z.string().min(1), recordId: z.string().min(1), reason: z.string().trim().min(1).max(2000),
  expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(128),
};
const linkSchema = z.object({ ...common, taskId: z.string().min(1).nullable() }).strict();
const feishuSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("adopt"), taskId: z.string().min(1), criterionIds: z.array(z.string().min(1)).min(1).max(100), evidenceId: z.string().min(1) }).strict(),
  z.object({ ...common, action: z.literal("ignore") }).strict(),
  z.object({ ...common, action: z.literal("restore") }).strict(),
]);
export type GithubLinkInput = z.infer<typeof linkSchema>;
export type FeishuDecisionInput = z.infer<typeof feishuSchema>;

function isReplay(data: MockData, key: string, fingerprint: string, actorId: string): boolean {
  const previous = [...data.github, ...data.feishu].flatMap(activityHistory).find((entry) => entry.idempotencyKey === key);
  if (!previous) return false;
  if (previous.fingerprint !== fingerprint || previous.actorId !== actorId) throw new DomainError("VERSION_CONFLICT", "此提交标识已用于其他记录操作，请重新确认。");
  return true;
}
function checkVersion(record: GithubActivity | FeishuRecord, expectedVersion: number) {
  if (activityVersion(record) !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "记录已更新，输入已保留，请核对当前版本后重试。", { latestVersion: activityVersion(record) });
}
function historyEntry(input: GithubLinkInput | FeishuDecisionInput, actorId: string, at: string, action: ActivityOperation, fingerprint: string): ActivityHistory {
  return { idempotencyKey: input.idempotencyKey, fingerprint, action, actorId, reason: input.reason, expectedVersion: input.expectedVersion, resultVersion: input.expectedVersion + 1, at };
}
function operationLog(actorId: string, logId: string, now: string, recordId: string, action: string, reason: string) {
  return { id: logId, actorId, action, target: recordId, result: "success" as const, ip: "mock", createdAt: now, detail: reason };
}

export const linkGithubActivity: Command<GithubLinkInput, ManagedActivity<GithubActivity>> = {
  name: "c.github.link", input: linkSchema,
  apply(data, context, input) {
    requireWriter(data, context.actorId, input.projectId);
    const record = data.github.find((item) => item.id === input.recordId && item.projectId === input.projectId);
    if (!record) throw new DomainError("NOT_FOUND", "当前项目中没有这条 GitHub 记录。");
    const fingerprint = JSON.stringify({ source: "github", ...input });
    if (isReplay(data, input.idempotencyKey, fingerprint, context.actorId)) return { data, result: record };
    checkVersion(record, input.expectedVersion);
    if (record.type === "sync") throw new DomainError("INVALID_STATE", "同步事件不作为任务开发活动关联。");
    if (input.taskId && !data.tasks.some((task) => task.id === input.taskId && task.projectId === input.projectId)) throw new DomainError("VALIDATION_ERROR", "关联任务必须属于当前项目。");
    const history = { ...historyEntry(input, context.actorId, context.now, "link", fingerprint), previousTaskId: record.taskId, taskId: input.taskId ?? undefined };
    const updated = { ...record, taskId: input.taskId ?? undefined, cVersion: activityVersion(record) + 1, cOperationHistory: [...activityHistory(record), history] };
    return { data: { ...data, github: data.github.map((item) => item.id === record.id ? updated : item), logs: [...data.logs, operationLog(context.actorId, context.logId, context.now, record.id, "调整 GitHub 任务关联", input.reason)] }, result: updated };
  },
};

export const decideFeishuRecord: Command<FeishuDecisionInput, ManagedActivity<FeishuRecord>> = {
  name: "c.feishu.decide", input: feishuSchema,
  apply(data, context, input) {
    requireWriter(data, context.actorId, input.projectId);
    const record = data.feishu.find((item) => item.id === input.recordId && item.projectId === input.projectId);
    if (!record) throw new DomainError("NOT_FOUND", "当前项目中没有这条飞书记录。");
    const normalized = input.action === "adopt" ? { ...input, criterionIds: [...new Set(input.criterionIds)].sort() } : input;
    const fingerprint = JSON.stringify({ source: "feishu", ...normalized });
    if (isReplay(data, input.idempotencyKey, fingerprint, context.actorId)) return { data, result: record };
    checkVersion(record, input.expectedVersion);
    if (input.action === "restore" ? record.status !== "ignored" : record.status !== "candidate") throw new DomainError("INVALID_STATE", "记录状态已变化，请核对后操作。");
    let candidate: SourcedEvidence | undefined;
    if (input.action === "adopt") {
      const task = data.tasks.find((item) => item.id === input.taskId && item.projectId === input.projectId);
      if (!task) throw new DomainError("VALIDATION_ERROR", "请选择属于当前项目的任务。");
      if (data.evidence.some((item) => item.id === input.evidenceId)) throw new DomainError("VERSION_CONFLICT", "候选证据标识已被使用，请重新打开操作。");
      const built = buildCandidateEvidence({ ...draftFromFeishu(record), criterionIds: input.criterionIds }, {
        id: input.evidenceId, projectId: input.projectId, taskId: task.id, taskStatus: task.status,
        authorId: context.actorId, criterionIds: data.criteria.filter((item) => item.taskId === task.id).map((item) => item.id), canSubmit: true, createdAt: context.now,
      });
      if (!built.ok) throw new DomainError("VALIDATION_ERROR", built.message);
      const blocked = evidenceDecisionBlockReason(data, context.actorId, built.evidence, "adopt");
      if (blocked) throw new DomainError("INVALID_STATE", blocked);
      candidate = built.evidence;
    }
    const status = input.action === "adopt" ? "adopted" : input.action === "ignore" ? "ignored" : "candidate";
    const history: ActivityHistory = { ...historyEntry(input, context.actorId, context.now, input.action, fingerprint), fromStatus: record.status, toStatus: status, previousTaskId: record.taskId, taskId: candidate?.taskId ?? record.taskId, evidenceId: candidate?.id };
    const updated: ManagedActivity<FeishuRecord> = { ...record, status, taskId: candidate?.taskId ?? record.taskId, cVersion: activityVersion(record) + 1, cOperationHistory: [...activityHistory(record), history] };
    return { data: {
      ...data, feishu: data.feishu.map((item) => item.id === record.id ? updated : item),
      evidence: candidate ? [...data.evidence, candidate] : data.evidence,
      logs: [...data.logs, operationLog(context.actorId, context.logId, context.now, record.id, `飞书记录${input.action === "adopt" ? "采纳为候选" : input.action === "ignore" ? "忽略" : "恢复待确认"}`, input.reason)],
    }, result: updated };
  },
};
