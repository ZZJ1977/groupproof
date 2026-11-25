"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, Bell, Check, CheckCheck, CheckSquare, Clock, RefreshCw } from "lucide-react";
import { EmptyState, PageHeader, StatusBadge } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { useGpThemeScope } from "@/components/ui/theme-scope";
import { CApiError } from "@/lib/api/c-client";
import { inboxApi, inboxTargetHref, type ActionItemQuery, type NotificationQuery } from "@/lib/api/c-inbox-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";
import { cn, formatDate } from "@/lib/utils";
import type { components } from "@/packages/domain/api.generated";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";
import {
  FEISHU_INBOX_CARD,
  resolveInboxErrorText,
  TeacherInboxCategoryChips,
  TeacherInboxEmptyState,
  TeacherInboxPager,
  TeacherInboxSkeleton,
  TeacherNotificationsApiPage,
} from "@/features/teacher/pages/TeacherNotificationsApiPage";
import { useUrlQuery } from "./use-url-query";
import { accessFailure, ApiPager, pageNumber, queryPolicy, useCommandKey, versionFailure } from "./c-project-api";

type Schema = components["schemas"];
// Values are message keys under pages.inbox.*; labels come from the active locale.
const states = { all: "all", unread: "unread", read: "read" } as const;
const categories = { all: "all", project: "project", course: "course", system: "system" } as const;
const actionStatuses = { pending: "pending", completed: "completed", rejected: "rejected", all: "all" } as const;
const actionCategories = { all: "all", task: "task", verification: "verification", evidence: "evidence", rule: "rule", appeal: "appeal", member: "member", course: "course" } as const;

const priorityBadge: Record<Schema["ActionItemDTO"]["priority"], { label: string; className: string }> = {
  high: { label: "高优先级", className: "bg-[#fef2f2] text-[#d93025]" },
  medium: { label: "中优先级", className: "bg-amber-50 text-amber-800" },
  low: { label: "低优先级", className: "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]" },
};

const actionStatusTone: Record<Schema["ActionItemDTO"]["status"], string> = {
  pending: "bg-amber-50 text-amber-800",
  completed: "bg-[#ecfdf5] text-[#008a5c]",
  rejected: "bg-[#fef2f2] text-[#d93025]",
};

const compactBtn = "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-all hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const compactSelect = "h-9 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";

function InboxFailure({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useTranslations("pages.inbox");
  const ts = useTranslations("pages.shared");
  const text = error === "NOTIFICATION_WRITE_UNAVAILABLE" ? t("writeUnavailable")
    : accessFailure(error) ? t("failAccess")
    : versionFailure(error) ? t("failVersion")
      : error instanceof CApiError && error.status === 503 ? t("failUnavailable")
        : t("failDefault");
  return (
    <div role="alert" className="rounded-xl border border-rose-200/85 bg-rose-50/40 px-4 py-3 text-xs text-rose-800">
      <p>{text}</p>
      {retry && <button type="button" className={`${compactBtn} mt-2 !h-8`} onClick={retry}>{ts("retry")}</button>}
    </div>
  );
}

function InboxModeTabs({ active }: { active: "notifications" | "actions" }) {
  const t = useTranslations("pages.inbox");
  return (
    <div className="gp-segmented !p-0.5" role="navigation" aria-label="收件箱模块切换">
      <Link
        href="/notifications"
        data-active={active === "notifications" ? "true" : undefined}
        className="gp-segmented-item !min-h-8 !px-3 !py-1 !text-xs"
      >
        <Bell size={13} />
        {t("notificationsTitle")}
      </Link>
      <Link
        href="/action-items"
        data-active={active === "actions" ? "true" : undefined}
        className="gp-segmented-item !min-h-8 !px-3 !py-1 !text-xs"
      >
        <CheckSquare size={13} />
        {t("actionsTitle")}
      </Link>
    </div>
  );
}

export function NotificationsApiPage() {
  const { userId, role } = useWorkspace();
  if (role === "teacher" || role === "ta") {
    return <TeacherNotificationsApiPage key={userId} />;
  }
  return <Notifications key={userId} userId={userId} />;
}

function Notifications({ userId }: { userId: string }) {
  const t = useTranslations("pages.inbox");
  const cache = useQueryClient();
  const { query, updateQuery } = useUrlQuery();
  const rawState = query.get("state") ?? "all", rawCategory = query.get("category") ?? "all";
  const filters: NotificationQuery = {
    state: Object.hasOwn(states, rawState) ? rawState as keyof typeof states : "all",
    category: Object.hasOwn(categories, rawCategory) ? rawCategory as keyof typeof categories : "all",
    page: pageNumber(query.get("page")),
    page_size: 10,
  };
  const list = useQuery({ queryKey: ["c-inbox-notifications", userId, filters], queryFn: () => inboxApi.notifications(filters), ...queryPolicy });
  const [error, setError] = useState<unknown>(null), [blocked, setBlocked] = useState<unknown>(null);
  const [all, setAll] = useState<Schema["MarkAllNotificationsRead"] | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const lock = useRef(false), commandKey = useCommandKey();
  const denied = blocked || (accessFailure(list.error) ? list.error : null);
  const data = !denied && list.isSuccess && !list.isFetching ? list.data : undefined;

  function block(failure: unknown) {
    setBlocked(failure);
    setAll(null);
    cache.setQueryData(["c-inbox-blocked", userId], true);
  }

  async function refresh() {
    setAll(null);
    setNotice("");
    void cache.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
    const response = await list.refetch();
    if (response.isSuccess) {
      setError(null);
      setBlocked(null);
      cache.setQueryData(["c-inbox-blocked", userId], false);
    } else if (accessFailure(response.error)) {
      block(response.error);
    }
  }

  async function mark(item?: Schema["NotificationDTO"]) {
    if (!data || lock.current || versionFailure(error) || (!item && !all)) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const body = item ? { expected_version: item.lock_version, expected_inbox_version: data.inbox_version, snapshot_id: data.snapshot_id } : all!;
    const key = commandKey({ operation: item ? "single" : "all", id: item?.id, body });
    try {
      if (item) await inboxApi.markRead(item.id, body as Schema["MarkNotificationRead"], key);
      else await inboxApi.markAllRead(body, key);
      void cache.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
      setAll(null);
      setNotice(item ? t("markedOne") : t("markedAll"));
      const response = await list.refetch();
      if (accessFailure(response.error)) block(response.error);
    } catch (failure) {
      setError(failure instanceof CApiError && failure.status === 503 ? "NOTIFICATION_WRITE_UNAVAILABLE" : failure);
      if (accessFailure(failure)) block(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={t("notificationsTitle")}
        actions={
          <button type="button" className={compactBtn} disabled={busy || list.isFetching} onClick={() => void refresh()}>
            <RefreshCw size={13} className={list.isFetching ? "animate-spin" : ""} />
            {t("refreshNotifications")}
          </button>
        }
      />

      {denied ? (
        <div className="space-y-3.5">
          <div className="flex flex-wrap items-center">
            <InboxModeTabs active="notifications" />
          </div>
          <InboxFailure error={denied} retry={() => void refresh()} />
        </div>
      ) : (
        <>
          {/* 单行模块切换 + 筛选栏 */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-slate-200/85 bg-white px-3.5 py-2.5 shadow-xs">
            <InboxModeTabs active="notifications" />
            <form
              key={`${rawState}:${rawCategory}`}
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                const form = new FormData(event.currentTarget);
                setAll(null);
                updateQuery({ state: String(form.get("state")), category: String(form.get("category")), page: null });
              }}
            >
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
                <span>{t("readState")}</span>
                <select name="state" className={compactSelect} defaultValue={filters.state}>
                  {Object.entries(states).map(([value, label]) => (
                    <option key={value} value={value}>{t(`states.${label}`)}</option>
                  ))}
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
                <span>{t("category")}</span>
                <select name="category" className={compactSelect} defaultValue={filters.category}>
                  {Object.entries(categories).map(([value, label]) => (
                    <option key={value} value={value}>{t(`categories.${label}`)}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className={compactBtn} disabled={busy}>
                {t("filterNotifications")}
              </button>
            </form>
          </div>

          {list.isFetching && <p role="status" className="text-xs text-slate-500">{t("loadingNotifications")}</p>}
          {list.isError && <InboxFailure error={list.error} retry={() => void refresh()} />}
          {Boolean(error) && <InboxFailure error={error} />}
          {notice && (
            <p role="status" className="rounded-xl border border-emerald-200/80 bg-emerald-50/60 px-3.5 py-2 text-xs font-medium text-emerald-800">
              {notice}
            </p>
          )}

          {all && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200/85 bg-amber-50/60 px-4 py-3 text-xs text-amber-950 shadow-xs">
              <div>
                <div className="font-semibold">{t("confirmAllTitle")}</div>
                <p className="mt-0.5 text-amber-800">{t("confirmAllBody")}</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className={compactBtn} disabled={busy} onClick={() => setAll(null)}>
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-2xs transition hover:bg-[var(--gp-action-hover)] disabled:opacity-50"
                  disabled={busy || !data || versionFailure(error)}
                  onClick={() => void mark()}
                >
                  {t("confirmAll")}
                </button>
              </div>
            </div>
          )}

          {data && (
            <section className="overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
                <p className="text-xs font-medium text-slate-600">
                  {t("summary", { all: data.total_all, unread: data.unread_total })}
                </p>
                <button
                  type="button"
                  className={`${compactBtn} !h-8`}
                  disabled={busy || data.unread_total === 0 || versionFailure(error)}
                  onClick={() => setAll({ expected_inbox_version: data.inbox_version, snapshot_id: data.snapshot_id })}
                >
                  <Check size={13} />
                  {t("markAllRead")}
                </button>
              </div>

              {data.items.length > 0 ? (
                <div aria-label={t("listLabel")} className="divide-y divide-slate-100">
                  {data.items.map((item) => {
                    const href = inboxTargetHref(item.target);
                    const unread = !item.read_at;
                    return (
                      <article
                        key={item.id}
                        className={`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition ${
                          unread ? "bg-sky-50/35 hover:bg-sky-50/60" : "bg-white hover:bg-slate-50/60"
                        }`}
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-2.5">
                          <span
                            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-sky-600" : "bg-slate-300"}`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <strong className="truncate text-sm font-semibold text-slate-900">{item.title}</strong>
                              <StatusBadge tone={unread ? "blue" : "gray"} label={item.read_at ? t("read") : t("unread")} />
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                {t(`categories.${categories[item.category]}`)}
                              </span>
                              <span className="text-[11px] tabular-nums text-slate-400">
                                {formatDate(item.created_at)}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-xs text-slate-600">{item.description}</p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {href && (
                            <Link
                              className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-sky-300 hover:text-sky-700"
                              href={href}
                            >
                              {t("viewRelated")}
                            </Link>
                          )}
                          {unread && (
                            <button
                              type="button"
                              className="inline-flex h-8 items-center rounded-lg border border-sky-200 bg-sky-50/70 px-2.5 text-xs font-medium text-sky-700 transition hover:bg-sky-100/80 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={busy || versionFailure(error)}
                              onClick={() => void mark(item)}
                            >
                              {t("markRead")}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4">
                  <EmptyState title={t("emptyNotifications")} />
                </div>
              )}

              <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-xs text-slate-500 [&>div]:!mt-0">
                <ApiPager
                  page={data.page}
                  pageSize={data.page_size}
                  total={data.total}
                  change={(page) => {
                    if (!busy) {
                      setAll(null);
                      updateQuery({ page: String(page) });
                    }
                  }}
                />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function ActionItemsApiPage() {
  const { userId } = useWorkspace();
  return <ActionItems key={userId} userId={userId} />;
}

function ActionItems({ userId }: { userId: string }) {
  const isTeacherScope = useGpThemeScope() === "teacher";
  const t = useTranslations("pages.inbox");
  const ts = useTranslations("pages.shared");
  const { query, updateQuery } = useUrlQuery();
  const rawStatus = query.get("status") ?? "pending", rawCategory = query.get("category") ?? "all";
  const filters: ActionItemQuery = {
    status: Object.hasOwn(actionStatuses, rawStatus) ? rawStatus as keyof typeof actionStatuses : "pending",
    category: Object.hasOwn(actionCategories, rawCategory) ? rawCategory as keyof typeof actionCategories : "all",
    page: pageNumber(query.get("page")),
    page_size: 10,
  };
  const list = useQuery({ queryKey: ["c-inbox-actions", userId, filters], queryFn: () => inboxApi.actionItems(filters), ...queryPolicy });
  const data = list.isSuccess && !list.isFetching ? list.data : undefined;

  if (isTeacherScope) {
    const activeStatus = filters.status ?? "pending";
    const activeCategory = filters.category ?? "all";

    return (
      <div className="min-w-0 max-w-full space-y-4">
        <div className={cn(FEISHU_INBOX_CARD, "flex flex-wrap items-center justify-between gap-3")}>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--gp-ink,#1f2329)]">
              <CheckSquare size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
              <span className="truncate">{t("actionsTitle")}</span>
            </h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">{t("actionsDesc")}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            pill
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            <RefreshCw size={14} className={cn(list.isFetching && "animate-spin")} />
            {t("refreshActions")}
          </Button>
        </div>

        <div className={cn(FEISHU_INBOX_CARD, "flex flex-wrap items-center justify-between gap-3 p-4")}>
          <TeacherSegmentedTabs
            variant="segmented"
            size="sm"
            ariaLabel={t("actionStatus")}
            activeId={activeStatus}
            onChange={(nextStatus) => updateQuery({ status: nextStatus, page: null })}
            items={Object.entries(actionStatuses).map(([value, label]) => ({
              id: value,
              label: t(`actionStatuses.${label}`),
            }))}
          />

          <TeacherInboxCategoryChips
            items={Object.entries(actionCategories).map(([value, label]) => ({
              id: value,
              label: t(`actionCategories.${label}`),
            }))}
            activeId={activeCategory}
            ariaLabel={t("actionType")}
            onSelect={(nextCat) =>
              updateQuery({ category: nextCat === "all" ? null : nextCat, page: null })
            }
          />
        </div>

        {list.isFetching && <TeacherInboxSkeleton label={t("loadingActions")} />}

        {list.isError && (
          <div className={cn(FEISHU_INBOX_CARD, "flex flex-wrap items-center justify-between gap-3")}>
            <TeacherFeedbackPill tone="error" message={resolveInboxErrorText(list.error, t)} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              pill
              onClick={() => void list.refetch()}
            >
              {ts("retry")}
            </Button>
          </div>
        )}

        {data && (
          <div className="space-y-3">
            {!data.items.length ? (
              <TeacherInboxEmptyState
                icon={
                  activeStatus === "pending" && activeCategory === "all" ? (
                    <CheckCheck size={22} aria-hidden="true" />
                  ) : (
                    <CheckSquare size={22} aria-hidden="true" />
                  )
                }
                iconTone={
                  activeStatus === "pending" && activeCategory === "all" ? "success" : "default"
                }
                title={t("emptyActions")}
                description={
                  activeStatus === "pending" && activeCategory === "all"
                    ? tr("可切换上方状态筛选查看已完成或全部历史事项。")
                    : tr("当前筛选条件下暂无需要处理的事项。")
                }
                action={
                  activeStatus !== "pending" || activeCategory !== "all" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      pill
                      onClick={() =>
                        updateQuery({ status: "pending", category: null, page: null })
                      }
                    >
                      {tr("重置筛选")}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="space-y-2.5" aria-label={t("actionListLabel")}>
                {data.items.map((item) => {
                  const href = inboxTargetHref(item.target);
                  const prio = priorityBadge[item.priority];
                  return (
                    <article
                      key={item.id}
                      className={cn(
                        FEISHU_INBOX_CARD,
                        "gp-card-interactive flex flex-wrap items-start justify-between gap-4 p-4 hover:border-[var(--gp-action,#3370ff)]/50",
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                              prio.className,
                            )}
                          >
                            {tr(prio.label)}
                          </span>
                          <strong className="break-words text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                            {item.title}
                          </strong>
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                              actionStatusTone[item.status],
                            )}
                          >
                            {t(`actionStatuses.${actionStatuses[item.status]}`)}
                          </span>
                        </div>
                        <p className="break-words text-xs leading-relaxed text-[var(--gp-ink-soft,#4e5969)]">
                          {item.description}
                        </p>
                        <div className="flex flex-wrap items-center gap-2.5 pt-0.5 text-[11px] text-[var(--gp-muted,#646a73)]">
                          <span className="rounded bg-[var(--gp-surface-subtle,#f8f9fa)] px-1.5 py-0.5 font-medium text-[var(--gp-ink-soft,#4e5969)]">
                            {t(`actionCategories.${actionCategories[item.category]}`)}
                          </span>
                          <span className="gp-tabular inline-flex items-center gap-1">
                            <Clock size={12} aria-hidden="true" />
                            {item.due_at ? t("due", { date: formatDate(item.due_at) }) : t("noDue")}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center">
                        {href ? (
                          <Link
                            href={href}
                            data-variant="tonal"
                            className={cn(
                              buttonVariants({ variant: "tonal", size: "sm", pill: true }),
                              "h-8 shrink-0 px-3.5 text-xs",
                            )}
                          >
                            {tr("前往处理")}
                            <ArrowRight size={13} />
                          </Link>
                        ) : (
                          <span className="shrink-0 rounded-full bg-[var(--gp-surface-subtle,#f8f9fa)] px-3 py-1 text-xs text-[var(--gp-muted,#646a73)]">
                            {t("noEntry")}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {data.total > 0 && (
              <TeacherInboxPager
                page={data.page}
                pageSize={data.page_size}
                total={data.total}
                onChange={(nextPage) => updateQuery({ page: String(nextPage) })}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={t("actionsTitle")}
        actions={
          <button className={compactBtn} type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>
            <RefreshCw size={13} className={list.isFetching ? "animate-spin" : ""} />
            {t("refreshActions")}
          </button>
        }
      />

      {/* 单行模块切换 + 筛选栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-slate-200/85 bg-white px-3.5 py-2.5 shadow-xs">
        <InboxModeTabs active="actions" />
        <form
          key={`${rawStatus}:${rawCategory}`}
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            updateQuery({ status: String(form.get("status")), category: String(form.get("category")), page: null });
          }}
        >
          <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <span>{t("actionStatus")}</span>
            <select className={compactSelect} name="status" defaultValue={filters.status}>
              {Object.entries(actionStatuses).map(([value, label]) => (
                <option key={value} value={value}>{t(`actionStatuses.${label}`)}</option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <span>{t("actionType")}</span>
            <select className={compactSelect} name="category" defaultValue={filters.category}>
              {Object.entries(actionCategories).map(([value, label]) => (
                <option key={value} value={value}>{t(`actionCategories.${label}`)}</option>
              ))}
            </select>
          </label>
          <button type="submit" className={compactBtn}>
            {t("filterActions")}
          </button>
        </form>
      </div>

      {list.isFetching && <p role="status" className="text-xs text-slate-500">{t("loadingActions")}</p>}
      {list.isError && <InboxFailure error={list.error} retry={() => void list.refetch()} />}

      {data && (
        <section className="overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
          {data.items.length > 0 ? (
            <div className="divide-y divide-slate-100" aria-label={t("actionListLabel")}>
              {data.items.map((item) => {
                const href = inboxTargetHref(item.target);
                const tone = item.status === "pending" ? "amber" : item.status === "completed" ? "green" : "red";
                const dotColor = item.status === "pending" ? "bg-amber-500" : item.status === "completed" ? "bg-emerald-500" : "bg-rose-500";
                return (
                  <article
                    key={item.id}
                    className={`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition ${
                      item.status === "pending" ? "bg-amber-50/25 hover:bg-amber-50/50" : "bg-white hover:bg-slate-50/60"
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <strong className="truncate text-sm font-semibold text-slate-900">{item.title}</strong>
                          <StatusBadge tone={tone} label={t(`actionStatuses.${actionStatuses[item.status]}`)} />
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {t(`actionCategories.${actionCategories[item.category]}`)}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {item.due_at ? t("due", { date: formatDate(item.due_at) }) : t("noDue")}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-xs text-slate-600">{item.description}</p>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {href ? (
                        <Link
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-amber-200 bg-white px-2.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-50"
                          href={href}
                        >
                          {t("goHandle")}
                          <ArrowRight size={12} />
                        </Link>
                      ) : (
                        <span className="text-xs text-slate-400">{t("noEntry")}</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="p-4">
              <EmptyState title={t("emptyActions")} />
            </div>
          )}

          <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-xs text-slate-500 [&>div]:!mt-0">
            <ApiPager page={data.page} pageSize={data.page_size} total={data.total} change={(page) => updateQuery({ page: String(page) })} />
          </div>
        </section>
      )}
    </div>
  );
}
