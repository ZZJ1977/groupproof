"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Calendar, ShieldCheck, Users } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { dateTime, errorText } from "@/features/b/ui";
import { cn } from "@/lib/utils";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { teacherClassesApi, teacherKeys } from "@/features/teacher/api/teacher-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

export function TeacherClassHomeApiPage({ courseId }: { courseId: string }) {
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

  if (detail.isLoading) {
    return (
      <div role="status" className="min-w-0 max-w-full space-y-5">
        <span className="sr-only">{tr("正在加载…")}</span>
        <div className={cn(feishuCard, "animate-pulse space-y-3")}>
          <div className="h-6 w-56 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
          <div className="h-4 w-80 max-w-full rounded bg-[var(--gp-surface-subtle,#f8f9fa)]" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((idx) => (
            <div key={idx} className={cn(feishuCard, "h-24 animate-pulse")} />
          ))}
        </div>
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void detail.refetch();
            void plaza.refetch();
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  const course = detail.data;
  const groups = plaza.data?.groups ?? [];
  const groupedCount = Math.max(0, course.student_count - course.ungrouped_count);
  const projectGroups = groups.filter((g) => g.has_project);
  const attentionGroups = groups.filter(
    (g) => g.progress.overdue_count > 0 || g.progress.risk_level === "high" || g.progress.risk_level === "medium",
  );
  const trackingPercents = groups
    .map((g) => g.progress.overall_percent)
    .filter((v): v is number => v !== null);
  const avgProgress =
    trackingPercents.length > 0
      ? Math.round(trackingPercents.reduce((sum, v) => sum + v, 0) / trackingPercents.length)
      : null;

  const previewGroups = [...groups]
    .sort((a, b) => {
      const aAlert = (a.progress.overdue_count > 0 ? 2 : 0) + (a.progress.risk_level === "high" ? 2 : a.progress.risk_level === "medium" ? 1 : 0);
      const bAlert = (b.progress.overdue_count > 0 ? 2 : 0) + (b.progress.risk_level === "high" ? 2 : b.progress.risk_level === "medium" ? 1 : 0);
      if (bAlert !== aAlert) return bAlert - aAlert;
      return (b.has_project ? 1 : 0) - (a.has_project ? 1 : 0);
    })
    .slice(0, 5);

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <div className={cn(feishuCard, "space-y-3")}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="break-words text-lg font-bold text-[var(--gp-ink,#1f2329)]">
              {course.name}
            </h1>
            <div className="gp-tabular flex flex-wrap items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-[8px] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2.5 py-1 font-medium">
                <Users size={13} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
                <span className="break-words">
                  {tr("队伍人数要求：{0}-{1} 人", {
                    0: course.min_group_size,
                    1: course.max_group_size,
                  })}
                </span>
              </span>
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-[8px] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2.5 py-1 font-medium">
                <Calendar size={13} className="shrink-0 text-[var(--gp-muted,#646a73)]" />
                <span className="break-words">
                  {tr("组队截止：{0}", { 0: dateTime(course.formation_deadline) })}
                </span>
              </span>
            </div>
          </div>

          <div className="flex max-w-full flex-wrap items-center gap-2">
            <Link
              href={`/teacher/courses/${courseId}/projects`}
              data-variant="outline"
              className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
            >
              {tr("项目监控")}
            </Link>
            <Link
              href={`/teacher/courses/${courseId}/groups`}
              data-variant="default"
              className={buttonVariants({ variant: "default", size: "sm", pill: true })}
            >
              <Users size={15} />
              进入学生组队广场
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className={feishuCard}>
          <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">入班学生总数</div>
          <div className="gp-tabular mt-2 text-2xl font-bold text-[var(--gp-ink,#1f2329)]">
            {course.student_count}
          </div>
        </div>
        <div className={feishuCard}>
          <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">已组队学生</div>
          <div className="gp-tabular mt-2 text-2xl font-bold text-[#008a5c]">{groupedCount}</div>
        </div>
        <div className={feishuCard}>
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-xs font-medium text-[var(--gp-muted,#646a73)]">未组队学生</span>
            {course.ungrouped_count > 0 && (
              <Link
                href={`/teacher/courses/${courseId}/groups`}
                data-variant="tonal"
                className={cn(
                  buttonVariants({ variant: "tonal", size: "sm", pill: true }),
                  "h-6 px-2 text-[11px]",
                )}
              >
                去分配
              </Link>
            )}
          </div>
          <div className="gp-tabular mt-2 text-2xl font-bold text-[var(--gp-action,#3370ff)]">
            {course.ungrouped_count}
          </div>
        </div>
        <div className={feishuCard}>
          <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">当前队伍数</div>
          <div className="gp-tabular mt-2 text-2xl font-bold text-[var(--gp-ink,#1f2329)]">
            {course.group_count}
          </div>
          {plaza.data && (
            <div className="gp-tabular mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              {tr("已立项")} {projectGroups.length} / {groups.length}
            </div>
          )}
        </div>
      </div>

      <div className={cn(feishuCard, "space-y-4")}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
              班级队伍进度总览
            </h2>
            <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
              点击任意队伍可查看组员详情与里程碑进度。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/teacher/courses/${courseId}/groups`}
              data-variant="tonal"
              className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
            >
              前往组队广场管理
            </Link>
          </div>
        </div>

        {plaza.error ? (
          <TeacherFeedbackPill
            tone="error"
            message={errorText(plaza.error)}
            action={{ label: tr("重试"), onClick: () => void plaza.refetch() }}
          />
        ) : plaza.isLoading ? (
          <div role="status" className="animate-pulse space-y-2.5">
            <span className="sr-only">{tr("正在加载…")}</span>
            <div className="h-12 rounded-[10px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
            <div className="h-12 rounded-[10px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] py-10 text-center text-xs text-[var(--gp-muted,#646a73)]">
            当前班级还没有任何队伍，前往「学生组队广场」即可新建队伍并为未组队学生分配。
          </div>
        ) : (
          <div className="space-y-3">
            <div className="gp-tabular flex flex-wrap items-center gap-3 rounded-[10px] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3.5 py-2.5 text-xs text-[var(--gp-ink-soft,#4e5969)]">
              <span className="inline-flex items-center gap-1 font-medium">
                <ShieldCheck size={13} className="text-[var(--gp-action,#3370ff)]" />
                {tr("已立项")} {projectGroups.length} / {groups.length}
              </span>
              {avgProgress !== null && (
                <span>{tr("整体进度 {0}%", { 0: avgProgress })}</span>
              )}
              {attentionGroups.length > 0 && (
                <span className="inline-flex items-center gap-1 font-medium text-[var(--gp-warning,#d97706)]">
                  <AlertTriangle size={12} />
                  {tr("{0} 支队伍存在预警", { 0: attentionGroups.length })}
                </span>
              )}
            </div>

            <div className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
              {previewGroups.map((group) => {
                const pct = group.progress.overall_percent;
                return (
                  <div
                    key={group.id}
                    className="flex min-w-0 flex-col gap-2.5 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/teacher/courses/${courseId}/groups/${group.id}`}
                          title={group.name}
                          className="max-w-full truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)] hover:text-[var(--gp-action,#3370ff)]"
                        >
                          {group.name}
                        </Link>
                        <span className="gp-tabular shrink-0 rounded-full bg-[var(--gp-surface-subtle,#f8f9fa)] px-2 py-0.5 text-[11px] font-medium text-[var(--gp-ink-soft,#4e5969)]">
                          {tr("{0}/{1} 人", {
                            0: group.member_count,
                            1: group.max_group_size,
                          })}
                        </span>
                        {group.has_project ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-[11px] font-medium text-[#1d4ed8]">
                            <ShieldCheck size={11} />
                            已立项
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-2 py-0.5 text-[11px] text-[var(--gp-muted,#646a73)]">
                            {tr("未立项")}
                          </span>
                        )}
                      </div>
                      {group.direction && (
                        <p className="truncate text-xs text-[var(--gp-muted,#646a73)]" title={group.direction}>
                          {group.direction}
                        </p>
                      )}
                    </div>

                    <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:max-w-[260px] sm:flex-1">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="gp-tabular flex items-center justify-between text-[11px] text-[var(--gp-muted,#646a73)]">
                          <span>
                            {pct !== null
                              ? tr("整体进度 {0}%", { 0: pct })
                              : group.progress.state === "no_project"
                                ? tr("未立项")
                                : tr("暂无里程碑")}
                          </span>
                          {group.progress.overdue_count > 0 && (
                            <span className="font-medium text-[var(--gp-danger,#d93025)]">
                              {tr("逾期 {0}", { 0: group.progress.overdue_count })}
                            </span>
                          )}
                        </div>
                        <div
                          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--gp-surface-hover,#eff0f1)]"
                          role="progressbar"
                          aria-valuenow={pct ?? 0}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className="h-full rounded-full bg-[var(--gp-action,#3370ff)] transition-all"
                            style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
                          />
                        </div>
                      </div>

                      <Link
                        href={`/teacher/courses/${courseId}/groups/${group.id}`}
                        data-variant="outline"
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
                      >
                        查看详情
                        <ArrowRight size={13} />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>

            {groups.length > 5 && (
              <div className="flex justify-end pt-1">
                <Link
                  href={`/teacher/courses/${courseId}/groups`}
                  data-variant="ghost"
                  className={buttonVariants({ variant: "ghost", size: "sm", pill: true })}
                >
                  {tr("查看全部")}
                  <ArrowRight size={13} />
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
