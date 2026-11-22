"use client";

import { useCallback, useEffect, useState } from "react";

type Note = { revision: number; body: string; author_id: string; created_at: string };
type Appeal = { id: string; member_id: string; task_id: string; evidence_id: string; reason: string; status: string };
type Task = { task_id: string; title: string; evidence: { evidence_id: string }[] };

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: "include", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "请求失败");
  return payload.data as T;
}

export function ContributionWeek7Panel({ projectId, memberId, tasks }: { projectId: string; memberId: string; tasks: Task[] }) {
  const base = `/api/v1/projects/${projectId}/contribution`;
  const [notes, setNotes] = useState<Note[]>([]);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [body, setBody] = useState("");
  const [taskId, setTaskId] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [nextNotes, nextAppeals] = await Promise.all([
      call<Note[]>(`${base}/members/${memberId}/notes`), call<Appeal[]>(`${base}/appeals`),
    ]);
    setNotes(nextNotes); setAppeals(nextAppeals.filter((item) => item.member_id === memberId));
  }, [base, memberId]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  async function save(url: string, data: unknown) {
    setBusy(true); setError("");
    try { await call(url, "POST", data); await refresh(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const selectedTask = tasks.find((task) => task.task_id === taskId);
  return <div className="space-y-4">
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <section className="space-y-2 rounded border bg-white p-4"><h2 className="font-semibold">协作说明</h2>
      <textarea className="w-full rounded border p-2" aria-label="协作说明" value={body} onChange={(event) => setBody(event.target.value)} />
      <button disabled={busy || !body.trim()} onClick={() => void save(`${base}/members/${memberId}/notes`, { body })}>保存新版本</button>
      {notes.map((note) => <p key={note.revision}>v{note.revision} · {note.created_at} · {note.body} <button disabled={busy} className="text-blue-700" onClick={() => void save(`${base}/members/${memberId}/notes`, { body: note.body, restore_revision: note.revision })}>恢复</button></p>)}
    </section>
    <section className="space-y-2 rounded border bg-white p-4"><h2 className="font-semibold">贡献申诉</h2>
      <select aria-label="申诉任务" value={taskId} onChange={(event) => { setTaskId(event.target.value); setEvidenceId(""); }}><option value="">选择任务</option>{tasks.map((task) => <option key={task.task_id} value={task.task_id}>{task.title}</option>)}</select>
      <select aria-label="正式证据" value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)}><option value="">选择证据</option>{selectedTask?.evidence.map((item) => <option key={item.evidence_id} value={item.evidence_id}>{item.evidence_id}</option>)}</select>
      <textarea className="w-full rounded border p-2" aria-label="申诉理由" value={reason} onChange={(event) => setReason(event.target.value)} />
      <button disabled={busy || !taskId || !evidenceId || !reason.trim()} onClick={() => void save(`${base}/appeals`, { task_id: taskId, evidence_id: evidenceId, reason })}>提交申诉</button>
      {appeals.map((appeal) => <p key={appeal.id}>{appeal.status} · 任务 {appeal.task_id} · 证据 {appeal.evidence_id} · {appeal.reason}</p>)}
    </section>
  </div>;
}
