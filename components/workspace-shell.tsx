"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Activity, Bell, BookOpen, Boxes, CheckSquare, ChevronDown, ClipboardList, FileCheck, FileClock, FileText, Folder, GitBranch, Home, ListTree, Menu, MessageSquare, Search, Settings, ShieldCheck, Users, X } from "lucide-react";
import { Avatar } from "@/components/common";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/lib/workspace";
import type { Role } from "@/types/domain";
import { cn } from "@/lib/utils";

type NavItem = { label: string; href: string; icon: typeof Home };

const globalNav: NavItem[] = [
  { label: "首页", href: "/home", icon: Home },
  { label: "我的课程", href: "/courses", icon: BookOpen },
  { label: "待处理事项", href: "/action-items", icon: CheckSquare },
  { label: "通知", href: "/notifications", icon: Bell },
  { label: "个人动态", href: "/activity", icon: Activity },
];

const projectNav: NavItem[] = [
  { label: "项目总览", href: "/projects/project-1", icon: Folder },
  { label: "项目初始化", href: "/projects/project-1/setup", icon: FileClock },
  { label: "需求基线", href: "/projects/project-1/requirements", icon: FileText },
  { label: "任务规划", href: "/projects/project-1/planning", icon: ClipboardList },
  { label: "任务树", href: "/projects/project-1/tasks?view=tree", icon: ListTree },
  { label: "任务看板", href: "/projects/project-1/tasks?view=board", icon: Boxes },
  { label: "任务列表", href: "/projects/project-1/tasks?view=list", icon: CheckSquare },
  { label: "里程碑", href: "/projects/project-1/milestones", icon: FileCheck },
  { label: "证据中心", href: "/projects/project-1/evidence", icon: ShieldCheck },
  { label: "GitHub", href: "/projects/project-1/github", icon: GitBranch },
  { label: "协作记录", href: "/projects/project-1/collaboration", icon: MessageSquare },
  { label: "文件资料", href: "/projects/project-1/files", icon: Folder },
  { label: "讨论区", href: "/projects/project-1/discussions", icon: MessageSquare },
  { label: "贡献", href: "/projects/project-1/contribution", icon: Users },
  { label: "报告", href: "/projects/project-1/reports", icon: FileText },
  { label: "项目设置", href: "/projects/project-1/settings", icon: Settings },
];

const teacherNav: NavItem[] = [
  { label: "课程总览", href: "/teacher/courses/course-1", icon: Home },
  { label: "小组", href: "/teacher/courses/course-1/groups", icon: Users },
  { label: "待处理", href: "/teacher/courses/course-1/actions", icon: CheckSquare },
  { label: "报告", href: "/teacher/courses/course-1/reports", icon: FileText },
  { label: "课程设置", href: "/teacher/courses/course-1/settings", icon: Settings },
];

const adminNav: NavItem[] = [
  { label: "用户管理", href: "/admin/users", icon: Users },
  { label: "教师审核", href: "/admin/teacher-verifications", icon: ShieldCheck },
  { label: "课程管理", href: "/admin/courses", icon: BookOpen },
  { label: "系统日志", href: "/admin/logs", icon: FileClock },
  { label: "AI 使用情况", href: "/admin/ai-usage", icon: Activity },
  { label: "异常 / 访问审批", href: "/admin/access-requests", icon: ShieldCheck },
];

const roleLabels: Record<Role, string> = { student: "学生", leader: "组长", teacher: "教师", ta: "助教", admin: "管理员" };

function NavLink({ item, pathname, search }: { item: NavItem; pathname: string; search: string }) {
  const Icon = item.icon;
  const [hrefPath, hrefSearch] = item.href.split("?");
  const active = hrefPath === pathname && (!hrefSearch || hrefSearch === search);
  return <Link href={item.href} className={cn("gp-nav-link", active && "active")}><Icon size={17} strokeWidth={1.9} /><span>{item.label}</span></Link>;
}

export function WorkspaceShell({ children, kind }: { children: ReactNode; kind: "student" | "teacher" | "admin" }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useTranslations("app");
  const { data, role, setRole } = useWorkspace();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const user = data.users.find((item) => item.id === data.currentUserId);
  const projectMode = kind === "student" && pathname.startsWith("/projects/");
  const nav = kind === "admin" ? adminNav : kind === "teacher" ? teacherNav : projectMode ? projectNav : globalNav;
  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const term = search.toLowerCase();
    return [
      ...data.projects.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({ label: item.name, type: "项目", href: `/projects/${item.id}` })),
      ...data.tasks.filter((item) => item.title.toLowerCase().includes(term)).map((item) => ({ label: item.title, type: "任务", href: `/projects/${item.projectId}/tasks/${item.id}` })),
      ...data.courses.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({ label: item.name, type: "课程", href: "/courses" })),
    ].slice(0, 6);
  }, [data.courses, data.projects, data.tasks, search]);

  const switchRole = (next: Role) => {
    setRole(next);
    router.push(next === "admin" ? "/admin/users" : next === "teacher" || next === "ta" ? "/teacher/courses/course-1" : "/home");
  };

  return <div className="gp-shell">
    {mobileOpen && <button className="fixed inset-0 z-[25] bg-[#14233d]/30 md:hidden" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <aside className={cn("gp-sidebar", kind === "admin" && "admin", mobileOpen && "open")}>
      <Link href={kind === "admin" ? "/admin/users" : kind === "teacher" ? "/teacher/courses/course-1" : "/home"} className="gp-brand" onClick={() => setMobileOpen(false)}><span className="gp-brand-mark" />{t("name")}</Link>
      {kind === "admin" && <div className="px-[22px] text-[11px] text-[#8fa4bf]">管理后台</div>}
      {projectMode && <Link href="/projects/project-1" className="mx-3 mt-2 flex items-center gap-2 rounded-[6px] border border-[#e5ebf3] px-3 py-2 text-[12px] text-[#52627b]"><Folder size={16} className="text-[#246bfa]" /> 软件工程 · GroupProof <ChevronDown size={13} className="ml-auto" /></Link>}
      {kind === "teacher" && <div className="mx-3 mt-2 flex items-center gap-2 rounded-[6px] border border-[#e5ebf3] px-3 py-2 text-[12px] text-[#52627b]"><BookOpen size={15} /> 软件工程 · 2026 <ChevronDown size={13} className="ml-auto" /></div>}
      <nav className="gp-nav" onClick={() => setMobileOpen(false)}>
        {projectMode && <><div className="gp-nav-section">全局</div><NavLink item={globalNav[0]} pathname={pathname} search="" /><NavLink item={globalNav[1]} pathname={pathname} search="" /><div className="gp-nav-section">当前项目</div></>}
        {nav.map((item) => <NavLink key={item.href} item={item} pathname={pathname} search={searchParams.toString()} />)}
      </nav>
      <div className="gp-sidebar-footer">澳门科技大学 · 软件工程<br />GroupProof V1</div>
    </aside>
    <div className="gp-main">
      <header className="gp-topbar">
        <div className="gp-topbar-left">
          <button className="gp-icon-button gp-mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="打开导航">{mobileOpen ? <X size={19} /> : <Menu size={19} />}</button>
          <div className="gp-search relative"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索课程、项目或任务..." aria-label="全局搜索" />
            {search && <div className="absolute left-0 top-10 z-40 w-[min(340px,85vw)] rounded-[7px] border border-[#dfe6ee] bg-white p-1 shadow-lg">{searchResults.length ? searchResults.map((result) => <Link key={`${result.type}-${result.href}`} href={result.href} onClick={() => setSearch("")} className="flex gap-2 rounded-[4px] px-3 py-2 text-[12px] hover:bg-[#eef4ff]"><span className="w-8 text-[#8b99aa]">{result.type}</span><span className="truncate">{result.label}</span></Link>) : <div className="px-3 py-2 text-[12px] text-[#8b99aa]">无匹配结果</div>}</div>}
          </div>
        </div>
        <div className="gp-topbar-right">
          <span className="gp-topbar-link">帮助中心</span>
          <Link href="/notifications" className="gp-icon-button relative" aria-label="通知"><Bell size={18} />{data.notifications.some((item) => item.userId === data.currentUserId && !item.read) && <span className="absolute right-[5px] top-[4px] h-[6px] w-[6px] rounded-full bg-[#ec4d5d]" />}</Link>
          <DropdownMenu><DropdownMenuTrigger className="flex items-center gap-2 rounded-[6px] px-1 py-1 text-[12px] text-[#42526e] hover:bg-[#f5f7fb]"><Avatar name={user?.name ?? "用"} color={user?.avatarColor} size={28} /><span className="hidden sm:inline">{user?.name}</span><ChevronDown size={13} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => router.push("/onboarding/profile")}>个人资料</DropdownMenuItem><DropdownMenuItem onSelect={() => router.push("/activity")}>我的记录</DropdownMenuItem><DropdownMenuItem onSelect={() => router.push("/login")}>退出演示</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <select className="max-w-[86px] rounded-[5px] border border-[#e0e6ef] bg-white px-1.5 py-1.5 text-[11px] text-[#53637d]" aria-label="切换演示角色" title="切换演示角色" value={role} onChange={(event) => switchRole(event.target.value as Role)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
      </header>
      <main className="gp-content">{children}</main>
    </div>
  </div>;
}
