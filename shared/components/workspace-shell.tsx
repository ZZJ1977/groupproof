"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Activity, ArrowRight, Bell, BookOpen, Check, CheckSquare, ChevronDown, ClipboardList, FileCheck, FileClock, FileText, Folder, FolderKanban, GitBranch, Home, ListTree, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, ShieldCheck, UserCog, UserRound, Users, X } from "lucide-react";
import { Avatar } from "@/shared/components/common";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/shared/components/ui/dropdown-menu";
import { GpThemeScopeProvider } from "@/shared/components/ui/theme-scope";
import { LanguageSwitcher } from "@/shared/components/language-switcher";
import { useApp } from "@/shared/components/app-providers";
import { useWorkspace } from "@/shared/lib/workspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMode } from "@/shared/lib/api-config";
import { CApiError, createCClient } from "@/shared/daily-inbox/c-client";
import { inboxApi, inboxTargetHref } from "@/shared/daily-inbox/c-inbox-client";
import { globalSearchApi, type SearchItemKind } from "@/shared/daily-inbox/search-client";
import { mockService } from "@/shared/legacy-mock/api/mock-service";
import { authClient } from "@/shared/auth/auth-client";
import { resolveObjectContext, resolveCanonicalRouteContext, teacherNavItems } from "@/shared/lib/navigation";
import { projectNavGroups, type ProjectNavGroup } from "@/student/ux/student-workspace";
import { tr } from "@/shared/i18n/tr";
import type { Role } from "@/shared/types/domain";
import type { components } from "@/packages/domain/api.generated";
import { cn, formatDate } from "@/shared/lib/utils";
import { AdminEnvironmentSwitcher } from "@/admin/components/admin-environment-switcher";
import { TeacherWorkbenchProvider } from "@/teacher/components/TeacherWorkbenchContext";
import { TeacherQuickSwitcher } from "@/teacher/components/TeacherQuickSwitcher";

type NavItem = {
  label: string;
  href: string;
  icon: typeof Home;
  ignoreSearch?: boolean;
  matchPrefixes?: string[];
  badge?: number | null;
};
type ProjectNavSectionGroup = Omit<ProjectNavGroup, "items"> & { items: NavItem[] };
type AdminNavGroup = { label: string; items: NavItem[] };

const TEACHER_RAIL_STORAGE_KEY = "gp:teacher-rail-collapsed";

const iconByKey: Record<string, typeof Home> = {
  folder: Folder, fileClock: FileClock, fileText: FileText, clipboardList: ClipboardList,
  listTree: ListTree, fileCheck: FileCheck, shieldCheck: ShieldCheck, gitBranch: GitBranch,
  messageSquare: MessageSquare, users: Users, settings: Settings, home: Home, checkSquare: CheckSquare,
  userCog: UserCog, bell: Bell,
};

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const SIDEBAR_SCROLL_STORAGE_PREFIX = "gp-sidebar-scroll:";
const sidebarScrollMemory = new Map<string, number>();

function readSidebarScroll(scopeKey: string): number {
  const cached = sidebarScrollMemory.get(scopeKey);
  if (typeof cached === "number" && Number.isFinite(cached)) return cached;
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(`${SIDEBAR_SCROLL_STORAGE_PREFIX}${scopeKey}`);
    const parsed = raw === null ? 0 : Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      sidebarScrollMemory.set(scopeKey, parsed);
      return parsed;
    }
  } catch {
    // Ignore storage access failures in restricted environments.
  }
  return 0;
}

function writeSidebarScroll(scopeKey: string, top: number): void {
  const safeTop = Math.max(0, Math.round(top));
  sidebarScrollMemory.set(scopeKey, safeTop);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${SIDEBAR_SCROLL_STORAGE_PREFIX}${scopeKey}`, String(safeTop));
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
}

function NavLink({
  item,
  label,
  pathname,
  search,
  collapsed = false,
  badge,
}: {
  item: NavItem;
  label: string;
  pathname: string;
  search: string;
  collapsed?: boolean;
  badge?: number | null;
}) {
  const Icon = item.icon;
  const [hrefPath, hrefSearch] = item.href.split("?");
  const isPlanningAlias = hrefPath.endsWith("/tasks") && pathname === `${hrefPath.slice(0, -"/tasks".length)}/planning`;
  const exactActive = hrefPath === pathname && (item.ignoreSearch ? true : !hrefSearch || hrefSearch === search);
  const prefixActive = Boolean(
    item.matchPrefixes?.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)),
  );
  const active = isPlanningAlias || exactActive || prefixActive;
  const resolvedBadge = badge ?? item.badge;
  const hasBadge = typeof resolvedBadge === "number" && resolvedBadge > 0;
  const badgeText = hasBadge ? (resolvedBadge > 99 ? "99+" : String(resolvedBadge)) : null;

  return (
    <Link
      href={item.href}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn("gp-nav-link", active && "active")}
    >
      <span className="relative inline-flex shrink-0">
        <Icon size={15} strokeWidth={1.9} className="shrink-0" />
        {hasBadge && collapsed && (
          <span
            aria-hidden="true"
            className="hidden md:block absolute -right-1 -top-1 h-[7px] w-[7px] rounded-full bg-[#d93025] ring-2 ring-[var(--gp-rail-bg,#ffffff)]"
          />
        )}
      </span>
      <span className={cn("min-w-0 truncate", collapsed && "md:hidden")}>{label}</span>
      {badgeText && (
        <span
          className={cn(
            "gp-tabular ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#d93025] px-1.5 text-[10px] font-bold leading-none text-white",
            collapsed && "md:hidden",
          )}
        >
          {badgeText}
        </span>
      )}
    </Link>
  );
}

type Schema = components["schemas"];

function NotificationCenterPopover({
  userId,
  realInbox,
  unreadCount,
  pathname,
}: {
  userId: string;
  realInbox: boolean;
  unreadCount: number | null;
  pathname: string;
}) {
  const ts = useTranslations("shell");
  const ti = useTranslations("pages.inbox");
  const tc = useTranslations("common");
  const queryClient = useQueryClient();
  const { data, update } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"actions" | "notifications">("actions");
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const actionsQuery = useQuery({
    queryKey: ["c-shell-popover-actions", userId],
    queryFn: () => inboxApi.actionItems({ status: "pending", page: 1, page_size: 6 }),
    enabled: open && realInbox && activeTab === "actions",
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const notificationsQuery = useQuery({
    queryKey: ["c-shell-popover-notifications", userId],
    queryFn: () => inboxApi.notifications({ state: "all", category: "all", page: 1, page_size: 6 }),
    enabled: open && realInbox && activeTab === "notifications",
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const mockActions = useMemo(
    () => (realInbox ? [] : data.actionItems.filter((item) => item.assigneeId === data.currentUserId && item.status === "pending").slice(0, 6)),
    [data.actionItems, data.currentUserId, realInbox],
  );
  const mockNotifications = useMemo(
    () => (realInbox ? [] : data.notifications.filter((item) => item.userId === data.currentUserId).slice(0, 6)),
    [data.currentUserId, data.notifications, realInbox],
  );

  const pendingActionBadge = realInbox
    ? (actionsQuery.isSuccess ? actionsQuery.data.total : null)
    : data.actionItems.filter((item) => item.assigneeId === data.currentUserId && item.status === "pending").length;

  const markRealNotificationRead = async (item: Schema["NotificationDTO"]) => {
    if (!notificationsQuery.data || markingId) return;
    setMarkingId(item.id);
    setMarkError(null);
    const body: Schema["MarkNotificationRead"] = {
      expected_version: item.lock_version,
      expected_inbox_version: notificationsQuery.data.inbox_version,
      snapshot_id: notificationsQuery.data.snapshot_id,
    };
    const key = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `shell-read-${item.id}-${Date.now()}`;
    try {
      await inboxApi.markRead(item.id, body, key);
      void queryClient.invalidateQueries({ queryKey: ["c-inbox-unread", userId] });
      void queryClient.invalidateQueries({ queryKey: ["c-shell-popover-notifications", userId] });
      void queryClient.invalidateQueries({ queryKey: ["c-inbox-notifications", userId] });
    } catch (error) {
      if (error instanceof CApiError && (error.status === 401 || error.status === 403)) {
        queryClient.setQueryData(["c-inbox-blocked", userId], true);
        setMarkError(ti("failAccess"));
      } else if (error instanceof CApiError && error.status === 409) {
        setMarkError(ti("failVersion"));
      } else {
        setMarkError(ti("failDefault"));
      }
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <Link
        href="/notifications"
        role="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ts("notifications")}
        title={unreadCount === null ? "未读数暂不可用" : `未读通知 ${unreadCount} 条`}
        className="gp-icon-button relative"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          setMarkError(null);
          setOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          if (event.key === " ") {
            event.preventDefault();
            setMarkError(null);
            setOpen((prev) => !prev);
          }
        }}
      >
        <Bell size={18} />
        {unreadCount !== null && unreadCount > 0 && (
          <span
            data-testid="unread-notification-dot"
            className="absolute right-[5px] top-[4px] h-[6px] w-[6px] rounded-full bg-[#ec4d5d]"
          />
        )}
      </Link>

      {open && (
        <div
          role="dialog"
          aria-label={ts("notifications")}
          className="absolute right-0 top-10 z-50 w-[min(390px,92vw)] overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-3 py-2">
            <div role="tablist" className="inline-flex items-center gap-1 rounded-lg bg-slate-200/60 p-0.5">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "actions"}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  activeTab === "actions" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-600 hover:text-slate-900",
                )}
                onClick={() => {
                  setMarkError(null);
                  setActiveTab("actions");
                }}
              >
                <span>{ti("actionStatuses.pending")}</span>
                {pendingActionBadge !== null && pendingActionBadge > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.2 text-[10px] font-semibold tabular-nums text-amber-800">
                    {pendingActionBadge}
                  </span>
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "notifications"}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  activeTab === "notifications" ? "bg-white text-slate-900 shadow-2xs" : "text-slate-600 hover:text-slate-900",
                )}
                onClick={() => {
                  setMarkError(null);
                  setActiveTab("notifications");
                }}
              >
                <span>{ti("notificationsTitle")}</span>
                {unreadCount !== null && unreadCount > 0 && (
                  <span className="rounded-full bg-sky-100 px-1.5 py-0.2 text-[10px] font-semibold tabular-nums text-sky-800">
                    {unreadCount}
                  </span>
                )}
              </button>
            </div>
            <button
              type="button"
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-700"
              aria-label={tc("close")}
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </button>
          </div>

          {markError && (
            <div role="alert" className="border-b border-rose-100 bg-rose-50/70 px-3.5 py-2 text-[11px] text-rose-700">
              {markError}
            </div>
          )}

          <div className="max-h-[340px] overflow-y-auto divide-y divide-slate-100">
            {activeTab === "actions" ? (
              realInbox ? (
                actionsQuery.isFetching ? (
                  <div className="px-4 py-8 text-center text-xs text-slate-500">{ti("loadingActions")}</div>
                ) : actionsQuery.isError ? (
                  <div className="px-4 py-6 text-center text-xs text-rose-700">
                    <p>{ti("failUnavailable")}</p>
                    <button
                      type="button"
                      className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => void actionsQuery.refetch()}
                    >
                      {tc("retry")}
                    </button>
                  </div>
                ) : (actionsQuery.data?.items.length ?? 0) > 0 ? (
                  actionsQuery.data!.items.map((item) => {
                    const href = inboxTargetHref(item.target) ?? "/action-items";
                    return (
                      <Link
                        key={item.id}
                        href={href}
                        onClick={() => setOpen(false)}
                        className="flex items-start gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-slate-50"
                      >
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-slate-900">{item.title}</span>
                          {item.description && (
                            <span className="mt-0.5 block line-clamp-1 text-[11px] text-slate-500">{item.description}</span>
                          )}
                          <span className="mt-1 block text-[10px] text-slate-400">
                            {item.due_at ? ti("due", { date: formatDate(item.due_at) }) : ti("noDue")}
                          </span>
                        </span>
                        <ArrowRight size={13} className="mt-1 shrink-0 text-slate-400" />
                      </Link>
                    );
                  })
                ) : (
                  <div className="px-4 py-8 text-center text-xs text-slate-500">{ti("emptyActions")}</div>
                )
              ) : mockActions.length > 0 ? (
                mockActions.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href || "/action-items"}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-slate-50"
                  >
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-slate-900">{item.title}</span>
                      <span className="mt-0.5 block line-clamp-1 text-[11px] text-slate-500">{item.description}</span>
                    </span>
                    <ArrowRight size={13} className="mt-1 shrink-0 text-slate-400" />
                  </Link>
                ))
              ) : (
                <div className="px-4 py-8 text-center text-xs text-slate-500">{ti("emptyActions")}</div>
              )
            ) : realInbox ? (
              notificationsQuery.isFetching ? (
                <div className="px-4 py-8 text-center text-xs text-slate-500">{ti("loadingNotifications")}</div>
              ) : notificationsQuery.isError ? (
                <div className="px-4 py-6 text-center text-xs text-rose-700">
                  <p>{ti("failUnavailable")}</p>
                  <button
                    type="button"
                    className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => void notificationsQuery.refetch()}
                  >
                    {tc("retry")}
                  </button>
                </div>
              ) : (notificationsQuery.data?.items.length ?? 0) > 0 ? (
                notificationsQuery.data!.items.map((item) => {
                  const href = inboxTargetHref(item.target) ?? "/notifications";
                  const isUnread = !item.read_at;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-start gap-2.5 px-3.5 py-2.5 transition-colors",
                        isUnread ? "bg-sky-50/35 hover:bg-sky-50/60" : "hover:bg-slate-50",
                      )}
                    >
                      <span
                        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", isUnread ? "bg-sky-600" : "bg-slate-300")}
                        aria-hidden="true"
                      />
                      <Link href={href} onClick={() => setOpen(false)} className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-slate-900">{item.title}</span>
                        {item.description && (
                          <span className="mt-0.5 block line-clamp-1 text-[11px] text-slate-500">{item.description}</span>
                        )}
                        <span className="mt-1 block text-[10px] tabular-nums text-slate-400">{formatDate(item.created_at)}</span>
                      </Link>
                      {isUnread && (
                        <button
                          type="button"
                          disabled={markingId !== null}
                          title={ti("markRead")}
                          aria-label={ti("markRead")}
                          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-sky-200 bg-white text-sky-700 transition-colors hover:bg-sky-50 disabled:opacity-50"
                          onClick={() => void markRealNotificationRead(item)}
                        >
                          <Check size={12} />
                        </button>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="px-4 py-8 text-center text-xs text-slate-500">{ti("emptyNotifications")}</div>
              )
            ) : mockNotifications.length > 0 ? (
              mockNotifications.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-start gap-2.5 px-3.5 py-2.5 transition-colors",
                    !item.read ? "bg-sky-50/35 hover:bg-sky-50/60" : "hover:bg-slate-50",
                  )}
                >
                  <span
                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", !item.read ? "bg-sky-600" : "bg-slate-300")}
                    aria-hidden="true"
                  />
                  <Link href={item.href || "/notifications"} onClick={() => setOpen(false)} className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-slate-900">{item.title}</span>
                    <span className="mt-0.5 block line-clamp-1 text-[11px] text-slate-500">{item.description}</span>
                  </Link>
                  {!item.read && (
                    <button
                      type="button"
                      title={ti("markRead")}
                      aria-label={ti("markRead")}
                      className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-sky-200 bg-white text-sky-700 transition-colors hover:bg-sky-50"
                      onClick={() => update("notifications", item.id, { read: true })}
                    >
                      <Check size={12} />
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-xs text-slate-500">{ti("emptyNotifications")}</div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-3.5 py-2 text-xs">
            <Link
              href="/action-items"
              onClick={() => setOpen(false)}
              className="font-medium text-slate-600 transition-colors hover:text-[var(--gp-action)]"
            >
              {tr("全部待处理")}
            </Link>
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="font-medium text-[var(--gp-action)] transition-colors hover:text-[var(--gp-action-hover)]"
            >
              {tr("全部通知")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceShellInner({ children, kind }: { children: ReactNode; kind: "student" | "teacher" | "admin" }) {
  const isTeacher = kind === "teacher";
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const ts = useTranslations("shell");
  const { data, role, userId, userName, setRole, demoMode, mockWorkspace } = useWorkspace();
  const realInbox = apiMode("inbox") === "real";
  const inboxBlocked = useQuery({ queryKey: ["c-inbox-blocked", userId], queryFn: () => false,
    enabled: false, initialData: false });
  const unread = useQuery({ queryKey: ["c-inbox-unread", userId],
    queryFn: () => inboxApi.notifications({ page: 1, page_size: 1 }), enabled: realInbox,
    staleTime: 0, gcTime: 0, retry: false });
  const unreadCount = realInbox ? (!inboxBlocked.data && unread.isSuccess && !unread.isFetching ? unread.data.unread_total : null)
    : data.notifications.filter((item) => item.userId === data.currentUserId && !item.read).length;
  const { session } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [teacherSwitcherOpen, setTeacherSwitcherOpen] = useState(false);
  const [openProjectGroups, setOpenProjectGroups] = useState<Record<string, boolean>>({ plan: true, collaborate: true, review: true });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const restoringNavScrollRef = useRef(false);
  const searchString = searchParams.toString();
  const user = data.users.find((item) => item.id === data.currentUserId);
  const displayName = session?.user?.name || userName || (mockWorkspace ? user?.name : null) || "—";
  const canonicalContext = resolveCanonicalRouteContext(pathname);
  const mockShell = mockWorkspace && !(isTeacher && apiMode("bworkspace") === "real") && !canonicalContext.projectId && !canonicalContext.courseId;
  const context = mockShell ? resolveObjectContext(data, pathname) : canonicalContext;
  const defaultCourse = mockShell ? data.courses.find((item) => item.teacherId === data.currentUserId) ?? data.courses[0] : undefined;
  const navCourseId = context.courseId ?? defaultCourse?.id;
  const projectMode = kind === "student" && pathname.startsWith("/projects/") && Boolean(context.projectId);
  const isGlobalStudentTopNav = kind === "student" && !projectMode && role !== "teacher" && role !== "ta";

  useEffect(() => {
    if (!isTeacher) return;
    try {
      setRailCollapsed(window.localStorage.getItem(TEACHER_RAIL_STORAGE_KEY) === "1");
    } catch {
      // Ignore storage access failures.
    }
  }, [isTeacher]);

  useEffect(() => {
    if (!isTeacher) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (teacherSwitcherOpen) {
          event.preventDefault();
          setTeacherSwitcherOpen(false);
          return;
        }
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        const isEditable =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          Boolean(target?.isContentEditable);
        if (isEditable) return;
        event.preventDefault();
        setTeacherSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isTeacher, teacherSwitcherOpen]);

  const toggleRail = () => {
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(TEACHER_RAIL_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Ignore storage access failures.
      }
      return next;
    });
  };

  const teacherTopLinks: NavItem[] = useMemo(
    () => [{ label: t("home"), href: "/home", icon: Home }],
    [t],
  );
  const teacherTeachingLinks: NavItem[] = useMemo(() => {
    void locale;
    return [
      { label: tr("教师工作台"), href: "/teacher/dashboard", icon: Activity },
      {
        label: tr("我的班级"),
        href: "/teacher/courses",
        icon: BookOpen,
        matchPrefixes: ["/teacher/courses"],
      },
    ];
  }, [locale]);
  const teacherPersonalLinks: NavItem[] = useMemo(
    () => [
      { label: t("myCourses"), href: "/courses", icon: BookOpen, matchPrefixes: ["/courses/join"] },
      { label: t("actionItems"), href: "/action-items", icon: CheckSquare },
      { label: t("notifications"), href: "/notifications", icon: Bell, badge: unreadCount },
      { label: t("activity"), href: "/activity", icon: Activity },
    ],
    [t, unreadCount],
  );
  const topNavLinks = useMemo(
    () => [
      { href: "/home", label: t("home"), active: pathname === "/home" },
      { href: "/projects", label: t("myProjects"), active: pathname === "/projects" || pathname === "/projects/new" },
      { href: "/courses", label: t("myCourses"), active: pathname === "/courses" || pathname.startsWith("/courses/") },
    ],
    [pathname, t],
  );
  const sidebarScopeKey = projectMode && context.projectId
    ? `project:${context.projectId}`
    : kind === "teacher" && navCourseId
      ? `teacher:${navCourseId}`
      : `global:${kind}`;

  useIsomorphicLayoutEffect(() => {
    const navEl = navRef.current;
    if (!navEl) return;
    const savedTop = readSidebarScroll(sidebarScopeKey);
    const maxTop = Math.max(0, navEl.scrollHeight - navEl.clientHeight);
    const targetTop = Math.min(savedTop, maxTop);
    if (navEl.scrollTop !== targetTop) {
      restoringNavScrollRef.current = true;
      navEl.scrollTop = targetTop;
      restoringNavScrollRef.current = false;
    }
  }, [sidebarScopeKey, pathname, searchString]);

  const handleNavScroll = () => {
    if (restoringNavScrollRef.current || !navRef.current) return;
    writeSidebarScroll(sidebarScopeKey, navRef.current.scrollTop);
  };

  const persistCurrentNavScroll = () => {
    if (!navRef.current) return;
    writeSidebarScroll(sidebarScopeKey, navRef.current.scrollTop);
  };
  const cachedCContext = useQuery<{ project?: { name?: string } }>({
    queryKey: ["c-project-context", userId, context.projectId],
    queryFn: () => Promise.resolve({}),
    enabled: false,
  });
  const cachedBOverview = useQuery<{ name?: string; project?: { name?: string } }>({
    queryKey: ["b-project-overview", userId, context.projectId],
    queryFn: () => Promise.resolve({}),
    enabled: false,
  });
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const dailyClient = useMemo(() => createCClient(), []);
  const cachedHome = useQuery<{ projects?: { id: string; name: string }[] }>({
    queryKey: ["c-home-summary", userId],
    queryFn: () => dailyClient.homeSummary(),
    enabled: projectMode && switcherOpen && !mockShell && apiMode("daily") === "real",
    staleTime: 30_000,
    retry: false,
  });
  const switcherProjects = mockShell
    ? data.projects.map((item) => ({ id: item.id, name: item.name }))
    : (cachedHome.data?.projects ?? []);
  const resolvedProjectName =
    context.projectName ??
    (cachedCContext.status === "success" && !cachedCContext.error ? cachedCContext.data?.project?.name : undefined) ??
    (cachedBOverview.status === "success" && !cachedBOverview.error ? (cachedBOverview.data?.name ?? cachedBOverview.data?.project?.name) : undefined) ??
    (cachedCContext.status !== "error" && cachedBOverview.status !== "error"
      ? cachedHome.data?.projects?.find((item) => item.id === context.projectId)?.name
      : undefined);

  const globalLinks = [
    { key: "home", href: "/home", icon: Home },
    { key: "myProjects", href: "/projects", icon: FolderKanban },
    { key: "myCourses", href: "/courses", icon: BookOpen },
    { key: "actionItems", href: "/action-items", icon: CheckSquare },
    { key: "notifications", href: "/notifications", icon: Bell },
    { key: "activity", href: "/activity", icon: Activity },
  ];
  const globalNav: NavItem[] = globalLinks.map((item) => ({ label: t(item.key), href: item.href, icon: item.icon }));

  const adminNavGroups: AdminNavGroup[] = useMemo(() => kind === "admin" ? [
    {
      label: t("adminGroups.platform"),
      items: [
        { label: t("adminItems.overview"), href: "/admin", icon: Home },
        { label: t("adminItems.users"), href: "/admin/users", icon: Users },
        { label: t("adminItems.teacherVerifications"), href: "/admin/teacher-verifications", icon: ShieldCheck },
        { label: t("adminItems.courses"), href: "/admin/courses", icon: BookOpen },
        { label: t("adminItems.accessRequests"), href: "/admin/access-requests", icon: ShieldCheck },
      ],
    },
    {
      label: t("adminGroups.operations"),
      items: [
        { label: t("adminItems.logs"), href: "/admin/logs", icon: FileClock },
        { label: t("adminItems.aiUsage"), href: "/admin/ai-usage", icon: Activity },
      ],
    },
  ] : [], [kind, t]);

  const nav: NavItem[] = useMemo(() => {
    const map = (items: { label: string; href: string; iconKey: string }[], namespace: string): NavItem[] =>
      items.map((item) => ({
        label: t(`${namespace}.${item.label.toLowerCase()}`),
        href: item.href,
        icon: iconByKey[item.iconKey] ?? Folder,
        ignoreSearch: item.href.includes("?"),
      }));
    if (kind === "admin") return [];
    const teacherDashboard: NavItem = { label: tr("教师工作台"), href: "/teacher/dashboard", icon: Activity };
    const myClasses: NavItem = { label: tr("我的班级"), href: "/teacher/courses", icon: BookOpen };
    const teacherGlobal = role === "teacher" || role === "ta" ? [teacherDashboard, myClasses, ...globalNav] : globalNav;
    const isGlobalTeacherRoute = pathname === "/teacher/dashboard" || pathname === "/teacher/courses";
    if (kind === "teacher") return navCourseId && !isGlobalTeacherRoute ? map(teacherNavItems(navCourseId), "teacher") : [teacherDashboard, myClasses, ...globalNav];
    return teacherGlobal;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, navCourseId, projectMode, context.projectId, role, pathname, t]);

  const projectGroups: ProjectNavSectionGroup[] = useMemo(() => {
    if (!projectMode || !context.projectId) return [];
    return projectNavGroups(context.projectId).map((group) => ({
      ...group,
      items: group.items.map((item) => ({
        label: t(`project.${item.label.toLowerCase()}`),
        href: item.href,
        icon: iconByKey[item.iconKey] ?? Folder,
        ignoreSearch: item.href.includes("?"),
      })),
    }));
  }, [context.projectId, projectMode, t]);

  useEffect(() => {
    const trimmed = search.trim();
    if (!trimmed) {
      setDebouncedSearch("");
      setActiveIndex(-1);
      return;
    }
    const timer = window.setTimeout(() => setDebouncedSearch(trimmed), 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const searchKindLabel = (itemKind: SearchItemKind): string => {
    switch (itemKind) {
      case "course": return ts("searchTypeCourse");
      case "project": return ts("searchTypeProject");
      case "task": return ts("searchTypeTask");
      case "evidence": return ts("searchTypeEvidence");
      case "file": return ts("searchTypeFile");
      case "user": return ts("searchTypeUser");
    }
  };

  const remoteSearch = useQuery({
    queryKey: ["global-search", userId, debouncedSearch],
    queryFn: ({ signal }) => globalSearchApi.search(debouncedSearch, signal),
    enabled: !mockShell && debouncedSearch.length >= 1,
    staleTime: 10_000,
    retry: false,
  });

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    if (!mockShell) {
      return (remoteSearch.data?.items ?? []).map((item) => ({
        id: `${item.kind}-${item.id}`,
        label: item.title,
        subtitle: item.subtitle ?? null,
        type: searchKindLabel(item.kind),
        href: item.href,
      }));
    }
    const term = search.toLowerCase();
    return [
      ...data.projects.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({ id: `project-${item.id}`, label: item.name, subtitle: null, type: ts("searchTypeProject"), href: `/projects/${item.id}` })),
      ...data.tasks.filter((item) => item.title.toLowerCase().includes(term)).map((item) => ({ id: `task-${item.id}`, label: item.title, subtitle: null, type: ts("searchTypeTask"), href: `/projects/${item.projectId}/tasks/${item.id}` })),
      ...data.courses.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({ id: `course-${item.id}`, label: item.name, subtitle: null, type: ts("searchTypeCourse"), href: "/courses" })),
    ].slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.courses, data.projects, data.tasks, mockShell, remoteSearch.data, search, ts]);

  const logout = async () => {
    // 真实注销：先获取当前会话 CSRF token 撤销服务端会话，再清理本地状态回登录页
    try {
      const current = await authClient.session().catch(() => null);
      await authClient.logout(current?.csrfToken ?? session?.csrfToken);
    } catch {
      // 即使会话已失效仍继续清理本地状态并回登录页
    } finally {
      mockService.clearWorkspace();
      window.localStorage.removeItem("groupproof-v1-workspace");
      router.push("/login");
      router.refresh();
    }
  };

  const searchInputNode = (
    <div ref={searchBoxRef} className="gp-search relative min-w-0 flex-1">
      <Search size={15} className="shrink-0" />
      <input
        value={search}
        onFocus={() => setSearchOpen(true)}
        onChange={(event) => {
          setSearch(event.target.value);
          setSearchOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearchOpen(false);
            setActiveIndex(-1);
          } else if (event.key === "ArrowDown" && searchResults.length) {
            event.preventDefault();
            setSearchOpen(true);
            setActiveIndex((prev) => (prev + 1) % searchResults.length);
          } else if (event.key === "ArrowUp" && searchResults.length) {
            event.preventDefault();
            setSearchOpen(true);
            setActiveIndex((prev) => (prev <= 0 ? searchResults.length - 1 : prev - 1));
          } else if (event.key === "Enter" && activeIndex >= 0 && searchResults[activeIndex]) {
            event.preventDefault();
            const chosen = searchResults[activeIndex];
            setSearch("");
            setSearchOpen(false);
            setActiveIndex(-1);
            router.push(chosen.href);
          }
        }}
        placeholder={ts("searchPlaceholder")}
        aria-label={ts("searchLabel")}
      />
      {search && (
        <button
          type="button"
          className="rounded p-0.5 text-[#8b99aa] hover:text-[#42526e]"
          aria-label={tc("close")}
          onClick={() => {
            setSearch("");
            setDebouncedSearch("");
            setActiveIndex(-1);
          }}
        >
          <X size={13} />
        </button>
      )}
      {searchOpen && search.trim() && (
        <div
          role="listbox"
          aria-label={ts("searchLabel")}
          className={cn(
            "absolute top-10 z-40 max-h-[360px] w-[min(380px,88vw)] overflow-y-auto rounded-[8px] border border-[#dfe6ee] bg-white p-1.5 shadow-lg",
            isGlobalStudentTopNav ? "right-0" : "left-0",
          )}
        >
          {!mockShell && (debouncedSearch !== search.trim() || remoteSearch.isFetching) ? (
            <div className="px-3 py-2 text-[12px] text-[#8b99aa]" role="status">{ts("searching")}</div>
          ) : !mockShell && remoteSearch.isError ? (
            <div className="px-3 py-2 text-[12px] text-[#b91c1c]" role="alert">{ts("searchError")}</div>
          ) : searchResults.length ? (
            searchResults.map((result, index) => (
              <Link
                key={result.id}
                role="option"
                aria-selected={index === activeIndex}
                href={result.href}
                onClick={() => {
                  setSearch("");
                  setSearchOpen(false);
                  setActiveIndex(-1);
                }}
                className={cn(
                  "flex items-center gap-2.5 rounded-[5px] px-3 py-2 text-[12px] hover:bg-[#eef4ff]",
                  index === activeIndex && "bg-[#eef4ff]",
                )}
              >
                <span className="shrink-0 rounded bg-[#f2f5fa] px-1.5 py-0.5 text-[11px] font-medium text-[#53637d]">{result.type}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[#17243c]">{result.label}</span>
                  {result.subtitle && <span className="block truncate text-[11px] text-[#7b899e]">{result.subtitle}</span>}
                </span>
              </Link>
            ))
          ) : (
            <div className="px-3 py-2 text-[12px] text-[#8b99aa]">{ts("searchNoResult")}</div>
          )}
        </div>
      )}
    </div>
  );

  return <div className={cn("gp-shell", kind === "student" && "gp-student-workspace", isGlobalStudentTopNav && "gp-shell-topnav", kind === "admin" && "gp-shell-admin", isTeacher && "gp-teacher-shell")}>
    {!isGlobalStudentTopNav && mobileOpen && <button className="fixed inset-0 z-[25] bg-[#14233d]/30 md:hidden" aria-label={ts("closeMenu")} onClick={() => setMobileOpen(false)} />}
    {!isGlobalStudentTopNav && <aside className={cn("gp-sidebar", kind === "admin" && "admin", mobileOpen && "open", isTeacher && railCollapsed && "is-collapsed")}>
      <div className="gp-sidebar-header">
        {isTeacher ? (
          <div className="gp-teacher-rail-head flex items-center justify-between gap-1 pr-2">
            <Link
              href="/home"
              className="gp-brand min-w-0 flex-1"
              onClick={() => setMobileOpen(false)}
              title={tc("appName")}
            >
              <span className="gp-brand-mark shrink-0" />
              <span className={cn("gp-brand-label truncate", railCollapsed && "md:hidden")}>{tc("appName")}</span>
            </Link>
            <button
              type="button"
              onClick={toggleRail}
              aria-label={railCollapsed ? tr("展开导航栏") : tr("收起导航栏")}
              title={railCollapsed ? tr("展开导航栏") : tr("收起导航栏")}
              className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-[var(--gp-muted,#646a73)] transition-colors hover:bg-[var(--gp-surface-hover,#eff0f1)] hover:text-[var(--gp-ink,#1f2329)] md:inline-flex"
            >
              {railCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </div>
        ) : (
          <Link href={kind === "admin" ? "/admin" : "/home"} className="gp-brand" onClick={() => setMobileOpen(false)}><span className="gp-brand-mark" />{tc("appName")}</Link>
        )}
        {kind === "admin" && <div className="px-[20px] pb-2 text-[11px] text-[#8fa4bf]">{t("admin")}</div>}
        {projectMode && <DropdownMenu open={switcherOpen} onOpenChange={setSwitcherOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="mx-3 mb-2.5 flex w-[calc(100%-24px)] items-center gap-2 rounded-lg border border-slate-200/90 bg-slate-50 px-2.5 py-1.5 text-left text-[12px] font-medium text-slate-700 transition-colors hover:border-slate-300/90 hover:bg-slate-100"
            >
              <Folder size={14} className="shrink-0 text-[var(--gp-action)]" />
              <span className="truncate">{context.courseName ? `${context.courseName} · ` : ""}{resolvedProjectName ?? ts("projectFallback")}</span>
              <ChevronDown size={13} className="ml-auto shrink-0 text-slate-400" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[236px]">
            <DropdownMenuItem asChild>
              <Link href={`/projects/${context.projectId}`} onClick={() => setMobileOpen(false)}>
                <Folder size={14} className="mr-2 text-[var(--gp-action)]" />
                <span className="truncate font-medium">{resolvedProjectName ?? ts("projectFallback")}</span>
                <Check size={13} className="ml-auto text-[var(--gp-action)]" />
              </Link>
            </DropdownMenuItem>
            {switcherProjects.filter((item) => item.id !== context.projectId).length > 0 && (
              <>
                <div className="my-1 h-px bg-slate-100" />
                {switcherProjects
                  .filter((item) => item.id !== context.projectId)
                  .map((item) => (
                    <DropdownMenuItem key={item.id} asChild>
                      <Link href={`/projects/${encodeURIComponent(item.id)}`} onClick={() => setMobileOpen(false)}>
                        <Folder size={14} className="mr-2 text-slate-400" />
                        <span className="truncate">{item.name}</span>
                      </Link>
                    </DropdownMenuItem>
                  ))}
              </>
            )}
            <div className="my-1 h-px bg-slate-100" />
            <DropdownMenuItem asChild>
              <Link href="/projects/new" onClick={() => setMobileOpen(false)}>
                <Plus size={14} className="mr-2 text-[var(--gp-action)]" />
                <span>新建项目</span>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
      <nav
        ref={navRef}
        className="gp-nav"
        onScroll={handleNavScroll}
        onPointerDown={persistCurrentNavScroll}
        onClick={() => {
          persistCurrentNavScroll();
          setMobileOpen(false);
        }}
      >
        {isTeacher ? (
          <>
            {teacherTopLinks.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                label={item.label}
                pathname={pathname}
                search={searchString}
                collapsed={railCollapsed}
              />
            ))}
            <div className={cn("gp-nav-section", railCollapsed && "md:hidden")}>
              {tr("教学")}
            </div>
            {teacherTeachingLinks.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                label={item.label}
                pathname={pathname}
                search={searchString}
                collapsed={railCollapsed}
              />
            ))}
            <div className={cn("gp-nav-section", railCollapsed && "md:hidden")}>
              {tr("个人")}
            </div>
            {teacherPersonalLinks.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                label={item.label}
                pathname={pathname}
                search={searchString}
                collapsed={railCollapsed}
                badge={item.badge}
              />
            ))}
          </>
        ) : kind === "admin" ? adminNavGroups.map((group) => <div className="gp-nav-group" key={group.label}>
          <div className="gp-nav-section" role="heading" aria-level={2}>{group.label}</div>
          {group.items.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchString} />)}
        </div>) : projectMode ? <>
          <div className="gp-nav-section">{t("global")}</div>
          <NavLink item={globalNav[0]} label={globalNav[0].label} pathname={pathname} search="" />
          <NavLink item={globalNav[1]} label={globalNav[1].label} pathname={pathname} search="" />
          <NavLink item={globalNav[2]} label={globalNav[2].label} pathname={pathname} search="" />
          <div className="gp-nav-section">{t("currentProject")}</div>
          {projectGroups.map((group) => {
            const collapsible = group.id === "plan" || group.id === "collaborate" || group.id === "review";
            const open = openProjectGroups[group.id] !== false;
            if (!collapsible) return group.items.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchString} />);
            const panelId = `project-nav-${group.id}`;
            return <div className="gp-nav-group" key={group.id}>
              <button
                type="button"
                className="gp-nav-group-toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={(event) => {
                  event.stopPropagation();
                  persistCurrentNavScroll();
                  setOpenProjectGroups((current) => ({ ...current, [group.id]: !open }));
                }}
              >
                <span>{t(`projectGroups.${group.label}`)}</span>
                <ChevronDown size={13} aria-hidden="true" className={cn("gp-nav-group-chevron", open && "open")} />
              </button>
              {open && <div id={panelId} className="gp-nav-group-items">
                {group.items.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchString} />)}
              </div>}
            </div>;
          })}
        </> : nav.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchString} />)}
      </nav>
    </aside>}
    <div className="gp-main">
      <header className="gp-topbar">
        <div className={cn("gp-topbar-inner", isGlobalStudentTopNav && "gp-topbar-inner-centered")}>
          <div className={cn("gp-topbar-left", isTeacher && "min-w-0 flex-1")}>
            <button
              type="button"
              className="gp-icon-button gp-mobile-menu"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label={mobileOpen ? ts("closeMenu") : ts("openMenu")}
              title={mobileOpen ? ts("closeMenu") : ts("openMenu")}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X size={19} /> : <Menu size={19} />}
            </button>
            {isTeacher ? (
              <button
                type="button"
                onClick={() => setTeacherSwitcherOpen(true)}
                aria-label={tr("快速跳转")}
                className="flex h-9 w-full max-w-[360px] min-w-0 items-center gap-2 rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3 text-left text-xs text-[var(--gp-muted,#646a73)] transition-colors hover:border-[#c9ced6] hover:bg-white hover:text-[var(--gp-ink,#1f2329)]"
              >
                <Search size={15} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{tr("搜索班级、模块或学生...")}</span>
                <kbd className="hidden rounded border border-[var(--gp-border,#dee0e3)] bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--gp-muted,#646a73)] sm:inline">
                  ⌘K
                </kbd>
              </button>
            ) : isGlobalStudentTopNav ? (
              <>
                <Link href="/home" className="gp-topnav-brand" onClick={() => setMobileOpen(false)}>
                  <span className="gp-brand-mark" />
                  <span>{tc("appName")}</span>
                </Link>
                <nav aria-label={t("global")} className="gp-topnav-links">
                  {topNavLinks.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={item.active ? "page" : undefined}
                      className={cn("gp-topnav-link", item.active && "active")}
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
              </>
            ) : (
              searchInputNode
            )}
          </div>
          <div className={cn("gp-topbar-right", isTeacher && "shrink-0")}>
            {isGlobalStudentTopNav && searchInputNode}
            {kind === "admin" && <AdminEnvironmentSwitcher />}
            <LanguageSwitcher compact />
            {!isTeacher && <span className={cn("gp-topbar-link hidden", isGlobalStudentTopNav ? "xl:inline" : "lg:inline")}>{ts("helpCenter")}</span>}
            {isTeacher ? (
              <Link
                href="/notifications"
                className="gp-icon-button relative"
                aria-label={ts("notifications")}
                title={unreadCount === null ? tr("未读数暂不可用") : tr("未读通知 {0} 条", { 0: unreadCount })}
              >
                <Bell size={18} />
                {unreadCount !== null && unreadCount > 0 && (
                  <span
                    data-testid="unread-notification-dot"
                    className="absolute right-[5px] top-[4px] h-[6px] w-[6px] rounded-full bg-[#ec4d5d]"
                  />
                )}
              </Link>
            ) : (
              <NotificationCenterPopover userId={userId} realInbox={realInbox} unreadCount={unreadCount} pathname={pathname} />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={ts("accountCenter")} title={ts("accountCenter")} className="flex shrink-0 items-center gap-2 rounded-[6px] px-1 py-1 text-[12px] text-[#42526e] hover:bg-[#f5f7fb]">
                <Avatar name={displayName} color={user?.avatarColor} size={28} />
                <span className="hidden lg:inline">{displayName}</span>
                <ChevronDown size={13} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={cn(isTeacher && "gp-teacher-portal")}>
                <DropdownMenuItem onSelect={() => router.push("/account")}>
                  <UserRound size={14} />{ts("accountCenter")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push("/activity")}>
                  <Activity size={14} />{t("activity")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void logout()}>
                  <LogOut size={14} />{ts("logout")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {demoMode && (
              <select className="hidden max-w-[86px] rounded-[5px] border border-[#e0e6ef] bg-white px-1.5 py-1.5 text-[11px] text-[#53637d] lg:inline" aria-label={ts("switchDemoRole")} title={ts("switchDemoRole")} value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {(["student", "leader", "teacher", "ta", "admin"] as Role[]).map((value) => <option key={value} value={value}>{ts(`roles.${value}`)}</option>)}
              </select>
            )}
          </div>
        </div>
      </header>
      {isGlobalStudentTopNav && mobileOpen && (
        <nav aria-label={t("global")} className="gp-topnav-mobile-drawer">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-2.5">
            {topNavLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                onClick={() => setMobileOpen(false)}
                className={cn("gp-nav-link", item.active && "active")}
              >
                <span>{item.label}</span>
              </Link>
            ))}
            <div className="my-1 h-px bg-slate-100" />
            <Link href="/action-items" onClick={() => setMobileOpen(false)} className={cn("gp-nav-link", pathname === "/action-items" && "active")}>
              <CheckSquare size={15} className="shrink-0" />
              <span>{t("actionItems")}</span>
            </Link>
            <Link href="/notifications" onClick={() => setMobileOpen(false)} className={cn("gp-nav-link", pathname === "/notifications" && "active")}>
              <Bell size={15} className="shrink-0" />
              <span>{t("notifications")}</span>
            </Link>
            <Link href="/activity" onClick={() => setMobileOpen(false)} className={cn("gp-nav-link", pathname === "/activity" && "active")}>
              <Activity size={15} className="shrink-0" />
              <span>{t("activity")}</span>
            </Link>
          </div>
        </nav>
      )}
      <main className="gp-content">{children}</main>
    </div>
    {isTeacher && (
      <TeacherQuickSwitcher
        open={teacherSwitcherOpen}
        onOpenChange={setTeacherSwitcherOpen}
        navCourseId={navCourseId}
        mockShell={mockShell}
        mockCourses={data.courses}
      />
    )}
  </div>;
}

export function WorkspaceShell({ children, kind }: { children: ReactNode; kind: "student" | "teacher" | "admin" }) {
  const isTeacher = kind === "teacher";
  return (
    <GpThemeScopeProvider scope={isTeacher ? "teacher" : "default"}>
      {isTeacher ? (
        <TeacherWorkbenchProvider>
          <WorkspaceShellInner kind={kind}>{children}</WorkspaceShellInner>
        </TeacherWorkbenchProvider>
      ) : (
        <WorkspaceShellInner kind={kind}>{children}</WorkspaceShellInner>
      )}
    </GpThemeScopeProvider>
  );
}
