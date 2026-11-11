"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { CApiError, type ActivityQuery, type ActivitySourceType } from "@/lib/api/c-client";
import { readProjectBindings } from "@/lib/api/c-project-bindings";
import type { components } from "@/packages/domain/api.generated";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiFailure, ApiPager, apiButton, apiInput, isUuid, pageNumber, projectApi, queryPolicy, safeHttps, useCommandKey, versionFailure } from "./c-project-api";

type Activity = components["schemas"]["ActivityDTO"];
type Action = "associate" | "adopt" | "ignore" | "restore";
type Command = { sourceId: string; action: Action; expected: number; taskId: string; criteria: string[]; reason: string };
const statuses = { candidate: "待处理", adopted: "已采纳", ignored: "已忽略" } as const;
const actionLabels = { associate: "关联任务", adopt: "采纳为候选证据", ignore: "忽略记录", restore: "恢复待处理" } as const;
const kindLabels: Record<string, string> = { commit: "提交记录", pr: "拉取请求", ci: "持续集成", sync: "同步事件", document: "文档", message: "消息" };
function selectedFilter(value: string | null) { return value && value !== "all" ? value : undefined; }
function snapshotText(snapshot: Record<string, unknown>, key: string) { return typeof snapshot[key] === "string" ? snapshot[key] as string : ""; }

export function ActivityApiPage({ projectId, sourceType }: { projectId: string; sourceType: ActivitySourceType }) {
  const { userId } = useWorkspace();
  return <ActivityPage key={`${userId}:${projectId}:${sourceType}`} projectId={projectId} sourceType={sourceType} userId={userId} />;
}

function ActivityPage({ projectId, sourceType, userId }: { projectId: string; sourceType: ActivitySourceType; userId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const rawStatus = query.get("status");
  const groupFilter = query.has("group_id") ? query.get("group_id") || undefined : selectedFilter(query.get("group"));
  const filters: ActivityQuery = { page: pageNumber(query.get("page")), page_size: 10, q: query.get("q") || undefined, status: rawStatus && Object.hasOwn(statuses, rawStatus) ? rawStatus as keyof typeof statuses : undefined, task_id: query.get("task") || undefined, author_id: query.get("author") || undefined, since: query.get("date_from") ? `${query.get("date_from")}T00:00:00Z` : undefined, until: query.get("date_to") ? `${query.get("date_to")}T23:59:59.999999Z` : undefined, group_id: sourceType === "feishu" ? groupFilter : undefined, kind: selectedFilter(query.get("kind")) };
  const selectedId = query.get("record");
  const enabled = isUuid(projectId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const bindings = useQuery({
    queryKey: ["c-project-bindings", userId, projectId, sourceType],
    queryFn: ({ signal }) => readProjectBindings(projectId, sourceType, signal),
    enabled: enabled && context.isSuccess && context.data.actor.is_member,
    ...queryPolicy,
  });
  const list = useQuery({ queryKey: ["c-project-activities", userId, projectId, sourceType, filters], queryFn: () => projectApi.activities(projectId, sourceType, filters), enabled, ...queryPolicy });
  const selectedEnabled = enabled && Boolean(selectedId && isUuid(selectedId)) && context.isSuccess && !context.isFetching;
  const detail = useQuery({ queryKey: ["c-project-activity", userId, projectId, sourceType, selectedId], queryFn: () => projectApi.activity(projectId, sourceType, selectedId!), enabled: selectedEnabled, ...queryPolicy });
  const history = useQuery({ queryKey: ["c-project-activity-history", userId, projectId, sourceType, selectedId], queryFn: () => projectApi.activityHistory(projectId, sourceType, selectedId!), enabled: selectedEnabled, ...queryPolicy });
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const commandKey = useCommandKey();
  const hiddenProject = bindings.error instanceof CApiError && bindings.error.code === "PROJECT_NOT_FOUND" ? bindings.error : null;
  const denial = blocked || hiddenProject || [context.error, list.error, detail.error, history.error, bindings.error].find(accessFailure);
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const rows = access && list.isSuccess && !list.isFetching ? list.data : undefined;
  const connected = access?.actor.is_member && bindings.isSuccess && !bindings.isFetching ? bindings.data : undefined;
  // Retained records remain filterable after a group is unlinked. Only A's list indicates a current binding.
  const groups = [...new Set([
    ...(connected?.kind === "feishu" ? connected.items.map((group) => group.chat_id) : []),
    ...(rows?.items.flatMap((item) => item.group_id ? [item.group_id] : []) ?? []),
  ])];
  const kinds = [...new Set(rows?.items.map((item) => item.kind) ?? [])];
  const authors = [...new Map(rows?.items.flatMap((item) => item.author_id ? [[item.author_id, item.author_name || "来源未提供作者名称"] as const] : []) ?? []).entries()];
  const record = access && detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const savedHistory = access && history.isSuccess && !history.isFetching ? history.data : undefined;
  const targetTask = command && access?.tasks.find((task) => task.id === command.taskId);
  const taskName = (taskId: string | null) => access?.tasks.find((task) => task.id === taskId)?.title ?? "未关联任务";
  const canChange = Boolean(record && access?.permissions.can_manage_activity && record.availability === "available" && record.kind !== "sync");

  function fail(error: unknown) {
    setOperationError(error);
    if (accessFailure(error)) { setBlocked(error); setCommand(null); }
  }
  async function refresh() {
    const results = await Promise.all([context.refetch(), list.refetch(), ...(context.data?.actor.is_member ? [bindings.refetch()] : []), ...(selectedId ? [detail.refetch(), history.refetch()] : [])]);
    const failed = results.find((result) => accessFailure(result.error));
    if (failed) { setBlocked(failed.error); setCommand(null); }
    else if (results[0].isSuccess) setBlocked(null);
  }
  function begin(item: Activity, action: Action) {
    setCommand({ sourceId: item.source_id, action, expected: item.lock_version, taskId: item.task_id ?? "", criteria: [], reason: "" });
    setOperationError(null); setNotice("");
  }
  async function submit() {
    if (!command || !canChange || busyRef.current || record?.source_id !== command.sourceId) return;
    if (command.action === "adopt" && record.snapshot_complete === false) { setNotice("来源仅提供摘要，需要完整正文才能采纳。"); return; }
    if (!command.reason.trim()) { setNotice("请填写本次操作的原因。"); return; }
    if (command.action === "adopt" && (!targetTask?.can_capture_evidence || !command.criteria.length)) { setNotice("请选择可接收证据的任务及至少一条验收标准。"); return; }
    if (command.action === "associate" && command.taskId && !targetTask?.can_associate) { setNotice("所选任务当前不可关联，请刷新任务范围。"); return; }
    busyRef.current = true; setBusy(true); setOperationError(null); setNotice("");
    try {
      if (command.action === "associate") {
        const input = { task_id: command.taskId || null, expected_version: command.expected, reason: command.reason.trim() };
        await projectApi.associateActivity(projectId, sourceType, command.sourceId, input, commandKey({ projectId, sourceType, sourceId: command.sourceId, action: command.action, input }));
      } else {
        const input = { action: command.action, expected_version: command.expected, reason: command.reason.trim(), ...(command.action === "adopt" ? { task_id: command.taskId, criterion_ids: command.criteria } : {}) };
        await projectApi.decideActivity(projectId, sourceType, command.sourceId, input, commandKey({ projectId, sourceType, sourceId: command.sourceId, input }));
      }
      setCommand(null); setNotice(command.action === "adopt" ? "已生成候选证据，尚未成为正式证据。" : "操作已保存，来源历史仍保留。");
      await refresh();
    } catch (error) { fail(error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    if (!command || busyRef.current) return;
    const [latest, permission] = await Promise.all([detail.refetch(), context.refetch()]);
    if (latest.error || permission.error) { fail(latest.error || permission.error); return; }
    if (latest.data && permission.data?.permissions.can_manage_activity) {
      const required = command.action === "restore" ? "ignored" : "candidate";
      if (latest.data.status !== required || latest.data.availability !== "available" || (command.action === "adopt" && latest.data.snapshot_complete === false)) { setCommand(null); setOperationError(null); setNotice("记录状态已变化，请重新选择可用操作。"); }
      else { setCommand({ ...command, expected: latest.data.lock_version }); setOperationError(null); setNotice("已读取最新状态，请核对输入后再次提交。"); }
    }
  }
  function selectRecord(id: string) { updateQuery({ record: id }); setCommand(null); setOperationError(null); setNotice(""); }
  if (!enabled) return <EmptyState title="项目地址无效" description="请从已授权项目入口打开活动页。" />;
  return <>
    <PageHeader title={sourceType === "github" ? "GitHub 开发活动" : "飞书协作记录"} description={access?.project.name ?? "正在验证项目权限…"} actions={<button className={apiButton} disabled={busy || context.isFetching || list.isFetching} onClick={() => void refresh()}>刷新活动</button>} />
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isFetching && <p role="status">正在验证项目权限…</p>}{context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
      {access && <>
        {access.actor.is_member && <section className="mb-4 text-sm" aria-label="项目绑定状态">
          {bindings.isFetching && <p role="status">正在读取绑定状态…</p>}
          {bindings.isError && <p>暂时无法读取绑定状态。 <button type="button" className={apiButton} onClick={() => void bindings.refetch()}>重试绑定查询</button></p>}
          {connected?.kind === "feishu" && <p>{connected.items.length ? `已绑定 ${connected.items.length} 个飞书群` : "此项目尚未绑定飞书群。"}
            {access.actor.is_leader && <Link className="gp-link ml-3" href={`/feishu/${projectId}`}>管理飞书群绑定</Link>}</p>}
          {connected?.kind === "github" && (connected.items.length ? <ul>{connected.items.map((repo) => <li key={repo.owner + "/" + repo.repo}>
            <a className="gp-link" href={`https://github.com/${repo.owner}/${repo.repo}`} target="_blank" rel="noopener noreferrer">{repo.owner}/{repo.repo}</a>
            <span className="ml-2">默认分支 {repo.default_branch} · {repo.last_synced_at ? "文本文件上次同步 " + formatDate(repo.last_synced_at) : "尚未同步文本文件"}</span>
          </li>)}</ul> : <p>此项目尚未绑定 GitHub 仓库。</p>)}
          {connected?.kind === "github" && access.actor.is_leader && <Link className="gp-link" href={`/github/${projectId}`}>管理 GitHub 仓库绑定</Link>}
        </section>}
        {!access.permissions.can_manage_activity && <p className="mb-3 text-sm">当前活动记录只读。</p>}
        <form key={`${filters.q}:${filters.status}:${filters.task_id}:${filters.author_id}:${filters.since}:${filters.until}:${filters.group_id}:${filters.kind}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const fields = Object.fromEntries(["q", "status", "task", "author", "date_from", "date_to", "kind"].map((field) => [field, String(form.get(field) ?? "").trim() || null])); updateQuery({ ...fields, group_id: sourceType === "feishu" ? String(form.get("group_id") ?? "") || null : null, group: null, page: null, record: null }); setCommand(null); }}>
          <label>搜索记录<input className={`${apiInput} block`} name="q" maxLength={200} defaultValue={filters.q ?? ""} /></label>
          {sourceType === "feishu" && <label>来源群组<select className={`${apiInput} block max-w-xs`} name="group_id" defaultValue={filters.group_id ?? ""}><option value="">全部群组</option>{filters.group_id && <option value={filters.group_id}>{groups.includes(filters.group_id) ? filters.group_id : "当前 URL 群组筛选（待来源核对）"}</option>}{groups.filter((group) => group !== filters.group_id).map((group) => <option key={group} value={group}>{group}</option>)}</select></label>}
          <label>记录类型<select className={`${apiInput} block`} name="kind" defaultValue={filters.kind ?? ""}><option value="">全部类型</option>{filters.kind && <option value={filters.kind}>{Object.hasOwn(kindLabels, filters.kind) ? kindLabels[filters.kind] : kinds.includes(filters.kind) ? filters.kind : "当前 URL 类型筛选（待来源核对）"}</option>}{kinds.filter((kind) => kind !== filters.kind).map((kind) => <option key={kind} value={kind}>{Object.hasOwn(kindLabels, kind) ? kindLabels[kind] : kind}</option>)}</select></label>
          <label>处理状态<select className={`${apiInput} block`} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>关联任务<select className={`${apiInput} block`} name="task" defaultValue={filters.task_id ?? ""}><option value="">全部任务</option>{access.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
          <label>记录作者<select className={`${apiInput} block`} name="author" defaultValue={filters.author_id ?? ""}><option value="">全部作者</option>{filters.author_id && !authors.some(([id]) => id === filters.author_id) && <option value={filters.author_id}>当前 URL 作者筛选（待来源核对）</option>}{authors.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label>开始日期<input className={`${apiInput} block`} type="date" name="date_from" defaultValue={query.get("date_from") ?? ""} /></label><label>结束日期<input className={`${apiInput} block`} type="date" name="date_to" defaultValue={query.get("date_to") ?? ""} /></label>
          <button className={apiButton} type="submit">查询活动</button><button className={apiButton} type="button" onClick={() => { updateQuery({ q: null, status: null, task: null, author: null, date_from: null, date_to: null, group_id: null, group: null, kind: null, page: null, record: null }); setCommand(null); }}>重置</button>
        </form><p className="mb-3 text-xs text-slate-500">日期按 UTC 自然日筛选。{sourceType === "feishu" && "群组选项包括已读取的绑定群和本页历史记录中的群。"}类型和作者选项来自本页记录。</p>
        {list.isFetching && <p role="status">正在读取活动…</p>}{list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}
        {rows && <Panel><div className="space-y-3">{rows.items.map((item) => <article key={item.source_id} className="border-b border-slate-100 pb-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{item.title}</strong><span>{statuses[item.status]}</span></div><p className="my-2 whitespace-pre-wrap text-sm">{item.summary}</p><p className="mb-2 text-xs text-slate-500">{item.author_name || "来源未提供作者名称"} · {formatDate(item.occurred_at)} · {taskName(item.task_id)}</p><button className={apiButton} onClick={() => selectRecord(item.source_id)}>查看记录</button></article>)}</div>{!rows.items.length && <EmptyState title="没有符合条件的来源记录" />}<ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => { updateQuery({ page: String(page), record: null }); setCommand(null); }} /></Panel>}
        {selectedId && <Panel title="记录详情与历史" action={<button className={apiButton} onClick={() => { updateQuery({ record: null }); setCommand(null); }}>关闭详情</button>}>
          {detail.isFetching && <p role="status">正在读取来源…</p>}{detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} label="重试来源" />}
          {record && <><h2 className="font-semibold">{record.title}</h2><p className="my-2 whitespace-pre-wrap">{record.summary}</p><p className="mb-3 text-sm">{record.author_name || "来源未提供作者名称"} · {statuses[record.status]} · {taskName(record.task_id)}</p>{record.snapshot_complete === false && <p className="my-2 text-sm">当前来源仅提供摘要，获得完整正文后才可采纳为候选证据。</p>}{record.source_changed && <p className="my-3 text-sm text-amber-800">来源与最近保存的快照不同，旧快照仍保留。正式证据状态需另行核查。</p>}{record.availability === "deleted" && <p className="my-3 text-sm">来源已删除，不可进行新的采纳或关联。</p>}{safeHttps(record.source_url, sourceType === "github") && <a className="gp-link" href={safeHttps(record.source_url, sourceType === "github")!} target="_blank" rel="noopener noreferrer">查看原始来源</a>}
            {record.suggested_task_ids.length > 0 && <p className="my-2 text-sm">关联建议：{record.suggested_task_ids.map((id) => access.tasks.find((task) => task.id === id)?.title).filter(Boolean).join("、") || "暂无可读任务"}（需人工确认）</p>}
            {(record.evidence_id || record.source_changed) && <p className="my-3 text-sm"><Link className="gp-link" href={record.evidence_id && isUuid(record.evidence_id) ? `/projects/${projectId}/evidence?evidence=${encodeURIComponent(record.evidence_id)}` : `/projects/${projectId}/evidence?${new URLSearchParams({ source: sourceType, ...(record.task_id && isUuid(record.task_id) ? { task: record.task_id } : {}) })}`}>{record.evidence_id && isUuid(record.evidence_id) ? "查看关联证据并检查来源" : "到证据中心查找相关来源"}</Link>{record.snapshot_complete === false && <p className="my-2 text-sm">当前来源仅提供摘要，获得完整正文后才可采纳为候选证据。</p>}{record.source_changed && <span> · 在证据详情中，由有权限的成员填写原因并主动检查；打开页面不会改变证据。</span>}</p>}
            {canChange && <div className="my-3 flex flex-wrap gap-2">{record.status === "candidate" && <button className={apiButton} disabled={busy} onClick={() => begin(record, "associate")}>关联任务</button>}{sourceType === "feishu" && record.status === "candidate" && <><button className={apiButton} disabled={busy || record.snapshot_complete === false || !access.permissions.can_capture_evidence} onClick={() => begin(record, "adopt")}>采纳为候选证据</button><button className={apiButton} disabled={busy} onClick={() => begin(record, "ignore")}>忽略记录</button></>}{sourceType === "feishu" && record.status === "ignored" && <button className={apiButton} disabled={busy} onClick={() => begin(record, "restore")}>恢复待处理</button>}</div>}
          </>}
          <h3 className="mb-2 mt-4 font-semibold">已保存的操作历史</h3>{history.isFetching && <p role="status">正在读取历史…</p>}{history.isError && <ApiFailure error={history.error} retry={() => void history.refetch()} label="重试历史" />}{savedHistory && <>{savedHistory.decisions.map((decision) => <article key={decision.id} className="mb-3 border-l-2 border-slate-200 pl-3"><p>{actionLabels[decision.action]} · {decision.reason}</p><p className="text-xs text-slate-500">{formatDate(decision.created_at)}</p><p className="mt-1 text-sm">当时来源：{snapshotText(decision.source_snapshot, "title") || "未提供标题"} · {snapshotText(decision.source_snapshot, "author_name") || "未提供作者名称"}</p></article>)}{!savedHistory.decisions.length && <p className="text-sm">还没有保存的处理记录。</p>}</>}
        </Panel>}
        {command && command.sourceId === selectedId && access.permissions.can_manage_activity && <Panel title={actionLabels[command.action]}>
          {(command.action === "associate" || command.action === "adopt") && <><label htmlFor="activity-task">目标任务</label><select id="activity-task" className={`${apiInput} mb-3 mt-1 block w-full`} value={command.taskId} disabled={busy} onChange={(event) => setCommand({ ...command, taskId: event.target.value, criteria: [] })}><option value="">{command.action === "associate" ? "取消任务关联" : "请选择任务"}</option>{access.tasks.filter((task) => command.action === "adopt" ? task.can_capture_evidence : task.can_associate).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></>}
          {command.action === "adopt" && <fieldset className="mb-3"><legend>对应验收标准（至少一条）</legend>{targetTask?.criteria.map((criterion) => <label key={criterion.id} className="my-2 flex items-center gap-2"><input type="checkbox" disabled={busy} checked={command.criteria.includes(criterion.id)} onChange={(event) => setCommand({ ...command, criteria: event.target.checked ? [...command.criteria, criterion.id] : command.criteria.filter((id) => id !== criterion.id) })} />{criterion.text}</label>)}{!targetTask?.criteria.length && <p className="text-sm">所选任务暂无可用验收标准。</p>}</fieldset>}
          <label htmlFor="activity-reason">本次操作原因</label><textarea id="activity-reason" className={`${apiInput} mt-1 block w-full`} maxLength={2000} value={command.reason} disabled={busy} onChange={(event) => setCommand({ ...command, reason: event.target.value })} /><div className="mt-3 flex flex-wrap gap-2"><button className={apiButton} disabled={busy || !canChange} onClick={() => void submit()}>{busy ? "保存中…" : "确认操作"}</button><button className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>{versionFailure(operationError) && <button className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对状态</button>}</div>
        </Panel>}
        {operationError && <ApiFailure error={operationError} />}{notice && <p role="status" className="my-3">{notice}</p>}
      </>}
    </>}
  </>;
}
