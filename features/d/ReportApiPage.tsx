"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  History,
  Pencil,
  Printer,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import { Feedback, StatusBadge } from "@/components/common";
import { button, input, secondary } from "@/features/b/ui";
import { MarkdownPreview } from "@/features/c/MarkdownPreview";
import { fetchWithSession } from "@/lib/api/client";
import { apiConfig } from "@/lib/api/config";

type VersionMeta = {
  authoring_mode?: string;
  model?: string | null;
  generated_at?: string;
  contribution_status?: string;
  milestones_completed?: number;
  milestones_total?: number;
  github_commits?: number;
  feishu_conclusions?: number;
};

type Version = {
  id: string;
  version: number;
  status: string;
  created_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  data: {
    project_name: string;
    counts: Record<string, number>;
    chapter_order?: string[];
    sections: Record<string, string>;
    meta?: VersionMeta;
  };
};

type Artifact = {
  id: string;
  version: number;
  format: "pdf" | "docx";
  status: string;
  error?: string | null;
  requested_by: string;
  requested_by_name: string | null;
  created_at: string | null;
};

type ExportFormat = "pdf" | "docx" | "md";
type BusyAction = null | "refresh" | "export" | "download" | "submit" | "review" | "edit" | "restore" | "rewrite";

type Listing = {
  status: string;
  versions: Version[];
  artifacts: Artifact[];
  downloads: { version: number; user_id: string; user_name: string | null; format: string; created_at: string | null }[];
  reviews: { action: string; reason: string; actor_id: string; actor_name: string | null; created_at: string | null }[];
};

const CHAPTER_ORDER = [
  "overview",
  "workflow",
  "progress",
  "collaboration",
  "evidence",
  "contribution",
  "reflection",
] as const;

const sectionHeadingLabels: Record<string, string> = {
  overview: "一、项目概述与目标范围",
  workflow: "二、开发流程与团队协作机制",
  progress: "三、项目进度与里程碑复盘",
  collaboration: "四、团队沟通协作与关键技术决策",
  evidence: "五、证据链沉淀与质量验收成果",
  contribution: "六、成员个人贡献与分工画像",
  reflection: "七、风险复盘与后续改进建议",
  tasks: "任务进展",
  milestones: "里程碑执行",
  risks: "风险记录",
  risk_explanation: "风险分析与建议",
  appendix: "附录：正式证据清单",
};

const shortChapterLabels: Record<string, string> = {
  overview: "1. 项目概述",
  workflow: "2. 开发流程",
  progress: "3. 进度里程碑",
  collaboration: "4. 沟通与决策",
  evidence: "5. 证据与验收",
  contribution: "6. 成员贡献",
  reflection: "7. 风险与建议",
  tasks: "任务进展",
  milestones: "里程碑",
  risks: "风险记录",
  risk_explanation: "风险分析",
  appendix: "附录",
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

const ERROR_MESSAGES: Record<string, string> = {
  REPORT_WRITE_DENIED: "仅项目组长或任课教师可生成、刷新或编辑结项报告。",
  REPORT_FINALIZE_DENIED: "仅项目组长可提交结项报告给教师定稿。",
  REPORT_REVIEW_DENIED: "仅该课程任课教师可审核结项报告。",
  PROJECT_READ_ONLY: "当前项目已归档或只读，无法修改报告。",
  REPORT_GENERATING: "报告预览正在生成中，请稍候片刻。",
  REPORT_READ_ONLY: "报告正在审核中或已定稿，暂不支持重新生成。",
  REPORT_NOT_READY: "报告预览尚未完成，请稍后重试。",
  REPORT_WORKER_UNAVAILABLE: "报告生成服务暂时不可用，请稍后重试。",
  REPORT_PREVIEW_FAILED: "报告预览生成失败，请点击重试。",
  REPORT_EXPORT_FAILED: "报告文件导出失败，请点击重试。",
  REPORT_LINK_EXPIRED: "下载链接已过期，请重新点击下载。",
  AI_UNAVAILABLE: "AI 重写服务暂时不可用，请稍后重试或手动编辑。",
};

function extractErrorMessage(result: unknown, fallback = "请求失败"): string {
  if (result && typeof result === "object") {
    const obj = result as { error?: { code?: string; message?: string }; detail?: string };
    const code = obj.error?.code;
    if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    if (obj.error?.message) return obj.error.message;
    if (typeof obj.detail === "string" && obj.detail) return obj.detail;
  }
  return fallback;
}

function parseFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const utf8Match = /filename\*=UTF-8''([^;\n]+)/i.exec(disposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      // fall through
    }
  }
  const plainMatch = /filename="?([^";\n]+)"?/i.exec(disposition);
  if (plainMatch?.[1]) return plainMatch[1].trim();
  return fallback;
}

function safeFileStem(name: string | undefined): string {
  return (name || "GroupProof").replace(/[\\/:*?"<>|]+/g, "-").trim() || "GroupProof";
}

function formatLabel(format: ExportFormat): string {
  if (format === "md") return "Markdown";
  return format.toUpperCase();
}

function resolveOrderedSections(data: Version["data"] | undefined): [string, string][] {
  const sections = data?.sections;
  if (!sections) return [];
  const rawOrder = data?.chapter_order;
  if (Array.isArray(rawOrder) && rawOrder.length > 0) {
    return rawOrder.filter((key) => key in sections).map((key) => [key, sections[key] ?? ""]);
  }
  const canonical = CHAPTER_ORDER.filter((key) => key in sections);
  const legacyOrder = ["tasks", "milestones", "risks", "risk_explanation", "appendix"];
  const rest = legacyOrder.filter((key) => key in sections && !canonical.includes(key as (typeof CHAPTER_ORDER)[number]));
  const extras = Object.keys(sections).filter(
    (key) => !canonical.includes(key as (typeof CHAPTER_ORDER)[number]) && !rest.includes(key),
  );
  return [...canonical, ...rest, ...extras].map((key) => [key, sections[key] ?? ""]);
}

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
  if (!response.ok) throw new Error(extractErrorMessage(result, `请求失败（HTTP ${response.status}）`));
  return result.data as T;
}

async function downloadBinaryFromApi(url: string, fallbackFilename: string): Promise<void> {
  const fullUrl = new URL(apiConfig.baseUrl + url, window.location.origin);
  const response = await fetch(fullUrl, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(extractErrorMessage(result, `文件下载失败（HTTP ${response.status}）`));
  }
  const blob = await response.blob();
  const filename = parseFilename(response.headers.get("content-disposition"), fallbackFilename);
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
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
  const [readMode, setReadMode] = useState<"chapter" | "full">("chapter");
  const [activeChapter, setActiveChapter] = useState<string>("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [rewritingSection, setRewritingSection] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileFormat, setFileFormat] = useState<ExportFormat>("pdf");
  const [reviewReason, setReviewReason] = useState("");
  const readerScrollRef = useRef<HTMLDivElement>(null);
  const busy = busyAction !== null;

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
  const canEditChapter = Boolean(viewed && !["submitted", "finalized"].includes(listing.status) && viewed.version === latest?.version);

  const sectionEntries = useMemo(() => resolveOrderedSections(viewed?.data), [viewed?.data]);
  const resolvedActiveChapter = useMemo(() => {
    if (sectionEntries.length === 0) return "";
    if (activeChapter && sectionEntries.some(([key]) => key === activeChapter)) return activeChapter;
    return sectionEntries[0][0];
  }, [activeChapter, sectionEntries]);

  const activeChapterIndex = sectionEntries.findIndex(([key]) => key === resolvedActiveChapter);
  const visibleEntries = useMemo(() => {
    if (readMode === "full") return sectionEntries;
    const current = sectionEntries.find(([key]) => key === resolvedActiveChapter);
    return current ? [current] : sectionEntries.slice(0, 1);
  }, [readMode, resolvedActiveChapter, sectionEntries]);

  const isRefreshing = busyAction === "refresh";
  const isExporting = busyAction === "export" || busyAction === "download";
  const isAiAuthored = viewed?.data?.meta?.authoring_mode === "ai";

  async function mutate(url: string, body?: unknown, successMsg?: string, action: BusyAction = "edit") {
    setBusyAction(action);
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
      setBusyAction(null);
    }
  }

  async function refreshPreview(initial: boolean) {
    setBusyAction("refresh");
    setError("");
    setNotice("");
    try {
      const created = await request<{ version: number; status: string; data?: Version["data"] }>(
        `${base}/refresh`,
        "POST",
        { includes_appendix: false },
      );
      await refresh();
      setEditing("");
      setSelected(null);
      if (created.status === "generating") {
        setNotice(`已提交 v${created.version} 报告生成任务，正在后台汇编预览…`);
      } else {
        const aiTag = created.data?.meta?.authoring_mode === "ai" ? "（AI 深度撰写）" : "";
        setNotice(
          initial
            ? `首版 7 章结项报告（v${created.version}）已生成${aiTag}。`
            : `报告已刷新至 v${created.version}${aiTag}。`,
        );
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function rewriteChapterWithAi(versionNo: number, sectionKey: string) {
    setBusyAction("rewrite");
    setRewritingSection(sectionKey);
    setError("");
    setNotice("");
    try {
      const updated = await request<{ version: number; authoring_mode?: string }>(
        `${base}/versions/${versionNo}/sections/${encodeURIComponent(sectionKey)}/ai-rewrite`,
        "POST",
        { instruction: "" },
      );
      await refresh();
      setEditing("");
      setSelected(null);
      setActiveChapter(sectionKey);
      const label = sectionHeadingLabels[sectionKey] ?? sectionKey;
      setNotice(
        updated.authoring_mode === "ai"
          ? `AI 已重写「${label}」并保存为 v${updated.version}。`
          : `已按最新真实数据重新汇编「${label}」并保存为 v${updated.version}。`,
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
      setRewritingSection(null);
    }
  }

  async function download(artifactId: string, versionNo?: number, fmt?: "pdf" | "docx") {
    setBusyAction("download");
    setError("");
    setNotice("");
    try {
      const link = await request<{ url: string; expires_at: string }>(`${base}/exports/${artifactId}/download-link`, "POST");
      const stem = safeFileStem(viewed?.data?.project_name);
      const fallback = `${stem}-结项报告-v${versionNo ?? viewed?.version ?? 1}.${fmt ?? "pdf"}`;
      await downloadBinaryFromApi(link.url, fallback);
      await refresh();
      setNotice(`已开始下载 ${(fmt ?? "pdf").toUpperCase()} 报告文件。`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function exportAndDownloadNow(versionNo: number, format: ExportFormat) {
    setBusyAction("export");
    setError("");
    setNotice("");
    const stem = safeFileStem(viewed?.data?.project_name);
    try {
      if (format === "md") {
        await downloadBinaryFromApi(
          `${base}/versions/${versionNo}/markdown`,
          `${stem}-结项报告-v${versionNo}.md`,
        );
        setNotice(`已生成并开始下载 v${versionNo} Markdown (.md) 报告。`);
        return;
      }
      const created = await request<{ id: string; status: string }>(`${base}/exports`, "POST", {
        version: versionNo,
        file_format: format,
      });
      let status = created.status;
      let exportError: string | null = null;
      if (status === "pending" || status === "generating") {
        for (let attempt = 0; attempt < 25; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
          const polled = await request<{ id: string; status: string; error?: string | null }>(
            `${base}/exports/${created.id}`,
          );
          status = polled.status;
          exportError = polled.error ?? null;
          if (status === "ready" || status === "failed") break;
        }
      }
      if (status === "failed") {
        await refresh();
        throw new Error(exportError || `导出 ${format.toUpperCase()} 文件失败，请重试。`);
      }
      if (status === "ready") {
        const link = await request<{ url: string; expires_at: string }>(
          `${base}/exports/${created.id}/download-link`,
          "POST",
        );
        await downloadBinaryFromApi(link.url, `${stem}-结项报告-v${versionNo}.${format}`);
        await refresh();
        setNotice(`已生成真实 ${format.toUpperCase()} 文件并开始下载。`);
      } else {
        await refresh();
        setNotice(`已提交后台生成 ${format.toUpperCase()} 文件，就绪后可在下方导出记录中下载。`);
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  function selectChapter(sectionKey: string) {
    setActiveChapter(sectionKey);
    setEditing("");
    if (readMode === "full" && readerScrollRef.current) {
      const target = readerScrollRef.current.querySelector<HTMLElement>(`#report-sec-${sectionKey}`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } else if (readerScrollRef.current) {
      readerScrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const versionHistoryCard = (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <History size={15} className="text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-900">版本历史与提交审核</h2>
        </div>
        <span className="text-xs text-slate-500">{listing.versions.length} 个版本</span>
      </div>

      {listing.versions.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-3 text-center text-xs text-slate-500">尚未生成报告版本</p>
      ) : (
        <ul className="max-h-44 divide-y divide-slate-100 overflow-y-auto text-xs">
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
                      onClick={() => void mutate(`${base}/restore`, { version: version.version }, `已恢复至 v${version.version}。`, "restore")}
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
              onClick={() => void mutate(`${base}/submit`, undefined, "已提交教师审核。", "submit")}
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
                  onClick={() => void mutate(`${base}/review`, { action: "return", reason: reviewReason }, "已退回修改。", "review")}
                >
                  退回修改
                </button>
                <button
                  type="button"
                  disabled={busy || !reviewReason.trim()}
                  className={`${compactPrimaryBtn} flex-1`}
                  onClick={() => void mutate(`${base}/review`, { action: "approve", reason: reviewReason }, "已审核通过并定稿。", "review")}
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
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">导出与快照设置</h2>
        {viewed && <span className="font-mono text-xs text-slate-500">当前 v{viewed.version}</span>}
      </div>
      <div className="space-y-2.5 text-xs">
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
              onChange={(event) => setFileFormat(event.target.value as ExportFormat)}
              className={`${compactSelect} w-full`}
            >
              <option value="pdf">PDF（标准排版）</option>
              <option value="docx">DOCX（Word 文档）</option>
              <option value="md">Markdown（.md）</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-0.5">
          {viewed ? (
            <>
              <button
                type="button"
                disabled={!canExport}
                onClick={() => void exportAndDownloadNow(viewed.version, fileFormat)}
                className={`${compactPrimaryBtn} flex-1`}
              >
                <Download size={13} className={isExporting ? "animate-bounce" : ""} />
                {isExporting ? `正在导出 ${formatLabel(fileFormat)}…` : `导出并下载 ${formatLabel(fileFormat)}`}
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
              onClick={() => void refreshPreview(true)}
              className={`${compactPrimaryBtn} w-full`}
            >
              <Sparkles size={13} className={isRefreshing ? "animate-pulse" : ""} />
              {isRefreshing ? "AI 正在撰写 7 章报告…" : "AI 生成首版结项报告"}
            </button>
          )}
        </div>
      </div>
    </section>
  );

  const auditLogsCard = (
    <details
      className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
      open={isExportView && (listing.downloads.length > 0 || listing.reviews.length > 0)}
    >
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
                    <button
                      type="button"
                      disabled={busy}
                      className="shrink-0 font-medium text-sky-700 hover:underline"
                      onClick={() => void download(item.id, item.version, item.format)}
                    >
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
              {listing.downloads.slice(0, 6).map((item, index) => (
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
    <div className="space-y-3">
      {/* Compact Header with Inline Status Pill + Primary Actions */}
      <div className={`${embedded ? "rounded-2xl border border-slate-200/85 bg-white px-4 py-2.5 shadow-xs" : "mb-3"} flex flex-wrap items-center justify-between gap-2.5`}>
        <div className="flex flex-wrap items-center gap-2">
          {embedded ? (
            <h2 className="text-sm font-semibold text-slate-900">结项报告</h2>
          ) : (
            <h1 className="text-xl font-bold tracking-tight text-slate-900">项目结项报告</h1>
          )}
          <StatusBadge tone={st.tone} label={st.label} />
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-xs font-medium text-slate-600">
            {latest ? `最新 v${latest.version}` : "尚未生成"}
          </span>
          {viewed?.data?.counts && (
            <span className="hidden items-center gap-2 text-xs text-slate-500 lg:inline-flex">
              <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
              <span>成员 <strong className="font-mono text-slate-800">{viewed.data.counts.members ?? 0}</strong></span>
              <span>任务 <strong className="font-mono text-emerald-700">{viewed.data.counts.completed_tasks ?? 0}/{viewed.data.counts.tasks ?? 0}</strong></span>
              <span>证据 <strong className="font-mono text-sky-700">{viewed.data.counts.evidence ?? 0}</strong></span>
              <span>风险 <strong className="font-mono text-amber-700">{viewed.data.counts.risks ?? 0}</strong></span>
            </span>
          )}
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
                报告阅读
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
                报告阅读
              </Link>
              <Link className="gp-segmented-item" data-active={isExportView ? "true" : undefined} href={`/projects/${projectId}/reports/export`}>
                导出与历史
              </Link>
            </div>
          )}
          <button
            type="button"
            disabled={!canRefresh}
            onClick={() => void refreshPreview(!latest)}
            className={compactPrimaryBtn}
          >
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "AI 撰写中…" : latest ? "AI 重新生成" : "生成预览"}
          </button>
          {viewed && (
            <button
              type="button"
              disabled={!canExport}
              onClick={() => void exportAndDownloadNow(viewed.version, fileFormat)}
              className={compactBtn}
            >
              <Download size={13} />
              {isExporting ? "导出中…" : `导出 ${formatLabel(fileFormat)}`}
            </button>
          )}
        </div>
      </div>

      {isRefreshing && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-sky-200/80 bg-sky-50/80 px-3.5 py-2 text-xs text-sky-800">
          <Sparkles size={14} className="shrink-0 animate-pulse text-sky-600" />
          <span>AI 正在基于任务、GitHub、飞书与证据撰写 7 章结项报告，请稍候…</span>
        </div>
      )}
      {rewritingSection && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-sky-200/80 bg-sky-50/80 px-3.5 py-2 text-xs text-sky-800">
          <Sparkles size={14} className="shrink-0 animate-pulse text-sky-600" />
          <span>AI 正在基于最新真实数据重写「{sectionHeadingLabels[rewritingSection] ?? rewritingSection}」…</span>
        </div>
      )}
      {error && (
        <div role="alert">
          <Feedback tone="error">{error}</Feedback>
        </div>
      )}
      {notice && <Feedback tone="success">{notice}</Feedback>}

      {isExportView ? (
        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.35fr)_minmax(310px,0.9fr)] xl:items-start">
          <div className="space-y-3.5">
            {exportControlsCard}

            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">生成进度与导出记录</h2>
                <span className="text-xs text-slate-500">{listing.artifacts.length} 份文件</span>
              </div>
              {listing.artifacts.length === 0 ? (
                <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                  暂无导出文件记录，生成报告版本后可一键导出 PDF、DOCX 或 Markdown。
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
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusBadge
                                tone={item.status === "ready" ? "green" : item.status === "failed" ? "red" : "amber"}
                                label={item.status}
                              />
                              {item.status === "failed" && item.error && (
                                <span className="text-[11px] text-rose-600">{item.error}</span>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 text-slate-600">{item.requested_by_name ?? item.requested_by}</td>
                          <td className="py-2.5 text-slate-500">{item.created_at?.slice(0, 16).replace("T", " ")}</td>
                          <td className="py-2.5 text-right">
                            {item.status === "ready" && (
                              <button
                                type="button"
                                disabled={busy}
                                className="font-medium text-sky-700 hover:underline disabled:opacity-50"
                                onClick={() => void download(item.id, item.version, item.format)}
                              >
                                下载文件
                              </button>
                            )}
                            {item.status === "failed" && (
                              <button
                                type="button"
                                disabled={busy}
                                className={compactBtn}
                                onClick={() => void exportAndDownloadNow(item.version, item.format)}
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
        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)] xl:items-start">
          {/* Left: Single-Viewport Compact Document Reader */}
          <section className="flex flex-col overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs lg:h-[calc(100vh-240px)] lg:min-h-[520px]">
            {/* Sticky Top Reader Bar */}
            <div className="shrink-0 space-y-2.5 border-b border-slate-100 bg-white px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText size={16} className="shrink-0 text-sky-600" />
                  <h2 className="truncate text-sm font-semibold text-slate-900">
                    {viewed ? `${viewed.data.project_name || "项目报告"} · v${viewed.version}` : "报告内容预览"}
                  </h2>
                  {viewed && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        isAiAuthored ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {isAiAuthored && <Sparkles size={10} />}
                      {isAiAuthored ? "AI 深度撰写" : "结构化汇编"}
                    </span>
                  )}
                </div>

                {viewed && sectionEntries.length > 0 && (
                  <div className="gp-segmented" role="tablist" aria-label="阅读模式">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={readMode === "chapter"}
                      data-active={readMode === "chapter" ? "true" : undefined}
                      className="gp-segmented-item"
                      onClick={() => setReadMode("chapter")}
                    >
                      单章聚焦
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={readMode === "full"}
                      data-active={readMode === "full" ? "true" : undefined}
                      className="gp-segmented-item"
                      onClick={() => setReadMode("full")}
                    >
                      全文浏览
                    </button>
                  </div>
                )}
              </div>

              {sectionEntries.length > 0 && (
                <div className="flex flex-wrap gap-1.5" role="navigation" aria-label="报告章节导航">
                  {sectionEntries.map(([section]) => {
                    const isCurrent = resolvedActiveChapter === section;
                    return (
                      <button
                        key={section}
                        type="button"
                        onClick={() => selectChapter(section)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                          isCurrent
                            ? "bg-sky-600 text-white shadow-2xs"
                            : "bg-slate-100 text-slate-600 hover:bg-sky-50 hover:text-sky-700"
                        }`}
                      >
                        {shortChapterLabels[section] ?? sectionHeadingLabels[section] ?? section}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Internal Scrollable Document Body */}
            <div ref={readerScrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {viewed?.status === "generating" && (
                <p role="status" className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700">
                  AI 正在后台汇编 7 章结项报告…
                </p>
              )}
              {viewed?.status === "failed" && (
                <p role="alert" className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  预览生成失败，请点击右上角重试刷新。
                </p>
              )}

              {viewed ? (
                <div className="divide-y divide-slate-100">
                  {visibleEntries.map(([section, body]) => {
                    const isRewritingThis = rewritingSection === section;
                    return (
                      <article id={`report-sec-${section}`} key={section} className="py-3.5 first:pt-0 last:pb-0">
                        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-base font-bold tracking-tight text-slate-900">
                            {sectionHeadingLabels[section] ?? section}
                          </h3>
                          {canEditChapter && editing !== section && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busy}
                                className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50/70 px-2.5 py-1 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100/80 disabled:opacity-50"
                                onClick={() => void rewriteChapterWithAi(viewed.version, section)}
                              >
                                <Sparkles size={12} className={isRewritingThis ? "animate-spin" : ""} />
                                {isRewritingThis ? "AI 重写中…" : "AI 重写本章"}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                                onClick={() => {
                                  setEditing(section);
                                  setDraft(body);
                                }}
                              >
                                <Pencil size={12} />
                                编辑
                              </button>
                            </div>
                          )}
                        </div>
                        {editing === section ? (
                          <div className="space-y-2">
                            <textarea
                              className={`${input} font-mono text-xs leading-6`}
                              rows={10}
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
                                    "edit",
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
                          <div className="rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3">
                            <MarkdownPreview source={body} />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-xl bg-slate-50/80 px-4 py-8 text-center">
                  <Sparkles size={24} className="mb-2 text-sky-600" />
                  <p className="text-sm font-semibold text-slate-800">尚无结项报告预览</p>
                  <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">
                    系统将汇总需求基线、任务与里程碑、GitHub 提交、飞书协作结论、正式证据与成员贡献，由 AI 撰写结构完整的 7 章高校课程结项报告。
                  </p>
                  <button
                    type="button"
                    disabled={!canRefresh}
                    onClick={() => void refreshPreview(true)}
                    className={`${compactPrimaryBtn} mt-4`}
                  >
                    <Sparkles size={13} className={isRefreshing ? "animate-pulse" : ""} />
                    {isRefreshing ? "AI 正在撰写首版报告…" : "生成首版预览"}
                  </button>
                </div>
              )}
            </div>

            {/* Compact Single-Chapter Navigation Footer */}
            {viewed && readMode === "chapter" && sectionEntries.length > 1 && (
              <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-xs">
                <button
                  type="button"
                  disabled={activeChapterIndex <= 0}
                  onClick={() => selectChapter(sectionEntries[activeChapterIndex - 1][0])}
                  className={compactBtn}
                >
                  <ChevronLeft size={13} />
                  上一章
                </button>
                <span className="font-mono text-slate-500">
                  第 {activeChapterIndex + 1} / {sectionEntries.length} 章
                  {viewed.created_at ? ` · 快照 ${viewed.created_at.slice(0, 16).replace("T", " ")}` : ""}
                </span>
                <button
                  type="button"
                  disabled={activeChapterIndex < 0 || activeChapterIndex >= sectionEntries.length - 1}
                  onClick={() => selectChapter(sectionEntries[activeChapterIndex + 1][0])}
                  className={compactBtn}
                >
                  下一章
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
          </section>

          {/* Right Sticky Column: Export, Version History, Audit */}
          <div className="space-y-3 xl:sticky xl:top-4">
            {exportControlsCard}
            {versionHistoryCard}
            {auditLogsCard}
          </div>
        </div>
      )}
    </div>
  );
}
