"use client";

import { useMemo, useState } from "react";
import { BarChart3, GitCommitHorizontal, TrendingUp, Users } from "lucide-react";
import { Avatar } from "@/components/common";
import type { components } from "@/packages/domain/api.generated";

export type GithubActivityStats = components["schemas"]["GithubActivityStatsDTO"];
type ChartMode = "commits" | "lines";

function formatCompact(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("zh-CN");
}

function shortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export function GithubStatsChart({
  stats,
  loading,
  selectedAuthorId,
  onSelectAuthor,
}: {
  stats?: GithubActivityStats;
  loading: boolean;
  selectedAuthorId?: string;
  onSelectAuthor?: (authorUserId: string | null, authorName: string) => void;
}) {
  const [mode, setMode] = useState<ChartMode>("commits");
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);

  const contributors = useMemo(() => stats?.contributors ?? [], [stats]);
  const daily = useMemo(() => stats?.daily ?? [], [stats]);

  const maxCommits = useMemo(
    () => Math.max(1, ...contributors.map((c) => c.commits)),
    [contributors],
  );
  const maxLines = useMemo(
    () => Math.max(1, ...contributors.map((c) => c.additions + c.deletions)),
    [contributors],
  );

  const dailyMax = useMemo(() => {
    if (!daily.length) return 1;
    const values = daily.map((d) => (mode === "commits" ? d.commits : d.additions + d.deletions));
    return Math.max(1, ...values);
  }, [daily, mode]);

  const activeDay = useMemo(() => {
    if (!daily.length) return null;
    if (hoveredDay !== null && daily[hoveredDay]) return daily[hoveredDay];
    for (let i = daily.length - 1; i >= 0; i -= 1) {
      if (daily[i].commits > 0) return daily[i];
    }
    return daily[daily.length - 1];
  }, [daily, hoveredDay]);

  if (loading && !stats) {
    return (
      <div className="gp-surface-card mb-5">
        <div className="h-5 w-44 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="h-44 animate-pulse rounded-xl bg-slate-50" />
          <div className="h-44 animate-pulse rounded-xl bg-slate-50" />
        </div>
      </div>
    );
  }

  if (!stats || stats.total_commits === 0) {
    return null;
  }

  const totalCommits = Math.max(1, stats.total_commits);

  return (
    <section
      aria-label="成员提交与代码增减可视化"
      className="gp-surface-card mb-5"
      data-testid="github-stats-chart"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[16px] font-bold tracking-tight text-slate-900">
            <BarChart3 size={17} className="text-[var(--gp-action)]" />
            成员提交与代码增减概览
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            基于本项目已同步的 {stats.total_commits} 次提交实时聚合 · 覆盖 {contributors.length} 位贡献者
          </p>
        </div>
        <div className="gp-segmented" role="tablist" aria-label="图表维度切换">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "commits"}
            data-active={mode === "commits" ? "true" : undefined}
            className="gp-segmented-item"
            onClick={() => setMode("commits")}
          >
            提交次数
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "lines"}
            data-active={mode === "lines" ? "true" : undefined}
            className="gp-segmented-item"
            onClick={() => setMode("lines")}
          >
            代码增减
          </button>
        </div>
      </div>

      {/* KPI 汇总条 */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-slate-50/85 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <GitCommitHorizontal size={13} className="text-sky-600" />
            总提交次数
          </div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-slate-900">
            {stats.total_commits.toLocaleString("zh-CN")}
          </div>
        </div>
        <div className="rounded-xl bg-emerald-50/55 px-3.5 py-2.5">
          <div className="text-[11px] font-medium text-emerald-700/90">累计新增代码</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-emerald-700">
            +{formatCompact(stats.total_additions)}
          </div>
        </div>
        <div className="rounded-xl bg-rose-50/55 px-3.5 py-2.5">
          <div className="text-[11px] font-medium text-rose-700/90">累计删除代码</div>
          <div className="mt-1 font-mono text-xl font-bold tabular-nums text-rose-600">
            -{formatCompact(stats.total_deletions)}
          </div>
        </div>
        <div className="rounded-xl bg-slate-50/85 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <Users size={13} className="text-slate-500" />
            贡献成员
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold tabular-nums text-slate-900">
              {contributors.length}
            </span>
            <span className="text-[11px] text-slate-400">
              PR {stats.total_pull_requests} · CI {stats.total_ci_runs}
            </span>
          </div>
        </div>
      </div>

      {/* 左右双图表区域 */}
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* 左：成员横向柱状对比图 */}
        <div>
          <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold text-slate-700">
              {mode === "commits" ? "各成员提交次数排行" : "各成员代码增删行对比"}
            </span>
            <span>{mode === "commits" ? "占比 / 增删行" : "绿=新增 · 红=删除"}</span>
          </div>
          <div className="space-y-3">
            {contributors.slice(0, 8).map((c) => {
              const share = Math.round((c.commits / totalCommits) * 100);
              const commitPct = Math.max(4, Math.round((c.commits / maxCommits) * 100));
              const totalChurn = c.additions + c.deletions;
              const addPct = totalChurn > 0 ? Math.max(2, Math.round((c.additions / maxLines) * 100)) : 0;
              const delPct = totalChurn > 0 ? Math.max(c.deletions > 0 ? 2 : 0, Math.round((c.deletions / maxLines) * 100)) : 0;
              const isSelected = Boolean(selectedAuthorId && c.author_user_id === selectedAuthorId);
              const clickable = Boolean(onSelectAuthor && c.author_user_id);

              return (
                <div
                  key={c.author_key}
                  className={`rounded-xl px-2.5 py-2 transition-colors ${
                    isSelected
                      ? "bg-sky-50/90 ring-1 ring-sky-200"
                      : clickable
                        ? "hover:bg-slate-50/90"
                        : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar name={c.author_name || "成"} />
                      {clickable ? (
                        <button
                          type="button"
                          className="truncate text-left font-medium text-slate-800 hover:text-[var(--gp-action)] hover:underline"
                          onClick={() =>
                            onSelectAuthor?.(
                              isSelected ? null : c.author_user_id ?? null,
                              c.author_name,
                            )
                          }
                        >
                          {c.author_name}
                        </button>
                      ) : (
                        <span className="truncate font-medium text-slate-800">{c.author_name}</span>
                      )}
                      {c.author_login && c.author_login.toLowerCase() !== c.author_name.toLowerCase() && (
                        <span className="hidden truncate text-xs text-slate-400 sm:inline">
                          @{c.author_login}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
                      {mode === "commits" ? (
                        <>
                          <span className="font-semibold text-slate-800">{c.commits} 次</span>
                          <span className="text-slate-400">{share}%</span>
                          {(c.additions > 0 || c.deletions > 0) && (
                            <span className="hidden items-center gap-1 sm:inline-flex">
                              <span className="text-emerald-600">+{formatCompact(c.additions)}</span>
                              <span className="text-rose-500">-{formatCompact(c.deletions)}</span>
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="font-semibold text-emerald-600">
                            +{formatCompact(c.additions)}
                          </span>
                          <span className="font-semibold text-rose-500">
                            -{formatCompact(c.deletions)}
                          </span>
                          <span className="text-slate-400">{c.commits} 次</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    {mode === "commits" ? (
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-sky-500 to-blue-600 transition-all duration-300"
                        style={{ width: `${commitPct}%` }}
                      />
                    ) : totalChurn > 0 ? (
                      <div className="flex h-full w-full gap-0.5">
                        {c.additions > 0 && (
                          <div
                            className="h-full rounded-l-full bg-emerald-500 transition-all duration-300"
                            style={{ width: `${addPct}%` }}
                          />
                        )}
                        {c.deletions > 0 && (
                          <div
                            className="h-full rounded-r-full bg-rose-400 transition-all duration-300"
                            style={{ width: `${delPct}%` }}
                          />
                        )}
                      </div>
                    ) : (
                      <div className="h-full w-1 rounded-full bg-slate-200" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右：近 14 天趋势柱状图（SVG） */}
        <div className="flex flex-col justify-between rounded-2xl bg-slate-50/75 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <TrendingUp size={14} className="text-[var(--gp-action)]" />
              近 {daily.length} 天{mode === "commits" ? "提交趋势" : "代码改动趋势"}
            </span>
            {activeDay && (
              <span className="rounded-full bg-white px-2.5 py-0.5 font-mono text-[11px] tabular-nums text-slate-600 shadow-2xs">
                {shortDate(activeDay.date)} · {activeDay.commits} 次 ·{" "}
                <span className="text-emerald-600">+{formatCompact(activeDay.additions)}</span>/
                <span className="text-rose-500">-{formatCompact(activeDay.deletions)}</span>
              </span>
            )}
          </div>

          <div className="mt-4">
            <svg
              viewBox="0 0 360 156"
              className="h-40 w-full overflow-visible"
              role="img"
              aria-label={`近 ${daily.length} 天${mode === "commits" ? "提交次数" : "代码改动"}趋势图`}
            >
              {/* 背景参考线 */}
              {[0, 0.5, 1].map((ratio) => {
                const y = 128 - ratio * 108;
                return (
                  <g key={ratio}>
                    <line
                      x1="0"
                      x2="360"
                      y1={y}
                      y2={y}
                      stroke="rgba(148,163,184,0.22)"
                      strokeDasharray={ratio === 0 ? undefined : "3 3"}
                    />
                  </g>
                );
              })}

              {daily.map((day, idx) => {
                const slot = 360 / Math.max(1, daily.length);
                const barW = Math.max(8, Math.min(18, slot - 7));
                const x = idx * slot + (slot - barW) / 2;
                const val = mode === "commits" ? day.commits : day.additions + day.deletions;
                const barH = val > 0 ? Math.max(6, Math.round((val / dailyMax) * 108)) : 3;
                const y = 128 - barH;
                const active = hoveredDay === idx || (hoveredDay === null && activeDay?.date === day.date);

                const addH =
                  mode === "lines" && val > 0 ? Math.round((day.additions / val) * barH) : 0;
                const delH = mode === "lines" && val > 0 ? Math.max(0, barH - addH) : 0;

                return (
                  <g
                    key={day.date}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredDay(idx)}
                    onMouseLeave={() => setHoveredDay(null)}
                    onClick={() => setHoveredDay(idx)}
                  >
                    <rect x={idx * slot} y={14} width={slot} height={124} fill="transparent" />
                    {mode === "commits" ? (
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={barH}
                        rx="4"
                        fill={
                          val === 0
                            ? "rgba(203,213,225,0.45)"
                            : active
                              ? "#0284c7"
                              : "rgba(14,165,233,0.72)"
                        }
                      />
                    ) : val === 0 ? (
                      <rect x={x} y={y} width={barW} height={barH} rx="2" fill="rgba(203,213,225,0.45)" />
                    ) : (
                      <>
                        {addH > 0 && (
                          <rect
                            x={x}
                            y={128 - addH}
                            width={barW}
                            height={addH}
                            rx="3"
                            fill={active ? "#059669" : "rgba(16,185,129,0.78)"}
                          />
                        )}
                        {delH > 0 && (
                          <rect
                            x={x}
                            y={y}
                            width={barW}
                            height={delH}
                            rx="3"
                            fill={active ? "#e11d48" : "rgba(244,63,94,0.72)"}
                          />
                        )}
                      </>
                    )}
                    {(idx === 0 || idx === Math.floor(daily.length / 2) || idx === daily.length - 1) && (
                      <text
                        x={x + barW / 2}
                        y="148"
                        textAnchor="middle"
                        fontSize="10"
                        fill="#64748b"
                      >
                        {shortDate(day.date)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            {stats.commits_with_stats < stats.total_commits
              ? `已统计最近 ${stats.commits_with_stats} / ${stats.total_commits} 次提交的详细代码行增减；再次点击「同步 GitHub」可继续补全较早提交。`
              : `已完整覆盖全部 ${stats.total_commits} 次提交的代码行增减统计。`}
          </p>
        </div>
      </div>
    </section>
  );
}
