"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Download, Printer } from "lucide-react";
import { useApp } from "@/components/app-providers";
import { EmptyState, Feedback, PageHeader, Panel, Stat, StatusBadge } from "@/components/common";
import { button, input, label, secondary } from "@/features/b/ui";

type Version = { id: string; version: number; status: string; created_at: string | null; created_by: string | null; created_by_name: string | null; data: { project_name: string; counts: Record<string, number>; sections: Record<string, string> } };
type Artifact = { id: string; version: number; format: "pdf" | "docx"; status: string; requested_by: string; requested_by_name: string | null; created_at: string | null };
type Listing = { status: string; versions: Version[]; artifacts: Artifact[]; downloads: { version: number; user_id: string; user_name: string | null; format: string; created_at: string | null }[]; reviews: { action: string; reason: string; actor_id: string; actor_name: string | null; created_at: string | null }[] };

const sectionHeadingLabels: Record<string, string> = {
  overview: "项目概览",
  tasks: "任务进展",
  milestones: "里程碑执行",
  evidence: "正式证据统计",
  contribution: "成员贡献快照",
  risks: "风险记录",
  risk_explanation: "风险分析与建议",
  appendix: "附录：正式证据清单",
};

async function request<T>(url: string, method = "GET", body?: unknown, csrfToken?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function ReportApiPage({ projectId, exportView }: { projectId: string; exportView: boolean }) {
  const { session } = useApp();
  const csrfToken = session?.csrfToken;
  const base = `/api/v1/projects/${projectId}/reports`;
  const [listing, setListing] = useState<Listing>({ status: "draft", versions: [], artifacts: [], downloads: [], reviews: [] });
  const [selected, setSelected] = useState<number | null>(null);
  const [appendix, setAppendix] = useState(false);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileFormat, setFileFormat] = useState<"pdf" | "docx">("pdf");
  const [reviewReason, setReviewReason] = useState("");

  const refresh = useCallback(async () => setListing(await request<Listing>(base)), [base]);
  useEffect(() => { void refresh().catch((failure) => setError((failure as Error).message)); }, [refresh]);
  useEffect(() => {
    if (listing.status !== "generating" && !listing.artifacts.some((item) => item.status === "pending" || item.status === "generating")) return;
    const timer = setInterval(() => { void refresh().catch((failure) => setError((failure as Error).message)); }, 2000);
    return () => clearInterval(timer);
  }, [listing.artifacts, listing.status, refresh]);

  const latest = listing.versions[0];
  const viewed = listing.versions.find((version) => version.version === selected) ?? latest;

  async function mutate(url: string, body?: unknown, successMsg?: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(url, "POST", body, csrfToken);
      await refresh();
      setEditing("");
      setSelected(null);
      if (successMsg) setNotice(successMsg);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function download(artifactId: string) {
    setBusy(true); setError("");
    try {
      const link = await request<{ url: string; expires_at: string }>(`${base}/exports/${artifactId}/download-link`, "POST", undefined, csrfToken);
      window.location.assign(link.url);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportAndDownloadNow(versionNo: number, format: "pdf" | "docx") {
    setBusy(true); setError(""); setNotice("");
    try {
      const created = await request<{ id: string; status: string }>(
        `${base}/exports`,
        "POST",
        { version: versionNo, file_format: format },
        csrfToken,
      );
      await refresh();
      if (created.status === "ready") {
        const link = await request<{ url: string; expires_at: string }>(
          `${base}/exports/${created.id}/download-link`,
          "POST",
          undefined,
          csrfToken,
        );
        setNotice(`已生成真实 ${format.toUpperCase()} 文件并开始下载。`);
        window.location.assign(link.url);
      } else {
        setNotice(`已提交后台生成 ${format.toUpperCase()} 文件，就绪后可点击获取下载链接。`);
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <PageHeader
      title="项目报告"
      description={`状态：${listing.status} · 最新版本：${latest ? `v${latest.version}` : "尚未生成"}`}
      actions={<div className="flex flex-wrap gap-2">
        <Link className={!exportView ? button : secondary} href={`/projects/${projectId}/reports`}>预览</Link>
        <Link className={exportView ? button : secondary} href={`/projects/${projectId}/reports/export`}>导出与历史</Link>
      </div>}
    />
    {error && <div role="alert" className="mb-4"><Feedback tone="error">{error}</Feedback></div>}
    {notice && <div className="mb-4"><Feedback tone="success">{notice}</Feedback></div>}
    {viewed?.data?.counts && (
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="项目成员" value={viewed.data.counts.members ?? 0} />
        <Stat label="任务完成" value={`${viewed.data.counts.completed_tasks ?? 0} / ${viewed.data.counts.tasks ?? 0}`} />
        <Stat label="正式证据" value={viewed.data.counts.evidence ?? 0} />
        <Stat label="活跃风险" value={viewed.data.counts.risks ?? 0} />
      </div>
    )}

    {exportView ? <div className="space-y-4">
      <Panel title="导出设置">
        <div className="space-y-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={appendix} onChange={(event) => setAppendix(event.target.checked)} />包含正式证据附录</label>
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" disabled={busy || ["generating", "submitted", "finalized"].includes(listing.status)} onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix }, "报告版本已刷新。")} className={button}>生成新版本</button>
            <div>
              <label className={label} htmlFor="report-version-select">选择版本</label>
              <select id="report-version-select" value={viewed?.version ?? ""} onChange={(event) => setSelected(Number(event.target.value))} className={input}>
                {listing.versions.map((version) => <option key={version.id} value={version.version}>v{version.version} · {version.created_at?.slice(0, 10)}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="report-format-select">格式</label>
              <select id="report-format-select" value={fileFormat} onChange={(event) => setFileFormat(event.target.value as "pdf" | "docx")} className={input}>
                <option value="pdf">PDF（标准文档）</option>
                <option value="docx">DOCX（Word 文档）</option>
              </select>
            </div>
            {viewed && (
              <>
                <button type="button" disabled={busy || !["generated", "finalized"].includes(viewed.status)} onClick={() => void exportAndDownloadNow(viewed.version, fileFormat)} className={button}><Download size={14} />导出并下载 {fileFormat.toUpperCase()}</button>
                <button type="button" disabled={busy || !["generated", "finalized"].includes(viewed.status)} onClick={() => void mutate(`${base}/exports`, { version: viewed.version, file_format: fileFormat })} className={secondary}>后台生成文件</button>
                <button type="button" onClick={() => window.print()} className={secondary}><Printer size={14} />打印预览</button>
              </>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="生成进度与导出记录">
        {listing.artifacts.length === 0 ? <EmptyState title="暂无导出文件记录" description="先生成报告版本，再选择 PDF 或 DOCX 导出真实文档。" /> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {listing.artifacts.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span>v{item.version} · <strong>{item.format.toUpperCase()}</strong> · <StatusBadge tone={item.status === "ready" ? "green" : item.status === "failed" ? "red" : "amber"} label={item.status} /> · 生成者 {item.requested_by_name ?? item.requested_by} · {item.created_at?.slice(0, 19).replace("T", " ")}</span>
                <span className="flex gap-2">
                  {item.status === "ready" && <button type="button" disabled={busy} className="text-blue-700 underline" onClick={() => void download(item.id)}>获取十分钟下载链接</button>}
                  {item.status === "failed" && <button type="button" disabled={busy} className={secondary} onClick={() => void mutate(`${base}/exports`, { version: item.version, file_format: item.format })}>重试</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="版本历史与提交审核">
          {listing.versions.length === 0 ? <EmptyState title="尚未生成报告版本" /> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {listing.versions.map((version) => (
                <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>v{version.version} · {version.status} · {version.created_at?.slice(0, 19).replace("T", " ")} · 生成者 {version.created_by_name ?? version.created_by ?? "历史记录"}</span>
                  {version.version !== latest?.version && ["generated", "returned", "failed"].includes(listing.status) && version.status === "generated" && (
                    <button type="button" disabled={busy} className="text-blue-700 underline" onClick={() => void mutate(`${base}/restore`, { version: version.version })}>恢复此版本</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 space-y-3">
            {latest && ["generated", "returned"].includes(listing.status) && (
              <button type="button" disabled={busy} onClick={() => void mutate(`${base}/submit`, undefined, "已提交教师审核。")} className={button}>提交给老师</button>
            )}
            {listing.status === "submitted" && (
              <div className="space-y-2">
                <textarea aria-label="教师审核理由" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} className={input} rows={3} placeholder="教师审核理由" />
                <div className="flex gap-2">
                  <button type="button" disabled={busy || !reviewReason.trim()} className={secondary} onClick={() => void mutate(`${base}/review`, { action: "return", reason: reviewReason })}>退回修改</button>
                  <button type="button" disabled={busy || !reviewReason.trim()} className={button} onClick={() => void mutate(`${base}/review`, { action: "approve", reason: reviewReason })}>审核通过并定稿</button>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="下载与审核记录">
          <div className="space-y-3 text-sm">
            <div>
              <h3 className="mb-1 font-semibold text-slate-700">下载记录</h3>
              {listing.downloads.length === 0 ? <p className="text-xs text-slate-500">暂无下载记录</p> : listing.downloads.map((item, index) => (
                <p key={index} className="text-xs text-slate-600">v{item.version} · {item.format.toUpperCase()} · 下载者 {item.user_name ?? item.user_id} · {item.created_at?.slice(0, 19).replace("T", " ")}</p>
              ))}
            </div>
            <div className="border-t border-slate-100 pt-3">
              <h3 className="mb-1 font-semibold text-slate-700">提交与审核历史</h3>
              {listing.reviews.length === 0 ? <p className="text-xs text-slate-500">暂无审核记录</p> : listing.reviews.map((item, index) => (
                <p key={index} className="text-xs text-slate-600">{item.action} · {item.reason} · {item.actor_name ?? item.actor_id} · {item.created_at?.slice(0, 19).replace("T", " ")}</p>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </div> : <Panel title="报告内容预览" action={<button type="button" disabled={busy || ["generating", "submitted", "finalized"].includes(listing.status)} onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix }, "预览已更新。")} className={button}>刷新预览</button>}>
      {viewed?.status === "generating" && <p role="status" className="text-sm text-slate-500">正在后台生成预览…</p>}
      {viewed?.status === "failed" && <p role="alert" className="text-sm text-red-700">预览生成失败，请重试刷新。</p>}
      {viewed ? <div className="space-y-4">
        {Object.entries(viewed.data.sections ?? {}).map(([section, body]) => (
          <article key={section} className="border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
            <div className="mb-1.5 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">{sectionHeadingLabels[section] ?? section}</h2>
              {!["submitted", "finalized"].includes(listing.status) && viewed.version === latest.version && editing !== section && (
                <button type="button" className="text-xs text-blue-700 hover:underline" onClick={() => { setEditing(section); setDraft(body); }}>编辑</button>
              )}
            </div>
            {editing === section ? (
              <div className="space-y-2">
                <textarea className={input} rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} />
                <div className="flex gap-2">
                  <button type="button" disabled={busy || !draft.trim()} onClick={() => void mutate(`${base}/sections`, { section, body: draft, expected_version: latest.version }, "已保存为新版本。")} className={button}>保存为新版本</button>
                  <button type="button" onClick={() => setEditing("")} className={secondary}>取消</button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm leading-6 text-slate-700">{body}</p>
            )}
          </article>
        ))}
      </div> : <EmptyState title="尚无报告预览" description="点击右上角“刷新预览”即可从当前项目真实数据生成首版报告快照。" />}
    </Panel>}
  </div>;
}
