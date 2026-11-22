"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Calendar, ShieldCheck, Users } from "lucide-react";
import { button, card, dateTime, errorText, secondary } from "@/features/b/ui";
import { GroupProgressBar } from "@/features/teacher/GroupProgressBar";
import { InviteCodeCard } from "@/features/teacher/InviteCodeCard";
import { teacherClassesApi, teacherKeys } from "@/lib/api/teacher-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

export function TeacherClassHomeApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();

  const detail = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
  });

  const plaza = useQuery({
    queryKey: teacherKeys.plaza(userId, courseId),
    queryFn: () => teacherClassesApi.plaza(courseId),
    enabled: Boolean(courseId),
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

  if (detail.isLoading || plaza.isLoading) {
    return (
      <div role="status" className="gp-empty">
        正在加载…
      </div>
    );
  }

  if (detail.error || plaza.error || !detail.data || !plaza.data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        <p>{errorText(detail.error ?? plaza.error)}</p>
        <button
          type="button"
          className={`${secondary} mt-3`}
          onClick={() => {
            void detail.refetch();
            void plaza.refetch();
          }}
        >
          重试
        </button>
      </div>
    );
  }

  const course = detail.data;
  const groups = plaza.data.groups;
  const groupedCount = Math.max(0, course.student_count - course.ungrouped_count);

  return (
    <div className="space-y-5">
      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-slate-900">{course.name}</h1>
            <p className="mt-1 text-sm text-slate-500">
              教师可通过下方邀请码邀请学生加入，或在组队广场分配学生队伍。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2.5 py-1 font-medium">
                <Users size={13} />
                {tr("队伍人数要求：{0}-{1} 人", {
                  0: course.min_group_size,
                  1: course.max_group_size,
                })}
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2.5 py-1 font-medium">
                <Calendar size={13} />
                {tr("组队截止：{0}", { 0: dateTime(course.formation_deadline) })}
              </span>
            </div>
          </div>

          <Link href={`/teacher/courses/${courseId}/groups`} className={button}>
            <Users size={15} />
            进入学生组队广场
            <ArrowRight size={15} />
          </Link>
        </div>

        <InviteCodeCard
          inviteCode={course.invite_code}
          joinUrl={course.join_url}
          canManage={course.can_manage}
          rotating={rotateInvite.isPending}
          onRotate={() => rotateInvite.mutate()}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className={card}>
          <div className="text-xs font-medium text-slate-500">入班学生总数</div>
          <div className="mt-2 text-2xl font-bold text-slate-900">{course.student_count}</div>
        </div>
        <div className={card}>
          <div className="text-xs font-medium text-slate-500">已组队学生</div>
          <div className="mt-2 text-2xl font-bold text-emerald-700">{groupedCount}</div>
        </div>
        <div className={card}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">未组队学生</span>
            {course.ungrouped_count > 0 && (
              <Link
                href={`/teacher/courses/${courseId}/groups`}
                className="text-xs font-semibold text-blue-600 hover:underline"
              >
                去分配
              </Link>
            )}
          </div>
          <div className="mt-2 text-2xl font-bold text-blue-700">{course.ungrouped_count}</div>
        </div>
        <div className={card}>
          <div className="text-xs font-medium text-slate-500">当前队伍数</div>
          <div className="mt-2 text-2xl font-bold text-slate-900">{course.group_count}</div>
        </div>
      </div>

      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">班级队伍进度总览</h2>
            <p className="text-xs text-slate-500">
              点击任意队伍可查看组员详情与里程碑进度。
            </p>
          </div>
          <Link href={`/teacher/courses/${courseId}/groups`} className={secondary}>
            前往组队广场管理
          </Link>
        </div>

        {groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-xs text-slate-500">
            当前班级还没有任何队伍，前往「学生组队广场」即可新建队伍并为未组队学生分配。
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div
                key={group.id}
                className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/teacher/courses/${courseId}/groups/${group.id}`}
                      className="text-sm font-semibold text-slate-900 hover:text-blue-600"
                    >
                      {group.name}
                    </Link>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {tr("{0}/{1} 人", {
                        0: group.member_count,
                        1: group.max_group_size,
                      })}
                    </span>
                    {group.has_project && (
                      <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                        <ShieldCheck size={12} />
                        已立项
                      </span>
                    )}
                  </div>
                  {group.direction && (
                    <p className="text-xs text-slate-500">{group.direction}</p>
                  )}
                </div>

                <div className="w-full md:max-w-md">
                  <GroupProgressBar progress={group.progress} />
                </div>

                <div className="shrink-0">
                  <Link
                    href={`/teacher/courses/${courseId}/groups/${group.id}`}
                    className={secondary}
                  >
                    查看详情
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
