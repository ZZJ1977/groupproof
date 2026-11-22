"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Users } from "lucide-react";
import { errorText, input } from "@/features/b/ui";
import { InviteCodeCard } from "@/features/teacher/InviteCodeCard";
import { StudentEntity } from "@/features/teacher/StudentEntity";
import { StudentProfileDrawer } from "@/features/teacher/StudentProfileDrawer";
import { type RosterStudent, teacherClassesApi, teacherKeys } from "@/lib/api/teacher-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

export function ClassRosterSidebar({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const [filter, setFilter] = useState<"all" | "grouped" | "ungrouped">("all");
  const [search, setSearch] = useState("");
  const [activeStudent, setActiveStudent] = useState<RosterStudent | null>(null);
  const [drawerError, setDrawerError] = useState<string | undefined>();

  const detail = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
  });

  const roster = useQuery({
    queryKey: teacherKeys.roster(userId, courseId, "all", ""),
    queryFn: () => teacherClassesApi.roster(courseId, "all", ""),
    enabled: Boolean(courseId),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rotateInvite = useMutation({
    mutationFn: () =>
      teacherClassesApi.rotateInvite(courseId, detail.data?.lock_version ?? 0),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
        qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] }),
      ]);
    },
  });

  const removeStudent = useMutation({
    mutationFn: ({ studentId, reason }: { studentId: string; reason: string }) =>
      teacherClassesApi.removeStudent(courseId, studentId, reason),
    onSuccess: async () => {
      setActiveStudent(null);
      setDrawerError(undefined);
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
      className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-blue-600" />
          <h2 className="text-sm font-semibold text-slate-900">班级学生花名册</h2>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          {tr("共 {0} 人", { 0: totalCount })}
        </span>
      </div>

      {detail.data && (
        <InviteCodeCard
          inviteCode={detail.data.invite_code}
          joinUrl={detail.data.join_url}
          canManage={canManage}
          compact
          rotating={rotateInvite.isPending}
          onRotate={() => rotateInvite.mutate()}
        />
      )}

      {pendingJoinCount > 0 && (
        <Link
          href={`/teacher/courses/${courseId}/member-changes`}
          className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100"
        >
          <span>{tr("待审批入班申请 {0} 人", { 0: pendingJoinCount })}</span>
          <span className="underline">去处理</span>
        </Link>
      )}

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <input
          type="search"
          aria-label="搜索班级学生"
          className={`${input} mt-0 pl-8`}
          placeholder="搜索姓名或学号"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 text-xs font-medium">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-md py-1.5 transition ${
            filter === "all"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {tr("全部 ({0})", { 0: totalCount })}
        </button>
        <button
          type="button"
          onClick={() => setFilter("grouped")}
          className={`rounded-md py-1.5 transition ${
            filter === "grouped"
              ? "bg-white text-emerald-700 shadow-sm"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {tr("已组队 ({0})", { 0: groupedCount })}
        </button>
        <button
          type="button"
          onClick={() => setFilter("ungrouped")}
          className={`rounded-md py-1.5 transition ${
            filter === "ungrouped"
              ? "bg-white text-blue-700 shadow-sm"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {tr("未组队 ({0})", { 0: ungroupedCount })}
        </button>
      </div>

      {roster.isLoading ? (
        <p className="py-6 text-center text-xs text-slate-500">正在加载学生名单…</p>
      ) : roster.error ? (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {errorText(roster.error)}
        </div>
      ) : filteredStudents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-xs text-slate-500">
          {totalCount === 0
            ? "暂无学生入班，复制上方邀请码发送给学生即可加入。"
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
              }}
            />
          ))}
        </div>
      )}

      {activeStudent && (
        <StudentProfileDrawer
          courseId={courseId}
          student={activeStudent}
          canManage={canManage}
          removing={removeStudent.isPending}
          errorMessage={drawerError}
          onClose={() => {
            setActiveStudent(null);
            setDrawerError(undefined);
          }}
          onRemove={(reason) =>
            removeStudent.mutate({ studentId: activeStudent.id, reason })
          }
        />
      )}
    </aside>
  );
}
