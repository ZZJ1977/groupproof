"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { CApiError } from "@/lib/api/c-client";
import { inboxApi, inboxTargetHref, type ActionItemQuery, type NotificationQuery } from "@/lib/api/c-inbox-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiPager, apiButton, apiInput, pageNumber, queryPolicy, useCommandKey, versionFailure } from "./c-project-api";

type Schema = components["schemas"];
const states = { all: "全部通知", unread: "未读", read: "已读" } as const;
const categories = { all: "全部类别", project: "项目", course: "课程", system: "系统" } as const;
const actionStatuses = { pending: "待处理", completed: "已完成", rejected: "已拒绝", all: "全部状态" } as const;
const actionCategories = { all: "全部类型", task: "任务", verification: "验收", evidence: "证据", rule: "规则", appeal: "申诉", member: "成员变更", course: "课程" } as const;

function InboxFailure({ error, retry }: { error: unknown; retry?: () => void }) {
  const text = accessFailure(error) ? "当前身份无权读取通知或待办，原有数据已隐藏。请重新登录后重试。"
    : versionFailure(error) ? "通知列表已变化，请刷新并核对后重试；尚未更改页面中的已读状态。"
      : error instanceof CApiError && error.status === 503 ? "通知或待办服务暂不可用，未更改页面中的已读状态。请稍后重试。"
        : "请求未成功，请重试。";
  return <div role="alert" className="my-3 rounded-md border border-red-200 p-3"><p>{text}</p>{retry && <button type="button" className={`${apiButton} mt-2`} onClick={retry}>重试</button>}</div>;
}

export function NotificationsApiPage() {
  const { userId } = useWorkspace();
  return <Notifications key={userId} userId={userId} />;
}

function Notifications({ userId }: { userId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const rawState = query.get("state") ?? "all", rawCategory = query.get("category") ?? "all";
  const filters: NotificationQuery = { state: Object.hasOwn(states, rawState) ? rawState as keyof typeof states : "all",
    category: Object.hasOwn(categories, rawCategory) ? rawCategory as keyof typeof categories : "all", page: pageNumber(query.get("page")), page_size: 10 };
  const list = useQuery({ queryKey: ["c-inbox-notifications", userId, filters], queryFn: () => inboxApi.notifications(filters), ...queryPolicy });
  const [error, setError] = useState<unknown>(null), [blocked, setBlocked] = useState<unknown>(null);
  const [all, setAll] = useState<Schema["MarkAllNotificationsRead"] | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const lock = useRef(false), commandKey = useCommandKey();
  const denied = blocked || (accessFailure(list.error) ? list.error : null);
  const data = !denied && list.isSuccess && !list.isFetching ? list.data : undefined;

  async function refresh() {
    setAll(null); setNotice("");
    const response = await list.refetch();
    if (response.isSuccess) { setError(null); setBlocked(null); }
    else if (accessFailure(response.error)) { setBlocked(response.error); setAll(null); }
  }
  async function mark(item?: Schema["NotificationDTO"]) {
    if (!data || lock.current || versionFailure(error) || (!item && !all)) return;
    lock.current = true; setBusy(true); setError(null); setNotice("");
    const body = item ? { expected_version: item.lock_version, expected_inbox_version: data.inbox_version, snapshot_id: data.snapshot_id } : all!;
    const key = commandKey({ operation: item ? "single" : "all", id: item?.id, body });
    try {
      if (item) await inboxApi.markRead(item.id, body as Schema["MarkNotificationRead"], key);
      else await inboxApi.markAllRead(body, key);
      setAll(null); setNotice(item ? "该通知已标记为已读。" : "此快照中的全部通知已标记为已读。");
      const response = await list.refetch();
      if (accessFailure(response.error)) setBlocked(response.error);
    } catch (failure) { setError(failure); if (accessFailure(failure)) { setBlocked(failure); setAll(null); } }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <PageHeader title="通知" description="通知内容和已读状态来自当前账号的通知服务。" actions={<button type="button" className={apiButton} disabled={busy || list.isFetching} onClick={() => void refresh()}>刷新通知</button>} />
    {denied ? <InboxFailure error={denied} retry={() => void refresh()} /> : <>
      <form key={`${rawState}:${rawCategory}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (busy) return; const form = new FormData(event.currentTarget); setAll(null); updateQuery({ state: String(form.get("state")), category: String(form.get("category")), page: null }); }}>
        <label>阅读状态<select name="state" className={`${apiInput} block`} defaultValue={filters.state}>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>通知类别<select name="category" className={`${apiInput} block`} defaultValue={filters.category}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="submit" className={apiButton} disabled={busy}>筛选通知</button>
      </form>
      {list.isFetching && <p role="status">正在读取通知…</p>}{list.isError && <InboxFailure error={list.error} retry={() => void refresh()} />}
      {data && <Panel><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p>全部通知 {data.total_all} 条 · 未读 {data.unread_total} 条</p><button type="button" className={apiButton} disabled={busy || data.unread_total === 0 || versionFailure(error)} onClick={() => setAll({ expected_inbox_version: data.inbox_version, snapshot_id: data.snapshot_id })}>全部标为已读</button></div>
        <div aria-label="通知列表" className="space-y-3">{data.items.map((item) => { const href = inboxTargetHref(item.target); return <article key={item.id} className="rounded border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><strong>{item.title}</strong><span>{item.read_at ? "已读" : "未读"}</span></div><p className="my-2 text-sm">{item.description}</p><p className="mb-2 text-xs text-slate-500">{categories[item.category]} · {formatDate(item.created_at)}</p><div className="flex gap-3">{href && <Link className="gp-link" href={href}>查看相关内容</Link>}{!item.read_at && <button type="button" className={apiButton} disabled={busy || versionFailure(error)} onClick={() => void mark(item)}>标为已读</button>}</div></article>; })}</div>
        {!data.items.length && <EmptyState title="没有符合条件的通知" />}<ApiPager page={data.page} pageSize={data.page_size} total={data.total} change={(page) => { if (!busy) { setAll(null); updateQuery({ page: String(page) }); } }} />
      </Panel>}
      {all && <Panel title="确认全部标为已读" className="mt-4"><p className="mb-3">将当前快照中全部类别、所有分页的未读通知标记为已读。若有新通知或状态变化，需刷新后重新确认。</p><div className="flex gap-3"><button type="button" className={apiButton} disabled={busy || !data || versionFailure(error)} onClick={() => void mark()}>确认全部已读</button><button type="button" className={apiButton} disabled={busy} onClick={() => setAll(null)}>取消</button></div></Panel>}
      {Boolean(error) && <InboxFailure error={error} />}{notice && <p role="status" className="my-3">{notice}</p>}
    </>}
  </>;
}

export function ActionItemsApiPage() {
  const { userId } = useWorkspace();
  return <ActionItems key={userId} userId={userId} />;
}

function ActionItems({ userId }: { userId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const rawStatus = query.get("status") ?? "pending", rawCategory = query.get("category") ?? "all";
  const filters: ActionItemQuery = { status: Object.hasOwn(actionStatuses, rawStatus) ? rawStatus as keyof typeof actionStatuses : "pending",
    category: Object.hasOwn(actionCategories, rawCategory) ? rawCategory as keyof typeof actionCategories : "all", page: pageNumber(query.get("page")), page_size: 10 };
  const list = useQuery({ queryKey: ["c-inbox-actions", userId, filters], queryFn: () => inboxApi.actionItems(filters), ...queryPolicy });
  const data = list.isSuccess && !list.isFetching ? list.data : undefined;
  return <>
    <PageHeader title="待处理事项" description="前往事项对应的业务流程处理，处理结果由原业务决定。" actions={<button className={apiButton} type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>刷新待办</button>} />
    <form key={`${rawStatus}:${rawCategory}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); updateQuery({ status: String(form.get("status")), category: String(form.get("category")), page: null }); }}>
      <label>待办状态<select className={`${apiInput} block`} name="status" defaultValue={filters.status}>{Object.entries(actionStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>待办类型<select className={`${apiInput} block`} name="category" defaultValue={filters.category}>{Object.entries(actionCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button type="submit" className={apiButton}>筛选待办</button>
    </form>
    {list.isFetching && <p role="status">正在读取待办…</p>}{list.isError && <InboxFailure error={list.error} retry={() => void list.refetch()} />}
    {data && <Panel><div className="space-y-3" aria-label="待办列表">{data.items.map((item) => { const href = inboxTargetHref(item.target); return <article className="rounded border border-slate-200 p-3" key={item.id}><div className="flex flex-wrap justify-between gap-2"><strong>{item.title}</strong><span>{actionStatuses[item.status]}</span></div><p className="my-2 text-sm">{item.description}</p><p className="mb-2 text-xs text-slate-500">{actionCategories[item.category]} · {item.due_at ? `截止 ${formatDate(item.due_at)}` : "未设截止时间"}</p>{href ? <Link className="gp-link" href={href}>前往处理页面</Link> : <span className="text-sm">处理入口暂不可用</span>}</article>; })}</div>{!data.items.length && <EmptyState title="没有符合条件的待办" />}<ApiPager page={data.page} pageSize={data.page_size} total={data.total} change={(page) => updateQuery({ page: String(page) })} /></Panel>}
  </>;
}
