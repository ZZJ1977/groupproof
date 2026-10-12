"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { EvidenceCapturePanel } from "./EvidenceCapturePanel";
import { DiscussionsApiPage } from "./DiscussionsApiPage";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, apiButton, ApiFailure, apiInput, ApiPager, isUuid, pageNumber, projectApi, queryPolicy, taskNoteQuery, useCommandKey, versionFailure } from "./c-project-api";

const states: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" };
const tabs = { overview: "任务概览", evidence: "任务证据", verification: "任务验收", discussion: "任务讨论", history: "执行历史", criteria: "验收标准" } as const;
type NoteDraft = { title: string; body: string; expected: number };

export function ExecutionApiPage({ projectId, taskId, submission = false }: { projectId: string; taskId: string; submission?: boolean }) {
  const { userId } = useWorkspace();
  return <ExecutionPage key={`${userId}:${projectId}:${taskId}:${submission}`} projectId={projectId} taskId={taskId} userId={userId} submission={submission} />;
}
function ExecutionPage({ projectId, taskId, userId, submission }: { projectId: string; taskId: string; userId: string; submission: boolean }) {
  const { query, updateQuery } = useUrlQuery();
  const tab = query.get("tab") && Object.hasOwn(tabs, query.get("tab")!) ? query.get("tab") as keyof typeof tabs : "overview";
  const enabled = isUuid(projectId) && isUuid(taskId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const execution = useQuery({ queryKey: ["c-execution", userId, projectId, taskId], queryFn: () => projectApi.execution(taskId), enabled, ...queryPolicy });
  const taskExists = context.isSuccess && !context.isFetching && context.data.tasks.some((task) => task.id === taskId);
  const note = useQuery({ ...taskNoteQuery(userId, projectId, taskId), enabled: taskExists });
  const evidence = useQuery({ queryKey: ["c-task-evidence", userId, projectId, taskId, pageNumber(query.get("evidence_page"))], queryFn: () => projectApi.evidence(projectId, { task_id: taskId, page: pageNumber(query.get("evidence_page")), page_size: 10 }), enabled: taskExists && (submission || tab === "evidence"), ...queryPolicy });
  const history = useQuery({ queryKey: ["c-progress-history", userId, projectId, taskId, pageNumber(query.get("history_page"))], queryFn: () => projectApi.progressHistory(projectId, taskId, pageNumber(query.get("history_page")), 10), enabled: taskExists && tab === "history" && !submission, ...queryPolicy });
  const [blocked, setBlocked] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const key = useCommandKey();
  const [progress, setProgress] = useState<{ value: number; reason: string; expected: number } | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [prepareVersion, setPrepareVersion] = useState<number | null>(null);
  const denial = blocked || [context.error, execution.error, note.error, evidence.error, history.error].find(accessFailure);
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const task = access?.tasks.find((item) => item.id === taskId);
  const state = task && execution.isSuccess && !execution.isFetching && execution.data.project_id === projectId && execution.data.task_id === taskId ? execution.data : undefined;
  const savedNote = access && note.isSuccess && !note.isFetching ? note.data : undefined;
  const noteReady = access && note.isSuccess && !note.isFetching;
  const canNote = Boolean(task?.can_capture_evidence && access?.permissions.can_capture_evidence);
  const canPrepare = Boolean(state && !state.read_only && ["in_progress", "pending_submission"].includes(state.status) && state.responsible_ids.includes(access!.actor.id));
  function deny(next: unknown) { setBlocked(next); setProgress(null); setDraft(null); setPrepareVersion(null); }
  async function refresh() {
    const results = await Promise.all([context.refetch(), execution.refetch(), ...(taskExists ? [note.refetch()] : []), ...(taskExists && (submission || tab === "evidence") ? [evidence.refetch()] : []), ...(taskExists && !submission && tab === "history" ? [history.refetch()] : [])]);
    const denied = results.find((result) => accessFailure(result.error));
    if (denied) deny(denied.error); else if (results[0].isSuccess) setBlocked(null);
  }
  async function perform(action: "start" | "progress" | "note" | "prepare") {
    if (!state || busyRef.current) return;
    if (action === "start" && !state.can_start) return;
    if (action === "progress" && (!state.can_update_progress || !progress)) return;
    if (action === "note" && (!canNote || !draft || !noteReady)) return;
    if (action === "prepare" && (!canPrepare || prepareVersion === null || !noteReady)) return;
    if (action === "progress" && (!progress!.reason.trim() || !Number.isInteger(progress!.value) || progress!.value < 0 || progress!.value > 100)) { setNotice("请填写 0–100 的整数进度及变更原因。"); return; }
    if ((action === "note" || action === "prepare") && draft && (!draft.title.trim() || !draft.body.trim())) { setNotice("任务说明的标题和正文不能为空。"); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    try {
      if (action === "start") await projectApi.start(taskId, state.version);
      if (action === "progress") await projectApi.progress(taskId, { expected_version: progress!.expected, progress: progress!.value, reason: progress!.reason.trim() });
      const noteInput = draft ? { title: draft.title.trim(), body: draft.body.trim(), expected_version: draft.expected } : null;
      if (action === "note" && noteInput) await projectApi.saveNote(projectId, taskId, noteInput, key({ action, projectId, taskId, noteInput }));
      if (action === "prepare") {
        const input = { expected_version: prepareVersion!, note: noteInput };
        await projectApi.prepareSubmission(taskId, input, key({ action, projectId, taskId, input }));
      }
      key.reset();
      if (action === "progress") setProgress(null);
      if (action === "note" || action === "prepare") setDraft(null);
      setPrepareVersion(null); setNotice(action === "prepare" ? "提交准备已保存，任务处于待提交状态。验收检查服务尚未接入，暂不能继续验收。" : "操作已保存。"); await refresh();
    } catch (next) { setError(next); if (accessFailure(next)) deny(next); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    const [latest, latestNote, permission] = await Promise.all([execution.refetch(), note.refetch(), context.refetch()]);
    const next = latest.error || latestNote.error || permission.error;
    if (next) { setError(next); if (accessFailure(next)) deny(next); return; }
    if (latest.data) { if (progress) setProgress({ ...progress, expected: latest.data.version }); if (prepareVersion !== null) setPrepareVersion(latest.data.version); }
    if (draft) setDraft({ ...draft, expected: latestNote.data?.lock_version ?? 0 });
    setError(null); setNotice("最新状态和已保存说明已刷新，输入仍保留；请对照后再次确认。");
  }
  if (!enabled) return <EmptyState title="任务地址无效" />;
  return <>
    <PageHeader title={submission ? "任务说明与提交准备" : task?.title ?? "任务执行"} description={access?.project.name ?? "正在验证项目权限…"} actions={<button className={apiButton} disabled={busy || context.isFetching || execution.isFetching} onClick={() => void refresh()}>刷新任务</button>} />
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {(context.isFetching || execution.isFetching) && <p role="status">正在读取当前任务…</p>}{context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}{execution.isError && <ApiFailure error={execution.error} retry={() => void refresh()} />}
      {access && !task && <EmptyState title="当前项目中没有此任务" />}
      {task && execution.isSuccess && execution.data.project_id !== projectId && <EmptyState title="任务不属于当前项目" />}
      {state && access && task && <>
        <Panel><p>任务：{task.title}</p><p>状态：{states[state.status]} · 进度：{state.progress}%</p><p className="mt-2 text-sm">100% 进度不会自动完成任务。验收结论由验收服务提供。</p><div className="mt-3 flex flex-wrap gap-2">{state.can_start && <button className={apiButton} disabled={busy} onClick={() => void perform("start")}>开始任务</button>}{state.can_update_progress && !submission && <button className={apiButton} disabled={busy} onClick={() => { setProgress({ value: state.progress, reason: "", expected: state.version }); setError(null); }}>更新进度</button>}<Link className={apiButton} href={`/projects/${projectId}/tasks/${taskId}${submission ? "" : "/submit"}`}>{submission ? "返回任务" : "任务说明与候选证据"}</Link></div></Panel>
        {!submission && <div className="my-4 flex flex-wrap gap-2">{Object.entries(tabs).map(([value, label]) => <button className={apiButton} key={value} aria-pressed={tab === value} onClick={() => updateQuery({ tab: value })}>{label}</button>)}</div>}
        {progress && state.can_update_progress && <Panel title="更新任务进度"><label>任务进度<input className={`${apiInput} block`} type="number" min={0} max={100} step={1} value={progress.value} disabled={busy} onChange={(event) => setProgress({ ...progress, value: Number(event.target.value) })} /></label><label htmlFor="progress-reason">进度变更原因</label><textarea id="progress-reason" className={`${apiInput} block w-full`} maxLength={2000} disabled={busy} value={progress.reason} onChange={(event) => setProgress({ ...progress, reason: event.target.value })} /><div className="mt-3 flex gap-2"><button className={apiButton} disabled={busy} onClick={() => void perform("progress")}>保存进度</button><button className={apiButton} disabled={busy} onClick={() => setProgress(null)}>取消</button></div></Panel>}
        {!submission && tab === "overview" && <Panel title="执行概览"><p>项目进度：{state.project_progress === null ? "暂无可计算进度" : `${state.project_progress}%`}</p><p className="my-2">负责人：{state.responsible_ids.map((id) => access.members.find((member) => member.id === id)?.title ?? "项目负责人").join("、") || "未指派"}</p><h3 className="mt-3 font-semibold">前置任务</h3>{state.dependencies.map((dependency) => <p key={dependency.task_id}>{access.tasks.find((item) => item.id === dependency.task_id)?.title ?? "前置任务"} · {dependency.satisfied ? "已满足" : "尚未满足"}</p>)}{!state.dependencies.length && <p>没有前置任务。</p>}<p className="mt-3 text-sm">验收详情和结论服务尚未接入。</p></Panel>}
        {!submission && tab === "criteria" && <Panel title="当前验收标准">{task.criteria.map((criterion) => <p className="my-2" key={criterion.id}>{criterion.text}</p>)}{!task.criteria.length && <p>暂无验收标准。</p>}</Panel>}
        {!submission && tab === "verification" && <Panel title="任务验收"><p>验收查询和结论服务尚未接入，当前无法读取验收检查、通过或退回结果。</p><p className="mt-3 text-sm">已保存的任务进度、说明和正式证据不会被当作验收通过结果。</p></Panel>}
        {(submission || tab === "evidence") && <Panel title="任务已有证据">{evidence.isFetching && <p role="status">正在读取证据…</p>}{evidence.isError && <ApiFailure error={evidence.error} retry={() => void evidence.refetch()} />}{evidence.isSuccess && !evidence.isFetching && <>{evidence.data.items.map((item) => <p className="my-2" key={item.id}><Link className="gp-link" href={`/projects/${projectId}/evidence?evidence=${item.id}`}>{item.title}</Link> · {item.effective ? "有效正式证据" : "当前不计入有效证据"}</p>)}{!evidence.data.items.length && <p>暂无证据。</p>}<ApiPager page={evidence.data.page} pageSize={evidence.data.page_size} total={evidence.data.total} change={(page) => updateQuery({ evidence_page: String(page) })} /></>}</Panel>}
        {(submission || tab === "history") && <Panel title="任务说明版本">{note.isFetching && <p role="status">正在读取说明…</p>}{note.isError && <ApiFailure error={note.error} retry={() => void note.refetch()} />}{noteReady && <>{savedNote?.versions.map((version) => <details className="my-3" key={version.id}><summary>v{version.version_no} · {version.title} · {formatDate(version.created_at)}</summary><p className="whitespace-pre-wrap">{version.body}</p></details>)}{!savedNote && <p>尚未保存任务说明。</p>}{submission && canNote && !draft && <button className={apiButton} onClick={() => { const current = savedNote?.versions.find((version) => version.version_no === savedNote.current_version_no); setDraft({ title: current?.title ?? task.title, body: current?.body ?? "", expected: savedNote?.lock_version ?? 0 }); setError(null); }}>编辑任务说明</button>}</>}</Panel>}
        {submission && draft && canNote && <Panel title="编辑任务说明"><label>说明标题<input className={`${apiInput} block w-full`} maxLength={240} value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label htmlFor="task-note-body">说明正文</label><textarea id="task-note-body" className={`${apiInput} block min-h-40 w-full`} maxLength={100000} value={draft.body} disabled={busy} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /><p className="my-3 text-sm">每次保存生成新版本，旧版本与其证据快照保留。</p><button className={apiButton} disabled={busy || !noteReady} onClick={() => void perform("note")}>保存说明新版本</button><button className={`${apiButton} ml-2`} disabled={busy} onClick={() => { setDraft(null); setPrepareVersion(null); }}>取消编辑</button></Panel>}
        {!submission && tab === "history" && <Panel title="任务进度与状态历史">{history.isFetching && <p role="status">正在读取执行历史…</p>}{history.isError && <ApiFailure error={history.error} retry={() => void history.refetch()} />}{history.isSuccess && !history.isFetching && <>{history.data.items.map((event) => <article key={event.id} className="mb-3 border-l-2 border-slate-200 pl-3"><p>{event.actor_name} · {formatDate(event.created_at)}</p><p>{event.from_status ? states[event.from_status] ?? event.from_status : "—"} → {event.to_status ? states[event.to_status] ?? event.to_status : "—"} · {event.progress_before ?? "—"}% → {event.progress_after ?? "—"}%</p><p>{event.reason ?? "未提供原因"}</p></article>)}{!history.data.items.length && <p>暂无执行历史。</p>}<ApiPager page={history.data.page} pageSize={history.data.page_size} total={history.data.total} change={(page) => updateQuery({ history_page: String(page) })} /></>}</Panel>}
        {submission && <Panel title="提交准备"><p className="mb-3">保存说明和待提交状态后，仍需独立验收检查。验收服务当前尚未接入。</p>{canPrepare && (prepareVersion === null ? <button className={apiButton} disabled={busy || !noteReady} onClick={() => setPrepareVersion(state.version)}>准备提交</button> : <><p className="mb-3">{draft ? "当前编辑的说明将与待提交状态一同保存。" : "将保留已保存的说明，并准备提交。"}</p><button className={apiButton} disabled={busy || !noteReady} onClick={() => void perform("prepare")}>确认保存提交准备</button><button className={`${apiButton} ml-2`} disabled={busy} onClick={() => setPrepareVersion(null)}>取消</button></>)}</Panel>}
        {error && <ApiFailure error={error} />}{versionFailure(error) && <button className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对输入</button>}{notice && <p role="status" className="my-3">{notice}</p>}
      </>}
      {!submission && tab === "discussion" && <DiscussionsApiPage projectId={projectId} taskId={taskId} visible={Boolean(state)} />}
      {submission && context.data && <EvidenceCapturePanel context={context.data} userId={userId} fixedTaskId={taskId} visible={Boolean(state && canNote)} onSaved={() => void evidence.refetch()} onDenied={deny} />}
    </>}
  </>;
}
