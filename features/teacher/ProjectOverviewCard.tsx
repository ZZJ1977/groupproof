"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Bell, FolderKanban } from "lucide-react";
import { card, secondary } from "@/features/b/ui";
import type { ProjectOverviewCard as CardModel } from "@/lib/api/teacher-projects-client";
import { tr } from "@/lib/i18n/tr";

export function ProjectOverviewCard({
  item,
  canRemind,
  reminding,
  onRemind,
}: {
  item: CardModel;
  canRemind: boolean;
  reminding: boolean;
  onRemind: (groupId: string) => void;
}) {
  if (!item.has_project) {
    return (
      <div className={`${card} flex flex-col justify-between gap-4 border-dashed bg-slate-50/80`}>
        <div>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-700">{item.group_name}</h2>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">
              {tr("未立项")}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {tr("成员 {0} 人 · 队长：{1}", {
              0: item.member_count,
              1: item.leader_name ?? tr("暂未指定"),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <Link
            href={item.plaza_href}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
          >
            {tr("进入组队广场")}
            <ArrowRight size={13} />
          </Link>
          {canRemind && item.member_count > 0 && (
            <button
              type="button"
              disabled={reminding}
              onClick={() => onRemind(item.group_id)}
              className={`${secondary} inline-flex items-center gap-1 text-xs`}
            >
              <Bell size={12} />
              {tr("催促立项")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const pct = item.progress_percent ?? 0;

  return (
    <div className={`${card} flex flex-col justify-between gap-4`}>
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700">
              <FolderKanban size={13} />
              <span>{item.group_name}</span>
            </div>
            <h2 className="mt-0.5 truncate text-base font-semibold text-slate-900">
              {item.project_name}
            </h2>
          </div>
          {(item.risk_level === "high" || item.risk_level === "medium") && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                item.risk_level === "high"
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-800"
              }`}
            >
              <AlertTriangle size={11} />
              {item.risk_level === "high" ? tr("高风险") : tr("中风险")}
            </span>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>{tr("综合进度")}</span>
            <span className="font-mono font-semibold text-slate-900">
              {item.progress_percent !== null ? `${pct}%` : "—"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${
                item.risk_level === "high"
                  ? "bg-red-500"
                  : item.risk_level === "medium"
                    ? "bg-amber-500"
                    : "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>
            {tr("完成任务 {0}/{1}", { 0: item.completed_tasks, 1: item.total_tasks })}
          </span>
          <span>
            {tr("里程碑 {0}/{1}", { 0: item.milestones_completed, 1: item.milestones_total })}
          </span>
          {item.overdue_milestones > 0 && (
            <span className="font-medium text-red-600">
              {tr("逾期 {0} 个", { 0: item.overdue_milestones })}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
        {item.project_href ? (
          <Link
            href={item.project_href}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
          >
            {tr("进入项目详情")}
            <ArrowRight size={13} />
          </Link>
        ) : (
          <span />
        )}
        {canRemind && (
          <button
            type="button"
            disabled={reminding}
            onClick={() => onRemind(item.group_id)}
            className={`${secondary} inline-flex items-center gap-1 text-xs`}
          >
            <Bell size={12} />
            {tr("发送催办")}
          </button>
        )}
      </div>
    </div>
  );
}
