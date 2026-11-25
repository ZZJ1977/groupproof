"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, Download, FileSpreadsheet, ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorText } from "@/features/b/ui";
import { ActivityRanking } from "@/features/teacher/charts/ActivityRanking";
import { MilestoneTimeline } from "@/features/teacher/charts/MilestoneTimeline";
import { ProgressChart } from "@/features/teacher/charts/ProgressChart";
import { RiskMatrix } from "@/features/teacher/charts/RiskMatrix";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";
import {
  type ExportFormat,
  teacherReportsApi,
  teacherReportsKeys,
} from "@/features/teacher/api/teacher-reports-client";
import { useTeacherPermissions } from "@/features/teacher/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

export function TeacherReportsApiPage({ courseId }: { courseId: string }) {
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const overviewQ = useQuery({
    queryKey: teacherReportsKeys.overview(userId, courseId),
    queryFn: () => teacherReportsApi.overview(courseId),
    enabled: Boolean(courseId),
  });
  const progressQ = useQuery({
    queryKey: teacherReportsKeys.progress(userId, courseId),
    queryFn: () => teacherReportsApi.progress(courseId),
    enabled: Boolean(courseId),
  });
  const milestonesQ = useQuery({
    queryKey: teacherReportsKeys.milestones(userId, courseId),
    queryFn: () => teacherReportsApi.milestones(courseId),
    enabled: Boolean(courseId),
  });
  const risksQ = useQuery({
    queryKey: teacherReportsKeys.risks(userId, courseId),
    queryFn: () => teacherReportsApi.risks(courseId),
    enabled: Boolean(courseId),
  });
  const activityQ = useQuery({
    queryKey: teacherReportsKeys.activity(userId, courseId),
    queryFn: () => teacherReportsApi.activity(courseId),
    enabled: Boolean(courseId),
  });
  const contributionQ = useQuery({
    queryKey: teacherReportsKeys.contribution(userId, courseId),
    queryFn: () => teacherReportsApi.contribution(courseId),
    enabled: Boolean(courseId),
  });

  const canExport = overviewQ.data?.can_export ?? perms.exportReports;

  const exportMut = useMutation({
    mutationFn: (format: ExportFormat) => teacherReportsApi.exportReport(courseId, format),
    onSuccess: (res) => {
      if (typeof window !== "undefined") {
        const blob = new Blob([res.content], { type: res.mime_type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = res.filename;
        link.click();
        URL.revokeObjectURL(url);
      }
      setFeedback({ tone: "success", text: tr("报告已导出：{0}", { 0: res.filename }) });
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const ov = overviewQ.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          variant="segmented"
          size="sm"
          ariaLabel={tr("项目与报告")}
          testId="hub4-segmented-tabs"
          activeId="reports"
          items={[
            {
              id: "projects",
              label: tr("项目监控"),
              href: `/teacher/courses/${courseId}/projects`,
              icon: ListTree,
            },
            {
              id: "reports",
              label: tr("班级数据报告"),
              href: `/teacher/courses/${courseId}/reports`,
              icon: BarChart3,
            },
          ]}
        />
        <TeacherFeedbackPill
          tone={feedback?.tone ?? "idle"}
          message={feedback?.text}
          autoHideMs={3500}
          onDismiss={() => setFeedback(null)}
        />
      </div>

      <div className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--gp-ink,#1f2329)]">
            <BarChart3 size={18} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
            <span>{tr("数据报告中心")}</span>
          </h1>
          <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("实时聚合全班队伍进度、里程碑逾期、D 模块风险预警与 GitHub/任务活跃度指标。")}
          </p>
        </div>
        {canExport && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              loading={exportMut.isPending && exportMut.variables === "csv"}
              disabled={exportMut.isPending}
              preserveWidth
              onClick={() => exportMut.mutate("csv")}
            >
              <FileSpreadsheet size={15} aria-hidden="true" />
              {tr("导出 CSV / Excel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={exportMut.isPending && exportMut.variables === "markdown"}
              disabled={exportMut.isPending}
              preserveWidth
              onClick={() => exportMut.mutate("markdown")}
            >
              <Download size={15} aria-hidden="true" />
              {tr("导出 Markdown")}
            </Button>
          </div>
        )}
      </div>

      {overviewQ.isLoading ? (
        <div role="status" className={`${panelClass} text-sm text-[var(--gp-muted,#646a73)]`}>
          {tr("正在汇总教学数据报告…")}
        </div>
      ) : overviewQ.isError ? (
        <div
          role="alert"
          className={`${panelClass} flex flex-wrap items-center justify-between gap-3 border-red-200 bg-red-50 text-sm text-[var(--gp-danger,#d93025)]`}
        >
          <span>{errorText(overviewQ.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void overviewQ.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : (
        ov && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className={panelClass}>
              <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                {tr("在研项目总数")}
              </div>
              <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-ink,#1f2329)]">
                {ov.project_count}
              </div>
              <div className="gp-tabular mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                {tr("已立项 {0} 支", { 0: ov.project_count })}
              </div>
            </div>
            <div className={panelClass}>
              <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                {tr("整体平均进度")}
              </div>
              <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-action,#3370ff)]">
                {ov.overall_progress !== null ? `${ov.overall_progress}%` : "—"}
              </div>
              <div className="gp-tabular mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                {tr("逾期里程碑 {0} 个", { 0: ov.overdue_milestones })}
              </div>
            </div>
            <div className={panelClass}>
              <div className="text-xs font-medium text-[var(--gp-muted,#646a73)]">
                {tr("风险预警队伍")}
              </div>
              <div className="gp-tabular mt-1.5 text-2xl font-bold text-[var(--gp-danger,#d93025)]">
                {ov.high_risk_groups + ov.medium_risk_groups}
              </div>
              <div className="gp-tabular mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                {tr("高风险 {0} · 中风险 {1}", {
                  0: ov.high_risk_groups,
                  1: ov.medium_risk_groups,
                })}
              </div>
            </div>
          </div>
        )
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className={`${panelClass} min-w-0 space-y-3`}>
          <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
            {tr("各队伍进度分布")}
          </h2>
          {progressQ.isLoading ? (
            <p className="text-sm text-[var(--gp-muted,#646a73)]">{tr("加载中…")}</p>
          ) : progressQ.isError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--gp-danger,#d93025)]">
              <span>{errorText(progressQ.error)}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void progressQ.refetch()}>
                {tr("重试")}
              </Button>
            </div>
          ) : (
            <ProgressChart items={progressQ.data?.items ?? []} />
          )}
        </div>

        <div className={`${panelClass} min-w-0 space-y-3`}>
          <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
            {tr("风险预警明细")}
          </h2>
          {risksQ.isLoading ? (
            <p className="text-sm text-[var(--gp-muted,#646a73)]">{tr("加载中…")}</p>
          ) : risksQ.isError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--gp-danger,#d93025)]">
              <span>{errorText(risksQ.error)}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void risksQ.refetch()}>
                {tr("重试")}
              </Button>
            </div>
          ) : (
            <RiskMatrix items={risksQ.data?.items ?? []} />
          )}
        </div>
      </div>

      <div className={`${panelClass} min-w-0 space-y-3`}>
        <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
          {tr("里程碑时间线矩阵")}
        </h2>
        {milestonesQ.isLoading ? (
          <p className="text-sm text-[var(--gp-muted,#646a73)]">{tr("加载中…")}</p>
        ) : milestonesQ.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--gp-danger,#d93025)]">
            <span>{errorText(milestonesQ.error)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void milestonesQ.refetch()}>
              {tr("重试")}
            </Button>
          </div>
        ) : (
          <MilestoneTimeline rows={milestonesQ.data?.rows ?? []} />
        )}
      </div>

      <div className={`${panelClass} min-w-0 space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
            {tr("学生活跃度排行")}
          </h2>
          {activityQ.data && (
            <div className="gp-tabular text-xs text-[var(--gp-muted,#646a73)]">
              {tr("GitHub 事件 {0} · 进度事件 {1} · 飞书消息 {2}", {
                0: activityQ.data.total_github_events,
                1: activityQ.data.total_progress_events,
                2: activityQ.data.feishu_message_count,
              })}
            </div>
          )}
        </div>
        {activityQ.isLoading ? (
          <p className="text-sm text-[var(--gp-muted,#646a73)]">{tr("加载中…")}</p>
        ) : activityQ.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--gp-danger,#d93025)]">
            <span>{errorText(activityQ.error)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void activityQ.refetch()}>
              {tr("重试")}
            </Button>
          </div>
        ) : (
          <ActivityRanking items={activityQ.data?.items ?? []} />
        )}
      </div>

      <div className={`${panelClass} min-w-0 space-y-3`}>
        <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
          {tr("贡献度快照总览")}
        </h2>
        {contributionQ.isLoading ? (
          <p className="text-sm text-[var(--gp-muted,#646a73)]">{tr("加载中…")}</p>
        ) : contributionQ.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--gp-danger,#d93025)]">
            <span>{errorText(contributionQ.error)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void contributionQ.refetch()}>
              {tr("重试")}
            </Button>
          </div>
        ) : (contributionQ.data?.projects.length ?? 0) === 0 ? (
          <p className="py-4 text-sm text-[var(--gp-muted,#646a73)]">
            {tr("暂无已生成贡献度快照的项目")}
          </p>
        ) : (
          <div className="space-y-3">
            {contributionQ.data?.projects.map((proj) => (
              <div
                key={proj.project_id}
                className="rounded-[10px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-3.5"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate font-semibold text-[var(--gp-ink,#1f2329)]">
                    {proj.group_name} · {proj.project_name}
                  </span>
                  <span className="gp-tabular shrink-0 text-[var(--gp-muted,#646a73)]">
                    {proj.version_no
                      ? tr("版本 v{0} ({1})", { 0: proj.version_no, 1: proj.status ?? "" })
                      : tr("尚未生成快照")}
                  </span>
                </div>
                {proj.items.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {proj.items.map((m) => (
                      <div
                        key={m.user_id}
                        className="rounded-[8px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-[var(--gp-ink,#1f2329)]">{m.name}</span>
                        <span className="gp-tabular ml-2 font-medium text-[var(--gp-action-on-soft,#1d4ed8)]">
                          {m.share}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
