"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Sparkles, X } from "lucide-react";
import { Feedback, StatusBadge } from "@/components/common";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";
import { createCClient } from "@/lib/api/c-client";

type Option = { id: string; title: string };
type Risk = {
  id: string;
  title: string;
  description: string;
  level: string;
  status: string;
  version: number;
  events: { id: string; type: string; note: string; created_at: string }[];
};

const levelMeta: Record<string, { label: string; tone: "red" | "amber" | "blue" | "gray" }> = {
  high: { label: "高风险", tone: "red" },
  medium: { label: "中风险", tone: "amber" },
  low: { label: "低风险", tone: "blue" },
};

const statusMeta: Record<string, { label: string; tone: "amber" | "blue" | "green" | "gray" }> = {
  open: { label: "待处理", tone: "amber" },
  mitigated: { label: "已缓解", tone: "blue" },
  closed: { label: "已关闭", tone: "green" },
};

const compactInput =
  "h-9 w-full rounded-lg border border-slate-200/90 bg-white px-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:bg-slate-50 disabled:text-slate-500";
const compactBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const compactPrimaryBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";

async function riskRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetchWithSession(
    new Request(new URL(apiConfig.baseUrl + path, window.location.origin), {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }),
  );
  const envelope = await response.json();
  if (!response.ok) throw new Error(envelope.error?.message ?? "请求失败");
  return envelope.data as T;
}

export function RiskApiPage({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
  const [tasks, setTasks] = useState<Option[]>([]);
  const [members, setMembers] = useState<Option[]>([]);
  const [milestones, setMilestones] = useState<Option[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [riskSummary, setRiskSummary] = useState<{ total: number; high: number; medium: number; low: number } | null>(null);
  const [taskId, setTaskId] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState("medium");
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "mitigated" | "closed">("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [explanation, setExplanation] = useState<{
    ai_available: boolean;
    explanation: { summary: string; explanation: string; suggestions: string[] } | null;
    facts: { id: string; title: string; level: string; description: string }[];
  } | null>(null);
  const base = `/api/v1/projects/${projectId}/risks`;

  async function refresh() {
    const [entries, summary] = await Promise.all([
      riskRequest<Risk[]>(base),
      riskRequest<{ total: number; high: number; medium: number; low: number }>(`/api/v1/projects/${projectId}/risk-summary`),
    ]);
    setRisks(entries);
    setRiskSummary(summary);
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      createCClient().projectContext(projectId),
      riskRequest<Risk[]>(base),
      riskRequest<{ total: number; high: number; medium: number; low: number }>(`/api/v1/projects/${projectId}/risk-summary`),
    ])
      .then(([context, entries, summary]) => {
        if (active) {
          setTasks(context.tasks.map((item) => ({ id: item.id, title: item.title })));
          setMembers(context.members.map((item) => ({ id: item.id, title: item.title })));
          setMilestones(context.milestones.map((item) => ({ id: item.id, title: item.title })));
          setRisks(entries);
          setRiskSummary(summary);
        }
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [projectId, base]);

  async function create() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await riskRequest(base, "POST", {
        title,
        description,
        level,
        task_id: taskId || null,
        milestone_id: milestoneId || null,
        owner_id: ownerId,
      });
      await refresh();
      setTitle("");
      setDescription("");
      setShowCreate(false);
      setNotice("风险记录已创建。");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function transition(risk: Risk, action: "mitigate" | "close") {
    const currentNote = (notesById[risk.id] ?? "").trim();
    if (!currentNote) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await riskRequest(`${base}/${risk.id}/transitions`, "POST", {
        action,
        note: currentNote,
        expected_version: risk.version,
      });
      await refresh();
      setNotesById((prev) => ({ ...prev, [risk.id]: "" }));
      setNotice(action === "mitigate" ? "风险已标记为缓解。" : "风险已关闭。");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function explain() {
    setBusy(true);
    setError("");
    try {
      setExplanation(await riskRequest(`/api/v1/projects/${projectId}/risk-explanation`));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visibleRisks = statusFilter === "all" ? risks : risks.filter((r) => r.status === statusFilter);
  const summary = riskSummary ?? { total: 0, high: 0, medium: 0, low: 0 };

  return (
    <div className="space-y-3.5">
      {/* Compact Header (Standalone only) */}
      {!embedded && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">里程碑与风险</h1>
            <p className="mt-0.5 text-xs text-slate-500">追踪项目关键阻塞项与缓解进度</p>
          </div>
          {milestones.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {milestones.slice(0, 4).map((item) => (
                <span key={item.id} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {item.title}
                </span>
              ))}
              {milestones.length > 4 && (
                <span className="text-xs text-slate-400">+{milestones.length - 4} 个里程碑</span>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert">
          <Feedback tone="error">{error}</Feedback>
        </div>
      )}
      {notice && <Feedback tone="success">{notice}</Feedback>}

      {/* Single Compact Summary Strip + Risk List Card */}
      <section className="rounded-2xl border border-slate-200/85 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <AlertTriangle size={15} className="text-amber-600" />
              项目风险
            </span>
            <span className="h-3.5 w-px bg-slate-200" aria-hidden="true" />
            <span className="text-slate-600">
              活跃 <strong className="font-mono text-slate-900">{summary.total}</strong>
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-rose-700">
              高 <strong className="font-mono">{summary.high}</strong>
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-amber-700">
              中 <strong className="font-mono">{summary.medium}</strong>
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-sky-700">
              低 <strong className="font-mono">{summary.low}</strong>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {risks.length > 0 && (
              <div className="flex items-center gap-1 rounded-lg bg-slate-100/80 p-0.5 text-[11px]">
                {(
                  [
                    ["all", "全部"],
                    ["open", "待处理"],
                    ["mitigated", "已缓解"],
                    ["closed", "已关闭"],
                  ] as const
                ).map(([key, text]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
                      statusFilter === key ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
            <button type="button" disabled={busy} onClick={() => void explain()} className={compactBtn}>
              <Sparkles size={13} />
              生成风险解释
            </button>
            <button
              type="button"
              onClick={() => setShowCreate((prev) => !prev)}
              className={showCreate ? compactBtn : compactPrimaryBtn}
            >
              {showCreate ? <X size={13} /> : <Plus size={13} />}
              {showCreate ? "收起表单" : "登记风险"}
            </button>
          </div>
        </div>

        {/* Collapsible Create Risk Form */}
        {showCreate && (
          <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3.5">
            <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_120px_minmax(0,1.2fr)]">
              <input
                id="risk-title"
                className={compactInput}
                aria-label="风险标题"
                placeholder="风险标题（例如：核心接口联调延期）"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <select
                id="risk-level"
                className={compactInput}
                aria-label="等级"
                value={level}
                onChange={(event) => setLevel(event.target.value)}
              >
                <option value="low">低风险</option>
                <option value="medium">中风险</option>
                <option value="high">高风险</option>
              </select>
              <input
                id="risk-desc"
                className={compactInput}
                aria-label="风险描述"
                placeholder="简要说明触发原因、影响范围及应对思路"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
              <select
                id="risk-task"
                className={`${compactInput} min-w-[160px] flex-1`}
                aria-label="关联任务"
                value={taskId}
                onChange={(event) => {
                  setTaskId(event.target.value);
                  if (event.target.value) setMilestoneId("");
                }}
              >
                <option value="">关联任务（二选一）</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <select
                id="risk-ms"
                className={`${compactInput} min-w-[160px] flex-1`}
                aria-label="关联里程碑"
                value={milestoneId}
                onChange={(event) => {
                  setMilestoneId(event.target.value);
                  if (event.target.value) setTaskId("");
                }}
              >
                <option value="">或关联里程碑（二选一）</option>
                {milestones.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <select
                id="risk-owner"
                className={`${compactInput} min-w-[140px] flex-1`}
                aria-label="负责人"
                value={ownerId}
                onChange={(event) => setOwnerId(event.target.value)}
              >
                <option value="">选择负责人</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={compactPrimaryBtn}
                disabled={busy || !title.trim() || !description.trim() || !(taskId || milestoneId) || !ownerId}
                onClick={() => void create()}
              >
                创建风险
              </button>
            </div>
          </div>
        )}

        {/* AI Risk Explanation Drawer (Inline Collapsible) */}
        {explanation && (
          <div role="status" className="border-t border-sky-100 bg-sky-50/45 px-4 py-3 text-xs text-slate-700">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-sky-800">
                <Sparkles size={13} />
                AI 风险解读
              </span>
              <button
                type="button"
                className="text-slate-400 hover:text-slate-600"
                aria-label="关闭风险解读"
                onClick={() => setExplanation(null)}
              >
                <X size={14} />
              </button>
            </div>
            {explanation.ai_available && explanation.explanation ? (
              <div className="space-y-1.5">
                <p className="font-semibold text-slate-900">{explanation.explanation.summary}</p>
                <p className="leading-5 text-slate-700">{explanation.explanation.explanation}</p>
                {explanation.explanation.suggestions.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-slate-600">
                    {explanation.explanation.suggestions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-slate-400">AI 建议，需人工判断。</p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-slate-600">AI 暂不可用，显示当前风险事实：</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {explanation.facts.map((item) => (
                    <li key={item.id}>
                      {item.title} · {levelMeta[item.level]?.label ?? item.level} · {item.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Dense Risk Table / Rows */}
        <div className="border-t border-slate-100">
          {visibleRisks.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5 text-xs text-slate-500">
              <span>{risks.length === 0 ? "当前项目暂无登记的风险项，若出现进度阻塞或外部依赖延期可随时登记。" : "当前筛选状态下无风险记录。"}</span>
              {risks.length === 0 && !showCreate && (
                <button type="button" onClick={() => setShowCreate(true)} className="font-medium text-sky-700 hover:underline">
                  + 登记首条风险
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {visibleRisks.map((risk) => {
                const lm = levelMeta[risk.level] ?? { label: risk.level, tone: "gray" as const };
                const sm = statusMeta[risk.status] ?? { label: risk.status, tone: "gray" as const };
                const isExpanded = expandedId === risk.id;
                const rowNote = notesById[risk.id] ?? "";
                return (
                  <article key={risk.id} className="transition-colors hover:bg-slate-50/50">
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : risk.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        {isExpanded ? (
                          <ChevronDown size={14} className="shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight size={14} className="shrink-0 text-slate-400" />
                        )}
                        <StatusBadge tone={lm.tone} label={lm.label} />
                        <span className="truncate text-sm font-medium text-slate-900">{risk.title}</span>
                        <StatusBadge tone={sm.tone} label={sm.label} />
                      </button>
                      <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                        <span>{risk.events.length} 条记录</span>
                        <button
                          type="button"
                          onClick={() => setExpandedId(isExpanded ? null : risk.id)}
                          className="font-medium text-sky-700 hover:underline"
                        >
                          {isExpanded ? "收起" : "详情 / 处置"}
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-xs">
                        <p className="leading-5 text-slate-700">{risk.description}</p>
                        {risk.status !== "closed" && (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              className={`${compactInput} h-8 min-w-[220px] flex-1 text-xs`}
                              aria-label="变化说明"
                              placeholder="填写缓解措施或关闭依据后操作"
                              value={rowNote}
                              onChange={(event) => setNotesById((prev) => ({ ...prev, [risk.id]: event.target.value }))}
                            />
                            {risk.status === "open" && (
                              <button
                                type="button"
                                className={compactBtn}
                                disabled={busy || !rowNote.trim()}
                                onClick={() => void transition(risk, "mitigate")}
                              >
                                缓解
                              </button>
                            )}
                            <button
                              type="button"
                              className={compactBtn}
                              disabled={busy || !rowNote.trim()}
                              onClick={() => void transition(risk, "close")}
                            >
                              关闭
                            </button>
                          </div>
                        )}
                        {risk.events.length > 0 && (
                          <details className="rounded-lg bg-white px-3 py-2 text-slate-600">
                            <summary className="cursor-pointer font-medium text-slate-700">
                              变化历史（{risk.events.length}）
                            </summary>
                            <ul className="mt-1.5 space-y-1">
                              {risk.events.map((event) => (
                                <li key={event.id}>
                                  {event.created_at.slice(0, 16).replace("T", " ")} · {event.type} · {event.note}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
