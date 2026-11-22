"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { card, errorText } from "@/features/b/ui";
import { AppealDetailPanel } from "@/features/teacher/AppealDetailPanel";
import {
  type AppealHandleAction,
  type AppealStatus,
  teacherAppealsApi,
  teacherAppealsKeys,
} from "@/lib/api/teacher-appeals-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const statusLabel: Record<AppealStatus, string> = {
  pending: "待审核",
  need_supplement: "待补充材料",
  accepted: "已受理",
  rejected: "已驳回",
};

const statusTone: Record<AppealStatus, string> = {
  pending: "bg-amber-50 text-amber-800",
  need_supplement: "bg-blue-50 text-blue-700",
  accepted: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
};

export function TeacherAppealsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const preselect = new URLSearchParams(window.location.search).get("appeal");
    if (preselect) setSelectedId(preselect);
  }, []);

  const listQuery = useQuery({
    queryKey: teacherAppealsKeys.list(userId, courseId, statusFilter),
    queryFn: () => teacherAppealsApi.list(courseId, statusFilter),
    enabled: Boolean(courseId),
  });

  const items = listQuery.data?.items ?? [];
  const activeId = selectedId ?? items[0]?.id ?? null;

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
      ]);
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const canHandle = listQuery.data?.can_handle ?? perms.approveChanges;
  const counts = listQuery.data?.counts ?? {};

  return (
    <div className="space-y-5">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <ShieldCheck size={18} className="text-blue-600" />
            {tr("申诉与争议处理")}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {tr("联动调阅学生任务记录、GitHub 提交与当前贡献度快照，裁决并按需重算冻结快照。")}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            { key: "all", label: tr("全部 ({0})", { 0: counts.all ?? 0 }) },
            { key: "pending", label: tr("待审核 ({0})", { 0: counts.pending ?? 0 }) },
            {
              key: "need_supplement",
              label: tr("待补充 ({0})", { 0: counts.need_supplement ?? 0 }),
            },
            { key: "handled", label: tr("已处理 ({0})", { 0: counts.handled ?? 0 }) },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                statusFilter === tab.key
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border px-4 py-3 text-sm ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {feedback.text}
        </div>
      )}

      {listQuery.isLoading ? (
        <div className={card}>{tr("正在加载申诉列表…")}</div>
      ) : listQuery.isError ? (
        <div className={`${card} text-sm text-red-600`}>{errorText(listQuery.error)}</div>
      ) : items.length === 0 ? (
        <div className={`${card} py-10 text-center text-sm text-slate-500`}>
          {tr("当前筛选条件下暂无学生申诉记录")}
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[320px_1fr]">
          <div className={`${card} divide-y divide-slate-100 p-2`}>
            {items.map((item) => {
              const selected = activeId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full rounded-lg p-3 text-left transition ${
                    selected ? "bg-blue-50" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900">
                      {item.title}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        statusTone[item.status]
                      }`}
                    >
                      {tr(statusLabel[item.status])}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {item.appellant_name} · {item.project_name}
                  </div>
                </button>
              );
            })}
          </div>

          <div>
            {detailQuery.isLoading ? (
              <div className={card}>{tr("正在加载申诉详情与贡献度快照…")}</div>
            ) : detailQuery.isError ? (
              <div className={`${card} text-sm text-red-600`}>{errorText(detailQuery.error)}</div>
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
