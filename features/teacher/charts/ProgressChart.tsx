"use client";

import type { GroupProgressItem, ProgressTone } from "@/lib/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

const barFill: Record<ProgressTone, string> = {
  green: "#10b981",
  yellow: "#f59e0b",
  red: "#ef4444",
  gray: "#94a3b8",
};

const toneLabel: Record<ProgressTone, string> = {
  green: "正常推进",
  yellow: "轻度滞后",
  red: "重点关注",
  gray: "未立项",
};

export function ProgressChart({ items }: { items: GroupProgressItem[] }) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">{tr("暂无队伍进度数据")}</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const pct = item.progress_percent ?? 0;
        return (
          <div key={item.group_id} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-900">{item.group_name}</span>
                <span className="text-slate-500">
                  {item.has_project ? item.project_name : tr("未立项")}
                </span>
              </div>
              <div className="flex items-center gap-2 font-mono text-slate-600">
                <span>
                  {tr("任务 {0}/{1}", { 0: item.completed_tasks, 1: item.total_tasks })}
                </span>
                <span className="font-semibold text-slate-900">
                  {item.progress_percent !== null ? `${pct}%` : "—"}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px]">
                  {tr(toneLabel[item.tone])}
                </span>
              </div>
            </div>
            <svg
              role="img"
              aria-label={tr("{0} 进度 {1}%", { 0: item.group_name, 1: pct })}
              viewBox="0 0 400 12"
              className="h-3 w-full overflow-hidden rounded-full bg-slate-100"
              preserveAspectRatio="none"
            >
              <rect x="0" y="0" width="400" height="12" rx="6" fill="#f1f5f9" />
              <rect
                x="0"
                y="0"
                width={Math.max(item.progress_percent === null ? 0 : 8, (400 * pct) / 100)}
                height="12"
                rx="6"
                fill={barFill[item.tone]}
              />
            </svg>
          </div>
        );
      })}
    </div>
  );
}
