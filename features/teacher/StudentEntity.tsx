"use client";

import type { DragEvent } from "react";
import { Crown, GripVertical } from "lucide-react";
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
  assignOptions?: AssignOption[];
  onAssignSelect?: (option: AssignOption) => void;
  onSetLeader?: () => void;
  onClick?: () => void;
  onDragStartStudent?: (payload: DragStudentPayload) => void;
  onDragEndStudent?: () => void;
}) {
  const displayName = name || "未命名学生";
  const canDrag = canManage && !inProjectGroup && !busy;

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
      title={inProjectGroup ? "该队伍已立项，请通过成员变动调整" : undefined}
      className={`group relative flex flex-col gap-2 rounded-lg border bg-white p-2.5 transition-shadow ${
        canDrag ? "cursor-grab hover:border-blue-300 hover:shadow-sm active:cursor-grabbing" : "border-slate-200"
      } ${busy ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        {canDrag && (
          <GripVertical
            size={14}
            className="shrink-0 text-slate-400 group-hover:text-slate-600"
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          onClick={onClick}
          disabled={!onClick}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">
            {initial}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-slate-900">{displayName}</span>
              {isLeader && (
                <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
                  <Crown size={11} />
                  队长
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {studentNumber || "无学号"}
            </span>
          </span>
        </button>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            grouped ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          {grouped
            ? groupName
              ? tr("已组队 · {0}", { 0: groupName })
              : "已组队"
            : "未组队"}
        </span>
      </div>

      {busy && (
        <div role="status" className="text-xs font-medium text-blue-600">
          保存中…
        </div>
      )}

      {canManage && !busy && (assignOptions?.length || onSetLeader) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
          {assignOptions && assignOptions.length > 0 && onAssignSelect && (
            <label className="flex flex-1 items-center gap-1 text-xs text-slate-600">
              <span className="sr-only">分配到</span>
              <select
                aria-label={tr("将 {0} 分配到", { 0: displayName })}
                className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
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
            <button
              type="button"
              onClick={onSetLeader}
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              设为队长
            </button>
          )}
        </div>
      )}
    </div>
  );
}
