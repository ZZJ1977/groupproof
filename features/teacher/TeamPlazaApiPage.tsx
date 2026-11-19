"use client";

import { type DragEvent, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Clock, Plus, Users } from "lucide-react";
import {
  button,
  card,
  errorText,
  input,
  label,
  secondary,
} from "@/features/b/ui";
import {
  type AssignOption,
  type DragStudentPayload,
  StudentEntity,
} from "@/features/teacher/StudentEntity";
import { TeamCard } from "@/features/teacher/TeamCard";
import { BApiError } from "@/lib/api/b-client";
import { teacherClassesApi, teacherKeys } from "@/lib/api/teacher-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

export function TeamPlazaApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDirection, setGroupDirection] = useState("");
  const [draggingStudent, setDraggingStudent] = useState<DragStudentPayload | null>(null);
  const [poolDragOver, setPoolDragOver] = useState(false);
  const [busyStudentId, setBusyStudentId] = useState<string | null>(null);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [actionError, setActionError] = useState<{
    message: string;
    memberChangesHref?: string;
  } | null>(null);

  const plaza = useQuery({
    queryKey: teacherKeys.plaza(userId, courseId),
    queryFn: () => teacherClassesApi.plaza(courseId),
    enabled: Boolean(courseId),
  });

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: teacherKeys.plaza(userId, courseId) }),
      qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
      qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
      qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] }),
    ]);
  };

  const handleMutationError = async (err: unknown) => {
    if (err instanceof BApiError) {
      if (err.code === "VERSION_CONFLICT") {
        await refreshAll();
        setActionError({
          message: "队伍数据刚被更新，已为您自动刷新最新状态，请重试。",
        });
        return;
      }
      if (err.code === "GROUP_HAS_PROJECT") {
        const href =
          typeof err.details.member_changes_href === "string"
            ? err.details.member_changes_href
            : `/teacher/courses/${courseId}/member-changes`;
        setActionError({
          message: "该队伍已立项，不能直接拖出或换组，请通过成员变动流程处理。",
          memberChangesHref: href,
        });
        return;
      }
    }
    setActionError({ message: errorText(err) });
  };

  const createGroup = useMutation({
    mutationFn: () =>
      teacherClassesApi.createGroup(courseId, {
        name: groupName.trim(),
        direction: groupDirection.trim() || undefined,
      }),
    onSuccess: async (created) => {
      setGroupName("");
      setGroupDirection("");
      setCreatingGroup(false);
      setActionError(null);
      setLiveStatus(tr("已创建队伍 {0}", { 0: created.name }));
      await refreshAll();
    },
    onError: (err) => {
      void handleMutationError(err);
    },
  });

  const assignStudent = useMutation({
    mutationFn: (vars: {
      payload: DragStudentPayload;
      toGroupId: string | null;
      toGroupVersion: number | null;
    }) => {
      setBusyStudentId(vars.payload.studentId);
      setBusyGroupId(vars.toGroupId ?? vars.payload.fromGroupId);
      return teacherClassesApi.assign(courseId, {
        student_id: vars.payload.studentId,
        to_group_id: vars.toGroupId,
        from_group_version: vars.payload.fromGroupVersion,
        to_group_version: vars.toGroupVersion,
      });
    },
    onSuccess: async (_res, vars) => {
      setActionError(null);
      const targetGroup = plaza.data?.groups.find((g) => g.id === vars.toGroupId);
      if (vars.toGroupId && targetGroup) {
        setLiveStatus(
          tr("已将 {0} 分配到 {1}", {
            0: vars.payload.studentName,
            1: targetGroup.name,
          }),
        );
      } else {
        setLiveStatus(
          tr("已将 {0} 移回未组队池", {
            0: vars.payload.studentName,
          }),
        );
      }
      await refreshAll();
    },
    onError: (err) => {
      void handleMutationError(err);
    },
    onSettled: () => {
      setBusyStudentId(null);
      setBusyGroupId(null);
      setDraggingStudent(null);
    },
  });

  const setLeader = useMutation({
    mutationFn: (vars: { groupId: string; leaderUserId: string; version: number }) => {
      setBusyGroupId(vars.groupId);
      setBusyStudentId(vars.leaderUserId);
      return teacherClassesApi.setLeader(courseId, vars.groupId, {
        user_id: vars.leaderUserId,
        expected_version: vars.version,
      });
    },
    onSuccess: async () => {
      setActionError(null);
      setLiveStatus("已更新队长");
      await refreshAll();
    },
    onError: (err) => {
      void handleMutationError(err);
    },
    onSettled: () => {
      setBusyGroupId(null);
      setBusyStudentId(null);
    },
  });

  if (plaza.isLoading) {
    return (
      <div role="status" className="gp-empty">
        正在加载…
      </div>
    );
  }

  if (plaza.error || !plaza.data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        <p>{errorText(plaza.error)}</p>
        <button
          type="button"
          className={`${secondary} mt-3`}
          onClick={() => void plaza.refetch()}
        >
          重试
        </button>
      </div>
    );
  }

  const data = plaza.data;
  const canManage = data.can_manage && (perms.loading || perms.manageGroups);
  const groupedCount = data.groups.reduce((acc, g) => acc + g.member_count, 0);
  const ungroupedCount = data.ungrouped.length;
  const deadlinePassed = !data.formation_open && Boolean(data.formation_deadline);

  const availableGroupOptions: AssignOption[] = canManage
    ? data.groups
        .filter((g) => g.accepts_drop && !g.roster_frozen && g.member_count < g.max_group_size)
        .map((g) => ({
          groupId: g.id,
          label: g.name,
          toGroupVersion: g.lock_version,
        }))
    : [];

  const handlePoolDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canManage) return;
    event.preventDefault();
    const cannotDropToPool =
      draggingStudent !== null &&
      (draggingStudent.fromGroupId === null || draggingStudent.inProjectGroup);
    event.dataTransfer.dropEffect = cannotDropToPool ? "none" : "move";
    if (!poolDragOver) setPoolDragOver(true);
  };

  const handlePoolDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setPoolDragOver(false);
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
    if (!payload || payload.fromGroupId === null) return;
    assignStudent.mutate({
      payload,
      toGroupId: null,
      toGroupVersion: null,
    });
  };

  return (
    <div className="space-y-5">
      <div className="sr-only" role="status" aria-live="polite">
        {liveStatus}
      </div>

      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-bold text-slate-900">学生组队广场</h1>
              <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                {tr("已组队 {0} 人", { 0: groupedCount })}
              </span>
              <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                {tr("未组队 {0} 人", { 0: ungroupedCount })}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                {tr("共 {0} 支队伍", { 0: data.groups.length })}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              可将左侧未组队学生（或班级侧边栏中的学生）直接拖拽至右侧队伍卡片，或使用卡片上的「分配到…」下拉菜单。
            </p>
          </div>

          {canManage && (
            <button
              type="button"
              className={button}
              onClick={() => setCreatingGroup((prev) => !prev)}
            >
              <Plus size={15} />
              新建队伍
            </button>
          )}
        </div>

        {deadlinePassed && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-900">
            <Clock size={14} className="shrink-0" />
            <span>
              已过学生自主组队截止时间；教师仍可为未冻结名单的队伍手动分配或调整组员。
            </span>
          </div>
        )}

        {creatingGroup && canManage && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!groupName.trim()) return;
              createGroup.mutate();
            }}
            className="rounded-lg border border-slate-200 bg-slate-50/70 p-4"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className={label} htmlFor="plaza-new-group-name">
                  队伍名称
                </label>
                <input
                  id="plaza-new-group-name"
                  className={input}
                  required
                  maxLength={100}
                  placeholder="例如：第一组 / 星火小队"
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                />
              </div>
              <div>
                <label className={label} htmlFor="plaza-new-group-direction">
                  研究或项目方向（选填）
                </label>
                <input
                  id="plaza-new-group-direction"
                  className={input}
                  maxLength={100}
                  placeholder="例如：智能教育辅助系统"
                  value={groupDirection}
                  onChange={(event) => setGroupDirection(event.target.value)}
                />
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className={secondary}
                onClick={() => setCreatingGroup(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className={button}
                disabled={createGroup.isPending || !groupName.trim()}
              >
                {createGroup.isPending ? "正在创建…" : "确认创建队伍"}
              </button>
            </div>
          </form>
        )}
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800"
        >
          <div className="flex items-center gap-2">
            <AlertCircle size={15} className="shrink-0 text-red-600" />
            <span>{actionError.message}</span>
          </div>
          <div className="flex items-center gap-2">
            {actionError.memberChangesHref && (
              <Link href={actionError.memberChangesHref} className={secondary}>
                前往成员变动页面
              </Link>
            )}
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-xs font-medium text-red-700 underline"
            >
              关闭提示
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[280px_1fr]">
        <section
          aria-label="未组队学生池"
          data-testid="ungrouped-pool-dropzone"
          onDragOver={handlePoolDragOver}
          onDragLeave={() => setPoolDragOver(false)}
          onDrop={handlePoolDrop}
          className={`rounded-xl border bg-white p-4 transition ${
            poolDragOver
              ? "border-blue-500 bg-blue-50/30 ring-2 ring-blue-200"
              : "border-slate-200"
          }`}
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Users size={15} className="text-blue-600" />
              <h2 className="text-sm font-semibold text-slate-900">未组队学生池</h2>
            </div>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
              {tr("{0} 人", { 0: ungroupedCount })}
            </span>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            将未立项队伍中的学生拖回此处可解除其当前分组。
          </p>

          <div className="mt-3 space-y-2">
            {data.ungrouped.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-xs text-slate-500">
                所有入班学生均已分配队伍
              </div>
            ) : (
              data.ungrouped.map((student) => (
                <StudentEntity
                  key={student.id}
                  studentId={student.id}
                  name={student.name}
                  studentNumber={student.student_number}
                  initial={student.initial}
                  grouped={false}
                  fromGroupId={null}
                  fromGroupVersion={null}
                  canManage={canManage}
                  busy={busyStudentId === student.id}
                  assignOptions={availableGroupOptions}
                  onAssignSelect={(option) =>
                    assignStudent.mutate({
                      payload: {
                        studentId: student.id,
                        studentName: student.name || "未命名学生",
                        fromGroupId: null,
                        fromGroupVersion: null,
                        inProjectGroup: false,
                      },
                      toGroupId: option.groupId,
                      toGroupVersion: option.toGroupVersion,
                    })
                  }
                  onDragStartStudent={(payload) => setDraggingStudent(payload)}
                  onDragEndStudent={() => setDraggingStudent(null)}
                />
              ))
            )}
          </div>
        </section>

        <section aria-label="班级队伍列表" className="space-y-4">
          {data.groups.length === 0 ? (
            <div className={`${card} py-12 text-center`}>
              <p className="text-sm font-medium text-slate-700">当前班级暂无队伍</p>
              <p className="mt-1 text-xs text-slate-500">
                点击右上角「新建队伍」即可创建空队伍，并将未组队学生拖拽进组。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {data.groups.map((group) => (
                <TeamCard
                  key={group.id}
                  courseId={courseId}
                  group={group}
                  allGroups={data.groups}
                  canManage={canManage}
                  busyStudentId={busyStudentId}
                  busyGroupId={busyGroupId}
                  draggingStudent={draggingStudent}
                  onDragStartStudent={(payload) => setDraggingStudent(payload)}
                  onDragEndStudent={() => setDraggingStudent(null)}
                  onDropStudent={(payload, toGroupId, toGroupVersion) =>
                    assignStudent.mutate({
                      payload,
                      toGroupId,
                      toGroupVersion,
                    })
                  }
                  onSetLeader={(groupId, leaderUserId, version) =>
                    setLeader.mutate({ groupId, leaderUserId, version })
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
