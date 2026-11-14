"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type EvidenceRef = { id: string; version: number };
type Criterion = { criterion_id: string; text: string; evidence: EvidenceRef[]; covered?: boolean; result?: string; reason?: string; remediation?: string };
type Check = { id: string; total_criteria: number; covered_criteria: number; coverage_rate: number; status: string; checked_at: string | null; details: Criterion[] };
type Verification = { id: string; status: string; result: string; created_at: string | null; criteria: Criterion[] };
type HistoryRun = Verification & { invalidated_reason: string | null; formal_outcome_id: string | null; responsible_ids: string[]; decisions: { actor_id: string; decision: string; responsibility_share: number | null; reason: string }[] };

async function request<T>(url: string, method = "GET", payload?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: "include", cache: "no-store", headers: payload ? { "Content-Type": "application/json" } : undefined, body: payload ? JSON.stringify(payload) : undefined });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
  return body.data as T;
}

export function AcceptanceApiPage({ projectId, taskId, screen }: { projectId: string; taskId: string; screen: 16 | 17 }) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  const [check, setCheck] = useState<Check | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [reason, setReason] = useState("");
  const [share, setShare] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    const [nextCheck, nextVerification, nextHistory] = await Promise.all([
      request<Check | null>(`${base}/integrity-check`),
      request<Verification | null>(`${base}/verification`),
      request<HistoryRun[]>(`${base}/verification/history`),
    ]);
    setCheck(nextCheck); setVerification(nextVerification); setHistory(nextHistory);
  }, [base]);
  useEffect(() => { let active = true; void refresh().catch((failure) => { if (active) setError((failure as Error).message); }); return () => { active = false; }; }, [refresh]);
  async function run(path: string, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await request(`${base}/${path}`, "POST"); await refresh(); setNotice(message); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function decide(decision: "confirmed" | "rejected") {
    setBusy(true); setError(""); setNotice("");
    try {
      const value = share.trim() === "" ? null : Number(share);
      if (decision === "confirmed" && (value === null || !Number.isFinite(value))) throw new Error("请填写实际承担比例");
      const result = await request<{ status: string; share_total?: number }>(`${base}/verification/decision`, "POST", { decision, reason, responsibility_share: decision === "confirmed" ? value : null });
      await refresh(); setNotice(result.status === "shares_incomplete" ? `已记录确认；当前承担比例合计 ${result.share_total}%，请负责人调整至 100%。` : "人工决定已保存"); setReason("");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const taskHref = `/projects/${projectId}/tasks/${taskId}`;
  return <main className="mx-auto max-w-5xl space-y-5 p-6">
    <Link className="gp-link" href={taskHref}>返回任务详情</Link>
    {screen === 16 && <Link className="ml-4 gp-link" href={`${taskHref}/submit`}>返回提交草稿</Link>}
    <h1 className="text-2xl font-semibold">{screen === 16 ? "证据完整性检查" : "任务验收"}</h1>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded bg-green-50 p-3 text-green-700">{notice}</p>}
    {screen === 16 ? <>
      <section className="rounded border bg-white p-4"><p>覆盖率：{check ? `${check.covered_criteria}/${check.total_criteria}（${check.coverage_rate}%）` : "尚未检查"}</p><p className="text-sm text-slate-600">仅计入当前有效的正式证据；检查结果按次保存。</p><button className="mt-3 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" type="button" disabled={busy} onClick={() => void run("integrity-check", "检查快照已保存")}>重新检查</button></section>
      <section className="rounded border bg-white p-4"><h2 className="font-semibold">逐条标准</h2>{check?.details.map((item) => <article className="border-t py-3" key={item.criterion_id}><p>{item.text}</p><p>{item.covered ? "已有有效正式证据" : "缺少有效正式证据"}</p>{item.evidence.map((ref) => <Link className="mr-3 gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>查看证据（v{ref.version}）</Link>)}</article>)}{!check && <p>点击“重新检查”读取真实数据。</p>}</section>
      <div className="flex gap-3"><Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}`}>补充证据</Link><button className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" type="button" disabled={busy || check?.status !== "passed"} onClick={() => void run("enter-verification", "任务已进入待验收")}>进入验收</button><Link className="gp-link" href={`${taskHref}/verification`}>查看验收结果</Link></div>
    </> : <>
      <section className="rounded border bg-white p-4"><p>验收结果：{verification?.result ?? "尚未运行"}</p><p className="text-sm text-slate-600">AI 结果只作建议，不能代替负责人确认。CI、PR 合并等未取得可信状态时会标为待人工复核。</p><button className="mt-3 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" type="button" disabled={busy || check?.status !== "passed"} onClick={() => void run("verification", "已保存逐条验收建议")}>运行自动验收</button></section>
      <section className="rounded border bg-white p-4"><h2 className="font-semibold">逐条结果</h2>{verification?.criteria.map((item) => <article className="border-t py-3" key={item.criterion_id}><h3 className="font-medium">{item.text}</h3><p>判断：{item.result}</p><p>{item.reason}</p>{item.remediation && <p>{item.remediation}</p>}{item.evidence.map((ref) => <Link className="mr-3 gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>查看证据（v{ref.version}）</Link>)}</article>)}{!verification && <p>尚无验收运行记录。</p>}</section>
      {verification && <section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">负责人确认</h2><p className="text-sm text-slate-600">每位负责人填写自己的实际承担比例并确认；全部确认且比例合计 100% 后生成正式成果并完成任务。自动结果仅供参考。</p><label className="block text-sm">人工判断原因<textarea className="mt-1 block w-full rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} /></label><label className="block text-sm">我的实际承担比例（%）<input className="ml-2 w-24 rounded border p-2" type="number" min="0" max="100" step="0.0001" value={share} onChange={(event) => setShare(event.target.value)} /></label><div className="flex gap-3"><button className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50" disabled={busy || !reason.trim() || !share.trim() || Boolean(history[0]?.invalidated_reason) || Boolean(history[0]?.formal_outcome_id)} onClick={() => void decide("confirmed")}>确认验收结果</button><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={busy || !reason.trim() || Boolean(history[0]?.formal_outcome_id)} onClick={() => void decide("rejected")}>要求补充证据</button></div><Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}&capture=1`}>按任务补充证据</Link></section>}
      <section className="rounded border bg-white p-4"><h2 className="font-semibold">验收历史（最新在前）</h2>{history.map((entry) => <article className="border-t py-3 text-sm" key={entry.id}><p>{entry.created_at ? new Date(entry.created_at).toLocaleString("zh-CN") : "时间未知"} · {entry.result} · {entry.formal_outcome_id ? "正式成果" : entry.invalidated_reason ? `已失效：${entry.invalidated_reason}` : "待人工确认"}</p><p>负责人确认：{entry.decisions.length}/{entry.responsible_ids.length}</p>{entry.decisions.map((decision) => <p key={decision.actor_id}>{decision.actor_id}：{decision.decision === "confirmed" ? `确认（${decision.responsibility_share}%）` : "要求补充"} · {decision.reason}</p>)}{entry.criteria.map((criterion) => <p key={criterion.criterion_id}>{criterion.text}：{criterion.result} {criterion.evidence.map((ref) => <Link className="ml-2 gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>证据</Link>)}<Link className="ml-2 gp-link" href={`/projects/${projectId}/evidence?task=${taskId}&criterion=${criterion.criterion_id}&capture=1`}>补充此标准证据</Link></p>)}</article>)}{history.length === 0 && <p>尚无验收历史。</p>}</section>
    </>}
  </main>;
}
