"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Settings = { name: string; project_type: string | null; language: string | null;
  visibility: "members" | "course"; lifecycle: string; github: string[]; feishu_chats: number;
  archive: Record<string, unknown> | null };
type Reopen = { new_project_id: string; version_label: string; copy_scope: string; reason: string; created_at: string };

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "include", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "请求失败");
  return payload.data as T;
}

export function ProjectSettingsApiPage({ projectId, reopenView }: { projectId: string; reopenView: boolean }) {
  const base = `/api/v1/projects/${projectId}`;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<Reopen[]>([]);
  const [form, setForm] = useState({ name: "", project_type: "", language: "", visibility: "members" as "members" | "course" });
  const [version, setVersion] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"full" | "baseline">("full");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [next, versions] = await Promise.all([request<Settings>(`${base}/settings`), request<Reopen[]>(`${base}/reopens`)]);
    setSettings(next); setHistory(versions);
    setForm({ name: next.name, project_type: next.project_type ?? "", language: next.language ?? "", visibility: next.visibility });
  }, [base]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  async function save(path: string, method: string, data?: unknown) {
    setBusy(true); setError(""); setNotice("");
    try { await request(path, method, data); await refresh(); setNotice("已保存"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-4xl space-y-5 p-6"><h1 className="text-2xl font-semibold">{reopenView ? "重新开启项目" : "项目设置"}</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p>状态：{settings?.lifecycle ?? "读取中"}</p>
    {!reopenView && <><section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">基本设置</h2>
      <input aria-label="项目名称" className="w-full rounded border p-2" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      <input aria-label="项目类型" className="w-full rounded border p-2" value={form.project_type} onChange={(event) => setForm({ ...form, project_type: event.target.value })} />
      <input aria-label="项目语言" className="w-full rounded border p-2" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })} />
      <select aria-label="可见范围" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value as "members" | "course" })}><option value="members">仅项目成员</option><option value="course">课程成员</option></select>
      <button disabled={busy || settings?.lifecycle !== "active" || !form.name.trim()} onClick={() => void save(`${base}/settings`, "PUT", form)}>保存设置</button>
    </section><section className="space-y-2 rounded border bg-white p-4"><h2 className="font-semibold">真实连接状态</h2>
      <p>GitHub：{settings?.github.length ? settings.github.join("、") : "未连接"} <Link className="text-blue-700" href={`/projects/${projectId}/github`}>前往配置</Link></p>
      <p>飞书群：{settings?.feishu_chats ?? 0} 个 <Link className="text-blue-700" href={`/projects/${projectId}/collaboration`}>前往配置</Link></p>
    </section><button disabled={busy || settings?.lifecycle !== "active"} onClick={() => { if (window.confirm("确认归档？报告、任务和贡献必须已定稿。")) void save(`${base}/archive`, "POST"); }}>确认归档项目</button></>}
    {(reopenView || settings?.lifecycle === "archived") && <section className="space-y-3 rounded border bg-white p-4"><h2 className="font-semibold">重新开启</h2><input aria-label="新版本号" placeholder="新版本号" className="w-full rounded border p-2" value={version} onChange={(event) => setVersion(event.target.value)} /><textarea aria-label="重新开启原因" className="w-full rounded border p-2" value={reason} onChange={(event) => setReason(event.target.value)} /><select aria-label="复制范围" value={scope} onChange={(event) => setScope(event.target.value as "full" | "baseline")}><option value="full">复制项目结构</option><option value="baseline">仅复制基线</option></select><button disabled={busy || settings?.lifecycle !== "archived" || !version.trim() || !reason.trim()} onClick={() => void save(`${base}/reopen`, "POST", { version_label: version, reason, copy_scope: scope })}>创建新项目版本</button></section>}
    <section><h2 className="font-semibold">重新开启历史</h2>{history.map((row) => <p key={row.new_project_id}>{row.version_label} · {row.copy_scope} · {row.reason} · <Link className="text-blue-700" href={`/projects/${row.new_project_id}`}>查看新项目</Link></p>)}</section>
  </main>;
}
