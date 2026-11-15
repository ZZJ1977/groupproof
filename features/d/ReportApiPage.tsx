"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Version = { id: string; version: number; status: string; created_at: string | null; created_by: string | null; created_by_name: string | null; data: { project_name: string; counts: Record<string, number>; sections: Record<string, string> } };
type Artifact = { id: string; version: number; format: "pdf" | "docx"; status: string; requested_by: string; requested_by_name: string | null; created_at: string | null };
type Listing = { status: string; versions: Version[]; artifacts: Artifact[]; downloads: { version: number; user_id: string; user_name: string | null; format: string; created_at: string | null }[]; reviews: { action: string; reason: string; actor_id: string; actor_name: string | null; created_at: string | null }[] };

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: "include", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function ReportApiPage({ projectId, exportView }: { projectId: string; exportView: boolean }) {
  const base = `/api/v1/projects/${projectId}/reports`;
  const [listing, setListing] = useState<Listing>({ status: "draft", versions: [], artifacts: [], downloads: [], reviews: [] });
  const [selected, setSelected] = useState<number | null>(null);
  const [appendix, setAppendix] = useState(false);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileFormat, setFileFormat] = useState<"pdf" | "docx">("pdf");
  const [reviewReason, setReviewReason] = useState("");
  const refresh = useCallback(async () => setListing(await request<Listing>(base)), [base]);
  useEffect(() => { void refresh().catch((failure) => setError(failure.message)); }, [refresh]);
  useEffect(() => {
    if (listing.status !== "generating" && !listing.artifacts.some((item) => item.status === "pending" || item.status === "generating")) return;
    const timer = setInterval(() => { void refresh().catch((failure) => setError(failure.message)); }, 2000);
    return () => clearInterval(timer);
  }, [listing.artifacts, listing.status, refresh]);
  const latest = listing.versions[0];
  const viewed = listing.versions.find((version) => version.version === selected) ?? latest;
  async function mutate(url: string, body?: unknown) {
    setBusy(true); setError("");
    try { await request(url, "POST", body); await refresh(); setEditing(""); setSelected(null); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function download(artifactId: string) {
    setBusy(true); setError("");
    try {
      const link = await request<{ url: string; expires_at: string }>(`${base}/exports/${artifactId}/download-link`, "POST");
      window.location.assign(link.url);
    } catch (failure) { setError((failure as Error).message); }
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
      <button disabled={busy || ["generating", "submitted", "finalized"].includes(listing.status)} onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix })} className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50">生成新版本</button>
      <label className="block">选择版本 <select value={viewed?.version ?? ""} onChange={(event) => setSelected(Number(event.target.value))} className="rounded border p-2">{listing.versions.map((version) => <option key={version.id} value={version.version}>v{version.version} · {version.created_at?.slice(0, 10)}</option>)}</select></label>
      <label>格式 <select value={fileFormat} onChange={(event) => setFileFormat(event.target.value as "pdf" | "docx")} className="rounded border p-2"><option value="pdf">PDF</option><option value="docx">DOCX</option></select></label>
      {viewed && <button disabled={busy || !["generated", "finalized"].includes(viewed.status)} onClick={() => void mutate(`${base}/exports`, { version: viewed.version, file_format: fileFormat })} className="rounded border px-3 py-2">后台生成文件</button>}
      <h2 className="font-semibold">生成进度与导出记录</h2>{listing.artifacts.map((item) => <p key={item.id}>v{item.version} · {item.format} · {item.status} · 生成者 {item.requested_by_name ?? item.requested_by} · {item.created_at} {item.status === "ready" && <button disabled={busy} className="text-blue-700 underline" onClick={() => void download(item.id)}>获取十分钟下载链接</button>}{item.status === "failed" && <button disabled={busy} onClick={() => void mutate(`${base}/exports`, { version: item.version, file_format: item.format })}>重试</button>}</p>)}
      <h2 className="font-semibold">下载记录</h2>{listing.downloads.map((item, index) => <p key={index}>v{item.version} · {item.format} · 下载者 {item.user_name ?? item.user_id} · {item.created_at}</p>)}
      <h2 className="font-semibold">版本历史</h2>{listing.versions.map((version) => <p key={version.id}>v{version.version} · {version.status} · {version.created_at} · 生成者 {version.created_by_name ?? version.created_by ?? "历史记录"} {version.version !== latest?.version && ["generated", "returned", "failed"].includes(listing.status) && version.status === "generated" && <button disabled={busy} className="text-blue-700 underline" onClick={() => void mutate(`${base}/restore`, { version: version.version })}>恢复此版本</button>}</p>)}
      {latest && ["generated", "returned"].includes(listing.status) && <button disabled={busy} onClick={() => void mutate(`${base}/submit`)} className="rounded border px-3 py-2">提交给老师</button>}
      {listing.status === "submitted" && <div className="space-y-2"><textarea aria-label="教师审核理由" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} className="w-full rounded border p-2" placeholder="教师审核理由" /><button disabled={busy || !reviewReason.trim()} onClick={() => void mutate(`${base}/review`, { action: "return", reason: reviewReason })}>退回修改</button><button className="ml-3" disabled={busy || !reviewReason.trim()} onClick={() => void mutate(`${base}/review`, { action: "approve", reason: reviewReason })}>审核通过并定稿</button></div>}
      <h2 className="font-semibold">提交与审核历史</h2>{listing.reviews.map((item, index) => <p key={index}>{item.action} · {item.reason} · {item.actor_name ?? item.actor_id} · {item.created_at}</p>)}
    </section> : <section className="space-y-4 rounded border bg-white p-4">
      <button disabled={busy || ["generating", "submitted", "finalized"].includes(listing.status)} onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix })} className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50">刷新预览</button>
      {viewed?.status === "generating" && <p role="status">正在后台生成预览…</p>}
      {viewed?.status === "failed" && <p role="alert">预览生成失败，请重试刷新。</p>}
      {viewed ? Object.entries(viewed.data.sections ?? {}).map(([section, body]) => <article key={section} className="border-t pt-3"><h2 className="font-semibold">{section}</h2>{editing === section ? <div className="space-y-2"><textarea className="w-full rounded border p-2" rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} /><button disabled={busy || !draft.trim()} onClick={() => void mutate(`${base}/sections`, { section, body: draft, expected_version: latest.version })} className="rounded bg-blue-700 px-3 py-2 text-white">保存为新版本</button><button onClick={() => setEditing("")} className="ml-2">取消</button></div> : <><p className="whitespace-pre-wrap">{body}</p>{!["submitted", "finalized"].includes(listing.status) && viewed.version === latest.version && <button className="text-blue-700" onClick={() => { setEditing(section); setDraft(body); }}>编辑</button>}</>}</article>) : <p>尚无报告预览</p>}
    </section>}
  </main>;
}
