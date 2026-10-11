"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Activity, Bell, BookOpen, CheckSquare, ChevronDown, ClipboardList, FileCheck, FileClock, FileText, Folder, GitBranch, Home, ListTree, LogOut, Menu, MessageSquare, Search, Settings, ShieldCheck, UserRound, Users, X } from "lucide-react";
import { Avatar } from "@/components/common";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useApp } from "@/components/app-providers";
import { useWorkspace } from "@/lib/workspace";
import { mockService } from "@/lib/api/mock-service";
import { authClient } from "@/lib/api/auth-client";
import { projectNavItems, resolveObjectContext, teacherNavItems } from "@/lib/ux/navigation";
import type { Role } from "@/types/domain";
import { cn } from "@/lib/utils";

type NavItem = { label: string; href: string; icon: typeof Home; ignoreSearch?: boolean };

const iconByKey: Record<string, typeof Home> = {
  folder: Folder, fileClock: FileClock, fileText: FileText, clipboardList: ClipboardList,
  listTree: ListTree, fileCheck: FileCheck, shieldCheck: ShieldCheck, gitBranch: GitBranch,
  messageSquare: MessageSquare, users: Users, settings: Settings, home: Home, checkSquare: CheckSquare,
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
  const { data, role, setRole, demoMode } = useWorkspace();
  const { session } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const user = data.users.find((item) => item.id === data.currentUserId);
  const displayName = session?.user?.name || user?.name || "—";
  const context = resolveObjectContext(data, pathname);
  const defaultCourse = data.courses.find((item) => item.teacherId === data.currentUserId) ?? data.courses[0];
  const navCourseId = context.courseId ?? defaultCourse?.id ?? "course-1";
  const projectMode = kind === "student" && pathname.startsWith("/projects/") && Boolean(context.projectId);

  const globalLinks = [
    { key: "home", href: "/home", icon: Home },
    { key: "myCourses", href: "/courses", icon: BookOpen },
    { key: "actionItems", href: "/action-items", icon: CheckSquare },
    { key: "notifications", href: "/notifications", icon: Bell },
    { key: "activity", href: "/activity", icon: Activity },
  ];
  const globalNav: NavItem[] = globalLinks.map((item) => ({ label: t(item.key), href: item.href, icon: item.icon }));

  const nav: NavItem[] = useMemo(() => {
    const map = (items: { label: string; href: string; iconKey: string }[], namespace: string): NavItem[] =>
      items.map((item) => ({
        label: t(`${namespace}.${item.label.toLowerCase()}`),
        href: item.href,
        icon: iconByKey[item.iconKey] ?? Folder,
        ignoreSearch: item.href.includes("?"),
      }));
    if (kind === "admin") {
      return [
        { label: t("adminItems.users"), href: "/admin/users", icon: Users },
        { label: t("adminItems.teacherVerifications"), href: "/admin/teacher-verifications", icon: ShieldCheck },
        { label: t("adminItems.courses"), href: "/admin/courses", icon: BookOpen },
        { label: t("adminItems.logs"), href: "/admin/logs", icon: FileClock },
        { label: t("adminItems.aiUsage"), href: "/admin/ai-usage", icon: Activity },
        { label: t("adminItems.accessRequests"), href: "/admin/access-requests", icon: ShieldCheck },
      ];
    }
    if (kind === "teacher") return map(teacherNavItems(navCourseId), "teacher");
    return projectMode ? map(projectNavItems(context.projectId as string), "project") : globalNav;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, navCourseId, projectMode, context.projectId, t]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const term = search.toLowerCase();
    return [
      ...data.projects.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({ label: item.name, type: ts("searchTypeProject"), href: `/projects/${item.id}` })),
      ...data.tasks.filter((item) => item.title.toLowerCase().includes(term)).map((item) => ({ label: item.title, type: ts("searchTypeTask"), href: `/projects/${item.projectId}/tasks/${item.id}` })),
      ...data.courses.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({ label: item.name, type: ts("searchTypeCourse"), href: "/courses" })),
    ].slice(0, 6);
  }, [data.courses, data.projects, data.tasks, search, ts]);

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

  return <div className="gp-shell">
    {mobileOpen && <button className="fixed inset-0 z-[25] bg-[#14233d]/30 md:hidden" aria-label={ts("closeMenu")} onClick={() => setMobileOpen(false)} />}
    <aside className={cn("gp-sidebar", kind === "admin" && "admin", mobileOpen && "open")}>
      <Link href={kind === "admin" ? "/admin/users" : kind === "teacher" ? `/teacher/courses/${navCourseId}` : "/home"} className="gp-brand" onClick={() => setMobileOpen(false)}><span className="gp-brand-mark" />{tc("appName")}</Link>
      {kind === "admin" && <div className="px-[22px] text-[11px] text-[#8fa4bf]">{t("admin")}</div>}
      {projectMode && <Link href={`/projects/${context.projectId}`} className="mx-3 mt-2 flex items-center gap-2 rounded-[6px] border border-[#e5ebf3] px-3 py-2 text-[12px] text-[#52627b]"><Folder size={16} className="text-[#246bfa]" /> {context.courseName ? `${context.courseName} · ` : ""}{context.projectName ?? ts("projectFallback")} <ChevronDown size={13} className="ml-auto" /></Link>}
      {kind === "teacher" && <div className="mx-3 mt-2 flex items-center gap-2 rounded-[6px] border border-[#e5ebf3] px-3 py-2 text-[12px] text-[#52627b]"><BookOpen size={15} /> {context.courseName ?? defaultCourse?.name ?? ts("courseFallback")} <ChevronDown size={13} className="ml-auto" /></div>}
      <nav className="gp-nav" onClick={() => setMobileOpen(false)}>
        {projectMode && <><div className="gp-nav-section">{t("global")}</div><NavLink item={globalNav[0]} label={globalNav[0].label} pathname={pathname} search="" /><NavLink item={globalNav[1]} label={globalNav[1].label} pathname={pathname} search="" /><div className="gp-nav-section">{t("currentProject")}</div></>}
        {nav.map((item) => <NavLink key={item.href} item={item} label={item.label} pathname={pathname} search={searchParams.toString()} />)}
      </nav>
      <div className="gp-sidebar-footer">{ts("footer")}</div>
    </aside>
    <div className="gp-main">
      <header className="gp-topbar">
        <div className="gp-topbar-left">
          <button className="gp-icon-button gp-mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label={ts("openMenu")}>{mobileOpen ? <X size={19} /> : <Menu size={19} />}</button>
          <div className="gp-search relative min-w-0 flex-1"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={ts("searchPlaceholder")} aria-label={ts("searchLabel")} />
            {search && <div className="absolute left-0 top-10 z-40 w-[min(340px,85vw)] rounded-[7px] border border-[#dfe6ee] bg-white p-1 shadow-lg">{searchResults.length ? searchResults.map((result) => <Link key={`${result.type}-${result.href}`} href={result.href} onClick={() => setSearch("")} className="flex gap-2 rounded-[4px] px-3 py-2 text-[12px] hover:bg-[#eef4ff]"><span className="w-8 text-[#8b99aa]">{result.type}</span><span className="truncate">{result.label}</span></Link>) : <div className="px-3 py-2 text-[12px] text-[#8b99aa]">{ts("searchNoResult")}</div>}</div>}
          </div>
        </div>
        <div className="gp-topbar-right">
          <LanguageSwitcher compact />
          <span className="gp-topbar-link hidden lg:inline">{ts("helpCenter")}</span>
          <Link href="/notifications" className="gp-icon-button relative" aria-label={ts("notifications")}><Bell size={18} />{data.notifications.some((item) => item.userId === data.currentUserId && !item.read) && <span className="absolute right-[5px] top-[4px] h-[6px] w-[6px] rounded-full bg-[#ec4d5d]" />}</Link>
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
