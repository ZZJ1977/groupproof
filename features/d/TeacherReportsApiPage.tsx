"use client";

import { useCallback, useEffect, useState } from "react";

type Project = { project_id: string; project_name: string };
type Review = { report_status: string; snapshot: { id: string; version: number; data: { sections: Record<string, string> } } | null;
  contribution: { members: { user_id: string; share: string }[] } | null;
  evidence: { id: string; title: string }[]; appeals: { id: string; status: string; reason: string }[];
  comments: { id: string; body: string; created_at: string }[];
  grades: { id: string; score: number; comment: string; created_at: string }[] };

async function call<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "include", cache: "no-store",
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function TeacherReportsApiPage({ courseId }: { courseId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [body, setBody] = useState("");
  const [score, setScore] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    setReview(await call<Review>(`/api/v1/projects/${projectId}/teacher-report`));
  }, [projectId]);
  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      const all: Project[] = [];
      for (let page = 1; ; page += 1) {
        const result = await call<{ total: number; items: Project[] }>(
          `/api/v1/courses/${courseId}/teacher-groups?size=100&page=${page}`);
        all.push(...result.items);
        if (all.length >= result.total || result.items.length === 0) break;
      }
      if (!cancelled) setProjects(all);
    }
    void loadProjects().catch((failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [courseId]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  async function send(path: string, data: unknown) {
    setBusy(true); setError("");
    try { await call(path, "POST", data); await refresh(); setBody(""); setReason(""); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="space-y-4 p-6"><h1 className="text-2xl font-semibold">报告与贡献审阅</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <select aria-label="选择小组项目" value={projectId} onChange={(event) => { setProjectId(event.target.value); setReview(null); }}><option value="">选择项目</option>{projects.map((item) => <option value={item.project_id} key={item.project_id}>{item.project_name}</option>)}</select>
    {review && <><p>报告状态：{review.report_status} · 快照 {review.snapshot ? `v${review.snapshot.version}` : "无"}</p>
      {Object.entries(review.snapshot?.data.sections ?? {}).map(([section, text]) => <section key={section} className="rounded border bg-white p-4"><h2 className="font-semibold">{section}</h2><p className="whitespace-pre-wrap">{text}</p></section>)}
      <section className="rounded border bg-white p-4"><h2 className="font-semibold">同一报告快照的贡献与证据</h2>{review.contribution?.members.map((member) => <p key={member.user_id}>{member.user_id} · {member.share}%</p>)}{review.evidence.map((item) => <p key={item.id}>证据 {item.title}</p>)}{review.appeals.map((item) => <p key={item.id}>申诉 {item.status} · {item.reason}</p>)}</section>
      <textarea aria-label="批注或评语" className="w-full rounded border p-2" value={body} onChange={(event) => setBody(event.target.value)} />
      <button disabled={busy || !body.trim() || !review.snapshot} onClick={() => void send(`/api/v1/projects/${projectId}/teacher-report/comments`, { body })}>保存批注</button>
      {review.report_status === "submitted" && <><input aria-label="审核理由" className="rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} /><button disabled={busy || !reason.trim()} onClick={() => void send(`/api/v1/projects/${projectId}/reports/review`, { action: "return", reason })}>退回修改</button><button disabled={busy || !reason.trim()} onClick={() => void send(`/api/v1/projects/${projectId}/reports/review`, { action: "approve", reason })}>通过定稿</button></>}
      {review.report_status === "finalized" && <><input aria-label="小组分数" type="number" min={0} max={100} step="0.01" value={score} onChange={(event) => setScore(event.target.value)} /><button disabled={busy || !body.trim() || !score} onClick={() => void send(`/api/v1/projects/${projectId}/teacher-report/grades`, { score: Number(score), comment: body })}>保存分数与评语</button></>}
      <h2 className="font-semibold">批注历史</h2>{review.comments.map((item) => <p key={item.id}>{item.created_at} · {item.body}</p>)}
      <h2 className="font-semibold">评分历史</h2>{review.grades.map((item) => <p key={item.id}>{item.created_at} · {item.score} · {item.comment}</p>)}
    </>}
  </main>;
}
