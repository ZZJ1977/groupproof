"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckSquare, ShieldCheck, UserCog } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { errorText } from "@/shared/lib/b-ui";
import { cn } from "@/shared/lib/utils";
import { AppealDetailPanel } from "@/teacher/components/AppealDetailPanel";
import {
  TeacherFeedbackPill,
  type TeacherFeedbackTone,
} from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import { teacherActionsApi, teacherActionsKeys } from "@/teacher/api/teacher-actions-client";
import {
  type AppealHandleAction,
  type AppealStatus,
  teacherAppealsApi,
  teacherAppealsKeys,
} from "@/teacher/api/teacher-appeals-client";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

const statusLabel: Record<AppealStatus, string> = {
  pending: "待审核",
  need_supplement: "待补充材料",
  accepted: "已受理",
  rejected: "已驳回",
};

const statusTone: Record<AppealStatus, string> = {
  pending: "bg-amber-50 text-amber-800",
  need_supplement: "bg-[#e8f0fe] text-[#1d4ed8]",
  accepted: "bg-[#ecfdf5] text-[#008a5c]",
  rejected: "bg-[#fef2f2] text-[#d93025]",
};

export function TeacherAppealsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: TeacherFeedbackTone; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const preselect = new URLSearchParams(window.location.search).get("appeal");
    if (preselect) {
      setSelectedId(preselect);
      setMobileShowDetail(true);
    }
  }, []);

  const badgeQuery = useQuery({
    queryKey: teacherActionsKeys.badge(userId, courseId),
    queryFn: () => teacherActionsApi.list(courseId, { status: "pending", page: 1, page_size: 1 }),
    enabled: Boolean(courseId && userId),
  });

  const listQuery = useQuery({
    queryKey: teacherAppealsKeys.list(userId, courseId, statusFilter),
    queryFn: () => teacherAppealsApi.list(courseId, statusFilter),
    enabled: Boolean(courseId),
  });

  const items = listQuery.data?.items ?? [];
  const activeId =
    selectedId && items.some((i) => i.id === selectedId) ? selectedId : (items[0]?.id ?? null);

  const detailQuery = useQuery({
    queryKey: teacherAppealsKeys.detail(userId, courseId, activeId ?? ""),
    queryFn: () => teacherAppealsApi.detail(courseId, activeId as string),
    enabled: Boolean(courseId && activeId),
  });

  const handleMut = useMutation({
    mutationFn: (payload: {
      action: AppealHandleAction;
      reason: string;
      contribution_adjustments?: { user_id: string; share: number; note?: string }[];
    }) => teacherAppealsApi.handle(courseId, activeId as string, payload),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: tr("申诉裁决已保存并通知申诉学生") });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["b-teacher-appeals", userId, courseId] }),
        activeId
          ? qc.invalidateQueries({
              queryKey: teacherAppealsKeys.detail(userId, courseId, activeId),
            })
          : Promise.resolve(),
        qc.invalidateQueries({ queryKey: ["b-teacher-actions", userId, courseId] }),
        qc.invalidateQueries({ queryKey: teacherActionsKeys.badge(userId, courseId) }),
      ]);
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const canHandle = listQuery.data?.can_handle ?? perms.approveChanges;
  const counts = listQuery.data?.counts ?? {};

  return (
    <div className="min-w-0 max-w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          activeId="appeals"
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
                (badgeQuery.data?.pending_count ?? 0) > 0
                  ? badgeQuery.data?.pending_count
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
          <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--gp-ink,#1f2329)]">
            <ShieldCheck size={18} className="shrink-0 text-[var(--gp-action,#3370ff)]" />
            {tr("申诉与争议处理")}
          </h1>
          <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("联动调阅学生任务记录、GitHub 提交与当前贡献度快照，裁决并按需重算冻结快照。")}
          </p>
        </div>

        <TeacherSegmentedTabs
          variant="pill"
          size="sm"
          ariaLabel={tr("状态筛选")}
          activeId={statusFilter}
          onChange={(id) => {
            setStatusFilter(id);
            setSelectedId(null);
            setMobileShowDetail(false);
          }}
          items={[
            { id: "all", label: tr("全部 ({0})", { 0: counts.all ?? 0 }) },
            { id: "pending", label: tr("待审核 ({0})", { 0: counts.pending ?? 0 }) },
            {
              id: "need_supplement",
              label: tr("待补充 ({0})", { 0: counts.need_supplement ?? 0 }),
            },
            { id: "handled", label: tr("已处理 ({0})", { 0: counts.handled ?? 0 }) },
          ]}
        />
      </div>

      {listQuery.isLoading ? (
        <div role="status" className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <span className="sr-only">{tr("正在加载申诉列表…")}</span>
          <div className={cn(feishuCard, "h-64 animate-pulse")} />
          <div className={cn(feishuCard, "h-64 animate-pulse")} />
        </div>
      ) : listQuery.isError ? (
        <div
          role="alert"
          className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}
        >
          <TeacherFeedbackPill tone="error" message={errorText(listQuery.error)} />
          <Button type="button" variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className={cn(feishuCard, "py-10 text-center text-sm text-[var(--gp-muted,#646a73)]")}>
          {tr("当前筛选条件下暂无学生申诉记录")}
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div
            className={cn(
              "min-w-0 divide-y divide-[var(--gp-border-subtle,#ebedf0)] rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-2 shadow-[var(--gp-shadow-card)]",
              mobileShowDetail ? "hidden lg:block" : "block",
            )}
          >
            {items.map((item) => {
              const selected = activeId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id);
                    setMobileShowDetail(true);
                  }}
                  className={cn(
                    "w-full rounded-[8px] p-3 text-left transition-colors",
                    selected
                      ? "bg-[#e8f0fe] text-[#1d4ed8]"
                      : "hover:bg-[var(--gp-surface-hover,#eff0f1)]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "truncate text-sm font-semibold",
                        selected ? "text-[#1d4ed8]" : "text-[var(--gp-ink,#1f2329)]",
                      )}
                    >
                      {item.title}
                    </span>
                    <span
                      className={cn(
                        "gp-tabular shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        statusTone[item.status],
                      )}
                    >
                      {tr(statusLabel[item.status])}
                    </span>
                  </div>
                  <div
                    className={cn(
                      "mt-1 truncate text-xs",
                      selected ? "text-[#1d4ed8]/80" : "text-[var(--gp-muted,#646a73)]",
                    )}
                  >
                    {item.appellant_name} · {item.project_name}
                  </div>
                </button>
              );
            })}
          </div>

          <div className={cn("min-w-0", mobileShowDetail ? "block" : "hidden lg:block")}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-3 lg:hidden"
              onClick={() => setMobileShowDetail(false)}
            >
              <ArrowLeft size={14} />
              {tr("返回列表")}
            </Button>

            {detailQuery.isLoading ? (
              <div role="status" className={cn(feishuCard, "h-64 animate-pulse")}>
                <span className="sr-only">{tr("正在加载申诉详情与贡献度快照…")}</span>
              </div>
            ) : detailQuery.isError ? (
              <div
                role="alert"
                className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}
              >
                <TeacherFeedbackPill tone="error" message={errorText(detailQuery.error)} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void detailQuery.refetch()}
                >
                  {tr("重试")}
                </Button>
              </div>
            ) : detailQuery.data ? (
              <AppealDetailPanel
                detail={detailQuery.data}
                canHandle={canHandle}
                submitting={handleMut.isPending}
                onHandle={(payload) => handleMut.mutate(payload)}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
