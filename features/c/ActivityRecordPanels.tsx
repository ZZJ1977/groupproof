"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Panel, StatusBadge } from "@/components/common";
import { apiMode } from "@/lib/api/config";
import { can } from "@/lib/access/policy";
import { workspaceService } from "@/lib/api/workspace-service";
import { createCommandRunner, type Command } from "@/lib/commands/core";
import { scopedWorkspaceKey, useWorkspace } from "@/lib/workspace";
import type { FeishuRecord, GithubActivity, MockData } from "@/types/domain";
import { activityHistory, activityVersion, canManageActivity, decideFeishuRecord, feishuActivityFilters, githubActivityFilters, githubTaskSuggestions, linkGithubActivity, queryFeishuActivities, queryGithubActivities, type FeishuDecisionInput } from "./activity-records";
import { GithubActivityLink } from "./github-activity-link";
import { useUrlQuery } from "./use-url-query";

const field = "w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-50";
const button = "inline-flex min-h-9 items-center justify-center rounded border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-blue-600 bg-blue-600 font-medium text-white hover:bg-blue-700`;
const link = "text-sm font-medium text-[var(--gp-action)] hover:underline disabled:cursor-not-allowed disabled:opacity-50";
const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const member = (data: MockData, userId: string) => data.users.find((item) => item.id === userId)?.name ?? userId;
const taskHref = (projectId: string, taskId: string) => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

function useActivityCommands(projectId: string) {
  const { data, userId } = useWorkspace();
  const queryClient = useQueryClient();
  const key = useMemo(() => scopedWorkspaceKey(userId), [userId]);
  const runner = useMemo(() => createCommandRunner({
    repository: { read: async () => queryClient.getQueryData<MockData>(key) ?? await workspaceService.getWorkspace(), save: workspaceService.saveWorkspace },
    currentActorId: () => queryClient.getQueryData<MockData>(key)?.currentUserId ?? "",
    onSaved: (next) => queryClient.setQueryData(key, next),
  }), [queryClient, key]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const local = apiMode("workspace") === "mock";
  const readable = can(data, data.currentUserId, "project.content.read", { kind: "project", id: projectId });
  const writable = local && canManageActivity(data, data.currentUserId, projectId);
  async function perform<I, O>(command: Command<I, O>, input: I) {
    if (!writable || busy.current) return null;
    busy.current = true; setSaving(true);
    try {
      const result = await runner(command, input);
      if (!result.ok) setNotice(result.error.message);
      return result;
    } catch {
      setNotice("保存失败，输入已保留，请重试。");
      return null;
    } finally { busy.current = false; setSaving(false); }
  }
  return { data, perform, readable, writable, local, saving, notice, setNotice };
}

function subscribeToAnchor(listener: () => void) {
  window.addEventListener("hashchange", listener); window.addEventListener("popstate", listener);
  return () => { window.removeEventListener("hashchange", listener); window.removeEventListener("popstate", listener); };
}
function readAnchor() { try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ""; } }
const serverAnchor = () => "";
/** Existing evidence deep links must still resolve when the source is on another page. */
function AnchoredRecord({ records, visibleIds, data }: { records: (GithubActivity | FeishuRecord)[]; visibleIds: string[]; data: MockData }) {
  const anchor = useSyncExternalStore(subscribeToAnchor, readAnchor, serverAnchor);
  const record = records.find((item) => item.id === anchor && !visibleIds.includes(item.id));
  return record ? <Panel title="定位到原始记录"><div id={record.id} aria-label="定位原始记录"><p className="mb-2 text-xs text-slate-500">这条记录位于其他分页或筛选范围，以下保留当前原记录供核对。</p>{"summary" in record ? <p className="whitespace-pre-wrap text-sm">{record.summary}</p> : <GithubActivityLink url={record.url} title={record.title} className={link} />}<p className="mt-2 text-xs text-slate-500">{member(data, record.authorId)} · {record.timestamp}</p><RecordHistory record={record} data={data} /></div></Panel> : null;
}

function RecordHistory({ record, data }: { record: GithubActivity | FeishuRecord; data: MockData }) {
  const history = activityHistory(record);
  return history.length ? <details className="mt-1 text-xs text-slate-500"><summary>处理历史（{history.length}）</summary>{history.map((entry) => <p className="mt-1" key={entry.idempotencyKey}>{member(data, entry.actorId)} · {entry.at.slice(0, 10)} · {({ link: "调整关联", adopt: "采纳为候选", ignore: "忽略", restore: "恢复" })[entry.action]}：{entry.reason}</p>)}</details> : null;
}
function Pagination({ result, update, name }: { result: { page: number; totalPages: number; total: number }; update: (page: string) => void; name: string }) {
  return <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-4 text-sm" aria-label={`${name}分页`}>
    <span>第 {result.page} / {result.totalPages} 页 · {result.total} 条</span>
    <div className="flex gap-2"><button className={button} onClick={() => update(String(result.page - 1))} disabled={result.page <= 1}>上一页</button><button className={button} onClick={() => update(String(result.page + 1))} disabled={result.page >= result.totalPages}>下一页</button></div>
  </nav>;
}
function Boundary({ local }: { local: boolean }) {
  return <p className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-slate-600">{local ? "记录处理使用浏览器本地演示数据；真实 GitHub / 飞书来源与同步 API 尚未接入。" : "真实记录处理服务尚未接入，此记录区只读。"}</p>;
}

export function GithubRecordPanels({ projectId }: { projectId: string }) {
  const { data, perform, readable, writable, local, saving, notice, setNotice } = useActivityCommands(projectId);
  const { query, updateQuery } = useUrlQuery();
  const filters = githubActivityFilters(query);
  const result = queryGithubActivities(data, projectId, filters);
  const records = readable ? data.github.filter((item) => item.projectId === projectId) : [];
  const tasks = readable ? data.tasks.filter((item) => item.projectId === projectId) : [];
  const authors = [...new Set(records.map((item) => item.authorId))];
  const [selection, setSelection] = useState<{ recordId: string; expectedVersion: number; idempotencyKey: string } | null>(null);
  const [taskId, setTaskId] = useState("");
  const [reason, setReason] = useState("");
  const selected = records.find((item) => item.id === selection?.recordId);
  const suggestions = selected ? githubTaskSuggestions(data, selected) : [];
  const setFilter = (key: string, value: string) => updateQuery({ [key]: value === "all" ? null : value, page: null });
  const open = (record: GithubActivity) => {
    if (saving || selection?.recordId === record.id) return;
    if (reason.trim() && !window.confirm("放弃尚未保存的任务关联修改？")) return;
    setSelection({ recordId: record.id, expectedVersion: activityVersion(record), idempotencyKey: makeId("github-link") });
    setTaskId(record.taskId ?? ""); setReason(""); setNotice("");
  };
  const save = async () => {
    if (!selected || !selection) return;
    const outcome = await perform(linkGithubActivity, { projectId, recordId: selected.id, taskId: taskId || null, reason, expectedVersion: selection.expectedVersion, idempotencyKey: selection.idempotencyKey });
    if (outcome?.ok) { setSelection(null); setReason(""); setNotice("任务关联已保存到本地记录；没有修改 GitHub、任务进度或验收结果。"); }
  };
  return <>
    <Boundary local={local} />
    <AnchoredRecord records={records} visibleIds={result.items.map((item) => item.id)} data={data} />
    {notice && <p role="status" className="rounded border border-blue-200 bg-blue-50 p-3 text-sm">{notice}</p>}
    <Panel title="最近开发活动" noPadding>
      <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
        <input className={`${field} max-w-64`} aria-label="搜索 GitHub 活动" placeholder="搜索标题、仓库或作者" value={filters.q} onChange={(event) => setFilter("q", event.target.value)} />
        <select className={`${field} w-auto`} aria-label="活动类型" value={filters.kind} onChange={(event) => setFilter("kind", event.target.value)}><option value="all">全部类型</option><option value="commit">Commit</option><option value="pr">PR</option><option value="ci">CI</option><option value="sync">同步</option></select>
        <select className={`${field} w-auto`} aria-label="活动时间" value={filters.days} onChange={(event) => setFilter("days", event.target.value)}><option value="all">全部时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select>
        <select className={`${field} w-auto`} aria-label="GitHub 活动作者" value={filters.author} onChange={(event) => setFilter("author", event.target.value)}><option value="all">全部作者</option>{filters.author !== "all" && !authors.includes(filters.author) && <option value={filters.author}>不可用的作者</option>}{authors.map((userId) => <option key={userId} value={userId}>{member(data, userId)}</option>)}</select>
        <select className={`${field} max-w-64`} aria-label="GitHub 关联任务筛选" value={filters.task} onChange={(event) => setFilter("task", event.target.value)}><option value="all">全部任务</option><option value="unlinked">未关联任务</option>{!["all", "unlinked"].includes(filters.task) && !tasks.some((task) => task.id === filters.task) && <option value={filters.task}>不可用的任务</option>}{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
        <button className={button} onClick={() => updateQuery({ kind: null, days: null, author: null, task: null, q: null, page: null })}>清除活动筛选</button>
      </div>
      <div className="overflow-x-auto"><table className="gp-table min-w-[800px]"><thead><tr><th>时间</th><th>类型</th><th>标题</th><th>作者</th><th>关联任务</th><th>状态</th><th>操作</th></tr></thead><tbody>{result.items.map((record) => <tr key={record.id} id={record.id}>
        <td>{record.timestamp.slice(0, 10)}</td><td className="uppercase">{record.type}</td><td><GithubActivityLink url={record.url} title={record.title} className={link} /><RecordHistory record={record} data={data} /></td><td>{member(data, record.authorId)}</td>
        <td>{record.taskId ? <Link className={link} href={taskHref(projectId, record.taskId)}>{tasks.find((task) => task.id === record.taskId)?.title ?? "关联任务已不可用"}</Link> : "—"}</td><td><StatusBadge tone={record.status.includes("失败") ? "red" : "green"} label={record.status} /></td>
        <td>{record.type !== "sync" && writable && <button className={link} disabled={saving} onClick={() => open(record)}>关联任务</button>}</td>
      </tr>)}</tbody></table>{!result.total && <p className="p-6 text-center text-sm text-slate-500">没有符合条件的活动</p>}</div>
      <Pagination result={result} name="GitHub 活动" update={(page) => updateQuery({ page })} />
    </Panel>
    {selected && selection && <Panel title="调整 GitHub 任务关联">
      <p className="mb-3 text-sm font-medium">{selected.title}</p>
      <label className="block text-sm">关联 GitHub 任务<select className={`${field} mt-1`} aria-label="关联 GitHub 任务" value={taskId} disabled={saving || !writable} onChange={(event) => setTaskId(event.target.value)}><option value="">不关联任务</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <div className="my-3 text-xs text-slate-500">{suggestions.length ? <><p>从活动标题中的明确任务编号找到以下建议，请核对后选择：</p>{suggestions.map((task) => <button className={`${button} mr-2 mt-2`} key={task.id} disabled={saving || !writable} onClick={() => setTaskId(task.id)}>按编号选择：{task.title}</button>)}</> : "标题没有唯一对应的项目任务编号，请手动选择。"}</div>
      <label className="block text-sm">关联原因<textarea className={`${field} mt-1 min-h-20`} aria-label="GitHub 关联原因" value={reason} maxLength={2000} disabled={saving || !writable} onChange={(event) => setReason(event.target.value)} /></label>
      {activityVersion(selected) !== selection.expectedVersion && <button className={`${button} mt-2`} disabled={saving} onClick={() => setSelection({ ...selection, expectedVersion: activityVersion(selected), idempotencyKey: makeId("github-link") })}>已核对当前版本，保留输入</button>}
      <div className="mt-3 flex gap-2"><button className={button} disabled={saving} onClick={() => { if (!reason.trim() || window.confirm("放弃尚未保存的任务关联修改？")) { setSelection(null); setReason(""); } }}>取消关联修改</button><button className={primary} disabled={saving || !writable || !reason.trim() || activityVersion(selected) !== selection.expectedVersion || taskId === (selected.taskId ?? "")} onClick={() => void save()}>保存任务关联</button></div>
    </Panel>}
    <Panel title="任务关联映射"><p className="text-sm text-slate-500">当前项目共有 {records.filter((record) => record.type !== "sync" && record.taskId).length} 条已关联活动。使用“关联任务筛选”查看完整映射，修改保留处理历史。</p><Link className={`${link} mt-2 inline-block`} href={`/projects/${encodeURIComponent(projectId)}/tasks?view=list`}>查看项目任务</Link></Panel>
  </>;
}

export function FeishuRecordPanel({ projectId }: { projectId: string }) {
  const { data, perform, readable, writable, local, saving, notice, setNotice } = useActivityCommands(projectId);
  const { query, updateQuery } = useUrlQuery();
  const filters = feishuActivityFilters(query);
  const result = queryFeishuActivities(data, projectId, filters);
  const records = readable ? data.feishu.filter((record) => record.projectId === projectId) : [];
  const tasks = readable ? data.tasks.filter((task) => task.projectId === projectId) : [];
  const eligibleTasks = tasks.filter((task) => task.status === "in_progress" || task.status === "pending_submission");
  const authors = [...new Set(records.map((record) => record.authorId))];
  const [selection, setSelection] = useState<{ recordId: string; action: FeishuDecisionInput["action"]; expectedVersion: number; idempotencyKey: string; evidenceId: string } | null>(null);
  const [taskId, setTaskId] = useState("");
  const [criterionIds, setCriterionIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const selected = records.find((record) => record.id === selection?.recordId);
  const criteria = data.criteria.filter((criterion) => criterion.taskId === taskId);
  const setFilter = (key: string, value: string) => updateQuery({ [key]: value === "all" ? null : value, page: null });
  const open = (record: FeishuRecord, action: FeishuDecisionInput["action"]) => {
    if (saving || (selection?.recordId === record.id && selection.action === action)) return;
    if (reason.trim() && !window.confirm("放弃尚未保存的飞书记录处理？")) return;
    setSelection({ recordId: record.id, action, expectedVersion: activityVersion(record), idempotencyKey: makeId("feishu-decision"), evidenceId: makeId("evidence") });
    setTaskId(eligibleTasks.some((task) => task.id === record.taskId) ? record.taskId! : ""); setCriterionIds([]); setReason(""); setNotice("");
  };
  const save = async () => {
    if (!selected || !selection) return;
    const common = { projectId, recordId: selected.id, reason, expectedVersion: selection.expectedVersion, idempotencyKey: selection.idempotencyKey };
    const input: FeishuDecisionInput = selection.action === "adopt" ? { ...common, action: "adopt", taskId, criterionIds, evidenceId: selection.evidenceId } : { ...common, action: selection.action };
    const outcome = await perform(decideFeishuRecord, input);
    if (outcome?.ok) {
      setNotice(selection.action === "adopt" ? "记录已采纳并生成本地候选证据，尚未成为正式证据；真实来源服务未接入。" : selection.action === "ignore" ? "记录已在本地忽略，可填写原因恢复为待确认。" : "记录已在本地恢复为待确认，未创建或采纳证据。");
      setSelection(null); setReason(""); setCriterionIds([]);
    }
  };
  return <>
    <Boundary local={local} />
    <AnchoredRecord records={records} visibleIds={result.items.map((item) => item.id)} data={data} />
    {notice && <p role="status" className="rounded border border-blue-200 bg-blue-50 p-3 text-sm">{notice}</p>}
    <Panel title={`协作记录（${result.total} 条）`} noPadding>
      <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
        <input className={`${field} max-w-64`} aria-label="搜索飞书记录" placeholder="搜索内容、群组或作者" value={filters.q} onChange={(event) => setFilter("q", event.target.value)} />
        <select className={`${field} w-auto`} aria-label="飞书记录作者" value={filters.author} onChange={(event) => setFilter("author", event.target.value)}><option value="all">全部作者</option>{filters.author !== "all" && !authors.includes(filters.author) && <option value={filters.author}>不可用的作者</option>}{authors.map((userId) => <option key={userId} value={userId}>{member(data, userId)}</option>)}</select>
        <select className={`${field} max-w-64`} aria-label="飞书关联任务筛选" value={filters.task} onChange={(event) => setFilter("task", event.target.value)}><option value="all">全部任务</option><option value="unlinked">未关联任务</option>{!["all", "unlinked"].includes(filters.task) && !tasks.some((task) => task.id === filters.task) && <option value={filters.task}>不可用的任务</option>}{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
        <button className={button} onClick={() => updateQuery({ group: null, status: null, author: null, task: null, q: null, page: null })}>清除记录筛选</button>
      </div>
      <div className="overflow-x-auto"><table className="gp-table min-w-[820px]"><thead><tr><th>时间</th><th>群组</th><th>类型</th><th>记录内容</th><th>相关成员</th><th>状态</th><th>操作</th></tr></thead><tbody>{result.items.map((record) => <tr key={record.id} id={record.id}>
        <td>{record.timestamp.slice(0, 10)}</td><td>{record.groupName}</td><td>{{ decision: "决策", task: "任务", discussion: "讨论" }[record.type]}</td><td><p className="max-w-sm">{record.summary}</p><RecordHistory record={record} data={data} /></td><td>{member(data, record.authorId)}</td><td><StatusBadge tone={record.status === "candidate" ? "amber" : record.status === "adopted" ? "green" : "gray"} label={{ candidate: "待确认", adopted: "已采纳", ignored: "已忽略" }[record.status]} /></td>
        <td><div className="flex flex-wrap gap-2">{writable && record.status === "candidate" && <><button className={link} disabled={saving} onClick={() => open(record, "adopt")}>采纳记录</button><button className={link} disabled={saving} onClick={() => open(record, "ignore")}>忽略记录</button></>}{writable && record.status === "ignored" && <button className={link} disabled={saving} onClick={() => open(record, "restore")}>恢复待确认</button>}{record.taskId && <Link className={link} href={taskHref(projectId, record.taskId)}>任务</Link>}{activityHistory(record).some((entry) => entry.evidenceId) && <Link className={link} href={`/projects/${encodeURIComponent(projectId)}/evidence?source=feishu&task=${encodeURIComponent(record.taskId ?? "")}`}>查看候选</Link>}</div></td>
      </tr>)}</tbody></table>{!result.total && <p className="p-6 text-center text-sm text-slate-500">暂无符合条件的协作记录</p>}</div>
      <Pagination result={result} name="飞书记录" update={(page) => updateQuery({ page })} />
    </Panel>
    {selected && selection && <Panel title={selection.action === "adopt" ? "采纳飞书记录为候选" : selection.action === "ignore" ? "忽略飞书记录" : "恢复飞书记录"}>
      <p className="mb-3 text-sm">{selected.summary}</p>
      {selection.action === "adopt" && <><p className="mb-3 text-xs text-slate-500">选择任务与验收标准后保存当前记录快照；正式采纳仍需在证据中心确认。</p><label className="block text-sm">飞书候选关联任务<select className={`${field} mt-1`} aria-label="飞书候选关联任务" value={taskId} disabled={saving || !writable} onChange={(event) => { setTaskId(event.target.value); setCriterionIds([]); }}><option value="">选择进行中或待提交的任务</option>{eligibleTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><div className="my-3 space-y-2">{criteria.map((criterion, index) => <label key={criterion.id} className="flex gap-2 text-sm"><input type="checkbox" checked={criterionIds.includes(criterion.id)} disabled={saving || !writable} onChange={(event) => setCriterionIds((old) => event.target.checked ? [...old, criterion.id] : old.filter((value) => value !== criterion.id))} /><span>AC-{index + 1} · {criterion.text}</span></label>)}</div></>}
      <label className="block text-sm">记录处理原因<textarea className={`${field} mt-1 min-h-20`} aria-label="记录处理原因" value={reason} maxLength={2000} disabled={saving || !writable} onChange={(event) => setReason(event.target.value)} /></label>
      {activityVersion(selected) !== selection.expectedVersion && <button className={`${button} mt-2`} disabled={saving} onClick={() => setSelection({ ...selection, expectedVersion: activityVersion(selected), idempotencyKey: makeId("feishu-decision"), evidenceId: makeId("evidence") })}>已核对当前版本，保留输入</button>}
      <div className="mt-3 flex gap-2"><button className={button} disabled={saving} onClick={() => { if (!reason.trim() || window.confirm("放弃尚未保存的飞书记录处理？")) { setSelection(null); setReason(""); } }}>取消记录处理</button><button className={primary} disabled={saving || !writable || !reason.trim() || activityVersion(selected) !== selection.expectedVersion || (selection.action === "adopt" && (!taskId || !criterionIds.length))} onClick={() => void save()}>{selection.action === "adopt" ? "确认采纳记录" : selection.action === "ignore" ? "确认忽略" : "确认恢复"}</button></div>
    </Panel>}
  </>;
}
