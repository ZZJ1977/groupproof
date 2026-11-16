"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type TaskCredit = { task_id: string; title: string; responsibility_share: number; weight: number; formal_outcome_id: string | null; evidence_url: string; evidence: { criterion_id: string; evidence_id: string; version: number }[] };
type Member = { user_id: string; name: string; share: number; task_credit: number; tasks: TaskCredit[] };
type Snapshot = { id: string; version: number; formula_version: string; calculated_at: string; stale: boolean; members: Member[] };

export function ContributionApiPage({ projectId, memberId }: { projectId: string; memberId?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/contribution`;
  const refresh = useCallback(async () => {
    const response = await fetch(base, { credentials: "include", cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "读取贡献失败");
    setSnapshot(body.data as Snapshot | null);
  }, [base]);
  useEffect(() => { void refresh().catch((failure) => setError((failure as Error).message)); }, [refresh]);
  async function calculate() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base}/calculate`, { method: "POST", credentials: "include" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "计算失败");
      await refresh();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const selected = memberId ? snapshot?.members.find((item) => item.user_id === memberId) : null;
  return <main className="mx-auto max-w-5xl space-y-5 p-6">
    <Link className="gp-link" href={`/projects/${projectId}`}>返回项目</Link>
    <h1 className="text-2xl font-semibold">{memberId ? "成员贡献详情" : "贡献总览"}</h1>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
    {!memberId && <button className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" disabled={busy} onClick={() => void calculate()}>按当前正式成果重新计算</button>}
    {snapshot ? <p className="text-sm text-slate-600">计算时间：{new Date(snapshot.calculated_at).toLocaleString("zh-CN")} · 版本 {snapshot.version} · 公式 {snapshot.formula_version}</p> : <p>尚无正式贡献计算结果。</p>}
    {snapshot?.stale && <p role="status" className="rounded bg-amber-50 p-3 text-amber-800">正式成果或证据已变化；以下为历史计算快照，请重新计算当前贡献。</p>}
    {memberId ? <>
      <Link className="gp-link" href={`/projects/${projectId}/contribution`}>返回贡献总览</Link>
      {selected ? <section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">{selected.name} · {selected.share}%</h2><p>正式任务权重积分：{selected.task_credit}</p>{selected.tasks.map((task) => <article className="border-t py-3" key={task.task_id}><p>{task.title} · 任务权重 {task.weight} · 实际承担 {task.responsibility_share}%</p><Link className="gp-link" href={task.evidence_url}>查看验收记录</Link>{task.evidence.map((ref) => <p key={`${ref.criterion_id}:${ref.evidence_id}`}><Link className="gp-link" href={`/projects/${projectId}/evidence?evidence=${ref.evidence_id}`}>查看正式证据（v{ref.version}）</Link><Link className="ml-3 gp-link" href={`/projects/${projectId}/evidence?task=${task.task_id}&criterion=${ref.criterion_id}&capture=1`}>按此标准补充证据</Link></p>)}</article>)}</section> : snapshot && <p>此计算版本没有该成员的正式贡献。</p>}
    </> : <section className="space-y-3 rounded border bg-white p-4">{snapshot?.members.map((member) => <article className="border-t py-3" key={member.user_id}><div className="flex items-center justify-between"><span>{member.name}</span><strong>{member.share}%</strong></div><div className="mt-2 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-blue-600" style={{ width: `${member.share}%` }} /></div><p className="text-sm">正式任务权重积分：{member.task_credit}</p><Link className="gp-link" href={`/projects/${projectId}/contribution/${member.user_id}`}>查看任务与证据</Link></article>)}{snapshot?.members.length === 0 && <p>暂无正式贡献。</p>}</section>}
  </main>;
}
