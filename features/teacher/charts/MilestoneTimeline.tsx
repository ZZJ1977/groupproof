"use client";

import type { GroupMilestoneRow } from "@/lib/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

export function MilestoneTimeline({ rows }: { rows: GroupMilestoneRow[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">{tr("暂无队伍里程碑矩阵")}</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.group_id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-900">{row.group_name}</span>
            <span className="text-xs text-slate-500">
              {row.project_name ?? tr("未初始化项目")}
            </span>
          </div>
          {row.milestones.length === 0 ? (
            <div className="text-xs text-slate-400">{tr("暂未设置里程碑节点")}</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {row.milestones.map((m) => (
                <div
                  key={m.milestone_id}
                  className={`rounded-lg border px-2.5 py-2 text-xs ${
                    m.status === "completed"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : m.overdue
                        ? "border-red-200 bg-red-50 text-red-900"
                        : "border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 font-semibold">
                    <span className="truncate">{m.title}</span>
                    <span>
                      {m.progress_percent !== null ? `${m.progress_percent}%` : "—"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] opacity-80">
                    <span>
                      {tr("任务 {0}/{1}", { 0: m.completed_task_count, 1: m.task_count })}
                    </span>
                    <span>
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
