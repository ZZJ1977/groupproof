"use client";

import { type DragEvent, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, ChevronUp, Clock, Plus, Users } from "lucide-react";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { errorText } from "@/shared/lib/b-ui";
import { cn } from "@/shared/lib/utils";
import {
  type AssignOption,
  type DragStudentPayload,
  StudentEntity,
} from "@/teacher/components/StudentEntity";
import { TeamCard } from "@/teacher/components/TeamCard";
import {
  TeacherFeedbackPill,
  type TeacherFeedbackTone,
} from "@/teacher/components/TeacherFeedbackPill";
import { BApiError } from "@/student/api/b-client";
import { teacherClassesApi, teacherKeys } from "@/teacher/api/teacher-client";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuInput =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[#3370ff]/15";
const feishuLabel = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

export function TeamPlazaApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDirection, setGroupDirection] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [draggingStudent, setDraggingStudent] = useState<DragStudentPayload | null>(null);
  const [poolDragOver, setPoolDragOver] = useState(false);
  const [poolExpandedMobile, setPoolExpandedMobile] = useState(true);
  const [busyStudentId, setBusyStudentId] = useState<string | null>(null);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [settingLeaderId, setSettingLeaderId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: TeacherFeedbackTone; message: string } | null>(
    null,
  );
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
    setFeedback(null);
    if (err instanceof BApiError) {
      if (err.code === "VERSION_CONFLICT") {
        await refreshAll();
        setActionError({
          message: tr("队伍数据刚被更新，已为您自动刷新最新状态，请重试。"),
        });
        return;
      }
      if (err.code === "GROUP_HAS_PROJECT") {
        const href =
          typeof err.details.member_changes_href === "string"
            ? err.details.member_changes_href
            : `/teacher/courses/${courseId}/member-changes`;
        setActionError({
          message: tr("该队伍已立项，不能直接拖出或换组，请通过成员变动流程处理。"),
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
    onMutate: () => {
      setCreateError(null);
      setFeedback({ tone: "loading", message: tr("正在创建…") });
    },
    onSuccess: async (created) => {
      setGroupName("");
      setGroupDirection("");
      setCreateError(null);
      setCreatingGroup(false);
      setActionError(null);
      setFeedback({ tone: "success", message: tr("已创建队伍 {0}", { 0: created.name }) });
      await refreshAll();
    },
    onError: (err) => {
      setFeedback(null);
      setCreateError(errorText(err));
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
    onMutate: () => {
      setFeedback({ tone: "loading", message: tr("保存中…") });
    },
    onSuccess: async (_res, vars) => {
      setActionError(null);
      const targetGroup = plaza.data?.groups.find((g) => g.id === vars.toGroupId);
      if (vars.toGroupId && targetGroup) {
        setFeedback({
          tone: "success",
          message: tr("已将 {0} 分配到 {1}", {
            0: vars.payload.studentName,
            1: targetGroup.name,
          }),
        });
      } else {
        setFeedback({
          tone: "success",
          message: tr("已将 {0} 移回未组队池", {
            0: vars.payload.studentName,
          }),
        });
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
      setSettingLeaderId(vars.leaderUserId);
      return teacherClassesApi.setLeader(courseId, vars.groupId, {
        user_id: vars.leaderUserId,
        expected_version: vars.version,
      });
    },
    onMutate: () => {
      setFeedback({ tone: "loading", message: tr("保存中…") });
    },
    onSuccess: async () => {
      setActionError(null);
      setFeedback({ tone: "success", message: tr("已更新队长") });
      await refreshAll();
    },
    onError: (err) => {
      void handleMutationError(err);
    },
    onSettled: () => {
      setBusyGroupId(null);
      setBusyStudentId(null);
      setSettingLeaderId(null);
    },
  });

  if (plaza.isLoading) {
    return (
      <div role="status" className="min-w-0 max-w-full space-y-5">
        <span className="sr-only">{tr("正在加载…")}</span>
        <div className={cn(feishuCard, "h-24 animate-pulse")} />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className={cn(feishuCard, "h-64 animate-pulse")} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className={cn(feishuCard, "h-56 animate-pulse")} />
            <div className={cn(feishuCard, "h-56 animate-pulse")} />
          </div>
        </div>
      </div>
    );
  }

  if (plaza.error || !plaza.data) {
    return (
      <div
        role="alert"
        className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}
      >
        <TeacherFeedbackPill tone="error" message={errorText(plaza.error)} />
        <Button type="button" variant="outline" size="sm" onClick={() => void plaza.refetch()}>
          重试
        </Button>
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
    <div className="min-w-0 max-w-full space-y-5">
      <div className={cn(feishuCard, "space-y-4")}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-bold text-[var(--gp-ink,#1f2329)]">学生组队广场</h1>
              <span className="gp-tabular rounded-full bg-[#ecfdf5] px-2.5 py-0.5 text-xs font-semibold text-[#008a5c]">
                {tr("已组队 {0} 人", { 0: groupedCount })}
              </span>
              <span className="gp-tabular rounded-full bg-[#e8f0fe] px-2.5 py-0.5 text-xs font-semibold text-[#1d4ed8]">
                {tr("未组队 {0} 人", { 0: ungroupedCount })}
              </span>
              <span className="gp-tabular rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-2.5 py-0.5 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
                {tr("共 {0} 支队伍", { 0: data.groups.length })}
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              可将左侧未组队学生（或班级侧边栏中的学生）直接拖拽至右侧队伍卡片，或使用卡片上的「分配到…」下拉菜单。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {feedback && (
              <TeacherFeedbackPill
                tone={feedback.tone}
                message={feedback.message}
                autoHideMs={3500}
                onDismiss={() => setFeedback(null)}
              />
            )}
            {canManage && (
              <Button
                type="button"
                variant="default"
                size="sm"
                pill
                onClick={() => {
                  setCreateError(null);
                  setCreatingGroup(true);
                }}
              >
                <Plus size={15} />
                新建队伍
              </Button>
            )}
          </div>
        </div>

        {deadlinePassed && (
          <div className="flex items-center gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-900">
            <Clock size={14} className="shrink-0" />
            <span>
              已过学生自主组队截止时间；教师仍可为未冻结名单的队伍手动分配或调整组员。
            </span>
          </div>
        )}
      </div>

      <Sheet
        open={creatingGroup && canManage}
        onOpenChange={(open) => {
          if (createGroup.isPending) return;
          setCreatingGroup(open);
          if (!open) setCreateError(null);
        }}
      >
        <SheetContent
          side="right"
          className="flex flex-col justify-between sm:max-w-[480px]"
          onEscapeKeyDown={(event) => {
            if (createGroup.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (createGroup.isPending) event.preventDefault();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!groupName.trim()) return;
              createGroup.mutate();
            }}
            className="flex h-full flex-col justify-between gap-5"
          >
            <div className="space-y-4">
              <SheetHeader className="pr-8">
                <SheetTitle className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                  新建队伍
                </SheetTitle>
                <SheetDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                  可将左侧未组队学生（或班级侧边栏中的学生）直接拖拽至右侧队伍卡片，或使用卡片上的「分配到…」下拉菜单。
                </SheetDescription>
              </SheetHeader>

              {createError && (
                <TeacherFeedbackPill
                  tone="error"
                  message={createError}
                  onDismiss={() => setCreateError(null)}
                />
              )}

              <div className="space-y-4">
                <div>
                  <label className={feishuLabel} htmlFor="plaza-new-group-name">
                    队伍名称
                  </label>
                  <input
                    id="plaza-new-group-name"
                    className={feishuInput}
                    required
                    maxLength={100}
                    placeholder="例如：第一组 / 星火小队"
                    value={groupName}
                    onChange={(event) => setGroupName(event.target.value)}
                  />
                </div>
                <div>
                  <label className={feishuLabel} htmlFor="plaza-new-group-direction">
                    研究或项目方向（选填）
                  </label>
                  <input
                    id="plaza-new-group-direction"
                    className={feishuInput}
                    maxLength={100}
                    placeholder="例如：智能教育辅助系统"
                    value={groupDirection}
                    onChange={(event) => setGroupDirection(event.target.value)}
                  />
                </div>
              </div>
            </div>

            <SheetFooter className="border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={createGroup.isPending}
                onClick={() => setCreatingGroup(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                pill
                loading={createGroup.isPending}
                preserveWidth
                disabled={!groupName.trim()}
              >
                {createGroup.isPending ? tr("正在创建…") : tr("确认创建队伍")}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {actionError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-xs text-[#b91c1c]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle size={15} className="shrink-0 text-[#d93025]" />
            <span>{actionError.message}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actionError.memberChangesHref && (
              <Link
                href={actionError.memberChangesHref}
                data-variant="outline"
                className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
              >
                前往成员变动页面
              </Link>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setActionError(null)}
            >
              关闭提示
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <section
          aria-label="未组队学生池"
          data-testid="ungrouped-pool-dropzone"
          onDragOver={handlePoolDragOver}
          onDragLeave={() => setPoolDragOver(false)}
          onDrop={handlePoolDrop}
          className={cn(
            "min-w-0 rounded-[12px] border bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] transition-colors",
            poolDragOver
              ? "border-[var(--gp-action,#3370ff)] bg-[#e8f0fe]/35 ring-2 ring-[#c7dafc]"
              : "border-[var(--gp-border,#dee0e3)]",
          )}
        >
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-3">
            <div className="flex min-w-0 max-w-full items-center gap-2">
              <Users size={15} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
              <h2 className="truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                未组队学生池
              </h2>
            </div>
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
              <span className="gp-tabular shrink-0 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-xs font-semibold text-[#1d4ed8]">
                {tr("{0} 人", { 0: ungroupedCount })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPoolExpandedMobile((prev) => !prev)}
                aria-expanded={poolExpandedMobile}
                className="h-auto min-h-7 max-w-full whitespace-normal px-2 py-1 text-left text-xs xl:hidden"
              >
                {poolExpandedMobile ? (
                  <>
                    <ChevronUp size={13} className="shrink-0" />
                    <span>{tr("收起 {0}", { 0: tr("未组队学生池") })}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown size={13} className="shrink-0" />
                    <span>{tr("展开 {0}", { 0: tr("未组队学生池") })}</span>
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className={cn(poolExpandedMobile ? "mt-2 block" : "mt-2 hidden xl:block")}>
            <p className="text-xs text-[var(--gp-muted,#646a73)]">
              将未立项队伍中的学生拖回此处可解除其当前分组。
            </p>

            <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1 xl:max-h-[620px]">
              {data.ungrouped.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] py-8 text-center text-xs text-[var(--gp-muted,#646a73)]">
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
                          studentName: student.name || tr("未命名学生"),
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
          </div>
        </section>

        <section aria-label="班级队伍列表" className="@container min-w-0 space-y-4">
          {data.groups.length === 0 ? (
            <div className={cn(feishuCard, "py-12 text-center")}>
              <p className="text-sm font-medium text-[var(--gp-ink-soft,#4e5969)]">
                当前班级暂无队伍
              </p>
              <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                点击右上角「新建队伍」即可创建空队伍，并将未组队学生拖拽进组。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 @[560px]:grid-cols-2">
              {data.groups.map((group) => (
                <TeamCard
                  key={group.id}
                  courseId={courseId}
                  group={group}
                  allGroups={data.groups}
                  canManage={canManage}
                  busyStudentId={busyStudentId}
                  busyGroupId={busyGroupId}
                  settingLeaderStudentId={settingLeaderId}
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
