"use client";

import { useMemo, useState } from "react";
import { BarChart3, GitCommitHorizontal, GitPullRequest, MessageSquare, PieChart, Sparkles } from "lucide-react";
import type { FeishuInsightCategory } from "@/student/execution/FeishuCollaborationInsights";
import type { MemberAnalyticsRow, ProjectContributionAnalytics } from "@/student/review/contribution-analytics";

type ShareMode = "formal" | "activity";

const FEISHU_CATEGORY_META: {
  key: FeishuInsightCategory;
  label: string;
  color: string;
}[] = [
  { key: "task_progress", label: "任务推进", color: "#0284c7" },
  { key: "decision", label: "关键决策", color: "#7c3aed" },
  { key: "division_confirm", label: "分工确认", color: "#059669" },
  { key: "doc_review", label: "文档评审", color: "#0d9488" },
  { key: "blocker", label: "阻塞处理", color: "#d97706" },
];

function formatCompact(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("zh-CN");
}

function formatSignedCompact(n: number): string {
  if (n > 0) return `+${formatCompact(n)}`;
  if (n < 0) return `-${formatCompact(Math.abs(n))}`;
  return "0";
}

export function ContributionDistributionBar({
  members,
  hasFormalSnapshot,
}: {
  members: MemberAnalyticsRow[];
  hasFormalSnapshot: boolean;
}) {
  const [mode, setMode] = useState<ShareMode>(hasFormalSnapshot ? "formal" : "activity");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const effectiveMode: ShareMode = hasFormalSnapshot ? mode : "activity";

  const segments = useMemo(
    () =>
      members.map((m) => ({
        userId: m.userId,
        name: m.name,
        color: m.color,
        value: effectiveMode === "formal" ? m.formalShare : m.activityShare,
        subLabel:
          effectiveMode === "formal"
            ? `正式积分 ${m.taskCredit} · ${m.formalTasks.length} 项成果`
            : `${m.commits} 提交 · ${m.completedCount}/${m.assignedCount} 任务 · 飞书 ${m.collabRecords} 条`,
      })),
    [effectiveMode, members],
  );

  const totalValue = segments.reduce((acc, s) => acc + s.value, 0);

  return (
    <section
      aria-label="全员贡献占比分布"
      className="gp-surface-card space-y-3"
      data-testid="contribution-distribution-bar"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-slate-900">
          <BarChart3 size={16} className="text-[var(--gp-action)]" />
          团队全员贡献占比分布
        </h2>

        <div className="gp-segmented" role="tablist" aria-label="贡献占比口径切换">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveMode === "formal"}
            data-active={effectiveMode === "formal" ? "true" : undefined}
            disabled={!hasFormalSnapshot}
            className="gp-segmented-item disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => setMode("formal")}
          >
            正式验收权重
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveMode === "activity"}
            data-active={effectiveMode === "activity" ? "true" : undefined}
            className="gp-segmented-item"
            onClick={() => setMode("activity")}
          >
            全过程综合活跃参考
          </button>
        </div>
      </div>

      {/* Full-width stacked horizontal bar */}
      <div
        className="flex h-7 w-full overflow-hidden rounded-xl border border-slate-200/80 bg-slate-100/90 p-0.5"
        role="img"
        aria-label="成员贡献占比堆叠条形图"
      >
        {totalValue > 0 ? (
          segments.map((seg) => {
            if (seg.value <= 0) return null;
            const dimmed = hoveredId !== null && hoveredId !== seg.userId;
            return (
              <div
                key={seg.userId}
                title={`${seg.name}: ${seg.value.toFixed(1)}% (${seg.subLabel})`}
                onMouseEnter={() => setHoveredId(seg.userId)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  width: `${Math.max(1.5, seg.value)}%`,
                  backgroundColor: seg.color,
                  opacity: dimmed ? 0.35 : 1,
                }}
                className="flex h-full items-center justify-center overflow-hidden px-1.5 text-[11px] font-bold text-white transition-opacity first:rounded-l-[9px] last:rounded-r-[9px]"
              >
                {seg.value >= 8 && (
                  <span className="truncate tabular-nums">
                    {seg.name} {seg.value.toFixed(1)}%
                  </span>
                )}
              </div>
            );
          })
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
            暂未检测到可分配的活动占比，下方展示全部成员实时状态
          </div>
        )}
      </div>

      {/* Ultra-compact 1-line inline legend pills */}
      <div className="flex flex-wrap items-center gap-2">
        {segments.map((seg) => {
          const isHovered = hoveredId === seg.userId;
          return (
            <div
              key={seg.userId}
              title={seg.subLabel}
              onMouseEnter={() => setHoveredId(seg.userId)}
              onMouseLeave={() => setHoveredId(null)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                isHovered
                  ? "border-sky-300 bg-sky-50/70 text-slate-900"
                  : "border-slate-200/80 bg-slate-50/70 text-slate-700"
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: seg.color }}
              />
              <span className="font-medium text-slate-800">{seg.name}</span>
              <span className="font-mono font-bold tabular-nums text-slate-900">
                {seg.value.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MemberComparisonChart({ members }: { members: MemberAnalyticsRow[] }) {
  const [hoveredMember, setHoveredMember] = useState<string | null>(null);
  const maxCommits = Math.max(1, ...members.map((m) => m.commits));
  const maxCollab = Math.max(1, ...members.map((m) => m.collabScore));

  // SVG layout metrics
  const labelWidth = 84;
  const chartWidth = 310;
  const valueWidth = 108;
  const totalWidth = labelWidth + chartWidth + valueWidth;
  const rowGap = 14;
  const memberBlockHeight = 68;
  const topPad = 10;
  const totalHeight = topPad + members.length * (memberBlockHeight + rowGap);

  const metrics = [
    { key: "formal", label: "正式成果权重", color: "#0284c7" },
    { key: "tasks", label: "任务完成进度", color: "#059669" },
    { key: "commits", label: "代码提交", color: "#7c3aed" },
    { key: "collab", label: "飞书协作参与", color: "#d97706" },
  ] as const;

  return (
    <section
      aria-label="成员多维贡献对比图"
      className="gp-surface-card flex flex-col justify-between space-y-3.5"
      data-testid="member-comparison-chart"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[15px] font-bold tracking-tight text-slate-900">成员多维贡献对比图</h2>
        <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-600">
          {metrics.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1 font-medium">
              <span className="h-2 w-2 rounded-xs" style={{ backgroundColor: m.color }} />
              {m.label}
            </span>
          ))}
        </div>
      </div>

      {members.length === 0 ? (
        <div className="py-12 text-center text-xs text-slate-400">暂无活跃项目成员数据</div>
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${totalWidth} ${totalHeight}`}
            className="w-full min-w-[440px]"
            role="img"
            aria-label="成员多维贡献 SVG 分组条形图"
          >
            {/* Vertical grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
              const x = labelWidth + pct * chartWidth;
              return (
                <line
                  key={pct}
                  x1={x}
                  y1={0}
                  x2={x}
                  y2={totalHeight - 8}
                  stroke="#e2e8f0"
                  strokeDasharray={pct === 0 ? undefined : "3 3"}
                  strokeWidth={1}
                />
              );
            })}

            {members.map((member, index) => {
              const y0 = topPad + index * (memberBlockHeight + rowGap);
              const bars = [
                {
                  key: "formal",
                  pct: Math.min(100, Math.max(0, member.formalShare)),
                  text: `${member.formalShare.toFixed(1)}%`,
                  color: "#0284c7",
                },
                {
                  key: "tasks",
                  pct: Math.min(100, Math.max(0, member.weightedTaskProgress)),
                  text: `${member.weightedTaskProgress}% (${member.completedCount}/${member.assignedCount})`,
                  color: "#059669",
                },
                {
                  key: "commits",
                  pct: Math.round((member.commits / maxCommits) * 100),
                  text: `${member.commits} 次提交`,
                  color: "#7c3aed",
                },
                {
                  key: "collab",
                  pct: Math.round((member.collabScore / maxCollab) * 100),
                  text: `${member.collabRecords} 条 · ${member.collabTopics} 结论`,
                  color: "#d97706",
                },
              ];

              const dimmed = hoveredMember !== null && hoveredMember !== member.userId;

              return (
                <g
                  key={member.userId}
                  style={{ opacity: dimmed ? 0.45 : 1, transition: "opacity 150ms ease" }}
                  onMouseEnter={() => setHoveredMember(member.userId)}
                  onMouseLeave={() => setHoveredMember(null)}
                >
                  {/* Member badge dot + name */}
                  <circle cx={8} cy={y0 + 26} r={4.5} fill={member.color} />
                  <text
                    x={18}
                    y={y0 + 30}
                    fill="#0f172a"
                    fontSize={12}
                    fontWeight={700}
                  >
                    {member.name.length > 5 ? `${member.name.slice(0, 5)}…` : member.name}
                  </text>
                  <text x={18} y={y0 + 46} fill="#64748b" fontSize={10}>
                    综合 {member.activityShare.toFixed(1)}%
                  </text>

                  {/* 4 metric bars */}
                  {bars.map((bar, bIdx) => {
                    const barY = y0 + bIdx * 15;
                    const barW = bar.pct > 0 ? Math.max(4, (bar.pct / 100) * chartWidth) : 2;
                    return (
                      <g key={bar.key}>
                        <rect
                          x={labelWidth}
                          y={barY}
                          width={chartWidth}
                          height={9}
                          rx={4.5}
                          fill="#f1f5f9"
                        />
                        <rect
                          x={labelWidth}
                          y={barY}
                          width={barW}
                          height={9}
                          rx={4.5}
                          fill={bar.color}
                        />
                        <text
                          x={labelWidth + chartWidth + 8}
                          y={barY + 8}
                          fill="#334155"
                          fontSize={10}
                          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        >
                          {bar.text}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}

export function ProjectStatusDonutPanel({
  analytics,
}: {
  analytics: ProjectContributionAnalytics;
}) {
  const { taskStatusCounts, feishuInsights } = analytics;
  const slices = useMemo(
    () => [
      { key: "completed", label: "已完成", value: taskStatusCounts.completed, color: "#059669" },
      {
        key: "pendingVerification",
        label: "待人工确认",
        value: taskStatusCounts.pendingVerification,
        color: "#0284c7",
      },
      { key: "inProgress", label: "进行中", value: taskStatusCounts.inProgress, color: "#6366f1" },
      {
        key: "pendingSubmission",
        label: "待提交",
        value: taskStatusCounts.pendingSubmission,
        color: "#d97706",
      },
      { key: "notStarted", label: "未开始", value: taskStatusCounts.notStarted, color: "#cbd5e1" },
    ],
    [taskStatusCounts],
  );

  const totalTasks = Math.max(0, taskStatusCounts.total);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const activeSlices = slices.filter((s) => s.value > 0);
  const donutArcs = useMemo(() => {
    let offset = 0;
    return activeSlices.map((slice) => {
      const length = totalTasks > 0 ? (slice.value / totalTasks) * circumference : 0;
      const arc = { ...slice, length, offset };
      offset += length;
      return arc;
    });
  }, [activeSlices, circumference, totalTasks]);

  const insightItems = useMemo(() => feishuInsights?.items ?? [], [feishuInsights]);
  const insightDone = insightItems.filter((i) => i.status === "completed").length;
  const insightProgress = insightItems.filter((i) => i.status === "in_progress").length;
  const insightFollowup = insightItems.filter((i) => i.status === "needs_followup").length;

  const categoryBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of insightItems) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    const knownKeys = new Set<string>(FEISHU_CATEGORY_META.map((c) => c.key));
    const rows: { key: string; label: string; color: string; count: number }[] = FEISHU_CATEGORY_META.map(
      (meta) => ({
        ...meta,
        count: counts.get(meta.key) ?? 0,
      }),
    );
    let otherCount = 0;
    for (const [key, count] of counts.entries()) {
      if (!knownKeys.has(key)) otherCount += count;
    }
    if (otherCount > 0) {
      rows.push({ key: "other", label: "其他协作", color: "#64748b", count: otherCount });
    }
    return rows.filter((row) => row.count > 0);
  }, [insightItems]);

  const totalChurn = analytics.totalAdditions + analytics.totalDeletions;
  const netLines = analytics.totalAdditions - analytics.totalDeletions;
  const additionsPct = totalChurn > 0 ? Math.round((analytics.totalAdditions / totalChurn) * 100) : 0;
  const deletionsPct = totalChurn > 0 ? 100 - additionsPct : 0;
  const matchedCommits = Math.max(0, analytics.totalCommits - analytics.unmatchedCommits);

  return (
    <section
      aria-label="项目交付概览"
      className="gp-surface-card flex flex-col space-y-4"
      data-testid="project-status-donut"
    >
      {/* Top: Task status SVG donut */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-slate-900">
            <PieChart size={16} className="text-[var(--gp-action)]" />
            项目交付概览
          </h2>
          <span className="shrink-0 whitespace-nowrap rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-700">
            共 {totalTasks} 项任务
          </span>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-6">
          <div className="relative flex shrink-0 items-center justify-center">
            <svg width="136" height="136" viewBox="0 0 136 136" role="img" aria-label="项目任务状态环形图">
              <circle cx="68" cy="68" r={radius} fill="none" stroke="#f1f5f9" strokeWidth="18" />
              <g transform="rotate(-90 68 68)">
                {donutArcs.map((arc) => (
                  <circle
                    key={arc.key}
                    cx="68"
                    cy="68"
                    r={radius}
                    fill="none"
                    stroke={arc.color}
                    strokeWidth="18"
                    strokeDasharray={`${arc.length} ${circumference}`}
                    strokeDashoffset={-arc.offset}
                  />
                ))}
              </g>
              <text
                x="68"
                y="65"
                textAnchor="middle"
                fill="#0f172a"
                fontSize="20"
                fontWeight="800"
              >
                {totalTasks > 0 ? `${Math.round((taskStatusCounts.completed / totalTasks) * 100)}%` : "0%"}
              </text>
              <text x="68" y="83" textAnchor="middle" fill="#64748b" fontSize="10.5">
                已完成比例
              </text>
            </svg>
          </div>

          <div className="grid min-w-[180px] flex-1 gap-2">
            {slices.map((s) => {
              const pct = totalTasks > 0 ? Math.round((s.value / totalTasks) * 100) : 0;
              return (
                <div key={s.key} className="flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-2 text-slate-700">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-slate-900">
                    {s.value} <span className="text-slate-400">({pct}%)</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Middle A: Feishu AI collaboration conclusion category distribution */}
      <div
        className="border-t border-slate-100 pt-3.5"
        data-testid="feishu-insight-category-breakdown"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
            <Sparkles size={13.5} className="shrink-0 text-amber-600" />
            飞书 AI 协作结论分布
          </span>
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold tabular-nums text-slate-600">
            {insightItems.length > 0 ? `共 ${insightItems.length} 项结论` : "暂未生成"}
          </span>
        </div>

        {insightItems.length > 0 ? (
          <>
            <div
              className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="img"
              aria-label="飞书 AI 协作结论分类分布条"
            >
              {categoryBreakdown.map((cat) => {
                const pct = Math.round((cat.count / insightItems.length) * 100);
                return (
                  <div
                    key={cat.label}
                    title={`${cat.label}：${cat.count} 项 (${pct}%)`}
                    style={{
                      width: `${(cat.count / insightItems.length) * 100}%`,
                      backgroundColor: cat.color,
                    }}
                    className="h-full min-w-[4px] first:rounded-l-full last:rounded-r-full"
                  />
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {categoryBreakdown.map((cat) => {
                const pct = Math.round((cat.count / insightItems.length) * 100);
                return (
                  <span
                    key={cat.label}
                    title={`${cat.label}：${cat.count} 项 (${pct}%)`}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200/80 bg-slate-50/80 px-2 py-0.5 text-[11px] text-slate-700"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: cat.color }}
                    />
                    <span>{cat.label}</span>
                    <span className="font-mono font-bold tabular-nums text-slate-900">{cat.count}</span>
                  </span>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="mt-2 h-2.5 w-full rounded-full bg-slate-100" aria-hidden="true" />
            <p className="mt-1.5 text-[11px] text-slate-400">
              暂无已生成的飞书 AI 协作结论分类分布
            </p>
          </>
        )}
      </div>

      {/* Middle B: Code diff additions/deletions ratio & PR overview */}
      <div
        className="border-t border-slate-100 pt-3.5"
        data-testid="code-diff-ratio-overview"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
            <GitPullRequest size={13.5} className="shrink-0 text-violet-600" />
            代码净增删与 PR 概览
          </span>
          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${
                netLines >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
              }`}
            >
              净变动 {formatSignedCompact(netLines)}
            </span>
            <span className="rounded-full border border-violet-200/80 bg-violet-50/80 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-violet-700">
              {analytics.totalPullRequests} PR
            </span>
          </div>
        </div>

        {totalChurn > 0 ? (
          <>
            <div
              className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="img"
              aria-label="代码新增与删除行占比条"
            >
              {analytics.totalAdditions > 0 && (
                <div
                  title={`新增代码 +${analytics.totalAdditions.toLocaleString("zh-CN")} 行 (${additionsPct}%)`}
                  style={{ width: `${(analytics.totalAdditions / totalChurn) * 100}%` }}
                  className="h-full min-w-[4px] bg-emerald-500 first:rounded-l-full last:rounded-r-full"
                />
              )}
              {analytics.totalDeletions > 0 && (
                <div
                  title={`删除代码 -${analytics.totalDeletions.toLocaleString("zh-CN")} 行 (${deletionsPct}%)`}
                  style={{ width: `${(analytics.totalDeletions / totalChurn) * 100}%` }}
                  className="h-full min-w-[4px] bg-rose-500 first:rounded-l-full last:rounded-r-full"
                />
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-emerald-700">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                +{formatCompact(analytics.totalAdditions)}
                <span className="font-normal text-slate-400">({additionsPct}%)</span>
              </span>
              <span className="whitespace-nowrap font-sans text-[11px] text-slate-400">
                总变动 {formatCompact(totalChurn)} 行
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-rose-600">
                <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />
                -{formatCompact(analytics.totalDeletions)}
                <span className="font-normal text-slate-400">({deletionsPct}%)</span>
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="mt-2 h-2.5 w-full rounded-full bg-slate-100" aria-hidden="true" />
            <p className="mt-1.5 text-[11px] text-slate-400">暂无代码新增/删除行变动统计</p>
          </>
        )}
      </div>

      {/* Bottom: Compact project-level aggregate summary (GitHub + Feishu, zero per-member duplication) */}
      <div className="grid gap-2.5 border-t border-slate-100 pt-3.5 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-slate-700">
              <GitCommitHorizontal size={14} className="shrink-0 text-violet-600" />
              代码交付汇总
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-xs font-bold tabular-nums text-slate-900">
              {analytics.totalCommits} 提交
            </span>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-1.5">
            <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-slate-200/60">
              <div className="whitespace-nowrap text-[10px] text-slate-500">已归属</div>
              <div className="mt-0.5 font-mono text-xs font-bold tabular-nums text-slate-900">
                {matchedCommits}
              </div>
            </div>
            <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-slate-200/60">
              <div className="whitespace-nowrap text-[10px] text-slate-500">PR 数</div>
              <div className="mt-0.5 font-mono text-xs font-bold tabular-nums text-violet-700">
                {analytics.totalPullRequests}
              </div>
            </div>
            {analytics.unmatchedCommits > 0 ? (
              <div
                title={`含 ${analytics.unmatchedCommits} 次未关联到在组账号的提交`}
                className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-amber-200/70"
              >
                <div className="whitespace-nowrap text-[10px] text-amber-700">未归属</div>
                <div className="mt-0.5 font-mono text-xs font-bold tabular-nums text-amber-700">
                  {analytics.unmatchedCommits}
                </div>
              </div>
            ) : (
              <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-slate-200/60">
                <div className="whitespace-nowrap text-[10px] text-slate-500">净行数</div>
                <div
                  className={`mt-0.5 font-mono text-xs font-bold tabular-nums ${
                    netLines >= 0 ? "text-emerald-700" : "text-rose-600"
                  }`}
                >
                  {formatSignedCompact(netLines)}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-slate-700">
              <MessageSquare size={14} className="shrink-0 text-amber-600" />
              飞书协作汇总
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-xs font-bold tabular-nums text-slate-900">
              {analytics.feishuTotalMessages} 条消息
            </span>
          </div>
          {insightItems.length > 0 ? (
            <div className="mt-2.5 grid grid-cols-3 gap-1.5">
              <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-slate-200/60">
                <div className="whitespace-nowrap text-[10px] text-slate-500">已达成</div>
                <div className="mt-0.5 font-mono text-xs font-bold tabular-nums text-emerald-700">
                  {insightDone}
                </div>
              </div>
              <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-slate-200/60">
                <div className="whitespace-nowrap text-[10px] text-slate-500">推进中</div>
                <div className="mt-0.5 font-mono text-xs font-bold tabular-nums text-sky-700">
                  {insightProgress}
                </div>
              </div>
              <div className="rounded-lg bg-white/80 px-2 py-1.5 text-center ring-1 ring-slate-200/60">
                <div className="whitespace-nowrap text-[10px] text-slate-500">待跟进</div>
                <div
                  className={`mt-0.5 font-mono text-xs font-bold tabular-nums ${
                    insightFollowup > 0 ? "text-amber-700" : "text-slate-400"
                  }`}
                >
                  {insightFollowup}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-2.5 flex h-[46px] items-center justify-center rounded-lg bg-white/60 text-[11px] text-slate-400 ring-1 ring-slate-200/50">
              暂无 AI 飞书协作结论
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
