"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Bell, BookOpen, Folder } from "lucide-react";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { apiMode } from "@/lib/api/config";
import { workspaceService } from "@/lib/api/workspace-service";
import { createCommandRunner } from "@/lib/commands/core";
import { scopedWorkspaceKey, useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import type { MockData } from "@/types/domain";
import { useUrlQuery } from "./use-url-query";
import { dailyEntryTab } from "./daily-entry";
import { notificationPage, setNotificationRead, type NotificationReadInput } from "./notification-actions";

export function NotificationsPage() {
  const { data, userId } = useWorkspace();
  const t = useTranslations("core.notifications");
  const queryClient = useQueryClient();
  const workspaceKey = useMemo(() => scopedWorkspaceKey(userId), [userId]);
  const runner = useMemo(() => createCommandRunner({
    repository: { read: async () => queryClient.getQueryData<MockData>(workspaceKey) ?? await workspaceService.getWorkspace(), save: workspaceService.saveWorkspace },
    currentActorId: () => queryClient.getQueryData<MockData>(workspaceKey)?.currentUserId ?? "",
    onSaved: (next) => queryClient.setQueryData(workspaceKey, next),
  }), [queryClient, workspaceKey]);
  const { query, updateQuery } = useUrlQuery();
  const tab = dailyEntryTab("notifications", query.get("tab"));
  const { items, total, unread, page, pageCount } = notificationPage(data, data.currentUserId, tab, Number(query.get("page") ?? 1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const localWorkspace = apiMode("workspace") === "mock";
  const save = async (input: NotificationReadInput) => {
    if (busy.current || !localWorkspace) return;
    busy.current = true; setSaving(true); setError("");
    try {
      const result = await runner(setNotificationRead, input);
      if (!result.ok) setError(result.error.message);
    } catch { setError("通知保存失败，请重试；当前状态未变更。"); }
    finally { busy.current = false; setSaving(false); }
  };
  if (!localWorkspace) return <><PageHeader title={t("title")} description={t("description")} /><Panel><p role="status">通知服务尚未接入，暂时无法读取或处理真实通知。</p></Panel></>;
  return <>
    <PageHeader title={t("title")} description={t("description")} actions={<Button variant="outline" size="sm" onClick={() => void save({ scope: "all", read: true })} disabled={!unread || saving || !localWorkspace}>{t("markAll")}</Button>} />
    <p className="mb-3 text-xs text-slate-500">当前为本地演示通知。</p>
    {error && <p role="alert" className="mb-4 text-sm text-red-700">{error}</p>}
    <div className="gp-tabs mb-4">{[["all", t("tabs.all")], ["unread", t("tabs.unread", { count: unread })], ["course", t("tabs.course")], ["project", t("tabs.project")], ["system", t("tabs.system")]].map(([id, label]) => <button key={id} className={`gp-tab ${tab === id ? "active" : ""}`} onClick={() => updateQuery({ tab: id, page: null })}>{label}</button>)}</div>
    <Panel noPadding>{items.length ? <div className="divide-y divide-[#e9eef5]">{items.map((item) => <div key={item.id} className={`flex gap-4 p-5 ${!item.read ? "bg-[#fafdff]" : ""}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] bg-[#eaf2ff] text-[#246bfa]">{item.type === "course" ? <BookOpen size={17} /> : item.type === "project" ? <Folder size={17} /> : <Bell size={17} />}</span>
      <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Link href={item.href} onClick={() => { if (!item.read) void save({ scope: "one", id: item.id, read: true }); }} className="font-semibold hover:text-[#246bfa]">{item.title}</Link>{!item.read && <span className="h-1.5 w-1.5 rounded-full bg-[#246bfa]" />}</div>
        <p className="mt-1 text-[12px] text-[#718097]">{item.description}</p><div className="mt-2 text-[11px] text-[#9aa6b7]">{formatDate(item.createdAt, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
      </div><Button variant="ghost" size="sm" disabled={saving || !localWorkspace} onClick={() => void save({ scope: "one", id: item.id, read: !item.read })}>{item.read ? t("markUnread") : t("markRead")}</Button>
    </div>)}</div> : <EmptyState title={t("empty")} description={t("emptyDesc")} />}
      <nav aria-label="通知分页" className="flex items-center justify-between gap-3 border-t p-4 text-sm"><span>共 {total} 条 · 第 {page}/{pageCount} 页</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => updateQuery({ page: String(page + 1) })}>下一页</Button></div></nav>
    </Panel>
  </>;
}
