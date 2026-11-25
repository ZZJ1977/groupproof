"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { dateOnly } from "@/features/b/ui";
import { cn } from "@/lib/utils";
import type { GroupProgress } from "@/features/teacher/api/teacher-client";
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
      <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3 py-2 text-xs text-[var(--gp-muted,#646a73)]">
        尚未立项
      </div>
    );
  }
  if (progress.state === "no_milestones") {
    return (
      <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3 py-2 text-xs text-[var(--gp-muted,#646a73)]">
        暂无里程碑
      </div>
    );
  }
  const pct = progress.overall_percent ?? 0;
  return (
    <div className="min-w-0 rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3">
      <div className="gp-tabular flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--gp-ink-soft,#4e5969)]">
          <CheckCircle2 size={14} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
          {tr("已完成 {0}/{1} 个里程碑", {
            0: progress.milestones_completed,
            1: progress.milestones_total,
          })}
        </span>
        <span className={cn("font-semibold text-[var(--gp-ink,#1f2329)]", large ? "text-base" : "text-xs")}>
          {progress.overall_percent !== null
            ? tr("整体进度 {0}%", { 0: progress.overall_percent })
            : "暂无关联任务"}
        </span>
      </div>
      <div
        className={cn(
          "mt-2 w-full overflow-hidden rounded-full bg-[var(--gp-surface-hover,#eff0f1)]",
          large ? "h-3" : "h-2",
        )}
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
      <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
        {progress.next_milestone ? (
          <Link
            href={progress.next_milestone.href}
            title={tr("下一个：{0} · {1}", {
              0: progress.next_milestone.title,
              1: dateOnly(progress.next_milestone.deadline),
            })}
            className="gp-link gp-tabular inline-flex min-w-0 max-w-full items-center gap-1"
          >
            <Clock size={12} className="shrink-0" />
            <span className="truncate">
              {tr("下一个：{0} · {1}", {
                0: progress.next_milestone.title,
                1: dateOnly(progress.next_milestone.deadline),
              })}
            </span>
          </Link>
        ) : (
          <span>全部里程碑已完成</span>
        )}
        <div className="gp-tabular flex shrink-0 items-center gap-1.5">
          {progress.overdue_count > 0 && (
            <span className="inline-flex items-center gap-1 rounded bg-[#fef2f2] px-1.5 py-0.5 text-[11px] font-medium text-[#d93025]">
              <AlertTriangle size={11} />
              {tr("逾期 {0}", { 0: progress.overdue_count })}
            </span>
          )}
          {progress.risk_level && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] font-medium",
                progress.risk_level === "high"
                  ? "bg-[#fef2f2] text-[#d93025]"
                  : progress.risk_level === "medium"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
              )}
            >
              {riskLabels[progress.risk_level] ? tr(riskLabels[progress.risk_level]) : progress.risk_level}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
