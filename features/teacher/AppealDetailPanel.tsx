"use client";

import { useEffect, useState } from "react";
import { button, card, input, label, secondary } from "@/features/b/ui";
import type { AppealDetailData, AppealHandleAction } from "@/lib/api/teacher-appeals-client";
import { tr } from "@/lib/i18n/tr";

const dangerBtn =
  "inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50";

export function AppealDetailPanel({
  detail,
  canHandle,
  submitting,
  onHandle,
}: {
  detail: AppealDetailData;
  canHandle: boolean;
  submitting: boolean;
  onHandle: (payload: {
    action: AppealHandleAction;
    reason: string;
    contribution_adjustments?: { user_id: string; share: number; note?: string }[];
  }) => void;
}) {
  const { appeal, decisions, appellant_tasks, github_commit_count, snapshot } = detail;
  const [reason, setReason] = useState("");
  const [adjustShares, setAdjustShares] = useState<Record<string, string>>({});
  const [adjustContribution, setAdjustContribution] = useState(false);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const item of snapshot.items) {
      init[item.user_id] = String(item.share);
    }
    setAdjustShares(init);
    setReason("");
    setAdjustContribution(false);
  }, [appeal.id, snapshot.items]);

  const editable =
    canHandle && (appeal.status === "pending" || appeal.status === "need_supplement");

  const handleAction = (action: AppealHandleAction) => {
    if (!reason.trim()) return;
    const adjustments =
      action === "accept" && adjustContribution
        ? snapshot.items.map((item) => ({
            user_id: item.user_id,
            share: Number(adjustShares[item.user_id] ?? item.share),
            note: reason.trim(),
          }))
        : undefined;
    onHandle({
      action,
      reason: reason.trim(),
      contribution_adjustments: adjustments,
    });
  };

  return (
    <div className="space-y-4">
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{appeal.title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {tr("申诉人：{0} · 小组：{1} · 项目：{2}", {
                0: appeal.appellant_name,
                1: appeal.group_name ?? tr("未关联小组"),
                2: appeal.project_name,
              })}
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
            {appeal.status}
          </span>
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-800">
          {appeal.content}
        </div>

        {appeal.supplement_text && (
          <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-slate-800">
            <div className="mb-1 font-semibold text-blue-800">{tr("学生补充说明")}</div>
            <p className="whitespace-pre-wrap">{appeal.supplement_text}</p>
          </div>
        )}

        {appeal.evidence.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {appeal.evidence.map((ev, idx) => (
              <span key={idx} className="rounded bg-slate-100 px-2 py-0.5 font-mono text-slate-600">
                {ev}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className={`${card} space-y-2`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
            <span>{tr("申诉人项目履历核查")}</span>
            <span className="font-mono text-blue-700">
              {tr("GitHub 提交 {0} 次", { 0: github_commit_count })}
            </span>
          </div>
          {appellant_tasks.length === 0 ? (
            <p className="text-xs text-slate-400">{tr("该生名下暂无关联任务")}</p>
          ) : (
            <div className="space-y-1.5">
              {appellant_tasks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded border border-slate-100 px-2.5 py-1.5 text-xs"
                >
                  <span className="truncate font-medium text-slate-800">{t.title}</span>
                  <span className="shrink-0 font-mono text-slate-500">
                    {t.status} ({t.progress_percent}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`${card} space-y-2`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
            <span>{tr("当前贡献度快照")}</span>
            <span className="text-slate-500">
              {snapshot.version_no ? `v${snapshot.version_no} (${snapshot.status})` : tr("基准")}
            </span>
          </div>
          {snapshot.items.length === 0 ? (
            <p className="text-xs text-slate-400">{tr("暂无成员贡献度数据")}</p>
          ) : (
            <div className="space-y-1.5">
              {snapshot.items.map((m) => (
                <div
                  key={m.user_id}
                  className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2.5 py-1.5 text-xs"
                >
                  <span className="font-medium text-slate-800">{m.name}</span>
                  {editable && adjustContribution ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        aria-label={m.name}
                        className="w-20 rounded border border-slate-300 px-2 py-0.5 text-right font-mono text-xs"
                        value={adjustShares[m.user_id] ?? String(m.share)}
                        onChange={(e) =>
                          setAdjustShares((prev) => ({ ...prev, [m.user_id]: e.target.value }))
                        }
                      />
                      <span>%</span>
                    </div>
                  ) : (
                    <span className="font-mono font-semibold text-blue-700">{m.share}%</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {decisions.length > 0 && (
        <div className={`${card} space-y-2`}>
          <div className="text-xs font-semibold text-slate-700">{tr("审核决策记录")}</div>
          {decisions.map((d) => (
            <div key={d.id} className="rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
              <div className="flex justify-between font-medium text-slate-800">
                <span>
                  {d.actor_name} · {d.action}
                </span>
                <span className="text-slate-400">{d.created_at.slice(0, 16)}</span>
              </div>
              <p className="mt-1 text-slate-600">{d.reason}</p>
            </div>
          ))}
        </div>
      )}

      {editable && (
        <div className={`${card} space-y-3 border-blue-200 bg-slate-50/60`}>
          <label className={label} htmlFor="appeal-reason">
            {tr("裁决意见与结论说明")}
          </label>
          <textarea
            id="appeal-reason"
            rows={3}
            className={input}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tr("请说明裁决依据、要求补充的具体证据，或调权后的占比说明…")}
          />

          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={adjustContribution}
              onChange={(e) => setAdjustContribution(e.target.checked)}
            />
            {tr("受理时同步调整上方贡献度占比并生成新冻结快照")}
          </label>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={!reason.trim() || submitting}
              onClick={() => handleAction("request_supplement")}
              className={secondary}
            >
              {tr("要求补充材料")}
            </button>
            <button
              type="button"
              disabled={!reason.trim() || submitting}
              onClick={() => handleAction("reject")}
              className={dangerBtn}
            >
              {tr("驳回申诉")}
            </button>
            <button
              type="button"
              disabled={!reason.trim() || submitting}
              onClick={() => handleAction("accept")}
              className={button}
            >
              {adjustContribution ? tr("接受并生成新快照") : tr("受理申诉")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
