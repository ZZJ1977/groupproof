"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bell, Check, CheckSquare, Inbox } from "lucide-react";
import { StatusBadge } from "@/components/common";
import { inboxApi, inboxTargetHref } from "@/lib/api/c-inbox-client";
import { tr } from "@/lib/i18n/tr";
import { formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { useCommandKey } from "./c-project-api";

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
        className="flex items-start justify-between gap-3 rounded-xl border border-amber-200/75 bg-amber-50/40 px-3.5 py-2.5 transition hover:border-amber-300/80 hover:bg-amber-50/70"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label="待处理" tone="amber" />
            <span className="gp-pill">{ACTION_CATEGORY_LABELS[item.category]}</span>
            {item.due_at && (
              <span className="text-[11px] text-amber-800/90">
                {tr("截止 {0}", { 0: formatDate(item.due_at) })}
              </span>
            )}
          </div>
          <div className="truncate text-sm font-semibold text-slate-900">{item.title}</div>
          <p className="line-clamp-1 text-xs text-slate-600">{item.description}</p>
        </div>
        {href && (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-50"
          >
            前往处理
            <ArrowRight size={12} />
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
        className={`flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition ${
          isUnread
            ? "border-sky-200/85 bg-sky-50/45 hover:border-sky-300/80 hover:bg-sky-50/75"
            : "border-slate-200/75 bg-slate-50/50 hover:border-slate-300/80 hover:bg-white"
        }`}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${isUnread ? "bg-sky-600" : "bg-slate-300"}`}
              aria-hidden="true"
            />
            <span className="text-[11px] font-semibold text-slate-500">
              {isUnread ? "未读" : "已读"}
            </span>
            <span className="gp-pill">{NOTIFICATION_CATEGORY_LABELS[item.category]}</span>
            <span className="text-[11px] text-slate-400">{formatDate(item.created_at)}</span>
          </div>
          <div className="truncate text-sm font-semibold text-slate-900">{item.title}</div>
          <p className="line-clamp-1 text-xs text-slate-600">{item.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {href && (
            <Link
              href={href}
              className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-sky-300 hover:text-sky-700"
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
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-sky-200 bg-white text-sky-700 transition hover:bg-sky-50 disabled:opacity-50"
            >
              <Check size={13} />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <section
      aria-label="待办与通知中心"
      className="rounded-2xl border border-slate-200/85 bg-white p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
            <Bell size={18} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold tracking-tight text-slate-900">待办与通知</h2>
              {attentionTotal > 0 && (
                <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700">
                  {tr("{0} 项需关注", { 0: attentionTotal })}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">集中查看待处理事项与动态通知，按类型快速筛选</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Link
            href="/action-items"
            className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-800 transition hover:bg-amber-100"
          >
            {tr("待处理事项：{0}", { 0: pendingCount ?? "暂不可用" })}
          </Link>
          <Link
            href="/notifications"
            className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 font-medium text-sky-800 transition hover:bg-sky-100"
          >
            {tr("未读通知：{0}", { 0: unreadCount ?? "暂不可用" })}
          </Link>
        </div>
      </div>

      {/* 一级切换：全部 / 待处理 / 通知 */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="gp-segmented" role="tablist" aria-label="收件箱视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "all"}
            data-active={primaryTab === "all" ? "true" : undefined}
            className="gp-segmented-item"
            onClick={() => setPrimaryTab("all")}
          >
            <Inbox size={13} />
            全部
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "actions"}
            data-active={primaryTab === "actions" ? "true" : undefined}
            className="gp-segmented-item"
            onClick={() => setPrimaryTab("actions")}
          >
            <CheckSquare size={13} />
            {tr("待处理 ({0})", { 0: pendingDisplay ?? 0 })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={primaryTab === "notifications"}
            data-active={primaryTab === "notifications" ? "true" : undefined}
            className="gp-segmented-item"
            onClick={() => setPrimaryTab("notifications")}
          >
            <Bell size={13} />
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
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="按待处理类型筛选">
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
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
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
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="按通知类型筛选">
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
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
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
        <p role="status" className="mt-3 text-xs text-amber-700">
          {inlineNotice}
        </p>
      )}

      {(actionsQuery.isError || notificationsQuery.isError) && !isInitialLoading && (
        <p className="mt-3 text-xs text-slate-500">
          部分收件箱明细暂不可用，可点击上方「待处理事项」或「未读通知」链接进入完整页面查看。
        </p>
      )}

      <div className="mt-4 space-y-2.5">
        {isInitialLoading && (
          <div className="space-y-2">
            <div className="h-14 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-14 animate-pulse rounded-xl bg-slate-100" />
          </div>
        )}

        {!isInitialLoading && primaryTab === "all" && (
          <>
            {actionItems.slice(0, 3).map(renderActionRow)}
            {notifications.slice(0, actionItems.length > 0 ? 4 : 6).map(renderNotificationRow)}
            {actionItems.length === 0 && notifications.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center">
                <div className="text-sm font-semibold text-slate-700">当前没有待处理事项或通知</div>
                <p className="mt-1 text-xs text-slate-500">新的任务确认、审批与项目通知会集中显示在这里。</p>
              </div>
            )}
          </>
        )}

        {!isInitialLoading && primaryTab === "actions" && (
          <>
            {filteredActions.slice(0, 6).map(renderActionRow)}
            {filteredActions.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center">
                <div className="text-sm font-semibold text-slate-700">该分类下暂无待处理事项</div>
                <p className="mt-1 text-xs text-slate-500">切换其他分类或前往「待处理事项」查看历史记录。</p>
              </div>
            )}
          </>
        )}

        {!isInitialLoading && primaryTab === "notifications" && (
          <>
            {filteredNotifications.slice(0, 6).map(renderNotificationRow)}
            {filteredNotifications.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center">
                <div className="text-sm font-semibold text-slate-700">该分类下暂无通知</div>
                <p className="mt-1 text-xs text-slate-500">切换其他筛选条件或前往「通知」页面查看全部记录。</p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
