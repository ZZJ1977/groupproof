"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FileCode2, GitCommitHorizontal, Plus } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { CApiError } from "@/lib/api/c-client";
import type { components, paths } from "@/packages/domain/api.generated";
import { EvidenceCapturePanel } from "./EvidenceCapturePanel";
import { parseEvidenceDetails } from "./evidence-format";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, apiButton, ApiFailure, apiInput, ApiPager, isUuid, pageNumber, projectApi, queryPolicy, safeHttps, useCommandKey, versionFailure } from "./c-project-api";
import { tr } from "@/lib/i18n/tr";

type Evidence = components["schemas"]["EvidenceDetailDTO"];
type EvidenceQuery = paths["/api/v1/projects/{project_id}/evidence"]["get"]["parameters"]["query"];
const states = { candidate: "候选", pending_confirmation: "待确认", formal: "正式", withdrawn: "已撤回", void: "无效" } as const;
const statusTones: Record<keyof typeof states, "amber" | "blue" | "green" | "gray" | "red"> = {
  candidate: "amber",
  pending_confirmation: "blue",
  formal: "green",
  withdrawn: "gray",
  void: "red",
};
const sources = { manual: "手工说明", task_note: "任务说明", discussion: "重要讨论", file: "文件", screenshot: "截图", github: "GitHub", feishu: "飞书" } as const;
const decisions = { submitted: "提交候选", adopted: "采纳正式", withdrawn: "撤回", source_changed: "来源变化" } as const;

function snapshotRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function originalSourceId(item: Evidence): string | null {
  const originals = item.source_snapshots.filter((snapshot) => snapshot.version_no === 1 && snapshot.id === item.original_snapshot_id);
  const value = originals.length === 1 ? originals[0].content.source_id : null;
  return typeof value === "string" && isUuid(value) ? value : null;
}
const checkableSources = new Set<Evidence["source_type"]>(["discussion", "file", "screenshot", "github", "feishu"]);

function SourceSnapshotContent({ snapshot, sourceType, projectId, taskId }: { snapshot: Evidence["source_snapshots"][number]; sourceType: Evidence["source_type"]; projectId: string; taskId: string }) {
  // Canonical snapshots wrap the immutable source payload; never dump IDs or provider metadata.
  const source = snapshotRecord(snapshot.content.source);
  const available = snapshot.content.availability !== "deleted";
  const noteVersionId = snapshot.source_revision;
  const discussionId = snapshot.source_identity;
  const originalUrl = sourceType === "manual" && typeof source.source_url === "string" ? safeHttps(source.source_url) : null;
  const fileVersionId = typeof source.version_id === "string" && isUuid(source.version_id) ? source.version_id : null;
  const textFields = sourceType === "feishu" && typeof source.text === "string" && source.text
    ? ["title", "text"] : ["title", "body", "summary", "description"];
  const text = textFields.map((field) => typeof source[field] === "string" ? source[field] : null).filter(Boolean).join("\n");
  const replies = sourceType === "discussion" && Array.isArray(source.replies) ? source.replies.map(snapshotRecord).map((reply) => reply.body).filter((body): body is string => typeof body === "string") : [];
  const attachments = sourceType === "feishu" && Array.isArray(source.attachments) ? source.attachments.map(snapshotRecord) : [];
  return <>
    {snapshot.content.availability === "deleted" && <p className="my-2">此快照记录了来源已删除。</p>}
    {originalUrl && <a className="gp-link" href={originalUrl} target="_blank" rel="noopener noreferrer">打开提交时的网址</a>}
    {sourceType === "task_note" && typeof source.version_no === "number" && <p className="my-2 text-sm">{tr("任务说明 v{0}", { 0: source.version_no })}</p>}
    {available && sourceType === "task_note" && isUuid(taskId) && isUuid(noteVersionId) &&
      (source.note_version_id == null || source.note_version_id === noteVersionId) &&
      <Link className="gp-link" href={`/projects/${projectId}/tasks/${taskId}?tab=history&note=${noteVersionId}#note-${noteVersionId}`}>查看此版本的任务说明</Link>}
    {available && sourceType === "discussion" && isUuid(discussionId) &&
      (source.id == null || source.id === discussionId) && (source.project_id == null || source.project_id === projectId) &&
      <Link className="gp-link" href={`/projects/${projectId}/discussions?discussion=${discussionId}`}>查看原讨论串</Link>}
    {sourceType === "discussion" && source.is_important === false && <p className="my-2">此快照中的讨论已取消重要标记。</p>}
    {sourceType === "feishu" && typeof source.version_no === "number" && <p className="my-2">飞书消息 v{source.version_no}</p>}
    {sourceType === "feishu" && source.preview_only === true && <p className="my-2">{attachments.length ? "此版本含尚未完整核验的来源。" : "来源仅返回消息摘要。完整程度以各版本保存的快照为准。"}</p>}
    {attachments.map((attachment, index) => <p key={index} className="my-2 break-all text-sm">
      {typeof attachment.name === "string" ? attachment.name : "附件"} · {attachment.verified && typeof attachment.sha256 === "string" ? `SHA-256 ${attachment.sha256}` : "未核验"}
    </p>)}
    {sourceType === "screenshot" && source.provenance === "registered_project_file" && typeof source.mime_type === "string" && !["image/png", "image/jpeg"].includes(source.mime_type) && <p>原截图已被其他文件类型替换（{source.mime_type}）。</p>}
    <p className="whitespace-pre-wrap">{text || "该来源快照不包含可直接展示的文字。"}</p>
    {(sourceType === "file" || sourceType === "screenshot") && source.provenance === "registered_project_file" &&
      typeof source.file_id === "string" && isUuid(source.file_id) &&
      <Link className="gp-link" href={`/projects/${projectId}/files?file=${source.file_id}${fileVersionId ? `&version=${fileVersionId}` : ""}`}>
        {fileVersionId ? `查看证据引用的文件版本${typeof source.version_no === "number" ? ` v${source.version_no}` : ""}` : "查看原文件"}
      </Link>}
    {replies.length > 0 && <div className="mt-3"><h4 className="font-semibold">快照中的回复</h4>{replies.map((body, index) => <p key={index} className="my-2 whitespace-pre-wrap">{body}</p>)}</div>}
  </>;
}

function StructuredEvidenceDetails({
  title,
  description,
  criterionIds,
  criterionTextById,
  sourceUrl,
  sourceType,
}: {
  title: string;
  description: string | null | undefined;
  criterionIds: string[];
  criterionTextById: Map<string, string>;
  sourceUrl: string | null | undefined;
  sourceType: Evidence["source_type"];
}) {
  const parsed = parseEvidenceDetails(title, description);
  const url = safeHttps(sourceUrl, sourceType === "github");
  const hasAnyContent = Boolean(
    parsed.implementation ||
    parsed.impact ||
    parsed.verification ||
    parsed.originalCommit ||
    parsed.changedFiles.length > 0 ||
    parsed.otherLines.length > 0 ||
    criterionIds.length > 0,
  );

  if (!hasAnyContent) {
    return <p className="text-xs text-slate-500">暂无补充实现说明。</p>;
  }

  return (
    <div className="space-y-2.5 text-xs leading-5 text-slate-700">
      {(parsed.commitTag || parsed.originalCommit || url) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200/80 bg-white px-3 py-2">
          {parsed.commitTag && (
            <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-800">
              <GitCommitHorizontal size={12} className="text-sky-600" />
              {parsed.commitTag}
            </span>
          )}
          {parsed.originalCommit && (
            <span className="min-w-0 flex-1 text-slate-600">{parsed.originalCommit}</span>
          )}
          {url && (
            <a
              className="inline-flex shrink-0 items-center gap-1 font-medium text-sky-700 hover:underline"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看来源 <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}

      {parsed.implementation && (
        <div>
          <span className="font-semibold text-slate-900">实现内容：</span>
          <span>{parsed.implementation}</span>
        </div>
      )}

      {parsed.impact && (
        <div>
          <span className="font-semibold text-slate-900">影响范围：</span>
          <span>{parsed.impact}</span>
        </div>
      )}

      {parsed.verification && (
        <div>
          <span className="font-semibold text-slate-900">验证说明：</span>
          <span>{parsed.verification}</span>
        </div>
      )}

      {parsed.otherLines.length > 0 && (
        <div className="space-y-1 whitespace-pre-wrap">
          {parsed.otherLines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}

      {parsed.changedFiles.length > 0 && (
        <div className="space-y-1">
          <div className="font-semibold text-slate-900">变动文件：</div>
          <div className="flex flex-wrap gap-1.5">
            {parsed.changedFiles.map((filePath) => (
              <code key={filePath} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                {filePath}
              </code>
            ))}
          </div>
        </div>
      )}

      {criterionIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="font-semibold text-slate-900">对应标准：</span>
          {criterionIds.map((cid) => (
            <span key={cid} className="rounded-md border border-slate-200/80 bg-white px-2 py-0.5 text-slate-700">
              {criterionTextById.get(cid) ?? "已关联标准"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function EvidenceApiPage({ projectId }: { projectId: string }) {
  const { userId } = useWorkspace();
  return <EvidencePage key={`${userId}:${projectId}`} userId={userId} projectId={projectId} />;
}

function EvidencePage({ userId, projectId }: { userId: string; projectId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const status = query.get("status"), source = query.get("source");
  const filters: EvidenceQuery = {
    page: pageNumber(query.get("page")),
    page_size: 10,
    task_id: query.get("task") || undefined,
    author_id: query.get("author") || undefined,
    criterion_id: query.get("criterion") || undefined,
    q: query.get("q") || undefined,
    status: status && Object.hasOwn(states, status) ? status as keyof typeof states : undefined,
    source_type: source && Object.hasOwn(sources, source) ? source as keyof typeof sources : undefined,
  };
  const selectedId = query.get("evidence");
  const decisionId = query.get("decision");
  const enabled = isUuid(projectId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const list = useQuery({ queryKey: ["c-evidence", userId, projectId, filters], queryFn: () => projectApi.evidence(projectId, filters), enabled, ...queryPolicy });
  const scopedRead = context.error instanceof CApiError && context.error.code === "PROJECT_ACCESS_DENIED";
  const detail = useQuery({ queryKey: ["c-evidence-detail", userId, projectId, selectedId, scopedRead], queryFn: () => projectApi.evidenceDetail(projectId, selectedId!), enabled: enabled && Boolean(selectedId && isUuid(selectedId)) && (context.isSuccess || scopedRead) && !context.isFetching, ...queryPolicy });
  const [blocked, setBlocked] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState<{ id: string; action: "adopt" | "withdraw" | "checkSource"; expected: number; reason: string; sourceId?: string } | null>(null);
  const [creating, setCreating] = useState(query.get("capture") === "1");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [quickAdoptBusy, setQuickAdoptBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const key = useCommandKey();
  const denial = blocked || [context.error, list.error, detail.error].find(accessFailure);
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const rows = access && list.isSuccess && !list.isFetching ? list.data : undefined;
  const received = access && detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const item = received && received.project_id === projectId && received.id === selectedId ? received : undefined;
  const activitySourceId = item && (item.source_type === "github" || item.source_type === "feishu") ? originalSourceId(item) : null;
  const referencedDecision = item?.decisions.find((decision) => decision.id === decisionId);
  const decisionRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (referencedDecision) decisionRef.current?.focus();
  }, [referencedDecision]);

  const authors = access?.evidence_authors ?? [];
  const authorNameById = new Map<string, string>();
  for (const member of access?.members ?? []) authorNameById.set(member.id, member.title);
  for (const author of authors) authorNameById.set(author.id, author.title);
  const authorLabel = (authorId: string) => authorNameById.get(authorId) ?? "项目成员";

  const canDecide = (entry: { author_id: string }) => Boolean(access?.permissions.can_capture_evidence && (access.actor.id === entry.author_id || access.actor.is_leader || access.actor.is_teacher));
  const taskTitle = (id: string) => access?.tasks.find((task) => task.id === id)?.title ?? "关联任务";
  const criterionTextById = new Map<string, string>(
    (access?.tasks ?? []).flatMap((task) => task.criteria.map((criterion) => [criterion.id, criterion.text] as const)),
  );
  const selectedTask = filters.task_id ? access?.tasks.find((task) => task.id === filters.task_id) : undefined;
  const activeTaskEvidences = selectedTask && rows
    ? rows.items.filter((ev) => ev.task_id === selectedTask.id && !ev.source_changed && ["candidate", "pending_confirmation", "formal"].includes(ev.status))
    : [];
  const taskEvidenceByCriterion = new Map<string, typeof activeTaskEvidences>();
  for (const ev of activeTaskEvidences) {
    for (const cid of ev.criterion_ids) {
      taskEvidenceByCriterion.set(cid, [...(taskEvidenceByCriterion.get(cid) ?? []), ev]);
    }
  }
  const adoptableTaskEvidences = activeTaskEvidences.filter(
    (ev) => ["candidate", "pending_confirmation"].includes(ev.status) && canDecide(ev),
  );
  const hasActiveFilters = Boolean(filters.q || filters.status || filters.source_type || filters.task_id || filters.author_id || filters.criterion_id);

  function toggleRowExpand(id: string) {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function applyFilterPatch(patch: Record<string, string | null>) {
    updateQuery({ ...patch, page: null, evidence: null, decision: null });
    setCommand(null);
  }

  async function quickAdoptOne(entry: (typeof activeTaskEvidences)[number]) {
    if (quickAdoptBusy || busyRef.current || !canDecide(entry)) return;
    setQuickAdoptBusy(entry.id);
    setError(null);
    setNotice("");
    try {
      await projectApi.adopt(
        projectId,
        entry.id,
        { expected_version: entry.lock_version, reason: "核对证据内容符合对应交付标准，确认采纳为正式证据。" },
        `quick-adopt-${entry.id}-v${entry.lock_version}-${Date.now()}`,
      );
      await refresh();
      setNotice(`已采纳「${entry.title}」为正式证据，对应验收标准已计入有效覆盖。`);
    } catch (next) {
      setError(next);
      if (accessFailure(next)) deny(next);
    } finally {
      setQuickAdoptBusy(null);
    }
  }

  async function quickAdoptAllForTask() {
    if (quickAdoptBusy || busyRef.current || adoptableTaskEvidences.length === 0) return;
    setQuickAdoptBusy("all");
    setError(null);
    setNotice("");
    let adopted = 0;
    try {
      for (const entry of adoptableTaskEvidences) {
        await projectApi.adopt(
          projectId,
          entry.id,
          { expected_version: entry.lock_version, reason: "核对本任务候选证据符合对应交付标准，批量确认采纳为正式证据。" },
          `quick-adopt-all-${entry.id}-v${entry.lock_version}-${Date.now()}`,
        );
        adopted += 1;
      }
      await refresh();
      setNotice(`已采纳 ${adopted} 条正式证据；可点击「前往提交验收」完成最终验收确认。`);
    } catch (next) {
      setError(next);
      if (accessFailure(next)) deny(next);
      if (adopted > 0) await refresh();
    } finally {
      setQuickAdoptBusy(null);
    }
  }

  function deny(next: unknown) { setBlocked(next); setCommand(null); setCreating(false); }

  async function refresh() {
    const results = await Promise.all([context.refetch(), list.refetch(), ...(selectedId ? [detail.refetch()] : [])]);
    const denied = results.find((result) => accessFailure(result.error));
    if (denied) deny(denied.error); else if (results[0].isSuccess) setBlocked(null);
  }

  async function save() {
    if (!command || !item || command.id !== item.id || !canDecide(item) || busyRef.current) return;
    if (!command.reason.trim()) { setNotice(command.action === "checkSource" ? "请填写本次来源检查的原因。" : "请填写本次证据决定的原因。"); return; }
    if (command.action === "checkSource" && (!command.sourceId || command.sourceId !== originalSourceId(item) || !checkableSources.has(item.source_type))) { setNotice("无法核对原始来源，请刷新证据详情。"); return; }
    if (command.expected !== item.lock_version) { setNotice("证据版本已变化，请刷新并核对证据后再次确认。"); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    const input = { expected_version: command.expected, reason: command.reason.trim() };
    try {
      if (command.action === "checkSource") {
        const sourceInput = { ...input, source_id: command.sourceId! };
        const result = await projectApi.checkSource(projectId, item.id, sourceInput, key({ projectId, evidenceId: item.id, action: command.action, input: sourceInput }));
        setNotice(result.source_changed ? "来源检查完成：该证据标记为来源已变化，不计入有效证据；原快照仍保留。" : "来源检查完成：与已保存的来源快照一致。");
      } else {
        await projectApi[command.action](projectId, item.id, input, key({ projectId, evidenceId: item.id, action: command.action, input }));
        setNotice(command.action === "adopt" ? "证据已采纳为正式；验收结论需由验收服务决定。" : "证据已撤回，历史和快照仍保留。");
      }
      key.reset();
      setCommand(null); await refresh();
    } catch (next) { setError(next); if (accessFailure(next)) deny(next); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function reviewLatest() {
    if (!command || busyRef.current) return;
    const [latest, permission] = await Promise.all([detail.refetch(), context.refetch()]);
    const next = latest.error || permission.error;
    if (next) { setError(next); if (accessFailure(next)) deny(next); return; }
    if (latest.data) {
      if (command.action === "checkSource" && originalSourceId(latest.data) !== command.sourceId) { setCommand(null); setError(null); setNotice("原始来源标识无法核对，请重新打开详情检查。"); return; }
      setCommand({ ...command, expected: latest.data.lock_version }); setError(null); setNotice("已刷新状态，请核对证据和原因后再次确认。");
    }
  }

  if (!enabled) return <EmptyState title="项目地址无效" />;

  if (scopedRead && selectedId && isUuid(selectedId)) {
    const record = detail.isSuccess && !detail.isFetching && detail.data.id === selectedId &&
      detail.data.project_id === projectId ? detail.data : null;
    return <>
      <PageHeader title="证据详情" actions={<button className={apiButton} disabled={detail.isFetching} onClick={() => void detail.refetch()}>刷新证据</button>} />
      {detail.isFetching && <p role="status">正在读取授权证据…</p>}
      {detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} />}
      {record && <Panel title={record.title}>
        <p className="mb-3 text-sm text-slate-600">{states[record.status]} · {sources[record.source_type]} · 只读</p>
        <StructuredEvidenceDetails
          title={record.title}
          description={record.description}
          criterionIds={record.criterion_ids}
          criterionTextById={criterionTextById}
          sourceUrl={record.source_url}
          sourceType={record.source_type}
        />
        {record.source_changed && <p className="mt-3 text-sm text-amber-800">来源已变化，原始快照保留。</p>}
        {record.source_snapshots.map((snapshot) => <details key={snapshot.id} className="my-2">
          <summary>来源快照 v{snapshot.version_no} · {formatDate(snapshot.created_at)}</summary>
          <SourceSnapshotContent snapshot={snapshot} sourceType={record.source_type} projectId={projectId} taskId={record.task_id} />
        </details>)}
        {record.decisions.map((decision) => <p key={decision.id}>{decisions[decision.decision]} · {formatDate(decision.created_at)} · {decision.reason}</p>)}
      </Panel>}
    </>;
  }

  return <>
    <PageHeader
      title="项目证据"
      description={access?.project.name ?? "正在验证项目权限…"}
      actions={<div className="flex flex-wrap items-center gap-2">
        {selectedTask && <Link className={apiButton} href={`/projects/${projectId}/tasks`}>返回任务列表</Link>}
        {access?.permissions.can_capture_evidence && (
          <button type="button" className={apiButton} onClick={() => setCreating(!creating)}>
            <Plus size={14} className="mr-1 inline-block" />
            {creating ? "关闭新增表单" : "添加候选证据"}
          </button>
        )}
        <button className={apiButton} disabled={busy || context.isFetching || list.isFetching} onClick={() => void refresh()}>刷新证据</button>
      </div>}
    />
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
      {context.isFetching && <p role="status">正在验证项目权限…</p>}
      {access && <>
        {/* Compact Single-Row Filter Bar */}
        <form
          key={JSON.stringify(filters)}
          className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-nowrap lg:items-center lg:gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const fields = Object.fromEntries(["q", "status", "source", "task", "author", "criterion"].map((field) => [field, String(form.get(field) ?? "").trim() || null]));
            applyFilterPatch(fields);
          }}
        >
          <label className="col-span-2 min-w-0 sm:col-span-1 lg:w-44 lg:shrink-0">
            <span className="sr-only">证据搜索</span>
            <input className={`${apiInput} h-9 w-full text-xs`} name="q" aria-label="证据搜索" placeholder="搜索证据标题或摘要…" maxLength={200} defaultValue={filters.q ?? ""} />
          </label>
          <label className="min-w-0 lg:w-28 lg:shrink-0">
            <span className="sr-only">证据状态</span>
            <select className={`${apiInput} h-9 w-full text-xs`} name="status" aria-label="证据状态" defaultValue={filters.status ?? ""} onChange={(e) => applyFilterPatch({ status: e.target.value || null })}>
              <option value="">全部状态</option>
              {Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="min-w-0 lg:w-28 lg:shrink-0">
            <span className="sr-only">证据来源</span>
            <select className={`${apiInput} h-9 w-full text-xs`} name="source" aria-label="证据来源" defaultValue={filters.source_type ?? ""} onChange={(e) => applyFilterPatch({ source: e.target.value || null })}>
              <option value="">全部来源</option>
              {Object.entries(sources).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="min-w-0 lg:min-w-[140px] lg:flex-1">
            <span className="sr-only">证据所属任务</span>
            <select className={`${apiInput} h-9 w-full text-xs`} name="task" aria-label="证据所属任务" defaultValue={filters.task_id ?? ""} onChange={(e) => applyFilterPatch({ task: e.target.value || null })}>
              <option value="">全部任务</option>
              {access.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
          </label>
          <label className="min-w-0 lg:w-32 lg:shrink-0">
            <span className="sr-only">证据作者</span>
            <select className={`${apiInput} h-9 w-full text-xs`} name="author" aria-label="证据作者" defaultValue={filters.author_id ?? ""} onChange={(e) => applyFilterPatch({ author: e.target.value || null })}>
              <option value="">全部作者</option>
              {filters.author_id && !authors.some((author) => author.id === filters.author_id) && <option value={filters.author_id}>当前 URL 作者筛选（待核对）</option>}
              {authors.map((author) => <option key={author.id} value={author.id}>{author.title}</option>)}
            </select>
          </label>
          <label className="min-w-0 lg:min-w-[140px] lg:flex-1">
            <span className="sr-only">验收标准</span>
            <select className={`${apiInput} h-9 w-full text-xs`} name="criterion" aria-label="验收标准" defaultValue={filters.criterion_id ?? ""} onChange={(e) => applyFilterPatch({ criterion: e.target.value || null })}>
              <option value="">全部标准</option>
              {access.tasks.flatMap((task) => task.criteria.map((criterion) => <option key={criterion.id} value={criterion.id}>{task.title} · {criterion.text}</option>))}
            </select>
          </label>
          <div className="col-span-2 flex shrink-0 items-center gap-1.5 sm:col-span-3 lg:col-span-1">
            <button className={`${apiButton} h-9 px-3 text-xs`}>查询证据</button>
            {hasActiveFilters && (
              <button className={`${apiButton} h-9 px-2.5 text-xs`} type="button" onClick={() => { updateQuery({ q: null, status: null, source: null, task: null, author: null, criterion: null, page: null, evidence: null, decision: null }); setCommand(null); }}>重置</button>
            )}
          </div>
        </form>

        {creating && context.data && (
          <div className="mb-4">
            <EvidenceCapturePanel context={context.data} userId={userId} initialTaskId={query.get("task") ?? undefined} initialCriterionId={query.get("criterion") ?? undefined} visible={Boolean(access?.permissions.can_capture_evidence)} onSaved={() => { setCreating(false); void refresh(); }} onDenied={deny} />
          </div>
        )}

        {error && <ApiFailure error={error} />}
        {notice && <p role="status" className="my-2 text-sm text-emerald-700">{notice}</p>}
        {list.isFetching && <p role="status" className="my-2 text-xs text-slate-500">正在读取证据…</p>}
        {list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}

        {selectedTask && selectedTask.criteria.length > 0 && rows && (
          <Panel
            title={`任务交付标准与证据覆盖 · ${selectedTask.title}`}
            action={<div className="flex flex-wrap items-center gap-3 text-xs">
              <Link className="gp-link" href={`/projects/${projectId}/tasks?view=plan&task=${selectedTask.id}`}>查看/修改标准</Link>
              <Link className="gp-link font-medium" href={`/projects/${projectId}/tasks/${selectedTask.id}/submit`}>前往提交验收 →</Link>
            </div>}
          >
            {(() => {
              const confirmedCount = selectedTask.criteria.filter((c) => (taskEvidenceByCriterion.get(c.id) ?? []).some((ev) => ev.effective)).length;
              const evidencedCount = selectedTask.criteria.filter((c) => (taskEvidenceByCriterion.get(c.id) ?? []).length > 0).length;
              return <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/75 px-3.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2 text-slate-600">
                    <span>共 <strong className="text-slate-900">{selectedTask.criteria.length}</strong> 条交付标准</span>
                    <span>·</span>
                    <span>已有候选/代码证据 <strong className="text-sky-700">{evidencedCount}</strong> 条</span>
                    <span>·</span>
                    <span>已采纳正式证据 <strong className="text-emerald-700">{confirmedCount}</strong> 条</span>
                  </div>
                  {adoptableTaskEvidences.length > 0 && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white shadow-2xs transition hover:bg-sky-700 disabled:opacity-50"
                      disabled={busy || quickAdoptBusy !== null}
                      onClick={() => void quickAdoptAllForTask()}
                    >
                      <CheckCircle2 size={13} />
                      {quickAdoptBusy === "all" ? "正在批量采纳…" : `一键采纳全部候选证据 (${adoptableTaskEvidences.length})`}
                    </button>
                  )}
                </div>
                {confirmedCount === selectedTask.criteria.length ? (
                  <Feedback tone="success">
                    全部 {selectedTask.criteria.length}/{selectedTask.criteria.length} 条交付标准均已有正式证据覆盖，可点击右上角「前往提交验收」完成任务验收。
                  </Feedback>
                ) : evidencedCount > confirmedCount ? (
                  <Feedback tone="info">
                    下方「候选证据」尚不计入有效验收，核对后点击「确认采纳此证据」或「一键采纳全部候选证据」转为正式证据，即可提交完成。
                  </Feedback>
                ) : null}
                <ul className="space-y-2">
                  {selectedTask.criteria.map((criterion, index) => {
                    const linked = taskEvidenceByCriterion.get(criterion.id) ?? [];
                    const isConfirmed = linked.some((ev) => ev.effective);
                    return <li key={criterion.id} className="rounded-xl border border-slate-200/80 bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">标准 {index + 1}</span>
                          <p className="text-sm font-medium text-slate-900">{criterion.text}</p>
                        </div>
                        {isConfirmed ? <StatusBadge tone="green" label="已采纳正式证据" />
                          : linked.length > 0 ? <StatusBadge tone="blue" label="已有候选证据 · 待采纳" />
                          : <StatusBadge tone="gray" label="暂无证据" />}
                      </div>
                      {linked.length > 0 && (
                        <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                          {linked.map((ev) => {
                            const url = safeHttps(ev.source_url, ev.source_type === "github");
                            const adoptable = ["candidate", "pending_confirmation"].includes(ev.status) && canDecide(ev);
                            return <div key={ev.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <FileCode2 size={13} className="shrink-0 text-sky-600" />
                                  <button
                                    type="button"
                                    className="text-left font-medium text-slate-800 hover:underline"
                                    onClick={() => { updateQuery({ evidence: ev.id, decision: null }); setCommand(null); setError(null); }}
                                  >
                                    {ev.title}
                                  </button>
                                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ev.effective ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                    {ev.effective ? "正式" : "候选"}
                                  </span>
                                  {url && <a className="inline-flex items-center gap-0.5 text-sky-700 hover:underline" href={url} target="_blank" rel="noopener noreferrer">来源 <ExternalLink size={11} /></a>}
                                </div>
                              </div>
                              {adoptable && (
                                <button
                                  type="button"
                                  className="shrink-0 rounded-md border border-sky-200 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
                                  disabled={busy || quickAdoptBusy !== null}
                                  onClick={() => void quickAdoptOne(ev)}
                                >
                                  {quickAdoptBusy === ev.id ? "采纳中…" : "确认采纳此证据"}
                                </button>
                              )}
                            </div>;
                          })}
                        </div>
                      )}
                    </li>;
                  })}
                </ul>
              </div>;
            })()}
          </Panel>
        )}

        {/* Lightweight Collapsed-by-Default Evidence Table + Inline Split-Pane Detail */}
        <div className={selectedId ? "grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_440px]" : "grid grid-cols-1"}>
          {rows && (
            <div className="min-w-0">
              <Panel noPadding>
                {rows.items.length === 0 ? (
                  <div className="p-6"><EmptyState title="没有符合条件的证据" /></div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[780px] text-left text-sm">
                      <thead className="border-b border-slate-100 bg-slate-50/70 text-xs text-slate-500">
                        <tr>
                          <th className="px-4 py-2.5 font-medium">任务名与证据标题</th>
                          <th className="px-3 py-2.5 font-medium">负责人</th>
                          <th className="px-3 py-2.5 font-medium">完成时间</th>
                          <th className="px-3 py-2.5 font-medium">证据状态</th>
                          <th className="px-3 py-2.5 font-medium">证据来源</th>
                          <th className="px-4 py-2.5 text-right font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rows.items.map((entry) => {
                          const isExpanded = Boolean(expandedIds[entry.id]);
                          const url = safeHttps(entry.source_url, entry.source_type === "github");
                          const adoptable = ["candidate", "pending_confirmation"].includes(entry.status) && !entry.source_changed && canDecide(entry);
                          const parsed = parseEvidenceDetails(entry.title, entry.description);
                          const isSelected = selectedId === entry.id;
                          return (
                            <Fragment key={entry.id}>
                              <tr className={isSelected ? "bg-sky-50/60 hover:bg-sky-50/80" : "hover:bg-slate-50/60"}>
                                <td className="max-w-[340px] px-4 py-2.5">
                                  <div className="truncate font-medium text-slate-900" title={taskTitle(entry.task_id)}>
                                    {taskTitle(entry.task_id)}
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                                    {parsed.commitTag && (
                                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-700">
                                        {parsed.commitTag}
                                      </span>
                                    )}
                                    <button
                                      type="button"
                                      className="min-w-0 truncate text-left hover:text-slate-800 hover:underline"
                                      title={entry.title}
                                      onClick={() => toggleRowExpand(entry.id)}
                                    >
                                      {entry.title}
                                    </button>
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-700">
                                  {authorLabel(entry.author_id)}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500 tabular-nums">
                                  {formatDate(entry.updated_at || entry.created_at)}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <StatusBadge tone={statusTones[entry.status]} label={states[entry.status]} />
                                    {entry.source_changed && <StatusBadge tone="amber" label="来源已变化" />}
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                                  <div className="inline-flex items-center gap-1.5">
                                    <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                                      {sources[entry.source_type]}
                                    </span>
                                    {url && (
                                      <a
                                        className="inline-flex items-center text-sky-700 hover:text-sky-900"
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="打开原始来源"
                                      >
                                        <ExternalLink size={12} />
                                      </a>
                                    )}
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs">
                                  <div className="inline-flex items-center justify-end gap-1.5">
                                    <button
                                      type="button"
                                      aria-expanded={isExpanded}
                                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
                                      onClick={() => toggleRowExpand(entry.id)}
                                    >
                                      {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                      {isExpanded ? "收起详情" : "展开详情"}
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
                                      onClick={() => { updateQuery({ evidence: entry.id, decision: null }); setCommand(null); setError(null); }}
                                    >
                                      查看证据历史
                                    </button>
                                    {adoptable && (
                                      <button
                                        type="button"
                                        className="rounded-md bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                                        disabled={busy || quickAdoptBusy !== null}
                                        onClick={() => void quickAdoptOne(entry)}
                                      >
                                        {quickAdoptBusy === entry.id ? "采纳中…" : "确认采纳此证据"}
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr className="bg-slate-50/75">
                                  <td colSpan={6} className="px-4 py-3">
                                    <StructuredEvidenceDetails
                                      title={entry.title}
                                      description={entry.description}
                                      criterionIds={entry.criterion_ids}
                                      criterionTextById={criterionTextById}
                                      sourceUrl={entry.source_url}
                                      sourceType={entry.source_type}
                                    />
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="border-t border-slate-100 px-4 py-2.5">
                  <ApiPager
                    page={rows.page}
                    pageSize={rows.page_size}
                    total={rows.total}
                    change={(page) => { updateQuery({ page: String(page), evidence: null, decision: null }); setCommand(null); }}
                  />
                </div>
              </Panel>
            </div>
          )}

          {/* Non-modal Split-Pane Detail Panel inside <main> */}
          {selectedId && (
            <aside
              aria-label="证据详情与不可变快照"
              className="space-y-4 rounded-2xl border border-slate-200/85 bg-white p-5 shadow-xs xl:sticky xl:top-4 xl:max-h-[calc(100vh-110px)] xl:overflow-y-auto"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">证据详情与不可变快照</h2>
                  <p className="text-xs text-slate-500">
                    查看证据实现内容、来源快照与人工决定历史。
                  </p>
                </div>
                <button
                  type="button"
                  className={`${apiButton} shrink-0 text-xs`}
                  onClick={() => { updateQuery({ evidence: null, decision: null }); setCommand(null); }}
                >
                  关闭详情
                </button>
              </div>

              {detail.isFetching && <p role="status" className="text-xs text-slate-500">正在读取证据历史…</p>}
              {detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} />}
              {received && !item && <p role="alert" className="text-sm text-rose-700">无法核对这条证据的项目或记录编号。</p>}

              {item && (
                <div className="space-y-4">
                  <div className="space-y-2 rounded-xl border border-slate-200/80 bg-slate-50/75 p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-slate-900">{item.title}</h2>
                      <StatusBadge tone={statusTones[item.status]} label={states[item.status]} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span>任务：{taskTitle(item.task_id)}</span>
                      <span>·</span>
                      <span>负责人：{authorLabel(item.author_id)}</span>
                      <span>·</span>
                      <span>来源：{sources[item.source_type]}</span>
                      <span>·</span>
                      <span>{formatDate(item.updated_at || item.created_at)}</span>
                    </div>
                    <p className="text-xs font-medium text-slate-700">
                      {item.effective ? "当前可用于有效证据查询" : "当前不计入有效证据"}
                    </p>
                  </div>

                  <StructuredEvidenceDetails
                    title={item.title}
                    description={item.description}
                    criterionIds={item.criterion_ids}
                    criterionTextById={criterionTextById}
                    sourceUrl={item.source_url}
                    sourceType={item.source_type}
                  />

                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {safeHttps(item.source_url, item.source_type === "github") && (
                      <a className="gp-link" href={safeHttps(item.source_url, item.source_type === "github")!} target="_blank" rel="noopener noreferrer">
                        查看证据来源
                      </a>
                    )}
                    {activitySourceId && (
                      <Link className="gp-link" href={`/projects/${projectId}/${item.source_type === "github" ? "github" : "collaboration"}?record=${activitySourceId}`}>
                        查看项目中的{sources[item.source_type]}记录
                      </Link>
                    )}
                  </div>

                  {item.source_changed && (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      来源已变化，原快照保留；该证据当前不计入有效证据。
                    </p>
                  )}

                  {canDecide(item) && (
                    <div className="flex flex-wrap items-center gap-2 border-y border-slate-100 py-3">
                      {["candidate", "pending_confirmation"].includes(item.status) && !item.source_changed && (
                        <button
                          type="button"
                          className={apiButton}
                          disabled={busy}
                          onClick={() => { setCommand({ id: item.id, action: "adopt", expected: item.lock_version, reason: "" }); setError(null); }}
                        >
                          采纳为正式证据
                        </button>
                      )}
                      {["candidate", "pending_confirmation", "formal"].includes(item.status) && (
                        <button
                          type="button"
                          className={apiButton}
                          disabled={busy}
                          onClick={() => { setCommand({ id: item.id, action: "withdraw", expected: item.lock_version, reason: "" }); setError(null); }}
                        >
                          撤回证据
                        </button>
                      )}
                      {checkableSources.has(item.source_type) && (
                        originalSourceId(item) ? (
                          <button
                            type="button"
                            className={apiButton}
                            disabled={busy}
                            onClick={() => { key.reset(); setCommand({ id: item.id, action: "checkSource", expected: item.lock_version, reason: "", sourceId: originalSourceId(item)! }); setError(null); setNotice(""); }}
                          >
                            检查证据来源
                          </button>
                        ) : (
                          <p className="text-xs text-slate-600">原始来源标识不完整，暂不能检查来源；请刷新详情后重试。</p>
                        )
                      )}
                    </div>
                  )}

                  {command && command.id === selectedId && canDecide(item) && (
                    <Panel title={command.action === "checkSource" ? "确认检查来源" : command.action === "adopt" ? "确认采纳" : "确认撤回"}>
                      <p className="mb-3 text-xs text-slate-600">
                        {command.action === "checkSource"
                          ? "检查将对比原始来源与保存的快照；确认变化后会保留历史并标记该证据不再有效。外部来源服务未接通时无法完成检查。"
                          : command.action === "adopt"
                            ? "采纳不会自动形成验收结论。"
                            : "撤回会使证据不再计入有效证据，历史仍保留。"}
                      </p>
                      <label htmlFor="evidence-reason" className="text-xs font-medium text-slate-800">
                        {command.action === "checkSource" ? "来源检查原因" : "证据决定原因"}
                      </label>
                      <textarea
                        id="evidence-reason"
                        className={`${apiInput} mt-1 block w-full`}
                        value={command.reason}
                        maxLength={4000}
                        disabled={busy}
                        onChange={(event) => setCommand({ ...command, reason: event.target.value })}
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={apiButton}
                          disabled={busy || command.expected !== item.lock_version || versionFailure(error)}
                          onClick={() => void save()}
                        >
                          {command.action === "checkSource" ? "确认检查来源" : "确认决定"}
                        </button>
                        <button type="button" className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>
                        {(versionFailure(error) || command.expected !== item.lock_version) && (
                          <button type="button" className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对证据</button>
                        )}
                      </div>
                    </Panel>
                  )}

                  <div>
                    <h3 className="text-xs font-semibold text-slate-900">来源快照</h3>
                    {item.source_snapshots.map((snapshot) => (
                      <details key={snapshot.id} className="my-2 rounded-lg border border-slate-200/80 px-3 py-2 text-xs">
                        <summary className="cursor-pointer font-medium text-slate-800">
                          {tr("快照 v{0} · {1}", { 0: snapshot.version_no, 1: formatDate(snapshot.created_at) })}
                        </summary>
                        <div className="mt-2">
                          <SourceSnapshotContent snapshot={snapshot} sourceType={item.source_type} projectId={projectId} taskId={item.task_id} />
                        </div>
                      </details>
                    ))}
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold text-slate-900">决定历史</h3>
                    {decisionId && !referencedDecision && <p role="status" className="mt-1 text-xs text-amber-800">这条证据中找不到指定的决定。</p>}
                    {item.decisions.map((decision) => (
                      <p
                        key={decision.id}
                        ref={decision === referencedDecision ? decisionRef : undefined}
                        tabIndex={decision === referencedDecision ? -1 : undefined}
                        className={`my-2 text-xs text-slate-700 ${decision === referencedDecision ? "rounded border border-blue-400 p-2" : ""}`}
                      >
                        {decisions[decision.decision]} · {decision.reason} · {formatDate(decision.created_at)}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      </>}
    </>}
  </>;
}
