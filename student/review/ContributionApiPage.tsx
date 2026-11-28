"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Award,
  BarChart3,
  Calculator,
  CheckCircle2,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  GitBranchPlus,
  GitCommitHorizontal,
  Info,
  Lock,
  MessageSquare,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Avatar,
  EmptyState,
  Feedback,
  ProgressBar,
  Section,
  StateBlock,
  StatusBadge,
} from "@/shared/components/common";
import { TaskOriginBadge } from "@/shared/components/TaskOriginBadge";
import { useUrlQuery } from "@/shared/lib/use-url-query";
import { apiErrorText } from "@/shared/i18n/api-error-text";
import { ContributionWeek7Panel } from "@/student/review/ContributionWeek7Panel";
import {
  ContributionDistributionBar,
  MemberComparisonChart,
  ProjectStatusDonutPanel,
} from "@/student/review/ContributionCharts";
import { ReportApiPage } from "@/student/review/ReportApiPage";
import {
  contributionRequest,
  fetchContributionAnalytics,
  type ProjectContributionAnalytics,
} from "@/student/review/contribution-analytics";
import { exportContributionReport, type ContributionExportFormat } from "@/student/review/contribution-export";

const TASK_STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  pending_verification: "待人工确认",
  pending_submission: "待提交",
  in_progress: "进行中",
  not_started: "未开始",
};

const compactBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const compactPrimaryBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";

function formatCompact(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("zh-CN");
}

function ExportReportDropdown({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (format: ContributionExportFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options: {
    format: ContributionExportFormat;
    label: string;
    desc: string;
    icon: typeof FileText;
  }[] = [
    {
      format: "markdown",
      label: "Markdown (.md)",
      desc: "结构化文档，含全员指标与任务明细",
      icon: FileText,
    },
    {
      format: "word",
      label: "Word (.doc)",
      desc: "排版报表，支持 Word / WPS 直接打开",
      icon: FileText,
    },
    {
      format: "excel",
      label: "Excel (.xls)",
      desc: "双工作表（成员汇总 + 任务明细）",
      icon: FileSpreadsheet,
    },
  ];

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        className={compactBtn}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="contribution-export-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Download size={13} />
        导出报告
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="选择导出报告格式"
          className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-slate-200/90 bg-white p-1.5 shadow-lg"
        >
          {options.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.format}
                type="button"
                role="menuitem"
                data-testid={`export-option-${opt.format}`}
                onClick={() => {
                  setOpen(false);
                  onExport(opt.format);
                }}
                className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
              >
                <Icon size={15} className="mt-0.5 shrink-0 text-[var(--gp-action)]" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                  <div className="text-[11px] text-slate-500">{opt.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ContributionApiPage({
  projectId,
  memberId,
}: {
  projectId: string;
  memberId?: string;
}) {
  const tCode = useTranslations("codeDiscovery");
  const { query, updateQuery } = useUrlQuery();
  const activeTab: "analytics" | "report" = !memberId && query.get("tab") === "report" ? "report" : "analytics";
  const [analytics, setAnalytics] = useState<ProjectContributionAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/contribution`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchContributionAnalytics(projectId);
      setAnalytics(next);
      setError("");
    } catch (failure) {
      setError(apiErrorText(failure));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function calculate() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await contributionRequest(`${base}/calculate`, "POST");
      await refresh();
      setNotice("已根据当前正式成果重新计算贡献草稿，已包含全部在组项目成员。");
    } catch (failure) {
      setError(apiErrorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function freeze() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await contributionRequest(`${base}/freeze`, "POST");
      await refresh();
      setNotice("贡献快照已确认冻结，可用于正式结项报告与项目归档。");
    } catch (failure) {
      setError(apiErrorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function handleExport(format: ContributionExportFormat) {
    if (!analytics) return;
    setError("");
    exportContributionReport(analytics, format);
    const labelMap: Record<ContributionExportFormat, string> = {
      markdown: "Markdown (.md)",
      word: "Word (.doc)",
      excel: "Excel (.xls)",
    };
    setNotice(`已生成并开始下载 ${labelMap[format]} 贡献数据分析报告。`);
  }

  const snapshot = analytics?.snapshot ?? null;
  const isFrozen = snapshot?.status === "frozen" && !snapshot.stale;

  const selectedMember = useMemo(
    () => (memberId && analytics ? analytics.members.find((m) => m.userId === memberId) ?? null : null),
    [analytics, memberId],
  );

  const snapshotStatusSummary = useMemo(() => {
    if (!snapshot) return "未计算";
    if (snapshot.stale) return `待重算 (v${snapshot.version})`;
    return isFrozen ? `已冻结 (v${snapshot.version})` : `草稿 (v${snapshot.version})`;
  }, [isFrozen, snapshot]);

  return (
    <div className="space-y-3.5">
      {/* Compact Header with 2-Tab Switcher & Primary Actions */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            {memberId ? `${selectedMember ? `${selectedMember.name} · ` : ""}成员贡献详情` : "贡献与结项报告"}
          </h1>
          {!memberId && (
            <div className="gp-segmented" role="tablist" aria-label="贡献与结项报告视图">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "analytics"}
                data-active={activeTab === "analytics" ? "true" : undefined}
                className="gp-segmented-item"
                onClick={() => updateQuery({ tab: null })}
              >
                <BarChart3 size={13} className="mr-1 inline" />
                贡献数据分析
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "report"}
                data-active={activeTab === "report" ? "true" : undefined}
                className="gp-segmented-item"
                onClick={() => updateQuery({ tab: "report" })}
              >
                <FileText size={13} className="mr-1 inline" />
                结项报告
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {memberId ? (
            <Link className={compactBtn} href={`/projects/${projectId}/contribution`}>
              返回贡献数据分析台
            </Link>
          ) : (
            <Link className={compactBtn} href={`/projects/${projectId}`}>
              返回项目
            </Link>
          )}
          {!memberId && activeTab === "analytics" && (
            <>
              <ExportReportDropdown
                disabled={busy || loading || !analytics}
                onExport={handleExport}
              />
              {analytics?.canCalculate !== false && (
                <button
                  type="button"
                  className={compactPrimaryBtn}
                  disabled={busy}
                  onClick={() => void calculate()}
                >
                  <Calculator size={13} />
                  按当前正式成果重新计算
                </button>
              )}
              {analytics?.canFreeze !== false &&
                snapshot &&
                !snapshot.stale &&
                snapshot.status !== "frozen" && (
                  <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-emerald-700 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void freeze()}
                  >
                    <Lock size={13} />
                    确认并冻结贡献快照
                  </button>
                )}
            </>
          )}
        </div>
      </div>

      {activeTab === "report" && !memberId ? (
        <ReportApiPage projectId={projectId} embedded />
      ) : (
        <>
          {error && (
            <div role="alert">
              <Feedback tone="error">{error}</Feedback>
            </div>
          )}
          {notice && <Feedback tone="success">{notice}</Feedback>}
          {snapshot?.stale && (
            <Feedback tone="warning">
              正式成果或证据已变化；当前展示历史计算快照，请点击「按当前正式成果重新计算」更新权重。
            </Feedback>
          )}

          {loading && !analytics ? (
            <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <StateBlock tone="loading" title="正在汇总团队贡献与多维协作数据" />
            </div>
          ) : null}

          {isFrozen && !memberId && (
            <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-emerald-200/85 bg-emerald-50/60 px-4 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-slate-700">
                <StatusBadge tone="green" label={`已冻结（v${snapshot?.version}）`} />
                <span>贡献快照已锁定，可以直接生成并提交正式结项报告。</span>
              </div>
              <button
                type="button"
                className={compactPrimaryBtn}
                onClick={() => updateQuery({ tab: "report" })}
              >
                打开结项报告 →
              </button>
            </div>
          )}

          {memberId ? (
            selectedMember ? (
              <div className="space-y-3.5">
                {/* Compact Inline KPI Divider Strip for Member Detail */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-3 text-xs shadow-xs">
                  <div className="flex items-center gap-1.5">
                    <Award size={14} className="text-sky-600" />
                    <span className="text-slate-500">正式成果权重</span>
                    <span className="font-mono text-sm font-bold text-sky-700">{selectedMember.formalShare.toFixed(1)}%</span>
                    <span className="text-slate-400">(积分 {selectedMember.taskCredit})</span>
                    {(selectedMember.codeDiscoveredCredit ?? 0) > 0 && (
                      <span className="rounded-full border border-violet-200/80 bg-violet-50/90 px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-violet-700">
                        {tCode("contributionMemberSplit", {
                          planned: selectedMember.plannedCredit ?? Math.max(0, Math.round((selectedMember.taskCredit - (selectedMember.codeDiscoveredCredit ?? 0)) * 100) / 100),
                          discovered: selectedMember.codeDiscoveredCredit ?? 0,
                        })}
                      </span>
                    )}
                  </div>
                  <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 size={14} className="text-emerald-600" />
                    <span className="text-slate-500">任务完成</span>
                    <span className="font-mono text-sm font-bold text-emerald-700">
                      {selectedMember.completedCount} / {selectedMember.assignedCount}
                    </span>
                    <span className="text-slate-400">(加权 {selectedMember.weightedTaskProgress}%)</span>
                  </div>
                  <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                  <div className="flex items-center gap-1.5">
                    <GitCommitHorizontal size={14} className="text-violet-600" />
                    <span className="text-slate-500">GitHub</span>
                    <span className="font-mono text-sm font-bold text-slate-900">{selectedMember.commits} 次</span>
                    <span className="font-mono text-emerald-600">+{formatCompact(selectedMember.additions)}</span>
                    <span className="font-mono text-rose-500">-{formatCompact(selectedMember.deletions)}</span>
                  </div>
                  <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                  <div className="flex items-center gap-1.5">
                    <MessageSquare size={14} className="text-amber-600" />
                    <span className="text-slate-500">飞书协作</span>
                    <span className="font-mono text-sm font-bold text-slate-900">
                      {selectedMember.collabRecords} 条
                    </span>
                    <span className="text-slate-400">
                      ({selectedMember.collabTopics} 项结论 · 综合 {selectedMember.activityShare.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                <Section
                  title={`${selectedMember.name} · 正式成果权重 ${selectedMember.formalShare.toFixed(1)}%`}
                  description={`正式任务权重积分：${selectedMember.taskCredit}（快照版本：${snapshotStatusSummary}）`}
                  surface
                >
                  <div className="mb-3">
                    <ProgressBar value={selectedMember.formalShare} color={selectedMember.color} />
                  </div>
                  {selectedMember.formalTasks.length > 0 ? (
                    <div className="divide-y divide-slate-100">
                      {selectedMember.formalTasks.map((task) => (
                        <article className="space-y-1.5 py-2.5 first:pt-0 last:pb-0" key={task.task_id}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
                              <TaskOriginBadge task={task} compact />
                            </div>
                            <span className="gp-pill">
                              权重 {task.weight} · 有效占比 {task.responsibility_share}%
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-3 text-xs">
                            <Link className="gp-link" href={task.evidence_url}>
                              查看验收记录
                            </Link>
                            {task.evidence.map((ref) => (
                              <span
                                key={`${ref.criterion_id}:${ref.evidence_id}`}
                                className="inline-flex items-center gap-2"
                              >
                                <Link
                                  className="gp-link"
                                  href={`/projects/${projectId}/evidence?evidence=${ref.evidence_id}`}
                                >
                                  查看正式证据（v{ref.version}）
                                </Link>
                                <Link
                                  className="text-slate-500 hover:text-slate-700 hover:underline"
                                  href={`/projects/${projectId}/evidence?task=${task.task_id}&criterion=${ref.criterion_id}&capture=1`}
                                >
                                  按此标准补充证据
                                </Link>
                              </span>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="暂未计入正式验收成果"
                      description="该成员目前在已确认正式成果中的占比为 0%；待其负责的任务完成人工验收确认并重新计算贡献后将自动计入。"
                    />
                  )}
                </Section>

                <Section
                  title="指派任务执行明细"
                  description={`共负责 ${selectedMember.assignedCount} 项任务，加权完成进度 ${selectedMember.weightedTaskProgress}%`}
                  surface
                >
                  {selectedMember.assignedTasks.length > 0 ? (
                    <div className="divide-y divide-slate-100">
                      {selectedMember.assignedTasks.map((task) => (
                        <article className="flex flex-wrap items-center justify-between gap-2.5 py-2.5 first:pt-0 last:pb-0" key={task.id}>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              {task.code && (
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                                  {task.code}
                                </span>
                              )}
                              <span className="text-sm font-semibold text-slate-900">{task.title}</span>
                              <TaskOriginBadge task={task} compact />
                              <StatusBadge
                                status={task.status}
                                label={TASK_STATUS_LABEL[task.status] ?? task.status}
                              />
                            </div>
                            <div className="text-xs text-slate-500">
                              权重 {task.weight} · 进度 {task.progress_percent}% · 关联提交 {task.matched_commits ?? 0} 次 · 验收标准 {task.criteria_confirmed ?? 0}/{task.criteria_total ?? 0}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <Link className="gp-link" href={task.links.verification}>
                              验收页
                            </Link>
                            <Link className="gp-link" href={task.links.evidence}>
                              证据页
                            </Link>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="暂无指派任务" />
                  )}
                </Section>

                <ContributionWeek7Panel
                  projectId={projectId}
                  memberId={memberId}
                  tasks={selectedMember.formalTasks}
                />
              </div>
            ) : analytics ? (
              <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                <EmptyState title="未找到该成员的项目记录" description="该成员可能尚未加入本项目或已退出项目组。" />
              </div>
            ) : null
          ) : analytics ? (
            <div className="space-y-3.5">
              {/* Sleek Inline KPI Divider Strip */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-3 text-xs shadow-xs">
                <div className="flex items-center gap-1.5">
                  <Users size={14} className="text-sky-600" />
                  <span className="text-slate-500">团队成员</span>
                  <span className="font-mono text-sm font-bold text-slate-900">{analytics.members.length} 人</span>
                  <span className="text-slate-400">(正式 {analytics.formalParticipantCount} · 活跃 {analytics.activeContributorCount})</span>
                </div>
                <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                <div className="flex items-center gap-1.5">
                  <Award size={14} className="text-emerald-600" />
                  <span className="text-slate-500">任务完成</span>
                  <span className="font-mono text-sm font-bold text-emerald-700">
                    {analytics.taskStatusCounts.completed} / {analytics.taskStatusCounts.total}
                  </span>
                  <span className="text-slate-400">(积分 {analytics.totalFormalCredit})</span>
                </div>
                <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                <div className="flex items-center gap-1.5">
                  <GitCommitHorizontal size={14} className="text-violet-600" />
                  <span className="text-slate-500">代码提交</span>
                  <span className="font-mono text-sm font-bold text-slate-900">{analytics.totalCommits} 次</span>
                  <span className="font-mono text-emerald-600">+{formatCompact(analytics.totalAdditions)}</span>
                  <span className="font-mono text-rose-500">-{formatCompact(analytics.totalDeletions)}</span>
                </div>
                <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                <div className="flex items-center gap-1.5">
                  <MessageSquare size={14} className="text-amber-600" />
                  <span className="text-slate-500">飞书消息</span>
                  <span className="font-mono text-sm font-bold text-slate-900">{analytics.feishuTotalMessages} 条</span>
                </div>
                <span className="ml-auto rounded-full bg-slate-100 px-2.5 py-0.5 font-medium text-slate-600">
                  快照：{snapshotStatusSummary}
                </span>
              </div>

              {analytics.originSummary && analytics.originSummary.code_discovered_task_count > 0 && (
                <div
                  data-testid="contribution-origin-breakdown"
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-violet-200/80 bg-white px-4 py-2.5 text-xs shadow-2xs"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                      <GitBranchPlus size={14} className="text-violet-600" aria-hidden="true" />
                      {tCode("contributionStripTitle")}
                    </span>
                    <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
                    <span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-slate-700">
                      <span className="h-2 w-2 rounded-full bg-slate-400" aria-hidden="true" />
                      {tCode("contributionPlanned", {
                        count: analytics.originSummary.planned_task_count,
                        credit: analytics.originSummary.planned_weight_total,
                      })}
                    </span>
                    <span className="text-slate-300" aria-hidden="true">vs</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200/85 bg-violet-50/85 px-2.5 py-0.5 font-mono font-semibold tabular-nums text-violet-800">
                      <span className="h-2 w-2 rounded-full bg-violet-500" aria-hidden="true" />
                      {tCode("contributionCodeDiscovered", {
                        count: analytics.originSummary.code_discovered_task_count,
                        credit: analytics.originSummary.code_discovered_weight_total,
                        share: Math.round(analytics.originSummary.code_discovered_weight_share * 10) / 10,
                      })}
                    </span>
                  </div>
                  {analytics.originSummary.high_expansion_warning && (
                    <span
                      data-testid="contribution-high-expansion-warning"
                      className="inline-flex items-center gap-1 rounded-full border border-amber-200/90 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800"
                    >
                      <AlertTriangle size={11} aria-hidden="true" />
                      {tCode("highExpansionWarning")}
                    </span>
                  )}
                </div>
              )}

              {/* Visual Section 1: Stacked horizontal distribution bar */}
              <ContributionDistributionBar
                members={analytics.members}
                hasFormalSnapshot={Boolean(snapshot && analytics.formalParticipantCount > 0)}
              />

              {/* Visual Section 2: Side-by-side SVG charts */}
              <div className="grid gap-3.5 lg:grid-cols-2">
                <MemberComparisonChart members={analytics.members} />
                <ProjectStatusDonutPanel analytics={analytics} />
              </div>

              {/* Visual Section 3: All-members pure-data breakdown table (no redundant progress bars) */}
              <Section
                title="全员贡献明细"
                surface
              >
                {analytics.members.length > 0 ? (
                  <div className="gp-table-wrap">
                    <table className="gp-table" data-testid="contribution-members-table">
                      <thead>
                        <tr>
                          <th>成员</th>
                          <th className="text-right">正式占比 / 积分</th>
                          <th className="text-right">任务完成</th>
                          <th className="text-right">GitHub 提交 / PR / 行数</th>
                          <th className="text-right">飞书关联与结论</th>
                          <th className="text-right">详情</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.members.map((member) => (
                          <tr key={member.userId} data-testid={`member-row-${member.userId}`}>
                            <td>
                              <div className="flex items-center gap-2.5">
                                <Avatar name={member.name} size={26} />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className="h-2 w-2 shrink-0 rounded-full"
                                      style={{ backgroundColor: member.color }}
                                    />
                                    <span className="font-semibold text-slate-900">{member.name}</span>
                                  </div>
                                  {member.githubLogin && (
                                    <div className="text-[11px] text-slate-400">@{member.githubLogin}</div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="text-right">
                              <div className="font-mono text-sm font-bold tabular-nums text-slate-900">
                                {member.formalShare.toFixed(1)}%
                              </div>
                              <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                                积分 {member.taskCredit} · {member.formalTasks.length} 项成果
                              </div>
                              {(member.codeDiscoveredCredit ?? 0) > 0 && (
                                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-violet-700">
                                  {tCode("contributionMemberSplit", {
                                    planned:
                                      member.plannedCredit ??
                                      Math.max(
                                        0,
                                        Math.round((member.taskCredit - (member.codeDiscoveredCredit ?? 0)) * 100) / 100,
                                      ),
                                    discovered: member.codeDiscoveredCredit ?? 0,
                                  })}
                                </div>
                              )}
                            </td>
                            <td className="text-right">
                              <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                                {member.completedCount} / {member.assignedCount} 完成
                              </div>
                              <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                                加权 {member.weightedTaskProgress}%
                                {member.pendingVerificationCount > 0 && (
                                  <span className="ml-1.5 font-medium text-sky-700">
                                    · {member.pendingVerificationCount} 待确认
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="text-right">
                              <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                                {member.commits} 提交{member.pullRequests > 0 ? ` · ${member.pullRequests} PR` : ""}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] tabular-nums">
                                <span className="text-emerald-700">+{formatCompact(member.additions)}</span>{" "}
                                <span className="text-rose-600">-{formatCompact(member.deletions)}</span>
                              </div>
                            </td>
                            <td className="text-right">
                              <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                                {member.collabRecords} 条关联 · {member.collabTopics} 项结论
                              </div>
                              <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                                综合活跃参考 {member.activityShare.toFixed(1)}%
                              </div>
                            </td>
                            <td className="text-right">
                              <Link
                                className="gp-link whitespace-nowrap text-xs"
                                href={`/projects/${projectId}/contribution/${member.userId}`}
                              >
                                查看任务与证据
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    title="暂无在组项目成员"
                    description="请先在项目成员管理中确认至少一名活跃成员。"
                  />
                )}
              </Section>

              {/* Academic transparency note */}
              <div className="flex items-start gap-2.5 rounded-2xl border border-sky-200/70 bg-sky-50/60 px-4 py-3 text-xs leading-relaxed text-slate-700">
                <Info size={15} className="mt-0.5 shrink-0 text-[var(--gp-action)]" />
                <div className="space-y-1">
                  <div>
                    <strong className="font-semibold text-slate-900">学术透明性与计算口径说明：</strong>
                    <span className="ml-1">
                      <strong>正式验收权重（用于结项冻结）</strong> 严格以已确认任务权重为锚点：无跨任务代码贡献时沿用 100% 确认责任占比；若有非任务负责人在该任务贡献实质代码（正式 GitHub 证据、任务直接关联/显式编号 ≥20 有效行且 ≥10%，或跨分工功能匹配 ≥80 有效行且 ≥15%，自动排除合并提交、锁文件与生成文件），则所有参与者按任务权重<strong>等权平分</strong>，不按代码行数或提交次数刷分（公式{" "}
                      <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px] text-slate-800">
                        {snapshot?.formula_version ?? "formal-task-weight-cross-task-equal-split-v2"}
                      </code>
                      ）；尚无计入成果的成员如实保留并计为 <code className="font-mono">0.0%</code>。
                    </span>
                  </div>
                  <div>
                    <strong>全过程综合活跃参考</strong> 按 <strong>85% 任务实际交付（含跨任务平分）+ 15% 全仓对数工程量兜底</strong> 加权（覆盖未挂单任务的基建与重构，无 GitHub 数据时自动归一化为 100% 任务交付）；<strong>代码提交次数与飞书群聊仅作过程参考（0% 权重）</strong>，不替代正式结项贡献权重。
                    {analytics.unmatchedCommits > 0 && (
                      <span className="ml-1 text-slate-500">
                        （注：另有 {analytics.unmatchedCommits} 次未关联到在组账号的 GitHub 提交未归入个人行。）
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
