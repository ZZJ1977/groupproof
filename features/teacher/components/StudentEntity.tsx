"use client";

import type { DragEvent } from "react";
import { Crown, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n/tr";

export type DragStudentPayload = {
  studentId: string;
  studentName: string;
  fromGroupId: string | null;
  fromGroupVersion: number | null;
  inProjectGroup: boolean;
};

export type AssignOption = {
  groupId: string | null;
  label: string;
  toGroupVersion: number | null;
};

export function StudentEntity({
  studentId,
  name,
  studentNumber,
  initial,
  grouped,
  groupName,
  isLeader = false,
  inProjectGroup = false,
  fromGroupId = null,
  fromGroupVersion = null,
  canManage = false,
  busy = false,
  settingLeader = false,
  assignOptions,
  onAssignSelect,
  onSetLeader,
  onClick,
  onDragStartStudent,
  onDragEndStudent,
}: {
  studentId: string;
  name: string | null;
  studentNumber: string | null;
  initial: string;
  grouped: boolean;
  groupName?: string | null;
  isLeader?: boolean;
  inProjectGroup?: boolean;
  fromGroupId?: string | null;
  fromGroupVersion?: number | null;
  canManage?: boolean;
  busy?: boolean;
  settingLeader?: boolean;
  assignOptions?: AssignOption[];
  onAssignSelect?: (option: AssignOption) => void;
  onSetLeader?: () => void;
  onClick?: () => void;
  onDragStartStudent?: (payload: DragStudentPayload) => void;
  onDragEndStudent?: () => void;
}) {
  const displayName = name || tr("未命名学生");
  const canDrag = canManage && !inProjectGroup && !busy;
  const badgeLabel = grouped
    ? groupName
      ? tr("已组队 · {0}", { 0: groupName })
      : tr("已组队")
    : tr("未组队");

  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    if (!canDrag) {
      event.preventDefault();
      return;
    }
    const payload: DragStudentPayload = {
      studentId,
      studentName: displayName,
      fromGroupId,
      fromGroupVersion,
      inProjectGroup,
    };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-gp-student", JSON.stringify(payload));
    onDragStartStudent?.(payload);
  };

  return (
    <div
      data-testid={`student-entity-${studentId}`}
      draggable={canDrag}
      onDragStart={handleDragStart}
      onDragEnd={() => onDragEndStudent?.()}
      title={inProjectGroup ? tr("该队伍已立项，请通过成员变动调整") : undefined}
      className={cn(
        "group relative flex min-w-0 flex-col gap-2 rounded-[10px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-2.5 transition-[border-color,box-shadow] duration-150",
        canDrag && "cursor-grab hover:border-[var(--gp-action,#3370ff)]/50 hover:shadow-xs active:cursor-grabbing",
        busy && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <div className="flex min-w-[min(140px,100%)] flex-1 items-center gap-2">
          {canDrag && (
            <GripVertical
              size={14}
              className="shrink-0 text-[var(--gp-subtle,#8f959e)] group-hover:text-[var(--gp-ink-soft,#4e5969)]"
              aria-hidden="true"
            />
          )}
          <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus:outline-none focus:ring-2 focus:ring-[var(--gp-action,#3370ff)]/30"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--gp-action-soft,#e8f0fe)] text-xs font-bold text-[var(--gp-action-on-soft,#1d4ed8)]">
              {initial}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  title={displayName}
                  className="truncate text-[13px] font-medium text-[var(--gp-ink,#1f2329)]"
                >
                  {displayName}
                </span>
                {isLeader && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-800">
                    <Crown size={10} />
                    队长
                  </span>
                )}
              </span>
              <span className="gp-tabular block truncate text-xs text-[var(--gp-muted,#646a73)]">
                {studentNumber || tr("无学号")}
              </span>
            </span>
          </button>
        </div>
        <span
          title={badgeLabel}
          className={cn(
            "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium",
            grouped
              ? "bg-[#ecfdf5] text-[#008a5c]"
              : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
          )}
        >
          {badgeLabel}
        </span>
      </div>

      {busy && (
        <div role="status" className="text-xs font-medium text-[var(--gp-action,#3370ff)]">
          保存中…
        </div>
      )}

      {canManage && !busy && (assignOptions?.length || onSetLeader) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-2">
          {assignOptions && assignOptions.length > 0 && onAssignSelect && (
            <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-[var(--gp-ink-soft,#4e5969)]">
              <span className="sr-only">分配到</span>
              <select
                aria-label={tr("将 {0} 分配到", { 0: displayName })}
                className="w-full min-w-0 rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2 py-1 text-xs text-[var(--gp-ink,#1f2329)] outline-none focus:border-[var(--gp-action,#3370ff)]"
                value=""
                onChange={(event) => {
                  const idx = Number(event.target.value);
                  if (!Number.isNaN(idx) && assignOptions[idx]) {
                    onAssignSelect(assignOptions[idx]);
                  }
                }}
              >
                <option value="">分配到…</option>
                {assignOptions.map((opt, index) => (
                  <option key={opt.groupId ?? "ungrouped"} value={String(index)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onSetLeader && !isLeader && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              pill
              loading={settingLeader}
              preserveWidth
              onClick={onSetLeader}
              className="h-7 px-2.5 text-xs"
            >
              设为队长
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
