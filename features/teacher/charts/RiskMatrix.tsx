"use client";

import { AlertTriangle } from "lucide-react";
import type { GroupRiskAlert } from "@/features/teacher/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

export function RiskMatrix({ items }: { items: GroupRiskAlert[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-[var(--gp-success,#008a5c)]">
        {tr("当前班级暂无高/中风险预警队伍。")}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {items.map((alert) => (
        <div
          key={alert.group_id}
          className={`min-w-0 rounded-[10px] border px-4 py-3 ${
            alert.risk_level === "high"
              ? "border-red-200 bg-red-50/70"
              : "border-amber-200 bg-amber-50/70"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <AlertTriangle
                size={15}
                className={
                  alert.risk_level === "high"
                    ? "shrink-0 text-[var(--gp-danger,#d93025)]"
                    : "shrink-0 text-[var(--gp-warning,#d97706)]"
                }
                aria-hidden="true"
              />
              <span
                title={alert.group_name}
                className="min-w-0 truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]"
              >
                {alert.group_name}
              </span>
              {alert.project_name && (
                <span
                  title={alert.project_name}
                  className="min-w-0 truncate text-xs text-[var(--gp-ink-soft,#4e5969)]"
                >
                  · {alert.project_name}
                </span>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                alert.risk_level === "high"
                  ? "bg-red-100 text-[var(--gp-danger,#d93025)]"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {alert.risk_level === "high" ? tr("高风险") : tr("中风险")}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            {alert.reasons.map((reason, idx) => (
              <span
                key={idx}
                className="min-w-0 break-words rounded-[6px] bg-white/85 px-2 py-0.5"
              >
                {reason}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
