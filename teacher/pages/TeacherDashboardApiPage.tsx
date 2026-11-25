"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowRight, BookOpen, CheckSquare } from "lucide-react";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import { errorText } from "@/shared/lib/b-ui";
import { cn } from "@/shared/lib/utils";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { teacherDashboardApi, teacherDashboardKeys } from "@/teacher/api/teacher-dashboard-client";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const feishuCard =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

export function TeacherDashboardApiPage() {
  const { userId } = useWorkspace();

  const dashQ = useQuery({
    queryKey: teacherDashboardKeys.overview(userId),
    queryFn: () => teacherDashboardApi.overview(),
    enabled: Boolean(userId),
  });
  const actionsQ = useQuery({
    queryKey: teacherDashboardKeys.actions(userId),
    queryFn: () => teacherDashboardApi.actions(),
    enabled: Boolean(userId),
  });
  const risksQ = useQuery({
    queryKey: teacherDashboardKeys.risks(userId),
    queryFn: () => teacherDashboardApi.risks(),
    enabled: Boolean(userId),
  });

  const data = dashQ.data;

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--gp-ink,#1f2329)]">
            <Activity size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
            <span className="truncate">{tr("教师工作台")}</span>
          </h1>
          <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("跨班级聚合展示待审批事项、风险预警队伍与近期教学活动流。")}
          </p>
        </div>
        <Link
          href="/teacher/courses"
          data-variant="default"
          className={buttonVariants({ variant: "default", size: "sm", pill: true })}
        >
          <BookOpen size={15} />
          {tr("管理我的班级")}
        </Link>
      </div>

      {dashQ.isLoading ? (
        <div role="status" className="space-y-5">
          <span className="sr-only">{tr("正在加载教师工作台数据…")}</span>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((idx) => (
              <div key={idx} className={cn(feishuCard, "animate-pulse space-y-3")}>
                <div className="h-3 w-24 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
                <div className="h-7 w-16 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
                <div className="h-3 w-32 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
              </div>
            ))}
          </div>
          <div className={cn(feishuCard, "animate-pulse space-y-3")}>
            <div className="h-4 w-32 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((idx) => (
                <div key={idx} className="h-28 rounded-[12px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
              ))}
            </div>
          </div>
        </div>
      ) : dashQ.isError ? (
        <div role="alert" className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}>
          <TeacherFeedbackPill tone="error" message={errorText(dashQ.error)} />
          <Button type="button" variant="outline" size="sm" onClick={() => void dashQ.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : (
        data && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={cn(feishuCard, "min-w-0")}>
                <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                  {tr("跨班待处理事项")}
                </div>
                <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-action,#3370ff)]">
                  {data.total_pending_actions}
                </div>
              </div>
              <div className={cn(feishuCard, "min-w-0")}>
                <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                  {tr("我管理的班级")}
                </div>
                <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-ink,#1f2329)]">
                  {data.total_classes}
                </div>
                <div className="gp-tabular mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                  {tr("学生 {0} 人 · 小组 {1} 支", {
                    0: data.total_students,
                    1: data.total_groups,
                  })}
                </div>
              </div>
              <div className={cn(feishuCard, "min-w-0")}>
                <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                  {tr("在研项目总数")}
                </div>
                <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-ink,#1f2329)]">
                  {data.total_projects}
                </div>
              </div>
              <div className={cn(feishuCard, "min-w-0")}>
                <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                  {tr("全局风险队伍")}
                </div>
                <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-danger,#d93025)]">
                  {data.high_risk_groups + data.medium_risk_groups}
                </div>
                <div className="gp-tabular mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                  {tr("高风险 {0} · 中风险 {1}", {
                    0: data.high_risk_groups,
                    1: data.medium_risk_groups,
                  })}
                </div>
              </div>
            </div>

            <div className={cn(feishuCard, "min-w-0 space-y-4")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                  {tr("授课班级概览")}
                </h2>
                <Link
                  href="/teacher/courses"
                  data-variant="outline"
                  className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
                >
                  {tr("全部班级")}
                </Link>
              </div>
              {data.classes.length === 0 ? (
                <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
                  {tr("尚未创建或加入管理任何班级")}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {data.classes.map((cls) => (
                    <Link
                      key={cls.course_id}
                      href={cls.href}
                      className="gp-card-interactive block min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 hover:border-[var(--gp-action,#3370ff)]/50"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate font-semibold text-[var(--gp-ink,#1f2329)]"
                            title={cls.name}
                          >
                            {cls.name}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-[var(--gp-muted,#646a73)]">
                            {cls.semester}
                          </div>
                        </div>
                        {cls.pending_actions > 0 && (
                          <span className="gp-tabular shrink-0 rounded-full bg-[var(--gp-danger,#d93025)] px-2 py-0.5 text-[11px] font-bold text-white">
                            {cls.pending_actions}
                          </span>
                        )}
                      </div>
                      <div className="gp-tabular mt-3 flex flex-wrap gap-3 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                        <span>{tr("{0} 名学生", { 0: cls.student_count })}</span>
                        <span>{tr("{0} 支队伍", { 0: cls.group_count })}</span>
                        <span>
                          {tr("进度 {0}%", { 0: cls.overall_progress ?? "—" })}
                        </span>
                      </div>
                      {cls.risk_count > 0 && (
                        <div className="gp-tabular mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--gp-warning,#d97706)]">
                          <AlertTriangle size={12} />
                          {tr("{0} 支队伍存在预警", { 0: cls.risk_count })}
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div className={cn(feishuCard, "min-w-0 space-y-3")}>
                <div className="flex items-center gap-2 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                  <CheckSquare size={17} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
                  <span>{tr("跨班级待处理事项")}</span>
                </div>
                {actionsQ.isLoading ? (
                  <div className="animate-pulse space-y-2 py-2" role="status">
                    <span className="sr-only">{tr("加载中…")}</span>
                    <div className="h-9 rounded-lg bg-[var(--gp-surface-subtle,#f8f9fa)]" />
                    <div className="h-9 rounded-lg bg-[var(--gp-surface-subtle,#f8f9fa)]" />
                  </div>
                ) : actionsQ.isError ? (
                  <TeacherFeedbackPill
                    tone="error"
                    message={errorText(actionsQ.error)}
                    action={{ label: tr("重试"), onClick: () => void actionsQ.refetch() }}
                  />
                ) : (actionsQ.data?.items.length ?? 0) === 0 ? (
                  <p className="py-4 text-sm text-[var(--gp-muted,#646a73)]">
                    {tr("所有班级待办均已清零")}
                  </p>
                ) : (
                  <div className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
                    {actionsQ.data?.items.slice(0, 8).map((act) => (
                      <div key={act.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate text-sm font-medium text-[var(--gp-ink,#1f2329)]"
                            title={act.title}
                          >
                            {act.title}
                          </div>
                          <div className="truncate text-xs text-[var(--gp-muted,#646a73)]">
                            {act.description}
                          </div>
                        </div>
                        <Link
                          href={act.href}
                          data-variant="tonal"
                          className={cn(
                            buttonVariants({ variant: "tonal", size: "sm", pill: true }),
                            "h-7 shrink-0 px-2.5 text-xs",
                          )}
                        >
                          {tr("去处理")}
                          <ArrowRight size={12} />
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={cn(feishuCard, "min-w-0 space-y-3")}>
                <div className="flex items-center gap-2 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                  <AlertTriangle size={17} className="shrink-0 text-[var(--gp-warning,#d97706)]" />
                  <span>{tr("全局风险与近期动态")}</span>
                </div>
                {risksQ.isError && (
                  <TeacherFeedbackPill
                    tone="error"
                    message={errorText(risksQ.error)}
                    action={{ label: tr("重试"), onClick: () => void risksQ.refetch() }}
                  />
                )}
                {(risksQ.data?.items.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    {risksQ.data?.items.slice(0, 4).map((r) => (
                      <div
                        key={r.group_id}
                        className="rounded-[8px] border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-xs text-[#991b1b]"
                      >
                        <span className="font-semibold">{r.group_name}</span> ·{" "}
                        {r.reasons[0] ?? r.risk_level}
                      </div>
                    ))}
                  </div>
                )}
                {data.recent_activity.length === 0 ? (
                  <p className="py-4 text-sm text-[var(--gp-muted,#646a73)]">
                    {tr("暂无近期跨班动态")}
                  </p>
                ) : (
                  <div className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
                    {data.recent_activity.slice(0, 8).map((ev) => (
                      <Link
                        key={ev.id}
                        href={ev.href}
                        className="flex items-center justify-between gap-2 rounded-[6px] px-1 py-2 text-xs transition-colors hover:bg-[var(--gp-surface-hover,#eff0f1)]"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          <span className="max-w-[140px] shrink-0 truncate rounded bg-[var(--gp-surface-subtle,#f8f9fa)] px-1.5 py-0.5 font-medium text-[var(--gp-ink-soft,#4e5969)]">
                            {ev.course_name}
                          </span>
                          <span className="truncate font-medium text-[var(--gp-ink,#1f2329)]">
                            {ev.title}
                          </span>
                        </div>
                        <span className="gp-tabular shrink-0 text-[var(--gp-subtle,#8f959e)]">
                          {ev.occurred_at.slice(0, 10)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
