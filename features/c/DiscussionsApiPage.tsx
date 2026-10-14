"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, apiButton, ApiFailure, apiInput, ApiPager, isUuid, pageNumber, projectApi, queryPolicy, useCommandKey, versionFailure } from "./c-project-api";

type Draft = { title: string; body: string; mentions: string[]; task_id: string; requirement_id: string; module_id: string; milestone_id: string };
const emptyDraft = (): Draft => ({ title: "", body: "", mentions: [], task_id: "", requirement_id: "", module_id: "", milestone_id: "" });
const links = [{ key: "task_id", field: "tasks", label: "关联任务" }, { key: "requirement_id", field: "requirements", label: "关联需求" }, { key: "module_id", field: "modules", label: "关联模块" }, { key: "milestone_id", field: "milestones", label: "关联里程碑" }] as const;
type Context = components["schemas"]["CProjectContextDTO"];

function MentionPicker({ context, value, change, disabled }: { context: Context; value: string[]; change: (value: string[]) => void; disabled: boolean }) {
  return <fieldset className="my-3"><legend>提及可访问本项目的人员（可选）</legend><div className="flex flex-wrap gap-4">{(context.mention_targets ?? []).map((member) => <label key={member.id} className="flex items-center gap-1"><input type="checkbox" checked={value.includes(member.id)} disabled={disabled} onChange={(event) => change(event.target.checked ? [...value, member.id] : value.filter((id) => id !== member.id))} />{member.title}</label>)}</div><p className="mt-2 text-xs text-slate-500">包含当前成员及所属教师、助教；提及会随内容保存，通知投递尚待通知服务接入。</p></fieldset>;
}
export function DiscussionsApiPage({ projectId, taskId, visible = true }: { projectId: string; taskId?: string; visible?: boolean }) {
  const { userId } = useWorkspace();
  return <DiscussionsPage key={`${userId}:${projectId}:${taskId ?? "all"}`} projectId={projectId} userId={userId} fixedTaskId={taskId} visible={visible} />;
}
function DiscussionsPage({ projectId, userId, fixedTaskId, visible }: { projectId: string; userId: string; fixedTaskId?: string; visible: boolean }) {
  const { query, updateQuery } = useUrlQuery();
  const selectedId = query.get("discussion");
  const replyFocus = isUuid(query.get("reply") ?? "") ? query.get("reply") : null;
  const filters = { page: pageNumber(query.get("page")), page_size: 10, q: query.get("q") || undefined, is_important: query.get("important") === "true" ? true : undefined, task_id: fixedTaskId ?? (query.get("task") || undefined), requirement_id: query.get("requirement") || undefined, module_id: query.get("module") || undefined, milestone_id: query.get("milestone") || undefined };
  const enabled = isUuid(projectId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const list = useQuery({ queryKey: ["c-discussions", userId, projectId, filters], queryFn: () => projectApi.discussions(projectId, filters), enabled, ...queryPolicy });
  const selectedEnabled = enabled && Boolean(selectedId && isUuid(selectedId)) && context.isSuccess && !context.isFetching;
  const detail = useQuery({ queryKey: ["c-discussion-detail", userId, projectId, selectedId], queryFn: () => projectApi.discussion(projectId, selectedId!), enabled: selectedEnabled, ...queryPolicy });
  const replies = useQuery({ queryKey: ["c-discussion-replies", userId, projectId, selectedId, pageNumber(query.get("reply_page")), replyFocus], queryFn: () => projectApi.replies(projectId, selectedId!, pageNumber(query.get("reply_page")), 10, replyFocus ?? undefined), enabled: selectedEnabled, ...queryPolicy });
  const [blocked, setBlocked] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reply, setReply] = useState<{ id: string; body: string; mentions: string[]; expected: number } | null>(null);
  const [important, setImportant] = useState<{ id: string; value: boolean; expected: number; reason: string } | null>(null);
  const [cancel, setCancel] = useState<"create" | "reply" | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const key = useCommandKey();
  const denial = blocked || [context.error, list.error, detail.error, replies.error].find(accessFailure);
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const rows = access && list.isSuccess && !list.isFetching ? list.data : undefined;
  const item = access && detail.isSuccess && !detail.isFetching && (!fixedTaskId || detail.data.task_id === fixedTaskId) ? detail.data : undefined;
  const replyRows = access && replies.isSuccess && !replies.isFetching && (!fixedTaskId || item) ? replies.data : undefined;
  const writable = Boolean(access?.permissions.can_discuss);
  const canMark = Boolean(writable && item && (access?.actor.id === item.author_id || access?.actor.is_leader || access?.actor.is_teacher));
  const author = (id: string) => access?.mention_targets?.find((member) => member.id === id)?.title ?? access?.members.find((member) => member.id === id)?.title ?? "项目讨论参与者";
  const focusTarget = visible && replyFocus && replyRows?.items.some((entry) => entry.id === replyFocus) ? `reply-${replyFocus}` : null;
  useEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget);
    element?.scrollIntoView({ block: "center" }); element?.focus({ preventScroll: true });
  }, [focusTarget]);
  function deny(next: unknown) { setBlocked(next); setDraft(null); setReply(null); setImportant(null); setCancel(null); }
  async function refresh() {
    const results = await Promise.all([context.refetch(), list.refetch(), ...(selectedId ? [detail.refetch(), replies.refetch()] : [])]);
    const denied = results.find((result) => accessFailure(result.error));
    if (denied) deny(denied.error); else if (results[0].isSuccess) setBlocked(null);
  }
  async function submit(action: "create" | "reply" | "important") {
    if (!writable || busyRef.current) return;
    if (action === "create" && (!draft?.title.trim() || !draft.body.trim())) { setNotice("请填写讨论标题和正文。"); return; }
    if (action === "reply" && (!reply?.body.trim() || item?.id !== reply.id || item.status !== "open")) { setNotice("请填写回复正文。"); return; }
    if (action === "important" && (!canMark || !important?.reason.trim() || item?.id !== important.id)) { setNotice("请填写重要标记的变更原因。"); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    try {
      if (action === "create" && draft) {
        const input = { expected_version: 0, title: draft.title.trim(), body: draft.body.trim(), mention_user_ids: draft.mentions, task_id: draft.task_id || null, requirement_id: draft.requirement_id || null, module_id: draft.module_id || null, milestone_id: draft.milestone_id || null };
        const saved = await projectApi.createDiscussion(projectId, input, key({ projectId, action, input })); setDraft(null); updateQuery({ discussion: saved.id, reply_page: null, reply: null });
      }
      if (action === "reply" && reply) {
        const input = { expected_version: reply.expected, body: reply.body.trim(), mention_user_ids: reply.mentions };
        const saved = await projectApi.reply(projectId, reply.id, input, key({ projectId, id: reply.id, action, input }));
        setReply(null); updateQuery({ reply: saved.reply.id, reply_page: null });
      }
      if (action === "important" && important) {
        const input = { expected_version: important.expected, is_important: important.value, reason: important.reason.trim() };
        await projectApi.markImportant(projectId, important.id, input, key({ projectId, id: important.id, action, input })); setImportant(null);
      }
      key.reset();
      setNotice("讨论变更已保存；通知投递不在本次完成范围内。"); await refresh();
    } catch (next) { setError(next); if (accessFailure(next)) deny(next); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reviewLatest() {
    const [latest, permission] = await Promise.all([detail.refetch(), context.refetch()]);
    const next = latest.error || permission.error;
    if (next) { setError(next); if (accessFailure(next)) deny(next); return; }
    if (latest.data) { if (reply) setReply({ ...reply, expected: latest.data.lock_version }); if (important) setImportant({ ...important, expected: latest.data.lock_version }); }
    setError(null); setNotice("已刷新讨论，请核对内容和状态后再次确认。");
  }
  if (!visible) return null;
  if (!enabled) return <EmptyState title="项目地址无效" />;
  return <>
    <PageHeader title="项目讨论" description={access?.project.name ?? "正在验证项目权限…"} actions={<button className={apiButton} disabled={busy || context.isFetching || list.isFetching} onClick={() => void refresh()}>刷新讨论</button>} />
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isFetching && <p role="status">正在验证项目权限…</p>}{context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
      {access && <>
        {!writable && <p className="mb-3">当前项目讨论只读。</p>}
        <form key={JSON.stringify(filters)} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const fields = Object.fromEntries(["q", "task", "requirement", "module", "milestone"].map((field) => [field, String(form.get(field) ?? "").trim() || null])); updateQuery({ ...fields, important: form.get("important") ? "true" : null, page: null, discussion: null, reply_page: null, reply: null }); }}>
          <label>搜索讨论<input className={`${apiInput} block`} name="q" maxLength={200} defaultValue={filters.q ?? ""} /></label>
          {links.map((link) => <label key={link.key}>{link.label}<select className={`${apiInput} block`} name={link.key.replace("_id", "")} disabled={Boolean(fixedTaskId && link.key === "task_id")} defaultValue={filters[link.key] ?? ""}><option value="">全部</option>{access[link.field].map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>)}
          <label><input name="important" type="checkbox" defaultChecked={filters.is_important} /> 仅重要讨论</label><button className={apiButton}>查询讨论</button><button className={apiButton} type="button" onClick={() => updateQuery({ q: null, task: null, requirement: null, module: null, milestone: null, important: null, page: null, discussion: null, reply_page: null, reply: null })}>重置</button>
        </form>
        {writable && !draft && <button className={`${apiButton} mb-4`} disabled={busy} onClick={() => { setDraft({ ...emptyDraft(), task_id: fixedTaskId ?? "" }); setError(null); }}>新建讨论</button>}
        {draft && writable && <Panel title="新建讨论"><label>讨论标题<input className={`${apiInput} block w-full`} maxLength={240} disabled={busy} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label htmlFor="discussion-body">讨论正文</label><textarea id="discussion-body" className={`${apiInput} block min-h-32 w-full`} maxLength={30000} disabled={busy} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /><div className="my-3 flex flex-wrap gap-3">{links.map((link) => <label key={link.key}>新讨论{link.label}<select className={`${apiInput} block`} value={draft[link.key]} disabled={busy || Boolean(fixedTaskId && link.key === "task_id")} onChange={(event) => setDraft({ ...draft, [link.key]: event.target.value })}><option value="">不关联</option>{access[link.field].map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>)}</div><MentionPicker context={access} value={draft.mentions} change={(mentions) => setDraft({ ...draft, mentions })} disabled={busy} /><button className={apiButton} disabled={busy} onClick={() => void submit("create")}>发布讨论</button><button className={`${apiButton} ml-2`} disabled={busy} onClick={() => setCancel("create")}>取消新讨论</button></Panel>}
        {list.isFetching && <p role="status">正在读取讨论…</p>}{list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}
        {rows && <Panel>{rows.items.map((entry) => <article key={entry.id} className="mb-3 border-b border-slate-100 pb-3"><strong>{entry.title}</strong><p className="my-2 text-sm">{entry.is_important ? "重要讨论 · " : ""}{author(entry.author_id)} · {entry.reply_count} 条回复 · {formatDate(entry.last_activity_at)}</p><button className={apiButton} disabled={busy} onClick={() => { updateQuery({ discussion: entry.id, reply_page: null, reply: null }); setImportant(null); setError(null); }}>查看讨论</button></article>)}{!rows.items.length && <EmptyState title="没有符合条件的讨论" />}<ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => updateQuery({ page: String(page), discussion: null, reply_page: null, reply: null })} /></Panel>}
        {selectedId && <Panel title="讨论内容与回复" action={<button className={apiButton} disabled={busy} onClick={() => updateQuery({ discussion: null, reply_page: null, reply: null })}>关闭详情</button>}>
          {detail.isFetching && <p role="status">正在读取讨论内容…</p>}{detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} />}
          {item && <><h2 className="font-semibold">{item.title}</h2><p className="my-3 whitespace-pre-wrap">{item.body}</p>{links.map((link) => item[link.key] && <p key={link.key}>{link.label}：{access[link.field].find((entry) => entry.id === item[link.key])?.title ?? "历史关联对象"}</p>)}<p className="my-2 text-sm">提及：{item.mention_user_ids.map(author).join("、") || "无"}</p>{item.is_important && <p className="my-3 text-sm">此讨论可选择为候选证据来源。新增回复或取消重要标记会使已有证据来源发生变化，原快照保留。</p>}
            <div className="my-3 flex gap-2">{writable && item.status === "open" && !reply && <button className={apiButton} disabled={busy} onClick={() => { setReply({ id: item.id, body: "", mentions: [], expected: item.lock_version }); setError(null); }}>回复讨论</button>}{canMark && item.status === "open" && <button className={apiButton} disabled={busy} onClick={() => { setImportant({ id: item.id, value: !item.is_important, reason: "", expected: item.lock_version }); setError(null); }}>{item.is_important ? "取消重要标记" : "标记为重要"}</button>}</div></>}
          {replies.isFetching && <p role="status">正在读取回复…</p>}{replies.isError && <ApiFailure error={replies.error} retry={() => void replies.refetch()} />}{replyRows && <>{replyRows.items.map((entry) => <article id={`reply-${entry.id}`} tabIndex={-1} key={entry.id} className={`my-3 border-l-2 pl-3 ${replyFocus === entry.id ? "border-blue-500 bg-blue-50" : "border-slate-200"}`}><p className="text-sm">{author(entry.author_id)} · {formatDate(entry.created_at)}</p><p className="my-2 whitespace-pre-wrap">{entry.body}</p>{entry.mention_user_ids.length > 0 && <p className="text-sm">提及：{entry.mention_user_ids.map(author).join("、")}</p>}</article>)}{!replyRows.items.length && <p>暂无回复。</p>}<ApiPager page={replyRows.page} pageSize={replyRows.page_size} total={replyRows.total} change={(page) => updateQuery({ reply_page: String(page), reply: null })} /></>}
        </Panel>}
        {reply && reply.id === selectedId && writable && item?.status === "open" && <Panel title="回复讨论"><label htmlFor="discussion-reply">回复正文</label><textarea id="discussion-reply" className={`${apiInput} block min-h-32 w-full`} disabled={busy} maxLength={30000} value={reply.body} onChange={(event) => setReply({ ...reply, body: event.target.value })} /><MentionPicker context={access} value={reply.mentions} change={(mentions) => setReply({ ...reply, mentions })} disabled={busy} /><button className={apiButton} disabled={busy} onClick={() => void submit("reply")}>保存回复</button><button className={`${apiButton} ml-2`} disabled={busy} onClick={() => setCancel("reply")}>取消回复</button></Panel>}
        {important && important.id === selectedId && canMark && <Panel title={important.value ? "确认标记重要" : "确认取消重要"}><p className="mb-3 text-sm">{important.value ? "标记后可从证据页选择此讨论作为候选来源。" : "取消后不能再作为新的候选来源；旧证据快照不会删除。"}</p><label htmlFor="important-reason">重要标记原因</label><textarea id="important-reason" className={`${apiInput} block w-full`} disabled={busy} maxLength={4000} value={important.reason} onChange={(event) => setImportant({ ...important, reason: event.target.value })} /><div className="mt-3 flex gap-2"><button className={apiButton} disabled={busy} onClick={() => void submit("important")}>确认重要标记变更</button><button className={apiButton} disabled={busy} onClick={() => setImportant(null)}>取消</button></div></Panel>}
        {cancel && <Panel title="放弃未保存内容？"><p className="mb-3">取消后本次尚未保存的输入会丢失。</p><button className={apiButton} disabled={busy} onClick={() => { if (cancel === "create") setDraft(null); else setReply(null); setCancel(null); }}>确认放弃编辑</button><button className={`${apiButton} ml-2`} onClick={() => setCancel(null)}>继续编辑</button></Panel>}
        {error && <ApiFailure error={error} />}{versionFailure(error) && <button className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对讨论</button>}{notice && <p role="status" className="my-3">{notice}</p>}
      </>}
    </>}
  </>;
}
