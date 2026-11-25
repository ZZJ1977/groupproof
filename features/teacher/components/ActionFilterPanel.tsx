"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TeacherActionType } from "@/features/teacher/api/teacher-actions-client";
import { tr } from "@/lib/i18n/tr";

const TYPE_OPTIONS: { value: TeacherActionType; label: string }[] = [
  { value: "join_request", label: "加入审批" },
  { value: "post_deadline_invite", label: "逾期组队邀请" },
  { value: "member_leave", label: "成员退出" },
  { value: "member_remove", label: "成员移出" },
  { value: "milestone_overdue", label: "里程碑逾期" },
  { value: "rule_change_review", label: "规则复核" },
  { value: "risk_alert", label: "风险与问题" },
  { value: "appeal", label: "贡献申诉" },
  { value: "notification", label: "待办通知" },
];

export function ActionFilterPanel({
  selectedTypes,
  onToggleType,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  days,
  onDaysChange,
  countsByType,
  onReset,
  className,
}: {
  selectedTypes: TeacherActionType[];
  onToggleType: (t: TeacherActionType) => void;
  status: string;
  onStatusChange: (s: string) => void;
  priority: string;
  onPriorityChange: (p: string) => void;
  days: string;
  onDaysChange: (d: string) => void;
  countsByType: Record<string, number>;
  onReset?: () => void;
  className?: string;
}) {
  const hasActiveFilters =
    selectedTypes.length > 0 || status !== "pending" || priority !== "all" || Boolean(days);

  return (
    <div
      className={cn(
        "space-y-4 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 text-xs shadow-[var(--gp-shadow-card)]",
        className,
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-[var(--gp-ink,#1f2329)]">操作类型</div>
          {onReset && hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="h-6 px-2 text-[11px] text-[var(--gp-action,#3370ff)]"
            >
              {tr("清除筛选")}
            </Button>
          )}
        </div>
        <div className="space-y-1.5">
          {TYPE_OPTIONS.map((opt) => {
            const count = countsByType[opt.value] ?? 0;
            return (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-1 py-0.5 text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)]"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-[#3370ff]"
                    checked={selectedTypes.includes(opt.value)}
                    onChange={() => onToggleType(opt.value)}
                  />
                  {tr(opt.label)}
                </span>
                {count > 0 && (
                  <span className="gp-tabular rounded-full bg-[var(--gp-surface-subtle,#f8f9fa)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--gp-muted,#646a73)]">
                    {count}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
        <div className="font-semibold text-[var(--gp-ink,#1f2329)]">处理状态</div>
        {[
          { value: "pending", label: "待处理" },
          { value: "handled", label: "已处理" },
          { value: "all", label: "全部" },
        ].map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1 py-0.5 text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)]"
          >
            <input
              type="radio"
              name="action-status"
              className="accent-[#3370ff]"
              checked={status === opt.value}
              onChange={() => onStatusChange(opt.value)}
            />
            {tr(opt.label)}
          </label>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
        <div className="font-semibold text-[var(--gp-ink,#1f2329)]">优先级</div>
        {[
          { value: "all", label: "全部" },
          { value: "urgent", label: "紧急" },
          { value: "normal", label: "普通" },
        ].map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1 py-0.5 text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)]"
          >
            <input
              type="radio"
              name="action-priority"
              className="accent-[#3370ff]"
              checked={priority === opt.value}
              onChange={() => onPriorityChange(opt.value)}
            />
            {tr(opt.label)}
          </label>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
        <label
          htmlFor="action-days-select"
          className="block font-semibold text-[var(--gp-ink,#1f2329)]"
        >
          时间范围
        </label>
        <select
          id="action-days-select"
          className="w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-2.5 py-1.5 text-xs text-[var(--gp-ink,#1f2329)] outline-none focus:border-[var(--gp-action,#3370ff)]"
          value={days}
          onChange={(e) => onDaysChange(e.target.value)}
        >
          <option value="">全部时间</option>
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
        </select>
      </div>
    </div>
  );
}
