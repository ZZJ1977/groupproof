"use client";

import { AlertTriangle } from "lucide-react";
import type { GroupRiskAlert } from "@/lib/api/teacher-reports-client";
import { tr } from "@/lib/i18n/tr";

export function RiskMatrix({ items }: { items: GroupRiskAlert[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        {tr("当前班级暂无高/中风险预警队伍。")}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {items.map((alert) => (
        <div
          key={alert.group_id}
          className={`rounded-lg border px-4 py-3 ${
            alert.risk_level === "high"
              ? "border-red-200 bg-red-50/70"
              : "border-amber-200 bg-amber-50/70"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle
                size={15}
                className={alert.risk_level === "high" ? "text-red-600" : "text-amber-600"}
              />
              <span className="text-sm font-semibold text-slate-900">{alert.group_name}</span>
              {alert.project_name && (
                <span className="text-xs text-slate-600">· {alert.project_name}</span>
              )}
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                alert.risk_level === "high"
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {alert.risk_level === "high" ? tr("高风险") : tr("中风险")}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-slate-700">
            {alert.reasons.map((reason, idx) => (
              <span key={idx} className="rounded bg-white/80 px-2 py-0.5">
                {reason}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
