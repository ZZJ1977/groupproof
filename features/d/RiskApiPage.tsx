"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Section, Stat, StatusBadge } from "@/components/common";
import { button, input, label, secondary } from "@/features/b/ui";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";
import { createCClient } from "@/lib/api/c-client";

type Option = { id: string; title: string };
type Risk = { id: string; title: string; description: string; level: string; status: string; version: number; events: { id: string; type: string; note: string; created_at: string }[] };

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

async function riskRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetchWithSession(new Request(new URL(apiConfig.baseUrl + path, window.location.origin), {
    method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store",
  }));
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
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [explanation, setExplanation] = useState<{ ai_available: boolean; explanation: { summary: string; explanation: string; suggestions: string[] } | null; facts: { id: string; title: string; level: string; description: string }[] } | null>(null);
  const base = `/api/v1/projects/${projectId}/risks`;

  async function refresh() {
    const [entries, summary] = await Promise.all([
      riskRequest<Risk[]>(base),
      riskRequest<{ total: number; high: number; medium: number; low: number }>(`/api/v1/projects/${projectId}/risk-summary`),
    ]);
    setRisks(entries); setRiskSummary(summary);
  }
  useEffect(() => {
    let active = true;
    Promise.all([createCClient().projectContext(projectId), riskRequest<Risk[]>(base), riskRequest<{ total: number; high: number; medium: number; low: number }>(`/api/v1/projects/${projectId}/risk-summary`)])
      .then(([context, entries, summary]) => { if (active) { setTasks(context.tasks.map((item) => ({ id: item.id, title: item.title }))); setMembers(context.members.map((item) => ({ id: item.id, title: item.title }))); setMilestones(context.milestones.map((item) => ({ id: item.id, title: item.title }))); setRisks(entries); setRiskSummary(summary); } })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [projectId, base]);

  async function create() {
    setBusy(true); setError(""); setNotice("");
    try { await riskRequest(base, "POST", { title, description, level, task_id: taskId || null, milestone_id: milestoneId || null, owner_id: ownerId }); await refresh(); setTitle(""); setDescription(""); setNotice("风险记录已创建。"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function transition(risk: Risk, action: "mitigate" | "close") {
    setBusy(true); setError(""); setNotice("");
    try { await riskRequest(`${base}/${risk.id}/transitions`, "POST", { action, note, expected_version: risk.version }); await refresh(); setNote(""); setNotice(action === "mitigate" ? "风险已标记为缓解。" : "风险已关闭。"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function explain() {
    setBusy(true); setError("");
    try { setExplanation(await riskRequest(`/api/v1/projects/${projectId}/risk-explanation`)); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    {embedded ? (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/70 pt-6">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900">项目风险跟踪</h2>
          <p className="mt-0.5 text-xs text-slate-500">登记任务或里程碑阻塞项，记录缓解动作并生成 AI 风险解读。</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void explain()} className={secondary}><Sparkles size={14} />生成风险解释</button>
      </div>
    ) : (
      <PageHeader
        title="里程碑与风险"
        description="追踪项目关键阻塞项与缓解进度。"
        actions={<button type="button" disabled={busy} onClick={() => void explain()} className={secondary}><Sparkles size={14} />生成风险解释</button>}
      />
    )}

    {error && <div role="alert"><Feedback tone="error">{error}</Feedback></div>}
    {notice && <Feedback tone="success">{notice}</Feedback>}

    {riskSummary && (
      <div className="gp-grid-4">
        <Stat label="活跃风险" value={riskSummary.total} icon={AlertTriangle} />
        <Stat label="高风险" value={riskSummary.high} accent="#be123c" />
        <Stat label="中风险" value={riskSummary.medium} accent="#b45309" />
        <Stat label="低风险" value={riskSummary.low} accent="#0369a1" />
      </div>
    )}

    {!embedded && (
      <Section title="里程碑" surface>
        {milestones.length ? <ul className="divide-y divide-slate-100 text-sm">{milestones.map((item) => <li className="py-2 font-medium text-slate-800" key={item.id}>{item.title}</li>)}</ul> : <p className="text-sm text-slate-500">暂无里程碑</p>}
      </Section>
    )}

    {explanation && (
      <Section title="AI 风险解读" surface>
        <div role="status" className="space-y-2 text-sm text-slate-700">
          {explanation.ai_available && explanation.explanation ? <>
            <h3 className="text-base font-semibold text-slate-900">{explanation.explanation.summary}</h3>
            <p className="leading-6">{explanation.explanation.explanation}</p>
            {explanation.explanation.suggestions.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-slate-600">{explanation.explanation.suggestions.map((item) => <li key={item}>{item}</li>)}</ul>
            )}
            <p className="text-xs text-slate-500">AI 建议，需人工判断。</p>
          </> : <>
            <p className="text-slate-600">AI 暂不可用，显示当前风险事实：</p>
            <ul className="list-disc space-y-1 pl-5">{explanation.facts.map((item) => <li key={item.id}>{item.title} · {levelMeta[item.level]?.label ?? item.level} · {item.description}</li>)}</ul>
          </>}
        </div>
      </Section>
    )}

    <Section title="创建风险" surface>
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
          <div><label className={label} htmlFor="risk-title">风险标题</label><input id="risk-title" className={input} aria-label="风险标题" placeholder="例如：核心接口联调延期" value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          <div><label className={label} htmlFor="risk-level">等级</label><select id="risk-level" className={input} aria-label="等级" value={level} onChange={(event) => setLevel(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
        </div>
        <div><label className={label} htmlFor="risk-desc">风险描述</label><textarea id="risk-desc" className={input} rows={2} aria-label="风险描述" placeholder="说明触发原因、影响范围及应对思路" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className={label} htmlFor="risk-task">关联任务</label><select id="risk-task" className={input} aria-label="关联任务" value={taskId} onChange={(event) => { setTaskId(event.target.value); if (event.target.value) setMilestoneId(""); }}><option value="">选择关联任务</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></div>
          <div><label className={label} htmlFor="risk-ms">或关联里程碑</label><select id="risk-ms" className={input} aria-label="关联里程碑" value={milestoneId} onChange={(event) => { setMilestoneId(event.target.value); if (event.target.value) setTaskId(""); }}><option value="">选择关联里程碑</option>{milestones.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
          <div><label className={label} htmlFor="risk-owner">负责人</label><select id="risk-owner" className={input} aria-label="负责人" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">选择负责人</option>{members.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}</select></div>
        </div>
        <div className="flex justify-end"><button type="button" className={button} disabled={busy || !title.trim() || !description.trim() || !(taskId || milestoneId) || !ownerId} onClick={() => void create()}>创建风险</button></div>
      </div>
    </Section>

    <Section title={`风险记录（${risks.length}）`}>
      {risks.length > 0 && (
        <div className="mb-3 max-w-xl">
          <label className={label} htmlFor="risk-note">状态变更说明（缓解或关闭前填写）</label>
          <input id="risk-note" className={input} aria-label="变化说明" placeholder="填写缓解措施或关闭依据" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
      )}
      <div className="space-y-3">
        {risks.map((risk) => {
          const lm = levelMeta[risk.level] ?? { label: risk.level, tone: "gray" as const };
          const sm = statusMeta[risk.status] ?? { label: risk.status, tone: "gray" as const };
          return (
            <article className="gp-surface-card space-y-2.5" key={risk.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{risk.title}</h3>
                    <StatusBadge tone={lm.tone} label={lm.label} />
                    <StatusBadge tone={sm.tone} label={sm.label} />
                  </div>
                  <p className="text-sm text-slate-600">{risk.description}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {risk.status === "open" && <button type="button" className={secondary} disabled={busy || !note.trim()} onClick={() => void transition(risk, "mitigate")}>缓解</button>}
                  {risk.status !== "closed" && <button type="button" className={secondary} disabled={busy || !note.trim()} onClick={() => void transition(risk, "close")}>关闭</button>}
                </div>
              </div>
              <details className="rounded-lg bg-slate-50/80 px-3 py-2 text-xs text-slate-600">
                <summary className="cursor-pointer font-medium text-slate-700">变化历史（{risk.events.length}）</summary>
                <ul className="mt-2 space-y-1">{risk.events.map((event) => <li key={event.id}>{event.created_at.slice(0, 16).replace("T", " ")} · {event.type} · {event.note}</li>)}</ul>
              </details>
            </article>
          );
        })}
        {risks.length === 0 && <div className="gp-surface-card"><EmptyState title="暂无风险记录" description="当前项目没有登记的风险项。" /></div>}
      </div>
    </Section>
  </div>;
}
