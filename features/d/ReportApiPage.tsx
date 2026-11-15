"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Version = { id: string; version: number; status: string; created_at: string | null; created_by: string | null; data: { project_name: string; counts: Record<string, number>; sections: Record<string, string> } };
type Listing = { status: string; versions: Version[] };

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: "include", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function ReportApiPage({ projectId, exportView }: { projectId: string; exportView: boolean }) {
  const base = `/api/v1/projects/${projectId}/reports`;
  const [listing, setListing] = useState<Listing>({ status: "draft", versions: [] });
  const [selected, setSelected] = useState<number | null>(null);
  const [appendix, setAppendix] = useState(false);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => setListing(await request<Listing>(base)), [base]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  const latest = listing.versions[0];
  const viewed = listing.versions.find((version) => version.version === selected) ?? latest;
  async function mutate(url: string, body?: unknown) {
    setBusy(true); setError("");
    try { await request(url, "POST", body); await refresh(); setEditing(""); setSelected(null); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-5xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">项目报告</h1>
    <nav className="flex gap-4 text-blue-700"><Link href={`/projects/${projectId}/reports`}>预览</Link><Link href={`/projects/${projectId}/reports/export`}>导出与历史</Link></nav>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <p>状态：{listing.status} · 最新版本：{latest ? `v${latest.version}` : "尚未生成"}</p>
    {exportView ? <section className="space-y-3 rounded border bg-white p-4">
      <h2 className="font-semibold">导出设置</h2>
      <label className="flex gap-2"><input type="checkbox" checked={appendix} onChange={(event) => setAppendix(event.target.checked)} />包含正式证据附录</label>
      <button disabled={busy || listing.status === "finalized"} onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix })} className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50">生成新版本</button>
      <label className="block">选择版本 <select value={viewed?.version ?? ""} onChange={(event) => setSelected(Number(event.target.value))} className="rounded border p-2">{listing.versions.map((version) => <option key={version.id} value={version.version}>v{version.version} · {version.created_at?.slice(0, 10)}</option>)}</select></label>
      {viewed && <div className="flex gap-3"><a href={`${base}/versions/${viewed.version}/download?file_format=pdf`} className="text-blue-700 underline">下载 PDF</a><a href={`${base}/versions/${viewed.version}/download?file_format=docx`} className="text-blue-700 underline">下载 DOCX</a></div>}
      <h2 className="font-semibold">版本历史</h2>{listing.versions.map((version) => <p key={version.id}>v{version.version} · {version.status} · {version.created_at} · 生成者 {version.created_by ?? "历史记录"}</p>)}
      {latest && listing.status !== "finalized" && <button disabled={busy} onClick={() => void mutate(`${base}/finalize`)} className="rounded border px-3 py-2">提交给老师并定稿</button>}
    </section> : <section className="space-y-4 rounded border bg-white p-4">
      <button disabled={busy || listing.status === "finalized"} onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix })} className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50">刷新预览</button>
      {viewed ? Object.entries(viewed.data.sections).map(([section, body]) => <article key={section} className="border-t pt-3"><h2 className="font-semibold">{section}</h2>{editing === section ? <div className="space-y-2"><textarea className="w-full rounded border p-2" rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} /><button disabled={busy || !draft.trim()} onClick={() => void mutate(`${base}/sections`, { section, body: draft, expected_version: latest.version })} className="rounded bg-blue-700 px-3 py-2 text-white">保存为新版本</button><button onClick={() => setEditing("")} className="ml-2">取消</button></div> : <><p className="whitespace-pre-wrap">{body}</p>{listing.status !== "finalized" && viewed.version === latest.version && <button className="text-blue-700" onClick={() => { setEditing(section); setDraft(body); }}>编辑</button>}</>}</article>) : <p>尚无报告预览</p>}
    </section>}
  </main>;
}
