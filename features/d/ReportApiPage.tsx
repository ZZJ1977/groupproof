"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileDown,
  FileText,
  History,
  Loader2,
  Pencil,
  Printer,
  RefreshCw,
  Send,
  Sparkles,
  X,
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
  course_name?: string | null;
  course_code?: string | null;
  semester?: string | null;
  team_members?: string[];
  ai_chapters_count?: number;
  word_count?: number;
  last_rewritten_section?: string | null;
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

const statusMeta: Record<string, { label: string; tone: "blue" | "green" | "amber" | "red" | "gray" }> = {
  draft: { label: "草稿", tone: "gray" },
  generating: { label: "生成中", tone: "blue" },
  generated: { label: "草稿", tone: "blue" },
  returned: { label: "已退回修改", tone: "amber" },
  submitted: { label: "待教师审核", tone: "amber" },
  finalized: { label: "已定稿", tone: "green" },
  failed: { label: "生成失败", tone: "red" },
};

const toolbarBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const toolbarPrimaryBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const toolbarSelect =
  "h-8 max-w-[260px] rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-800 outline-none transition-colors hover:border-slate-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";

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

function hasReadableSections(data: Version["data"] | undefined): boolean {
  const entries = resolveOrderedSections(data);
  return entries.length > 0 && entries.some(([, body]) => body.trim().length > 0);
}

function countDocumentChars(entries: [string, string][]): number {
  return entries.reduce((sum, [, body]) => sum + body.replace(/\s+/g, "").length, 0);
}

function authoringLabel(meta?: VersionMeta): string {
  if (meta?.authoring_mode === "ai") return "AI 深度撰写";
  if (meta?.last_rewritten_section) return "AI 辅助修订";
  return "结构化汇编";
}

function compactAuthoringLabel(meta?: VersionMeta): string {
  if (meta?.authoring_mode === "ai") return "AI 撰写";
  if (meta?.last_rewritten_section) return "AI 修订";
  return "结构化";
}

const GENERATION_STEPS = [
  {
    key: "facts",
    label: "采集项目真实事实包（任务、里程碑、GitHub、飞书、证据、贡献）",
    shortLabel: "采集真实事实包",
    startAt: 0,
    doneAt: 5,
  },
  {
    key: "chapters_1_4",
    label: "AI 撰写第 1–4 章（项目概述、流程机制、里程碑复盘、团队协作）",
    shortLabel: "撰写第 1–4 章",
    startAt: 5,
    doneAt: 18,
  },
  {
    key: "chapters_5_7",
    label: "AI 撰写第 5–7 章（证据链验收、成员贡献画像、风险与展望）",
    shortLabel: "撰写第 5–7 章",
    startAt: 18,
    doneAt: 33,
  },
  {
    key: "finalize",
    label: "文档排版校验与报告快照保存",
    shortLabel: "排版校验与保存",
    startAt: 33,
    doneAt: Number.POSITIVE_INFINITY,
  },
] as const;

function computeGenerationProgress(elapsedSeconds: number, completed: boolean): number {
  if (completed) return 100;
  // Asymptotic curve: 12% (0s) -> ~38% (5s) -> ~62% (12s) -> ~84% (26s) -> ~93% (45s), capped at 95%
  const t = Math.max(0, elapsedSeconds);
  const raw = 12 + 84 * (1 - Math.exp(-t / 13.5));
  return Math.min(95, Math.max(12, Math.round(raw)));
}

function ReportGenerationProgress({
  variant,
  elapsedSeconds,
  completed,
  versionNo,
  previousVersionNo,
  onViewPreviousVersion,
}: {
  variant: "full" | "compact";
  elapsedSeconds: number;
  completed: boolean;
  versionNo?: number | null;
  previousVersionNo?: number | null;
  onViewPreviousVersion?: () => void;
}) {
  const progress = computeGenerationProgress(elapsedSeconds, completed);
  const versionTag = versionNo ? `v${versionNo}` : "";
  const activeStepIndex = completed
    ? GENERATION_STEPS.length
    : Math.max(
        0,
        GENERATION_STEPS.findIndex(
          (step) => elapsedSeconds >= step.startAt && elapsedSeconds < step.doneAt,
        ),
      );
  const currentStep = GENERATION_STEPS[Math.min(activeStepIndex, GENERATION_STEPS.length - 1)];

  if (variant === "compact") {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`mb-7 rounded-xl border px-4 py-3.5 transition-colors print:hidden ${
          completed
            ? "border-emerald-200/90 bg-emerald-50/70"
            : "border-sky-200/85 bg-sky-50/60"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {completed ? (
              <CheckCircle2 size={15} className="shrink-0 text-emerald-600" />
            ) : (
              <Sparkles size={15} className="shrink-0 animate-pulse text-sky-600 motion-reduce:animate-none" />
            )}
            <p className={`text-xs font-semibold ${completed ? "text-emerald-900" : "text-slate-900"}`}>
              {completed
                ? `新版结项报告${versionTag ? ` ${versionTag}` : ""} 已生成完成，已自动更新正文`
                : `AI 正在后台撰写新版结项报告${versionTag ? `（${versionTag}）` : ""} · ${currentStep.shortLabel}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
            <span className={completed ? "text-emerald-700" : "text-slate-500"}>
              {completed ? `用时 ${elapsedSeconds}s` : `已用时 ${elapsedSeconds}s · 预计 20–45 秒`}
            </span>
            <span className={`font-semibold ${completed ? "text-emerald-700" : "text-sky-700"}`}>
              {progress}%
            </span>
          </div>
        </div>

        <div
          role="progressbar"
          aria-label="AI 报告生成进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/90 ring-1 ring-slate-200/70"
        >
          <div
            className={`h-full rounded-full transition-all duration-700 ease-out ${
              completed
                ? "bg-emerald-500"
                : "bg-gradient-to-r from-sky-500 via-sky-600 to-indigo-500"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {GENERATION_STEPS.map((step, index) => {
            const isDone = completed || index < activeStepIndex;
            const isActive = !completed && index === activeStepIndex;
            return (
              <div
                key={step.key}
                title={step.label}
                className={`flex items-center gap-1.5 truncate text-[11px] ${
                  isDone
                    ? "text-emerald-700"
                    : isActive
                      ? "font-medium text-sky-900"
                      : "text-slate-400"
                }`}
              >
                {isDone ? (
                  <Check size={12} className="shrink-0 text-emerald-600" />
                ) : isActive ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-sky-600 motion-reduce:animate-none" />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                )}
                <span className="truncate">{step.shortLabel}</span>
              </div>
            );
          })}
        </div>

        {!completed && (
          <p className="mt-2 text-[11px] text-slate-500">
            您可继续阅读当前版本内容，新版撰写完成后将自动刷新并切换。
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto max-w-xl rounded-2xl border border-slate-200/90 bg-gradient-to-b from-sky-50/55 via-white to-white p-6 shadow-2xs print:hidden"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
              completed
                ? "border-emerald-200 bg-emerald-50 text-emerald-600"
                : "border-sky-200/90 bg-sky-50 text-sky-600"
            }`}
          >
            {completed ? (
              <CheckCircle2 size={18} />
            ) : (
              <Sparkles size={18} className="animate-pulse motion-reduce:animate-none" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">
              {completed
                ? `结项报告${versionTag ? ` ${versionTag}` : ""} 已生成完成`
                : `AI 正在撰写 7 章结项报告${versionTag ? `（${versionTag}）` : ""}`}
            </h2>
            <p className="mt-1 text-xs tabular-nums text-slate-500">
              {completed
                ? `已完成全部章节撰写与校验 · 用时 ${elapsedSeconds}s`
                : `已用时 ${elapsedSeconds}s · 预计 20–45 秒`}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <span
            className={`text-xl font-bold tracking-tight tabular-nums ${
              completed ? "text-emerald-600" : "text-sky-700"
            }`}
          >
            {progress}%
          </span>
        </div>
      </div>

      {/* Smooth Asymptotic Progress Bar */}
      <div
        role="progressbar"
        aria-label="AI 报告生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/70"
      >
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${
            completed
              ? "bg-emerald-500"
              : "bg-gradient-to-r from-sky-500 via-sky-600 to-indigo-500"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* 4-Step Live Checklist */}
      <ol className="mt-5 space-y-2.5">
        {GENERATION_STEPS.map((step, index) => {
          const isDone = completed || index < activeStepIndex;
          const isActive = !completed && index === activeStepIndex;
          return (
            <li
              key={step.key}
              className={`flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                isActive ? "bg-sky-50/80 text-slate-900" : isDone ? "text-slate-600" : "text-slate-400"
              }`}
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {isDone ? (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <Check size={11} strokeWidth={2.5} />
                  </span>
                ) : isActive ? (
                  <Loader2 size={14} className="animate-spin text-sky-600 motion-reduce:animate-none" />
                ) : (
                  <span className="h-2 w-2 rounded-full border border-slate-300 bg-white" />
                )}
              </span>
              <span className={`min-w-0 flex-1 leading-5 ${isActive ? "font-medium" : ""}`}>
                {step.label}
              </span>
              {isActive && (
                <span className="mt-0.5 shrink-0 rounded-full bg-sky-100/90 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                  进行中
                </span>
              )}
              {isDone && (
                <span className="mt-0.5 shrink-0 text-[10px] font-medium text-emerald-600">完成</span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3.5 text-[11px] text-slate-500">
        <span>后台完成后将自动刷新完整正文，无需手动刷新页面。</span>
        {previousVersionNo && onViewPreviousVersion && (
          <button
            type="button"
            onClick={onViewPreviousVersion}
            className="inline-flex shrink-0 items-center gap-1 font-medium text-sky-700 transition-colors hover:text-sky-900 hover:underline"
          >
            先查看上一版（v{previousVersionNo}）
            <ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
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
  const [selected, setSelected] = useState<number | null>(null);
  const [activeChapter, setActiveChapter] = useState<string>("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [rewritingSection, setRewritingSection] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(exportView);
  const [drawerTab, setDrawerTab] = useState<"versions" | "exports">(exportView ? "exports" : "versions");
  const [genElapsedSeconds, setGenElapsedSeconds] = useState(0);
  const [completionState, setCompletionState] = useState<{ version: number; elapsed: number } | null>(null);

  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const genStartedAtRef = useRef<number | null>(null);
  const wasGeneratingRef = useRef(false);
  const refreshFailedRef = useRef(false);
  const busy = busyAction !== null;

  const applyListing = useCallback((next: Listing) => {
    const nextGenerating =
      next.status === "generating" || next.versions.some((version) => version.status === "generating");
    if (!nextGenerating && wasGeneratingRef.current) {
      const nextLatest = next.versions[0];
      const nextHasChapters = Boolean(nextLatest && hasReadableSections(nextLatest.data));
      const failed = refreshFailedRef.current || next.status === "failed" || nextLatest?.status === "failed";
      const finishedElapsed =
        genStartedAtRef.current !== null
          ? Math.max(1, Math.floor((Date.now() - genStartedAtRef.current) / 1000))
          : 1;
      wasGeneratingRef.current = false;
      genStartedAtRef.current = null;
      refreshFailedRef.current = false;

      if (!failed && nextLatest && nextHasChapters) {
        setSelected(null);
        setCompletionState({ version: nextLatest.version, elapsed: finishedElapsed });
        const aiTag = nextLatest.data?.meta?.authoring_mode === "ai" ? "（AI 深度撰写）" : "";
        setNotice((prev) =>
          !prev || prev.includes("正在后台")
            ? `结项报告 v${nextLatest.version} 已撰写完成${aiTag}，已自动刷新正文。`
            : prev,
        );
      } else {
        setGenElapsedSeconds(0);
      }
    }
    setListing(next);
  }, []);

  const refresh = useCallback(async () => applyListing(await request<Listing>(base)), [applyListing, base]);
  useEffect(() => {
    void refresh().catch((failure) => setError((failure as Error).message));
  }, [refresh]);

  const latest = listing.versions[0];
  const viewed = listing.versions.find((version) => version.version === selected) ?? latest;
  const generatingVersion = useMemo(
    () => listing.versions.find((version) => version.status === "generating") ?? null,
    [listing.versions],
  );
  const hasPendingArtifacts = useMemo(
    () => listing.artifacts.some((item) => item.status === "pending" || item.status === "generating"),
    [listing.artifacts],
  );
  const isRefreshing = busyAction === "refresh";
  const isServerGenerating = listing.status === "generating" || generatingVersion !== null;
  const isGenerating = isRefreshing || isServerGenerating;

  useEffect(() => {
    if (!isServerGenerating && !hasPendingArtifacts) return;
    const timer = window.setInterval(() => {
      void refresh().catch((failure) => setError((failure as Error).message));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasPendingArtifacts, isServerGenerating, refresh]);

  const generatingCreatedAt = generatingVersion?.created_at ?? null;

  useEffect(() => {
    if (!isGenerating) return;
    wasGeneratingRef.current = true;
    if (genStartedAtRef.current === null) {
      const createdMs = generatingCreatedAt ? Date.parse(generatingCreatedAt) : Number.NaN;
      const diffSec = Number.isFinite(createdMs) ? Math.floor((Date.now() - createdMs) / 1000) : -1;
      genStartedAtRef.current = !isRefreshing && diffSec >= 0 && diffSec <= 120 ? createdMs : Date.now();
    }
    const startedAt = genStartedAtRef.current;
    const syncElapsed = () => {
      setGenElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    const initialTick = window.setTimeout(syncElapsed, 0);
    const interval = window.setInterval(syncElapsed, 1000);
    return () => {
      window.clearTimeout(initialTick);
      window.clearInterval(interval);
    };
  }, [generatingCreatedAt, isGenerating, isRefreshing]);

  useEffect(() => {
    if (!completionState) return;
    const timer = window.setTimeout(() => {
      setCompletionState(null);
      setGenElapsedSeconds(0);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [completionState]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExportMenuOpen(false);
        setDrawerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const st = statusMeta[listing.status] ?? { label: listing.status, tone: "gray" as const };
  const canRefresh = !busy && !isServerGenerating && !["generating", "submitted", "finalized"].includes(listing.status);
  const canExport = Boolean(viewed && !busy && ["generated", "finalized"].includes(viewed.status));
  const canSubmit = Boolean(latest && ["generated", "returned"].includes(listing.status));
  const canEditChapter = Boolean(viewed && !["submitted", "finalized"].includes(listing.status) && viewed.version === latest?.version);

  const sectionEntries = useMemo(() => resolveOrderedSections(viewed?.data), [viewed?.data]);
  const viewedHasContent = useMemo(
    () => sectionEntries.length > 0 && sectionEntries.some(([, body]) => body.trim().length > 0),
    [sectionEntries],
  );
  const previousReadableVersion = useMemo(
    () =>
      listing.versions.find(
        (version) =>
          version.version !== viewed?.version &&
          version.status !== "generating" &&
          hasReadableSections(version.data),
      ) ?? null,
    [listing.versions, viewed?.version],
  );
  const isGeneratingEmptyPaper =
    (!viewed && isGenerating) ||
    (Boolean(viewed) &&
      !viewedHasContent &&
      (viewed?.status === "generating" || (isGenerating && viewed?.version === latest?.version)));
  const activeTargetVersionNo =
    generatingVersion?.version ?? (isRefreshing ? (latest ? latest.version + 1 : 1) : latest?.version ?? null);
  const resolvedActiveChapter = useMemo(() => {
    if (sectionEntries.length === 0) return "";
    if (activeChapter && sectionEntries.some(([key]) => key === activeChapter)) return activeChapter;
    return sectionEntries[0][0];
  }, [activeChapter, sectionEntries]);

  const totalChars = useMemo(() => countDocumentChars(sectionEntries), [sectionEntries]);
  const isExporting = busyAction === "export" || busyAction === "download";

  const counts = viewed?.data?.counts;
  const meta = viewed?.data?.meta;
  const completionRate = useMemo(() => {
    const total = counts?.tasks ?? 0;
    const done = counts?.completed_tasks ?? 0;
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }, [counts]);

  const teamMembersDisplay = useMemo(() => {
    if (meta?.team_members && meta.team_members.length > 0) {
      return meta.team_members.join("、");
    }
    return `${counts?.members ?? 0} 名成员`;
  }, [counts?.members, meta?.team_members]);

  const handleCanvasScroll = useCallback(() => {
    const container = canvasScrollRef.current;
    if (!container || sectionEntries.length === 0) return;
    const containerTop = container.getBoundingClientRect().top;
    let currentKey = sectionEntries[0][0];
    for (const [key] of sectionEntries) {
      const el = container.querySelector<HTMLElement>(`#report-sec-${key}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - containerTop <= 96) {
        currentKey = key;
      }
    }
    setActiveChapter((prev) => (prev === currentKey ? prev : currentKey));
  }, [sectionEntries]);

  function scrollToChapter(sectionKey: string) {
    setActiveChapter(sectionKey);
    const container = canvasScrollRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`#report-sec-${sectionKey}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function mutate(url: string, body?: unknown, successMsg?: string, action: BusyAction = "edit") {
    setBusyAction(action);
    setError("");
    setNotice("");
    try {
      await request(url, "POST", body);
      await refresh();
      setEditing("");
      setSelected(null);
      if (action === "review") setReviewReason("");
      if (successMsg) setNotice(successMsg);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshPreview(initial: boolean) {
    genStartedAtRef.current = Date.now();
    wasGeneratingRef.current = true;
    refreshFailedRef.current = false;
    setGenElapsedSeconds(0);
    setCompletionState(null);
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
      if (created.status !== "generating") {
        const aiTag = created.data?.meta?.authoring_mode === "ai" ? "（AI 深度撰写）" : "";
        setNotice(
          initial
            ? `首版 7 章结项报告（v${created.version}）已生成${aiTag}。`
            : `已生成新版结项报告 v${created.version}${aiTag}。`,
        );
      }
    } catch (failure) {
      refreshFailedRef.current = true;
      wasGeneratingRef.current = false;
      genStartedAtRef.current = null;
      setGenElapsedSeconds(0);
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
          ? `AI 已重新润色「${label}」并保存为 v${updated.version}。`
          : `已依据最新真实工程数据重新汇编「${label}」并保存为 v${updated.version}。`,
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
      setNotice(`已开始下载 ${(fmt ?? "pdf").toUpperCase()} 文档。`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function exportAndDownloadNow(versionNo: number, format: ExportFormat) {
    setExportMenuOpen(false);
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
        setNotice(`已导出并开始下载 v${versionNo} Markdown (.md) 文档。`);
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
        throw new Error(exportError || `导出 ${format.toUpperCase()} 文档失败，请重试。`);
      }
      if (status === "ready") {
        const link = await request<{ url: string; expires_at: string }>(
          `${base}/exports/${created.id}/download-link`,
          "POST",
        );
        await downloadBinaryFromApi(link.url, `${stem}-结项报告-v${versionNo}.${format}`);
        await refresh();
        setNotice(`已生成并开始下载 ${format.toUpperCase()} 标准文档。`);
      } else {
        await refresh();
        setNotice(`已提交后台导出 ${format.toUpperCase()} 文档，就绪后可在「版本历史 → 导出记录」下载。`);
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Single Sleek Top Document Toolbar */}
      <header className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-200/85 bg-white px-3.5 py-2.5 shadow-2xs print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          {!embedded && (
            <span className="inline-flex items-center gap-1.5 pr-1 text-sm font-semibold text-slate-900">
              <FileText size={15} className="text-slate-500" />
              结项报告
            </span>
          )}
          <select
            aria-label="选择报告版本"
            value={viewed?.version ?? ""}
            onChange={(event) => {
              setSelected(Number(event.target.value));
              setEditing("");
            }}
            disabled={listing.versions.length === 0}
            className={toolbarSelect}
          >
            {listing.versions.length === 0 && <option value="">尚未生成报告版本</option>}
            {listing.versions.map((version) => (
              <option key={version.id} value={version.version}>
                v{version.version} ·{" "}
                {version.status === "generating"
                  ? "AI 撰写中…"
                  : version.status === "failed"
                    ? "生成失败"
                    : authoringLabel(version.data?.meta)}{" "}
                · {version.created_at?.slice(0, 10) ?? ""}
              </option>
            ))}
          </select>

          <StatusBadge tone={st.tone} label={st.label} />

          <button
            type="button"
            onClick={() => {
              setDrawerTab("versions");
              setDrawerOpen(true);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <History size={13} />
            版本历史
            {listing.versions.length > 0 && (
              <span className="rounded-full bg-slate-100 px-1.5 py-0.2 font-mono text-[11px] text-slate-500">
                {listing.versions.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canRefresh}
            onClick={() => void refreshPreview(!latest)}
            className={toolbarBtn}
          >
            {isGenerating ? (
              <RefreshCw size={13} className="animate-spin text-sky-600 motion-reduce:animate-none" />
            ) : (
              <Sparkles size={13} className="text-sky-600" />
            )}
            {isGenerating ? "AI 深度撰写中…" : latest ? "AI 生成新版报告" : "AI 生成首版报告"}
          </button>

          {viewed && (
            <div ref={exportMenuRef} className="relative">
              <button
                type="button"
                disabled={!canExport}
                aria-expanded={exportMenuOpen}
                aria-haspopup="menu"
                onClick={() => setExportMenuOpen((open) => !open)}
                className={toolbarBtn}
              >
                <Download size={13} className={isExporting ? "animate-bounce" : ""} />
                {isExporting ? "导出中…" : "导出文档"}
                <ChevronDown size={13} className="text-slate-400" />
              </button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-30 mt-1.5 w-48 rounded-xl border border-slate-200 bg-white py-1.5 text-xs shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportAndDownloadNow(viewed.version, "pdf")}
                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50"
                  >
                    <FileDown size={14} className="text-rose-500" />
                    <span>PDF 标准文档</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportAndDownloadNow(viewed.version, "docx")}
                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50"
                  >
                    <FileText size={14} className="text-sky-600" />
                    <span>Word 文档 (.docx)</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void exportAndDownloadNow(viewed.version, "md")}
                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50"
                  >
                    <FileText size={14} className="text-slate-500" />
                    <span>Markdown (.md)</span>
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setExportMenuOpen(false);
                      window.print();
                    }}
                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-slate-700 hover:bg-slate-50"
                  >
                    <Printer size={14} className="text-slate-500" />
                    <span>打印当前文档</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {canSubmit && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(`${base}/submit`, undefined, "已提交给任课教师审核定稿。", "submit")}
              className={toolbarPrimaryBtn}
            >
              <Send size={13} />
              提交定稿
            </button>
          )}

          {listing.status === "submitted" && (
            <button
              type="button"
              onClick={() => {
                setDrawerTab("versions");
                setDrawerOpen(true);
              }}
              className={toolbarPrimaryBtn}
            >
              <CheckCircle2 size={13} />
              教师审核
            </button>
          )}
        </div>
      </header>

      {/* Progress / Status / Feedback Banners */}
      {rewritingSection && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-sky-200/80 bg-sky-50/80 px-3.5 py-2 text-xs text-sky-800 print:hidden">
          <Sparkles size={14} className="shrink-0 animate-pulse text-sky-600" />
          <span>AI 正在润色「{sectionHeadingLabels[rewritingSection] ?? rewritingSection}」…</span>
        </div>
      )}
      {listing.status === "submitted" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200/80 bg-amber-50/75 px-3.5 py-2 text-xs text-amber-900 print:hidden">
          <span>该报告已提交至任课教师审阅，当前文档内容已锁定。任课教师可在审核抽屉中填写评语并选择退回修改或审核通过定稿。</span>
          <button
            type="button"
            onClick={() => {
              setDrawerTab("versions");
              setDrawerOpen(true);
            }}
            className="font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-700"
          >
            打开审核面板
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="print:hidden">
          <Feedback tone="error">{error}</Feedback>
        </div>
      )}
      {notice && (
        <div className="print:hidden">
          <Feedback tone="success">{notice}</Feedback>
        </div>
      )}

      {/* 2-Pane Authentic Document Workspace (100% Width Dedicated to Reading & Authoring) */}
      <div className="flex overflow-hidden rounded-2xl border border-slate-200/85 bg-slate-100/75 lg:h-[calc(100vh-215px)] lg:min-h-[540px] print:block print:h-auto print:overflow-visible print:border-0 print:bg-white">
        {/* Left Quiet Document Outline */}
        <aside
          aria-label="文档目录"
          className="hidden flex-col overflow-y-auto border-r border-slate-200/80 bg-white/95 p-4 lg:flex lg:w-56 lg:shrink-0 print:hidden"
        >
          <p className="mb-3 px-2 text-[11px] font-semibold tracking-wider text-slate-400">文档目录</p>
          {sectionEntries.length === 0 ? (
            isGeneratingEmptyPaper ? (
              <div className="space-y-2 px-2">
                <p className="text-[11px] font-medium text-sky-700">正在生成 7 章目录…</p>
                <div className="space-y-2 pt-1" aria-hidden="true">
                  {CHAPTER_ORDER.map((key) => (
                    <div
                      key={key}
                      className="h-3.5 animate-pulse rounded bg-slate-100 motion-reduce:animate-none"
                      style={{ width: key === "overview" || key === "reflection" ? "82%" : "92%" }}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="px-2 text-xs text-slate-400">生成报告后显示章节目录</p>
            )
          ) : (
            <nav className="flex-1 space-y-0.5">
              {sectionEntries.map(([section]) => {
                const isActive = resolvedActiveChapter === section;
                const label = sectionHeadingLabels[section] ?? section;
                return (
                  <button
                    key={section}
                    type="button"
                    onClick={() => scrollToChapter(section)}
                    className={`block w-full border-l-2 py-1.5 pl-2.5 pr-2 text-left text-[12.5px] leading-snug transition-colors ${
                      isActive
                        ? "border-slate-900 bg-slate-100/80 font-semibold text-slate-900"
                        : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
          )}
          {viewed && sectionEntries.length > 0 && (
            <div className="mt-4 border-t border-slate-100 px-2 pt-3 text-[11px] leading-5 text-slate-400">
              <p>共 {sectionEntries.length} 章 · 约 {totalChars.toLocaleString()} 字</p>
              <p>快照版本 v{viewed.version}</p>
            </div>
          )}
        </aside>

        {/* Right Continuous White A4 Paper Canvas */}
        <div
          ref={canvasScrollRef}
          onScroll={handleCanvasScroll}
          className="flex-1 overflow-y-auto px-4 py-6 sm:px-8 print:overflow-visible print:p-0"
        >
          {isGeneratingEmptyPaper ? (
            <article className="mx-auto max-w-[840px] rounded-xl border border-slate-200/90 bg-white px-8 py-9 shadow-xs sm:px-12 sm:py-11 print:max-w-none print:rounded-none print:border-0 print:px-0 print:py-0 print:shadow-none">
              <ReportGenerationProgress
                variant="full"
                elapsedSeconds={genElapsedSeconds}
                completed={false}
                versionNo={activeTargetVersionNo}
                previousVersionNo={previousReadableVersion?.version ?? null}
                onViewPreviousVersion={
                  previousReadableVersion
                    ? () => {
                        setSelected(previousReadableVersion.version);
                        setEditing("");
                      }
                    : undefined
                }
              />

              {/* Subtle A4 Document Skeleton — avoids misleading 0 stats while generating */}
              <div
                aria-hidden="true"
                className="pointer-events-none mt-9 select-none border-t border-slate-100 pt-8 opacity-65 print:hidden"
              >
                <div className="h-3 w-44 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
                <div className="mt-3 h-7 w-72 max-w-[78%] animate-pulse rounded-md bg-slate-100 motion-reduce:animate-none" />

                <div className="my-6 grid grid-cols-2 gap-4 border-y border-slate-100 py-4 sm:grid-cols-4">
                  {[0, 1, 2, 3].map((item) => (
                    <div key={item} className="space-y-2">
                      <div className="h-2.5 w-14 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
                      <div className="h-3.5 w-24 animate-pulse rounded bg-slate-100/90 motion-reduce:animate-none" />
                    </div>
                  ))}
                </div>

                <div className="space-y-6">
                  {[
                    { heading: "w-48", lines: ["w-full", "w-[94%]", "w-[82%]"] },
                    { heading: "w-56", lines: ["w-[96%]", "w-[88%]", "w-[70%]"] },
                  ].map((block, blockIdx) => (
                    <div key={blockIdx} className="space-y-2.5">
                      <div
                        className={`h-4 ${block.heading} animate-pulse rounded bg-slate-100 motion-reduce:animate-none`}
                      />
                      {block.lines.map((widthClass, lineIdx) => (
                        <div
                          key={lineIdx}
                          className={`h-3 ${widthClass} animate-pulse rounded bg-slate-100/80 motion-reduce:animate-none`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </article>
          ) : viewed && viewed.status === "failed" && !viewedHasContent ? (
            <div className="mx-auto flex max-w-[840px] min-h-[420px] flex-col items-center justify-center rounded-xl border border-slate-200/90 bg-white px-8 py-14 text-center shadow-xs">
              <AlertCircle size={28} className="mb-3 text-rose-400" />
              <h2 className="text-base font-semibold text-slate-900">v{viewed.version} 结项报告生成失败</h2>
              <p className="mt-2 max-w-md text-xs leading-6 text-slate-500">
                后台生成任务未能完成，当前快照未写入正文。您可以点击下方按钮重新生成新版报告
                {previousReadableVersion ? `，或先切换回上一版（v${previousReadableVersion.version}）查看。` : "。"}
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  disabled={!canRefresh}
                  onClick={() => void refreshPreview(false)}
                  className={toolbarPrimaryBtn}
                >
                  <Sparkles size={13} />
                  重新生成报告
                </button>
                {previousReadableVersion && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(previousReadableVersion.version);
                      setEditing("");
                    }}
                    className={toolbarBtn}
                  >
                    查看 v{previousReadableVersion.version}
                  </button>
                )}
              </div>
            </div>
          ) : viewed ? (
            <article className="mx-auto max-w-[840px] rounded-xl border border-slate-200/90 bg-white px-8 py-9 shadow-xs sm:px-12 sm:py-11 print:max-w-none print:rounded-none print:border-0 print:px-0 print:py-0 print:shadow-none">
              {(isGenerating || completionState !== null) && (
                <ReportGenerationProgress
                  variant="compact"
                  elapsedSeconds={completionState && !isGenerating ? completionState.elapsed : genElapsedSeconds}
                  completed={!isGenerating && completionState !== null}
                  versionNo={completionState && !isGenerating ? completionState.version : activeTargetVersionNo}
                />
              )}
              {viewed.status === "failed" && (
                <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700 print:hidden">
                  该版本报告生成失败，请点击上方「AI 生成新版报告」重试。
                </p>
              )}

              {/* Formal Editorial Cover / Document Header Block */}
              <header className="mb-8">
                <p className="mb-2 text-xs tracking-wide text-slate-400">
                  {meta?.course_name
                    ? `${meta.course_name}${meta.semester ? ` · ${meta.semester}` : ""} · 课程小组项目结项报告`
                    : "课程小组项目结项文档"}
                </p>
                <h1 className="text-2xl font-bold leading-snug tracking-tight text-slate-900 sm:text-[26px]">
                  {viewed.data.project_name || "项目"} 小组项目合作结项报告
                </h1>

                <dl className="my-5 grid grid-cols-2 gap-x-5 gap-y-2.5 border-y border-slate-200 py-3.5 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.75fr)_minmax(0,1.35fr)]">
                  <div className="min-w-0">
                    <dt className="text-slate-400">团队成员</dt>
                    <dd className="mt-0.5 font-medium text-slate-800">{teamMembersDisplay}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-400">任务完成情况</dt>
                    <dd className="mt-0.5 whitespace-nowrap font-medium text-slate-800">
                      {counts?.completed_tasks ?? 0} / {counts?.tasks ?? 0} 项（{completionRate}%）
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-400">有效正式证据</dt>
                    <dd className="mt-0.5 whitespace-nowrap font-medium text-slate-800">{counts?.evidence ?? 0} 条</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-400">版本与编制时间</dt>
                    <dd className="mt-0.5 whitespace-nowrap font-medium text-slate-800">
                      v{viewed.version} · {viewed.created_at?.slice(0, 10) ?? "—"} · {compactAuthoringLabel(meta)}
                    </dd>
                  </div>
                </dl>
              </header>

              {/* Continuous Flowing 7-Chapter Document Body */}
              <div>
                {sectionEntries.map(([section, body]) => {
                  const isRewritingThis = rewritingSection === section;
                  return (
                    <section
                      id={`report-sec-${section}`}
                      key={section}
                      className="group mt-9 scroll-mt-6 first:mt-0"
                    >
                      <div className="mb-3.5 flex items-baseline justify-between gap-4 border-b border-slate-100 pb-2">
                        <h2 className="text-lg font-bold tracking-tight text-slate-900">
                          {sectionHeadingLabels[section] ?? section}
                        </h2>
                        {canEditChapter && editing !== section && (
                          <div
                            className={`flex shrink-0 items-center gap-3 transition-opacity duration-150 print:hidden ${
                              isRewritingThis
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                            }`}
                          >
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setEditing(section);
                                setDraft(body);
                              }}
                              className="inline-flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-800 disabled:opacity-40"
                            >
                              <Pencil size={12} />
                              编辑
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void rewriteChapterWithAi(viewed.version, section)}
                              className="inline-flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-800 disabled:opacity-40"
                            >
                              <Sparkles size={12} className={isRewritingThis ? "animate-spin text-sky-600" : ""} />
                              {isRewritingThis ? "重写中…" : "AI 重写"}
                            </button>
                          </div>
                        )}
                      </div>

                      {editing === section ? (
                        <div className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50/50 p-3.5">
                          <textarea
                            aria-label={`编辑${sectionHeadingLabels[section] ?? section}`}
                            className={`${input} bg-white font-mono text-xs leading-6`}
                            rows={12}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={busy || !draft.trim()}
                              onClick={() =>
                                void mutate(
                                  `${base}/sections`,
                                  { section, body: draft, expected_version: latest.version },
                                  "已保存章节修改并生成新版本。",
                                  "edit",
                                )
                              }
                              className={button}
                            >
                              保存修改
                            </button>
                            <button type="button" onClick={() => setEditing("")} className={secondary}>
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[14.5px] leading-7 text-slate-800 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:bg-transparent [&_blockquote]:py-0.5 [&_blockquote]:pl-3.5 [&_blockquote]:text-slate-600 [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-[15.5px] [&_h3]:font-semibold [&_h3]:text-slate-900 [&_li]:leading-7 [&_p]:my-2.5 [&_p]:leading-7 [&_table]:my-3.5 [&_table]:text-[13px] [&_th]:bg-slate-50/90 [&_th]:font-semibold [&_th]:text-slate-700">
                          <MarkdownPreview source={body} />
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>

              {/* Formal Paper End Footer */}
              <footer className="mt-12 border-t border-slate-200/80 pt-5 text-center text-xs tracking-wide text-slate-400">
                — 报告正文结束 · GroupProof 证据驱动协作平台生成 —
              </footer>
            </article>
          ) : (
            <div className="mx-auto flex max-w-[840px] min-h-[420px] flex-col items-center justify-center rounded-xl border border-slate-200/90 bg-white px-8 py-14 text-center shadow-xs">
              <FileText size={28} className="mb-3 text-slate-300" />
              <h2 className="text-base font-semibold text-slate-900">尚无结项报告文档</h2>
              <p className="mt-2 max-w-md text-xs leading-6 text-slate-500">
                系统将自动汇总需求基线、阶段里程碑与任务、GitHub 工程提交、飞书协作决策、正式证据与成员贡献画像，由 AI 撰写可供任课教师直接评阅的 7 章正式结项报告。
              </p>
              <button
                type="button"
                disabled={!canRefresh}
                onClick={() => void refreshPreview(true)}
                className={`${toolbarPrimaryBtn} mt-5`}
              >
                <Sparkles size={13} className={isRefreshing ? "animate-pulse" : ""} />
                {isRefreshing ? "AI 正在撰写首版报告…" : "AI 生成首版报告"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Slide-Over Drawer for Version History, Teacher Review & Export Records */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-900/20 backdrop-blur-[1px] print:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="版本历史与导出记录"
            className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <History size={15} className="text-slate-500" />
                <h2 className="text-sm font-semibold text-slate-900">版本历史与导出管理</h2>
              </div>
              <button
                type="button"
                aria-label="关闭抽屉"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex border-b border-slate-100 px-5 pt-2 text-xs">
              <button
                type="button"
                onClick={() => setDrawerTab("versions")}
                className={`border-b-2 px-3 py-2 font-medium transition-colors ${
                  drawerTab === "versions"
                    ? "border-slate-900 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                版本与审核（{listing.versions.length}）
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab("exports")}
                className={`border-b-2 px-3 py-2 font-medium transition-colors ${
                  drawerTab === "exports"
                    ? "border-slate-900 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                导出与下载（{listing.artifacts.length}）
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-xs">
              {drawerTab === "versions" ? (
                <>
                  {listing.status === "submitted" && (
                    <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
                      <h3 className="mb-2 font-semibold text-amber-950">任课教师审核定稿</h3>
                      <textarea
                        aria-label="教师审核理由"
                        value={reviewReason}
                        onChange={(event) => setReviewReason(event.target.value)}
                        className={`${input} bg-white text-xs`}
                        rows={3}
                        placeholder="请填写评阅意见或修改建议…"
                      />
                      <div className="mt-2.5 flex gap-2">
                        <button
                          type="button"
                          disabled={busy || !reviewReason.trim()}
                          className={`${toolbarBtn} flex-1`}
                          onClick={() =>
                            void mutate(`${base}/review`, { action: "return", reason: reviewReason }, "已退回修改。", "review")
                          }
                        >
                          退回修改
                        </button>
                        <button
                          type="button"
                          disabled={busy || !reviewReason.trim()}
                          className={`${toolbarPrimaryBtn} flex-1`}
                          onClick={() =>
                            void mutate(
                              `${base}/review`,
                              { action: "approve", reason: reviewReason },
                              "已审核通过并定稿。",
                              "review",
                            )
                          }
                        >
                          <CheckCircle2 size={13} />
                          审核通过并定稿
                        </button>
                      </div>
                    </section>
                  )}

                  <section>
                    <h3 className="mb-2 font-semibold text-slate-700">历史快照版本</h3>
                    {listing.versions.length === 0 ? (
                      <p className="rounded-lg bg-slate-50 py-6 text-center text-slate-400">尚未生成报告版本</p>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {listing.versions.map((version) => {
                          const isActive = viewed?.version === version.version;
                          const vMeta = statusMeta[version.status] ?? { label: version.status, tone: "gray" as const };
                          return (
                            <li key={version.id} className="flex items-center justify-between gap-2 py-2.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelected(version.version);
                                  setEditing("");
                                  setDrawerOpen(false);
                                }}
                                className={`min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left transition-colors ${
                                  isActive ? "bg-sky-50 text-sky-950" : "hover:bg-slate-50 text-slate-700"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-semibold">v{version.version}</span>
                                  <StatusBadge tone={vMeta.tone} label={vMeta.label} />
                                  <span className="text-[11px] text-slate-500">
                                    {version.status === "generating"
                                      ? "AI 撰写中…"
                                      : version.status === "failed"
                                        ? "生成失败"
                                        : authoringLabel(version.data?.meta)}
                                  </span>
                                </div>
                                <p className="mt-0.5 truncate text-[11px] text-slate-400">
                                  {version.created_by_name ?? version.created_by ?? "系统"} ·{" "}
                                  {version.created_at?.slice(0, 16).replace("T", " ")}
                                </p>
                              </button>
                              {version.version !== latest?.version &&
                                ["generated", "returned", "failed"].includes(listing.status) &&
                                version.status === "generated" && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void mutate(
                                        `${base}/restore`,
                                        { version: version.version },
                                        `已恢复至 v${version.version}。`,
                                        "restore",
                                      )
                                    }
                                    className="shrink-0 font-medium text-sky-700 hover:underline disabled:opacity-50"
                                  >
                                    恢复
                                  </button>
                                )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="border-t border-slate-100 pt-4">
                    <h3 className="mb-2 font-semibold text-slate-700">提交与审核记录（{listing.reviews.length}）</h3>
                    {listing.reviews.length === 0 ? (
                      <p className="text-slate-400">暂无审核记录</p>
                    ) : (
                      <ul className="space-y-2">
                        {listing.reviews.map((item, index) => (
                          <li key={index} className="rounded-lg bg-slate-50/80 px-3 py-2 text-slate-600">
                            <div className="flex items-center justify-between font-medium text-slate-800">
                              <span>{item.action}</span>
                              <span className="text-[11px] font-normal text-slate-400">
                                {item.created_at?.slice(0, 16).replace("T", " ")}
                              </span>
                            </div>
                            <p className="mt-1 text-slate-600">{item.reason}</p>
                            <p className="mt-0.5 text-[11px] text-slate-400">操作人：{item.actor_name ?? item.actor_id}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              ) : (
                <>
                  {viewed && (
                    <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                      <p className="mb-2.5 font-semibold text-slate-800">快速导出当前版本（v{viewed.version}）</p>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          disabled={!canExport}
                          onClick={() => void exportAndDownloadNow(viewed.version, "pdf")}
                          className={toolbarBtn}
                        >
                          PDF
                        </button>
                        <button
                          type="button"
                          disabled={!canExport}
                          onClick={() => void exportAndDownloadNow(viewed.version, "docx")}
                          className={toolbarBtn}
                        >
                          Word
                        </button>
                        <button
                          type="button"
                          disabled={!canExport}
                          onClick={() => void exportAndDownloadNow(viewed.version, "md")}
                          className={toolbarBtn}
                        >
                          Markdown
                        </button>
                      </div>
                    </section>
                  )}

                  <section>
                    <h3 className="mb-2 font-semibold text-slate-700">历史导出文件（{listing.artifacts.length}）</h3>
                    {listing.artifacts.length === 0 ? (
                      <p className="rounded-lg bg-slate-50 py-6 text-center text-slate-400">暂无导出文件记录</p>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {listing.artifacts.map((item) => (
                          <li key={item.id} className="flex items-center justify-between gap-2 py-2.5">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold text-slate-900">
                                  v{item.version} · {item.format.toUpperCase()}
                                </span>
                                <StatusBadge
                                  tone={item.status === "ready" ? "green" : item.status === "failed" ? "red" : "amber"}
                                  label={item.status}
                                />
                              </div>
                              <p className="mt-0.5 text-[11px] text-slate-400">
                                {item.requested_by_name ?? item.requested_by} ·{" "}
                                {item.created_at?.slice(0, 16).replace("T", " ")}
                              </p>
                              {item.status === "failed" && item.error && (
                                <p className="mt-0.5 text-[11px] text-rose-600">{item.error}</p>
                              )}
                            </div>
                            {item.status === "ready" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void download(item.id, item.version, item.format)}
                                className="shrink-0 font-medium text-sky-700 hover:underline disabled:opacity-50"
                              >
                                下载
                              </button>
                            )}
                            {item.status === "failed" && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void exportAndDownloadNow(item.version, item.format)}
                                className={toolbarBtn}
                              >
                                重试
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="border-t border-slate-100 pt-4">
                    <h3 className="mb-2 font-semibold text-slate-700">下载审计记录（{listing.downloads.length}）</h3>
                    {listing.downloads.length === 0 ? (
                      <p className="text-slate-400">暂无下载记录</p>
                    ) : (
                      <ul className="space-y-1.5 text-slate-600">
                        {listing.downloads.slice(0, 10).map((item, index) => (
                          <li key={index} className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              v{item.version} · {item.format.toUpperCase()} · {item.user_name ?? item.user_id}
                            </span>
                            <span className="shrink-0 text-[11px] text-slate-400">
                              {item.created_at?.slice(0, 16).replace("T", " ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
