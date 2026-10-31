import type { Evidence, FeishuRecord, GithubActivity, TaskStatus } from "@/types/domain";
import { safeEvidenceSourceUrl } from "./url-filters";

type FeishuSourceRecord = FeishuRecord & { sourceUrl?: string };
export type EvidenceSourceSnapshot =
  | { source: "github"; record: GithubActivity }
  | { source: "feishu"; record: FeishuSourceRecord };

export type SourcedEvidence = Evidence & {
  sourceRecordId?: string;
  sourceRecordUrl?: string;
  sourceSnapshot?: EvidenceSourceSnapshot;
};

export interface EvidenceSourceDraft {
  source: Evidence["source"];
  title: string;
  description: string;
  sourceUrl: string;
  file: File | null;
  criterionIds: string[];
  sourceRecordId: string;
  sourceRecordUrl: string;
  sourceSnapshot?: EvidenceSourceSnapshot;
}

/** Switching source or record creates a fresh draft, never reuses old attribution. */
export function emptyEvidenceDraft(source: Evidence["source"]): EvidenceSourceDraft {
  return { source, title: "", description: "", sourceUrl: "", file: null, criterionIds: [], sourceRecordId: "", sourceRecordUrl: "" };
}

export function githubEvidenceUrl(value: string): string | null {
  if (!/^https:\/\//i.test(value.trim())) return null;
  const safe = safeEvidenceSourceUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.protocol === "https:" && url.hostname === "github.com" && !url.port ? url.href : null;
}

export function draftFromGithub(record: GithubActivity): EvidenceSourceDraft {
  return {
    ...emptyEvidenceDraft("github"),
    title: record.title,
    description: `${record.type.toUpperCase()} · ${record.status}`,
    sourceUrl: record.url,
    sourceRecordId: record.id,
    sourceSnapshot: { source: "github", record: { ...record } },
  };
}

export function draftFromFeishu(record: FeishuSourceRecord): EvidenceSourceDraft {
  return {
    ...emptyEvidenceDraft("feishu"),
    title: record.summary,
    description: record.summary,
    sourceUrl: safeEvidenceSourceUrl(record.sourceUrl) ?? "",
    sourceRecordId: record.id,
    sourceRecordUrl: `/projects/${encodeURIComponent(record.projectId)}/collaboration#${encodeURIComponent(record.id)}`,
    // The current record supplies a summary, not a full external document body.
    sourceSnapshot: { source: "feishu", record: { ...record } },
  };
}

export function taskAcceptsEvidence(status: TaskStatus): boolean {
  return status === "in_progress" || status === "pending_submission";
}

export function buildCandidateEvidence(draft: EvidenceSourceDraft, context: {
  id: string;
  projectId: string;
  taskId: string;
  taskStatus: TaskStatus;
  authorId: string;
  criterionIds: readonly string[];
  canSubmit: boolean;
  createdAt: string;
}): { ok: true; evidence: SourcedEvidence } | { ok: false; message: string } {
  if (!context.canSubmit || !taskAcceptsEvidence(context.taskStatus)) return { ok: false, message: "仅可为进行中或待提交的任务补充证据，请先确认任务状态和编辑权限。" };
  if (draft.source === "file" || draft.source === "screenshot") return { ok: false, message: "文件存储尚未接入，当前不能上传文件或截图，也不会生成已上传证据。请改用可访问的来源链接。" };
  if (!draft.title.trim() || !draft.description.trim()) return { ok: false, message: "请填写证据名称和说明。" };
  if (!draft.criterionIds.length || draft.criterionIds.some((id) => !context.criterionIds.includes(id))) return { ok: false, message: "请至少关联一条属于本任务的验收标准。" };

  const snapshot = draft.sourceSnapshot;
  if (draft.sourceRecordId && (!snapshot || snapshot.source !== draft.source || snapshot.record.id !== draft.sourceRecordId || snapshot.record.projectId !== context.projectId)) {
    return { ok: false, message: "所选来源记录与当前项目或来源不一致，请重新选择。" };
  }
  const sourceUrl = draft.source === "github" ? githubEvidenceUrl(draft.sourceUrl) : safeEvidenceSourceUrl(draft.sourceUrl);
  if (draft.source === "github" && !sourceUrl) return { ok: false, message: "GitHub 来源须为 https://github.com/ 下的链接，不能包含用户名、密码或自定义端口。" };
  if (draft.sourceUrl.trim() && !sourceUrl) return { ok: false, message: "来源链接须为有效的 HTTP 或 HTTPS 地址。" };
  if (draft.source === "feishu" && !sourceUrl && !draft.sourceRecordId) return { ok: false, message: "请选择已有飞书记录，或填写可访问的原始来源链接。" };

  return { ok: true, evidence: {
    id: context.id,
    projectId: context.projectId,
    taskId: context.taskId,
    criterionIds: [...new Set(draft.criterionIds)],
    authorId: context.authorId,
    title: draft.title.trim(),
    description: draft.description.trim(),
    source: draft.source,
    sourceUrl: sourceUrl ?? undefined,
    status: "candidate",
    createdAt: context.createdAt,
    version: 1,
    ...(draft.sourceRecordId ? {
      sourceRecordId: draft.sourceRecordId,
      sourceRecordUrl: draft.sourceRecordUrl || undefined,
      sourceSnapshot: snapshot ? structuredClone(snapshot) : undefined,
    } : {}),
  } };
}
