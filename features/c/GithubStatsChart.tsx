"use client";

import { useMemo, useState } from "react";
import { BarChart3, Calendar, ChevronDown, ChevronUp, GitCommitHorizontal, TrendingUp, Users } from "lucide-react";
import { Avatar } from "@/components/common";
import type { components } from "@/packages/domain/api.generated";

export type GithubActivityStats = components["schemas"]["GithubActivityStatsDTO"];
export type GithubStatsRange = "all" | "30d" | "14d" | "7d" | "custom";
type ChartMode = "commits" | "lines";

const RANGE_OPTIONS: { key: GithubStatsRange; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "30d", label: "近 30 天" },
  { key: "14d", label: "近 14 天" },
  { key: "7d", label: "近 7 天" },
  { key: "custom", label: "自定义" },
];

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

function rangeTitlePrefix(range: GithubStatsRange, dateFrom?: string | null, dateTo?: string | null, dayCount?: number): string {
  if (range === "all") return "全部时间";
  if (range === "30d") return "近 30 天";
  if (range === "14d") return "近 14 天";
  if (range === "7d") return "近 7 天";
  if (dateFrom && dateTo) return `${shortDate(dateFrom)} – ${shortDate(dateTo)} `;
  return dayCount ? `近 ${dayCount} 天` : "自定义区间";
}

export function GithubStatsChart({
  stats,
  loading,
  fetching,
  range,
  customFrom,
  customTo,
  onRangeChange,
  onCustomChange,
  onApplyCustom,
  selectedAuthorId,
  onSelectAuthor,
}: {
  stats?: GithubActivityStats;
  loading: boolean;
  fetching?: boolean;
  range: GithubStatsRange;
  customFrom: string;
  customTo: string;
  onRangeChange: (next: GithubStatsRange) => void;
  onCustomChange: (next: { from: string; to: string }) => void;
  onApplyCustom: () => void;
  selectedAuthorId?: string;
  onSelectAuthor?: (authorUserId: string | null, authorName: string) => void;
}) {
  const [mode, setMode] = useState<ChartMode>("commits");
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const contributors = useMemo(() => stats?.contributors ?? [], [stats]);
  const daily = useMemo(() => stats?.daily ?? [], [stats]);

  const maxCommits = useMemo(() => Math.max(1, ...contributors.map((c) => c.commits)), [contributors]);
  const maxLines = useMemo(() => Math.max(1, ...contributors.map((c) => c.additions + c.deletions)), [contributors]);

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

  const invalidCustomRange = Boolean(customFrom && customTo && customFrom > customTo);

  if (loading && !stats) {
    return (
      <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="h-32 animate-pulse rounded-xl bg-slate-50" />
          <div className="h-32 animate-pulse rounded-xl bg-slate-50" />
        </div>
      </div>
    );
  }

  const allTimeCommits = stats?.all_time_commits ?? stats?.total_commits ?? 0;
  if (!stats || allTimeCommits === 0) {
    return null;
  }

  const totalCommits = Math.max(1, stats.total_commits);
  const tickIndices = new Set<number>();
  if (daily.length > 0) {
    tickIndices.add(0);
    tickIndices.add(daily.length - 1);
    if (daily.length >= 20) {
      tickIndices.add(Math.floor(daily.length / 3));
      tickIndices.add(Math.floor((daily.length * 2) / 3));
    } else if (daily.length >= 5) {
      tickIndices.add(Math.floor(daily.length / 2));
    }
  }

  const rangeLabelText = stats.date_from && stats.date_to ? `${stats.date_from} 至 ${stats.date_to}` : "全部已同步记录";

  return (
    <section
      aria-label="成员提交与代码增减可视化"
      className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
      data-testid="github-stats-chart"
    >
      {/* Compact Header + Inline KPI Strip + Collapse Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <BarChart3 size={15} className="text-[var(--gp-action)]" />
            代码统计概览
            {fetching && <span className="text-[11px] font-normal text-slate-400">更新中…</span>}
          </h2>
          <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
          <span className="inline-flex items-center gap-1 text-slate-600">
            <GitCommitHorizontal size={13} className="text-sky-600" />
            <strong className="font-mono text-slate-900">{stats.total_commits.toLocaleString("zh-CN")}</strong> 次提交
          </span>
          <span className="font-mono font-semibold text-emerald-700">+{formatCompact(stats.total_additions)}</span>
          <span className="font-mono font-semibold text-rose-600">-{formatCompact(stats.total_deletions)}</span>
          <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />
          <span className="inline-flex items-center gap-1 text-slate-600">
            <Users size={12} className="text-slate-400" />
            <strong className="font-mono text-slate-900">{contributors.length}</strong> 人 · PR {stats.total_pull_requests} · CI{" "}
            {stats.total_ci_runs}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!collapsed && (
            <>
              <div className="gp-segmented" role="tablist" aria-label="统计时间范围">
                {RANGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    role="tab"
                    aria-selected={range === opt.key}
                    data-active={range === opt.key ? "true" : undefined}
                    className="gp-segmented-item"
                    onClick={() => {
                      setHoveredDay(null);
                      onRangeChange(opt.key);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
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
                  提交
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "lines"}
                  data-active={mode === "lines" ? "true" : undefined}
                  className="gp-segmented-item"
                  onClick={() => setMode("lines")}
                >
                  代码行
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            {collapsed ? "展开图表" : "收起"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {range === "custom" && (
            <form
              className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50/90 px-3 py-1.5 text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                if (!invalidCustomRange) {
                  setHoveredDay(null);
                  onApplyCustom();
                }
              }}
            >
              <Calendar size={13} className="text-slate-400" />
              <input
                type="date"
                aria-label="统计开始日期"
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={customFrom}
                min={stats.earliest_date ?? undefined}
                max={customTo || stats.latest_date || undefined}
                onChange={(e) => onCustomChange({ from: e.target.value, to: customTo })}
              />
              <span className="text-slate-400">至</span>
              <input
                type="date"
                aria-label="统计结束日期"
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                value={customTo}
                min={customFrom || stats.earliest_date || undefined}
                max={stats.latest_date ?? undefined}
                onChange={(e) => onCustomChange({ from: customFrom, to: e.target.value })}
              />
              <button
                type="submit"
                disabled={invalidCustomRange}
                className="rounded-lg bg-[var(--gp-action)] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                应用
              </button>
              {invalidCustomRange && <span className="text-rose-600">开始日期不能晚于结束日期</span>}
            </form>
          )}

          {stats.total_commits === 0 ? (
            <div className="mt-3 rounded-xl bg-slate-50/75 px-4 py-5 text-center text-xs text-slate-500">
              所选时间范围（{rangeLabelText}）内暂无成员提交记录，可切换到「全部」或调整日期范围查看。
            </div>
          ) : (
            <div className="mt-3 grid gap-4 border-t border-slate-100 pt-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              {/* Left: Compact Contributor Bars */}
              <div>
                <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
                  <span className="font-semibold text-slate-700">
                    {mode === "commits" ? "各成员提交次数排行" : "各成员代码增删行对比"}
                  </span>
                  <span>{rangeLabelText}</span>
                </div>
                <div className="space-y-1.5">
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
                        className={`rounded-lg px-2 py-1.5 transition-colors ${
                          isSelected ? "bg-sky-50/90 ring-1 ring-sky-200" : clickable ? "hover:bg-slate-50/90" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Avatar name={c.author_name || "成"} size={22} />
                            {clickable ? (
                              <button
                                type="button"
                                className="truncate text-left font-medium text-slate-800 hover:text-[var(--gp-action)] hover:underline"
                                onClick={() => onSelectAuthor?.(isSelected ? null : (c.author_user_id ?? null), c.author_name)}
                              >
                                {c.author_name}
                              </button>
                            ) : (
                              <span className="truncate font-medium text-slate-800">{c.author_name}</span>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
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
                                <span className="font-semibold text-emerald-600">+{formatCompact(c.additions)}</span>
                                <span className="font-semibold text-rose-500">-{formatCompact(c.deletions)}</span>
                                <span className="text-slate-400">{c.commits} 次</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          {mode === "commits" ? (
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-sky-500 to-blue-600 transition-all duration-300"
                              style={{ width: `${commitPct}%` }}
                            />
                          ) : totalChurn > 0 ? (
                            <div className="flex h-full w-full gap-0.5">
                              {c.additions > 0 && (
                                <div className="h-full rounded-l-full bg-emerald-500 transition-all duration-300" style={{ width: `${addPct}%` }} />
                              )}
                              {c.deletions > 0 && (
                                <div className="h-full rounded-r-full bg-rose-400 transition-all duration-300" style={{ width: `${delPct}%` }} />
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

              {/* Right: Compact SVG Trend Chart */}
              <div className="flex flex-col justify-between rounded-xl bg-slate-50/75 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <TrendingUp size={13} className="text-[var(--gp-action)]" />
                    {rangeTitlePrefix(range, stats.date_from, stats.date_to, daily.length)}
                    {mode === "commits" ? "提交趋势" : "代码改动趋势"}
                  </span>
                  {activeDay && (
                    <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[11px] tabular-nums text-slate-600 shadow-2xs">
                      {shortDate(activeDay.date)} · {activeDay.commits} 次 ·{" "}
                      <span className="text-emerald-600">+{formatCompact(activeDay.additions)}</span>/
                      <span className="text-rose-500">-{formatCompact(activeDay.deletions)}</span>
                    </span>
                  )}
                </div>

                <div className="mt-2.5">
                  <svg
                    viewBox="0 0 360 128"
                    className="h-32 w-full overflow-visible"
                    role="img"
                    aria-label={`${rangeTitlePrefix(range, stats.date_from, stats.date_to, daily.length)}${mode === "commits" ? "提交次数" : "代码改动"}趋势图`}
                  >
                    {[0, 0.5, 1].map((ratio) => {
                      const y = 104 - ratio * 88;
                      return (
                        <line
                          key={ratio}
                          x1="0"
                          x2="360"
                          y1={y}
                          y2={y}
                          stroke="rgba(148,163,184,0.22)"
                          strokeDasharray={ratio === 0 ? undefined : "3 3"}
                        />
                      );
                    })}

                    {daily.map((day, idx) => {
                      const slot = 360 / Math.max(1, daily.length);
                      const gap = daily.length > 35 ? 1.5 : daily.length > 18 ? 3 : 7;
                      const barW = Math.max(3, Math.min(18, slot - gap));
                      const x = idx * slot + (slot - barW) / 2;
                      const val = mode === "commits" ? day.commits : day.additions + day.deletions;
                      const barH = val > 0 ? Math.max(5, Math.round((val / dailyMax) * 88)) : 2.5;
                      const y = 104 - barH;
                      const active = hoveredDay === idx || (hoveredDay === null && activeDay?.date === day.date);

                      const addH = mode === "lines" && val > 0 ? Math.round((day.additions / val) * barH) : 0;
                      const delH = mode === "lines" && val > 0 ? Math.max(0, barH - addH) : 0;
                      const rx = barW >= 8 ? 3.5 : 2;

                      return (
                        <g
                          key={day.date}
                          className="cursor-pointer"
                          onMouseEnter={() => setHoveredDay(idx)}
                          onMouseLeave={() => setHoveredDay(null)}
                          onClick={() => setHoveredDay(idx)}
                        >
                          <rect x={idx * slot} y={10} width={slot} height={102} fill="transparent" />
                          {mode === "commits" ? (
                            <rect
                              x={x}
                              y={y}
                              width={barW}
                              height={barH}
                              rx={rx}
                              fill={val === 0 ? "rgba(203,213,225,0.45)" : active ? "#0284c7" : "rgba(14,165,233,0.72)"}
                            />
                          ) : val === 0 ? (
                            <rect x={x} y={y} width={barW} height={barH} rx={1.5} fill="rgba(203,213,225,0.45)" />
                          ) : (
                            <>
                              {addH > 0 && (
                                <rect
                                  x={x}
                                  y={104 - addH}
                                  width={barW}
                                  height={addH}
                                  rx={rx}
                                  fill={active ? "#059669" : "rgba(16,185,129,0.78)"}
                                />
                              )}
                              {delH > 0 && (
                                <rect
                                  x={x}
                                  y={y}
                                  width={barW}
                                  height={delH}
                                  rx={rx}
                                  fill={active ? "#e11d48" : "rgba(244,63,94,0.72)"}
                                />
                              )}
                            </>
                          )}
                          {tickIndices.has(idx) && (
                            <text
                              x={x + barW / 2}
                              y="122"
                              textAnchor={idx === 0 ? "start" : idx === daily.length - 1 ? "end" : "middle"}
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

                <p className="mt-1.5 text-[11px] text-slate-400">
                  {stats.commits_with_stats < stats.total_commits
                    ? `已统计 ${stats.commits_with_stats}/${stats.total_commits} 次提交代码行；再次同步可继续补全。`
                    : `已完整覆盖全部 ${stats.total_commits} 次提交的代码行统计（已排除 Bot）。`}
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
