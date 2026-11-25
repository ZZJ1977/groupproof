"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, RefreshCw, ShieldCheck } from "lucide-react";
import { Feedback, ProgressBar, StatusBadge } from "@/components/common";
import { button, input, label, secondary } from "@/features/b/ui";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";
import { CApiError } from "@/lib/api/c-client";

type EvidenceRef = { id: string; version: number };
type Criterion = {
  criterion_id: string;
  text: string;
  evidence: EvidenceRef[];
  covered?: boolean;
  result?: string;
  reason?: string;
  remediation?: string;
};
type Check = {
  id: string;
  total_criteria: number;
  covered_criteria: number;
  coverage_rate: number;
  status: string;
  checked_at: string | null;
  details: Criterion[];
};
type Verification = { id: string; status: string; result: string; created_at: string | null; criteria: Criterion[] };
type HistoryRun = Verification & {
  invalidated_reason: string | null;
  formal_outcome_id: string | null;
  responsible_ids: string[];
  decisions: { actor_id: string; decision: string; responsibility_share: number | null; reason: string }[];
};

const resultMeta: Record<string, { label: string; tone: "green" | "amber" | "red" | "blue" | "gray" }> = {
  passed: { label: "通过", tone: "green" },
  partially_passed: { label: "部分通过", tone: "amber" },
  uncertain: { label: "待人工复核", tone: "amber" },
  failed: { label: "未通过", tone: "red" },
  pending: { label: "待运行", tone: "gray" },
};

const compactBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

async function request<T>(url: string, method = "GET", payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithSession(
    new Request(new URL(apiConfig.baseUrl + url, window.location.origin), {
      method,
      credentials: "include",
      cache: "no-store",
      signal,
      headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    }),
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !Object.hasOwn(body, "data")) {
    throw new CApiError(
      response.status,
      body?.error?.code ?? "INVALID_API_RESPONSE",
      body?.error?.message ?? "无法读取验收数据，请重试。",
      response.headers.get("X-Request-Id"),
    );
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
      setCheck(null);
      setVerification(null);
      setHistory([]);
    }
    setError(failure instanceof Error ? failure.message : "请求失败，请重试。");
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [nextCheck, nextVerification, nextHistory] = await Promise.all([
        request<Check | null>(`${base}/integrity-check`, "GET", undefined, signal),
        request<Verification | null>(`${base}/verification`, "GET", undefined, signal),
        request<HistoryRun[]>(`${base}/verification/history`, "GET", undefined, signal),
      ]);
      if (signal?.aborted) return;
      setCheck(nextCheck);
      setVerification(nextVerification);
      setHistory(nextHistory);
    },
    [base],
  );

  useEffect(() => {
    const next = new AbortController();
    controller.current = next;
    setCheck(null);
    setVerification(null);
    setHistory([]);
    setReason("");
    setShare("");
    setError("");
    setNotice("");
    setBusy(false);
    void refresh(next.signal).catch((failure) => reportFailure(failure, next.signal));
    return () => next.abort();
  }, [refresh, reportFailure]);

  async function retryRead() {
    const signal = controller.current?.signal;
    setBusy(true);
    setError("");
    try {
      await refresh(signal);
    } catch (failure) {
      reportFailure(failure, signal);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  async function run(path: string, message: string) {
    const signal = controller.current?.signal;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`${base}/${path}`, "POST", undefined, signal);
      await refresh(signal);
      if (!signal?.aborted) setNotice(message);
    } catch (failure) {
      reportFailure(failure, signal);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  async function decide(decision: "confirmed" | "rejected") {
    const signal = controller.current?.signal;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = share.trim() === "" ? null : Number(share);
      if (decision === "confirmed" && (value === null || !Number.isFinite(value))) throw new Error("请填写实际承担比例");
      const result = await request<{ status: string; share_total?: number }>(
        `${base}/verification/decision`,
        "POST",
        { decision, reason, responsibility_share: decision === "confirmed" ? value : null },
        signal,
      );
      await refresh(signal);
      if (!signal?.aborted) {
        setNotice(
          result.status === "shares_incomplete"
            ? `已记录确认；当前承担比例合计 ${result.share_total}%，请负责人调整至 100%。`
            : "人工决定已保存",
        );
        setReason("");
      }
    } catch (failure) {
      reportFailure(failure, signal);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  const taskHref = `/projects/${projectId}/tasks/${taskId}`;
  const vMeta = verification ? (resultMeta[verification.result] ?? { label: verification.result, tone: "gray" as const }) : null;
  const formalDone = Boolean(history[0]?.formal_outcome_id);

  return (
    <div className="space-y-3.5">
      {/* Compact Header */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            {screen === 16 ? "证据完整性检查" : "任务验收"}
          </h1>
          <div className="gp-segmented" role="navigation" aria-label="验收步骤">
            <Link className="gp-segmented-item" data-active={screen === 16 ? "true" : undefined} href={`${taskHref}/evidence-check`}>
              1. 证据完整性检查
            </Link>
            <Link className="gp-segmented-item" data-active={screen === 17 ? "true" : undefined} href={`${taskHref}/verification`}>
              2. 自动验收与人工确认
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className={compactBtn} href={`/projects/${projectId}/tasks`}>
            返回任务列表
          </Link>
          <Link className={compactBtn} href={taskHref}>
            返回任务详情
          </Link>
          {screen === 16 && (
            <Link className={compactBtn} href={`${taskHref}/submit`}>
              返回提交草稿
            </Link>
          )}
          <button className={compactBtn} type="button" disabled={busy} onClick={() => void retryRead()}>
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            刷新验收数据
          </button>
        </div>
      </div>

      {error && (
        <div role="alert">
          <Feedback tone="error">{error}</Feedback>
        </div>
      )}
      {notice && <Feedback tone="success">{notice}</Feedback>}

      {screen === 16 ? (
        <>
          {/* Inline KPI Divider Strip */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-2.5 text-xs shadow-xs">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 size={14} className="text-sky-600" />
              <span className="text-slate-500">标准覆盖率</span>
              <span className="font-mono text-sm font-bold text-slate-900">{check ? `${check.coverage_rate}%` : "—"}</span>
              {check && <span className="text-slate-400">({check.covered_criteria}/{check.total_criteria})</span>}
            </div>
            <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">检查结论</span>
              <StatusBadge
                tone={check?.status === "passed" ? "green" : check ? "amber" : "gray"}
                label={check ? (check.status === "passed" ? "完整" : "待补充") : "未检查"}
              />
            </div>
            <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
            <div className="flex items-center gap-1.5 text-slate-500">
              <span>最近检查</span>
              <span className="font-mono text-slate-700">{check?.checked_at ? check.checked_at.slice(5, 16).replace("T", " ") : "—"}</span>
            </div>
          </div>

          {/* 2-Column Bento Layout */}
          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)] xl:items-start">
            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">逐条标准</h2>
                <Link className="gp-link text-xs" href={`/projects/${projectId}/evidence?task=${taskId}`}>
                  补充或采纳正式证据
                </Link>
              </div>
              {check?.details.length ? (
                <div className="divide-y divide-slate-100">
                  {check.details.map((item) => (
                    <article className="flex flex-wrap items-start justify-between gap-2.5 py-2.5 first:pt-0 last:pb-0" key={item.criterion_id}>
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium text-slate-900">{item.text}</p>
                        {item.evidence.length > 0 && (
                          <div className="flex flex-wrap gap-2.5 text-xs">
                            {item.evidence.map((ref) => (
                              <Link className="gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>
                                查看证据（v{ref.version}）
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                      <StatusBadge
                        tone={item.covered ? "green" : "amber"}
                        label={item.covered ? "已有有效正式证据" : "缺少有效正式证据"}
                      />
                    </article>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                  尚未执行检查，点击右侧“重新检查”核验当前有效正式证据。
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs xl:sticky xl:top-4">
              <h2 className="text-sm font-semibold text-slate-900">完整性核验</h2>
              <p className="mt-1.5 text-xs leading-5 text-slate-600">
                覆盖率：{check ? `${check.covered_criteria}/${check.total_criteria}（${check.coverage_rate}%）` : "尚未检查"}。仅计入当前有效的正式证据。
              </p>
              {check && (
                <div className="mt-2.5">
                  <ProgressBar value={check.coverage_rate} />
                </div>
              )}
              <div className="mt-3.5 flex flex-wrap gap-2">
                <button className={secondary} type="button" disabled={busy} onClick={() => void run("integrity-check", "检查快照已保存")}>
                  重新检查
                </button>
                <button
                  className={button}
                  type="button"
                  disabled={busy || check?.status !== "passed"}
                  onClick={() => void run("enter-verification", "任务已进入待验收")}
                >
                  进入验收
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2.5 text-xs">
                <Link className="gp-link" href={`${taskHref}/verification`}>
                  查看验收结果
                </Link>
                <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}`}>
                  管理正式证据
                </Link>
              </div>
            </section>
          </div>
        </>
      ) : (
        <>
          {/* Inline KPI Divider Strip */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-2.5 text-xs shadow-xs">
            <div className="flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-sky-600" />
              <span className="text-slate-500">自动验收建议</span>
              {vMeta ? <StatusBadge tone={vMeta.tone} label={vMeta.label} /> : <span className="font-medium text-slate-600">尚未运行</span>}
            </div>
            <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">正式成果</span>
              <StatusBadge tone={formalDone ? "green" : "amber"} label={formalDone ? "已确认完成" : "待负责人确认"} />
            </div>
            <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
            <div className="flex items-center gap-1.5 text-slate-500">
              <span>验收记录</span>
              <span className="font-mono font-semibold text-slate-800">{history.length}</span>
            </div>
            {formalDone && (
              <Link className="gp-link ml-auto font-medium" href={`/projects/${projectId}/contribution`}>
                前往贡献总览 →
              </Link>
            )}
          </div>

          {/* 2-Column Bento Layout */}
          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,1fr)] xl:items-start">
            {/* Left Column: Criteria Results + Collapsible History */}
            <div className="space-y-3.5">
              <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">逐条验收结果</h2>
                    <p className="text-[11px] text-slate-500">AI 结果仅作建议，不能替代负责人确认。</p>
                  </div>
                  <button
                    className={button}
                    type="button"
                    disabled={busy || check?.status !== "passed"}
                    onClick={() => void run("verification", "已保存逐条验收建议")}
                  >
                    运行自动验收
                  </button>
                </div>

                {verification?.criteria.length ? (
                  <div className="divide-y divide-slate-100">
                    {verification.criteria.map((item) => {
                      const cm = item.result ? (resultMeta[item.result] ?? { label: item.result, tone: "gray" as const }) : null;
                      return (
                        <article className="space-y-1 py-2.5 first:pt-0 last:pb-0" key={item.criterion_id}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold text-slate-900">{item.text}</h3>
                            {cm && <StatusBadge tone={cm.tone} label={`判断：${cm.label}`} />}
                          </div>
                          {item.reason && <p className="text-xs leading-5 text-slate-600">{item.reason}</p>}
                          {item.remediation && <p className="text-xs text-amber-800">整改建议：{item.remediation}</p>}
                          {item.evidence.length > 0 && (
                            <div className="flex flex-wrap gap-2.5 text-xs">
                              {item.evidence.map((ref) => (
                                <Link className="gp-link" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>
                                  查看证据（v{ref.version}）
                                </Link>
                              ))}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                    尚无验收运行记录，确认证据完整后点击右上角“运行自动验收”。
                  </p>
                )}
              </section>

              <details className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs" open={history.length > 0 && history.length <= 2}>
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-slate-900">
                  <span>验收历史（{history.length}，最新在前）</span>
                  <ChevronDown size={15} className="text-slate-400" />
                </summary>
                <div className="mt-3">
                  {history.length ? (
                    <div className="divide-y divide-slate-100 text-xs">
                      {history.map((entry) => (
                        <article className="space-y-1.5 py-2.5 first:pt-0 last:pb-0" key={entry.id}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-slate-900">
                              {entry.created_at ? new Date(entry.created_at).toLocaleString("zh-CN") : "时间未知"}
                            </span>
                            <StatusBadge
                              tone={entry.formal_outcome_id ? "green" : entry.invalidated_reason ? "red" : "amber"}
                              label={
                                entry.formal_outcome_id
                                  ? "正式成果"
                                  : entry.invalidated_reason
                                    ? `已失效：${entry.invalidated_reason}`
                                    : "待人工确认"
                              }
                            />
                            <span className="text-slate-500">
                              负责人确认：{entry.decisions.length}/{entry.responsible_ids.length}
                            </span>
                          </div>
                          {entry.decisions.map((decision) => (
                            <p className="text-slate-600" key={decision.actor_id}>
                              {decision.actor_id}：
                              {decision.decision === "confirmed" ? `确认（${decision.responsibility_share}%）` : "要求补充"} ·{" "}
                              {decision.reason}
                            </p>
                          ))}
                          <div className="space-y-1 text-slate-600">
                            {entry.criteria.map((criterion) => (
                              <p key={criterion.criterion_id}>
                                {criterion.text}：{resultMeta[criterion.result ?? ""]?.label ?? criterion.result}
                                {criterion.evidence.map((ref) => (
                                  <Link className="gp-link ml-2" key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>
                                    证据
                                  </Link>
                                ))}
                                <Link
                                  className="gp-link ml-2"
                                  href={`/projects/${projectId}/evidence?task=${taskId}&criterion=${criterion.criterion_id}&capture=1`}
                                >
                                  补充此标准证据
                                </Link>
                              </p>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">尚无验收历史。</p>
                  )}
                </div>
              </details>
            </div>

            {/* Right Sticky Column: Responsible Confirmation */}
            <div className="space-y-3.5 xl:sticky xl:top-4">
              {verification ? (
                <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                  <h2 className="text-sm font-semibold text-slate-900">负责人确认</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    填写实际承担比例并确认；全部确认且合计 100% 后生成正式成果并完成任务。
                  </p>
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className={label} htmlFor="accept-reason">
                        人工判断原因
                      </label>
                      <textarea
                        id="accept-reason"
                        className={input}
                        rows={3}
                        placeholder="说明核查结论与依据"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </div>
                    <div>
                      <label className={label} htmlFor="accept-share">
                        我的实际承担比例（%）
                      </label>
                      <input
                        id="accept-share"
                        className={input}
                        type="number"
                        min="0"
                        max="100"
                        step="0.0001"
                        placeholder="例如 100"
                        value={share}
                        onChange={(event) => setShare(event.target.value)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        className={`${button} flex-1`}
                        disabled={busy || !reason.trim() || !share.trim() || Boolean(history[0]?.invalidated_reason) || formalDone}
                        onClick={() => void decide("confirmed")}
                      >
                        确认验收结果
                      </button>
                      <button
                        type="button"
                        className={secondary}
                        disabled={busy || !reason.trim() || formalDone}
                        onClick={() => void decide("rejected")}
                      >
                        要求补充证据
                      </button>
                    </div>
                    <div className="border-t border-slate-100 pt-2.5 text-right text-xs">
                      <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}&capture=1`}>
                        按任务补充证据 →
                      </Link>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                  <h2 className="text-sm font-semibold text-slate-900">下一步：运行自动验收</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    先完成“证据完整性检查”，再点击“运行自动验收”生成逐条建议，随后在此处完成负责人人工确认与责任分配。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link className={compactBtn} href={`${taskHref}/evidence-check`}>
                      前往完整性检查
                    </Link>
                    <Link className={compactBtn} href={`/projects/${projectId}/evidence?task=${taskId}&capture=1`}>
                      补充任务证据
                    </Link>
                  </div>
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
