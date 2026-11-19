"use client";

import { type DragEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight, FolderKanban, Lock, ShieldCheck } from "lucide-react";
import { GroupProgressBar } from "@/features/teacher/GroupProgressBar";
import {
  type AssignOption,
  type DragStudentPayload,
  StudentEntity,
} from "@/features/teacher/StudentEntity";
import type { PlazaGroup } from "@/lib/api/teacher-client";
import { tr } from "@/lib/i18n/tr";

export function TeamCard({
  courseId,
  group,
  allGroups,
  canManage,
  busyStudentId,
  busyGroupId,
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
          { groupId: null, label: "移回未组队池", toGroupVersion: null },
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
      className={`flex flex-col justify-between gap-4 rounded-xl border bg-white p-4 transition ${
        dragOver
          ? cannotAcceptDrop
            ? "border-red-400 bg-red-50/30 ring-2 ring-red-200"
            : "border-blue-500 bg-blue-50/30 ring-2 ring-blue-200"
          : "border-slate-200"
      }`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/teacher/courses/${courseId}/groups/${group.id}`}
                className="text-base font-semibold text-slate-900 hover:text-blue-600"
              >
                {group.name}
              </Link>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                {tr("{0}/{1} 人", { 0: group.member_count, 1: group.max_group_size })}
              </span>
            </div>
            {group.direction && (
              <p className="mt-1 text-xs text-slate-500">{group.direction}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {group.has_project && (
              <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                <ShieldCheck size={12} />
                已立项
              </span>
            )}
            {group.roster_frozen && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                <Lock size={12} />
                名单已冻结
              </span>
            )}
            {isFull && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                已满员
              </span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {group.members.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 py-6 text-center text-xs text-slate-500">
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
                assignOptions={memberAssignOptions}
                onAssignSelect={(option) =>
                  onDropStudent(
                    {
                      studentId: member.id,
                      studentName: member.name || "未命名学生",
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

      <div className="space-y-3 border-t border-slate-100 pt-3">
        <GroupProgressBar progress={group.progress} />

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <Link
            href={`/teacher/courses/${courseId}/groups/${group.id}`}
            className="gp-link inline-flex items-center gap-1 font-medium"
          >
            查看队伍详情
            <ArrowRight size={13} />
          </Link>
          {group.project && (
            <Link
              href={group.project.href}
              className="inline-flex items-center gap-1 text-slate-600 hover:text-blue-600"
            >
              <FolderKanban size={13} />
              {group.project.name || "进入项目工作台"}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
