"use client";

/* TeacherQuickSwitcher — quick jump dialog with Lucian UX/UI Prompt #429 search autocomplete styling & spring highlight */

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
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/components/ui/dialog";
import { tr } from "@/shared/i18n/tr";
import { cn } from "@/shared/lib/utils";
import { useWorkspace } from "@/shared/lib/workspace";
import { teacherClassesApi, teacherKeys, type RosterStudent } from "@/teacher/api/teacher-client";
import { useTeacherWorkbench } from "@/teacher/components/TeacherWorkbenchContext";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import "@/shared/components/lux/search-autocomplete.css";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

function renderHighlightedMatch(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIdx = lowerText.indexOf(lowerNeedle, cursor);
  let keyIdx = 0;
  while (matchIdx !== -1) {
    if (matchIdx > cursor) {
      parts.push(text.slice(cursor, matchIdx));
    }
    parts.push(
      <strong key={keyIdx++} className="u429-hl">
        {text.slice(matchIdx, matchIdx + needle.length)}
      </strong>,
    );
    cursor = matchIdx + needle.length;
    matchIdx = lowerText.indexOf(lowerNeedle, cursor);
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

interface QuickEntry {
  id: string;
  section: string;
  label: string;
  subtitle?: string;
  icon: typeof Home;
  onSelect: () => void;
}

function QuickSwitcherList({
  entries,
  selectedIndex,
  query,
  listboxId,
  baseId,
  navSourceRef,
  onSelectIndex,
}: {
  entries: QuickEntry[];
  selectedIndex: number;
  query: string;
  listboxId: string;
  baseId: string;
  navSourceRef: React.MutableRefObject<"keyboard" | "mouse">;
  onSelectIndex: (idx: number) => void;
}) {
  const optionRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const hadVisiblePillRef = React.useRef(false);
  const [pillState, setPillState] = React.useState<{
    top: number;
    height: number;
    visible: boolean;
    animate: boolean;
  }>({ top: 0, height: 40, visible: false, animate: false });

  useIsomorphicLayoutEffect(() => {
    if (entries.length === 0 || selectedIndex < 0 || selectedIndex >= entries.length) {
      hadVisiblePillRef.current = false;
      setPillState((prev) => (prev.visible ? { ...prev, visible: false, animate: false } : prev));
      return;
    }
    const activeEl = optionRefs.current[selectedIndex];
    if (!activeEl) {
      hadVisiblePillRef.current = false;
      setPillState((prev) => (prev.visible ? { ...prev, visible: false, animate: false } : prev));
      return;
    }
    const top = activeEl.offsetTop;
    const height = activeEl.offsetHeight;
    const animate = hadVisiblePillRef.current;
    hadVisiblePillRef.current = true;
    setPillState({ top, height, visible: true, animate });
  }, [entries.length, query, selectedIndex]);

  React.useEffect(() => {
    if (navSourceRef.current !== "keyboard") return;
    const activeEl = optionRefs.current[selectedIndex];
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [entries.length, navSourceRef, selectedIndex]);

  return (
    <div id={listboxId} className="u429-lb space-y-0.5" role="listbox" aria-label={tr("快速跳转")}>
      <span
        aria-hidden="true"
        className={cn("u429-pill", !pillState.animate && "is-instant")}
        style={
          {
            "--py": `${pillState.top}px`,
            "--ph": `${pillState.height}px`,
            "--po": pillState.visible ? 1 : 0,
          } as React.CSSProperties
        }
      />
      {entries.map((entry, idx) => {
        const Icon = entry.icon;
        const active = idx === selectedIndex;
        return (
          <button
            key={entry.id}
            id={`${baseId}-opt-${idx}`}
            ref={(el) => {
              optionRefs.current[idx] = el;
            }}
            type="button"
            role="option"
            aria-selected={active}
            style={{ "--i": Math.min(idx, 8) } as React.CSSProperties}
            onMouseEnter={() => {
              navSourceRef.current = "mouse";
              onSelectIndex(idx);
            }}
            onClick={entry.onSelect}
            className="u429-o"
          >
            <span className="u429-ic" aria-hidden="true">
              <Icon size={14} aria-hidden="true" />
            </span>
            <span className="u429-text">
              <span className="u429-t">
                {renderHighlightedMatch(entry.label, query)}
              </span>
              {entry.subtitle && (
                <span className="u429-sub">
                  {renderHighlightedMatch(entry.subtitle, query)}
                </span>
              )}
            </span>
            <span className="u429-m">
              {entry.section}
            </span>
            <span className="u429-en" aria-hidden="true">↵</span>
          </button>
        );
      })}
    </div>
  );
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
  const [shortcutHint, setShortcutHint] = React.useState("⌘K");
  const baseId = React.useId();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const lastNavSourceRef = React.useRef<"keyboard" | "mouse">("keyboard");

  React.useEffect(() => {
    if (typeof navigator === "undefined") return;
    const platform = navigator.platform || navigator.userAgent || "";
    if (!/Mac|iPhone|iPad|iPod/i.test(platform)) {
      setShortcutHint("Ctrl K");
    }
  }, []);

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

  const listboxId = `${baseId}-listbox`;

  React.useEffect(() => {
    setSelectedIndex((prev) => (entries.length === 0 ? 0 : Math.min(prev, entries.length - 1)));
  }, [entries.length]);

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
        className="w-[min(94vw,560px)] overflow-hidden rounded-[16px] border-[var(--gp-border,#dee0e3)] p-0"
        aria-label={tr("快速跳转")}
      >
        <DialogTitle className="sr-only">{tr("快速跳转")}</DialogTitle>
        <DialogDescription className="sr-only">
          {tr("搜索班级、课程功能或学生姓名/学号...")}
        </DialogDescription>
        <div className="ux u429 u429-modal is-open">
          <div className="u429-modal-head">
            <div
              className="u429-f"
              onClick={(event) => {
                if (!(event.target as HTMLElement).closest("button")) {
                  inputRef.current?.focus();
                }
              }}
            >
              <Search size={17} aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-activedescendant={
                  open && entries[selectedIndex] ? `${baseId}-opt-${selectedIndex}` : undefined
                }
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder={tr("搜索班级、课程功能或学生姓名/学号...")}
                aria-label={tr("搜索班级、课程功能或学生姓名/学号...")}
                className="u429-in"
              />
              {query && (
                <button
                  type="button"
                  className="u429-clear"
                  aria-label={tr("清空")}
                  onClick={() => {
                    setQuery("");
                    setSelectedIndex(0);
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <div className="u429-modal-list overflow-y-auto">
            {entries.length === 0 ? (
              <div className="u429-no py-10 text-center">
                {tr("没有匹配结果")}
              </div>
            ) : (
              <QuickSwitcherList
                entries={entries}
                selectedIndex={selectedIndex}
                query={query}
                listboxId={listboxId}
                baseId={baseId}
                navSourceRef={lastNavSourceRef}
                onSelectIndex={setSelectedIndex}
              />
            )}
          </div>

          <div className="u429-modal-foot">
            <span>{tr("↑↓ 选择 · Enter 打开 · Esc 关闭")}</span>
            <kbd className="u429-kb">
              {shortcutHint}
            </kbd>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
