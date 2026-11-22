"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { dateOnly } from "@/features/b/ui";
import type { GroupProgress } from "@/lib/api/teacher-client";
import { tr } from "@/lib/i18n/tr";

const riskLabels: Record<string, string> = {
  high: "高风险",
  medium: "中风险",
  low: "低风险",
};

export function GroupProgressBar({
  progress,
  large = false,
}: {
  progress: GroupProgress;
  large?: boolean;
}) {
  if (progress.state === "no_project") {
    return (
      <div className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        尚未立项
      </div>
    );
  }
  if (progress.state === "no_milestones") {
    return (
      <div className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        暂无里程碑
      </div>
    );
  }
  const pct = progress.overall_percent ?? 0;
  return (
    <div className="rounded border border-slate-200 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
          <CheckCircle2 size={14} className="text-blue-600" />
          {tr("已完成 {0}/{1} 个里程碑", {
            0: progress.milestones_completed,
            1: progress.milestones_total,
          })}
        </span>
        <span className={`font-semibold text-slate-900 ${large ? "text-base" : "text-xs"}`}>
          {progress.overall_percent !== null
            ? tr("整体进度 {0}%", { 0: progress.overall_percent })
            : "暂无关联任务"}
        </span>
      </div>
      <div
        className={`mt-2 w-full overflow-hidden rounded-full bg-slate-200 ${large ? "h-3" : "h-2"}`}
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
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        {progress.next_milestone ? (
          <Link href={progress.next_milestone.href} className="gp-link inline-flex items-center gap-1">
            <Clock size={12} />
            {tr("下一个：{0} · {1}", {
              0: progress.next_milestone.title,
              1: dateOnly(progress.next_milestone.deadline),
            })}
          </Link>
        ) : (
          <span>全部里程碑已完成</span>
        )}
        <div className="flex items-center gap-1.5">
          {progress.overdue_count > 0 && (
            <span className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
              <AlertTriangle size={11} />
              {tr("逾期 {0}", { 0: progress.overdue_count })}
            </span>
          )}
          {progress.risk_level && (
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                progress.risk_level === "high"
                  ? "bg-red-100 text-red-800"
                  : progress.risk_level === "medium"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-slate-200 text-slate-700"
              }`}
            >
              {riskLabels[progress.risk_level] ?? progress.risk_level}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
