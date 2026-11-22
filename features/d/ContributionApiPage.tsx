"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Award, Calculator, Lock } from "lucide-react";
import { Avatar, EmptyState, Feedback, PageHeader, ProgressBar, Section, Stat, StatusBadge } from "@/components/common";
import { button, secondary } from "@/features/b/ui";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";
import { ContributionWeek7Panel } from "./ContributionWeek7Panel";

type TaskCredit = { task_id: string; title: string; responsibility_share: number; weight: number; formal_outcome_id: string | null; evidence_url: string; evidence: { criterion_id: string; evidence_id: string; version: number }[] };
type Member = { user_id: string; name: string; share: number; task_credit: number; tasks: TaskCredit[] };
type Snapshot = { id: string; version: number; status?: string; frozen_at?: string | null; formula_version: string; calculated_at: string; stale: boolean; members: Member[] };

async function contributionRequest<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetchWithSession(new Request(new URL(apiConfig.baseUrl + url, window.location.origin), {
    method,
    credentials: "include",
    cache: "no-store",
  }));
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "读取贡献失败");
  return body.data as T;
}

export function ContributionApiPage({ projectId, memberId }: { projectId: string; memberId?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/contribution`;
  const refresh = useCallback(async () => {
    setSnapshot(await contributionRequest<Snapshot | null>(base));
  }, [base]);
  useEffect(() => { void refresh().catch((failure) => setError((failure as Error).message)); }, [refresh]);
  async function calculate() {
    setBusy(true); setError(""); setNotice("");
    try {
      await contributionRequest(`${base}/calculate`, "POST");
      await refresh();
      setNotice("已根据当前正式成果重新计算贡献草稿。");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function freeze() {
    setBusy(true); setError(""); setNotice("");
    try {
      await contributionRequest(`${base}/freeze`, "POST");
      await refresh();
      setNotice("贡献快照已确认冻结，可用于正式结项报告与项目归档。");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const selected = memberId ? snapshot?.members.find((item) => item.user_id === memberId) : null;
  const isFrozen = snapshot?.status === "frozen" && !snapshot.stale;

  return <div className="space-y-6">
    <PageHeader
      title={memberId ? "成员贡献详情" : "贡献总览"}
      description={memberId ? "查看成员在正式验收成果中的任务权重与证据明细。" : "基于已确认的正式成果与责任占比计算团队贡献，确认后冻结快照用于结项报告。"}
      actions={<div className="flex flex-wrap items-center gap-2">
        {memberId ? <Link className={secondary} href={`/projects/${projectId}/contribution`}>返回贡献总览</Link> : <Link className={secondary} href={`/projects/${projectId}`}>返回项目</Link>}
        {!memberId && (
          <button type="button" className={button} disabled={busy} onClick={() => void calculate()}><Calculator size={14} />按当前正式成果重新计算</button>
        )}
        {!memberId && snapshot && !snapshot.stale && snapshot.status !== "frozen" && (
          <button type="button" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-xs transition-all hover:bg-emerald-700 disabled:opacity-50" disabled={busy} onClick={() => void freeze()}><Lock size={14} />确认并冻结贡献快照</button>
        )}
      </div>}
    />

    {error && <div role="alert"><Feedback tone="error">{error}</Feedback></div>}
    {notice && <Feedback tone="success">{notice}</Feedback>}
    {snapshot?.stale && <Feedback tone="warning">正式成果或证据已变化；以下为历史计算快照，请重新计算当前贡献。</Feedback>}

    {snapshot && (
      <div className="gp-grid-4">
        <Stat label="快照状态" value={isFrozen ? `已冻结 (v${snapshot.version})` : `草稿 (v${snapshot.version})`} accent={isFrozen ? "#047857" : "#0369a1"} icon={Award} />
        <Stat label="参与成员" value={snapshot.members.length} sub="按正式验收成果计入" />
        <Stat label="计算模型" value="正式成果加权 v1" sub={snapshot.formula_version} />
        <Stat label="最近计算" value={new Date(snapshot.calculated_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} />
      </div>
    )}

    {isFrozen && !memberId && (
      <div className="gp-surface-card flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-sm text-slate-700">
          <StatusBadge tone="green" label={`已冻结（v${snapshot?.version}）`} />
          <span>贡献快照已锁定，可以生成并提交正式项目报告。</span>
        </div>
        <Link className={button} href={`/projects/${projectId}/reports`}>前往项目报告 →</Link>
      </div>
    )}

    {memberId ? (
      selected ? (
        <div className="space-y-6">
          <Section title={`${selected.name} · ${selected.share}%`} description={`正式任务权重积分：${selected.task_credit}`} surface>
            <div className="mb-4"><ProgressBar value={selected.share} /></div>
            <div className="divide-y divide-slate-100">
              {selected.tasks.map((task) => (
                <article className="space-y-2 py-3.5 first:pt-0 last:pb-0" key={task.task_id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
                    <span className="gp-pill">权重 {task.weight} · 承担 {task.responsibility_share}%</span>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <Link className="gp-link" href={task.evidence_url}>查看验收记录</Link>
                    {task.evidence.map((ref) => (
                      <span key={`${ref.criterion_id}:${ref.evidence_id}`} className="inline-flex items-center gap-2">
                        <Link className="gp-link" href={`/projects/${projectId}/evidence?evidence=${ref.evidence_id}`}>查看正式证据（v{ref.version}）</Link>
                        <Link className="text-slate-500 hover:text-slate-700 hover:underline" href={`/projects/${projectId}/evidence?task=${task.task_id}&criterion=${ref.criterion_id}&capture=1`}>按此标准补充证据</Link>
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </Section>
          <ContributionWeek7Panel projectId={projectId} memberId={memberId} tasks={selected.tasks} />
        </div>
      ) : snapshot ? <div className="gp-surface-card"><EmptyState title="此计算版本没有该成员的正式贡献" /></div> : null
    ) : (
      <Section title="成员贡献分布" surface>
        {snapshot?.members.length ? (
          <div className="divide-y divide-slate-100">
            {snapshot.members.map((member) => (
              <article className="space-y-2.5 py-4 first:pt-0 last:pb-0" key={member.user_id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={member.name} size={34} />
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{member.name}</div>
                      <div className="text-xs text-slate-500">正式任务权重积分：{member.task_credit} · 涉及 {member.tasks.length} 项任务</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-lg font-bold tabular-nums text-slate-900">{member.share}%</span>
                    <Link className="gp-link text-sm" href={`/projects/${projectId}/contribution/${member.user_id}`}>查看任务与证据</Link>
                  </div>
                </div>
                <ProgressBar value={member.share} />
              </article>
            ))}
          </div>
        ) : <EmptyState title={snapshot ? "暂无正式贡献" : "尚无正式贡献计算结果"} description="完成至少一项任务的人工验收确认后，点击上方“按当前正式成果重新计算”。" />}
      </Section>
    )}
  </div>;
}
