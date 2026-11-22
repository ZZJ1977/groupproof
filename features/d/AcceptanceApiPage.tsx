"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { EmptyState, Feedback, PageHeader, ProgressBar, Section, Stat, StatusBadge } from "@/components/common";
import { button, input, label, secondary } from "@/features/b/ui";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";
import { CApiError } from "@/lib/api/c-client";

type EvidenceRef = { id: string; version: number };
type Criterion = { criterion_id: string; text: string; evidence: EvidenceRef[]; covered?: boolean; result?: string; reason?: string; remediation?: string };
type Check = { id: string; total_criteria: number; covered_criteria: number; coverage_rate: number; status: string; checked_at: string | null; details: Criterion[] };
type Verification = { id: string; status: string; result: string; created_at: string | null; criteria: Criterion[] };
type HistoryRun = Verification & { invalidated_reason: string | null; formal_outcome_id: string | null; responsible_ids: string[]; decisions: { actor_id: string; decision: string; responsibility_share: number | null; reason: string }[] };

const resultMeta: Record<string, { label: string; tone: "green" | "amber" | "red" | "blue" | "gray" }> = {
  passed: { label: "通过", tone: "green" },
  partially_passed: { label: "部分通过", tone: "amber" },
  uncertain: { label: "待人工复核", tone: "amber" },
  failed: { label: "未通过", tone: "red" },
  pending: { label: "待运行", tone: "gray" },
};

async function request<T>(url: string, method = "GET", payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithSession(new Request(new URL(apiConfig.baseUrl + url, window.location.origin), {
    method, credentials: "include", cache: "no-store", signal,
    headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  }));
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !Object.hasOwn(body, "data")) {
    throw new CApiError(response.status, body?.error?.code ?? "INVALID_API_RESPONSE", body?.error?.message ?? "无法读取验收数据，请重试。", response.headers.get("X-Request-Id"));
  }
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
  const controller = useRef<AbortController | null>(null);
  const reportFailure = useCallback((failure: unknown, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    if (failure instanceof CApiError && [401, 403, 404].includes(failure.status)) {
      setCheck(null); setVerification(null); setHistory([]);
    }
    setError(failure instanceof Error ? failure.message : "请求失败，请重试。");
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [nextCheck, nextVerification, nextHistory] = await Promise.all([
      request<Check | null>(`${base}/integrity-check`, "GET", undefined, signal),
      request<Verification | null>(`${base}/verification`, "GET", undefined, signal),
      request<HistoryRun[]>(`${base}/verification/history`, "GET", undefined, signal),
    ]);
    if (signal?.aborted) return;
    setCheck(nextCheck); setVerification(nextVerification); setHistory(nextHistory);
  }, [base]);
  useEffect(() => {
    const next = new AbortController(); controller.current = next;
    setCheck(null); setVerification(null); setHistory([]); setReason(""); setShare(""); setError(""); setNotice(""); setBusy(false);
    void refresh(next.signal).catch((failure) => reportFailure(failure, next.signal));
    return () => next.abort();
  }, [refresh, reportFailure]);
  async function retryRead() {
    const signal = controller.current?.signal;
    setBusy(true); setError("");
    try { await refresh(signal); }
    catch (failure) { reportFailure(failure, signal); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function run(path: string, message: string) {
    const signal = controller.current?.signal;
    setBusy(true); setError(""); setNotice("");
    try { await request(`${base}/${path}`, "POST", undefined, signal); await refresh(signal); if (!signal?.aborted) setNotice(message); }
    catch (failure) { reportFailure(failure, signal); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function decide(decision: "confirmed" | "rejected") {
    const signal = controller.current?.signal;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = share.trim() === "" ? null : Number(share);
      if (decision === "confirmed" && (value === null || !Number.isFinite(value))) throw new Error("请填写实际承担比例");
      const result = await request<{ status: string; share_total?: number }>(`${base}/verification/decision`, "POST", { decision, reason, responsibility_share: decision === "confirmed" ? value : null }, signal);
      await refresh(signal); if (!signal?.aborted) { setNotice(result.status === "shares_incomplete" ? `已记录确认；当前承担比例合计 ${result.share_total}%，请负责人调整至 100%。` : "人工决定已保存"); setReason(""); }
    } catch (failure) { reportFailure(failure, signal); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  const taskHref = `/projects/${projectId}/tasks/${taskId}`;
  const vMeta = verification ? (resultMeta[verification.result] ?? { label: verification.result, tone: "gray" as const }) : null;
  const formalDone = Boolean(history[0]?.formal_outcome_id);

  return <div className="space-y-6">
    <PageHeader
      title={screen === 16 ? "证据完整性检查" : "任务验收"}
      description={screen === 16 ? "核验每条验收标准是否均已关联有效正式证据。" : "运行 AI 逐条验收建议并由任务负责人完成人工确认与责任分配。"}
      actions={<div className="flex flex-wrap items-center gap-2">
        <Link className={secondary} href={taskHref}>返回任务详情</Link>
        {screen === 16 && <Link className={secondary} href={`${taskHref}/submit`}>返回提交草稿</Link>}
        <button className={secondary} type="button" disabled={busy} onClick={() => void retryRead()}><RefreshCw size={14} />刷新验收数据</button>
      </div>}
    />

    <div className="gp-segmented" role="navigation" aria-label="验收步骤">
      <Link className="gp-segmented-item" data-active={screen === 16 ? "true" : undefined} href={`${taskHref}/evidence-check`}>1. 证据完整性检查</Link>
      <Link className="gp-segmented-item" data-active={screen === 17 ? "true" : undefined} href={`${taskHref}/verification`}>2. 自动验收与人工确认</Link>
    </div>

    {error && <div role="alert"><Feedback tone="error">{error}</Feedback></div>}
    {notice && <Feedback tone="success">{notice}</Feedback>}

    {screen === 16 ? <>
      <div className="gp-grid-3">
        <Stat label="标准覆盖率" value={check ? `${check.coverage_rate}%` : "—"} sub={check ? `${check.covered_criteria} / ${check.total_criteria} 条已覆盖` : "尚未检查"} icon={CheckCircle2} />
        <Stat label="检查结论" value={check ? (check.status === "passed" ? "完整" : "待补充") : "未检查"} accent={check?.status === "passed" ? "#047857" : "#b45309"} />
        <Stat label="最近检查" value={check?.checked_at ? check.checked_at.slice(5, 16).replace("T", " ") : "—"} />
      </div>

      <Section title="完整性核验" surface action={<div className="flex flex-wrap gap-2">
        <button className={secondary} type="button" disabled={busy} onClick={() => void run("integrity-check", "检查快照已保存")}>重新检查</button>
        <button className={button} type="button" disabled={busy || check?.status !== "passed"} onClick={() => void run("enter-verification", "任务已进入待验收")}>进入验收</button>
      </div>}>
        <p className="text-sm text-slate-600">覆盖率：{check ? `${check.covered_criteria}/${check.total_criteria}（${check.coverage_rate}%）` : "尚未检查"}。仅计入当前有效的正式证据。</p>
        {check && <div className="mt-3"><ProgressBar value={check.coverage_rate} /></div>}
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
          <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}`}>补充证据</Link>
          <Link className="gp-link" href={`${taskHref}/verification`}>查看验收结果</Link>
        </div>
      </Section>

      <Section title="逐条标准" surface>
        {check?.details.length ? (
          <div className="divide-y divide-slate-100">
            {check.details.map((item) => (
              <article className="flex flex-wrap items-start justify-between gap-3 py-3.5 first:pt-0 last:pb-0" key={item.criterion_id}>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium text-slate-900">{item.text}</p>
                  <div className="flex flex-wrap gap-3 text-xs">
                    {item.evidence.map((ref) => <Link className="gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>查看证据（v{ref.version}）</Link>)}
                  </div>
                </div>
                <StatusBadge tone={item.covered ? "green" : "amber"} label={item.covered ? "已有有效正式证据" : "缺少有效正式证据"} />
              </article>
            ))}
          </div>
        ) : <EmptyState title="尚未执行检查" description="点击“重新检查”核验当前有效正式证据。" />}
      </Section>
    </> : <>
      <div className="gp-grid-3">
        <Stat label="自动验收建议" value={vMeta?.label ?? "尚未运行"} icon={ShieldCheck} accent={vMeta?.tone === "green" ? "#047857" : vMeta?.tone === "red" ? "#be123c" : "#0369a1"} />
        <Stat label="正式成果" value={formalDone ? "已确认完成" : "待负责人确认"} accent={formalDone ? "#047857" : "#b45309"} />
        <Stat label="验收记录" value={history.length} sub="按时间倒序保存" />
      </div>

      <Section title="自动验收建议" description="AI 结果仅作建议，不能替代负责人确认。" surface action={<button className={button} type="button" disabled={busy || check?.status !== "passed"} onClick={() => void run("verification", "已保存逐条验收建议")}>运行自动验收</button>}>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
          <span>验收结果：</span>
          {vMeta ? <StatusBadge tone={vMeta.tone} label={vMeta.label} /> : <span className="text-slate-500">尚未运行</span>}
          {formalDone && <Link className="gp-link ml-auto" href={`/projects/${projectId}/contribution`}>前往贡献总览 →</Link>}
        </div>
      </Section>

      <Section title="逐条结果" surface>
        {verification?.criteria.length ? (
          <div className="divide-y divide-slate-100">
            {verification.criteria.map((item) => {
              const cm = item.result ? (resultMeta[item.result] ?? { label: item.result, tone: "gray" as const }) : null;
              return (
                <article className="space-y-1.5 py-3.5 first:pt-0 last:pb-0" key={item.criterion_id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{item.text}</h3>
                    {cm && <StatusBadge tone={cm.tone} label={`判断：${cm.label}`} />}
                  </div>
                  {item.reason && <p className="text-sm text-slate-600">{item.reason}</p>}
                  {item.remediation && <p className="text-xs text-amber-800">整改建议：{item.remediation}</p>}
                  <div className="flex flex-wrap gap-3 text-xs">
                    {item.evidence.map((ref) => <Link className="gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>查看证据（v{ref.version}）</Link>)}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <EmptyState title="尚无验收运行记录" description="确认证据完整后点击“运行自动验收”。" />}
      </Section>

      {verification && (
        <Section title="负责人确认" description="每位负责人填写实际承担比例并确认；全部确认且合计 100% 后生成正式成果并完成任务。" surface>
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_200px]">
              <div>
                <label className={label} htmlFor="accept-reason">人工判断原因</label>
                <textarea id="accept-reason" className={input} rows={2} placeholder="说明核查结论与依据" value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
              <div>
                <label className={label} htmlFor="accept-share">我的实际承担比例（%）</label>
                <input id="accept-share" className={input} type="number" min="0" max="100" step="0.0001" placeholder="例如 100" value={share} onChange={(event) => setShare(event.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={button} disabled={busy || !reason.trim() || !share.trim() || Boolean(history[0]?.invalidated_reason) || formalDone} onClick={() => void decide("confirmed")}>确认验收结果</button>
              <button type="button" className={secondary} disabled={busy || !reason.trim() || formalDone} onClick={() => void decide("rejected")}>要求补充证据</button>
              <Link className="gp-link ml-auto text-sm" href={`/projects/${projectId}/evidence?task=${taskId}&capture=1`}>按任务补充证据</Link>
            </div>
          </div>
        </Section>
      )}

      <Section title="验收历史（最新在前）" surface>
        {history.length ? (
          <div className="divide-y divide-slate-100 text-sm">
            {history.map((entry) => (
              <article className="space-y-2 py-3.5 first:pt-0 last:pb-0" key={entry.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{entry.created_at ? new Date(entry.created_at).toLocaleString("zh-CN") : "时间未知"}</span>
                  <StatusBadge tone={entry.formal_outcome_id ? "green" : entry.invalidated_reason ? "red" : "amber"} label={entry.formal_outcome_id ? "正式成果" : entry.invalidated_reason ? `已失效：${entry.invalidated_reason}` : "待人工确认"} />
                  <span className="text-xs text-slate-500">负责人确认：{entry.decisions.length}/{entry.responsible_ids.length}</span>
                </div>
                {entry.decisions.map((decision) => <p className="text-xs text-slate-600" key={decision.actor_id}>{decision.actor_id}：{decision.decision === "confirmed" ? `确认（${decision.responsibility_share}%）` : "要求补充"} · {decision.reason}</p>)}
                <div className="space-y-1 text-xs text-slate-600">
                  {entry.criteria.map((criterion) => <p key={criterion.criterion_id}>{criterion.text}：{resultMeta[criterion.result ?? ""]?.label ?? criterion.result} {criterion.evidence.map((ref) => <Link className="ml-2 gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>证据</Link>)}<Link className="ml-2 gp-link" href={`/projects/${projectId}/evidence?task=${taskId}&criterion=${criterion.criterion_id}&capture=1`}>补充此标准证据</Link></p>)}
                </div>
              </article>
            ))}
          </div>
        ) : <p className="text-sm text-slate-500">尚无验收历史。</p>}
      </Section>
    </>}
  </div>;
}
