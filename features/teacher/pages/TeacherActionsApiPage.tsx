"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCheck,
  CheckSquare,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { errorText } from "@/features/b/ui";
import { cn } from "@/lib/utils";
import { bCoursesApi } from "@/lib/api/b-courses";
import { bMembershipApi, type BMembershipChange } from "@/lib/api/b-membership";
import { ActionCard } from "@/features/teacher/components/ActionCard";
import { ActionFilterPanel } from "@/features/teacher/components/ActionFilterPanel";
import { TeacherConfirmDialog } from "@/features/teacher/components/TeacherConfirmDialog";
import {
  TeacherFeedbackPill,
  type TeacherFeedbackTone,
} from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";
import { type JoinMode, teacherClassesApi, teacherKeys } from "@/features/teacher/api/teacher-client";
import {
  type ActionDef,
  type TeacherActionItem,
  type TeacherActionType,
  newIdempotencyKey,
  teacherActionsApi,
  teacherActionsKeys,
} from "@/features/teacher/api/teacher-actions-client";
import { useTeacherPermissions } from "@/features/teacher/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuInput =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[#3370ff]/15";

export function TeacherActionsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const [selectedTypes, setSelectedTypes] = useState<TeacherActionType[]>([]);
  const [status, setStatus] = useState("pending");
  const [priority, setPriority] = useState("all");
  const [days, setDays] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [reasonModal, setReasonModal] = useState<{ item: TeacherActionItem; action: ActionDef } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [feedback, setFeedback] = useState<{ tone: TeacherFeedbackTone; text: string } | null>(null);

  const queryParams = useMemo(
    () => ({
      type: selectedTypes.length > 0 ? selectedTypes.join(",") : undefined,
      status,
      priority: priority === "all" ? undefined : priority,
      days: days ? Number(days) : undefined,
      page: 1,
      page_size: 50,
    }),
    [selectedTypes, status, priority, days],
  );

  const actionsQuery = useQuery({
    queryKey: teacherActionsKeys.list(userId, courseId, JSON.stringify(queryParams)),
    queryFn: () => teacherActionsApi.list(courseId, queryParams),
    enabled: Boolean(courseId),
  });

  const courseDetailQuery = useQuery({
    queryKey: teacherKeys.classDetail(userId, courseId),
    queryFn: () => teacherClassesApi.detail(courseId),
    enabled: Boolean(courseId),
  });

  const joinPolicyQuery = useQuery({
    queryKey: ["b-join-policy", userId, courseId],
    queryFn: () => bCoursesApi.joinPolicy(courseId),
    enabled: Boolean(courseId),
    retry: false,
  });

  const items = actionsQuery.data?.items ?? [];
  const hasMemberChanges = items.some(
    (item) => item.type === "member_leave" || item.type === "member_remove",
  );

  const changesQuery = useQuery({
    queryKey: ["b-course-membership-changes", userId, courseId, "actions-inline"],
    queryFn: () => bMembershipApi.courseChanges(courseId),
    enabled: Boolean(courseId) && hasMemberChanges,
    retry: false,
  });

  const changesById = useMemo(() => {
    const map = new Map<string, BMembershipChange>();
    for (const c of changesQuery.data ?? []) {
      map.set(c.id, c);
    }
    return map;
  }, [changesQuery.data]);

  const invalidate = async () => {
    setSelectedIds([]);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["b-teacher-actions", userId, courseId] }),
      qc.invalidateQueries({ queryKey: teacherActionsKeys.badge(userId, courseId) }),
      qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-teacher-class", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-teacher-plaza", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-course-membership-changes", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-join-requests", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-awaiting-invitations", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-join-policy", userId, courseId] }),
    ]);
  };

  const handleOne = useMutation({
    mutationFn: ({ item, actionKey, reason }: { item: TeacherActionItem; actionKey: string; reason?: string }) =>
      teacherActionsApi.handle(courseId, item.id, { action_key: actionKey, reason }, newIdempotencyKey()),
    onSuccess: async () => {
      setReasonModal(null);
      setReasonText("");
      setFeedback({ tone: "success", text: tr("该待办事项已处理。") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const remindOne = useMutation({
    mutationFn: (actionId: string) =>
      teacherActionsApi.remind(courseId, actionId, undefined, newIdempotencyKey()),
    onSuccess: (res) =>
      setFeedback({ tone: "success", text: tr("已向 {0} 位相关同学发送催办通知。", { 0: res.notified_count }) }),
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const batchAck = useMutation({
    mutationFn: (ids: string[]) =>
      teacherActionsApi.batch(courseId, { ids, action_key: "mark_read" }, newIdempotencyKey()),
    onSuccess: async (res) => {
      setFeedback({
        tone: "success",
        text: tr("批量处理完成：成功 {0} 项，未完成 {1} 项。", { 0: res.handled, 1: res.failed }),
      });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const setJoinPolicyMut = useMutation({
    mutationFn: (mode: JoinMode) =>
      bCoursesApi.setJoinPolicy(courseId, {
        mode,
        expected_version: joinPolicyQuery.data?.lock_version ?? 0,
      }),
    onSuccess: async (updated) => {
      setFeedback({
        tone: "success",
        text: [
          tr("入班方式"),
          tr(updated.mode === "direct" ? "直接加入" : "加入需教师审批"),
        ].join(" · "),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["b-join-policy", userId, courseId] }),
        qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
        qc.invalidateQueries({ queryKey: teacherKeys.settings(userId, courseId) }),
      ]);
    },
    onError: async (err) => {
      await qc.invalidateQueries({ queryKey: ["b-join-policy", userId, courseId] });
      setFeedback({ tone: "error", text: errorText(err) });
    },
  });

  const onTriggerAction = (item: TeacherActionItem, action: ActionDef) => {
    if (action.key === "remind") {
      remindOne.mutate(item.id);
      return;
    }
    if (action.requires_reason) {
      setReasonModal({ item, action });
      setReasonText("");
      return;
    }
    handleOne.mutate({ item, actionKey: action.key });
  };

  const toggleType = (t: TeacherActionType) => {
    setSelectedTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const resetFilters = () => {
    setSelectedTypes([]);
    setStatus("pending");
    setPriority("all");
    setDays("");
  };

  const ackableIds = items
    .filter((i) => i.status === "pending" && i.available_actions.some((a) => a.key === "mark_read"))
    .map((i) => i.id);

  const activeFilterCount =
    selectedTypes.length +
    (status !== "pending" ? 1 : 0) +
    (priority !== "all" ? 1 : 0) +
    (days ? 1 : 0);

  const canEditJoinPolicy =
    perms.isTeacher &&
    Boolean(courseDetailQuery.data) &&
    courseDetailQuery.data?.status !== "ended" &&
    !setJoinPolicyMut.isPending;

  return (
    <div className="min-w-0 max-w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          activeId="actions"
          variant="segmented"
          size="sm"
          ariaLabel={tr("审批与申诉")}
          testId="hub3-segmented-tabs"
          items={[
            {
              id: "actions",
              label: tr("待办审批"),
              href: `/teacher/courses/${courseId}/actions`,
              icon: CheckSquare,
              badge:
                (actionsQuery.data?.pending_count ?? 0) > 0
                  ? actionsQuery.data?.pending_count
                  : undefined,
            },
            {
              id: "member-changes",
              label: tr("成员变动"),
              href: `/teacher/courses/${courseId}/member-changes`,
              icon: UserCog,
            },
            {
              id: "appeals",
              label: tr("申诉裁决"),
              href: `/teacher/courses/${courseId}/appeals`,
              icon: ShieldCheck,
            },
          ]}
        />

        {feedback && (
          <TeacherFeedbackPill
            tone={feedback.tone}
            message={feedback.text}
            autoHideMs={4000}
            onDismiss={() => setFeedback(null)}
          />
        )}
      </div>

      <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--gp-ink,#1f2329)]">审批与操作中心</h1>
          <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
            统一收口本班入班审批、逾期组队邀请、成员变动及逾期里程碑催办。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {joinPolicyQuery.data && (
            <label className="inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2.5 py-1 text-xs text-[var(--gp-ink-soft,#4e5969)]">
              <span className="shrink-0 font-medium">{tr("入班方式")}</span>
              <select
                aria-label={tr("入班方式")}
                disabled={!canEditJoinPolicy}
                value={joinPolicyQuery.data.mode}
                onChange={(event) => setJoinPolicyMut.mutate(event.target.value as JoinMode)}
                className="bg-transparent font-semibold text-[var(--gp-ink,#1f2329)] outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="direct">{tr("直接加入")}</option>
                <option value="approval">{tr("加入需教师审批")}</option>
              </select>
            </label>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            pill
            onClick={() => setFilterSheetOpen(true)}
            className="lg:hidden"
          >
            <SlidersHorizontal size={14} />
            {tr("筛选申请")}
            {activeFilterCount > 0 && (
              <span className="gp-tabular rounded-full bg-[#e8f0fe] px-1.5 py-0.5 text-[10px] font-bold text-[#1d4ed8]">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {ackableIds.length > 0 && (
            <Button
              type="button"
              variant="tonal"
              size="sm"
              pill
              loading={batchAck.isPending}
              preserveWidth
              onClick={() => batchAck.mutate(selectedIds.length > 0 ? selectedIds : ackableIds)}
            >
              <CheckCheck size={14} />
              全部标记已读
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={actionsQuery.isFetching}
            onClick={() => void actionsQuery.refetch()}
          >
            <RefreshCw size={14} />
            刷新
          </Button>
        </div>
      </div>

      <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
        <SheetContent side="left" className="w-[min(100vw,320px)] p-4">
          <SheetHeader className="pr-8">
            <SheetTitle className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
              {tr("筛选申请")}
            </SheetTitle>
          </SheetHeader>
          <ActionFilterPanel
            selectedTypes={selectedTypes}
            onToggleType={toggleType}
            status={status}
            onStatusChange={setStatus}
            priority={priority}
            onPriorityChange={setPriority}
            days={days}
            onDaysChange={setDays}
            countsByType={actionsQuery.data?.counts_by_type ?? {}}
            onReset={resetFilters}
            className="border-0 p-0 shadow-none"
          />
        </SheetContent>
      </Sheet>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
        <div className="hidden lg:block">
          <ActionFilterPanel
            selectedTypes={selectedTypes}
            onToggleType={toggleType}
            status={status}
            onStatusChange={setStatus}
            priority={priority}
            onPriorityChange={setPriority}
            days={days}
            onDaysChange={setDays}
            countsByType={actionsQuery.data?.counts_by_type ?? {}}
            onReset={resetFilters}
          />
        </div>

        <div className="min-w-0 space-y-3">
          {actionsQuery.isLoading ? (
            <div role="status" className="space-y-3">
              <span className="sr-only">{tr("正在加载…")}</span>
              {[0, 1, 2].map((idx) => (
                <div key={idx} className={cn(feishuCard, "h-24 animate-pulse")} />
              ))}
            </div>
          ) : actionsQuery.error ? (
            <div
              role="alert"
              className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}
            >
              <TeacherFeedbackPill tone="error" message={errorText(actionsQuery.error)} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void actionsQuery.refetch()}
              >
                重试
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className={cn(feishuCard, "py-12 text-center text-sm text-[var(--gp-muted,#646a73)]")}>
              暂无待处理事项
            </div>
          ) : (
            items.map((item) => (
              <ActionCard
                key={item.id}
                item={item}
                membershipChange={changesById.get(item.source_id)}
                selected={selectedIds.includes(item.id)}
                busy={handleOne.isPending || remindOne.isPending}
                onToggleSelect={(id) =>
                  setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                }
                onTriggerAction={onTriggerAction}
              />
            ))
          )}
        </div>
      </div>

      <TeacherConfirmDialog
        open={Boolean(reasonModal)}
        onOpenChange={(open) => {
          if (!open && !handleOne.isPending) {
            setReasonModal(null);
          }
        }}
        title={
          reasonModal
            ? tr("{0}：{1}", { 0: tr(reasonModal.action.label), 1: reasonModal.item.title })
            : ""
        }
        description={reasonModal?.action.confirm_text ?? undefined}
        confirmLabel={tr("确认提交")}
        cancelLabel={tr("取消")}
        tone={reasonModal?.action.style === "danger" ? "danger" : "default"}
        confirmDisabled={!reasonText.trim()}
        loading={handleOne.isPending}
        onConfirm={() => {
          if (!reasonModal || !reasonText.trim()) return;
          handleOne.mutate({
            item: reasonModal.item,
            actionKey: reasonModal.action.key,
            reason: reasonText.trim(),
          });
        }}
      >
        <div>
          <label
            className="mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]"
            htmlFor="action-reason-input"
          >
            处理理由
          </label>
          <input
            id="action-reason-input"
            className={feishuInput}
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder="请填写原因"
          />
        </div>
      </TeacherConfirmDialog>
    </div>
  );
}
