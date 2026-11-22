"use client";

import type { TeacherActionType } from "@/lib/api/teacher-actions-client";
import { tr } from "@/lib/i18n/tr";

const TYPE_OPTIONS: { value: TeacherActionType; label: string }[] = [
  { value: "join_request", label: "加入审批" },
  { value: "post_deadline_invite", label: "逾期组队邀请" },
  { value: "member_leave", label: "成员退出" },
  { value: "member_remove", label: "成员移出" },
  { value: "milestone_overdue", label: "里程碑逾期" },
  { value: "rule_change_review", label: "规则复核" },
  { value: "appeal", label: "贡献申诉" },
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
}) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 text-xs">
      <div className="space-y-2">
        <div className="font-semibold text-slate-900">操作类型</div>
        <div className="space-y-1.5">
          {TYPE_OPTIONS.map((opt) => {
            const count = countsByType[opt.value] ?? 0;
            return (
              <label key={opt.value} className="flex cursor-pointer items-center justify-between gap-2 text-slate-700">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedTypes.includes(opt.value)}
                    onChange={() => onToggleType(opt.value)}
                  />
                  {tr(opt.label)}
                </span>
                {count > 0 && (
                  <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                    {count}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-slate-100 pt-3">
        <div className="font-semibold text-slate-900">处理状态</div>
        {[
          { value: "pending", label: "待处理" },
          { value: "handled", label: "已处理" },
          { value: "all", label: "全部" },
        ].map((opt) => (
          <label key={opt.value} className="flex cursor-pointer items-center gap-2 text-slate-700">
            <input
              type="radio"
              name="action-status"
              checked={status === opt.value}
              onChange={() => onStatusChange(opt.value)}
            />
            {tr(opt.label)}
          </label>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-slate-100 pt-3">
        <div className="font-semibold text-slate-900">优先级</div>
        {[
          { value: "all", label: "全部" },
          { value: "urgent", label: "紧急" },
          { value: "normal", label: "普通" },
        ].map((opt) => (
          <label key={opt.value} className="flex cursor-pointer items-center gap-2 text-slate-700">
            <input
              type="radio"
              name="action-priority"
              checked={priority === opt.value}
              onChange={() => onPriorityChange(opt.value)}
            />
            {tr(opt.label)}
          </label>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-slate-100 pt-3">
        <label htmlFor="action-days-select" className="block font-semibold text-slate-900">
          时间范围
        </label>
        <select
          id="action-days-select"
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
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
