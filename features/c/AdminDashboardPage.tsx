"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileCheck2,
  GitBranch,
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

const windowOptions: readonly { value: OverviewWindow; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "30d", label: "近 30 天" },
  { value: "7d", label: "近 7 天" },
];

export function AdminDashboardPage() {
  const { userId } = useWorkspace();
  const [windowRange, setWindowRange] = useState<OverviewWindow>("all");
  const overview = useQuery({
    queryKey: ["admin-workbench-overview", userId, windowRange],
    queryFn: () => governance.workbenchOverview({ window: windowRange }),
    staleTime: 20_000,
    retry: false,
  });

  const data = overview.data;
  const loading = overview.isFetching;
  const users = data?.users;
  const queues = data?.queues;
  const teaching = data?.teaching;
  const proof = data?.proof_pipeline;
  const ai = data?.ai ?? data?.ai_7d;

  const onlyAdmin = Boolean(users && users.total === 1 && teaching && teaching.courses_total === 0);
  const verifiedRate = users && users.total > 0 ? `${Math.round((users.verified_school_email / users.total) * 100)}%` : "—";
  const aiCostLabel = ai
    ? Object.entries(ai.cost_by_currency).map(([c, v]) => `${c} ${v}`).join(" · ") || (ai.requests ? "未计价" : "暂无费用")
    : "—";

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
    activitySeries.length <= 7 ? 1 : activitySeries.length <= 15 ? 2 : activitySeries.length <= 35 ? 5 : 10;
  const maxPulse = Math.max(
    1,
    ...activitySeries.map((day) => Math.max(day.audit_events, day.ai_requests, day.github_activities + day.feishu_messages)),
  );
  const aiCardLabel =
    windowRange === "all" ? "教学 AI（全部）" : windowRange === "30d" ? "教学 AI（近 30 天）" : "教学 AI（近 7 天）";
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
                  onClick={() => setWindowRange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button type="button" className={styles.button} disabled={loading} onClick={() => void overview.refetch()}>
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
                  role="img"
                  aria-label={`${pulseTitle}：审计事件、AI 调用和集成同步活动趋势`}
                >
                  {activitySeries.map((day, idx) => {
                    const syncCount = day.github_activities + day.feishu_messages;
                    const hAudit = day.audit_events ? Math.max(8, Math.round((day.audit_events / maxPulse) * 110)) : 3;
                    const hAi = day.ai_requests ? Math.max(8, Math.round((day.ai_requests / maxPulse) * 110)) : 3;
                    const hSync = syncCount ? Math.max(8, Math.round((syncCount / maxPulse) * 110)) : 3;
                    const showLabel = idx % pulseLabelStride === 0 || idx === activitySeries.length - 1;
                    return (
                      <div
                        className={styles.pulseDayCol}
                        key={String(day.date)}
                        title={`${day.date} · 审计 ${day.audit_events} · AI ${day.ai_requests}（失败 ${day.ai_failed}）· 同步 ${syncCount} · 新用户 ${day.new_users}`}
                      >
                        <div className={styles.pulseBars}>
                          <div className={styles.pulseBar} style={{ height: `${hAudit}px`, background: "#2563eb" }} />
                          <div className={styles.pulseBar} style={{ height: `${hAi}px`, background: day.ai_failed > 0 ? "#dc2626" : "#7c3aed" }} />
                          <div className={styles.pulseBar} style={{ height: `${hSync}px`, background: "#059669" }} />
                        </div>
                        <span className="h-[16px] whitespace-nowrap text-[11px] text-slate-500">
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
