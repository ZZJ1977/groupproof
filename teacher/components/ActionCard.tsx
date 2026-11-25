"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import { dateTime } from "@/shared/lib/b-ui";
import { cn } from "@/shared/lib/utils";
import type { BMembershipChange } from "@/student/api/b-membership";
import type { ActionDef, TeacherActionItem } from "@/teacher/api/teacher-actions-client";
import { tr } from "@/shared/i18n/tr";

export function ActionCard({
  item,
  membershipChange,
  selected,
  busy,
  onToggleSelect,
  onTriggerAction,
}: {
  item: TeacherActionItem;
  membershipChange?: BMembershipChange;
  selected: boolean;
  busy: boolean;
  onToggleSelect: (id: string) => void;
  onTriggerAction: (item: TeacherActionItem, action: ActionDef) => void;
}) {
  const showHandover =
    (item.type === "member_leave" || item.type === "member_remove") &&
    Boolean(membershipChange);

  return (
    <div className="min-w-0 space-y-2.5 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] transition-colors hover:border-[#cfd3d9]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {item.status === "pending" && (
            <input
              type="checkbox"
              aria-label={tr("选择 {0}", { 0: item.title })}
              className="mt-1 shrink-0 accent-[#3370ff]"
              checked={selected}
              onChange={() => onToggleSelect(item.id)}
            />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-block h-2 w-2 shrink-0 rounded-full",
                  item.status !== "pending"
                    ? "bg-[var(--gp-subtle,#8f959e)]"
                    : item.priority === "urgent"
                      ? "bg-[var(--gp-danger,#d93025)]"
                      : "bg-[var(--gp-warning,#d97706)]",
                )}
              />
              <span className="break-words text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                {item.title}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  item.status === "pending"
                    ? "bg-amber-50 text-amber-800"
                    : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
                )}
              >
                {item.status === "pending" ? tr("待处理") : tr("已处理")}
              </span>
            </div>
            <p className="break-words text-xs text-[var(--gp-ink-soft,#4e5969)]">
              {item.description}
            </p>
            <p className="gp-tabular text-[11px] text-[var(--gp-muted,#646a73)]">
              {dateTime(item.created_at)}
              {item.handled_by ? tr(" · 处理人：{0}", { 0: item.handled_by }) : ""}
              {item.decision_reason ? tr(" · 说明：{0}", { 0: item.decision_reason }) : ""}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link
            href={item.href}
            data-variant="outline"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            查看详情
          </Link>
          {item.available_actions.map((act) => {
            if (act.style === "primary") {
              return (
                <Button
                  key={act.key}
                  type="button"
                  variant="default"
                  size="sm"
                  pill
                  disabled={busy}
                  onClick={() => onTriggerAction(item, act)}
                >
                  {tr(act.label)}
                </Button>
              );
            }
            if (act.style === "danger") {
              return (
                <Button
                  key={act.key}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="border-[#fecaca] bg-[#fef2f2] text-[#d93025] hover:bg-[#fee2e2] hover:text-[#b91c1c]"
                  onClick={() => onTriggerAction(item, act)}
                >
                  {tr(act.label)}
                </Button>
              );
            }
            return (
              <Button
                key={act.key}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onTriggerAction(item, act)}
              >
                {tr(act.label)}
              </Button>
            );
          })}
        </div>
      </div>

      {showHandover && membershipChange && (
        <div className="rounded-[8px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3 py-2 text-xs">
          <div className="font-semibold text-[var(--gp-ink-soft,#4e5969)]">
            {tr("未完成任务交接")}
          </div>
          {membershipChange.handovers.length === 0 ? (
            <p className="mt-1 text-[var(--gp-muted,#646a73)]">{tr("没有需要交接的任务。")}</p>
          ) : (
            <ul className="mt-1 space-y-1 text-[var(--gp-ink,#1f2329)]">
              {membershipChange.handovers.map((h) => (
                <li key={h.task_id} className="gp-tabular flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium">
                    {h.code ? `${h.code} ` : ""}
                    {h.title}
                  </span>
                  <span className="text-[var(--gp-muted,#646a73)]">
                    → {h.to_user?.name ?? tr("队员")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
