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
  const td = useTranslations("pages.daily");
  const ts = useTranslations("pages.shared");
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
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await runner(setNotificationRead, input);
      if (!result.ok) setError(result.error.message);
    } catch {
      setError(td("notificationSaveFailed"));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  if (!localWorkspace) {
    return (
      <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
        <PageHeader title={t("title")} />
        <Panel><p role="status">{td("notificationsNotConnected")}</p></Panel>
      </div>
    );
  }

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={t("title")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save({ scope: "all", read: true })}
            disabled={!unread || saving || !localWorkspace}
          >
            {t("markAll")}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-1.5 shadow-xs">
        <div className="gp-tabs !border-b-0">
          {[
            ["all", t("tabs.all")],
            ["unread", t("tabs.unread", { count: unread })],
            ["course", t("tabs.course")],
            ["project", t("tabs.project")],
            ["system", t("tabs.system")],
          ].map(([id, label]) => (
            <button
              key={id}
              className={`gp-tab !py-2 ${tab === id ? "active" : ""}`}
              onClick={() => updateQuery({ tab: id, page: null })}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-slate-400">{td("demoNotifications")}</span>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50/60 px-3.5 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}

      <section className="overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((item) => (
              <div
                key={item.id}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 transition ${
                  !item.read ? "bg-sky-50/35 hover:bg-sky-50/60" : "hover:bg-slate-50/60"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                    {item.type === "course" ? <BookOpen size={15} /> : item.type === "project" ? <Folder size={15} /> : <Bell size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {!item.read && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-600" aria-hidden="true" />}
                      <Link
                        href={item.href}
                        onClick={() => { if (!item.read) void save({ scope: "one", id: item.id, read: true }); }}
                        className="truncate text-sm font-semibold text-slate-900 hover:text-[var(--gp-action)] hover:underline"
                      >
                        {item.title}
                      </Link>
                      <span className="text-[11px] tabular-nums text-slate-400">
                        {formatDate(item.createdAt, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-xs text-slate-600">{item.description}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={saving || !localWorkspace}
                  onClick={() => void save({ scope: "one", id: item.id, read: !item.read })}
                >
                  {item.read ? t("markUnread") : t("markRead")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4">
            <EmptyState title={t("empty")} description={t("emptyDesc")} />
          </div>
        )}

        <nav
          aria-label={td("notificationPagination")}
          className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-xs text-slate-500"
        >
          <span>{td("pagerOf", { total, page, pages: pageCount })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>
              {ts("prev")}
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={page >= pageCount} onClick={() => updateQuery({ page: String(page + 1) })}>
              {ts("next")}
            </Button>
          </div>
        </nav>
      </section>
    </div>
  );
}
