"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components, paths } from "@/packages/domain/api.generated";
import { EvidenceCapturePanel } from "./EvidenceCapturePanel";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, apiButton, ApiFailure, apiInput, ApiPager, isUuid, pageNumber, projectApi, queryPolicy, safeHttps, useCommandKey, versionFailure } from "./c-project-api";

type Evidence = components["schemas"]["EvidenceDetailDTO"];
type EvidenceQuery = paths["/api/v1/projects/{project_id}/evidence"]["get"]["parameters"]["query"];
const states = { candidate: "候选", pending_confirmation: "待确认", formal: "正式", withdrawn: "已撤回", void: "无效" } as const;
const sources = { manual: "手工说明", task_note: "任务说明", discussion: "重要讨论", file: "文件", screenshot: "截图", github: "GitHub", feishu: "飞书" } as const;
const decisions = { submitted: "提交候选", adopted: "采纳正式", withdrawn: "撤回", source_changed: "来源变化" } as const;

function snapshotRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function SourceSnapshotContent({ snapshot, sourceType }: { snapshot: Evidence["source_snapshots"][number]; sourceType: Evidence["source_type"] }) {
  // Canonical snapshots wrap the immutable source payload; never dump IDs or provider metadata.
  const source = snapshotRecord(snapshot.content.source);
  const text = ["title", "body", "summary", "description"].map((field) => typeof source[field] === "string" ? source[field] : null).filter(Boolean).join("\n");
  const replies = sourceType === "discussion" && Array.isArray(source.replies) ? source.replies.map(snapshotRecord).map((reply) => reply.body).filter((body): body is string => typeof body === "string") : [];
  return <>
    {snapshot.content.availability === "deleted" && <p className="my-2">此快照记录了来源已删除。</p>}
    {sourceType === "task_note" && typeof source.version_no === "number" && <p className="my-2 text-sm">任务说明 v{source.version_no}</p>}
    {sourceType === "discussion" && source.is_important === false && <p className="my-2">此快照中的讨论已取消重要标记。</p>}
    <p className="whitespace-pre-wrap">{text || "该来源快照不包含可直接展示的文字。"}</p>
    {replies.length > 0 && <div className="mt-3"><h4 className="font-semibold">快照中的回复</h4>{replies.map((body, index) => <p key={index} className="my-2 whitespace-pre-wrap">{body}</p>)}</div>}
  </>;
}

export function EvidenceApiPage({ projectId }: { projectId: string }) {
  const { userId } = useWorkspace();
  return <EvidencePage key={`${userId}:${projectId}`} userId={userId} projectId={projectId} />;
}
function EvidencePage({ userId, projectId }: { userId: string; projectId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const status = query.get("status"), source = query.get("source");
  const filters: EvidenceQuery = { page: pageNumber(query.get("page")), page_size: 10, task_id: query.get("task") || undefined, author_id: query.get("author") || undefined, criterion_id: query.get("criterion") || undefined, q: query.get("q") || undefined, status: status && Object.hasOwn(states, status) ? status as keyof typeof states : undefined, source_type: source && Object.hasOwn(sources, source) ? source as keyof typeof sources : undefined };
  const selectedId = query.get("evidence");
  const enabled = isUuid(projectId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const list = useQuery({ queryKey: ["c-evidence", userId, projectId, filters], queryFn: () => projectApi.evidence(projectId, filters), enabled, ...queryPolicy });
  const detail = useQuery({ queryKey: ["c-evidence-detail", userId, projectId, selectedId], queryFn: () => projectApi.evidenceDetail(projectId, selectedId!), enabled: enabled && Boolean(selectedId && isUuid(selectedId)) && context.isSuccess && !context.isFetching, ...queryPolicy });
  const [blocked, setBlocked] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState<{ id: string; action: "adopt" | "withdraw"; expected: number; reason: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const key = useCommandKey();
  const denial = blocked || [context.error, list.error, detail.error].find(accessFailure);
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const rows = access && list.isSuccess && !list.isFetching ? list.data : undefined;
  const item = access && detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const canDecide = (entry: Evidence) => Boolean(access?.permissions.can_capture_evidence && (access.actor.id === entry.author_id || access.actor.is_leader || access.actor.is_teacher));
  const taskTitle = (id: string) => access?.tasks.find((task) => task.id === id)?.title ?? "关联任务";
  function deny(next: unknown) { setBlocked(next); setCommand(null); setCreating(false); }
  async function refresh() {
    const results = await Promise.all([context.refetch(), list.refetch(), ...(selectedId ? [detail.refetch()] : [])]);
    const denied = results.find((result) => accessFailure(result.error));
    if (denied) deny(denied.error); else if (results[0].isSuccess) setBlocked(null);
  }
  async function save() {
    if (!command || !item || command.id !== item.id || !canDecide(item) || busyRef.current) return;
    if (!command.reason.trim()) { setNotice("请填写本次证据决定的原因。"); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    const input = { expected_version: command.expected, reason: command.reason.trim() };
    try {
      await projectApi[command.action](projectId, item.id, input, key({ projectId, evidenceId: item.id, action: command.action, input }));
      key.reset();
      setCommand(null); setNotice(command.action === "adopt" ? "证据已采纳为正式；验收结论需由验收服务决定。" : "证据已撤回，历史和快照仍保留。"); await refresh();
    } catch (next) { setError(next); if (accessFailure(next)) deny(next); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    if (!command || busyRef.current) return;
    const [latest, permission] = await Promise.all([detail.refetch(), context.refetch()]);
    const next = latest.error || permission.error;
    if (next) { setError(next); if (accessFailure(next)) deny(next); return; }
    if (latest.data) { setCommand({ ...command, expected: latest.data.lock_version }); setError(null); setNotice("已刷新状态，请核对证据和原因后再次确认。"); }
  }
  if (!enabled) return <EmptyState title="项目地址无效" />;
  return <>
    <PageHeader title="项目证据" description={access?.project.name ?? "正在验证项目权限…"} actions={<button className={apiButton} disabled={busy || context.isFetching || list.isFetching} onClick={() => void refresh()}>刷新证据</button>} />
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}{context.isFetching && <p role="status">正在验证项目权限…</p>}
      {access && <>
        <form key={JSON.stringify(filters)} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const fields = Object.fromEntries(["q", "status", "source", "task", "author", "criterion"].map((field) => [field, String(form.get(field) ?? "").trim() || null])); updateQuery({ ...fields, page: null, evidence: null }); setCommand(null); }}>
          <label>证据搜索<input className={`${apiInput} block`} name="q" maxLength={200} defaultValue={filters.q ?? ""} /></label>
          <label>证据状态<select className={`${apiInput} block`} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>证据来源<select className={`${apiInput} block`} name="source" defaultValue={filters.source_type ?? ""}><option value="">全部来源</option>{Object.entries(sources).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>证据所属任务<select className={`${apiInput} block`} name="task" defaultValue={filters.task_id ?? ""}><option value="">全部任务</option>{access.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
          <label>证据作者<select className={`${apiInput} block`} name="author" defaultValue={filters.author_id ?? ""}><option value="">全部作者</option>{access.members.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}</select></label>
          <label>验收标准<select className={`${apiInput} block`} name="criterion" defaultValue={filters.criterion_id ?? ""}><option value="">全部标准</option>{access.tasks.flatMap((task) => task.criteria.map((criterion) => <option key={criterion.id} value={criterion.id}>{task.title} · {criterion.text}</option>))}</select></label>
          <button className={apiButton}>查询证据</button><button className={apiButton} type="button" onClick={() => { updateQuery({ q: null, status: null, source: null, task: null, author: null, criterion: null, page: null, evidence: null }); setCommand(null); }}>重置</button>
        </form>
        {access.permissions.can_capture_evidence && <button className={`${apiButton} mb-4`} onClick={() => setCreating(!creating)}>{creating ? "关闭新增表单" : "添加候选证据"}</button>}
        {list.isFetching && <p role="status">正在读取证据…</p>}{list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}
        {rows && <Panel>{rows.items.map((entry) => <article className="mb-3 border-b border-slate-100 pb-3" key={entry.id}><strong>{entry.title}</strong><p>{states[entry.status]} · {sources[entry.source_type]} · {taskTitle(entry.task_id)}{entry.source_changed ? " · 来源已变化" : ""}</p><p className="my-2 text-sm">{entry.effective ? "当前可用于有效证据查询" : "当前不计入有效证据"}</p><button className={apiButton} onClick={() => { updateQuery({ evidence: entry.id }); setCommand(null); setError(null); }}>查看证据历史</button></article>)}{!rows.items.length && <EmptyState title="没有符合条件的证据" />}<ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => { updateQuery({ page: String(page), evidence: null }); setCommand(null); }} /></Panel>}
        {selectedId && <Panel title="证据详情与不可变快照" action={<button className={apiButton} onClick={() => { updateQuery({ evidence: null }); setCommand(null); }}>关闭详情</button>}>
          {detail.isFetching && <p role="status">正在读取证据历史…</p>}{detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} />}
          {item && <><h2 className="font-semibold">{item.title}</h2><p className="my-3 whitespace-pre-wrap">{item.description}</p>{safeHttps(item.source_url, item.source_type === "github") && <a className="gp-link" href={safeHttps(item.source_url, item.source_type === "github")!} target="_blank" rel="noopener noreferrer">查看证据来源</a>}
            {item.source_changed && <p className="my-3 text-amber-800">来源已变化，原快照保留；该证据当前不计入有效证据。</p>}
            <h3 className="mb-2 mt-4 font-semibold">对应标准</h3>{item.criterion_ids.map((id) => <p key={id}>{access.tasks.flatMap((task) => task.criteria).find((criterion) => criterion.id === id)?.text ?? "历史关联标准"}</p>)}
            {canDecide(item) && <div className="my-3 flex gap-2">{["candidate", "pending_confirmation"].includes(item.status) && !item.source_changed && <button className={apiButton} disabled={busy} onClick={() => { setCommand({ id: item.id, action: "adopt", expected: item.lock_version, reason: "" }); setError(null); }}>采纳为正式证据</button>}{["candidate", "pending_confirmation", "formal"].includes(item.status) && <button className={apiButton} disabled={busy} onClick={() => { setCommand({ id: item.id, action: "withdraw", expected: item.lock_version, reason: "" }); setError(null); }}>撤回证据</button>}</div>}
            <h3 className="mt-4 font-semibold">来源快照</h3>{item.source_snapshots.map((snapshot) => <details key={snapshot.id} className="my-2"><summary>快照 v{snapshot.version_no} · {formatDate(snapshot.created_at)}</summary><SourceSnapshotContent snapshot={snapshot} sourceType={item.source_type} /></details>)}
            <h3 className="mt-4 font-semibold">决定历史</h3>{item.decisions.map((decision) => <p key={decision.id} className="my-2 text-sm">{decisions[decision.decision]} · {decision.reason} · {formatDate(decision.created_at)}</p>)}</>}
        </Panel>}
        {command && command.id === selectedId && item && canDecide(item) && <Panel title={command.action === "adopt" ? "确认采纳" : "确认撤回"}><p className="mb-3 text-sm">{command.action === "adopt" ? "采纳不会自动形成验收结论。" : "撤回会使证据不再计入有效证据，历史仍保留。"}</p><label htmlFor="evidence-reason">证据决定原因</label><textarea id="evidence-reason" className={`${apiInput} block w-full`} value={command.reason} maxLength={4000} disabled={busy} onChange={(event) => setCommand({ ...command, reason: event.target.value })} /><div className="mt-3 flex gap-2"><button className={apiButton} disabled={busy} onClick={() => void save()}>确认决定</button><button className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>{versionFailure(error) && <button className={apiButton} onClick={() => void reviewLatest()}>刷新并核对证据</button>}</div></Panel>}
        {error && <ApiFailure error={error} />}{notice && <p role="status" className="my-3">{notice}</p>}
      </>}
      {creating && context.data && <EvidenceCapturePanel context={context.data} userId={userId} visible={Boolean(access?.permissions.can_capture_evidence)} onSaved={() => void refresh()} onDenied={deny} />}
    </>}
  </>;
}
