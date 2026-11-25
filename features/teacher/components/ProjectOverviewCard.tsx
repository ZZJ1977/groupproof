"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Bell, FolderKanban } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProjectOverviewCard as CardModel } from "@/features/teacher/api/teacher-projects-client";
import { tr } from "@/lib/i18n/tr";

const cardSurface =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)] gp-card-interactive";

export function ProjectOverviewCard({
  item,
  canRemind,
  reminding,
  remindDisabled,
  onRemind,
}: {
  item: CardModel;
  canRemind: boolean;
  reminding: boolean;
  remindDisabled?: boolean;
  onRemind: (groupId: string) => void;
}) {
  if (!item.has_project) {
    return (
      <div
        className={cn(
          cardSurface,
          "flex flex-col justify-between gap-4 border-dashed bg-[var(--gp-surface-subtle,#f8f9fa)]",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h2
              title={item.group_name}
              className="min-w-0 truncate text-base font-semibold text-[var(--gp-ink,#1f2329)]"
            >
              {item.group_name}
            </h2>
            <span className="shrink-0 rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--gp-ink-soft,#4e5969)]">
              {tr("未立项")}
            </span>
          </div>
          <p className="gp-tabular mt-1.5 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("成员 {0} 人 · 队长：{1}", {
              0: item.member_count,
              1: item.leader_name ?? tr("暂未指定"),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
          <Link
            href={item.plaza_href}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {tr("进入组队广场")}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
          {canRemind && item.member_count > 0 && (
            <Button
              type="button"
              variant="tonal"
              size="sm"
              pill
              loading={reminding}
              disabled={remindDisabled ?? reminding}
              preserveWidth
              onClick={() => onRemind(item.group_id)}
            >
              <Bell size={13} aria-hidden="true" />
              {tr("催促立项")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const pct = item.progress_percent ?? 0;

  return (
    <div className={cn(cardSurface, "flex flex-col justify-between gap-4")}>
      <div className="min-w-0 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[var(--gp-action-on-soft,#1d4ed8)]">
              <FolderKanban size={13} className="shrink-0" aria-hidden="true" />
              <span title={item.group_name} className="truncate">
                {item.group_name}
              </span>
            </div>
            <h2
              title={item.project_name ?? undefined}
              className="mt-0.5 truncate text-base font-semibold text-[var(--gp-ink,#1f2329)]"
            >
              {item.project_name}
            </h2>
          </div>
          {(item.risk_level === "high" || item.risk_level === "medium") && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                item.risk_level === "high"
                  ? "bg-red-50 text-[var(--gp-danger,#d93025)]"
                  : "bg-amber-50 text-[var(--gp-warning,#d97706)]",
              )}
            >
              <AlertTriangle size={11} aria-hidden="true" />
              {item.risk_level === "high" ? tr("高风险") : tr("中风险")}
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <span>{tr("综合进度")}</span>
            <span className="gp-tabular font-semibold text-[var(--gp-ink,#1f2329)]">
              {item.progress_percent !== null ? `${pct}%` : "—"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--gp-surface-hover,#eff0f1)]">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-200",
                item.risk_level === "high"
                  ? "bg-[var(--gp-danger,#d93025)]"
                  : item.risk_level === "medium"
                    ? "bg-[var(--gp-warning,#d97706)]"
                    : "bg-[var(--gp-success,#008a5c)]",
              )}
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>
        </div>

        <div className="gp-tabular flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--gp-muted,#646a73)]">
          <span>
            {tr("完成任务 {0}/{1}", { 0: item.completed_tasks, 1: item.total_tasks })}
          </span>
          <span>
            {tr("里程碑 {0}/{1}", { 0: item.milestones_completed, 1: item.milestones_total })}
          </span>
          {item.overdue_milestones > 0 && (
            <span className="font-medium text-[var(--gp-danger,#d93025)]">
              {tr("逾期 {0} 个", { 0: item.overdue_milestones })}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
        {item.project_href ? (
          <Link
            href={item.project_href}
            className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
          >
            {tr("进入项目详情")}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        ) : (
          <span />
        )}
        {canRemind && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={reminding}
            disabled={remindDisabled ?? reminding}
            preserveWidth
            onClick={() => onRemind(item.group_id)}
          >
            <Bell size={13} aria-hidden="true" />
            {tr("发送催办")}
          </Button>
        )}
      </div>
    </div>
  );
}
