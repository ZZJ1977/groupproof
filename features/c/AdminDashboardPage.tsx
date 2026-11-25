"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Coins,
  FileCheck2,
  Gauge,
  GitBranch,
  Layers3,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace";
import { createGovernanceClient } from "@/lib/api/c-governance-client";
import { Badge, Box, Empty, Header, Metric } from "@/features/governance/primitives";
import { formatBytes, formatDurationMs, formatRelativeTime } from "@/features/c/AdminPrimitives";
import styles from "@/features/governance/governance.module.css";

const governance = createGovernanceClient();
const roleLabels: Record<string, string> = { student: "学生", teacher: "教师", ta: "助教", admin: "管理员" };
const roleTones: Record<string, "blue" | "purple" | "green" | "amber" | "gray"> = {
  student: "blue",
  teacher: "purple",
  ta: "green",
  admin: "amber",
};

const aiFeatureLabels: Record<string, string> = {
  summarize_activity: "提交与群聊活动摘要",
  generate_project_blueprint: "AI 项目研发蓝图",
  analyze_implementation: "GitHub 仓库提交分析",
  match_evidence: "证据与群聊追踪",
  extract_requirements: "需求文档解析",
  suggest_tasks: "任务规划建议",
  explain_risk: "风险与进度解释",
};

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
  }
  return String(tokens);
}

function formatCostAmount(raw: string): string {
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num)) return raw;
  if (num >= 1) return num.toFixed(2);
  if (num >= 0.01) return num.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return num.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function Distribution({ items, total }: { items: { label: string; value: number; color: string }[]; total: number }) {
  return (
    <div className="space-y-4">
      {items.map((item) => {
        const width = total > 0 ? Math.max(item.value ? 5 : 0, Math.round((item.value / total) * 100)) : 0;
        const pct = total > 0 ? `${Math.round((item.value / total) * 100)}%` : "0%";
        return (
          <div key={item.label}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-slate-700">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
              <span className="text-slate-600">
                <strong className="text-slate-900">{item.value}</strong> · {pct}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full transition-all" style={{ width: `${width}%`, backgroundColor: item.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function healthTone(status: "healthy" | "warning" | "degraded"): "green" | "amber" | "red" {
  return status === "healthy" ? "green" : status === "warning" ? "amber" : "red";
}

function healthText(status: "healthy" | "warning" | "degraded"): string {
  return status === "healthy" ? "正常" : status === "warning" ? "需关注" : "异常";
}

type OverviewWindow = "all" | "30d" | "7d";
type PulseSeries = "audit" | "ai" | "sync";

const windowOptions: readonly { value: OverviewWindow; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "30d", label: "近 30 天" },
  { value: "7d", label: "近 7 天" },
];

export function AdminDashboardPage() {
  const { userId } = useWorkspace();
  const [windowRange, setWindowRange] = useState<OverviewWindow>("all");
  const [hoveredPulse, setHoveredPulse] = useState<{ index: number; series: PulseSeries | null } | null>(null);
  const usageDays: 7 | 30 | 90 = windowRange === "7d" ? 7 : windowRange === "30d" ? 30 : 90;
  const overview = useQuery({
    queryKey: ["admin-workbench-overview", userId, windowRange],
    queryFn: () => governance.workbenchOverview({ window: windowRange }),
    staleTime: 20_000,
    retry: false,
  });
  const aiUsage = useQuery({
    queryKey: ["admin-overview-ai-usage", userId, usageDays],
    queryFn: () => governance.usage({ days: usageDays }),
    staleTime: 20_000,
    retry: false,
  });
  const aiDiagnostics = useQuery({
    queryKey: ["admin-overview-ai-diagnostics", userId, usageDays],
    queryFn: () => governance.workbenchAiDiagnostics({ days: usageDays }),
    staleTime: 20_000,
    retry: false,
  });

  const data = overview.data;
  const loading = overview.isFetching || aiUsage.isFetching || aiDiagnostics.isFetching;
  const users = data?.users;
  const queues = data?.queues;
  const teaching = data?.teaching;
  const proof = data?.proof_pipeline;
  const ai = data?.ai ?? data?.ai_7d;

  const onlyAdmin = Boolean(users && users.total === 1 && teaching && teaching.courses_total === 0);
  const verifiedRate = users && users.total > 0 ? `${Math.round((users.verified_school_email / users.total) * 100)}%` : "—";
  const aiCostFormatted = ai
    ? Object.entries(ai.cost_by_currency).map(([c, v]) => `${c} ${formatCostAmount(v)}`).join(" · ")
    : "";
  const aiCostLabel = ai
    ? aiCostFormatted || (ai.requests ? "未计价" : "暂无费用")
    : "—";
  const aiTotalTokens = ai ? ai.input_tokens + ai.output_tokens : 0;
  const avgLatencyMs = aiDiagnostics.data?.avg_latency_ms ?? null;
  const p95LatencyMs = ai?.p95_latency_ms ?? aiDiagnostics.data?.p95_latency_ms ?? null;
  const topFeatures = aiUsage.data
    ? [...aiUsage.data.by_feature]
        .filter((item) => item.requests > 0)
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 4)
    : [];
  const topModels = aiUsage.data
    ? [...aiUsage.data.by_model]
        .filter((item) => item.requests > 0)
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 4)
    : [];
  const usageTotalForShare = Math.max(1, aiUsage.data?.requests ?? ai?.requests ?? 1);

  const roleItems = [
    { label: "学生", value: users?.by_role.student ?? 0, color: "#2563eb" },
    { label: "教师", value: users?.by_role.teacher ?? 0, color: "#7c3aed" },
    { label: "助教", value: users?.by_role.ta ?? 0, color: "#0d9488" },
    { label: "管理员", value: users?.by_role.admin ?? 0, color: "#ea580c" },
  ];
  const courseItems = [
    { label: "草稿", value: teaching?.courses_draft ?? 0, color: "#f59e0b" },
    { label: "已发布", value: teaching?.courses_active ?? 0, color: "#10b981" },
    { label: "已结束", value: teaching?.courses_ended ?? 0, color: "#64748b" },
  ];

  const activitySeries = data?.activity_series ?? data?.activity_7d ?? [];
  const compactPulse = activitySeries.length > 14;
  const pulseLabelStride =
    activitySeries.length <= 7
      ? 1
      : activitySeries.length <= 15
        ? 2
        : activitySeries.length <= 35
          ? 5
          : Math.max(10, Math.ceil(activitySeries.length / 6));
  const pulseMinEndGap = pulseLabelStride === 1 ? 1 : Math.max(2, Math.ceil(pulseLabelStride * 0.6));
  const maxPulse = Math.max(
    1,
    ...activitySeries.map((day) => Math.max(day.audit_events, day.ai_requests, day.github_activities + day.feishu_messages)),
  );
  const windowLabel = windowRange === "all" ? "全部" : windowRange === "30d" ? "近 30 天" : "近 7 天";
  const aiCardLabel = `教学 AI（${windowLabel}）`;
  const pulseTitle =
    windowRange === "all" ? "全部平台活动脉搏" : windowRange === "30d" ? "近 30 天平台活动脉搏" : "近 7 天平台活动脉搏";
  const aiFailTitle =
    windowRange === "all"
      ? `累计 AI 调用失败 ${ai?.failed ?? 0} 次`
      : windowRange === "30d"
        ? `30 日 AI 调用失败 ${ai?.failed ?? 0} 次`
        : `7 日 AI 调用失败 ${ai?.failed ?? 0} 次`;

  return (
    <main className={styles.page}>
      <Header
        title="管理总览"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className={styles.usageTrendTabs} role="group" aria-label="总览统计时间范围">
              {windowOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={styles.usageTrendTab}
                  aria-pressed={windowRange === opt.value}
                  onClick={() => {
                    setWindowRange(opt.value);
                    setHoveredPulse(null);
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.button}
              disabled={loading}
              onClick={() => {
                void overview.refetch();
                void aiUsage.refetch();
                void aiDiagnostics.refetch();
              }}
            >
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
              {loading ? "刷新中…" : "刷新数据"}
            </button>
          </div>
        }
      />

      {overview.isError && (
        <div role="alert" className={styles.identityError}>
          <p>工作台概览暂不可用，请检查服务或管理权限后重试。</p>
          <button type="button" className={styles.button} onClick={() => void overview.refetch()}>
            <RefreshCw size={14} />重试
          </button>
        </div>
      )}

      {onlyAdmin && (
        <div role="status" className={styles.notice}>
          <span>当前环境只有管理员账号，还没有学生、教师或课程数据。你可以批量导入师生名单或先开设课程。</span>
          <Link className={styles.primaryButton} href="/admin/users">
            新增或导入账号
            <ArrowRight size={14} />
          </Link>
        </div>
      )}

      <div className={styles.metrics}>
        <Link href="/admin/users" className={styles.kpiLink}>
          <Metric
            label="用户总数"
            value={users ? users.total : loading ? "…" : "—"}
            hint={users ? `近 7 日新增 +${users.new_last_7d} · 7 日活跃 ${users.active_last_7d}` : "来自统一身份服务"}
            trend={`学校邮箱验证率 ${verifiedRate}`}
            icon={Users}
          />
        </Link>
        <Link href="/admin/teacher-verifications" className={styles.kpiLink}>
          <Metric
            label="待审核教师"
            value={queues ? queues.pending_teacher_applications : loading ? "…" : "—"}
            hint="教师身份申请队列"
            trend={queues?.pending_teacher_applications ? "需要尽快审批" : "队列为空"}
            icon={UserCheck}
            tone={queues?.pending_teacher_applications ? "amber" : "blue"}
          />
        </Link>
        <Link href="/admin/courses" className={styles.kpiLink}>
          <Metric
            label="课程总数"
            value={teaching ? teaching.courses_total : loading ? "…" : "—"}
            hint={teaching ? `${teaching.groups_total} 个小组 · ${teaching.projects_active} 个进行中项目` : "草稿、已发布和已结束"}
            trend={teaching ? `任务 ${teaching.tasks_total} · 正式证据 ${teaching.formal_evidences_total}` : "生命周期汇总"}
            icon={BookOpen}
          />
        </Link>
        <Link href="/admin/access-requests" className={styles.kpiLink}>
          <Metric
            label="待审批访问"
            value={queues ? queues.pending_access_requests : loading ? "…" : "—"}
            hint="临时只读授权申请"
            trend={queues ? `当前生效中授权 ${queues.active_access_grants} 份` : "暂无待办"}
            icon={ShieldCheck}
            tone={queues?.pending_access_requests ? "amber" : "blue"}
          />
        </Link>
      </div>

      <section aria-label="GroupProof 过程证明链健康指标" className={styles.proofStrip}>
        <Link href="/admin/integrations" className={styles.proofStripCard}>
          <div className={styles.proofStripHead}>
            <span className="inline-flex items-center gap-1.5"><GitBranch size={15} className="text-blue-600" />GitHub 代码同步</span>
            <Badge tone={proof && proof.github_stale_links > 0 ? "amber" : "green"}>
              {proof ? (proof.github_stale_links > 0 ? `${proof.github_stale_links} 滞后` : "正常") : "—"}
            </Badge>
          </div>
          <div className={styles.proofStripValue}>{proof ? `${proof.github_repo_links} 仓库` : "—"}</div>
          <div className={styles.proofStripMeta}>
            {proof ? `24h 活跃同步 ${proof.github_synced_24h} · 实名 GitHub ${users?.github_verified ?? 0} 人` : "读取中…"}
          </div>
        </Link>

        <Link href="/admin/integrations" className={styles.proofStripCard}>
          <div className={styles.proofStripHead}>
            <span className="inline-flex items-center gap-1.5"><MessageSquare size={15} className="text-indigo-600" />飞书群聊追踪</span>
            <Badge tone="blue">{proof ? `${proof.feishu_chat_links} 群` : "—"}</Badge>
          </div>
          <div className={styles.proofStripValue}>
            {proof ? `${windowRange === "all" ? proof.feishu_messages_total : proof.feishu_messages_window} 条` : "—"}
          </div>
          <div className={styles.proofStripMeta}>
            {proof
              ? windowRange === "all"
                ? `近 7 日 ${proof.feishu_messages_7d} 条 · 仅统计元数据，管理员不可见群聊正文`
                : `累计 ${proof.feishu_messages_total} 条 · 仅统计元数据，管理员不可见群聊正文`
              : "读取中…"}
          </div>
        </Link>

        <Link href="/admin/integrations" className={styles.proofStripCard}>
          <div className={styles.proofStripHead}>
            <span className="inline-flex items-center gap-1.5"><FileCheck2 size={15} className="text-emerald-600" />证据与对象存储</span>
            <Badge tone="green">{teaching ? `${teaching.formal_evidences_total} 正式` : "—"}</Badge>
          </div>
          <div className={styles.proofStripValue}>{proof ? formatBytes(proof.upload_total_bytes) : "—"}</div>
          <div className={styles.proofStripMeta}>
            {proof ? `已完成上传 ${proof.upload_completed_count} 份 · 拒绝 ${proof.upload_rejected_count} 份` : "读取中…"}
          </div>
        </Link>

        <Link href="/admin/ai-usage" className={styles.proofStripCard}>
          <div className={styles.proofStripHead}>
            <span className="inline-flex items-center gap-1.5"><Activity size={15} className="text-violet-600" />{aiCardLabel}</span>
            <Badge tone={ai && ai.requests >= 3 && (ai.success_rate ?? 100) < 80 ? "red" : "purple"}>
              {ai?.success_rate !== null && ai?.success_rate !== undefined ? `成功率 ${ai.success_rate}%` : "暂无调用"}
            </Badge>
          </div>
          <div className={styles.proofStripValue}>{ai ? `${ai.requests} 次调用` : "—"}</div>
          <div className={styles.proofStripMeta}>
            {ai ? `P95 ${formatDurationMs(ai.p95_latency_ms)} · ${aiCostLabel}` : "读取中…"}
          </div>
        </Link>
      </section>

      <div className={styles.twoColumns}>
        <Box
          className={styles.pulsePanel}
          title={pulseTitle}
          action={<Link className="gp-link inline-flex items-center gap-1 text-xs" href="/admin/logs">查看系统日志 <ArrowRight size={13} /></Link>}
        >
          <div className={styles.panelBody}>
            {!activitySeries.length ? (
              <Empty>暂无近期时间序列</Empty>
            ) : (
              <>
                <div
                  className={compactPulse ? `${styles.pulseChart} ${styles.pulseChartCompact}` : styles.pulseChart}
                  style={{ gridTemplateColumns: `repeat(${activitySeries.length}, minmax(0, 1fr))` }}
                  role="region"
                  aria-label={`${pulseTitle}：审计事件、AI 调用和集成同步活动趋势`}
                  onMouseLeave={() => setHoveredPulse(null)}
                >
                  {activitySeries.map((day, idx) => {
                    const syncCount = day.github_activities + day.feishu_messages;
                    const hAudit = day.audit_events ? Math.max(8, Math.round((day.audit_events / maxPulse) * 110)) : 3;
                    const hAi = day.ai_requests ? Math.max(8, Math.round((day.ai_requests / maxPulse) * 110)) : 3;
                    const hSync = syncCount ? Math.max(8, Math.round((syncCount / maxPulse) * 110)) : 3;
                    const lastIdx = activitySeries.length - 1;
                    const showLabel =
                      idx === lastIdx ||
                      (idx % pulseLabelStride === 0 && lastIdx - idx >= pulseMinEndGap);
                    const isHovered = hoveredPulse?.index === idx;
                    const activeSeries = isHovered ? hoveredPulse.series : null;
                    const ratio = activitySeries.length > 1 ? idx / (activitySeries.length - 1) : 0.5;
                    const tooltipAlign =
                      activitySeries.length <= 2
                        ? "center"
                        : idx < 2 || ratio < 0.22
                          ? "left"
                          : idx >= activitySeries.length - 2 || ratio > 0.78
                            ? "right"
                            : "center";
                    return (
                      <div
                        className={styles.pulseDayCol}
                        key={String(day.date)}
                        tabIndex={0}
                        role="group"
                        data-active={isHovered ? "true" : undefined}
                        aria-label={`${day.date}：业务审计 ${day.audit_events}，AI 调用 ${day.ai_requests}（失败 ${day.ai_failed}），GitHub/飞书同步 ${syncCount}`}
                        onMouseEnter={() => setHoveredPulse({ index: idx, series: null })}
                        onFocus={() => setHoveredPulse({ index: idx, series: null })}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            setHoveredPulse((prev) => (prev?.index === idx ? null : prev));
                          }
                        }}
                      >
                        {isHovered && (
                          <div
                            role="tooltip"
                            className={styles.pulseTooltip}
                            data-align={tooltipAlign}
                          >
                            <div className={styles.pulseTooltipHeader}>
                              <span>{String(day.date)}</span>
                              {day.new_users > 0 && (
                                <span className={styles.pulseTooltipMeta}>+{day.new_users} 新用户</span>
                              )}
                            </div>
                            <div
                              className={styles.pulseTooltipRow}
                              data-highlighted={activeSeries === "audit" ? "true" : undefined}
                            >
                              <span className={styles.pulseTooltipLabel}>
                                <span className={styles.pulseDot} style={{ background: "#60a5fa" }} />
                                业务审计
                              </span>
                              <strong className={styles.pulseTooltipValue}>{day.audit_events}</strong>
                            </div>
                            <div
                              className={styles.pulseTooltipRow}
                              data-highlighted={activeSeries === "ai" ? "true" : undefined}
                            >
                              <span className={styles.pulseTooltipLabel}>
                                <span
                                  className={styles.pulseDot}
                                  style={{ background: day.ai_failed > 0 ? "#f87171" : "#a78bfa" }}
                                />
                                AI 调用
                              </span>
                              <strong className={styles.pulseTooltipValue}>
                                {day.ai_requests}
                                <span className={day.ai_failed > 0 ? styles.pulseTooltipFail : styles.pulseTooltipSub}>
                                  （失败 {day.ai_failed}）
                                </span>
                              </strong>
                            </div>
                            <div
                              className={styles.pulseTooltipRow}
                              data-highlighted={activeSeries === "sync" ? "true" : undefined}
                            >
                              <span className={styles.pulseTooltipLabel}>
                                <span className={styles.pulseDot} style={{ background: "#34d399" }} />
                                GitHub / 飞书同步
                              </span>
                              <strong className={styles.pulseTooltipValue}>
                                {syncCount}
                                {syncCount > 0 && (
                                  <span className={styles.pulseTooltipSub}>
                                    （GH {day.github_activities} / 飞书 {day.feishu_messages}）
                                  </span>
                                )}
                              </strong>
                            </div>
                          </div>
                        )}
                        <div className={styles.pulseBars}>
                          <div
                            className={styles.pulseBar}
                            style={{ height: `${hAudit}px`, background: "#2563eb" }}
                            data-focused={activeSeries === "audit" ? "true" : undefined}
                            data-dimmed={activeSeries !== null && activeSeries !== "audit" ? "true" : undefined}
                            onMouseEnter={() => setHoveredPulse({ index: idx, series: "audit" })}
                          />
                          <div
                            className={styles.pulseBar}
                            style={{ height: `${hAi}px`, background: day.ai_failed > 0 ? "#dc2626" : "#7c3aed" }}
                            data-focused={activeSeries === "ai" ? "true" : undefined}
                            data-dimmed={activeSeries !== null && activeSeries !== "ai" ? "true" : undefined}
                            onMouseEnter={() => setHoveredPulse({ index: idx, series: "ai" })}
                          />
                          <div
                            className={styles.pulseBar}
                            style={{ height: `${hSync}px`, background: "#059669" }}
                            data-focused={activeSeries === "sync" ? "true" : undefined}
                            data-dimmed={activeSeries !== null && activeSeries !== "sync" ? "true" : undefined}
                            onMouseEnter={() => setHoveredPulse({ index: idx, series: "sync" })}
                          />
                        </div>
                        <span
                          className={`h-[16px] whitespace-nowrap text-[11px] text-slate-500 ${
                            compactPulse && idx === 0
                              ? "self-start"
                              : compactPulse && idx === lastIdx
                                ? "self-end"
                                : ""
                          }`}
                        >
                          {showLabel ? String(day.date).slice(5) : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className={styles.pulseLegend}>
                  <span className={styles.pulseLegendItem}><span className={styles.pulseDot} style={{ background: "#2563eb" }} />业务审计</span>
                  <span className={styles.pulseLegendItem}><span className={styles.pulseDot} style={{ background: "#7c3aed" }} />AI 调用（红柱含失败）</span>
                  <span className={styles.pulseLegendItem}><span className={styles.pulseDot} style={{ background: "#059669" }} />GitHub / 飞书同步</span>
                </div>
              </>
            )}
          </div>
        </Box>

        <Box title="治理待办与异常提醒">
          <div className={`${styles.panelBody} space-y-3`}>
            <Link href="/admin/teacher-verifications" className="group flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3.5 transition hover:border-blue-300 hover:bg-blue-50">
              <span className="flex items-center gap-3 min-w-0">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><UserCheck size={17} /></span>
                <span className="min-w-0">
                  <strong className="block text-sm text-slate-900">教师身份审核</strong>
                  <span className="block text-xs text-slate-500">{queues?.pending_teacher_applications ?? 0} 条待处理申请</span>
                </span>
              </span>
              <Badge tone={queues?.pending_teacher_applications ? "amber" : "gray"}>{queues?.pending_teacher_applications ?? 0}</Badge>
            </Link>

            <Link href="/admin/access-requests" className="group flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3.5 transition hover:border-blue-300 hover:bg-blue-50">
              <span className="flex items-center gap-3 min-w-0">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><ShieldCheck size={17} /></span>
                <span className="min-w-0">
                  <strong className="block text-sm text-slate-900">临时访问审批与授权</strong>
                  <span className="block text-xs text-slate-500">{queues?.pending_access_requests ?? 0} 条待批 · {queues?.active_access_grants ?? 0} 份生效中</span>
                </span>
              </span>
              <Badge tone={queues?.pending_access_requests ? "amber" : "gray"}>{queues?.pending_access_requests ?? 0}</Badge>
            </Link>

            {ai && ai.failed > 0 && (
              <Link href="/admin/ai-usage" className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50/70 p-3.5 text-rose-900 transition hover:bg-rose-50">
                <span className="flex items-center gap-3 min-w-0">
                  <AlertTriangle size={18} className="shrink-0 text-rose-600" />
                  <span className="min-w-0">
                    <strong className="block text-sm">{aiFailTitle}</strong>
                    <span className="block truncate text-xs text-rose-700">
                      主要错误：{ai.top_errors.map((e) => `${e.error_code}(${e.count})`).join("、") || "详见故障诊断"}
                    </span>
                  </span>
                </span>
                <ArrowRight size={15} className="shrink-0 text-rose-600" />
              </Link>
            )}

            {proof && (proof.email_challenges_failed_7d > 0 || proof.notification_emails_failed_7d > 0) && (
              <Link href="/admin/integrations" className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3.5 text-amber-900 transition hover:bg-amber-50">
                <span className="flex items-center gap-3 min-w-0">
                  <AlertTriangle size={18} className="shrink-0 text-amber-600" />
                  <span className="min-w-0">
                    <strong className="block text-sm">学校邮箱 / 通知邮件存在投递失败</strong>
                    <span className="block text-xs text-amber-700">
                      验证码失败 {proof.email_challenges_failed_7d} · 通知失败 {proof.notification_emails_failed_7d}
                    </span>
                  </span>
                </span>
                <ArrowRight size={15} className="shrink-0 text-amber-600" />
              </Link>
            )}
          </div>
        </Box>
      </div>

      <Box
        title={`AI 用量与成本概览（${windowLabel}）`}
        action={
          <Link className="gp-link inline-flex items-center gap-1 text-xs" href={`/admin/ai-usage?days=${usageDays}`}>
            查看 AI 详情 <ArrowRight size={13} />
          </Link>
        }
      >
        <div className={styles.panelBody}>
          <div className={styles.aiOverviewMetrics}>
            <div className={styles.aiOverviewTile}>
              <div className={styles.aiOverviewTileHead}>
                <span className={styles.aiOverviewTileIcon} data-tone="blue"><Activity size={15} /></span>
                <span>请求总数</span>
              </div>
              <strong className={styles.aiOverviewTileValue}>{ai ? formatCount(ai.requests) : "—"}</strong>
              <span className={styles.aiOverviewTileMeta}>
                {ai ? `成功 ${formatCount(ai.succeeded)} / 失败 ${formatCount(ai.failed)}` : "读取中…"}
              </span>
            </div>

            <div className={styles.aiOverviewTile}>
              <div className={styles.aiOverviewTileHead}>
                <span className={styles.aiOverviewTileIcon} data-tone="indigo"><Layers3 size={15} /></span>
                <span>总 Token</span>
              </div>
              <strong className={styles.aiOverviewTileValue}>{ai ? formatCount(aiTotalTokens) : "—"}</strong>
              <span className={styles.aiOverviewTileMeta}>
                {ai ? `输入 ${formatCompactTokens(ai.input_tokens)} / 输出 ${formatCompactTokens(ai.output_tokens)}` : "读取中…"}
              </span>
            </div>

            <div className={styles.aiOverviewTile}>
              <div className={styles.aiOverviewTileHead}>
                <span className={styles.aiOverviewTileIcon} data-tone={ai && ai.unpriced_requests > 0 ? "amber" : "green"}><Coins size={15} /></span>
                <span>累计费用</span>
              </div>
              <strong className={styles.aiOverviewTileValue}>{aiCostLabel}</strong>
              <span className={styles.aiOverviewTileMeta}>
                {ai
                  ? ai.unpriced_requests > 0
                    ? `含 ${formatCount(ai.unpriced_requests)} 次未计价`
                    : ai.requests > 0
                      ? "计费记录完整"
                      : "暂无调用"
                  : "读取中…"}
              </span>
            </div>

            <div className={styles.aiOverviewTile}>
              <div className={styles.aiOverviewTileHead}>
                <span
                  className={styles.aiOverviewTileIcon}
                  data-tone={ai && ai.requests >= 3 && (ai.success_rate ?? 100) < 80 ? "red" : "purple"}
                >
                  <Gauge size={15} />
                </span>
                <span>性能与成功率</span>
              </div>
              <strong
                className={styles.aiOverviewTileValue}
                data-tone={ai && ai.requests >= 3 && (ai.success_rate ?? 100) < 80 ? "red" : undefined}
              >
                {ai?.success_rate !== null && ai?.success_rate !== undefined ? `${ai.success_rate}%` : "—"}
              </strong>
              <span className={styles.aiOverviewTileMeta}>
                {ai
                  ? avgLatencyMs !== null
                    ? `平均 ${formatDurationMs(avgLatencyMs)} / P95 ${formatDurationMs(p95LatencyMs)}`
                    : `P95 ${formatDurationMs(p95LatencyMs)}`
                  : "读取中…"}
              </span>
            </div>
          </div>

          <div className={styles.aiOverviewBreakdowns}>
            <div className={styles.aiOverviewRankCol}>
              <div className={styles.aiOverviewRankHeader}>
                <h3>高频业务场景</h3>
                <span>Top {topFeatures.length || 0}</span>
              </div>
              {aiUsage.isFetching && !aiUsage.data ? (
                <p className={styles.muted}>正在读取场景分布…</p>
              ) : !topFeatures.length ? (
                <p className={styles.muted}>当前窗口暂无场景调用记录</p>
              ) : (
                <div className={styles.aiOverviewRankList}>
                  {topFeatures.map((item) => {
                    const pct = Math.round((item.requests / usageTotalForShare) * 100);
                    const width = Math.max(4, pct);
                    const label = aiFeatureLabels[item.key] ?? item.key;
                    return (
                      <div key={item.key} className={styles.aiOverviewRankItem}>
                        <div className={styles.aiOverviewRankMeta}>
                          <span className={styles.aiOverviewRankName} title={item.key}>{label}</span>
                          <span className={styles.aiOverviewRankCount}>
                            <strong>{formatCount(item.requests)}</strong> 次 · {pct}%
                          </span>
                        </div>
                        <div className={styles.aiOverviewRankTrack}>
                          <div className={styles.aiOverviewRankFill} data-tone="blue" style={{ width: `${width}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={styles.aiOverviewRankCol}>
              <div className={styles.aiOverviewRankHeader}>
                <h3>高频模型排行</h3>
                <span>Top {topModels.length || 0}</span>
              </div>
              {aiUsage.isFetching && !aiUsage.data ? (
                <p className={styles.muted}>正在读取模型排行…</p>
              ) : !topModels.length ? (
                <p className={styles.muted}>当前窗口暂无模型调用记录</p>
              ) : (
                <div className={styles.aiOverviewRankList}>
                  {topModels.map((item) => {
                    const pct = Math.round((item.requests / usageTotalForShare) * 100);
                    const width = Math.max(4, pct);
                    return (
                      <div key={item.key} className={styles.aiOverviewRankItem}>
                        <div className={styles.aiOverviewRankMeta}>
                          <span className={styles.aiOverviewRankName} title={item.key}>{item.key}</span>
                          <span className={styles.aiOverviewRankCount}>
                            <strong>{formatCount(item.requests)}</strong> 次 · {pct}%
                          </span>
                        </div>
                        <div className={styles.aiOverviewRankTrack}>
                          <div className={styles.aiOverviewRankFill} data-tone="purple" style={{ width: `${width}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </Box>

      <div className={styles.twoColumns}>
        <Box
          title="最近账号"
          action={<Link className="gp-link inline-flex items-center gap-1" href="/admin/users">查看用户目录 <ArrowRight size={14} /></Link>}
        >
          <div className={styles.panelBody}>
            {!loading && !overview.isError && !(data?.recent_users.length) && <Empty>暂无使用端账号</Empty>}
            {(data?.recent_users ?? []).map((item) => (
              <Link
                key={item.id}
                href={`/admin/users?user=${encodeURIComponent(String(item.id))}`}
                className="flex items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-0 hover:bg-slate-50/70 px-1 rounded"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-sm text-slate-900">{item.name}</strong>
                  <span className="mt-1 block truncate text-xs text-slate-500">
                    {item.school_email ?? "暂无学校邮箱"}
                    {item.college ? ` · ${item.college}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  <Badge tone={roleTones[item.role] ?? "gray"}>{roleLabels[item.role] ?? item.role}</Badge>
                  <Badge tone={item.status === "disabled" ? "red" : "green"}>{item.status === "disabled" ? "已停用" : "可用"}</Badge>
                  {item.school_email_verified ? (
                    <Badge tone="green">邮箱已验</Badge>
                  ) : (
                    <Badge tone="amber">待验证</Badge>
                  )}
                  <span className="hidden text-[11px] text-slate-400 sm:inline">{formatRelativeTime(item.created_at)}</span>
                </span>
              </Link>
            ))}
          </div>
        </Box>

        <div className={styles.stack}>
          <Box title="账号结构与验证覆盖">
            <div className={styles.panelBody}>
              <Distribution items={roleItems} total={users?.total ?? 0} />
              {users && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
                  <span>学校邮箱已验：{users.verified_school_email}</span>
                  <span>·</span>
                  <span>Google 绑定：{users.google_linked}</span>
                  <span>·</span>
                  <span>GitHub 归属：{users.github_verified}</span>
                </div>
              )}
            </div>
          </Box>
          <Box title="课程生命周期分布">
            <div className={styles.panelBody}>
              <Distribution items={courseItems} total={teaching?.courses_total ?? 0} />
            </div>
          </Box>
        </div>
      </div>

      <Box title="系统探针与服务状态">
        <div className={styles.healthGrid}>
          {(data?.system_health ?? []).map((probe) => (
            <div key={probe.key} className={styles.healthItem}>
              <div className="min-w-0">
                <strong className="block text-sm text-slate-900">{probe.label}</strong>
                <span className="mt-1 block text-xs text-slate-500">{probe.detail}</span>
              </div>
              <Badge tone={healthTone(probe.status)}>
                {probe.status === "healthy" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {healthText(probe.status)}
              </Badge>
            </div>
          ))}
          {!data && !overview.isError && <p className={styles.muted}>正在读取系统探针…</p>}
        </div>
      </Box>
    </main>
  );
}
