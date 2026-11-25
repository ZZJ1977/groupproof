"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  History,
  Pencil,
  Printer,
  RefreshCw,
  Send,
} from "lucide-react";
import { Feedback, StatusBadge } from "@/components/common";
import { button, input, secondary } from "@/features/b/ui";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";

type Version = {
  id: string;
  version: number;
  status: string;
  created_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  data: { project_name: string; counts: Record<string, number>; sections: Record<string, string> };
};
type Artifact = {
  id: string;
  version: number;
  format: "pdf" | "docx";
  status: string;
  requested_by: string;
  requested_by_name: string | null;
  created_at: string | null;
};
type Listing = {
  status: string;
  versions: Version[];
  artifacts: Artifact[];
  downloads: { version: number; user_id: string; user_name: string | null; format: string; created_at: string | null }[];
  reviews: { action: string; reason: string; actor_id: string; actor_name: string | null; created_at: string | null }[];
};

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

const statusMeta: Record<string, { label: string; tone: "blue" | "green" | "amber" | "red" | "gray" }> = {
  draft: { label: "草稿", tone: "gray" },
  generating: { label: "生成中", tone: "blue" },
  generated: { label: "已生成", tone: "blue" },
  returned: { label: "已退回修改", tone: "amber" },
  submitted: { label: "已提交审核", tone: "amber" },
  finalized: { label: "已定稿", tone: "green" },
  failed: { label: "生成失败", tone: "red" },
};

const compactBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const compactPrimaryBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const compactSelect =
  "h-8 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetchWithSession(
    new Request(new URL(apiConfig.baseUrl + url, window.location.origin), {
      method,
      credentials: "include",
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? "请求失败");
  return result.data as T;
}

export function ReportApiPage({
  projectId,
  exportView = false,
  embedded = false,
}: {
  projectId: string;
  exportView?: boolean;
  embedded?: boolean;
}) {
  const base = `/api/v1/projects/${projectId}/reports`;
  const [listing, setListing] = useState<Listing>({ status: "draft", versions: [], artifacts: [], downloads: [], reviews: [] });
  const [embeddedMode, setEmbeddedMode] = useState<"preview" | "export">(exportView ? "export" : "preview");
  const isExportView = embedded ? embeddedMode === "export" : exportView;
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
  useEffect(() => {
    void refresh().catch((failure) => setError((failure as Error).message));
  }, [refresh]);
  useEffect(() => {
    if (listing.status !== "generating" && !listing.artifacts.some((item) => item.status === "pending" || item.status === "generating")) return;
    const timer = setInterval(() => {
      void refresh().catch((failure) => setError((failure as Error).message));
    }, 2000);
    return () => clearInterval(timer);
  }, [listing.artifacts, listing.status, refresh]);

  const latest = listing.versions[0];
  const viewed = listing.versions.find((version) => version.version === selected) ?? latest;
  const st = statusMeta[listing.status] ?? { label: listing.status, tone: "gray" as const };
  const canRefresh = !busy && !["generating", "submitted", "finalized"].includes(listing.status);
  const canExport = Boolean(viewed && !busy && ["generated", "finalized"].includes(viewed.status));
  const canSubmit = Boolean(latest && ["generated", "returned"].includes(listing.status));
  const sectionEntries = Object.entries(viewed?.data?.sections ?? {});

  async function mutate(url: string, body?: unknown, successMsg?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(url, "POST", body);
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
    setBusy(true);
    setError("");
    try {
      const link = await request<{ url: string; expires_at: string }>(`${base}/exports/${artifactId}/download-link`, "POST");
      window.location.assign(link.url);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportAndDownloadNow(versionNo: number, format: "pdf" | "docx") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await request<{ id: string; status: string }>(`${base}/exports`, "POST", {
        version: versionNo,
        file_format: format,
      });
      await refresh();
      if (created.status === "ready") {
        const link = await request<{ url: string; expires_at: string }>(
          `${base}/exports/${created.id}/download-link`,
          "POST",
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

  const versionHistoryCard = (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <History size={15} className="text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-900">版本历史与提交审核</h2>
        </div>
        <span className="text-xs text-slate-500">{listing.versions.length} 个版本</span>
      </div>

      {listing.versions.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-3 text-center text-xs text-slate-500">尚未生成报告版本</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-xs">
          {listing.versions.map((version) => {
            const isActive = viewed?.version === version.version;
            const vMeta = statusMeta[version.status] ?? { label: version.status, tone: "gray" as const };
            return (
              <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(version.version);
                    setEditing("");
                  }}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors ${
                    isActive ? "bg-sky-50/80 text-sky-900" : "hover:bg-slate-50 text-slate-700"
                  }`}
                >
                  <span className="font-mono font-semibold">v{version.version}</span>
                  <StatusBadge tone={vMeta.tone} label={vMeta.label} />
                  <span className="truncate text-slate-500">
                    {version.created_by_name ?? version.created_by ?? "历史记录"} · {version.created_at?.slice(0, 16).replace("T", " ")}
                  </span>
                </button>
                {version.version !== latest?.version &&
                  ["generated", "returned", "failed"].includes(listing.status) &&
                  version.status === "generated" && (
                    <button
                      type="button"
                      disabled={busy}
                      className="shrink-0 text-xs font-medium text-sky-700 hover:underline disabled:opacity-50"
                      onClick={() => void mutate(`${base}/restore`, { version: version.version }, `已恢复至 v${version.version}。`)}
                    >
                      恢复此版本
                    </button>
                  )}
              </li>
            );
          })}
        </ul>
      )}

      {(canSubmit || listing.status === "submitted") && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {canSubmit && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(`${base}/submit`, undefined, "已提交教师审核。")}
              className={`${compactPrimaryBtn} w-full`}
            >
              <Send size={13} />
              提交给老师定稿
            </button>
          )}
          {listing.status === "submitted" && (
            <div className="space-y-2">
              <textarea
                aria-label="教师审核理由"
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
                className={`${input} text-xs`}
                rows={2}
                placeholder="填写教师审核理由"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !reviewReason.trim()}
                  className={`${compactBtn} flex-1`}
                  onClick={() => void mutate(`${base}/review`, { action: "return", reason: reviewReason }, "已退回修改。")}
                >
                  退回修改
                </button>
                <button
                  type="button"
                  disabled={busy || !reviewReason.trim()}
                  className={`${compactPrimaryBtn} flex-1`}
                  onClick={() => void mutate(`${base}/review`, { action: "approve", reason: reviewReason }, "已审核通过并定稿。")}
                >
                  <CheckCircle2 size={13} />
                  审核通过并定稿
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );

  const exportControlsCard = (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">导出与快照设置</h2>
        {viewed && <span className="font-mono text-xs text-slate-500">当前 v{viewed.version}</span>}
      </div>
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block font-medium text-slate-600" htmlFor="report-version-select">
              选择版本
            </label>
            <select
              id="report-version-select"
              value={viewed?.version ?? ""}
              onChange={(event) => setSelected(Number(event.target.value))}
              className={`${compactSelect} w-full`}
              disabled={listing.versions.length === 0}
            >
              {listing.versions.length === 0 && <option value="">尚未生成</option>}
              {listing.versions.map((version) => (
                <option key={version.id} value={version.version}>
                  v{version.version} · {version.created_at?.slice(0, 10)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block font-medium text-slate-600" htmlFor="report-format-select">
              导出格式
            </label>
            <select
              id="report-format-select"
              value={fileFormat}
              onChange={(event) => setFileFormat(event.target.value as "pdf" | "docx")}
              className={`${compactSelect} w-full`}
            >
              <option value="pdf">PDF（标准文档）</option>
              <option value="docx">DOCX（Word 文档）</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-slate-600">
          <input
            type="checkbox"
            checked={appendix}
            onChange={(event) => setAppendix(event.target.checked)}
            className="rounded border-slate-300"
          />
          生成新版本时包含正式证据附录
        </label>
        <div className="flex flex-wrap gap-2 pt-0.5">
          {viewed ? (
            <>
              <button
                type="button"
                disabled={!canExport}
                onClick={() => void exportAndDownloadNow(viewed.version, fileFormat)}
                className={`${compactPrimaryBtn} flex-1`}
              >
                <Download size={13} />
                导出并下载 {fileFormat.toUpperCase()}
              </button>
              <button type="button" onClick={() => window.print()} className={compactBtn}>
                <Printer size={13} />
                打印
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!canRefresh}
              onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix }, "首版报告快照已生成。")}
              className={`${compactPrimaryBtn} w-full`}
            >
              <RefreshCw size={13} />
              生成首版报告快照
            </button>
          )}
        </div>
        {viewed && (
          <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
            <span>基于项目当前真实数据生成快照</span>
            <button
              type="button"
              disabled={!canExport}
              onClick={() => void mutate(`${base}/exports`, { version: viewed.version, file_format: fileFormat }, "已提交后台生成任务。")}
              className="font-medium text-sky-700 hover:underline disabled:opacity-50"
            >
              后台生成文件
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const auditLogsCard = (
    <details className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs" open={isExportView && (listing.downloads.length > 0 || listing.reviews.length > 0)}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-slate-900">
        <span>导出文件与审核记录（{listing.artifacts.length + listing.downloads.length + listing.reviews.length}）</span>
        <ChevronDown size={15} className="text-slate-400" />
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        {!isExportView && listing.artifacts.length > 0 && (
          <div>
            <h3 className="mb-1.5 font-semibold text-slate-700">最近导出文件</h3>
            <ul className="divide-y divide-slate-100">
              {listing.artifacts.slice(0, 4).map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="truncate text-slate-600">
                    v{item.version} · {item.format.toUpperCase()} ·{" "}
                    <StatusBadge tone={item.status === "ready" ? "green" : item.status === "failed" ? "red" : "amber"} label={item.status} />
                  </span>
                  {item.status === "ready" && (
                    <button type="button" disabled={busy} className="shrink-0 font-medium text-sky-700 hover:underline" onClick={() => void download(item.id)}>
                      下载
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className={!isExportView && listing.artifacts.length > 0 ? "border-t border-slate-100 pt-2.5" : ""}>
          <h3 className="mb-1 font-semibold text-slate-700">下载记录（{listing.downloads.length}）</h3>
          {listing.downloads.length === 0 ? (
            <p className="text-slate-500">暂无下载记录</p>
          ) : (
            <div className="space-y-1">
              {listing.downloads.map((item, index) => (
                <p key={index} className="text-slate-600">
                  v{item.version} · {item.format.toUpperCase()} · {item.user_name ?? item.user_id} · {item.created_at?.slice(0, 16).replace("T", " ")}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-slate-100 pt-2.5">
          <h3 className="mb-1 font-semibold text-slate-700">提交与审核历史（{listing.reviews.length}）</h3>
          {listing.reviews.length === 0 ? (
            <p className="text-slate-500">暂无审核记录</p>
          ) : (
            <div className="space-y-1">
              {listing.reviews.map((item, index) => (
                <p key={index} className="text-slate-600">
                  {item.action} · {item.reason} · {item.actor_name ?? item.actor_id} · {item.created_at?.slice(0, 16).replace("T", " ")}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </details>
  );

  return (
    <div className="space-y-3.5">
      {/* Compact Header with Inline Status Pill + Primary Actions */}
      <div className={`${embedded ? "rounded-2xl border border-slate-200/85 bg-white px-4 py-3 shadow-xs" : "mb-3.5"} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex flex-wrap items-center gap-2.5">
          {embedded ? (
            <h2 className="text-sm font-semibold text-slate-900">结项报告</h2>
          ) : (
            <h1 className="text-xl font-bold tracking-tight text-slate-900">项目报告</h1>
          )}
          <StatusBadge tone={st.tone} label={st.label} />
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-xs font-medium text-slate-600">
            {latest ? `最新 v${latest.version}` : "尚未生成"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {embedded ? (
            <div className="gp-segmented" role="tablist" aria-label="报告视图">
              <button
                type="button"
                role="tab"
                aria-selected={!isExportView}
                data-active={!isExportView ? "true" : undefined}
                className="gp-segmented-item"
                onClick={() => setEmbeddedMode("preview")}
              >
                预览
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isExportView}
                data-active={isExportView ? "true" : undefined}
                className="gp-segmented-item"
                onClick={() => setEmbeddedMode("export")}
              >
                导出与历史
              </button>
            </div>
          ) : (
            <div className="gp-segmented" role="navigation" aria-label="报告视图">
              <Link className="gp-segmented-item" data-active={!isExportView ? "true" : undefined} href={`/projects/${projectId}/reports`}>
                预览
              </Link>
              <Link className="gp-segmented-item" data-active={isExportView ? "true" : undefined} href={`/projects/${projectId}/reports/export`}>
                导出与历史
              </Link>
            </div>
          )}
          <button
            type="button"
            disabled={!canRefresh}
            onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix }, "报告版本已刷新。")}
            className={compactPrimaryBtn}
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            {latest ? "刷新预览" : "生成预览"}
          </button>
          {canSubmit && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(`${base}/submit`, undefined, "已提交教师审核。")}
              className={compactBtn}
            >
              <Send size={13} />
              提交定稿
            </button>
          )}
          {viewed && (
            <button
              type="button"
              disabled={!canExport}
              onClick={() => void exportAndDownloadNow(viewed.version, fileFormat)}
              className={compactBtn}
            >
              <Download size={13} />
              导出 {fileFormat.toUpperCase()}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert">
          <Feedback tone="error">{error}</Feedback>
        </div>
      )}
      {notice && <Feedback tone="success">{notice}</Feedback>}

      {/* Inline KPI Divider Strip */}
      {viewed?.data?.counts && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-2.5 text-xs shadow-xs">
          <div className="flex items-baseline gap-1.5">
            <span className="text-slate-500">项目成员</span>
            <span className="font-mono text-sm font-bold text-slate-900">{viewed.data.counts.members ?? 0}</span>
          </div>
          <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-slate-500">任务完成</span>
            <span className="font-mono text-sm font-bold text-emerald-700">
              {viewed.data.counts.completed_tasks ?? 0} / {viewed.data.counts.tasks ?? 0}
            </span>
          </div>
          <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-slate-500">正式证据</span>
            <span className="font-mono text-sm font-bold text-sky-700">{viewed.data.counts.evidence ?? 0}</span>
          </div>
          <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-slate-500">活跃风险</span>
            <span className="font-mono text-sm font-bold text-amber-700">{viewed.data.counts.risks ?? 0}</span>
          </div>
          {viewed.created_at && (
            <span className="ml-auto text-[11px] text-slate-400">
              快照时间：{viewed.created_at.slice(0, 16).replace("T", " ")}
            </span>
          )}
        </div>
      )}

      {isExportView ? (
        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)] xl:items-start">
          <div className="space-y-3.5">
            {exportControlsCard}

            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">生成进度与导出记录</h2>
                <span className="text-xs text-slate-500">{listing.artifacts.length} 份文件</span>
              </div>
              {listing.artifacts.length === 0 ? (
                <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                  暂无导出文件记录，生成报告版本后可一键导出 PDF 或 DOCX。
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 text-slate-500">
                        <th className="pb-2 font-medium">版本 / 格式</th>
                        <th className="pb-2 font-medium">状态</th>
                        <th className="pb-2 font-medium">生成者</th>
                        <th className="pb-2 font-medium">时间</th>
                        <th className="pb-2 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {listing.artifacts.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50/60">
                          <td className="py-2.5 font-mono font-medium text-slate-900">
                            v{item.version} · {item.format.toUpperCase()}
                          </td>
                          <td className="py-2.5">
                            <StatusBadge
                              tone={item.status === "ready" ? "green" : item.status === "failed" ? "red" : "amber"}
                              label={item.status}
                            />
                          </td>
                          <td className="py-2.5 text-slate-600">{item.requested_by_name ?? item.requested_by}</td>
                          <td className="py-2.5 text-slate-500">{item.created_at?.slice(0, 16).replace("T", " ")}</td>
                          <td className="py-2.5 text-right">
                            {item.status === "ready" && (
                              <button
                                type="button"
                                disabled={busy}
                                className="font-medium text-sky-700 hover:underline disabled:opacity-50"
                                onClick={() => void download(item.id)}
                              >
                                获取十分钟下载链接
                              </button>
                            )}
                            {item.status === "failed" && (
                              <button
                                type="button"
                                disabled={busy}
                                className={compactBtn}
                                onClick={() => void mutate(`${base}/exports`, { version: item.version, file_format: item.format })}
                              >
                                重试
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <div className="space-y-3.5 xl:sticky xl:top-4">
            {versionHistoryCard}
            {auditLogsCard}
          </div>
        </div>
      ) : (
        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.5fr)_minmax(310px,1fr)] xl:items-start">
          {/* Left / Main: Structured Report Preview */}
          <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-sky-600" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {viewed ? `${viewed.data.project_name || "项目报告"} · v${viewed.version}` : "报告内容预览"}
                </h2>
              </div>
              {sectionEntries.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {sectionEntries.map(([section]) => (
                    <a
                      key={section}
                      href={`#report-sec-${section}`}
                      className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-sky-50 hover:text-sky-700"
                    >
                      {sectionHeadingLabels[section] ?? section}
                    </a>
                  ))}
                </div>
              )}
            </div>

            {viewed?.status === "generating" && (
              <p role="status" className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700">
                正在后台生成预览…
              </p>
            )}
            {viewed?.status === "failed" && (
              <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                预览生成失败，请重试刷新。
              </p>
            )}

            {viewed ? (
              <div className="divide-y divide-slate-100">
                {sectionEntries.map(([section, body]) => (
                  <article id={`report-sec-${section}`} key={section} className="py-3 first:pt-0 last:pb-0">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">{sectionHeadingLabels[section] ?? section}</h3>
                      {!["submitted", "finalized"].includes(listing.status) &&
                        viewed.version === latest?.version &&
                        editing !== section && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
                            onClick={() => {
                              setEditing(section);
                              setDraft(body);
                            }}
                          >
                            <Pencil size={12} />
                            编辑
                          </button>
                        )}
                    </div>
                    {editing === section ? (
                      <div className="space-y-2">
                        <textarea
                          className={input}
                          rows={5}
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy || !draft.trim()}
                            onClick={() =>
                              void mutate(
                                `${base}/sections`,
                                { section, body: draft, expected_version: latest.version },
                                "已保存为新版本。",
                              )
                            }
                            className={button}
                          >
                            保存为新版本
                          </button>
                          <button type="button" onClick={() => setEditing("")} className={secondary}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap rounded-xl bg-slate-50/85 px-3.5 py-2.5 text-sm leading-6 text-slate-700">
                        {body}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50/80 px-4 py-8 text-center">
                <p className="text-sm font-semibold text-slate-700">尚无报告预览</p>
                <p className="mt-1 text-xs text-slate-500">基于当前任务、正式证据、贡献与风险数据自动汇编首版报告快照。</p>
                <button
                  type="button"
                  disabled={!canRefresh}
                  onClick={() => void mutate(`${base}/refresh`, { includes_appendix: appendix }, "首版报告预览已生成。")}
                  className={`${compactPrimaryBtn} mt-3`}
                >
                  <RefreshCw size={13} />
                  生成首版预览
                </button>
              </div>
            )}
          </section>

          {/* Right Sticky Column: Export, Version History, Audit */}
          <div className="space-y-3.5 xl:sticky xl:top-4">
            {exportControlsCard}
            {versionHistoryCard}
            {auditLogsCard}
          </div>
        </div>
      )}
    </div>
  );
}
