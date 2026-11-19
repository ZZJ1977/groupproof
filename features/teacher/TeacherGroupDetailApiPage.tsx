"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Crown,
  FolderKanban,
  Lock,
  ShieldCheck,
} from "lucide-react";
import {
  card,
  dateTime,
  errorText,
  secondary,
} from "@/features/b/ui";
import { GroupProgressBar } from "@/features/teacher/GroupProgressBar";
import { teacherClassesApi, teacherKeys } from "@/lib/api/teacher-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const milestoneStatusLabels: Record<string, string> = {
  completed: "已完成",
  in_progress: "进行中",
  not_started: "未开始",
  overdue: "已逾期",
};

const riskLabels: Record<string, string> = {
  high: "高风险",
  medium: "中风险",
  low: "低风险",
};

export function TeacherGroupDetailApiPage({
  courseId,
  groupId,
}: {
  courseId: string;
  groupId: string;
}) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const courseDetail = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
  });

  const detail = useQuery({
    queryKey: teacherKeys.group(userId, courseId, groupId),
    queryFn: () => teacherClassesApi.groupDetail(courseId, groupId),
    enabled: Boolean(courseId && groupId),
  });

  const setLeader = useMutation({
    mutationFn: (leaderUserId: string) =>
      teacherClassesApi.setLeader(courseId, groupId, {
        user_id: leaderUserId,
        expected_version: detail.data?.group.lock_version ?? 1,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: teacherKeys.group(userId, courseId, groupId) }),
        qc.invalidateQueries({ queryKey: teacherKeys.plaza(userId, courseId) }),
        qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
      ]);
    },
  });

  if (detail.isLoading) {
    return (
      <div role="status" className="gp-empty">
        正在加载…
      </div>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        <p>{errorText(detail.error)}</p>
        <button
          type="button"
          className={`${secondary} mt-3`}
          onClick={() => void detail.refetch()}
        >
          重试
        </button>
      </div>
    );
  }

  const data = detail.data;
  const group = data.group;
  const canManage = perms.loading ? (courseDetail.data?.can_manage ?? false) : perms.manageGroups;

  return (
    <div className="space-y-5">
      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <Link
              href={`/teacher/courses/${courseId}/groups`}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              <ArrowLeft size={13} />
              返回学生组队广场
            </Link>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-bold text-slate-900">{group.name}</h1>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                {tr("{0}/{1} 人", { 0: group.member_count, 1: group.max_group_size })}
              </span>
              {group.has_project && (
                <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  <ShieldCheck size={12} />
                  已立项
                </span>
              )}
              {group.roster_frozen && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  <Lock size={12} />
                  名单已冻结
                </span>
              )}
            </div>
            {group.direction && <p className="text-xs text-slate-500">{group.direction}</p>}
          </div>

          {group.project && (
            <Link href={group.project.href} className={secondary}>
              <FolderKanban size={15} />
              {tr("进入项目：{0}", { 0: group.project.name })}
            </Link>
          )}
        </div>

        <GroupProgressBar progress={group.progress} large />

        {group.has_project && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-xs text-blue-900">
            <span>
              该队伍已关联立项项目，不能在组队广场直接将组员拖出队伍；如需移出成员请走成员变动流程。
            </span>
            <Link
              href={data.member_changes_href}
              className="font-semibold underline"
            >
              前往成员变动页面
            </Link>
          </div>
        )}
      </div>

      <div className={`${card} space-y-4`}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">队伍成员信息</h2>
            <p className="text-xs text-slate-500">
              查看队伍内每位学生的详细信息，或指定新的队长。
            </p>
          </div>
        </div>

        {setLeader.error && (
          <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {errorText(setLeader.error)}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">队伍成员列表</caption>
            <thead>
              <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                <th className="py-2.5 pr-4">学生姓名</th>
                <th className="px-4 py-2.5">学号</th>
                <th className="px-4 py-2.5">邮箱</th>
                <th className="px-4 py-2.5">队内角色</th>
                <th className="px-4 py-2.5">未完任务数</th>
                <th className="px-4 py-2.5">入队时间</th>
                {canManage && !group.roster_frozen && (
                  <th className="py-2.5 pl-4 text-right">操作</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.members.length === 0 ? (
                <tr>
                  <td
                    colSpan={canManage && !group.roster_frozen ? 7 : 6}
                    className="py-8 text-center text-xs text-slate-500"
                  >
                    当前队伍暂无成员
                  </td>
                </tr>
              ) : (
                data.members.map((member) => {
                  const initial = (member.name || member.student_number || "生").slice(0, 1);
                  return (
                    <tr key={member.id} className="hover:bg-slate-50/70">
                      <td className="py-3 pr-4 font-medium text-slate-900">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">
                            {initial}
                          </span>
                          <span>{member.name || "未命名学生"}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {member.student_number || "无学号"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {member.email || "未公开"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {member.role === "leader" ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                            <Crown size={11} />
                            队长
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-600">
                            队员
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {member.open_task_count}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {dateTime(member.joined_at)}
                      </td>
                      {canManage && !group.roster_frozen && (
                        <td className="py-3 pl-4 text-right">
                          {member.role !== "leader" && (
                            <button
                              type="button"
                              className={secondary}
                              disabled={setLeader.isPending}
                              onClick={() => setLeader.mutate(member.id)}
                            >
                              设为队长
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">队伍里程碑进度</h2>
            <p className="text-xs text-slate-500">
              展示该队伍关联项目的所有里程碑、任务完成度与风险提示。
            </p>
          </div>
          {group.project && (
            <Link
              href={`/projects/${group.project.id}/milestones`}
              className="gp-link inline-flex items-center gap-1 text-xs font-semibold"
            >
              前往项目里程碑列表
              <ArrowRight size={13} />
            </Link>
          )}
        </div>

        {!group.project ? (
          <div className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-xs text-slate-500">
            该队伍尚未创建立项项目，立项并添加里程碑后将在此展示进度详情。
          </div>
        ) : data.milestones.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-xs text-slate-500">
            该项目暂未设置里程碑。
          </div>
        ) : (
          <div className="space-y-3">
            {data.milestones.map((ms) => {
              const pct = ms.progress_percent ?? 0;
              const riskLevel = ms.risk?.level ?? null;
              return (
                <div
                  key={ms.id}
                  data-testid={`group-milestone-${ms.id}`}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={ms.href}
                          className="text-sm font-semibold text-slate-900 hover:text-blue-600"
                        >
                          {ms.title}
                        </Link>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            ms.status === "completed"
                              ? "bg-emerald-50 text-emerald-700"
                              : ms.overdue
                                ? "bg-red-50 text-red-700"
                                : "bg-blue-50 text-blue-700"
                          }`}
                        >
                          {milestoneStatusLabels[ms.status] ?? ms.status}
                        </span>
                        {ms.overdue && (
                          <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                            <AlertTriangle size={11} />
                            已逾期
                          </span>
                        )}
                        {riskLevel && (
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-medium ${
                              riskLevel === "high"
                                ? "bg-red-100 text-red-800"
                                : riskLevel === "medium"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {riskLabels[riskLevel] ?? riskLevel}
                          </span>
                        )}
                      </div>
                      {ms.description && (
                        <p className="text-xs text-slate-500">{ms.description}</p>
                      )}
                    </div>

                    <Link href={ms.href} className={secondary}>
                      查看里程碑详情
                      <ArrowRight size={13} />
                    </Link>
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                      <span>
                        {tr("关联任务：{0}/{1} 已完成", {
                          0: ms.completed_task_count,
                          1: ms.task_count,
                        })}
                      </span>
                      <span>{tr("截止时间：{0}", { 0: dateTime(ms.deadline) })}</span>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full bg-blue-600 transition-all"
                        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
