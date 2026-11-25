"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckSquare,
  ChevronDown,
  ClipboardList,
  Copy,
  Folder,
  Home,
  KeyRound,
  ListTree,
  MoreHorizontal,
  Settings,
  Shield,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import "@/shared/styles/lux-teacher.css";
import { MorphNav, type MorphNavItem, useHubSlideDirection } from "@/shared/components/lux/MorphNav";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { errorText } from "@/shared/lib/b-ui";
import { tr } from "@/shared/i18n/tr";
import { cn } from "@/shared/lib/utils";
import { useWorkspace } from "@/shared/lib/workspace";
import { teacherActionsApi, teacherActionsKeys } from "@/teacher/api/teacher-actions-client";
import { type RosterStudent, teacherClassesApi, teacherKeys } from "@/teacher/api/teacher-client";
import { ClassRosterSidebar } from "@/teacher/components/ClassRosterSidebar";
import { InviteCodeCard } from "@/teacher/components/InviteCodeCard";
import { StudentProfileDrawer } from "@/teacher/components/StudentProfileDrawer";
import { useTeacherWorkbench } from "@/teacher/components/TeacherWorkbenchContext";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";

export type TeacherCourseLegacyTab =
  | "home"
  | "groups"
  | "detail"
  | "actions"
  | "member-changes"
  | "appeals"
  | "projects"
  | "reports"
  | "settings"
  | "rules"
  | "files"
  | "announcements"
  | "staff";

type HubId = "home" | "groups" | "actions" | "projects" | "settings";

const HUB_IDS: readonly HubId[] = ["home", "groups", "actions", "projects", "settings"];
const ROSTER_STORAGE_KEY = "gp-teacher-roster-open";
const EMPTY_ROSTER: RosterStudent[] = [];

const statusLabels: Record<string, string> = {
  active: "进行中",
  ended: "已结课",
  draft: "草稿",
  pending_approval: "待审批",
  archived: "已归档",
};

function resolveActiveHub(tab: TeacherCourseLegacyTab): HubId {
  if (tab === "home") return "home";
  if (tab === "groups" || tab === "detail") return "groups";
  if (tab === "actions" || tab === "member-changes" || tab === "appeals") return "actions";
  if (tab === "projects" || tab === "reports") return "projects";
  return "settings";
}

export function TeacherClassLayout({
  courseId,
  activeTab,
  children,
}: {
  courseId: string;
  activeTab: TeacherCourseLegacyTab;
  children: ReactNode;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const { registerCourseDetail, registerRoster, clearCourseContext } = useTeacherWorkbench();

  const [isXlDesktop, setIsXlDesktop] = useState(false);
  const [desktopRosterOpen, setDesktopRosterOpen] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [quickStudent, setQuickStudent] = useState<RosterStudent | null>(null);
  const [quickDrawerOpen, setQuickDrawerOpen] = useState(false);
  const [quickDrawerError, setQuickDrawerError] = useState<string | undefined>();
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    try {
      setDesktopRosterOpen(window.localStorage.getItem(ROSTER_STORAGE_KEY) === "1");
    } catch {
      // Ignore storage access failures.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 1280px)");
    const sync = () => {
      const matches = mql.matches;
      setIsXlDesktop(matches);
      if (matches) setMobileSheetOpen(false);
    };
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  const badgeQuery = useQuery({
    queryKey: teacherActionsKeys.badge(userId, courseId),
    queryFn: () => teacherActionsApi.list(courseId, { status: "pending", page: 1, page_size: 1 }),
    enabled: Boolean(courseId),
    refetchInterval: 60_000,
    retry: false,
  });
  const pendingActions = badgeQuery.data?.pending_count ?? 0;

  const detail = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
    retry: false,
  });

  const classesQuery = useQuery({
    queryKey: teacherKeys.classes(userId, "all", ""),
    queryFn: () => teacherClassesApi.list("all", ""),
    enabled: Boolean(courseId),
    staleTime: 60_000,
    retry: false,
  });

  const sortedClasses = [...(classesQuery.data?.items ?? [])].sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (a.status !== "active" && b.status === "active") return 1;
    return 0;
  });

  const roster = useQuery({
    queryKey: teacherKeys.roster(userId, courseId, "all", ""),
    queryFn: () => teacherClassesApi.roster(courseId, "all", ""),
    enabled: Boolean(courseId),
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    registerCourseDetail(courseId, detail.data);
  }, [courseId, detail.data, registerCourseDetail]);

  useEffect(() => {
    const items = roster.data?.items ?? EMPTY_ROSTER;
    registerRoster(courseId, items, (student) => {
      setQuickDrawerError(undefined);
      setQuickStudent(student);
      setQuickDrawerOpen(true);
    });
  }, [courseId, roster.data?.items, registerRoster]);

  useEffect(() => {
    return () => {
      clearCourseContext(courseId);
    };
  }, [courseId, clearCourseContext]);

  const rotateInvite = useMutation({
    mutationFn: () =>
      teacherClassesApi.rotateInvite(courseId, detail.data?.lock_version ?? 0),
    onSuccess: async () => {
      setRotateError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
        qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] }),
      ]);
    },
    onError: (err) => {
      setRotateError(errorText(err));
    },
  });

  const removeQuickStudent = useMutation({
    mutationFn: ({ studentId, reason }: { studentId: string; reason: string }) =>
      teacherClassesApi.removeStudent(courseId, studentId, reason),
    onSuccess: async () => {
      setQuickDrawerOpen(false);
      setQuickDrawerError(undefined);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
        qc.invalidateQueries({ queryKey: teacherKeys.plaza(userId, courseId) }),
        qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
        qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] }),
      ]);
    },
    onError: (err) => {
      setQuickDrawerError(errorText(err));
    },
  });

  const toggleRoster = () => {
    if (isXlDesktop) {
      setDesktopRosterOpen((prev) => {
        const next = !prev;
        try {
          window.localStorage.setItem(ROSTER_STORAGE_KEY, next ? "1" : "0");
        } catch {
          // Ignore storage access failures.
        }
        return next;
      });
    } else {
      setMobileSheetOpen((prev) => !prev);
    }
  };

  const copyHeaderInvite = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      setInviteDialogOpen(true);
    }
  };

  const activeHub = resolveActiveHub(activeTab);
  const slideDir = useHubSlideDirection(courseId, activeHub, HUB_IDS);
  const canManage = (detail.data?.can_manage ?? false) && (perms.loading || perms.isTeacher);
  const rosterCount = roster.data?.counts.all ?? detail.data?.student_count;
  const rosterOpen = isXlDesktop ? desktopRosterOpen : mobileSheetOpen;

  const hubs: MorphNavItem[] = [
    { id: "home", label: tr("概览"), href: `/teacher/courses/${courseId}`, icon: Home },
    { id: "groups", label: tr("组队与名单"), href: `/teacher/courses/${courseId}/groups`, icon: Users },
    {
      id: "actions",
      label: tr("审批与申诉"),
      href: `/teacher/courses/${courseId}/actions`,
      icon: CheckSquare,
      badge: pendingActions > 0 ? pendingActions : undefined,
    },
    { id: "projects", label: tr("项目与报告"), href: `/teacher/courses/${courseId}/projects`, icon: ListTree },
    { id: "settings", label: tr("课程设置"), href: `/teacher/courses/${courseId}/settings`, icon: Settings },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <div className="z-10 flex min-w-0 flex-wrap items-center gap-2 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-2.5 py-2 shadow-[var(--gp-shadow-card)] lg:sticky lg:top-[56px] xl:flex-nowrap xl:justify-between xl:gap-1 xl:px-2 2xl:gap-2 2xl:px-3">
        <div className="order-1 -my-1 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1 sm:flex-nowrap xl:gap-1 xl:overflow-hidden 2xl:gap-1.5">
          <Link
            href="/teacher/courses"
            className="gp-toolbar-pill gp-rainbow-ring inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)] transition-colors hover:bg-[var(--gp-surface-hover,#eff0f1)] hover:text-[var(--gp-ink,#1f2329)] xl:px-1.5 2xl:h-8 2xl:px-2"
          >
            <ArrowLeft size={13} aria-hidden="true" />
            <span>{tr("班级")}</span>
          </Link>

          {detail.data && (
            <div className="flex min-w-0 basis-full flex-wrap items-center gap-1.5 sm:basis-auto sm:flex-1 sm:flex-nowrap xl:gap-1 2xl:gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild id="teacher-course-switcher">
                  <button
                    type="button"
                    aria-label={tr("切换班级")}
                    title={detail.data.name}
                    className="gp-toolbar-pill gp-rainbow-ring inline-flex h-7 max-w-[180px] min-w-0 items-center gap-1 rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-2 text-sm font-semibold text-[var(--gp-ink,#1f2329)] transition-colors hover:bg-[var(--gp-surface-subtle,#f8f9fa)] sm:min-w-[60px] 2xl:h-8 2xl:max-w-[220px] 2xl:px-2.5"
                  >
                    <span className="truncate">{detail.data.name}</span>
                    <ChevronDown size={13} className="shrink-0 text-[var(--gp-muted,#646a73)]" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="gp-teacher-portal max-h-80 w-64 overflow-y-auto">
                  {classesQuery.isLoading ? (
                    <div className="px-3 py-2 text-[12px] text-[var(--gp-muted,#646a73)]">
                      {tr("正在加载…")}
                    </div>
                  ) : sortedClasses.length > 0 ? (
                    sortedClasses.map((course) => (
                      <DropdownMenuItem
                        key={course.id}
                        onSelect={() => router.push(`/teacher/courses/${course.id}`)}
                      >
                        <span
                          className={cn(
                            "truncate font-medium",
                            course.id === courseId && "text-[var(--gp-action,#3370ff)]",
                          )}
                        >
                          {course.name}
                        </span>
                        {course.semester && (
                          <span className="ml-auto shrink-0 text-[11px] text-[var(--gp-muted,#646a73)]">
                            {course.semester}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-[12px] text-[var(--gp-muted,#646a73)]">
                      {tr("暂无进行中班级")}
                    </div>
                  )}
                  <div className="my-1 border-t border-[var(--gp-border-subtle,#ebedf0)]" />
                  <DropdownMenuItem onSelect={() => router.push("/teacher/courses")}>
                    <BookOpen size={13} />
                    {tr("查看全部班级")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => router.push("/teacher/dashboard")}>
                    <Activity size={13} />
                    {tr("教师工作台")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span
                className={cn(
                  "hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium min-[1720px]:inline-flex",
                  detail.data.status === "active"
                    ? "bg-[#ecfdf5] text-[#008a5c]"
                    : "bg-[var(--gp-canvas,#f5f6f7)] text-[var(--gp-muted,#646a73)]",
                )}
              >
                {statusLabels[detail.data.status] ? tr(statusLabels[detail.data.status]) : detail.data.status}
              </span>
              {(detail.data.invite_code || canManage) && (
                <div className="gp-toolbar-pill gp-rainbow-ring inline-flex shrink-0 items-center rounded-full border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setRotateError(null);
                      setInviteDialogOpen(true);
                    }}
                    title={tr("点击打开邀请码管理")}
                    className="gp-tabular inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium text-[var(--gp-ink-soft,#4e5969)] transition-[background-color,color,transform] duration-150 hover:bg-white hover:text-[var(--gp-ink,#1f2329)] active:scale-[0.96] 2xl:px-2"
                  >
                    <KeyRound size={11} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
                    <span className="hidden min-[1720px]:inline">{tr("邀请码")}:</span>
                    <span className="font-mono font-semibold text-[var(--gp-ink,#1f2329)]">
                      {detail.data.invite_code ?? "—"}
                    </span>
                  </button>
                  {detail.data.invite_code && (
                    <button
                      type="button"
                      onClick={() => void copyHeaderInvite(detail.data!.invite_code!)}
                      aria-label={copiedCode ? tr("已复制邀请码") : tr("复制邀请码")}
                      title={copiedCode ? tr("已复制邀请码") : tr("复制邀请码")}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--gp-muted,#646a73)] transition-[background-color,color,transform] duration-150 hover:bg-white hover:text-[var(--gp-action,#3370ff)] active:scale-[0.94] xl:w-5 2xl:w-6"
                    >
                      {copiedCode ? (
                        <Check size={11} className="text-[#008a5c]" aria-hidden="true" />
                      ) : (
                        <Copy size={11} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <MorphNav
          items={hubs}
          activeId={activeHub}
          courseKey={courseId}
          ariaLabel="班级管理子导航"
          testId="teacher-course-nav"
          className="order-3 w-full xl:order-2 xl:w-auto xl:shrink-0"
          trailing={
            <DropdownMenu>
              <DropdownMenuTrigger asChild id="teacher-course-more-menu">
                <button
                  type="button"
                  aria-label={tr("切换子页面")}
                  title={tr("更多")}
                  className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--gp-surface-hover,#eff0f1)] hover:text-[var(--gp-ink,#1f2329)] active:scale-[0.96] xl:px-1.5 2xl:px-2"
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                  <span className="sr-only">{tr("更多")}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="gp-teacher-portal w-48">
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/actions`)}>
                  <CheckSquare size={13} />
                  {tr("待办审批")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/member-changes`)}>
                  <UserCog size={13} />
                  {tr("成员变动")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/appeals`)}>
                  <ShieldCheck size={13} />
                  {tr("申诉裁决")}
                </DropdownMenuItem>
                <div className="my-1 border-t border-[var(--gp-border-subtle,#ebedf0)]" />
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/projects`)}>
                  <ListTree size={13} />
                  {tr("项目监控")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/reports`)}>
                  <BarChart3 size={13} />
                  {tr("班级数据报告")}
                </DropdownMenuItem>
                <div className="my-1 border-t border-[var(--gp-border-subtle,#ebedf0)]" />
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/settings`)}>
                  <Settings size={13} />
                  {tr("基础设置")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/rules`)}>
                  <ClipboardList size={13} />
                  {tr("规则与模板")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/files`)}>
                  <Folder size={13} />
                  {tr("课程资料")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/announcements`)}>
                  <Bell size={13} />
                  {tr("课程公告")}
                </DropdownMenuItem>
                {perms.isOwner && (
                  <DropdownMenuItem onSelect={() => router.push(`/teacher/courses/${courseId}/staff`)}>
                    <Shield size={13} />
                    {tr("助教管理")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />

        <div className="order-2 ml-auto shrink-0 xl:order-3 xl:ml-0">
          <Button
            type="button"
            variant={rosterOpen ? "tonal" : "outline"}
            size="sm"
            pill
            data-testid="roster-toggle-btn"
            aria-expanded={rosterOpen}
            onClick={toggleRoster}
            className="gp-toolbar-pill gp-rainbow-ring h-7 px-2 text-xs xl:px-1.5 xl:text-[11.5px] 2xl:h-8 2xl:px-2.5 2xl:text-xs"
          >
            <Users size={13} aria-hidden="true" />
            <span className="gp-tabular">
              {typeof rosterCount === "number" ? (
                <>
                  <span className="2xl:hidden">
                    {tr("花名册")} · {rosterCount}
                  </span>
                  <span className="hidden 2xl:inline">{tr("花名册 · {0}人", { 0: rosterCount })}</span>
                </>
              ) : (
                tr("花名册")
              )}
            </span>
          </Button>
        </div>
      </div>

      <div
        className={cn(
          isXlDesktop &&
            desktopRosterOpen &&
            "grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]",
        )}
      >
        <div
          key={activeHub}
          data-slide={slideDir}
          className={cn(
            "gp-hub-panel min-w-0 space-y-5",
            slideDir !== "none" && "u354-hub-content",
          )}
        >
          {children}
        </div>
        {isXlDesktop && desktopRosterOpen && (
          <ClassRosterSidebar
            courseId={courseId}
            showCollapseButton
            onCollapse={toggleRoster}
          />
        )}
      </div>

      {!isXlDesktop && (
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetContent side="right" className="w-[min(100vw,360px)] p-4">
            <SheetTitle className="sr-only">{tr("花名册")}</SheetTitle>
            <SheetDescription className="sr-only">班级学生花名册</SheetDescription>
            <ClassRosterSidebar courseId={courseId} />
          </SheetContent>
        </Sheet>
      )}

      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader className="pr-8">
            <DialogTitle>{tr("邀请码")}</DialogTitle>
            <DialogDescription>
              {detail.data?.name ?? tr("班级详情")}
            </DialogDescription>
          </DialogHeader>
          <InviteCodeCard
            inviteCode={detail.data?.invite_code ?? null}
            joinUrl={detail.data?.join_url ?? null}
            canManage={canManage}
            compact
            rotating={rotateInvite.isPending}
            errorMessage={rotateError}
            onRotate={() => rotateInvite.mutate()}
          />
        </DialogContent>
      </Dialog>

      <StudentProfileDrawer
        courseId={courseId}
        student={quickStudent}
        open={quickDrawerOpen}
        canManage={canManage}
        removing={removeQuickStudent.isPending}
        errorMessage={quickDrawerError}
        onClose={() => {
          setQuickDrawerOpen(false);
          setQuickDrawerError(undefined);
        }}
        onRemove={(reason) => {
          if (quickStudent) {
            removeQuickStudent.mutate({ studentId: quickStudent.id, reason });
          }
        }}
      />
    </div>
  );
}
