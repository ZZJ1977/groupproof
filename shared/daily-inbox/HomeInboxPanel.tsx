"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bell, Check, CheckSquare, Inbox } from "lucide-react";
import { StatusBadge } from "@/shared/components/common";
import { inboxApi, inboxTargetHref } from "@/shared/daily-inbox/c-inbox-client";
import { tr } from "@/shared/i18n/tr";
import { formatDate } from "@/shared/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { useCommandKey } from "@/shared/lib/c-project-api";

type Schema = components["schemas"];
type PrimaryTab = "all" | "actions" | "notifications";
type ActionSubFilter = "all" | "task" | "verification_evidence" | "course_member";
type NotificationSubFilter = "all" | "unread" | "project" | "course" | "system";

const ACTION_CATEGORY_LABELS: Record<Schema["ActionItemDTO"]["category"], string> = {
  task: "任务",
  verification: "验收",
  evidence: "证据",
  rule: "规则",
  appeal: "申诉",
  member: "成员",
  course: "课程",
};

const NOTIFICATION_CATEGORY_LABELS: Record<Schema["NotificationDTO"]["category"], string> = {
  project: "项目",
  course: "课程",
  system: "系统",
};

function matchesActionSubFilter(
  category: Schema["ActionItemDTO"]["category"],
  filter: ActionSubFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "task") return category === "task";
  if (filter === "verification_evidence") return category === "verification" || category === "evidence";
  return category === "course" || category === "member" || category === "rule" || category === "appeal";
}

export function HomeInboxPanel({
  userId,
  pendingCount,
  unreadCount,
  onCountsChanged,
}: {
  userId: string;
  pendingCount?: number | null;
  unreadCount?: number | null;
  onCountsChanged?: () => void;
}) {
  const cache = useQueryClient();
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>("all");
  const [actionFilter, setActionFilter] = useState<ActionSubFilter>("all");
  const [notificationFilter, setNotificationFilter] = useState<NotificationSubFilter>("all");
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const commandKey = useCommandKey();

  const actionsQuery = useQuery({
    queryKey: ["c-home-inbox-actions", userId],
    queryFn: () => inboxApi.actionItems({ status: "pending", category: "all", page: 1, page_size: 8 }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const notificationsQuery = useQuery({
    queryKey: ["c-home-inbox-notifications", userId],
    queryFn: () => inboxApi.notifications({ state: "all", category: "all", page: 1, page_size: 8 }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const actionItems = useMemo(
    () => (actionsQuery.isSuccess ? actionsQuery.data.items : []),
    [actionsQuery.data, actionsQuery.isSuccess],
  );
  const notifications = useMemo(
    () => (notificationsQuery.isSuccess ? notificationsQuery.data.items : []),
    [notificationsQuery.data, notificationsQuery.isSuccess],
  );

  const filteredActions = useMemo(
    () => actionItems.filter((item) => matchesActionSubFilter(item.category, actionFilter)),
    [actionFilter, actionItems],
  );

  const filteredNotifications = useMemo(() => {
    if (notificationFilter === "all") return notifications;
    if (notificationFilter === "unread") return notifications.filter((item) => !item.read_at);
    return notifications.filter((item) => item.category === notificationFilter);
  }, [notificationFilter, notifications]);

  async function markOneRead(item: Schema["NotificationDTO"]) {
    const inboxData = notificationsQuery.data;
    if (!inboxData || lock.current || item.read_at) return;
    lock.current = true;
    setMarkingId(item.id);
    setInlineNotice(null);
    const body: Schema["MarkNotificationRead"] = {
      expected_version: item.lock_version,
      expected_inbox_version: inboxData.inbox_version,
      snapshot_id: inboxData.snapshot_id,
    };
    const key = commandKey({ operation: "home-single", id: item.id, body });
    try {
      await inboxApi.markRead(item.id, body, key);
      void cache.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
      await notificationsQuery.refetch();
      onCountsChanged?.();
    } catch {
      setInlineNotice("标记已读暂未成功，请前往通知中心重试。");
    } finally {
      lock.current = false;
      setMarkingId(null);
    }
  }

  const pendingDisplay = pendingCount ?? (actionsQuery.isSuccess ? actionsQuery.data.total : null);
  const unreadDisplay = unreadCount ?? (notificationsQuery.isSuccess ? notificationsQuery.data.unread_total : null);
  const attentionTotal = (pendingDisplay ?? 0) + (unreadDisplay ?? 0);
  const isInitialLoading = actionsQuery.isPending && notificationsQuery.isPending;

  const renderActionRow = (item: Schema["ActionItemDTO"]) => {
    const href = inboxTargetHref(item.target);
    return (
      <div
        key={`action-${item.id}`}
        className="flex items-center justify-between gap-2.5 py-2.5 first:pt-1 last:pb-0.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label="待处理" tone="amber" className="!min-h-5 !px-1.5 !py-0 !text-[10px]" />
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {ACTION_CATEGORY_LABELS[item.category]}
            </span>
            <span className="truncate text-xs font-semibold text-slate-900">{item.title}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
            <span className="truncate">{item.description}</span>
            {item.due_at && (
              <span className="shrink-0 text-amber-700">
                {tr("截止 {0}", { 0: formatDate(item.due_at) })}
              </span>
            )}
          </div>
        </div>
        {href && (
          <Link
            href={href}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-amber-200 bg-amber-50/50 px-2 text-[11px] font-semibold text-amber-900 transition hover:bg-amber-100/70"
          >
            前往处理
            <ArrowRight size={11} />
          </Link>
        )}
      </div>
    );
  };

  const renderNotificationRow = (item: Schema["NotificationDTO"]) => {
    const href = inboxTargetHref(item.target);
    const isUnread = !item.read_at;
    return (
      <div
        key={`notif-${item.id}`}
        className="flex items-center justify-between gap-2.5 py-2.5 first:pt-1 last:pb-0.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${isUnread ? "bg-sky-600" : "bg-slate-300"}`}
              aria-hidden="true"
            />
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {NOTIFICATION_CATEGORY_LABELS[item.category]}
            </span>
            <span className={`truncate text-xs ${isUnread ? "font-semibold text-slate-900" : "font-medium text-slate-700"}`}>
              {item.title}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{formatDate(item.created_at)}</span>
          </div>
          <p className="mt-0.5 line-clamp-1 pl-3.5 text-[11px] text-slate-500">{item.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {href && (
            <Link
              href={href}
              className="inline-flex h-7 items-center rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-700 transition hover:border-sky-300 hover:text-sky-700"
            >
              查看相关内容
            </Link>
          )}
          {isUnread && (
            <button
              type="button"
              disabled={markingId === item.id}
              onClick={() => void markOneRead(item)}
              title="标为已读"
              aria-label={tr("将「{0}」标为已读", { 0: item.title })}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-sky-200 bg-sky-50/60 text-sky-700 transition hover:bg-sky-100/70 disabled:opacity-50"
            >
              <Check size={12} />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <section
      aria-label="待办与通知中心"
      className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
            <Bell size={15} />
          </span>
          <h2 className="text-sm font-bold tracking-tight text-slate-900">待办与通知</h2>
          {attentionTotal > 0 && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
              {tr("{0} 项需关注", { 0: attentionTotal })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Link
            href="/action-items"
            className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 transition hover:bg-amber-100"
          >
            {tr("待处理事项：{0}", { 0: pendingCount ?? "暂不可用" })}
          </Link>
          <Link
            href="/notifications"
            className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-800 transition hover:bg-sky-100"
          >
            {tr("未读通知：{0}", { 0: unreadCount ?? "暂不可用" })}
          </Link>
        </div>
      </div>

      {/* 一级切换：全部 / 待处理 / 通知 */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="gp-segmented !p-0.5" role="tablist" aria-label="收件箱视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "all"}
            data-active={primaryTab === "all" ? "true" : undefined}
            className="gp-segmented-item !min-h-7 !px-2.5 !py-1 !text-xs"
            onClick={() => setPrimaryTab("all")}
          >
            <Inbox size={12} />
            全部
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "actions"}
            data-active={primaryTab === "actions" ? "true" : undefined}
            className="gp-segmented-item !min-h-7 !px-2.5 !py-1 !text-xs"
            onClick={() => setPrimaryTab("actions")}
          >
            <CheckSquare size={12} />
            {tr("待处理 ({0})", { 0: pendingDisplay ?? 0 })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "notifications"}
            data-active={primaryTab === "notifications" ? "true" : undefined}
            className="gp-segmented-item !min-h-7 !px-2.5 !py-1 !text-xs"
            onClick={() => setPrimaryTab("notifications")}
          >
            <Bell size={12} />
            {tr("通知 ({0})", { 0: unreadDisplay ?? 0 })}
          </button>
        </div>
        <Link
          href={primaryTab === "actions" ? "/action-items" : "/notifications"}
          className="text-xs font-semibold text-[var(--gp-action)] hover:underline"
        >
          进入完整列表 →
        </Link>
      </div>

      {/* 二级细分筛选 */}
      {primaryTab === "actions" && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="按待处理类型筛选">
          {(
            [
              ["all", "全部待办"],
              ["task", "任务"],
              ["verification_evidence", "验收与证据"],
              ["course_member", "课程与成员"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setActionFilter(key)}
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                actionFilter === key
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {primaryTab === "notifications" && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="按通知类型筛选">
          {(
            [
              ["all", "全部通知"],
              ["unread", "仅未读"],
              ["project", "项目"],
              ["course", "课程"],
              ["system", "系统"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setNotificationFilter(key)}
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                notificationFilter === key
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/80"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {inlineNotice && (
        <p role="status" className="mt-2 text-xs text-amber-700">
          {inlineNotice}
        </p>
      )}

      {(actionsQuery.isError || notificationsQuery.isError) && !isInitialLoading && (
        <p className="mt-2 text-[11px] text-slate-500">
          部分收件箱明细暂不可用，可点击上方「待处理事项」或「未读通知」链接进入完整页面查看。
        </p>
      )}

      <div className="mt-2.5">
        {isInitialLoading && (
          <div className="space-y-2 py-1">
            <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
          </div>
        )}

        {!isInitialLoading && primaryTab === "all" && (
          actionItems.length > 0 || notifications.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {actionItems.slice(0, 3).map(renderActionRow)}
              {notifications.slice(0, actionItems.length > 0 ? 3 : 5).map(renderNotificationRow)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-3.5 py-4 text-center">
              <div className="text-xs font-semibold text-slate-700">当前没有待处理事项或通知</div>
              <p className="mt-0.5 text-[11px] text-slate-500">新的任务确认、审批与项目通知会集中显示在这里。</p>
            </div>
          )
        )}

        {!isInitialLoading && primaryTab === "actions" && (
          filteredActions.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {filteredActions.slice(0, 5).map(renderActionRow)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-3.5 py-4 text-center">
              <div className="text-xs font-semibold text-slate-700">该分类下暂无待处理事项</div>
              <p className="mt-0.5 text-[11px] text-slate-500">切换其他分类或前往「待处理事项」查看历史记录。</p>
            </div>
          )
        )}

        {!isInitialLoading && primaryTab === "notifications" && (
          filteredNotifications.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {filteredNotifications.slice(0, 5).map(renderNotificationRow)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-3.5 py-4 text-center">
              <div className="text-xs font-semibold text-slate-700">该分类下暂无通知</div>
              <p className="mt-0.5 text-[11px] text-slate-500">切换其他筛选条件或前往「通知」页面查看全部记录。</p>
            </div>
          )
        )}
      </div>
    </section>
  );
}
