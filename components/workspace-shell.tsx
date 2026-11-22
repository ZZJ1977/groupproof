"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Activity, Bell, BookOpen, CheckSquare, ChevronDown, ClipboardList, FileCheck, FileClock, FileText, Folder, GitBranch, Home, ListTree, LogOut, Menu, MessageSquare, Search, Settings, ShieldCheck, UserCog, UserRound, Users, X } from "lucide-react";
import { Avatar } from "@/components/common";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useApp } from "@/components/app-providers";
import { useWorkspace } from "@/lib/workspace";
import { useQuery } from "@tanstack/react-query";
import { apiMode } from "@/lib/api/config";
import { inboxApi } from "@/lib/api/c-inbox-client";
import { globalSearchApi, type SearchItemKind } from "@/lib/api/search-client";
import { mockService } from "@/lib/api/mock-service";
import { authClient } from "@/lib/api/auth-client";
import { resolveObjectContext, resolveCanonicalRouteContext, teacherNavItems } from "@/lib/ux/navigation";
import { projectNavGroups, type ProjectNavGroup } from "@/lib/ux/student-workspace";
import { tr } from "@/lib/i18n/tr";
import type { Role } from "@/types/domain";
import { cn } from "@/lib/utils";
import { AdminEnvironmentSwitcher } from "@/components/admin-environment-switcher";

type NavItem = { label: string; href: string; icon: typeof Home; ignoreSearch?: boolean };
type ProjectNavSectionGroup = Omit<ProjectNavGroup, "items"> & { items: NavItem[] };
type AdminNavGroup = { label: string; items: NavItem[] };

const iconByKey: Record<string, typeof Home> = {
  folder: Folder, fileClock: FileClock, fileText: FileText, clipboardList: ClipboardList,
  listTree: ListTree, fileCheck: FileCheck, shieldCheck: ShieldCheck, gitBranch: GitBranch,
  messageSquare: MessageSquare, users: Users, settings: Settings, home: Home, checkSquare: CheckSquare,
  userCog: UserCog, bell: Bell,
};

function NavLink({ item, label, pathname, search }: { item: NavItem; label: string; pathname: string; search: string }) {
  const Icon = item.icon;
  const [hrefPath, hrefSearch] = item.href.split("?");
  const active = hrefPath === pathname && (item.ignoreSearch ? true : !hrefSearch || hrefSearch === search);
  return <Link href={item.href} className={cn("gp-nav-link", active && "active")}><Icon size={17} strokeWidth={1.9} /><span>{label}</span></Link>;
}

export function WorkspaceShell({ children, kind }: { children: ReactNode; kind: "student" | "teacher" | "admin" }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
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
  const [openProjectGroups, setOpenProjectGroups] = useState<Record<string, boolean>>({ plan: true, collaborate: true, review: true });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const user = data.users.find((item) => item.id === data.currentUserId);
  const displayName = session?.user?.name || userName || (mockWorkspace ? user?.name : null) || "—";
  const canonicalContext = resolveCanonicalRouteContext(pathname);
  const mockShell = mockWorkspace && !canonicalContext.projectId && !canonicalContext.courseId;
  const context = mockShell ? resolveObjectContext(data, pathname) : canonicalContext;
  const defaultCourse = mockShell ? data.courses.find((item) => item.teacherId === data.currentUserId) ?? data.courses[0] : undefined;
  const navCourseId = context.courseId ?? defaultCourse?.id;
  const projectMode = kind === "student" && pathname.startsWith("/projects/") && Boolean(context.projectId);

  const globalLinks = [
    { key: "home", href: "/home", icon: Home },
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
    // 真实注销：撤销服务端会话并清理当前用户缓存，再回登录页
    try {
      await authClient.logout(session?.csrfToken);
    } finally {
      mockService.clearWorkspace();
      window.localStorage.removeItem("groupproof-v1-workspace");
      router.push("/login");
      router.refresh();
    }
  };

  return <div className={cn("gp-shell", kind === "student" && "gp-student-workspace", kind === "admin" && "gp-shell-admin")}>
    {mobileOpen && <button className="fixed inset-0 z-[25] bg-[#14233d]/30 md:hidden" aria-label={ts("closeMenu")} onClick={() => setMobileOpen(false)} />}
    <aside className={cn("gp-sidebar", kind === "admin" && "admin", mobileOpen && "open")}>
      <Link href={kind === "admin" ? "/admin" : kind === "teacher" && navCourseId ? `/teacher/courses/${navCourseId}` : "/home"} className="gp-brand" onClick={() => setMobileOpen(false)}><span className="gp-brand-mark" />{tc("appName")}</Link>
      {kind === "admin" && <div className="px-[22px] text-[11px] text-[#8fa4bf]">{t("admin")}</div>}
      {projectMode && <Link href={`/projects/${context.projectId}`} className="mx-3 mt-2 flex items-center gap-2 rounded-[6px] border border-[#e5ebf3] px-3 py-2 text-[12px] text-[#52627b]"><Folder size={16} className="text-[#246bfa]" /> {context.courseName ? `${context.courseName} · ` : ""}{context.projectName ?? ts("projectFallback")} <ChevronDown size={13} className="ml-auto" /></Link>}
      {kind === "teacher" && <Link href="/teacher/courses" onClick={() => setMobileOpen(false)} title={tr("我的班级")} className="mx-3 mt-2 flex items-center gap-2 rounded-[6px] border border-[#e5ebf3] px-3 py-2 text-[12px] text-[#52627b] hover:bg-[#f7f9fc]"><BookOpen size={15} className="shrink-0" /> <span className="truncate">{navCourseId ? (context.courseName ?? defaultCourse?.name ?? ts("courseFallback")) : tr("我的班级")}</span> <ChevronDown size={13} className="ml-auto shrink-0" /></Link>}
      <nav className="gp-nav" onClick={() => setMobileOpen(false)}>
        {kind === "admin" ? adminNavGroups.map((group) => <div className="gp-nav-group" key={group.label}>
          <div className="gp-nav-section" role="heading" aria-level={2}>{group.label}</div>
          {group.items.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchParams.toString()} />)}
        </div>) : projectMode ? <>
          <div className="gp-nav-section">{t("global")}</div>
          <NavLink item={globalNav[0]} label={globalNav[0].label} pathname={pathname} search="" />
          <NavLink item={globalNav[1]} label={globalNav[1].label} pathname={pathname} search="" />
          <div className="gp-nav-section">{t("currentProject")}</div>
          {projectGroups.map((group) => {
            const collapsible = group.id === "plan" || group.id === "collaborate" || group.id === "review";
            const open = openProjectGroups[group.id] !== false;
            if (!collapsible) return group.items.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchParams.toString()} />);
            const panelId = `project-nav-${group.id}`;
            return <div className="gp-nav-group" key={group.id}>
              <button
                type="button"
                className="gp-nav-group-toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenProjectGroups((current) => ({ ...current, [group.id]: !open }));
                }}
              >
                <span>{t(`projectGroups.${group.label}`)}</span>
                <ChevronDown size={14} aria-hidden="true" className={cn("gp-nav-group-chevron", open && "open")} />
              </button>
              {open && <div id={panelId} className="gp-nav-group-items">
                {group.items.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchParams.toString()} />)}
              </div>}
            </div>;
          })}
        </> : nav.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchParams.toString()} />)}
      </nav>
      <div className="gp-sidebar-footer">{ts("footer")}</div>
    </aside>
    <div className="gp-main">
      <header className="gp-topbar">
        <div className="gp-topbar-left">
          <button className="gp-icon-button gp-mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label={ts("openMenu")}>{mobileOpen ? <X size={19} /> : <Menu size={19} />}</button>
          <div ref={searchBoxRef} className="gp-search relative min-w-0 flex-1">
            <Search size={15} />
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
                className="absolute left-0 top-10 z-40 max-h-[360px] w-[min(380px,88vw)] overflow-y-auto rounded-[8px] border border-[#dfe6ee] bg-white p-1.5 shadow-lg"
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
        </div>
        <div className="gp-topbar-right">
          {kind === "admin" && <AdminEnvironmentSwitcher />}
          <LanguageSwitcher compact />
          <span className="gp-topbar-link hidden lg:inline">{ts("helpCenter")}</span>
          <Link href="/notifications" className="gp-icon-button relative" aria-label={ts("notifications")} title={unreadCount === null ? "未读数暂不可用" : `未读通知 ${unreadCount} 条`}><Bell size={18} />{unreadCount !== null && unreadCount > 0 && <span data-testid="unread-notification-dot" className="absolute right-[5px] top-[4px] h-[6px] w-[6px] rounded-full bg-[#ec4d5d]" />}</Link>
          <DropdownMenu><DropdownMenuTrigger className="flex items-center gap-2 rounded-[6px] px-1 py-1 text-[12px] text-[#42526e] hover:bg-[#f5f7fb]"><Avatar name={displayName} color={user?.avatarColor} size={28} /><span className="hidden lg:inline">{displayName}</span><ChevronDown size={13} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => router.push("/account")}><UserRound size={14} />{ts("accountCenter")}</DropdownMenuItem><DropdownMenuItem onSelect={() => router.push("/activity")}>{ts("myActivity")}</DropdownMenuItem><DropdownMenuItem onSelect={() => void logout()}><LogOut size={14} />{ts("logout")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          {demoMode && (
            <select className="hidden max-w-[86px] rounded-[5px] border border-[#e0e6ef] bg-white px-1.5 py-1.5 text-[11px] text-[#53637d] lg:inline" aria-label={ts("switchDemoRole")} title={ts("switchDemoRole")} value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {(["student", "leader", "teacher", "ta", "admin"] as Role[]).map((value) => <option key={value} value={value}>{ts(`roles.${value}`)}</option>)}
            </select>
          )}
        </div>
      </header>
      <main className="gp-content">{children}</main>
    </div>
  </div>;
}
