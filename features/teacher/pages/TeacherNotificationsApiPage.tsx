"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, Bell, BookOpen, CheckCheck, Folder, Inbox, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CApiError } from "@/lib/api/c-client";
import {
  inboxApi,
  inboxTargetHref,
  type NotificationQuery,
} from "@/lib/api/c-inbox-client";
import type { components } from "@/packages/domain/api.generated";
import { tr } from "@/lib/i18n/tr";
import {
  accessFailure,
  isUuid,
  pageNumber,
  queryPolicy,
  useCommandKey,
  versionFailure,
} from "@/features/c/c-project-api";
import { useUrlQuery } from "@/features/c/use-url-query";
import { cn, formatDate } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";

type Schema = components["schemas"];
type InboxT = ReturnType<typeof useTranslations>;

export const FEISHU_INBOX_CARD =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

const notificationStates = { all: "all", unread: "unread", read: "read" } as const;
const notificationCategories = {
  all: "all",
  course: "course",
  project: "project",
  system: "system",
} as const;

const teacherCategoryChips: { id: keyof typeof notificationCategories; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "course", label: "课程与班级" },
  { id: "project", label: "项目进展" },
  { id: "system", label: "系统" },
];

const categoryLabelMap: Record<Schema["NotificationDTO"]["category"], string> = {
  course: "课程与班级",
  project: "项目进展",
  system: "系统",
};

/** Resolve C inbox API / snapshot errors using canonical pages.inbox.* messages. */
export function resolveInboxErrorText(failure: unknown, t: InboxT): string {
  if (failure === "NOTIFICATION_WRITE_UNAVAILABLE") return t("writeUnavailable");
  if (accessFailure(failure)) return t("failAccess");
  if (versionFailure(failure)) return t("failVersion");
  if (failure instanceof CApiError && failure.status === 503) return t("failUnavailable");
  return t("failDefault");
}

/** Shared Feishu-style category pill chips for teacher inbox views. */
export function TeacherInboxCategoryChips<T extends string>({
  items,
  activeId,
  ariaLabel,
  disabled = false,
  onSelect,
}: {
  items: { id: T; label: string }[];
  activeId: T;
  ariaLabel: string;
  disabled?: boolean;
  onSelect: (id: T) => void;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onSelect(item.id)}
            className={cn(
              "inline-flex shrink-0 items-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
              active
                ? "bg-[#e8f0fe] font-semibold text-[#1d4ed8]"
                : "border border-[var(--gp-border,#dee0e3)] bg-white text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)] hover:text-[var(--gp-ink,#1f2329)]",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Shared Feishu-style skeleton list for teacher inbox pages. */
export function TeacherInboxSkeleton({ label }: { label: string }) {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2, 3].map((idx) => (
        <div
          key={idx}
          className={cn(FEISHU_INBOX_CARD, "animate-pulse flex items-start gap-3.5 p-4")}
        >
          <div className="h-9 w-9 shrink-0 rounded-full bg-[var(--gp-surface-hover,#eff0f1)]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-48 max-w-full rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
            <div className="h-3.5 w-3/4 rounded bg-[var(--gp-surface-subtle,#f8f9fa)]" />
            <div className="h-3 w-32 rounded bg-[var(--gp-surface-subtle,#f8f9fa)]" />
          </div>
          <div className="h-7 w-16 shrink-0 rounded-full bg-[var(--gp-surface-subtle,#f8f9fa)]" />
        </div>
      ))}
    </div>
  );
}

/** Shared Feishu-style centered empty card for teacher inbox views. */
export function TeacherInboxEmptyState({
  icon,
  iconTone = "default",
  title,
  description,
  action,
}: {
  icon: ReactNode;
  iconTone?: "default" | "success";
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn(FEISHU_INBOX_CARD, "flex flex-col items-center py-12 text-center")}>
      <span
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-full",
          iconTone === "success"
            ? "bg-[#ecfdf5] text-[#008a5c]"
            : "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action,#3370ff)]",
        )}
      >
        {icon}
      </span>
      <p className="mt-3 text-sm font-semibold text-[var(--gp-ink,#1f2329)]">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-xs text-[var(--gp-muted,#646a73)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Shared Feishu-style bottom pagination bar for teacher inbox views. */
export function TeacherInboxPager({
  page,
  pageSize,
  total,
  disabled = false,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  disabled?: boolean;
  onChange: (nextPage: number) => void;
}) {
  const ts = useTranslations("pages.shared");
  return (
    <div
      className={cn(
        FEISHU_INBOX_CARD,
        "flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-xs text-[var(--gp-muted,#646a73)]",
      )}
    >
      <span className="gp-tabular">{ts("pagerTotal", { total, page })}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          pill
          disabled={disabled || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          {ts("prev")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          pill
          disabled={disabled || page * pageSize >= total}
          onClick={() => onChange(page + 1)}
        >
          {ts("next")}
        </Button>
      </div>
    </div>
  );
}

function categoryIcon(category: Schema["NotificationDTO"]["category"]) {
  if (category === "course") return <BookOpen size={17} aria-hidden="true" />;
  if (category === "project") return <Folder size={17} aria-hidden="true" />;
  return <Bell size={17} aria-hidden="true" />;
}

/** Map course notifications to teacher-workbench routes so staff stay inside the teacher shell. */
function teacherNotificationHref(item: Schema["NotificationDTO"]): string | null {
  const target = item.target;
  if (!target || !isUuid(target.id)) return null;
  if (target.kind === "course") {
    const courseId = target.course_id;
    if (!courseId || !isUuid(courseId) || target.project_id != null) return null;
    const title = item.title ?? "";
    if (title.includes("申请") || title.includes("审批")) {
      return `/teacher/courses/${courseId}/actions`;
    }
    if (title.includes("公告")) {
      return `/teacher/courses/${courseId}/announcements`;
    }
    if (title.includes("规则")) {
      return `/teacher/courses/${courseId}/rules`;
    }
    return `/teacher/courses/${courseId}`;
  }
  return inboxTargetHref(target);
}

/** Teacher & TA notification center using canonical /api/v1/me/notifications contracts. */
export function TeacherNotificationsApiPage() {
  const { userId } = useWorkspace();
  const router = useRouter();
  const t = useTranslations("pages.inbox");
  const ts = useTranslations("pages.shared");
  const cache = useQueryClient();
  const { query, updateQuery } = useUrlQuery();

  const rawState = query.get("state") ?? "all";
  const rawCategory = query.get("category") ?? "all";
  const filters: NotificationQuery = {
    state: Object.hasOwn(notificationStates, rawState)
      ? (rawState as keyof typeof notificationStates)
      : "all",
    category: Object.hasOwn(notificationCategories, rawCategory)
      ? (rawCategory as keyof typeof notificationCategories)
      : "all",
    page: pageNumber(query.get("page")),
    page_size: 10,
  };

  const list = useQuery({
    queryKey: ["c-inbox-notifications", userId, filters],
    queryFn: () => inboxApi.notifications(filters),
    ...queryPolicy,
  });

  const [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState<unknown>(null);
  const [all, setAll] = useState<Schema["MarkAllNotificationsRead"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const commandKey = useCommandKey();

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

  async function mark(item?: Schema["NotificationDTO"]): Promise<boolean> {
    if (!data || lock.current || versionFailure(error) || (!item && !all)) return false;
    if (item?.read_at) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const body = item
      ? {
          expected_version: item.lock_version,
          expected_inbox_version: data.inbox_version,
          snapshot_id: data.snapshot_id,
        }
      : all!;
    const key = commandKey({ operation: item ? "single" : "all", id: item?.id, body });
    try {
      if (item) {
        await inboxApi.markRead(item.id, body as Schema["MarkNotificationRead"], key);
      } else {
        await inboxApi.markAllRead(body, key);
      }
      void cache.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
      setAll(null);
      setNotice(item ? t("markedOne") : t("markedAll"));
      const response = await list.refetch();
      if (accessFailure(response.error)) block(response.error);
      return true;
    } catch (failure) {
      setError(
        failure instanceof CApiError && failure.status === 503
          ? "NOTIFICATION_WRITE_UNAVAILABLE"
          : failure,
      );
      if (accessFailure(failure)) block(failure);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function handleRowClick(item: Schema["NotificationDTO"], href: string | null) {
    if (busy) return;
    if (!item.read_at) {
      if (versionFailure(error)) return;
      const ok = await mark(item);
      if (ok && href) router.push(href);
      return;
    }
    if (href) router.push(href);
  }

  const activeFilterState = filters.state ?? "all";
  const activeCategory = filters.category ?? "all";

  return (
    <div className="min-w-0 max-w-full space-y-4">
      <div className={cn(FEISHU_INBOX_CARD, "flex flex-wrap items-center justify-between gap-3")}>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--gp-ink,#1f2329)]">
            <Bell size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
            <span className="truncate">{tr("通知")}</span>
          </h1>
          <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("接收学生的申诉、组队、加入班级与项目进展等消息")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            pill
            disabled={busy || list.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={cn(list.isFetching && "animate-spin")} />
            {t("refreshNotifications")}
          </Button>
          {!denied && (
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              disabled={
                !data ||
                busy ||
                data.unread_total === 0 ||
                versionFailure(error) ||
                list.isError
              }
              onClick={() => {
                if (data) {
                  setAll({
                    expected_inbox_version: data.inbox_version,
                    snapshot_id: data.snapshot_id,
                  });
                }
              }}
            >
              <CheckCheck size={14} />
              {t("markAllRead")}
            </Button>
          )}
        </div>
      </div>

      {denied ? (
        <div className={cn(FEISHU_INBOX_CARD, "flex flex-wrap items-center justify-between gap-3")}>
          <TeacherFeedbackPill tone="error" message={resolveInboxErrorText(denied, t)} />
          <Button type="button" variant="outline" size="sm" pill onClick={() => void refresh()}>
            {ts("retry")}
          </Button>
        </div>
      ) : (
        <>
          <div
            className={cn(
              FEISHU_INBOX_CARD,
              "flex flex-wrap items-center justify-between gap-3 p-4",
            )}
          >
            <TeacherSegmentedTabs
              variant="segmented"
              size="sm"
              ariaLabel={t("readState")}
              activeId={activeFilterState}
              onChange={(nextState) => {
                if (busy) return;
                setAll(null);
                updateQuery({
                  state: nextState === "all" ? null : nextState,
                  page: null,
                });
              }}
              items={[
                {
                  id: "all",
                  label: data ? tr("全部 ({0})", { 0: data.total_all }) : t("states.all"),
                  disabled: busy,
                },
                {
                  id: "unread",
                  label: t("states.unread"),
                  badge: data && data.unread_total > 0 ? data.unread_total : undefined,
                  disabled: busy,
                },
                { id: "read", label: t("states.read"), disabled: busy },
              ]}
            />

            <TeacherInboxCategoryChips
              items={teacherCategoryChips.map((cat) => ({
                id: cat.id,
                label: tr(cat.label),
              }))}
              activeId={activeCategory}
              ariaLabel={t("category")}
              disabled={busy}
              onSelect={(catId) => {
                if (busy) return;
                setAll(null);
                updateQuery({
                  category: catId === "all" ? null : catId,
                  page: null,
                });
              }}
            />
          </div>

          {all && (
            <div
              role="region"
              aria-label={t("confirmAllTitle")}
              className={cn(
                FEISHU_INBOX_CARD,
                "flex flex-wrap items-center justify-between gap-4 border-[#c7dafc] bg-[#f8faff]",
              )}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1d4ed8]">
                  <CheckCheck size={16} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                    {t("confirmAllTitle")}
                  </h2>
                  <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
                    {t("confirmAllBody")}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  pill
                  disabled={busy}
                  onClick={() => setAll(null)}
                >
                  {t("cancel")}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  pill
                  loading={busy}
                  disabled={busy || !data || versionFailure(error)}
                  onClick={() => void mark()}
                >
                  {t("confirmAll")}
                </Button>
              </div>
            </div>
          )}

          {(Boolean(error) || notice) && (
            <div className="flex flex-wrap items-center gap-2">
              {Boolean(error) && (
                <TeacherFeedbackPill
                  tone="error"
                  message={resolveInboxErrorText(error, t)}
                  action={
                    versionFailure(error)
                      ? { label: t("refreshNotifications"), onClick: () => void refresh() }
                      : undefined
                  }
                />
              )}
              {notice && (
                <TeacherFeedbackPill
                  tone="success"
                  message={notice}
                  autoHideMs={4000}
                  onDismiss={() => setNotice("")}
                />
              )}
            </div>
          )}

          {list.isFetching && <TeacherInboxSkeleton label={t("loadingNotifications")} />}

          {list.isError && (
            <div
              className={cn(FEISHU_INBOX_CARD, "flex flex-wrap items-center justify-between gap-3")}
            >
              <TeacherFeedbackPill tone="error" message={resolveInboxErrorText(list.error, t)} />
              <Button type="button" variant="outline" size="sm" pill onClick={() => void refresh()}>
                {ts("retry")}
              </Button>
            </div>
          )}

          {data && (
            <div className="space-y-3">
              {data.items.length === 0 ? (
                activeFilterState === "unread" ? (
                  <TeacherInboxEmptyState
                    icon={<CheckCheck size={22} aria-hidden="true" />}
                    iconTone="success"
                    title={
                      activeCategory === "all"
                        ? tr("所有未读通知已清零")
                        : tr("当前类别下暂无未读通知")
                    }
                    description={tr("暂时没有未读的学生、课程或系统消息。")}
                    action={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        pill
                        disabled={busy}
                        onClick={() => {
                          setAll(null);
                          updateQuery({ state: null, category: null, page: null });
                        }}
                      >
                        {tr("查看全部通知")}
                      </Button>
                    }
                  />
                ) : (
                  <TeacherInboxEmptyState
                    icon={<Inbox size={22} aria-hidden="true" />}
                    title={t("emptyNotifications")}
                    description={tr("可切换状态或类别筛选条件，或稍后刷新查看最新消息。")}
                    action={
                      activeFilterState !== "all" || activeCategory !== "all" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          pill
                          disabled={busy}
                          onClick={() => {
                            setAll(null);
                            updateQuery({ state: null, category: null, page: null });
                          }}
                        >
                          {tr("查看全部通知")}
                        </Button>
                      ) : undefined
                    }
                  />
                )
              ) : (
                <div aria-label={t("listLabel")} className="space-y-2.5">
                  {data.items.map((item) => {
                    const href = teacherNotificationHref(item);
                    const isUnread = !item.read_at;
                    const clickable = Boolean(href) || isUnread;
                    return (
                      <article
                        key={item.id}
                        onClick={
                          clickable ? () => void handleRowClick(item, href) : undefined
                        }
                        className={cn(
                          FEISHU_INBOX_CARD,
                          "gp-card-interactive flex flex-wrap items-start justify-between gap-4 p-4",
                          isUnread
                            ? "border-[#c7dafc] bg-[#f8faff] hover:border-[var(--gp-action,#3370ff)]/60"
                            : "hover:border-[#cfd3d9]",
                          clickable && "cursor-pointer",
                        )}
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <span
                            className={cn(
                              "mt-4 h-2 w-2 shrink-0 rounded-full",
                              isUnread ? "bg-[#3370ff]" : "bg-transparent",
                            )}
                            aria-hidden="true"
                          />
                          <span
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                              isUnread
                                ? "bg-[#e8f0fe] text-[#3370ff]"
                                : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
                            )}
                          >
                            {categoryIcon(item.category)}
                          </span>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <strong
                                className={cn(
                                  "break-words text-sm text-[var(--gp-ink,#1f2329)]",
                                  isUnread ? "font-semibold" : "font-medium",
                                )}
                              >
                                {item.title}
                              </strong>
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                                  isUnread
                                    ? "bg-[#e8f0fe] font-semibold text-[#1d4ed8]"
                                    : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-muted,#646a73)]",
                                )}
                              >
                                {isUnread ? t("unread") : t("read")}
                              </span>
                            </div>
                            <p className="break-words text-xs leading-relaxed text-[var(--gp-ink-soft,#4e5969)]">
                              {item.description}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-[var(--gp-muted,#646a73)]">
                              <span className="rounded bg-[var(--gp-surface-subtle,#f8f9fa)] px-1.5 py-0.5 font-medium text-[var(--gp-ink-soft,#4e5969)]">
                                {tr(categoryLabelMap[item.category])}
                              </span>
                              <span className="gp-tabular">
                                {formatDate(item.created_at, {
                                  month: "numeric",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {href && (
                            <Link
                              href={href}
                              onClick={(event) => event.stopPropagation()}
                              data-variant="tonal"
                              className={cn(
                                buttonVariants({ variant: "tonal", size: "sm", pill: true }),
                                "h-8 px-3 text-xs",
                              )}
                            >
                              {tr("查看")}
                              <ArrowRight size={12} />
                            </Link>
                          )}
                          {isUnread && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              pill
                              disabled={busy || versionFailure(error)}
                              onClick={(event) => {
                                event.stopPropagation();
                                void mark(item);
                              }}
                            >
                              {t("markRead")}
                            </Button>
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
                  disabled={busy}
                  onChange={(nextPage) => {
                    if (!busy) {
                      setAll(null);
                      updateQuery({ page: String(nextPage) });
                    }
                  }}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
