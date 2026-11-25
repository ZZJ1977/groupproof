"use client";

import { useState } from "react";
import Link from "next/link";
import type { UseQueryResult } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, FileCode2 } from "lucide-react";
import { Feedback, Panel, StatusBadge } from "@/components/common";
import { bTasksApi } from "@/lib/api/b-tasks";
import type { CriterionRecheck } from "@/lib/api/c-criterion-rechecks";
import type { components } from "@/packages/domain/api.generated";
import { apiButton, projectApi, safeHttps } from "./c-project-api";

type EvidenceItem = components["schemas"]["EvidenceDTO"];

type Props = {
  projectId: string;
  taskId: string;
  taskStatus: string;
  actorId: string;
  canLeadOrTeach: boolean;
  isLeader?: boolean;
  isResponsible: boolean;
  canCaptureEvidence: boolean;
  criteria: { id: string; text: string }[];
  requirements: { id: string; title: string }[];
  rechecks?: UseQueryResult<CriterionRecheck[]>;
  evidences: EvidenceItem[];
  onChanged: () => Promise<void>;
};

export function TaskCriteriaPanel({
  projectId,
  taskId,
  taskStatus,
  actorId,
  canLeadOrTeach,
  isLeader = false,
  isResponsible,
  canCaptureEvidence,
  criteria,
  requirements,
  rechecks,
  evidences,
  onChanged,
}: Props) {
  const canConfirmComplete = isResponsible || isLeader;
  const current = rechecks?.isSuccess && !rechecks.isFetching ? rechecks.data : [];
  const byCriterion = new Map(current.map((row) => [row.criterion_id, row]));
  const titles = new Map(requirements.map((requirement) => [requirement.id, requirement.title]));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);

  const activeEvidences = evidences.filter((ev) => !ev.source_changed && ["candidate", "pending_confirmation", "formal"].includes(ev.status));
  const evidenceByCriterion = new Map<string, EvidenceItem[]>();
  for (const ev of activeEvidences) {
    for (const cid of ev.criterion_ids) {
      evidenceByCriterion.set(cid, [...(evidenceByCriterion.get(cid) ?? []), ev]);
    }
  }

  const confirmedCount = criteria.filter((c) => (evidenceByCriterion.get(c.id) ?? []).some((ev) => ev.effective)).length;
  const evidencedCount = criteria.filter((c) => (evidenceByCriterion.get(c.id) ?? []).length > 0).length;
  const allConfirmed = criteria.length > 0 && confirmedCount === criteria.length;
  const allAiPassed = criteria.length > 0 && evidencedCount === criteria.length;
  const partialAiPassed = criteria.length > 0 && evidencedCount > 0 && evidencedCount < criteria.length;

  const canAdopt = (ev: EvidenceItem) =>
    canCaptureEvidence && !ev.source_changed && ["candidate", "pending_confirmation"].includes(ev.status) && (ev.author_id === actorId || canLeadOrTeach);
  const adoptableEvidences = activeEvidences.filter((ev) => canAdopt(ev));

  async function adoptAllEvidences() {
    if (busyId !== null || adoptableEvidences.length === 0) return;
    setBusyId("adopt-all");
    setNotice(null);
    try {
      const items = adoptableEvidences.map((ev) => ({
        evidence_id: ev.id,
        expected_version: ev.lock_version,
      }));
      const idempotencyKey = `adopt-crit-batch-${taskId}-${items.length}-${Date.now()}`;
      const res = await projectApi.batchAdopt(
        projectId,
        {
          items,
          reason: "核对代码改动符合对应交付标准，批量确认采纳为正式证据。",
        },
        idempotencyKey,
      );
      await onChanged();
      setNotice({
        tone: "success",
        text: `已批量采纳 ${res.count} 条正式证据；若全部交付标准均已确认达标，可直接点击「全部标准达标 · 提交并完成任务」。`,
      });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "批量采纳证据失败，请刷新后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  async function adoptEvidence(ev: EvidenceItem) {
    setBusyId(ev.id);
    setNotice(null);
    try {
      const idempotencyKey = `adopt-crit-${ev.id}-v${ev.lock_version}-${Date.now()}`;
      await projectApi.adopt(
        projectId,
        ev.id,
        { expected_version: ev.lock_version, reason: "核对代码改动符合对应交付标准，确认采纳为正式证据。" },
        idempotencyKey,
      );
      await onChanged();
      setNotice({ tone: "success", text: `已采纳代码证据「${ev.title}」为正式证据，对应交付标准已确认达标。` });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "采纳证据失败，请刷新后重试。" });
    } finally {
      setBusyId(null);
    }
  }

  async function completeTask(autoAdoptCandidates = false) {
    setBusyId("complete-task");
    setNotice(null);
    try {
      const res = await bTasksApi.completeByCriteria(
        projectId,
        taskId,
        autoAdoptCandidates
          ? "核对 AI 验收结果与代码实现说明无误，一键确认采纳候选证据并完成任务。"
          : "全部交付标准均已核对真实代码证据并确认达标，确认完成任务。",
        autoAdoptCandidates,
      );
      await onChanged();
      setNotice({
        tone: "success",
        text: res.task_status === "completed"
          ? "已确认 AI 验收结果并完成正式验收，任务状态已更新为「已完成（100%）」。"
          : "已记录你的验收确认，等待其余任务负责人完成确认后正式办结。",
      });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "完成确认失败，请检查是否所有标准均已覆盖有效证据。" });
    } finally {
      setBusyId(null);
    }
  }

  return <Panel
    title="AI 自动验收结果与交付标准"
    action={<Link className="gp-link text-xs" href={`/projects/${projectId}/tasks?view=plan&task=${taskId}`}>在分工与规划中查看/修改标准 →</Link>}
  >
    {criteria.length > 0 && (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-600">
          <span>共 <strong className="text-slate-900">{criteria.length}</strong> 条交付标准</span>
          <span>·</span>
          <span>AI 核验通过 <strong className="text-sky-700">{evidencedCount}/{criteria.length}</strong> 条</span>
          <span>·</span>
          <span>已人工确认正式 <strong className="text-emerald-700">{confirmedCount}/{criteria.length}</strong> 条</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {adoptableEvidences.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-50 disabled:opacity-50"
              disabled={busyId !== null}
              onClick={() => void adoptAllEvidences()}
            >
              <CheckCircle2 size={13} />
              {busyId === "adopt-all" ? "正在批量采纳…" : `仅批量采纳证据 (${adoptableEvidences.length})`}
            </button>
          )}
          <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}`}>在证据中心查看全部证据 →</Link>
        </div>
      </div>
    )}

    {taskStatus === "completed" && criteria.length > 0 && (
      <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5 text-sm text-emerald-900">
        <p className="font-semibold">正式验收已通过（{confirmedCount}/{criteria.length}）· 任务已完成（100%）</p>
        <p className="mt-0.5 text-xs text-emerald-700">全部交付标准均已由真实代码证据核验并完成人工确认。</p>
      </div>
    )}

    {allAiPassed && taskStatus !== "completed" && (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5">
        <div className="text-sm text-emerald-900">
          <p className="font-semibold">
            {allConfirmed
              ? `全部 ${criteria.length}/${criteria.length} 条交付标准已由正式证据确认达标`
              : `AI 自动验收结果：全部通过（${evidencedCount}/${criteria.length} 条标准已由代码实现覆盖）`}
          </p>
          <p className="mt-0.5 text-xs text-emerald-700">
            {canConfirmComplete
              ? isResponsible
                ? allConfirmed
                  ? "点击右侧按钮将自动完成完整性核验与验收记录，并将本任务标记为「已完成（100%）」。"
                  : "AI 已完成逐条核验并生成下方实现说明，无需逐条点采纳，核对无误后点击右侧按钮即可一键确认并完成任务。"
                : "AI 已核验全部交付标准达标，作为项目组长可直接一键确认完成任务（贡献仍归属任务负责人）。"
              : "AI 已核验全部交付标准达标，等待本任务负责人或项目组长一键确认完成任务。"}
          </p>
        </div>
        {canConfirmComplete && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-2xs transition hover:bg-emerald-700 disabled:opacity-50"
            disabled={busyId !== null}
            onClick={() => void completeTask(!allConfirmed)}
          >
            <CheckCircle2 size={15} />
            {busyId === "complete-task"
              ? "正在确认完成…"
              : allConfirmed
                ? "全部标准达标 · 提交并完成任务"
                : "确认 AI 验收并完成任务"}
          </button>
        )}
      </div>
    )}

    {partialAiPassed && taskStatus !== "completed" && (
      <div className="mb-4">
        <Feedback tone="warning">
          AI 自动验收结果：部分通过（已通过 {evidencedCount}/{criteria.length} 条，尚缺 {criteria.length - evidencedCount} 条代码证据）。请查看下方标记「AI 未通过 · 缺证据」的标准并补充代码提交或证据。
        </Feedback>
      </div>
    )}

    {!allAiPassed && !partialAiPassed && taskStatus !== "completed" && criteria.length > 0 && (
      <div className="mb-4">
        <Feedback tone="info">
          AI 自动验收结果：待补充（尚未匹配到覆盖交付标准的代码提交）。提交对应代码后会自动归集并展示验收结果，也可在下方手动补充证据。
        </Feedback>
      </div>
    )}

    {notice && <div className="mb-3"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}

    {criteria.length === 0 && <p>暂无验收标准。</p>}
    <ul className="space-y-2">{criteria.map((criterion) => {
      const row = byCriterion.get(criterion.id);
      const linked = evidenceByCriterion.get(criterion.id) ?? [];
      const confirmed = linked.some((ev) => ev.effective);
      return <li key={criterion.id} className="rounded-xl border border-slate-200/75 bg-white p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-sm font-medium text-slate-900">{criterion.text}</p>
          {confirmed ? <StatusBadge tone="green" label="已正式确认通过" />
            : linked.length > 0 ? <StatusBadge tone="blue" label="AI 验收通过 · 待确认" />
            : <StatusBadge tone="gray" label="AI 未通过 · 缺证据" />}
        </div>

        {linked.length > 0 && (
          <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
            {linked.map((ev) => {
              const url = safeHttps(ev.source_url, ev.source_type === "github");
              const lines = (ev.description ?? "").split(/\r?\n/).filter((line) => line.trim());
              const leadLine = lines.find((line) => line.startsWith("实现内容：") || line.startsWith("AI 代码实现分析：")) ?? lines[0];
              const extraLines = lines.filter((line) => line !== leadLine);
              const leadColonIdx = leadLine ? leadLine.indexOf("：") : -1;
              return <div key={ev.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <FileCode2 size={13} className="shrink-0 text-sky-600" />
                    <Link className="font-medium text-slate-800 hover:underline" href={`/projects/${projectId}/evidence?evidence=${ev.id}`}>{ev.title}</Link>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ev.effective ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {ev.effective ? "正式证据" : "候选代码证据"}
                    </span>
                    {url && <a className="inline-flex items-center gap-0.5 text-sky-700 hover:underline" href={url} target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={11} /></a>}
                  </div>
                  {leadLine && (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-700">
                      {leadColonIdx > 0 ? (
                        <>
                          <strong className="font-semibold text-slate-800">{leadLine.slice(0, leadColonIdx + 1)}</strong>
                          {leadLine.slice(leadColonIdx + 1)}
                        </>
                      ) : leadLine}
                    </p>
                  )}
                  {extraLines.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-[11px] font-medium text-slate-500 hover:text-slate-700">展开完整 AI 分析</summary>
                      <div className="mt-1 space-y-1 border-t border-slate-200/70 pt-1">
                        {extraLines.map((line, lineIdx) => {
                          const isDetail = line.startsWith("实现内容：") || line.startsWith("AI 代码实现分析：") || line.startsWith("影响范围：") || line.startsWith("验证说明：");
                          const colonIdx = line.indexOf("：");
                          return isDetail && colonIdx > 0 ? (
                            <p key={lineIdx} className="text-xs leading-5 text-slate-700">
                              <strong className="font-semibold text-slate-800">{line.slice(0, colonIdx + 1)}</strong>
                              {line.slice(colonIdx + 1)}
                            </p>
                          ) : (
                            <p key={lineIdx} className="text-[11px] leading-4 text-slate-500">{line}</p>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
                {canAdopt(ev) && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-sky-200 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
                    disabled={busyId !== null}
                    onClick={() => void adoptEvidence(ev)}
                  >
                    {busyId === ev.id ? "确认中…" : "确认采纳此证据"}
                  </button>
                )}
              </div>;
            })}
          </div>
        )}

        {row && <div className="mt-2 border-l-2 border-amber-500 pl-3 text-sm">
          <strong>需要重新检查</strong>
          <p>{titles.get(row.requirement_id) ?? "关联需求"} · 需求版本 {row.requirement_version_no}</p>
          {row.reason && <p>{row.reason}</p>}
          <p>{row.verification_notified ? "已通知验收方" : "待通知验收方"}</p>
        </div>}
      </li>;
    })}</ul>
    {rechecks?.isFetching && <p role="status">正在读取复核记录…</p>}
    {rechecks?.isError && <div role="alert"><p>暂时无法读取验收标准的复核状态。</p>
      <button className={apiButton} onClick={() => void rechecks.refetch()}>重试复核记录</button>
    </div>}
  </Panel>;
}
