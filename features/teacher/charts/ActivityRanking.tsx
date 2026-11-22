"use client";

import { AlertCircle } from "lucide-react";
import type { StudentActivityRank } from "@/lib/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

export function ActivityRanking({ items }: { items: StudentActivityRank[] }) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-slate-500">{tr("暂无学生活跃度记录")}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-2 pr-3 font-medium">{tr("排名")}</th>
            <th className="py-2 pr-3 font-medium">{tr("学生姓名")}</th>
            <th className="py-2 pr-3 font-medium">{tr("所在小组")}</th>
            <th className="py-2 pr-3 font-medium">{tr("GitHub 动态")}</th>
            <th className="py-2 pr-3 font-medium">{tr("进度记录")}</th>
            <th className="py-2 pr-3 font-medium">{tr("完成任务")}</th>
            <th className="py-2 font-medium">{tr("综合活跃分")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((row, idx) => (
            <tr key={row.user_id} className={row.low_activity ? "bg-amber-50/40" : ""}>
              <td className="py-2.5 pr-3 font-mono text-slate-500">#{idx + 1}</td>
              <td className="py-2.5 pr-3 font-semibold text-slate-900">
                <span className="inline-flex items-center gap-1.5">
                  {row.name}
                  {row.low_activity && (
                    <span
                      title={tr("低活跃预警")}
                      className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                    >
                      <AlertCircle size={11} />
                      {tr("偏低")}
                    </span>
                  )}
                </span>
              </td>
              <td className="py-2.5 pr-3 text-slate-600">{row.group_name ?? tr("未分组")}</td>
              <td className="py-2.5 pr-3 font-mono text-slate-700">{row.github_events}</td>
              <td className="py-2.5 pr-3 font-mono text-slate-700">{row.progress_events}</td>
              <td className="py-2.5 pr-3 font-mono text-slate-700">{row.completed_tasks}</td>
              <td className="py-2.5 font-mono font-semibold text-slate-900">{row.total_score}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
