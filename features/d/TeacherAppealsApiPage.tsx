"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";

type Appeal = { id: string; project_id: string; member_id: string; task_id: string; evidence_id: string; reason: string; status: string };
type Project = { project_id: string; project_name: string };

async function read<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetchWithSession(new Request(new URL(apiConfig.baseUrl + path, window.location.origin), {
    method, credentials: "include", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function TeacherAppealsApiPage({ courseId }: { courseId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const overview = await read<{ projects: Project[] }>(`/api/v1/courses/${courseId}/teacher-overview`);
    const rows = await Promise.all(overview.projects.map(async (project) =>
      (await read<Appeal[]>(`/api/v1/projects/${project.project_id}/contribution/appeals`))
        .map((appeal) => ({ ...appeal, project_id: project.project_id }))));
    setProjects(overview.projects); setAppeals(rows.flat());
  }, [courseId]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  async function decide(appeal: Appeal, action: "uphold" | "adjust" | "return") {
    setBusy(true); setError("");
    try {
      await read(`/api/v1/projects/${appeal.project_id}/contribution/appeals/${appeal.id}/decision`, "POST", {
        action, reason: reasons[appeal.id],
        adjusted_share: action === "adjust" ? Number(shares[appeal.id]) : null,
      });
      await refresh();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="space-y-4 p-6"><h1 className="text-2xl font-semibold">教师处理贡献申诉</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {appeals.map((appeal) => <article className="space-y-2 rounded border bg-white p-4" key={appeal.id}>
      <h2 className="font-semibold">{projects.find((item) => item.project_id === appeal.project_id)?.project_name} · {appeal.status}</h2>
      <p>成员 {appeal.member_id} · 任务 {appeal.task_id} · 证据 {appeal.evidence_id}</p><p>{appeal.reason}</p>
      {appeal.status === "pending" && <><textarea aria-label="处理理由" className="w-full rounded border p-2" value={reasons[appeal.id] ?? ""} onChange={(event) => setReasons({ ...reasons, [appeal.id]: event.target.value })} />
        <input aria-label="调整后贡献百分比" type="number" min={0} max={100} step="0.0001" placeholder="调整后百分比" value={shares[appeal.id] ?? ""} onChange={(event) => setShares({ ...shares, [appeal.id]: event.target.value })} />
        <div className="flex gap-3"><button disabled={busy || !reasons[appeal.id]?.trim()} onClick={() => void decide(appeal, "uphold")}>维持原结果</button><button disabled={busy || !reasons[appeal.id]?.trim() || !shares[appeal.id]} onClick={() => void decide(appeal, "adjust")}>调整贡献</button><button disabled={busy || !reasons[appeal.id]?.trim()} onClick={() => void decide(appeal, "return")}>退回补证</button></div></>}
    </article>)}
    {!appeals.length && <p>暂无申诉。</p>}
  </main>;
}
