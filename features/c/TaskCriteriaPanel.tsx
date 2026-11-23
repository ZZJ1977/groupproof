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
  isResponsible: boolean;
  canCaptureEvidence: boolean;
  criteria: { id: string; text: string }[];
  requirements: { id: string; title: string }[];
  rechecks: UseQueryResult<CriterionRecheck[]>;
  evidences: EvidenceItem[];
  onChanged: () => Promise<void>;
};

export function TaskCriteriaPanel({
  projectId,
  taskId,
  taskStatus,
  actorId,
  canLeadOrTeach,
  isResponsible,
  canCaptureEvidence,
  criteria,
  requirements,
  rechecks,
  evidences,
  onChanged,
}: Props) {
  const current = rechecks.isSuccess && !rechecks.isFetching ? rechecks.data : [];
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

  const canAdopt = (ev: EvidenceItem) =>
    canCaptureEvidence && !ev.source_changed && ["candidate", "pending_confirmation"].includes(ev.status) && (ev.author_id === actorId || canLeadOrTeach);

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

  async function completeTask() {
    setBusyId("complete-task");
    setNotice(null);
    try {
      const res = await bTasksApi.completeByCriteria(projectId, taskId, "全部交付标准均已核对真实代码证据并确认达标，确认完成任务。");
      await onChanged();
      setNotice({
        tone: "success",
        text: res.task_status === "completed"
          ? "全部交付标准已通过验收并确认，任务状态已更新为「已完成（100%）」。"
          : "已记录你的验收确认，等待其余任务负责人完成确认后正式办结。",
      });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "完成确认失败，请检查是否所有标准均已采纳正式证据。" });
    } finally {
      setBusyId(null);
    }
  }

  return <Panel
    title="当前验收标准"
    action={<Link className="gp-link text-xs" href={`/projects/${projectId}/tasks?view=plan&task=${taskId}`}>在分工与规划中查看/修改标准 →</Link>}
  >
    {criteria.length > 0 && (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-600">
          <span>共 <strong className="text-slate-900">{criteria.length}</strong> 条交付标准</span>
          <span>·</span>
          <span>已有代码证据 <strong className="text-sky-700">{evidencedCount}</strong> 条</span>
          <span>·</span>
          <span>已人工确认 <strong className="text-emerald-700">{confirmedCount}</strong> 条</span>
        </div>
        <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}`}>在证据中心查看全部证据 →</Link>
      </div>
    )}

    {allConfirmed && taskStatus !== "completed" && isResponsible && (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3">
        <div className="text-sm text-emerald-900">
          <p className="font-semibold">全部 {criteria.length}/{criteria.length} 条交付标准已由正式代码证据确认达标</p>
          <p className="mt-0.5 text-xs text-emerald-700">点击右侧按钮将自动完成完整性核验与验收记录，并将本任务标记为「已完成（100%）」。</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-2xs transition hover:bg-emerald-700 disabled:opacity-50"
          disabled={busyId !== null}
          onClick={() => void completeTask()}
        >
          <CheckCircle2 size={15} />
          {busyId === "complete-task" ? "正在完成验收…" : "全部标准达标 · 确认完成任务"}
        </button>
      </div>
    )}

    {notice && <div className="mb-3"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}

    {criteria.length === 0 && <p>暂无验收标准。</p>}
    <ul className="space-y-3">{criteria.map((criterion) => {
      const row = byCriterion.get(criterion.id);
      const linked = evidenceByCriterion.get(criterion.id) ?? [];
      const confirmed = linked.some((ev) => ev.effective);
      return <li key={criterion.id} className="rounded-xl border border-slate-200/75 bg-white p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-sm font-medium text-slate-900">{criterion.text}</p>
          {confirmed ? <StatusBadge tone="green" label="已确认达标" />
            : linked.length > 0 ? <StatusBadge tone="blue" label="代码已覆盖 · 待确认" />
            : <StatusBadge tone="gray" label="暂无代码证据" />}
        </div>

        {linked.length > 0 && (
          <div className="mt-2.5 space-y-2 border-t border-slate-100 pt-2.5">
            {linked.map((ev) => {
              const url = safeHttps(ev.source_url, ev.source_type === "github");
              return <div key={ev.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <FileCode2 size={13} className="shrink-0 text-sky-600" />
                    <Link className="font-medium text-slate-800 hover:underline" href={`/projects/${projectId}/evidence?evidence=${ev.id}`}>{ev.title}</Link>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ev.effective ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {ev.effective ? "正式证据" : "候选代码证据"}
                    </span>
                    {url && <a className="inline-flex items-center gap-0.5 text-sky-700 hover:underline" href={url} target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={11} /></a>}
                  </div>
                  {ev.description && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] text-slate-500">{ev.description}</p>}
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
    {rechecks.isFetching && <p role="status">正在读取复核记录…</p>}
    {rechecks.isError && <div role="alert"><p>暂时无法读取验收标准的复核状态。</p>
      <button className={apiButton} onClick={() => void rechecks.refetch()}>重试复核记录</button>
    </div>}
  </Panel>;
}
