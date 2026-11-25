"use client";

import { useMemo, useState } from "react";
import { BarChart3, GitCommitHorizontal, MessageSquare, PieChart } from "lucide-react";
import type { MemberAnalyticsRow, ProjectContributionAnalytics } from "./contribution-analytics";

type ShareMode = "formal" | "activity";

function formatCompact(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("zh-CN");
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
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-slate-900">
            <BarChart3 size={16} className="text-[var(--gp-action)]" />
            团队全员贡献占比分布
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            覆盖全部 {members.length} 位在组项目成员；
            {effectiveMode === "formal"
              ? "按已确认正式验收成果的责任比例展示（未确认成员显示 0%）。"
              : "按正式成果、任务进度、GitHub 代码提交与飞书协作关联综合展示参考占比。"}
          </p>
        </div>

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
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-slate-900">成员多维贡献对比图</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            按正式权重、任务进度、代码提交与飞书协作 4 项维度横向对比全组成员
          </p>
        </div>
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

  const insightItems = feishuInsights?.items ?? [];
  const insightDone = insightItems.filter((i) => i.status === "completed").length;
  const insightProgress = insightItems.filter((i) => i.status === "in_progress").length;
  const insightFollowup = insightItems.filter((i) => i.status === "needs_followup").length;

  return (
    <section
      aria-label="项目交付概览"
      className="gp-surface-card flex flex-col justify-between space-y-4"
      data-testid="project-status-donut"
    >
      {/* Top: Task status SVG donut */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-slate-900">
              <PieChart size={16} className="text-[var(--gp-action)]" />
              项目交付概览
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              项目任务状态分布与代码、飞书协作整体统计
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-700">
            共 {totalTasks} 项任务
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-6">
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

      {/* Bottom: Compact project-level aggregate summary (GitHub + Feishu, zero per-member duplication) */}
      <div className="grid gap-2.5 border-t border-slate-100 pt-3.5 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <GitCommitHorizontal size={14} className="text-violet-600" />
              代码交付汇总
            </span>
            <span className="font-mono text-xs font-bold tabular-nums text-slate-900">
              {analytics.totalCommits} 提交
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums">
            <span className="font-semibold text-emerald-700">+{formatCompact(analytics.totalAdditions)}</span>
            <span className="font-semibold text-rose-600">-{formatCompact(analytics.totalDeletions)}</span>
            <span className="text-slate-500">{analytics.totalPullRequests} PR</span>
          </div>
          {analytics.unmatchedCommits > 0 && (
            <p className="mt-1.5 text-[11px] text-slate-400">
              含 {analytics.unmatchedCommits} 次未关联到在组账号的提交
            </p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <MessageSquare size={14} className="text-amber-600" />
              飞书协作汇总
            </span>
            <span className="font-mono text-xs font-bold tabular-nums text-slate-900">
              {analytics.feishuTotalMessages} 条消息
            </span>
          </div>
          {insightItems.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] tabular-nums text-slate-600">
              <span className="font-semibold text-slate-800">AI 结论 {insightItems.length} 项</span>
              <span className="text-emerald-700">已达成 {insightDone}</span>
              <span className="text-sky-700">推进中 {insightProgress}</span>
              {insightFollowup > 0 && <span className="text-amber-700">待跟进 {insightFollowup}</span>}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-400">暂无 AI 飞书协作结论</p>
          )}
        </div>
      </div>
    </section>
  );
}
