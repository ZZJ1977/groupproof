"use client";

import { type DragEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight, FolderKanban, Lock, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GroupProgressBar } from "@/features/teacher/components/GroupProgressBar";
import {
  type AssignOption,
  type DragStudentPayload,
  StudentEntity,
} from "@/features/teacher/components/StudentEntity";
import type { PlazaGroup } from "@/features/teacher/api/teacher-client";
import { tr } from "@/lib/i18n/tr";

export function TeamCard({
  courseId,
  group,
  allGroups,
  canManage,
  busyStudentId,
  busyGroupId,
  settingLeaderStudentId = null,
  draggingStudent,
  onDragStartStudent,
  onDragEndStudent,
  onDropStudent,
  onSetLeader,
}: {
  courseId: string;
  group: PlazaGroup;
  allGroups: PlazaGroup[];
  canManage: boolean;
  busyStudentId: string | null;
  busyGroupId: string | null;
  settingLeaderStudentId?: string | null;
  draggingStudent: DragStudentPayload | null;
  onDragStartStudent: (payload: DragStudentPayload) => void;
  onDragEndStudent: () => void;
  onDropStudent: (
    payload: DragStudentPayload,
    toGroupId: string | null,
    toGroupVersion: number | null,
  ) => void;
  onSetLeader: (groupId: string, leaderUserId: string, version: number) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const isFull = group.member_count >= group.max_group_size;

  const cannotAcceptDrop =
    !canManage ||
    !group.accepts_drop ||
    group.roster_frozen ||
    isFull ||
    (draggingStudent !== null &&
      (draggingStudent.fromGroupId === group.id || draggingStudent.inProjectGroup));

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canManage) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = cannotAcceptDrop ? "none" : "move";
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!canManage) return;
    let payload: DragStudentPayload | null = draggingStudent;
    const raw = event.dataTransfer.getData("application/x-gp-student");
    if (raw) {
      try {
        payload = JSON.parse(raw) as DragStudentPayload;
      } catch {
        payload = draggingStudent;
      }
    }
    if (!payload || payload.fromGroupId === group.id) return;
    onDropStudent(payload, group.id, group.lock_version);
  };

  const memberAssignOptions: AssignOption[] =
    canManage && !group.has_project && !group.roster_frozen && !group.members_locked
      ? [
          { groupId: null, label: tr("移回未组队池"), toGroupVersion: null },
          ...allGroups
            .filter(
              (g) =>
                g.id !== group.id &&
                g.accepts_drop &&
                !g.roster_frozen &&
                g.member_count < g.max_group_size,
            )
            .map((g) => ({
              groupId: g.id,
              label: g.name,
              toGroupVersion: g.lock_version,
            })),
        ]
      : [];

  return (
    <div
      data-testid={`team-card-${group.id}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "flex min-w-0 flex-col justify-between gap-4 rounded-[12px] border bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] transition-[border-color,background-color,box-shadow] duration-150",
        dragOver
          ? cannotAcceptDrop
            ? "border-[#d93025] bg-[#fef2f2]/40 ring-2 ring-[#fecaca]"
            : "border-[var(--gp-action,#3370ff)] bg-[#e8f0fe]/35 ring-2 ring-[#c7dafc]"
          : "border-[var(--gp-border,#dee0e3)]",
      )}
    >
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/teacher/courses/${courseId}/groups/${group.id}`}
                title={group.name}
                className="max-w-full truncate text-base font-semibold text-[var(--gp-ink,#1f2329)] hover:text-[var(--gp-action,#3370ff)]"
              >
                {group.name}
              </Link>
              <span className="gp-tabular shrink-0 rounded-full bg-[var(--gp-surface-subtle,#f8f9fa)] px-2 py-0.5 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
                {tr("{0}/{1} 人", { 0: group.member_count, 1: group.max_group_size })}
              </span>
            </div>
            {group.direction && (
              <p className="mt-1 truncate text-xs text-[var(--gp-muted,#646a73)]" title={group.direction}>
                {group.direction}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {group.has_project && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-xs font-medium text-[#1d4ed8]">
                <ShieldCheck size={12} />
                已立项
              </span>
            )}
            {group.roster_frozen && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                <Lock size={12} />
                名单已冻结
              </span>
            )}
            {isFull && (
              <span className="rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-2 py-0.5 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
                已满员
              </span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {group.members.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] py-6 text-center text-xs text-[var(--gp-muted,#646a73)]">
              暂无组员，可将未组队学生拖拽至此队伍
            </div>
          ) : (
            group.members.map((member) => (
              <StudentEntity
                key={member.id}
                studentId={member.id}
                name={member.name}
                studentNumber={member.student_number}
                initial={member.initial}
                grouped
                groupName={group.name}
                isLeader={member.is_leader}
                inProjectGroup={group.has_project}
                fromGroupId={group.id}
                fromGroupVersion={group.lock_version}
                canManage={canManage && !group.roster_frozen}
                busy={busyStudentId === member.id || busyGroupId === group.id}
                settingLeader={settingLeaderStudentId === member.id}
                assignOptions={memberAssignOptions}
                onAssignSelect={(option) =>
                  onDropStudent(
                    {
                      studentId: member.id,
                      studentName: member.name || tr("未命名学生"),
                      fromGroupId: group.id,
                      fromGroupVersion: group.lock_version,
                      inProjectGroup: group.has_project,
                    },
                    option.groupId,
                    option.toGroupVersion,
                  )
                }
                onSetLeader={
                  canManage && !group.roster_frozen && !member.is_leader
                    ? () => onSetLeader(group.id, member.id, group.lock_version)
                    : undefined
                }
                onDragStartStudent={onDragStartStudent}
                onDragEndStudent={onDragEndStudent}
              />
            ))
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
        <GroupProgressBar progress={group.progress} />

        <div data-card-footer className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <Link
            href={`/teacher/courses/${courseId}/groups/${group.id}`}
            data-variant="tonal"
            className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
          >
            查看队伍详情
            <ArrowRight size={13} />
          </Link>
          {group.project && (
            <Link
              href={group.project.href}
              data-variant="outline"
              title={group.project.name || tr("进入项目工作台")}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm", pill: true }),
                "max-w-[180px] truncate",
              )}
            >
              <FolderKanban size={13} className="shrink-0" />
              <span className="truncate">{group.project.name || tr("进入项目工作台")}</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
