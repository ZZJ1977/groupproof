"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@/packages/domain/api.generated";
import { Panel } from "@/components/common";
import { accessFailure, apiButton, ApiFailure, apiInput, ApiPager, projectApi, queryPolicy, safeHttps, useCommandKey } from "./c-project-api";

type Context = components["schemas"]["CProjectContextDTO"];
type Source = "manual" | "task_note" | "discussion" | "file" | "github" | "feishu";
const sourceNames: Record<Source, string> = { manual: "手工说明或链接", task_note: "当前任务说明", discussion: "重要讨论", file: "已有项目文件", github: "GitHub 来源", feishu: "飞书来源" };

export function EvidenceCapturePanel({ context, userId, fixedTaskId, onSaved, onDenied, visible = true }: { context: Context; userId: string; fixedTaskId?: string; onSaved: () => void; onDenied: (error: unknown) => void; visible?: boolean }) {
  const projectId = context.project.id;
  const [taskId, setTaskId] = useState(fixedTaskId ?? "");
  const [kind, setKind] = useState<Source>("manual");
  const [sourceId, setSourceId] = useState("");
  const [page, setPage] = useState(1);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [criteria, setCriteria] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const commandKey = useCommandKey();
  const task = context.tasks.find((item) => item.id === taskId);
  const allowed = visible && context.permissions.can_capture_evidence && task?.can_capture_evidence;
  async function readSource<T>(request: Promise<T>): Promise<T> {
    try { return await request; } catch (next) { if (accessFailure(next)) onDenied(next); throw next; }
  }
  const note = useQuery({ queryKey: ["c-capture-note", userId, projectId, taskId], queryFn: () => readSource(projectApi.note(projectId, taskId)), enabled: kind === "task_note" && Boolean(taskId), ...queryPolicy });
  const discussions = useQuery({ queryKey: ["c-capture-discussions", userId, projectId, page], queryFn: () => readSource(projectApi.discussions(projectId, { is_important: true, page, page_size: 10 })), enabled: kind === "discussion", ...queryPolicy });
  const files = useQuery({ queryKey: ["c-capture-files", userId, projectId, page], queryFn: () => readSource(projectApi.files(projectId, { page, page_size: 10 })), enabled: kind === "file", ...queryPolicy });
  const activity = useQuery({ queryKey: ["c-capture-activity", userId, projectId, kind, page], queryFn: () => readSource(projectApi.activities(projectId, kind === "github" ? "github" : "feishu", { page, page_size: 10 })), enabled: kind === "github" || kind === "feishu", ...queryPolicy });
  const sourceQuery = kind === "task_note" ? note : kind === "discussion" ? discussions : kind === "file" ? files : kind !== "manual" ? activity : null;
  const sourcePage = kind === "discussion" ? discussions.data : kind === "file" ? files.data : activity.data;
  const sourceError = sourceQuery?.error;
  const options = sourceQuery?.isSuccess && !sourceQuery.isFetching ? kind === "task_note" ? (note.data?.versions ?? []).map((item) => ({ id: item.id, title: `${item.title} · v${item.version_no}` })) : kind === "discussion" ? (discussions.data?.items ?? []).filter((item) => item.is_important).map((item) => ({ id: item.id, title: item.title })) : kind === "file" ? (files.data?.items ?? []).map((item) => ({ id: item.id, title: `${item.name} · v${item.version_no}` })) : (activity.data?.items ?? []).filter((item) => item.availability === "available" && item.kind !== "sync").map((item) => ({ id: item.source_id, title: item.title })) : [];
  async function save() {
    if (!allowed || busyRef.current || sourceError) return;
    if (!title.trim() || !body.trim() || !criteria.length) { setNotice("请填写标题、说明并选择至少一条验收标准。"); return; }
    if (kind === "manual" && url.trim() && !safeHttps(url.trim())) { setNotice("来源链接须为不含登录凭据的 HTTPS 地址。"); return; }
    if (kind !== "manual" && !options.some((item) => item.id === sourceId)) { setNotice("请从已授权的来源列表选择记录。"); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    const input = { task_id: taskId, title: title.trim(), description: body.trim(), source_type: kind, criterion_ids: criteria, ...(kind === "manual" ? { source_url: url.trim() || null } : { source_id: sourceId }) };
    try {
      await projectApi.addEvidence(projectId, input, commandKey({ projectId, input }));
      setTitle(""); setBody(""); setCriteria([]); setSourceId(""); setUrl(""); setNotice("候选证据已保存，需经采纳后才是正式证据。"); onSaved();
    } catch (next) { setError(next); if (accessFailure(next)) onDenied(next); }
    finally { busyRef.current = false; setBusy(false); }
  }
  if (!visible) return null;
  return <Panel title="添加候选证据">
    {!fixedTaskId && <label className="mb-3 block">证据任务<select className={`${apiInput} block w-full`} value={taskId} disabled={busy} onChange={(event) => { setTaskId(event.target.value); setCriteria([]); setSourceId(""); }}><option value="">请选择任务</option>{context.tasks.filter((item) => item.can_capture_evidence).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
    <label className="mb-3 block">证据标题<input className={`${apiInput} block w-full`} maxLength={240} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
    <label htmlFor="capture-body">证据说明</label><textarea id="capture-body" className={`${apiInput} mb-3 block w-full`} maxLength={30000} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
    <label className="mb-3 block">来源类型<select className={`${apiInput} block w-full`} value={kind} disabled={busy} onChange={(event) => { setKind(event.target.value as Source); setSourceId(""); setUrl(""); setPage(1); setError(null); }}>{Object.entries(sourceNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {kind === "manual" ? <label className="mb-3 block">来源链接（可选）<input className={`${apiInput} block w-full`} type="url" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} placeholder="https://" /></label> : <>
      {sourceQuery?.isFetching && <p role="status">正在读取可用来源…</p>}{sourceError && <ApiFailure error={sourceError} retry={() => void sourceQuery?.refetch()} label="重试来源列表" />}
      {!sourceError && !sourceQuery?.isFetching && <label className="mb-3 block">来源记录<select className={`${apiInput} block w-full`} value={sourceId} disabled={busy} onChange={(event) => setSourceId(event.target.value)}><option value="">请选择来源</option>{options.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>{!options.length && <span className="text-sm">没有可选来源。</span>}</label>}
      {kind !== "task_note" && sourcePage && !sourceError && <ApiPager page={sourcePage.page} pageSize={sourcePage.page_size} total={sourcePage.total} change={(next) => { setPage(next); setSourceId(""); }} />}
      {["file", "github", "feishu"].includes(kind) && <p className="my-3 text-sm">来源内容需由授权服务核验；该适配尚未接通时无法保存。文件上传暂不可用。</p>}
    </>}
    <fieldset className="mb-3"><legend>对应验收标准</legend>{task?.criteria.map((criterion) => <label key={criterion.id} className="my-2 flex gap-2"><input type="checkbox" disabled={busy} checked={criteria.includes(criterion.id)} onChange={(event) => setCriteria(event.target.checked ? [...criteria, criterion.id] : criteria.filter((id) => id !== criterion.id))} />{criterion.text}</label>)}</fieldset>
    {Boolean(error) && <ApiFailure error={error} />}{notice && <p role="status" className="mb-3">{notice}</p>}
    <button className={apiButton} disabled={busy || !allowed || Boolean(sourceError)} onClick={() => void save()}>{busy ? "保存中…" : "保存候选证据"}</button>
  </Panel>;
}
