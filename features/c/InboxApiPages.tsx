"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { CApiError } from "@/lib/api/c-client";
import { inboxApi, inboxTargetHref, type ActionItemQuery, type NotificationQuery } from "@/lib/api/c-inbox-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiPager, apiButton, apiInput, pageNumber, queryPolicy, useCommandKey, versionFailure } from "./c-project-api";

type Schema = components["schemas"];
// Values are message keys under pages.inbox.*; labels come from the active locale.
const states = { all: "all", unread: "unread", read: "read" } as const;
const categories = { all: "all", project: "project", course: "course", system: "system" } as const;
const actionStatuses = { pending: "pending", completed: "completed", rejected: "rejected", all: "all" } as const;
const actionCategories = { all: "all", task: "task", verification: "verification", evidence: "evidence", rule: "rule", appeal: "appeal", member: "member", course: "course" } as const;

function InboxFailure({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useTranslations("pages.inbox");
  const ts = useTranslations("pages.shared");
  const text = accessFailure(error) ? t("failAccess")
    : versionFailure(error) ? t("failVersion")
      : error instanceof CApiError && error.status === 503 ? t("failUnavailable")
        : t("failDefault");
  return <div role="alert" className="my-3 rounded-md border border-red-200 p-3"><p>{text}</p>{retry && <button type="button" className={`${apiButton} mt-2`} onClick={retry}>{ts("retry")}</button>}</div>;
}

export function NotificationsApiPage() {
  const { userId } = useWorkspace();
  return <Notifications key={userId} userId={userId} />;
}

function Notifications({ userId }: { userId: string }) {
  const t = useTranslations("pages.inbox");
  const cache = useQueryClient();
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
  function block(failure: unknown) {
    setBlocked(failure); setAll(null);
    cache.setQueryData(["c-inbox-blocked", userId], true);
  }

  async function refresh() {
    setAll(null); setNotice("");
    void cache.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
    const response = await list.refetch();
    if (response.isSuccess) { setError(null); setBlocked(null); cache.setQueryData(["c-inbox-blocked", userId], false); }
    else if (accessFailure(response.error)) block(response.error);
  }
  async function mark(item?: Schema["NotificationDTO"]) {
    if (!data || lock.current || versionFailure(error) || (!item && !all)) return;
    lock.current = true; setBusy(true); setError(null); setNotice("");
    const body = item ? { expected_version: item.lock_version, expected_inbox_version: data.inbox_version, snapshot_id: data.snapshot_id } : all!;
    const key = commandKey({ operation: item ? "single" : "all", id: item?.id, body });
    try {
      if (item) await inboxApi.markRead(item.id, body as Schema["MarkNotificationRead"], key);
      else await inboxApi.markAllRead(body, key);
      void cache.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
      setAll(null); setNotice(item ? t("markedOne") : t("markedAll"));
      const response = await list.refetch();
      if (accessFailure(response.error)) block(response.error);
    } catch (failure) { setError(failure); if (accessFailure(failure)) block(failure); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <PageHeader title={t("notificationsTitle")} description={t("notificationsDesc")} actions={<button type="button" className={apiButton} disabled={busy || list.isFetching} onClick={() => void refresh()}>{t("refreshNotifications")}</button>} />
    {denied ? <InboxFailure error={denied} retry={() => void refresh()} /> : <>
      <form key={`${rawState}:${rawCategory}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (busy) return; const form = new FormData(event.currentTarget); setAll(null); updateQuery({ state: String(form.get("state")), category: String(form.get("category")), page: null }); }}>
        <label>{t("readState")}<select name="state" className={`${apiInput} block`} defaultValue={filters.state}>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{t(`states.${label}`)}</option>)}</select></label>
        <label>{t("category")}<select name="category" className={`${apiInput} block`} defaultValue={filters.category}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{t(`categories.${label}`)}</option>)}</select></label>
        <button type="submit" className={apiButton} disabled={busy}>{t("filterNotifications")}</button>
      </form>
      {list.isFetching && <p role="status">{t("loadingNotifications")}</p>}{list.isError && <InboxFailure error={list.error} retry={() => void refresh()} />}
      {data && <Panel><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p>{t("summary", { all: data.total_all, unread: data.unread_total })}</p><button type="button" className={apiButton} disabled={busy || data.unread_total === 0 || versionFailure(error)} onClick={() => setAll({ expected_inbox_version: data.inbox_version, snapshot_id: data.snapshot_id })}>{t("markAllRead")}</button></div>
        <div aria-label={t("listLabel")} className="space-y-3">{data.items.map((item) => { const href = inboxTargetHref(item.target); return <article key={item.id} className="rounded border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><strong>{item.title}</strong><span>{item.read_at ? t("read") : t("unread")}</span></div><p className="my-2 text-sm">{item.description}</p><p className="mb-2 text-xs text-slate-500">{t(`categories.${categories[item.category]}`)} · {formatDate(item.created_at)}</p><div className="flex gap-3">{href && <Link className="gp-link" href={href}>{t("viewRelated")}</Link>}{!item.read_at && <button type="button" className={apiButton} disabled={busy || versionFailure(error)} onClick={() => void mark(item)}>{t("markRead")}</button>}</div></article>; })}</div>
        {!data.items.length && <EmptyState title={t("emptyNotifications")} />}<ApiPager page={data.page} pageSize={data.page_size} total={data.total} change={(page) => { if (!busy) { setAll(null); updateQuery({ page: String(page) }); } }} />
      </Panel>}
      {all && <Panel title={t("confirmAllTitle")} className="mt-4"><p className="mb-3">{t("confirmAllBody")}</p><div className="flex gap-3"><button type="button" className={apiButton} disabled={busy || !data || versionFailure(error)} onClick={() => void mark()}>{t("confirmAll")}</button><button type="button" className={apiButton} disabled={busy} onClick={() => setAll(null)}>{t("cancel")}</button></div></Panel>}
      {Boolean(error) && <InboxFailure error={error} />}{notice && <p role="status" className="my-3">{notice}</p>}
    </>}
  </>;
}

export function ActionItemsApiPage() {
  const { userId } = useWorkspace();
  return <ActionItems key={userId} userId={userId} />;
}

function ActionItems({ userId }: { userId: string }) {
  const t = useTranslations("pages.inbox");
  const { query, updateQuery } = useUrlQuery();
  const rawStatus = query.get("status") ?? "pending", rawCategory = query.get("category") ?? "all";
  const filters: ActionItemQuery = { status: Object.hasOwn(actionStatuses, rawStatus) ? rawStatus as keyof typeof actionStatuses : "pending",
    category: Object.hasOwn(actionCategories, rawCategory) ? rawCategory as keyof typeof actionCategories : "all", page: pageNumber(query.get("page")), page_size: 10 };
  const list = useQuery({ queryKey: ["c-inbox-actions", userId, filters], queryFn: () => inboxApi.actionItems(filters), ...queryPolicy });
  const data = list.isSuccess && !list.isFetching ? list.data : undefined;
  return <>
    <PageHeader title={t("actionsTitle")} description={t("actionsDesc")} actions={<button className={apiButton} type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>{t("refreshActions")}</button>} />
    <form key={`${rawStatus}:${rawCategory}`} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); updateQuery({ status: String(form.get("status")), category: String(form.get("category")), page: null }); }}>
      <label>{t("actionStatus")}<select className={`${apiInput} block`} name="status" defaultValue={filters.status}>{Object.entries(actionStatuses).map(([value, label]) => <option key={value} value={value}>{t(`actionStatuses.${label}`)}</option>)}</select></label>
      <label>{t("actionType")}<select className={`${apiInput} block`} name="category" defaultValue={filters.category}>{Object.entries(actionCategories).map(([value, label]) => <option key={value} value={value}>{t(`actionCategories.${label}`)}</option>)}</select></label>
      <button type="submit" className={apiButton}>{t("filterActions")}</button>
    </form>
    {list.isFetching && <p role="status">{t("loadingActions")}</p>}{list.isError && <InboxFailure error={list.error} retry={() => void list.refetch()} />}
    {data && <Panel><div className="space-y-3" aria-label={t("actionListLabel")}>{data.items.map((item) => { const href = inboxTargetHref(item.target); return <article className="rounded border border-slate-200 p-3" key={item.id}><div className="flex flex-wrap justify-between gap-2"><strong>{item.title}</strong><span>{t(`actionStatuses.${actionStatuses[item.status]}`)}</span></div><p className="my-2 text-sm">{item.description}</p><p className="mb-2 text-xs text-slate-500">{t(`actionCategories.${actionCategories[item.category]}`)} · {item.due_at ? t("due", { date: formatDate(item.due_at) }) : t("noDue")}</p>{href ? <Link className="gp-link" href={href}>{t("goHandle")}</Link> : <span className="text-sm">{t("noEntry")}</span>}</article>; })}</div>{!data.items.length && <EmptyState title={t("emptyActions")} />}<ApiPager page={data.page} pageSize={data.page_size} total={data.total} change={(page) => updateQuery({ page: String(page) })} /></Panel>}
  </>;
}
