"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, RefreshCw } from "lucide-react";
import { button, card, errorText, input, label, secondary } from "@/features/b/ui";
import { ActionCard } from "@/features/teacher/ActionCard";
import { ActionFilterPanel } from "@/features/teacher/ActionFilterPanel";
import {
  type ActionDef,
  type TeacherActionItem,
  type TeacherActionType,
  newIdempotencyKey,
  teacherActionsApi,
  teacherActionsKeys,
} from "@/lib/api/teacher-actions-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

export function TeacherActionsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();

  const [selectedTypes, setSelectedTypes] = useState<TeacherActionType[]>([]);
  const [status, setStatus] = useState("pending");
  const [priority, setPriority] = useState("all");
  const [days, setDays] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reasonModal, setReasonModal] = useState<{ item: TeacherActionItem; action: ActionDef } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

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

  const invalidate = async () => {
    setSelectedIds([]);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["b-teacher-actions", userId, courseId] }),
      qc.invalidateQueries({ queryKey: teacherActionsKeys.badge(userId, courseId) }),
      qc.invalidateQueries({ queryKey: ["b-teacher-roster", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-teacher-class", userId, courseId] }),
      qc.invalidateQueries({ queryKey: ["b-teacher-plaza", userId, courseId] }),
    ]);
  };

  const handleOne = useMutation({
    mutationFn: ({ item, actionKey, reason }: { item: TeacherActionItem; actionKey: string; reason?: string }) =>
      teacherActionsApi.handle(courseId, item.id, { action_key: actionKey, reason }, newIdempotencyKey()),
    onSuccess: async () => {
      setReasonModal(null);
      setReasonText("");
      setFeedback({ tone: "success", text: "该待办事项已处理。" });
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

  const items = actionsQuery.data?.items ?? [];
  const ackableIds = items
    .filter((i) => i.status === "pending" && i.available_actions.some((a) => a.key === "mark_read"))
    .map((i) => i.id);

  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="text-lg font-bold text-slate-900">审批与操作中心</h1>
          <p className="mt-1 text-xs text-slate-500">
            统一收口本班入班审批、逾期组队邀请、成员变动及逾期里程碑催办。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ackableIds.length > 0 && (
            <button
              type="button"
              className={secondary}
              disabled={batchAck.isPending}
              onClick={() => batchAck.mutate(selectedIds.length > 0 ? selectedIds : ackableIds)}
            >
              <CheckCheck size={14} />
              全部标记已读
            </button>
          )}
          <button
            type="button"
            className={secondary}
            disabled={actionsQuery.isFetching}
            onClick={() => void actionsQuery.refetch()}
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </div>

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[220px_1fr]">
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
        />

        <div className="space-y-3">
          {actionsQuery.isLoading ? (
            <div role="status" className="gp-empty">
              正在加载…
            </div>
          ) : actionsQuery.error ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
              <p>{errorText(actionsQuery.error)}</p>
              <button type="button" className={`${secondary} mt-3`} onClick={() => void actionsQuery.refetch()}>
                重试
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className={`${card} py-12 text-center text-sm text-slate-500`}>
              暂无待处理事项
            </div>
          ) : (
            items.map((item) => (
              <ActionCard
                key={item.id}
                item={item}
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

      {reasonModal && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">
              {tr("{0}：{1}", { 0: tr(reasonModal.action.label), 1: reasonModal.item.title })}
            </h2>
            {reasonModal.action.confirm_text && (
              <p className="text-xs text-slate-500">{reasonModal.action.confirm_text}</p>
            )}
            <div>
              <label className={label} htmlFor="action-reason-input">
                处理理由
              </label>
              <input
                id="action-reason-input"
                className={input}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="请填写原因"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={secondary} onClick={() => setReasonModal(null)}>
                取消
              </button>
              <button
                type="button"
                className={button}
                disabled={handleOne.isPending || !reasonText.trim()}
                onClick={() =>
                  handleOne.mutate({
                    item: reasonModal.item,
                    actionKey: reasonModal.action.key,
                    reason: reasonText.trim(),
                  })
                }
              >
                {handleOne.isPending ? "正在处理…" : "确认提交"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
