"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Clock, RefreshCw, ShieldCheck } from "lucide-react";
import { Feedback, ProgressBar, StatusBadge } from "@/shared/components/common";
import { button, input, label, secondary } from "@/shared/lib/b-ui";
import { projectApi } from "@/shared/lib/c-project-api";
import { fetchWithSession } from "@/shared/lib/api-client";
import { apiConfig } from "@/shared/lib/api-config";
import { CApiError } from "@/shared/daily-inbox/c-client";

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
type DecisionRecord = {
  actor_id: string;
  decision: string;
  responsibility_share: number | null;
  reason: string;
  created_at?: string | null;
};
type HistoryRun = Verification & {
  invalidated_reason: string | null;
  formal_outcome_id: string | null;
  responsible_ids: string[];
  decisions: DecisionRecord[];
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

const evidenceChipClass =
  "inline-flex items-center rounded-md border border-slate-200/85 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 transition-colors hover:border-sky-300 hover:bg-sky-50";

const HISTORY_INITIAL_VISIBLE = 5;

function cleanTextSegments(raw?: string | null): string[] {
  if (!raw) return [];
  const normalized = raw
    .replace(/AI\s*建议[：:]\s*uncertain/gi, "AI 建议：待人工复核")
    .replace(/AI\s*建议[：:]\s*partially_passed/gi, "AI 建议：部分通过")
    .replace(/AI\s*建议[：:]\s*passed/gi, "AI 建议：通过")
    .replace(/AI\s*建议[：:]\s*failed/gi, "AI 建议：未通过")
    .replace(/\r\n?/g, "\n");

  const parts = normalized.split(/[；;。\n]+/);
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const part of parts) {
    const cleaned = part.replace(/^[\s，,、]+|[\s。；;，,]+$/g, "").trim();
    if (!cleaned) continue;
    const key = cleaned.replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique;
}

function formatCleanText(raw?: string | null): string {
  const segments = cleanTextSegments(raw);
  if (segments.length === 0) return "";
  const joined = segments.join("；");
  return /[。！？.!?]$/.test(joined) ? joined : `${joined}。`;
}

function resolveMemberName(actorId: string, memberNames: Record<string, string>): string {
  const known = memberNames[actorId]?.trim();
  if (known) return known;
  return `成员 #${actorId.slice(0, 6)}`;
}

function formatCompactTime(iso?: string | null): string {
  if (!iso) return "时间未知";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(5, 16).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

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
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [share, setShare] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expandedCriteria, setExpandedCriteria] = useState<Record<string, boolean>>({});
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showReconfirmForm, setShowReconfirmForm] = useState(false);
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
    setExpandedCriteria({});
    setExpandedRuns({});
    setShowAllHistory(false);
    setShowReconfirmForm(false);

    void refresh(next.signal).catch((failure) => reportFailure(failure, next.signal));

    void projectApi
      .projectContext(projectId)
      .then((context) => {
        if (next.signal.aborted) return;
        const map: Record<string, string> = {};
        for (const item of context.evidence_authors ?? []) {
          if (item.id && item.title) map[item.id] = item.title;
        }
        for (const item of context.mention_targets ?? []) {
          if (item.id && item.title) map[item.id] = item.title;
        }
        for (const item of context.members ?? []) {
          if (item.id && item.title) map[item.id] = item.title;
        }
        setMemberNames(map);
      })
      .catch(() => {
        // Member directory lookup is best-effort; fallback uses short IDs.
      });

    return () => next.abort();
  }, [projectId, refresh, reportFailure]);

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
      if (!signal?.aborted) {
        setNotice(message);
        if (path === "verification") {
          setExpandedCriteria({});
          setShowReconfirmForm(false);
        }
      }
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
        if (decision === "confirmed") setShowReconfirmForm(false);
      }
    } catch (failure) {
      reportFailure(failure, signal);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  function toggleCriterion(criterionId: string) {
    setExpandedCriteria((prev) => ({ ...prev, [criterionId]: !prev[criterionId] }));
  }

  function toggleHistoryRun(runId: string) {
    setExpandedRuns((prev) => ({ ...prev, [runId]: !prev[runId] }));
  }

  const taskHref = `/projects/${projectId}/tasks/${taskId}`;
  const vMeta = verification ? (resultMeta[verification.result] ?? { label: verification.result, tone: "gray" as const }) : null;
  const latestRun = history[0] ?? null;
  const formalDone = Boolean(latestRun?.formal_outcome_id);

  const criteriaWithDetails = useMemo(
    () =>
      (verification?.criteria ?? []).map((item) => ({
        item,
        cleanedReason: formatCleanText(item.reason),
        cleanedRemediation: formatCleanText(item.remediation),
      })),
    [verification],
  );

  const expandableIds = useMemo(
    () =>
      criteriaWithDetails
        .filter((entry) => Boolean(entry.cleanedReason || entry.cleanedRemediation))
        .map((entry) => entry.item.criterion_id),
    [criteriaWithDetails],
  );

  const allCriteriaExpanded = expandableIds.length > 0 && expandableIds.every((id) => Boolean(expandedCriteria[id]));

  function toggleAllCriteria() {
    if (allCriteriaExpanded) {
      setExpandedCriteria({});
    } else {
      const next: Record<string, boolean> = {};
      for (const id of expandableIds) next[id] = true;
      setExpandedCriteria(next);
    }
  }

  const visibleHistory = showAllHistory ? history : history.slice(0, HISTORY_INITIAL_VISIBLE);
  const hiddenHistoryCount = Math.max(0, history.length - visibleHistory.length);

  return (
    <div className="space-y-3">
      {/* Compact Header */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
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
              <span className="font-mono text-slate-700">{check?.checked_at ? formatCompactTime(check.checked_at) : "—"}</span>
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
                    <article className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0" key={item.criterion_id}>
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
                        <p className="text-sm font-medium text-slate-900">{item.text}</p>
                        {item.evidence.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {item.evidence.map((ref) => (
                              <Link className={evidenceChipClass} key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>
                                查看证据 (v{ref.version})
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

          {/* Balanced 2-Column Bento Layout: Left = Criteria Results, Right = Confirmation + Compact History */}
          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,1fr)] xl:items-start">
            {/* Left Column: Compact Per-Criterion Results */}
            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">逐条验收结果</h2>
                <div className="flex items-center gap-2">
                  {expandableIds.length > 0 && (
                    <button
                      type="button"
                      onClick={toggleAllCriteria}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                    >
                      {allCriteriaExpanded ? "全部收起" : "全部展开"}
                    </button>
                  )}
                  <button
                    className={button}
                    type="button"
                    disabled={busy || check?.status !== "passed"}
                    onClick={() => void run("verification", "已保存逐条验收建议")}
                  >
                    运行自动验收
                  </button>
                </div>
              </div>

              {criteriaWithDetails.length > 0 ? (
                <div className="divide-y divide-slate-100">
                  {criteriaWithDetails.map(({ item, cleanedReason, cleanedRemediation }, index) => {
                    const cm = item.result ? (resultMeta[item.result] ?? { label: item.result, tone: "gray" as const }) : null;
                    const hasDetail = Boolean(cleanedReason || cleanedRemediation);
                    const isExpanded = Boolean(expandedCriteria[item.criterion_id]);

                    return (
                      <article className="py-2.5 first:pt-0 last:pb-0" key={item.criterion_id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono text-[11px] font-semibold text-slate-600">
                              {index + 1}
                            </span>
                            <h3 className="text-sm font-medium text-slate-900">{item.text}</h3>
                            {item.evidence.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {item.evidence.map((ref) => (
                                  <Link className={evidenceChipClass} key={ref.id} href={`/projects/${projectId}/evidence?evidence=${ref.id}`}>
                                    查看证据 (v{ref.version})
                                  </Link>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {cm && <StatusBadge tone={cm.tone} label={`判断：${cm.label}`} />}
                            {hasDetail && (
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                onClick={() => toggleCriterion(item.criterion_id)}
                                className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                              >
                                <span>{isExpanded ? "收起详情" : "展开详情"}</span>
                                <ChevronDown size={12} className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`} />
                              </button>
                            )}
                          </div>
                        </div>

                        {hasDetail && isExpanded && (
                          <div className="mt-2 ml-7 space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs">
                            {cleanedReason && (
                              <p className="leading-5 text-slate-600">
                                <span className="font-medium text-slate-700">AI 分析与核验：</span>
                                {cleanedReason}
                              </p>
                            )}
                            {cleanedRemediation && (
                              <p className="leading-5 text-amber-800">
                                <span className="font-medium">整改建议：</span>
                                {cleanedRemediation}
                              </p>
                            )}
                            <div className="pt-0.5">
                              <Link
                                className="gp-link text-[11px]"
                                href={`/projects/${projectId}/evidence?task=${taskId}&criterion=${item.criterion_id}&capture=1`}
                              >
                                补充此标准证据 →
                              </Link>
                            </div>
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

            {/* Right Column: Responsible Confirmation + Compact Collapsible History */}
            <div className="space-y-3.5">
              {verification ? (
                <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                  {formalDone && !showReconfirmForm ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/75 px-3.5 py-3">
                        <div className="flex items-start gap-2.5">
                          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <h2 className="text-sm font-semibold text-emerald-950">已确认正式验收成果</h2>
                              {latestRun?.created_at && (
                                <span className="font-mono text-[11px] text-emerald-700/80">
                                  {formatCompactTime(latestRun.created_at)}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs text-emerald-800/90">
                              负责人已完成人工确认并锁定承担比例，当前任务已归档为正式成果。
                            </p>
                          </div>
                        </div>
                        {latestRun && latestRun.decisions.length > 0 && (
                          <div className="mt-2.5 space-y-1 border-t border-emerald-200/70 pt-2 text-xs text-emerald-900">
                            {latestRun.decisions.map((decision) => (
                              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5" key={decision.actor_id}>
                                <span className="font-medium">
                                  {resolveMemberName(decision.actor_id, memberNames)}
                                  {decision.responsibility_share !== null ? ` · ${decision.responsibility_share}%` : ""}
                                </span>
                                {decision.reason && (
                                  <span className="truncate text-[11px] text-emerald-800/80" title={decision.reason}>
                                    {decision.reason}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => setShowReconfirmForm(true)}
                          className={compactBtn}
                        >
                          补充 / 重新确认
                        </button>
                        <div className="flex items-center gap-3">
                          <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}&capture=1`}>
                            补充证据
                          </Link>
                          <Link className="gp-link font-medium" href={`/projects/${projectId}/contribution`}>
                            前往贡献总览 →
                          </Link>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold text-slate-900">负责人确认</h2>
                        {formalDone && (
                          <button
                            type="button"
                            onClick={() => setShowReconfirmForm(false)}
                            className="text-xs font-medium text-slate-500 hover:text-slate-800"
                          >
                            收起表单
                          </button>
                        )}
                      </div>
                      <div className="mt-3 space-y-2.5">
                        <div>
                          <label className={label} htmlFor="accept-reason">
                            人工判断原因
                          </label>
                          <textarea
                            id="accept-reason"
                            className={input}
                            rows={2}
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
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            className={`${button} flex-1`}
                            disabled={busy || !reason.trim() || !share.trim() || Boolean(latestRun?.invalidated_reason) || formalDone}
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
                        <div className="border-t border-slate-100 pt-2 text-right text-xs">
                          <Link className="gp-link" href={`/projects/${projectId}/evidence?task=${taskId}&capture=1`}>
                            按任务补充证据 →
                          </Link>
                        </div>
                      </div>
                    </>
                  )}
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

              {/* Compact Collapsible Acceptance History in Right Column */}
              <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Clock size={14} className="text-slate-400" />
                    <h2 className="text-sm font-semibold text-slate-900">验收历史</h2>
                  </div>
                  <span className="text-[11px] text-slate-500">{history.length} 条 · 最新在前</span>
                </div>

                {history.length > 0 ? (
                  <div className="divide-y divide-slate-100">
                    {visibleHistory.map((entry) => {
                      const isExpanded = Boolean(expandedRuns[entry.id]);
                      const confirmerSummary =
                        entry.decisions.length > 0
                          ? entry.decisions
                              .map((d) =>
                                d.decision === "confirmed" && d.responsibility_share !== null
                                  ? `${resolveMemberName(d.actor_id, memberNames)} (${d.responsibility_share}%)`
                                  : resolveMemberName(d.actor_id, memberNames),
                              )
                              .join("、")
                          : `确认 ${entry.decisions.length}/${entry.responsible_ids.length}`;

                      return (
                        <article className="py-2 first:pt-0 last:pb-0" key={entry.id}>
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() => toggleHistoryRun(entry.id)}
                            className="flex w-full items-center justify-between gap-2 rounded-lg py-0.5 text-left transition-colors hover:bg-slate-50/80"
                          >
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
                              <span className="shrink-0 font-mono text-[11px] text-slate-600">
                                {formatCompactTime(entry.created_at)}
                              </span>
                              <StatusBadge
                                tone={entry.formal_outcome_id ? "green" : entry.invalidated_reason ? "red" : "amber"}
                                label={entry.formal_outcome_id ? "正式成果" : entry.invalidated_reason ? "已失效" : "待确认"}
                              />
                              <span className="truncate text-slate-600" title={confirmerSummary}>
                                {confirmerSummary}
                              </span>
                            </div>
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-slate-500">
                              <span>{isExpanded ? "收起" : "展开详情"}</span>
                              <ChevronDown size={12} className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`} />
                            </span>
                          </button>

                          {isExpanded && (
                            <div className="mt-2 space-y-2 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs">
                              {entry.invalidated_reason && (
                                <p className="text-rose-700">
                                  <span className="font-medium">失效原因：</span>
                                  {entry.invalidated_reason}
                                </p>
                              )}

                              <div className="space-y-1">
                                <p className="font-medium text-slate-700">
                                  负责人确认（{entry.decisions.length}/{entry.responsible_ids.length}）
                                </p>
                                {entry.decisions.length > 0 ? (
                                  entry.decisions.map((decision) => (
                                    <p className="leading-5 text-slate-600" key={decision.actor_id}>
                                      <span className="font-medium text-slate-800">
                                        {resolveMemberName(decision.actor_id, memberNames)}
                                      </span>
                                      ：{decision.decision === "confirmed" ? `确认（${decision.responsibility_share}%）` : "要求补充"}
                                      {decision.reason ? ` · ${decision.reason}` : ""}
                                    </p>
                                  ))
                                ) : (
                                  <p className="text-slate-500">暂无负责人确认记录。</p>
                                )}
                              </div>

                              {entry.criteria.length > 0 && (
                                <div className="space-y-1 border-t border-slate-200/70 pt-1.5">
                                  <p className="font-medium text-slate-700">验收标准快照</p>
                                  {entry.criteria.map((criterion) => (
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-600" key={criterion.criterion_id}>
                                      <span className="text-slate-800">{criterion.text}</span>
                                      <span className="text-[11px] text-slate-500">
                                        ({resultMeta[criterion.result ?? ""]?.label ?? criterion.result ?? "未判断"})
                                      </span>
                                      {criterion.evidence.map((ref) => (
                                        <Link
                                          className="gp-link text-[11px]"
                                          key={ref.id}
                                          href={`/projects/${projectId}/evidence?evidence=${ref.id}`}
                                        >
                                          证据 v{ref.version}
                                        </Link>
                                      ))}
                                      <Link
                                        className="gp-link text-[11px]"
                                        href={`/projects/${projectId}/evidence?task=${taskId}&criterion=${criterion.criterion_id}&capture=1`}
                                      >
                                        补充证据
                                      </Link>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}

                    {hiddenHistoryCount > 0 && (
                      <div className="pt-2 text-center">
                        <button
                          type="button"
                          onClick={() => setShowAllHistory(true)}
                          className="text-xs font-medium text-sky-700 hover:text-sky-800"
                        >
                          展开其余 {hiddenHistoryCount} 条历史记录
                        </button>
                      </div>
                    )}
                    {showAllHistory && history.length > HISTORY_INITIAL_VISIBLE && (
                      <div className="pt-2 text-center">
                        <button
                          type="button"
                          onClick={() => setShowAllHistory(false)}
                          className="text-xs font-medium text-slate-500 hover:text-slate-800"
                        >
                          收起较早记录
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">尚无验收历史。</p>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
