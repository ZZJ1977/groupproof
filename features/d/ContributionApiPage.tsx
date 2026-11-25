"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Award,
  Calculator,
  CheckCircle2,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  GitCommitHorizontal,
  Info,
  Lock,
  MessageSquare,
  Users,
} from "lucide-react";
import {
  Avatar,
  EmptyState,
  Feedback,
  PageHeader,
  ProgressBar,
  Section,
  Stat,
  StateBlock,
  StatusBadge,
} from "@/components/common";
import { button, secondary } from "@/features/b/ui";
import { ContributionWeek7Panel } from "./ContributionWeek7Panel";
import {
  ContributionDistributionBar,
  MemberComparisonChart,
  ProjectStatusDonutPanel,
} from "./ContributionCharts";
import {
  contributionRequest,
  fetchContributionAnalytics,
  type ProjectContributionAnalytics,
} from "./contribution-analytics";
import { exportContributionReport, type ContributionExportFormat } from "./contribution-export";

const TASK_STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  pending_verification: "待人工确认",
  pending_submission: "待提交",
  in_progress: "进行中",
  not_started: "未开始",
};

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
        className={secondary}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="contribution-export-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Download size={14} />
        导出报告
        <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
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
      setError((failure as Error).message);
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
      setError((failure as Error).message);
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
      setError((failure as Error).message);
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
    <div className="space-y-6">
      <PageHeader
        title={memberId ? `${selectedMember ? `${selectedMember.name} · ` : ""}成员贡献详情` : "贡献数据分析台"}
        description={
          memberId
            ? "查看成员在正式验收成果中的任务权重、多维过程参与记录及证据明细。"
            : "汇总正式成果权重、任务执行进度、GitHub 代码提交与飞书协作记录，全面呈现每位团队成员贡献。"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {memberId ? (
              <Link className={secondary} href={`/projects/${projectId}/contribution`}>
                返回贡献数据分析台
              </Link>
            ) : (
              <Link className={secondary} href={`/projects/${projectId}`}>
                返回项目
              </Link>
            )}
            {!memberId && (
              <ExportReportDropdown
                disabled={busy || loading || !analytics}
                onExport={handleExport}
              />
            )}
            {!memberId && analytics?.canCalculate !== false && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void calculate()}
              >
                <Calculator size={14} />
                按当前正式成果重新计算
              </button>
            )}
            {!memberId &&
              analytics?.canFreeze !== false &&
              snapshot &&
              !snapshot.stale &&
              snapshot.status !== "frozen" && (
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-xs transition-all hover:bg-emerald-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void freeze()}
                >
                  <Lock size={14} />
                  确认并冻结贡献快照
                </button>
              )}
          </div>
        }
      />

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
        <div className="gp-surface-card">
          <StateBlock tone="loading" title="正在汇总团队贡献与多维协作数据" />
        </div>
      ) : null}

      {isFrozen && !memberId && (
        <div className="gp-surface-card flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-sm text-slate-700">
            <StatusBadge tone="green" label={`已冻结（v${snapshot?.version}）`} />
            <span>贡献快照已锁定，可以生成并提交正式项目报告。</span>
          </div>
          <Link className={button} href={`/projects/${projectId}/reports`}>
            前往项目报告 →
          </Link>
        </div>
      )}

      {memberId ? (
        selectedMember ? (
          <div className="space-y-6">
            <div className="gp-grid-4">
              <Stat
                label="正式成果权重"
                value={`${selectedMember.formalShare.toFixed(1)}%`}
                sub={`正式积分 ${selectedMember.taskCredit} · ${selectedMember.formalTasks.length} 项成果`}
                accent="#0369a1"
                icon={Award}
              />
              <Stat
                label="任务完成进度"
                value={`${selectedMember.completedCount} / ${selectedMember.assignedCount}`}
                sub={`加权进度 ${selectedMember.weightedTaskProgress}% · 待确认 ${selectedMember.pendingVerificationCount} 项`}
                accent="#059669"
                icon={CheckCircle2}
              />
              <Stat
                label="GitHub 代码提交"
                value={`${selectedMember.commits} 次`}
                sub={`+${formatCompact(selectedMember.additions)} / -${formatCompact(selectedMember.deletions)} 行 · ${selectedMember.pullRequests} PR`}
                accent="#7c3aed"
                icon={GitCommitHorizontal}
              />
              <Stat
                label="协作与综合活跃"
                value={`${selectedMember.activityShare.toFixed(1)}%`}
                sub={`飞书关联 ${selectedMember.collabRecords} 条记录 · ${selectedMember.collabTopics} 项结论`}
                accent="#d97706"
                icon={MessageSquare}
              />
            </div>

            <Section
              title={`${selectedMember.name} · 正式成果权重 ${selectedMember.formalShare.toFixed(1)}%`}
              description={`正式任务权重积分：${selectedMember.taskCredit}（快照版本：${snapshotStatusSummary}）`}
              surface
            >
              <div className="mb-4">
                <ProgressBar value={selectedMember.formalShare} color={selectedMember.color} />
              </div>
              {selectedMember.formalTasks.length > 0 ? (
                <div className="divide-y divide-slate-100">
                  {selectedMember.formalTasks.map((task) => (
                    <article className="space-y-2 py-3.5 first:pt-0 last:pb-0" key={task.task_id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
                        <span className="gp-pill">
                          权重 {task.weight} · 承担 {task.responsibility_share}%
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
                    <article className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" key={task.id}>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {task.code && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                              {task.code}
                            </span>
                          )}
                          <span className="text-sm font-semibold text-slate-900">{task.title}</span>
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
          <div className="gp-surface-card">
            <EmptyState title="未找到该成员的项目记录" description="该成员可能尚未加入本项目或已退出项目组。" />
          </div>
        ) : null
      ) : analytics ? (
        <div className="space-y-6">
          {/* Top 4 KPI Cards */}
          <div className="gp-grid-4">
            <Stat
              label="团队成员总数"
              value={`${analytics.members.length} 人`}
              sub={`正式计入 ${analytics.formalParticipantCount} 人 · 活跃贡献 ${analytics.activeContributorCount} 人`}
              accent="#0369a1"
              icon={Users}
            />
            <Stat
              label="任务完成与正式成果"
              value={`${analytics.taskStatusCounts.completed} / ${analytics.taskStatusCounts.total}`}
              sub={`正式积分 ${analytics.totalFormalCredit} · 待人工确认 ${analytics.taskStatusCounts.pendingVerification} 项`}
              accent="#059669"
              icon={Award}
            />
            <Stat
              label="代码提交与改动量"
              value={`${analytics.totalCommits} 次`}
              sub={`+${formatCompact(analytics.totalAdditions)} / -${formatCompact(analytics.totalDeletions)} 行 · ${analytics.totalPullRequests} PR`}
              accent="#7c3aed"
              icon={GitCommitHorizontal}
            />
            <Stat
              label="飞书协作与快照状态"
              value={`${analytics.feishuTotalMessages} 条`}
              sub={`快照：${snapshotStatusSummary}`}
              accent={isFrozen ? "#047857" : "#d97706"}
              icon={MessageSquare}
            />
          </div>

          {/* Visual Section 1: Stacked horizontal distribution bar */}
          <ContributionDistributionBar
            members={analytics.members}
            hasFormalSnapshot={Boolean(snapshot && analytics.formalParticipantCount > 0)}
          />

          {/* Visual Section 2: Side-by-side SVG charts */}
          <div className="grid gap-5 lg:grid-cols-2">
            <MemberComparisonChart members={analytics.members} />
            <ProjectStatusDonutPanel analytics={analytics} />
          </div>

          {/* Visual Section 3: All-members breakdown table */}
          <Section
            title="全员多维贡献明细"
            description="完整列出全部在组项目成员（含暂未确认正式成果、当前正式占比 0% 的成员）。"
            surface
          >
            {analytics.members.length > 0 ? (
              <div className="gp-table-wrap">
                <table className="gp-table" data-testid="contribution-members-table">
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>正式成果权重</th>
                      <th>任务完成情况</th>
                      <th>GitHub 代码提交</th>
                      <th>协作与综合活跃</th>
                      <th className="text-right">详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.members.map((member) => (
                      <tr key={member.userId} data-testid={`member-row-${member.userId}`}>
                        <td>
                          <div className="flex items-center gap-3">
                            <Avatar name={member.name} size={32} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: member.color }}
                                />
                                <span className="font-semibold text-slate-900">{member.name}</span>
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {member.githubLogin ? `@${member.githubLogin}` : "未绑定 GitHub 别名"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="min-w-[165px]">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-sm font-bold tabular-nums text-slate-900">
                              {member.formalShare.toFixed(1)}%
                            </span>
                            <span className="text-[11px] text-slate-500">
                              积分 {member.taskCredit} · {member.formalTasks.length} 项
                            </span>
                          </div>
                          <div className="mt-1.5">
                            <ProgressBar value={member.formalShare} color={member.color} />
                          </div>
                        </td>
                        <td className="min-w-[160px]">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-xs font-semibold tabular-nums text-slate-800">
                              {member.completedCount} / {member.assignedCount} 完成
                            </span>
                            <span className="text-[11px] text-slate-500">
                              进度 {member.weightedTaskProgress}%
                            </span>
                          </div>
                          <div className="mt-1.5">
                            <ProgressBar value={member.weightedTaskProgress} color="#059669" />
                          </div>
                          {member.pendingVerificationCount > 0 && (
                            <div className="mt-1 text-[11px] font-medium text-sky-700">
                              {member.pendingVerificationCount} 项待人工确认
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                            {member.commits} 次提交{member.pullRequests > 0 ? ` · ${member.pullRequests} PR` : ""}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] tabular-nums">
                            <span className="text-emerald-700">+{formatCompact(member.additions)}</span>{" "}
                            <span className="text-rose-600">-{formatCompact(member.deletions)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                            综合参考 {member.activityShare.toFixed(1)}%
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            飞书关联 {member.collabRecords} 条 · {member.collabTopics} 项结论
                          </div>
                        </td>
                        <td className="text-right">
                          <Link
                            className="gp-link text-xs whitespace-nowrap"
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
          <div className="flex items-start gap-3 rounded-2xl border border-sky-200/70 bg-sky-50/60 px-4 py-3.5 text-xs leading-relaxed text-slate-700">
            <Info size={16} className="mt-0.5 shrink-0 text-[var(--gp-action)]" />
            <div className="space-y-1">
              <div>
                <strong className="font-semibold text-slate-900">学术透明性与计算口径说明：</strong>
                <span className="ml-1">
                  <strong>正式验收权重（用于结项冻结）</strong> 严格依据已通过人工确认的正式成果与任务责任占比计算（公式{" "}
                  <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px] text-slate-800">
                    {snapshot?.formula_version ?? "formal-task-weight-x-confirmed-responsibility-v1"}
                  </code>
                  ）；尚无已确认正式成果的成员会如实保留在列表中并计为 <code className="font-mono">0.0%</code>。
                </span>
              </div>
              <div>
                <strong>全过程综合活跃参考</strong> 综合任务推进进度、GitHub 代码提交与飞书群聊任务关联记录，仅用于过程透明展示与团队复盘，不自动替代正式结项贡献权重。
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
    </div>
  );
}
