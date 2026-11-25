"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  BookOpen,
  CheckSquare,
  ClipboardList,
  Folder,
  Home,
  ListTree,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/components/ui/dialog";
import { tr } from "@/shared/i18n/tr";
import { cn } from "@/shared/lib/utils";
import { useWorkspace } from "@/shared/lib/workspace";
import { teacherClassesApi, teacherKeys, type RosterStudent } from "@/teacher/api/teacher-client";
import { useTeacherWorkbench } from "@/teacher/components/TeacherWorkbenchContext";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";

interface QuickEntry {
  id: string;
  section: string;
  label: string;
  subtitle?: string;
  icon: typeof Home;
  onSelect: () => void;
}

export function TeacherQuickSwitcher({
  open,
  onOpenChange,
  navCourseId,
  mockShell,
  mockCourses,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navCourseId?: string;
  mockShell: boolean;
  mockCourses: { id: string; name: string; code?: string; semester?: string }[];
}) {
  const router = useRouter();
  const { userId } = useWorkspace();
  const workbench = useTeacherWorkbench();
  const perms = useTeacherPermissions(navCourseId ?? "");
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const optionRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const lastNavSourceRef = React.useRef<"keyboard" | "mouse">("keyboard");

  const classesQuery = useQuery({
    queryKey: teacherKeys.classes(userId, "all", ""),
    queryFn: () => teacherClassesApi.list("all", ""),
    enabled: open && !mockShell,
    retry: false,
    staleTime: 60_000,
  });

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      lastNavSourceRef.current = "keyboard";
      const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  const entries = React.useMemo<QuickEntry[]>(() => {
    const term = query.trim().toLowerCase();
    const list: QuickEntry[] = [];
    const go = (href: string) => {
      onOpenChange(false);
      router.push(href);
    };

    if (navCourseId) {
      const base = `/teacher/courses/${navCourseId}`;
      const section = tr("当前班级功能");
      const courseHubs: { id: string; label: string; href: string; icon: typeof Home }[] = [
        { id: "hub-overview", label: tr("概览"), href: base, icon: Home },
        { id: "hub-groups", label: tr("组队与名单"), href: `${base}/groups`, icon: Users },
        { id: "hub-actions", label: tr("审批与申诉"), href: `${base}/actions`, icon: CheckSquare },
        { id: "hub-member-changes", label: tr("成员变动"), href: `${base}/member-changes`, icon: Users },
        { id: "hub-appeals", label: tr("申诉裁决"), href: `${base}/appeals`, icon: ShieldCheck },
        { id: "hub-projects", label: tr("项目与报告"), href: `${base}/projects`, icon: ListTree },
        { id: "hub-reports", label: tr("班级数据报告"), href: `${base}/reports`, icon: Activity },
        { id: "hub-settings", label: tr("课程设置"), href: `${base}/settings`, icon: Settings },
        { id: "hub-rules", label: tr("规则与模板"), href: `${base}/rules`, icon: ClipboardList },
        { id: "hub-files", label: tr("课程资料"), href: `${base}/files`, icon: Folder },
        { id: "hub-announcements", label: tr("课程公告"), href: `${base}/announcements`, icon: Bell },
      ];
      if (perms.isOwner) {
        courseHubs.push({
          id: "hub-staff",
          label: tr("助教管理"),
          href: `${base}/staff`,
          icon: Shield,
        });
      }
      for (const hub of courseHubs) {
        list.push({
          id: hub.id,
          section,
          label: hub.label,
          subtitle: workbench.courseDetail?.name,
          icon: hub.icon,
          onSelect: () => go(hub.href),
        });
      }
    }

    const classes = mockShell
      ? mockCourses.map((c) => ({ id: c.id, name: c.name, meta: c.code ?? c.semester }))
      : (classesQuery.data?.items ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          meta: c.semester || c.code,
        }));

    for (const c of term ? classes : classes.slice(0, 6)) {
      list.push({
        id: `course-${c.id}`,
        section: tr("我的班级"),
        label: c.name,
        subtitle: c.meta || undefined,
        icon: BookOpen,
        onSelect: () => go(`/teacher/courses/${c.id}`),
      });
    }

    if (navCourseId && workbench.rosterStudents.length > 0) {
      const handleStudent = (student: RosterStudent) => {
        onOpenChange(false);
        if (workbench.openStudentProfile) {
          workbench.openStudentProfile(student);
        } else {
          router.push(`/teacher/courses/${navCourseId}/groups`);
        }
      };

      const activeStudents = workbench.rosterStudents.filter((s) => s.status !== "left");
      const visibleStudents = term ? activeStudents : activeStudents.slice(0, 8);
      for (const student of visibleStudents) {
        const label = student.name || student.student_number || student.email || student.id;
        list.push({
          id: `student-${student.id}`,
          section: tr("当前班级学生"),
          label,
          subtitle: [student.student_number, student.group?.name].filter(Boolean).join(" · ") || undefined,
          icon: UserRound,
          onSelect: () => handleStudent(student),
        });
      }
    }

    list.push(
      {
        id: "global-dashboard",
        section: tr("快捷跳转"),
        label: tr("教师工作台"),
        icon: Activity,
        onSelect: () => go("/teacher/dashboard"),
      },
      {
        id: "global-courses",
        section: tr("快捷跳转"),
        label: tr("我的班级"),
        icon: BookOpen,
        onSelect: () => go("/teacher/courses"),
      },
      {
        id: "global-notifications",
        section: tr("快捷跳转"),
        label: tr("待办通知"),
        icon: Bell,
        onSelect: () => go("/notifications"),
      },
    );

    if (!term) return list;
    return list
      .filter(
        (entry) =>
          entry.label.toLowerCase().includes(term) ||
          (entry.subtitle ?? "").toLowerCase().includes(term) ||
          entry.section.toLowerCase().includes(term),
      )
      .slice(0, 16);
  }, [
    classesQuery.data?.items,
    mockCourses,
    mockShell,
    navCourseId,
    onOpenChange,
    perms.isOwner,
    query,
    router,
    workbench,
  ]);

  React.useEffect(() => {
    setSelectedIndex((prev) => (entries.length === 0 ? 0 : Math.min(prev, entries.length - 1)));
  }, [entries.length]);

  React.useEffect(() => {
    if (!open || lastNavSourceRef.current !== "keyboard") return;
    const activeEl = optionRefs.current[selectedIndex];
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [open, selectedIndex, entries.length]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      lastNavSourceRef.current = "keyboard";
      if (entries.length > 0) setSelectedIndex((prev) => (prev + 1) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      lastNavSourceRef.current = "keyboard";
      if (entries.length > 0) setSelectedIndex((prev) => (prev - 1 + entries.length) % entries.length);
    } else if (event.key === "Enter" && entries[selectedIndex]) {
      event.preventDefault();
      entries[selectedIndex].onSelect();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(94vw,560px)] overflow-hidden rounded-[12px] border-[var(--gp-border,#dee0e3)] p-0"
        aria-label={tr("快速跳转")}
      >
        <DialogTitle className="sr-only">{tr("快速跳转")}</DialogTitle>
        <DialogDescription className="sr-only">
          {tr("搜索班级、课程功能或学生姓名/学号...")}
        </DialogDescription>
        <div className="flex items-center gap-2.5 border-b border-[var(--gp-border-subtle,#ebedf0)] px-4 py-3 pr-11">
          <Search size={16} className="shrink-0 text-[var(--gp-muted,#646a73)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={tr("搜索班级、课程功能或学生姓名/学号...")}
            aria-label={tr("搜索班级、课程功能或学生姓名/学号...")}
            className="w-full min-w-0 border-0 bg-transparent text-sm text-[var(--gp-ink,#1f2329)] outline-none placeholder:text-[var(--gp-subtle,#8f959e)]"
          />
        </div>

        <div className="max-h-[360px] overflow-y-auto p-2">
          {entries.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--gp-muted,#646a73)]">
              {tr("没有匹配结果")}
            </div>
          ) : (
            <div className="space-y-0.5" role="listbox" aria-label={tr("快速跳转")}>
              {entries.map((entry, idx) => {
                const Icon = entry.icon;
                const active = idx === selectedIndex;
                return (
                  <button
                    key={entry.id}
                    ref={(el) => {
                      optionRefs.current[idx] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => {
                      lastNavSourceRef.current = "mouse";
                      setSelectedIndex(idx);
                    }}
                    onClick={entry.onSelect}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left transition-colors",
                      active
                        ? "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action-on-soft,#1d4ed8)]"
                        : "text-[var(--gp-ink,#1f2329)] hover:bg-[var(--gp-surface-hover,#eff0f1)]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Icon size={15} className="shrink-0 opacity-80" aria-hidden="true" />
                      <span className="truncate text-sm font-medium">{entry.label}</span>
                      {entry.subtitle && (
                        <span className="truncate text-xs text-[var(--gp-muted,#646a73)]">
                          {entry.subtitle}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-[var(--gp-muted,#646a73)]">
                      {entry.section}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-4 py-2 text-[11px] text-[var(--gp-muted,#646a73)]">
          <span>{tr("↑↓ 选择 · Enter 打开 · Esc 关闭")}</span>
          <kbd className="rounded border border-[var(--gp-border,#dee0e3)] bg-white px-1.5 py-0.5 font-mono text-[10px]">
            ⌘K
          </kbd>
        </div>
      </DialogContent>
    </Dialog>
  );
}
