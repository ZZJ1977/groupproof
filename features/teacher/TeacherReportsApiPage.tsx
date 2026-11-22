"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, Download, FileSpreadsheet } from "lucide-react";
import { button, card, errorText, secondary } from "@/features/b/ui";
import { ActivityRanking } from "@/features/teacher/charts/ActivityRanking";
import { MilestoneTimeline } from "@/features/teacher/charts/MilestoneTimeline";
import { ProgressChart } from "@/features/teacher/charts/ProgressChart";
import { RiskMatrix } from "@/features/teacher/charts/RiskMatrix";
import {
  type ExportFormat,
  teacherReportsApi,
  teacherReportsKeys,
} from "@/lib/api/teacher-reports-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

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
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <BarChart3 size={18} className="text-blue-600" />
            {tr("数据报告中心")}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {tr("实时聚合全班队伍进度、里程碑逾期、D 模块风险预警与 GitHub/任务活跃度指标。")}
          </p>
        </div>
        {canExport && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={exportMut.isPending}
              onClick={() => exportMut.mutate("csv")}
              className={`${button} inline-flex items-center gap-1.5`}
            >
              <FileSpreadsheet size={15} />
              {tr("导出 CSV / Excel")}
            </button>
            <button
              type="button"
              disabled={exportMut.isPending}
              onClick={() => exportMut.mutate("markdown")}
              className={`${secondary} inline-flex items-center gap-1.5`}
            >
              <Download size={15} />
              {tr("导出 Markdown")}
            </button>
          </div>
        )}
      </div>

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border px-4 py-3 text-sm ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {feedback.text}
        </div>
      )}

      {overviewQ.isLoading ? (
        <div className={card}>{tr("正在汇总教学数据报告…")}</div>
      ) : overviewQ.isError ? (
        <div className={`${card} text-sm text-red-600`}>{errorText(overviewQ.error)}</div>
      ) : (
        ov && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className={card}>
              <div className="text-xs text-slate-500">{tr("班级学生总数")}</div>
              <div className="mt-1 text-2xl font-bold text-slate-900">{ov.student_count}</div>
              <div className="mt-1 text-xs text-slate-500">
                {tr("未分组 {0} 人", { 0: ov.ungrouped_count })}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-slate-500">{tr("已建队伍")}</div>
              <div className="mt-1 text-2xl font-bold text-slate-900">{ov.group_count}</div>
              <div className="mt-1 text-xs text-slate-500">
                {tr("已立项 {0} 支", { 0: ov.project_count })}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-slate-500">{tr("整体平均进度")}</div>
              <div className="mt-1 text-2xl font-bold text-blue-600">
                {ov.overall_progress !== null ? `${ov.overall_progress}%` : "—"}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {tr("逾期里程碑 {0} 个", { 0: ov.overdue_milestones })}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-slate-500">{tr("风险预警队伍")}</div>
              <div className="mt-1 text-2xl font-bold text-red-600">
                {ov.high_risk_groups + ov.medium_risk_groups}
              </div>
              <div className="mt-1 text-xs text-slate-500">
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
        <div className={`${card} space-y-3`}>
          <h2 className="text-base font-semibold text-slate-900">{tr("各队伍进度分布")}</h2>
          {progressQ.isLoading ? (
            <p className="text-sm text-slate-500">{tr("加载中…")}</p>
          ) : (
            <ProgressChart items={progressQ.data?.items ?? []} />
          )}
        </div>

        <div className={`${card} space-y-3`}>
          <h2 className="text-base font-semibold text-slate-900">{tr("风险预警明细")}</h2>
          {risksQ.isLoading ? (
            <p className="text-sm text-slate-500">{tr("加载中…")}</p>
          ) : (
            <RiskMatrix items={risksQ.data?.items ?? []} />
          )}
        </div>
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="text-base font-semibold text-slate-900">{tr("里程碑时间线矩阵")}</h2>
        {milestonesQ.isLoading ? (
          <p className="text-sm text-slate-500">{tr("加载中…")}</p>
        ) : (
          <MilestoneTimeline rows={milestonesQ.data?.rows ?? []} />
        )}
      </div>

      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">{tr("学生活跃度排行")}</h2>
          {activityQ.data && (
            <div className="text-xs text-slate-500">
              {tr("GitHub 事件 {0} · 进度事件 {1} · 飞书消息 {2}", {
                0: activityQ.data.total_github_events,
                1: activityQ.data.total_progress_events,
                2: activityQ.data.feishu_message_count,
              })}
            </div>
          )}
        </div>
        {activityQ.isLoading ? (
          <p className="text-sm text-slate-500">{tr("加载中…")}</p>
        ) : (
          <ActivityRanking items={activityQ.data?.items ?? []} />
        )}
      </div>

      <div className={`${card} space-y-3`}>
        <h2 className="text-base font-semibold text-slate-900">{tr("贡献度快照总览")}</h2>
        {contributionQ.isLoading ? (
          <p className="text-sm text-slate-500">{tr("加载中…")}</p>
        ) : (contributionQ.data?.projects.length ?? 0) === 0 ? (
          <p className="py-4 text-sm text-slate-500">{tr("暂无已生成贡献度快照的项目")}</p>
        ) : (
          <div className="space-y-3">
            {contributionQ.data?.projects.map((proj) => (
              <div key={proj.project_id} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-900">
                    {proj.group_name} · {proj.project_name}
                  </span>
                  <span className="text-slate-500">
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
                        className="rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-slate-900">{m.name}</span>
                        <span className="ml-2 font-mono text-blue-700">{m.share}%</span>
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
