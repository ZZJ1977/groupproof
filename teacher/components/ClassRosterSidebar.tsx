"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelRightClose, Search, Users } from "lucide-react";
import { errorText, input } from "@/shared/lib/b-ui";
import { StudentEntity } from "@/teacher/components/StudentEntity";
import { StudentProfileDrawer } from "@/teacher/components/StudentProfileDrawer";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { type RosterStudent, teacherClassesApi, teacherKeys } from "@/teacher/api/teacher-client";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

export function ClassRosterSidebar({
  courseId,
  onCollapse,
  showCollapseButton = false,
}: {
  courseId: string;
  onCollapse?: () => void;
  showCollapseButton?: boolean;
}) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const [filter, setFilter] = useState<"all" | "grouped" | "ungrouped">("all");
  const [search, setSearch] = useState("");
  const [activeStudent, setActiveStudent] = useState<RosterStudent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerError, setDrawerError] = useState<string | undefined>();
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
    retry: false,
  });

  const roster = useQuery({
    queryKey: teacherKeys.roster(userId, courseId, "all", ""),
    queryFn: () => teacherClassesApi.roster(courseId, "all", ""),
    enabled: Boolean(courseId),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    setDrawerOpen(false);
    setActiveStudent(null);
    setDrawerError(undefined);
  }, [courseId]);

  const removeStudent = useMutation({
    mutationFn: ({ studentId, reason }: { studentId: string; reason: string }) =>
      teacherClassesApi.removeStudent(courseId, studentId, reason),
    onSuccess: async () => {
      setDrawerOpen(false);
      setDrawerError(undefined);
      setFeedbackMessage(tr("已将学生移出班级"));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
        qc.invalidateQueries({ queryKey: teacherKeys.plaza(userId, courseId) }),
        qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
        qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] }),
      ]);
    },
    onError: (err) => {
      setDrawerError(errorText(err));
    },
  });

  const filteredStudents = useMemo(() => {
    const items = roster.data?.items ?? [];
    const keyword = search.trim().toLowerCase();
    return items.filter((item) => {
      if (item.status === "left") return false;
      if (filter === "grouped" && item.status !== "grouped") return false;
      if (filter === "ungrouped" && item.status !== "ungrouped") return false;
      if (!keyword) return true;
      const nameMatch = (item.name ?? "").toLowerCase().includes(keyword);
      const numberMatch = (item.student_number ?? "").toLowerCase().includes(keyword);
      const emailMatch = (item.email ?? "").toLowerCase().includes(keyword);
      return nameMatch || numberMatch || emailMatch;
    });
  }, [roster.data?.items, filter, search]);

  const canManage = (detail.data?.can_manage ?? false) && (perms.loading || perms.isTeacher);
  const totalCount = roster.data?.counts.all ?? 0;
  const groupedCount = roster.data?.counts.grouped ?? 0;
  const ungroupedCount = roster.data?.counts.ungrouped ?? 0;
  const pendingJoinCount = roster.data?.pending_join_count ?? 0;

  return (
    <aside
      aria-label="班级学生侧边栏"
      data-testid="class-roster-sidebar"
      className="flex flex-col gap-3.5 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Users size={16} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
          <h2 className="truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
            班级学生花名册
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="gp-tabular rounded-full bg-[var(--gp-canvas,#f5f6f7)] px-2 py-0.5 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
            {tr("共 {0} 人", { 0: totalCount })}
          </span>
          {showCollapseButton && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={tr("收起花名册")}
              title={tr("收起花名册")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--gp-muted,#646a73)] transition-colors hover:bg-[var(--gp-surface-hover,#eff0f1)] hover:text-[var(--gp-ink,#1f2329)]"
            >
              <PanelRightClose size={14} />
            </button>
          )}
        </div>
      </div>

      {feedbackMessage && (
        <TeacherFeedbackPill
          tone="success"
          message={feedbackMessage}
          autoHideMs={3000}
          onDismiss={() => setFeedbackMessage(null)}
        />
      )}

      {pendingJoinCount > 0 && (
        <Link
          href={`/teacher/courses/${courseId}/member-changes`}
          className="flex items-center justify-between rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
        >
          <span className="gp-tabular">{tr("待审批入班申请 {0} 人", { 0: pendingJoinCount })}</span>
          <span className="underline">去处理</span>
        </Link>
      )}

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gp-subtle,#8f959e)]"
        />
        <input
          type="search"
          aria-label="搜索班级学生"
          className={`${input} mt-0 rounded-[8px] border-[var(--gp-border,#dee0e3)] pl-8 text-xs`}
          placeholder="搜索姓名或学号"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-[10px] border border-[var(--gp-border,#dee0e3)]/60 bg-[var(--gp-canvas,#f5f6f7)] p-1 text-xs font-medium">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`gp-tabular rounded-[7px] py-1.5 transition-all ${
            filter === "all"
              ? "bg-white font-semibold text-[var(--gp-ink,#1f2329)] shadow-xs"
              : "text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-ink,#1f2329)]"
          }`}
        >
          {tr("全部 ({0})", { 0: totalCount })}
        </button>
        <button
          type="button"
          onClick={() => setFilter("grouped")}
          className={`gp-tabular rounded-[7px] py-1.5 transition-all ${
            filter === "grouped"
              ? "bg-white font-semibold text-[#008a5c] shadow-xs"
              : "text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-ink,#1f2329)]"
          }`}
        >
          {tr("已组队 ({0})", { 0: groupedCount })}
        </button>
        <button
          type="button"
          onClick={() => setFilter("ungrouped")}
          className={`gp-tabular rounded-[7px] py-1.5 transition-all ${
            filter === "ungrouped"
              ? "bg-white font-semibold text-[#1d4ed8] shadow-xs"
              : "text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-ink,#1f2329)]"
          }`}
        >
          {tr("未组队 ({0})", { 0: ungroupedCount })}
        </button>
      </div>

      {roster.isLoading ? (
        <p className="py-6 text-center text-xs text-[var(--gp-muted,#646a73)]">正在加载学生名单…</p>
      ) : roster.error ? (
        <div role="alert" className="rounded-[8px] border border-red-200 bg-red-50 p-3 text-xs text-[#d93025]">
          {errorText(roster.error)}
        </div>
      ) : filteredStudents.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--gp-border,#dee0e3)] py-8 text-center text-xs text-[var(--gp-muted,#646a73)]">
          {totalCount === 0
            ? "暂无学生入班，点击顶部邀请码复制给学生即可加入。"
            : "没有匹配筛选条件的学生"}
        </div>
      ) : (
        <div className="max-h-[540px] space-y-2 overflow-y-auto pr-1">
          {filteredStudents.map((student) => (
            <StudentEntity
              key={student.id}
              studentId={student.id}
              name={student.name}
              studentNumber={student.student_number}
              initial={student.initial}
              grouped={student.status === "grouped"}
              groupName={student.group?.name ?? null}
              isLeader={student.is_leader}
              inProjectGroup={student.in_project_group}
              fromGroupId={student.group?.id ?? null}
              fromGroupVersion={null}
              canManage={canManage}
              onClick={() => {
                setDrawerError(undefined);
                setActiveStudent(student);
                setDrawerOpen(true);
              }}
            />
          ))}
        </div>
      )}

      <StudentProfileDrawer
        courseId={courseId}
        student={activeStudent}
        open={drawerOpen}
        canManage={canManage}
        removing={removeStudent.isPending}
        errorMessage={drawerError}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerError(undefined);
        }}
        onRemove={(reason) => {
          if (activeStudent) {
            removeStudent.mutate({ studentId: activeStudent.id, reason });
          }
        }}
      />
    </aside>
  );
}
