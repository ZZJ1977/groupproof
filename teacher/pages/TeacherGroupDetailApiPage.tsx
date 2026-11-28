"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Crown,
  FolderKanban,
  GitBranchPlus,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import { dateTime, errorText } from "@/shared/lib/b-ui";
import { cn } from "@/shared/lib/utils";
import { GroupProgressBar } from "@/teacher/components/GroupProgressBar";
import {
  TeacherFeedbackPill,
  type TeacherFeedbackTone,
} from "@/teacher/components/TeacherFeedbackPill";
import { BApiError } from "@/student/api/b-client";
import { teacherClassesApi, teacherKeys } from "@/teacher/api/teacher-client";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

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
  const tCode = useTranslations("codeDiscovery");
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const [leaderFeedback, setLeaderFeedback] = useState<{
    tone: TeacherFeedbackTone;
    message: string;
  } | null>(null);

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
    onMutate: () => {
      setLeaderFeedback({ tone: "loading", message: tr("保存中…") });
    },
    onSuccess: async () => {
      setLeaderFeedback({ tone: "success", message: tr("已更新队长") });
      await Promise.all([
        qc.invalidateQueries({ queryKey: teacherKeys.group(userId, courseId, groupId) }),
        qc.invalidateQueries({ queryKey: teacherKeys.plaza(userId, courseId) }),
        qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
      ]);
    },
    onError: async (err) => {
      if (err instanceof BApiError && err.code === "VERSION_CONFLICT") {
        await qc.invalidateQueries({ queryKey: teacherKeys.group(userId, courseId, groupId) });
        setLeaderFeedback({
          tone: "error",
          message: tr("队伍数据刚被更新，已为您自动刷新最新状态，请重试。"),
        });
        return;
      }
      setLeaderFeedback({ tone: "error", message: errorText(err) });
    },
  });

  if (detail.isLoading) {
    return (
      <div role="status" className="min-w-0 max-w-full space-y-5">
        <span className="sr-only">{tr("正在加载…")}</span>
        <div className={cn(feishuCard, "h-36 animate-pulse")} />
        <div className={cn(feishuCard, "h-56 animate-pulse")} />
      </div>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <div
        role="alert"
        className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}
      >
        <TeacherFeedbackPill tone="error" message={errorText(detail.error)} />
        <Button type="button" variant="outline" size="sm" onClick={() => void detail.refetch()}>
          重试
        </Button>
      </div>
    );
  }

  const data = detail.data;
  const group = data.group;
  const canManage = perms.loading ? (courseDetail.data?.can_manage ?? false) : perms.manageGroups;
  const codeDiscoveredCount =
    group.project?.code_discovered_task_count ??
    group.progress.code_discovered_task_count ??
    group.code_discovered_task_count ??
    0;
  const plannedCount =
    group.project?.planned_task_count ??
    group.progress.planned_task_count ??
    group.planned_task_count ??
    0;
  const codeDiscoveredWeightShare =
    group.project?.code_discovered_weight_share ??
    group.progress.code_discovered_weight_share ??
    group.code_discovered_weight_share;
  const highExpansionWarning = Boolean(
    group.project?.high_expansion_warning ??
      group.progress.high_expansion_warning ??
      group.high_expansion_warning,
  );

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <div className={cn(feishuCard, "space-y-4")}>
        <div className="flex min-w-0 max-w-full flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Link
              href={`/teacher/courses/${courseId}/groups`}
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-ink,#1f2329)]"
            >
              <ArrowLeft size={13} />
              返回学生组队广场
            </Link>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="break-words text-lg font-bold text-[var(--gp-ink,#1f2329)]">
                {group.name}
              </h1>
              <span className="gp-tabular rounded-full bg-[var(--gp-surface-subtle,#f8f9fa)] px-2.5 py-0.5 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
                {tr("{0}/{1} 人", { 0: group.member_count, 1: group.max_group_size })}
              </span>
              {group.has_project && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-xs font-medium text-[#1d4ed8]">
                  <ShieldCheck size={12} />
                  已立项
                </span>
              )}
              {group.roster_frozen && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  <Lock size={12} />
                  名单已冻结
                </span>
              )}
              {codeDiscoveredCount > 0 && (
                <span
                  data-testid="teacher-group-origin-pill"
                  className="gp-tabular inline-flex items-center gap-1 rounded-full border border-violet-200/85 bg-violet-50/85 px-2.5 py-0.5 font-mono text-xs font-medium text-violet-800"
                >
                  <GitBranchPlus size={12} className="shrink-0 text-violet-600" aria-hidden="true" />
                  {codeDiscoveredWeightShare !== undefined
                    ? tCode("teacherOriginPillWithShare", {
                        planned: plannedCount,
                        discovered: codeDiscoveredCount,
                        share:
                          Math.round(
                            (codeDiscoveredWeightShare <= 1
                              ? codeDiscoveredWeightShare * 100
                              : codeDiscoveredWeightShare) * 10,
                          ) / 10,
                      })
                    : tCode("teacherOriginPill", {
                        planned: plannedCount,
                        discovered: codeDiscoveredCount,
                      })}
                </span>
              )}
              {codeDiscoveredCount > 0 && highExpansionWarning && (
                <span
                  data-testid="teacher-group-high-expansion-warning"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-200/90 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800"
                >
                  <AlertTriangle size={11} aria-hidden="true" />
                  {tCode("highExpansionWarning")}
                </span>
              )}
            </div>
            {group.direction && (
              <p className="text-xs text-[var(--gp-muted,#646a73)]">{group.direction}</p>
            )}
          </div>

          {group.project && (
            <Link
              href={group.project.href}
              data-variant="tonal"
              title={tr("进入项目：{0}", { 0: group.project.name })}
              className={cn(
                buttonVariants({ variant: "tonal", size: "sm", pill: true }),
                "min-w-0 max-w-full",
              )}
            >
              <FolderKanban size={15} className="shrink-0" />
              <span className="min-w-0 truncate">
                {tr("进入项目：{0}", { 0: group.project.name })}
              </span>
            </Link>
          )}
        </div>

        <GroupProgressBar progress={group.progress} large />

        {group.has_project && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#c7dafc] bg-[#e8f0fe]/60 px-4 py-2.5 text-xs text-[#1d4ed8]">
            <span>
              该队伍已关联立项项目，不能在组队广场直接将组员拖出队伍；如需移出成员请走成员变动流程。
            </span>
            <Link
              href={data.member_changes_href}
              className="shrink-0 font-semibold underline underline-offset-2"
            >
              前往成员变动页面
            </Link>
          </div>
        )}
      </div>

      <div className={cn(feishuCard, "space-y-4")}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">队伍成员信息</h2>
            <p className="text-xs text-[var(--gp-muted,#646a73)]">
              查看队伍内每位学生的详细信息，或指定新的队长。
            </p>
          </div>
          {leaderFeedback && (
            <TeacherFeedbackPill
              tone={leaderFeedback.tone}
              message={leaderFeedback.message}
              autoHideMs={3500}
              onDismiss={() => setLeaderFeedback(null)}
            />
          )}
        </div>

        {data.members.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] py-8 text-center text-xs text-[var(--gp-muted,#646a73)]">
            当前队伍暂无成员
          </div>
        ) : (
          <>
            <div className="space-y-2.5 md:hidden">
              {data.members.map((member) => {
                const initial = (member.name || member.student_number || "生").slice(0, 1);
                const isRowLoading = setLeader.isPending && setLeader.variables === member.id;
                return (
                  <div
                    key={member.id}
                    className="space-y-2.5 rounded-[10px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)]/50 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-xs font-bold text-[#1d4ed8]">
                          {initial}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-[var(--gp-ink,#1f2329)]">
                            {member.name || "未命名学生"}
                          </div>
                          <div className="gp-tabular truncate text-xs text-[var(--gp-muted,#646a73)]">
                            {member.student_number || "无学号"}
                          </div>
                        </div>
                      </div>
                      {member.role === "leader" ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                          <Crown size={11} />
                          队长
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-2 py-0.5 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                          队员
                        </span>
                      )}
                    </div>

                    <div className="gp-tabular flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--gp-muted,#646a73)]">
                      <span className="truncate">{member.email || "未公开"}</span>
                      <span>{dateTime(member.joined_at)}</span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-2">
                      <span className="gp-tabular text-xs text-[var(--gp-ink-soft,#4e5969)]">
                        {tr("未完任务数")}: {member.open_task_count}
                      </span>
                      {canManage && !group.roster_frozen && member.role !== "leader" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          pill
                          loading={isRowLoading}
                          preserveWidth
                          disabled={setLeader.isPending}
                          onClick={() => setLeader.mutate(member.id)}
                        >
                          设为队长
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">队伍成员列表</caption>
                <thead>
                  <tr className="border-b border-[var(--gp-border,#dee0e3)] text-xs font-semibold text-[var(--gp-muted,#646a73)]">
                    <th className="whitespace-nowrap py-2.5 pr-4">学生姓名</th>
                    <th className="whitespace-nowrap px-4 py-2.5">学号</th>
                    <th className="whitespace-nowrap px-4 py-2.5">邮箱</th>
                    <th className="whitespace-nowrap px-4 py-2.5">队内角色</th>
                    <th className="whitespace-nowrap px-4 py-2.5">未完任务数</th>
                    <th className="whitespace-nowrap px-4 py-2.5">入队时间</th>
                    {canManage && !group.roster_frozen && (
                      <th className="whitespace-nowrap py-2.5 pl-4 text-right">操作</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
                  {data.members.map((member) => {
                    const initial = (member.name || member.student_number || "生").slice(0, 1);
                    const isRowLoading = setLeader.isPending && setLeader.variables === member.id;
                    return (
                      <tr
                        key={member.id}
                        className="transition-colors hover:bg-[var(--gp-surface-subtle,#f8f9fa)]"
                      >
                        <td className="py-3 pr-4 font-medium text-[var(--gp-ink,#1f2329)]">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#e8f0fe] text-xs font-bold text-[#1d4ed8]">
                              {initial}
                            </span>
                            <span>{member.name || "未命名学生"}</span>
                          </div>
                        </td>
                        <td className="gp-tabular whitespace-nowrap px-4 py-3 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                          {member.student_number || "无学号"}
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                          {member.email || "未公开"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs">
                          {member.role === "leader" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                              <Crown size={11} />
                              队长
                            </span>
                          ) : (
                            <span className="rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-2 py-0.5 text-[var(--gp-ink-soft,#4e5969)]">
                              队员
                            </span>
                          )}
                        </td>
                        <td className="gp-tabular whitespace-nowrap px-4 py-3 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                          {member.open_task_count}
                        </td>
                        <td className="gp-tabular whitespace-nowrap px-4 py-3 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                          {dateTime(member.joined_at)}
                        </td>
                        {canManage && !group.roster_frozen && (
                          <td className="whitespace-nowrap py-3 pl-4 text-right">
                            {member.role !== "leader" && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                pill
                                loading={isRowLoading}
                                preserveWidth
                                disabled={setLeader.isPending}
                                onClick={() => setLeader.mutate(member.id)}
                              >
                                设为队长
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className={cn(feishuCard, "space-y-4")}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
              队伍里程碑进度
            </h2>
            <p className="text-xs text-[var(--gp-muted,#646a73)]">
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
          <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] py-10 text-center text-xs text-[var(--gp-muted,#646a73)]">
            该队伍尚未创建立项项目，立项并添加里程碑后将在此展示进度详情。
          </div>
        ) : data.milestones.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] py-10 text-center text-xs text-[var(--gp-muted,#646a73)]">
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
                  className="rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={ms.href}
                          className="text-sm font-semibold text-[var(--gp-ink,#1f2329)] hover:text-[var(--gp-action,#3370ff)]"
                        >
                          {ms.title}
                        </Link>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            ms.status === "completed"
                              ? "bg-[#ecfdf5] text-[#008a5c]"
                              : ms.overdue
                                ? "bg-[#fef2f2] text-[#d93025]"
                                : "bg-[#e8f0fe] text-[#1d4ed8]",
                          )}
                        >
                          {milestoneStatusLabels[ms.status]
                            ? tr(milestoneStatusLabels[ms.status])
                            : ms.status}
                        </span>
                        {ms.overdue && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#fef2f2] px-2 py-0.5 text-xs font-medium text-[#d93025]">
                            <AlertTriangle size={11} />
                            已逾期
                          </span>
                        )}
                        {riskLevel && (
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs font-medium",
                              riskLevel === "high"
                                ? "bg-[#fef2f2] text-[#d93025]"
                                : riskLevel === "medium"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
                            )}
                          >
                            {riskLabels[riskLevel] ? tr(riskLabels[riskLevel]) : riskLevel}
                          </span>
                        )}
                      </div>
                      {ms.description && (
                        <p className="text-xs text-[var(--gp-muted,#646a73)]">{ms.description}</p>
                      )}
                    </div>

                    <Link
                      href={ms.href}
                      data-variant="outline"
                      className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
                    >
                      查看里程碑详情
                      <ArrowRight size={13} />
                    </Link>
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <div className="gp-tabular flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                      <span>
                        {tr("关联任务：{0}/{1} 已完成", {
                          0: ms.completed_task_count,
                          1: ms.task_count,
                        })}
                      </span>
                      <span>{tr("截止时间：{0}", { 0: dateTime(ms.deadline) })}</span>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-[var(--gp-surface-hover,#eff0f1)]"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full bg-[var(--gp-action,#3370ff)] transition-all"
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
