"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AppealDetailData,
  AppealHandleAction,
  AppealStatus,
} from "@/features/teacher/api/teacher-appeals-client";
import { tr } from "@/lib/i18n/tr";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuInput =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[#3370ff]/15";
const feishuLabel = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

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

  const parsedShares = snapshot.items.map((item) => {
    const raw = adjustShares[item.user_id] ?? String(item.share);
    const trimmed = raw.trim();
    return trimmed === "" ? Number.NaN : Number(trimmed);
  });
  const hasInvalidIndividualShare = parsedShares.some(
    (val) => !Number.isFinite(val) || val < 0 || val > 100,
  );
  const shareSum = parsedShares.reduce(
    (acc, val) => acc + (Number.isFinite(val) ? val : 0),
    0,
  );
  const shareSumRounded = Math.round(shareSum * 100) / 100;
  const sharesInvalid =
    adjustContribution &&
    (snapshot.items.length === 0 || hasInvalidIndividualShare || shareSumRounded !== 100);
  const sharesHint = hasInvalidIndividualShare
    ? tr("每位成员的贡献占比需在 0%–100% 之间")
    : tr("贡献度占比合计：{0}%（需等于 100%）", { 0: shareSumRounded });

  const handleAction = (action: AppealHandleAction) => {
    if (!reason.trim()) return;
    if (action === "accept" && sharesInvalid) return;
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
    <div className="min-w-0 space-y-4">
      <div className={cn(feishuCard, "space-y-3")}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-semibold text-[var(--gp-ink,#1f2329)]">
              {appeal.title}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
              {tr("申诉人：{0} · 小组：{1} · 项目：{2}", {
                0: appeal.appellant_name,
                1: appeal.group_name ?? tr("未关联小组"),
                2: appeal.project_name,
              })}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold",
              statusTone[appeal.status],
            )}
          >
            {statusLabel[appeal.status] ? tr(statusLabel[appeal.status]) : appeal.status}
          </span>
        </div>

        <div className="rounded-[8px] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3 text-sm leading-relaxed text-[var(--gp-ink,#1f2329)]">
          {appeal.content}
        </div>

        {appeal.supplement_text && (
          <div className="rounded-[8px] border border-[#c7dafc] bg-[#e8f0fe]/50 p-3 text-xs text-[var(--gp-ink,#1f2329)]">
            <div className="mb-1 font-semibold text-[#1d4ed8]">{tr("学生补充说明")}</div>
            <p className="whitespace-pre-wrap">{appeal.supplement_text}</p>
          </div>
        )}

        {appeal.evidence.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {appeal.evidence.map((ev, idx) => (
              <span
                key={idx}
                className="rounded bg-[var(--gp-surface-subtle,#f8f9fa)] px-2 py-0.5 font-mono text-[var(--gp-ink-soft,#4e5969)]"
              >
                {ev}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className={cn(feishuCard, "space-y-2")}>
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
            <span>{tr("申诉人项目履历核查")}</span>
            <span className="gp-tabular font-mono text-[#1d4ed8]">
              {tr("GitHub 提交 {0} 次", { 0: github_commit_count })}
            </span>
          </div>
          {appellant_tasks.length === 0 ? (
            <p className="text-xs text-[var(--gp-muted,#646a73)]">{tr("该生名下暂无关联任务")}</p>
          ) : (
            <div className="space-y-1.5">
              {appellant_tasks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-[8px] border border-[var(--gp-border-subtle,#ebedf0)] px-2.5 py-1.5 text-xs"
                >
                  <span className="truncate font-medium text-[var(--gp-ink,#1f2329)]">{t.title}</span>
                  <span className="gp-tabular shrink-0 font-mono text-[var(--gp-muted,#646a73)]">
                    {t.status} ({t.progress_percent}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={cn(feishuCard, "space-y-2")}>
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
            <span>{tr("当前贡献度快照")}</span>
            <span className="gp-tabular text-[var(--gp-muted,#646a73)]">
              {snapshot.version_no ? `v${snapshot.version_no} (${snapshot.status})` : tr("基准")}
            </span>
          </div>
          {snapshot.items.length === 0 ? (
            <p className="text-xs text-[var(--gp-muted,#646a73)]">{tr("暂无成员贡献度数据")}</p>
          ) : (
            <div className="space-y-1.5">
              {snapshot.items.map((m) => (
                <div
                  key={m.user_id}
                  className="flex items-center justify-between gap-2 rounded-[8px] border border-[var(--gp-border-subtle,#ebedf0)] px-2.5 py-1.5 text-xs"
                >
                  <span className="truncate font-medium text-[var(--gp-ink,#1f2329)]">{m.name}</span>
                  {editable && adjustContribution ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        aria-label={m.name}
                        className="gp-tabular w-20 rounded-[6px] border border-[var(--gp-border,#dee0e3)] bg-white px-2 py-0.5 text-right font-mono text-xs text-[var(--gp-ink,#1f2329)] outline-none focus:border-[var(--gp-action,#3370ff)]"
                        value={adjustShares[m.user_id] ?? String(m.share)}
                        onChange={(e) =>
                          setAdjustShares((prev) => ({ ...prev, [m.user_id]: e.target.value }))
                        }
                      />
                      <span>%</span>
                    </div>
                  ) : (
                    <span className="gp-tabular shrink-0 font-mono font-semibold text-[#1d4ed8]">
                      {m.share}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {decisions.length > 0 && (
        <div className={cn(feishuCard, "space-y-2")}>
          <div className="text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
            {tr("审核决策记录")}
          </div>
          {decisions.map((d) => (
            <div
              key={d.id}
              className="rounded-[8px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap justify-between gap-2 font-medium text-[var(--gp-ink,#1f2329)]">
                <span>
                  {d.actor_name} · {d.action}
                </span>
                <span className="gp-tabular text-[var(--gp-subtle,#8f959e)]">
                  {d.created_at.slice(0, 16)}
                </span>
              </div>
              <p className="mt-1 text-[var(--gp-ink-soft,#4e5969)]">{d.reason}</p>
            </div>
          ))}
        </div>
      )}

      {editable && (
        <div className={cn(feishuCard, "space-y-3 border-[#c7dafc] bg-[var(--gp-surface-subtle,#f8f9fa)]")}>
          <label className={feishuLabel} htmlFor="appeal-reason">
            {tr("裁决意见与结论说明")}
          </label>
          <textarea
            id="appeal-reason"
            rows={3}
            className={feishuInput}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tr("请说明裁决依据、要求补充的具体证据，或调权后的占比说明…")}
          />

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
            <input
              type="checkbox"
              className="accent-[#3370ff]"
              checked={adjustContribution}
              onChange={(e) => setAdjustContribution(e.target.checked)}
            />
            {tr("受理时同步调整上方贡献度占比并生成新冻结快照")}
          </label>

          {sharesInvalid && (
            <p
              role="status"
              className="gp-tabular text-xs font-medium text-[var(--gp-danger,#d93025)]"
            >
              {sharesHint}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!reason.trim() || submitting}
              onClick={() => handleAction("request_supplement")}
            >
              {tr("要求补充材料")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!reason.trim() || submitting}
              className="border-[#fecaca] bg-[#fef2f2] text-[#d93025] hover:bg-[#fee2e2] hover:text-[#b91c1c]"
              onClick={() => handleAction("reject")}
            >
              {tr("驳回申诉")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              loading={submitting}
              preserveWidth
              disabled={!reason.trim() || submitting || sharesInvalid}
              title={sharesInvalid ? sharesHint : undefined}
              onClick={() => handleAction("accept")}
            >
              {adjustContribution ? tr("接受并生成新快照") : tr("受理申诉")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
