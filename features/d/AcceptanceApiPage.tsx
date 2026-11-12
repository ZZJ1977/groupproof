"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type EvidenceRef = { id: string; version: number };
type Criterion = { criterion_id: string; text: string; evidence: EvidenceRef[]; covered?: boolean; result?: string; reason?: string; remediation?: string };
type Check = { id: string; total_criteria: number; covered_criteria: number; coverage_rate: number; status: string; checked_at: string | null; details: Criterion[] };
type Verification = { id: string; status: string; result: string; created_at: string | null; criteria: Criterion[] };

async function request<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, credentials: "include", cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
  return body.data as T;
}

export function AcceptanceApiPage({ projectId, taskId, screen }: { projectId: string; taskId: string; screen: 16 | 17 }) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  const [check, setCheck] = useState<Check | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    const [nextCheck, nextVerification] = await Promise.all([
      request<Check | null>(`${base}/integrity-check`),
      request<Verification | null>(`${base}/verification`),
    ]);
    setCheck(nextCheck); setVerification(nextVerification);
  }, [base]);
  useEffect(() => { let active = true; void refresh().catch((failure) => { if (active) setError((failure as Error).message); }); return () => { active = false; }; }, [refresh]);
  async function run(path: string, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await request(`${base}/${path}`, "POST"); await refresh(); setNotice(message); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const taskHref = `/projects/${projectId}/tasks/${taskId}`;
  return <main className="mx-auto max-w-5xl space-y-5 p-6">
    <Link className="gp-link" href={taskHref}>返回任务详情</Link>
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
    </>}
  </main>;
}
