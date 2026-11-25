"use client";

import type { GroupMilestoneRow } from "@/features/teacher/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

export function MilestoneTimeline({ rows }: { rows: GroupMilestoneRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
        {tr("暂无队伍里程碑矩阵")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div
          key={row.group_id}
          className="min-w-0 rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3.5"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span
              title={row.group_name}
              className="min-w-0 truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]"
            >
              {row.group_name}
            </span>
            <span
              title={row.project_name ?? tr("未初始化项目")}
              className="min-w-0 truncate text-xs text-[var(--gp-muted,#646a73)]"
            >
              {row.project_name ?? tr("未初始化项目")}
            </span>
          </div>
          {row.milestones.length === 0 ? (
            <div className="text-xs text-[var(--gp-subtle,#8f959e)]">
              {tr("暂未设置里程碑节点")}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {row.milestones.map((m) => (
                <div
                  key={m.milestone_id}
                  className={`min-w-0 rounded-[8px] border px-2.5 py-2 text-xs ${
                    m.status === "completed"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : m.overdue
                        ? "border-red-200 bg-red-50 text-red-900"
                        : "border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] text-[var(--gp-ink-soft,#4e5969)]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5 font-semibold">
                    <span title={m.title} className="min-w-0 truncate">
                      {m.title}
                    </span>
                    <span className="gp-tabular shrink-0">
                      {m.progress_percent !== null ? `${m.progress_percent}%` : "—"}
                    </span>
                  </div>
                  <div className="gp-tabular mt-1 flex items-center justify-between gap-1 text-[11px] opacity-80">
                    <span>
                      {tr("任务 {0}/{1}", { 0: m.completed_task_count, 1: m.task_count })}
                    </span>
                    <span className="shrink-0">
                      {m.status === "completed"
                        ? tr("已完成")
                        : m.overdue
                          ? tr("已逾期")
                          : tr("进行中")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
