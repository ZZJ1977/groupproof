"use client";

import { useEffect, useState } from "react";
import { createCClient } from "@/lib/api/c-client";

type Option = { id: string; title: string };
type Risk = { id: string; title: string; description: string; level: string; status: string; version: number; events: { id: string; type: string; note: string; created_at: string }[] };

async function riskRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const envelope = await response.json();
  if (!response.ok) throw new Error(envelope.error?.message ?? "请求失败");
  return envelope.data as T;
}

export function RiskApiPage({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Option[]>([]);
  const [members, setMembers] = useState<Option[]>([]);
  const [milestones, setMilestones] = useState<Option[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [taskId, setTaskId] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState("medium");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/projects/${projectId}/risks`;

  async function refresh() { setRisks(await riskRequest<Risk[]>(base)); }
  useEffect(() => {
    let active = true;
    Promise.all([createCClient().projectContext(projectId), riskRequest<Risk[]>(base)])
      .then(([context, entries]) => { if (active) { setTasks(context.tasks.map((item) => ({ id: item.id, title: item.title }))); setMembers(context.members.map((item) => ({ id: item.id, title: item.title }))); setMilestones(context.milestones.map((item) => ({ id: item.id, title: item.title }))); setRisks(entries); } })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [projectId, base]);

  async function create() {
    setBusy(true); setError("");
    try { await riskRequest(base, "POST", { title, description, level, task_id: taskId || null, milestone_id: milestoneId || null, owner_id: ownerId }); await refresh(); setTitle(""); setDescription(""); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function transition(risk: Risk, action: "mitigate" | "close") {
    setBusy(true); setError("");
    try { await riskRequest(`${base}/${risk.id}/transitions`, "POST", { action, note, expected_version: risk.version }); await refresh(); setNote(""); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-4xl space-y-5 p-6"><h1 className="text-2xl font-semibold">里程碑与风险</h1>{error && <p role="alert" className="text-red-700">{error}</p>}
    <section className="space-y-2 rounded border bg-white p-4"><h2 className="font-semibold">里程碑</h2>{milestones.map((item) => <p key={item.id}>{item.title}</p>)}{!milestones.length && <p>暂无里程碑</p>}</section>
    <section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">创建风险</h2><input className="w-full rounded border p-2" aria-label="风险标题" placeholder="风险标题" value={title} onChange={(event) => setTitle(event.target.value)} /><textarea className="w-full rounded border p-2" aria-label="风险描述" placeholder="描述" value={description} onChange={(event) => setDescription(event.target.value)} /><div className="flex flex-wrap gap-2"><select aria-label="等级" value={level} onChange={(event) => setLevel(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><select aria-label="关联任务" value={taskId} onChange={(event) => { setTaskId(event.target.value); if (event.target.value) setMilestoneId(""); }}><option value="">选择关联任务</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><span>或</span><select aria-label="关联里程碑" value={milestoneId} onChange={(event) => { setMilestoneId(event.target.value); if (event.target.value) setTaskId(""); }}><option value="">选择关联里程碑</option>{milestones.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select aria-label="负责人" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">选择负责人</option>{members.map((member) => <option key={member.id} value={member.id}>{member.title}</option>)}</select></div><button className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50" disabled={busy || !title.trim() || !description.trim() || !(taskId || milestoneId) || !ownerId} onClick={() => void create()}>创建风险</button></section>
    <section className="space-y-3"><h2 className="font-semibold">风险记录</h2><input className="w-full rounded border p-2" aria-label="变化说明" placeholder="缓解或关闭原因" value={note} onChange={(event) => setNote(event.target.value)} />{risks.map((risk) => <article className="rounded border bg-white p-4" key={risk.id}><h3 className="font-semibold">{risk.title} · {risk.level} · {risk.status}</h3><p>{risk.description}</p><div className="mt-2 flex gap-2">{risk.status === "open" && <button disabled={busy || !note.trim()} onClick={() => void transition(risk, "mitigate")}>缓解</button>}{risk.status !== "closed" && <button disabled={busy || !note.trim()} onClick={() => void transition(risk, "close")}>关闭</button>}</div><details className="mt-2"><summary>变化历史（{risk.events.length}）</summary>{risk.events.map((event) => <p key={event.id}>{event.created_at} · {event.type} · {event.note}</p>)}</details></article>)}{risks.length === 0 && <p>暂无风险记录</p>}</section>
  </main>;
}
