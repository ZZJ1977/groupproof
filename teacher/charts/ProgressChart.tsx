"use client";

import type { GroupProgressItem, ProgressTone } from "@/teacher/api/teacher-reports-client";
import { tr } from "@/shared/i18n/tr";

const barFill: Record<ProgressTone, string> = {
  green: "#008a5c",
  yellow: "#d97706",
  red: "#d93025",
  gray: "#8f959e",
};

const toneLabel: Record<ProgressTone, string> = {
  green: "正常推进",
  yellow: "轻度滞后",
  red: "重点关注",
  gray: "未立项",
};

export function ProgressChart({ items }: { items: GroupProgressItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
        {tr("暂无队伍进度数据")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const pct = item.progress_percent ?? 0;
        return (
          <div key={item.group_id} className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  title={item.group_name}
                  className="shrink-0 max-w-[140px] truncate font-semibold text-[var(--gp-ink,#1f2329)]"
                >
                  {item.group_name}
                </span>
                <span
                  title={item.has_project ? (item.project_name ?? undefined) : tr("未立项")}
                  className="min-w-0 truncate text-[var(--gp-muted,#646a73)]"
                >
                  {item.has_project ? item.project_name : tr("未立项")}
                </span>
              </div>
              <div className="gp-tabular flex shrink-0 items-center gap-2 text-[var(--gp-ink-soft,#4e5969)]">
                <span>
                  {tr("任务 {0}/{1}", { 0: item.completed_tasks, 1: item.total_tasks })}
                </span>
                <span className="font-semibold text-[var(--gp-ink,#1f2329)]">
                  {item.progress_percent !== null ? `${pct}%` : "—"}
                </span>
                <span className="rounded bg-[var(--gp-surface-hover,#eff0f1)] px-1.5 py-0.5 text-[11px]">
                  {tr(toneLabel[item.tone])}
                </span>
              </div>
            </div>
            <svg
              role="img"
              aria-label={tr("{0} 进度 {1}%", { 0: item.group_name, 1: pct })}
              viewBox="0 0 400 12"
              className="h-3 w-full overflow-hidden rounded-full bg-[var(--gp-surface-hover,#eff0f1)]"
              preserveAspectRatio="none"
            >
              <rect x="0" y="0" width="400" height="12" rx="6" fill="#eff0f1" />
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
