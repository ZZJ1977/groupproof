"use client";

import { AlertCircle } from "lucide-react";
import type { StudentActivityRank } from "@/features/teacher/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

export function ActivityRanking({ items }: { items: StudentActivityRank[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
        {tr("暂无学生活跃度记录")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead>
          <tr className="border-b border-[var(--gp-border,#dee0e3)] text-[var(--gp-muted,#646a73)]">
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{tr("排名")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{tr("学生姓名")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{tr("所在小组")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{tr("GitHub 动态")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{tr("进度记录")}</th>
            <th className="whitespace-nowrap py-2 pr-3 font-medium">{tr("完成任务")}</th>
            <th className="whitespace-nowrap py-2 font-medium">{tr("综合活跃分")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
          {items.map((row, idx) => (
            <tr key={row.user_id} className={row.low_activity ? "bg-amber-50/40" : ""}>
              <td className="gp-tabular whitespace-nowrap py-2.5 pr-3 text-[var(--gp-muted,#646a73)]">
                #{idx + 1}
              </td>
              <td className="py-2.5 pr-3 font-semibold text-[var(--gp-ink,#1f2329)]">
                <span className="inline-flex items-center gap-1.5">
                  <span title={row.name} className="max-w-[140px] truncate">
                    {row.name}
                  </span>
                  {row.low_activity && (
                    <span
                      title={tr("低活跃预警")}
                      className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                    >
                      <AlertCircle size={11} aria-hidden="true" />
                      {tr("偏低")}
                    </span>
                  )}
                </span>
              </td>
              <td className="py-2.5 pr-3 text-[var(--gp-ink-soft,#4e5969)]">
                <span
                  title={row.group_name ?? tr("未分组")}
                  className="block max-w-[140px] truncate"
                >
                  {row.group_name ?? tr("未分组")}
                </span>
              </td>
              <td className="gp-tabular whitespace-nowrap py-2.5 pr-3 text-[var(--gp-ink-soft,#4e5969)]">
                {row.github_events}
              </td>
              <td className="gp-tabular whitespace-nowrap py-2.5 pr-3 text-[var(--gp-ink-soft,#4e5969)]">
                {row.progress_events}
              </td>
              <td className="gp-tabular whitespace-nowrap py-2.5 pr-3 text-[var(--gp-ink-soft,#4e5969)]">
                {row.completed_tasks}
              </td>
              <td className="gp-tabular whitespace-nowrap py-2.5 font-semibold text-[var(--gp-ink,#1f2329)]">
                {row.total_score}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
