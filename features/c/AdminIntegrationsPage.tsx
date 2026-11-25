"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileCheck2, GitBranch, Mail, MessageSquare, RefreshCw, ShieldAlert } from "lucide-react";
import { createGovernanceClient } from "@/lib/api/c-governance-client";
import { useWorkspace } from "@/lib/workspace";
import { Badge, Box, Empty, Header, Metric, Table, formatDateTime } from "@/features/governance/primitives";
import { CopyableId, formatBytes, formatRelativeTime } from "@/features/c/AdminPrimitives";
import styles from "@/features/governance/governance.module.css";

const governance = createGovernanceClient();

function githubHealthBadge(health: "healthy" | "stale" | "never_synced") {
  if (health === "healthy") return <Badge tone="green">同步正常</Badge>;
  if (health === "stale") return <Badge tone="amber">同步滞后 (&gt;48h)</Badge>;
  return <Badge tone="gray">尚未同步</Badge>;
}

export function AdminIntegrationsPage() {
  const { userId } = useWorkspace();
  const query = useQuery({
    queryKey: ["admin-workbench-integrations", userId],
    queryFn: () => governance.workbenchIntegrations(),
    staleTime: 20_000,
    retry: false,
  });

  const data = query.data;
  const gh = data?.github;
  const fs = data?.feishu;
  const email = data?.email_delivery;
  const storage = data?.storage_and_evidence;
  const rl = data?.rate_limits;

  return (
    <main className={styles.page}>
      <Header
        title="过程证明与集成运维"
        action={
          <button type="button" className={styles.button} disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
            {query.isFetching ? "刷新中…" : "刷新状态"}
          </button>
        }
      />

      {query.isError && (
        <div role="alert" className={styles.identityError}>
          <p>集成与运维状态读取失败，请确认管理员权限或服务连通性后重试。</p>
          <button type="button" className={styles.button} onClick={() => void query.refetch()}>
            重试
          </button>
        </div>
      )}

      <div className={styles.metrics}>
        <Metric
          label="GitHub 绑定仓库"
          value={gh ? gh.total_links : "—"}
          hint={gh ? `24h 活跃 ${gh.synced_24h} · 7 日活动 ${gh.activities_7d} 条` : "正在读取"}
          trend={gh ? (gh.stale_over_48h > 0 ? `${gh.stale_over_48h} 个仓库超 48h 未同步` : "全部按期同步") : undefined}
          icon={GitBranch}
          tone={gh && gh.stale_over_48h > 0 ? "amber" : "blue"}
        />
        <Metric
          label="飞书群聊追踪"
          value={fs ? fs.total_links : "—"}
          hint={fs ? `累计消息 ${fs.messages_total} 条 · 近 7 日 ${fs.messages_7d} 条` : "正在读取"}
          trend={fs ? `附件指纹 ${fs.attachments_total} 份 · 近 7 日撤回 ${fs.deleted_messages_7d} 条` : undefined}
          icon={MessageSquare}
          tone="purple"
        />
        <Metric
          label="学校邮箱投递（7 日）"
          value={email ? email.challenges_7d : "—"}
          hint={email ? `已投递 ${email.challenges_accepted_7d} · 捕获 ${email.challenges_captured_7d}` : "正在读取"}
          trend={email ? `验证码失败 ${email.challenges_failed_7d} · 通知失败 ${email.notifications_email_failed_7d}` : undefined}
          icon={Mail}
          tone={email && (email.challenges_failed_7d > 0 || email.notifications_email_failed_7d > 0) ? "red" : "green"}
        />
        <Metric
          label="正式证据与存储"
          value={storage ? formatBytes(storage.total_bytes) : "—"}
          hint={storage ? `完成上传 ${storage.upload_completed} 份 · 待确认证据 ${storage.evidence_pending_confirmation}` : "正在读取"}
          trend={storage ? `正式证据 ${storage.evidence_formal} / 总 ${storage.evidence_total}` : undefined}
          icon={FileCheck2}
          tone="green"
        />
      </div>

      <Box
        title="GitHub 仓库同步监控"
        action={gh && <span className={styles.muted}>个人 GitHub 实名绑定：{gh.verified_identities} 人</span>}
      >
        {gh && gh.links.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <th>项目</th>
                <th>仓库</th>
                <th>默认分支</th>
                <th>活动数</th>
                <th>最近同步</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {gh.links.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong className="block text-slate-900">{item.project_name}</strong>
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      {item.course_code && <span>{item.course_code}</span>}
                      <CopyableId value={String(item.project_id)} />
                    </span>
                  </td>
                  <td><code>{item.repo_full_name}</code></td>
                  <td><code>{item.default_branch}</code></td>
                  <td>{item.activity_count}</td>
                  <td>{item.last_synced_at ? `${formatDateTime(item.last_synced_at)} (${formatRelativeTime(item.last_synced_at)})` : "从未同步"}</td>
                  <td>{githubHealthBadge(item.health)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty>{query.isFetching ? "正在读取仓库同步状态…" : "当前环境暂无绑定的 GitHub 仓库"}</Empty>
        )}
      </Box>

      <Box
        title="飞书群聊同步追踪"
        action={<span className={styles.muted}>群聊 ID 已脱敏 · 仅显示元数与活跃时间</span>}
      >
        {fs && fs.links.length > 0 ? (
          <Table>
            <thead>
              <tr>
                <th>项目</th>
                <th>脱敏群聊 ID</th>
                <th>绑定时间</th>
                <th>累计消息数</th>
                <th>最近消息时间</th>
              </tr>
            </thead>
            <tbody>
              {fs.links.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong className="block text-slate-900">{item.project_name}</strong>
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      {item.course_code && <span>{item.course_code}</span>}
                      <CopyableId value={String(item.project_id)} />
                    </span>
                  </td>
                  <td><code>{item.chat_id_masked}</code></td>
                  <td>{formatDateTime(item.linked_at)}</td>
                  <td>{item.message_count}</td>
                  <td>{item.last_message_at ? `${formatDateTime(item.last_message_at)} (${formatRelativeTime(item.last_message_at)})` : "暂无消息"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty>{query.isFetching ? "正在读取飞书群追踪…" : "当前环境暂无绑定的飞书项目群"}</Empty>
        )}
      </Box>

      <div className={styles.equalColumns}>
        <Box
          title="邮件验证码与通知投递"
          action={email && <Badge tone={email.notifications_email_failed_7d + email.challenges_failed_7d > 0 ? "amber" : "green"}>{email.notifications_email_failed_7d + email.challenges_failed_7d > 0 ? "有失败" : "健康"}</Badge>}
        >
          <div className={styles.panelBody}>
            {email ? (
              <div className={styles.stack}>
                <div className={styles.bindingMatrix}>
                  <div className={styles.bindingItem}><span>验证码 7 日总请求</span><strong>{email.challenges_7d}</strong></div>
                  <div className={styles.bindingItem}><span>验证码投递失败</span><strong>{email.challenges_failed_7d}</strong></div>
                  <div className={styles.bindingItem}><span>站内通知待发邮件</span><strong>{email.notifications_email_pending}</strong></div>
                  <div className={styles.bindingItem}><span>通知邮件 7 日成功 / 失败</span><strong>{email.notifications_email_sent_7d} / {email.notifications_email_failed_7d}</strong></div>
                </div>
                {email.recent_failures.length > 0 ? (
                  <Table>
                    <thead><tr><th>类型</th><th>用途</th><th>目标域名</th><th>时间</th></tr></thead>
                    <tbody>
                      {email.recent_failures.map((item) => (
                        <tr key={`${item.kind}:${item.id}`}>
                          <td><Badge tone="red">{item.kind === "challenge" ? "验证码" : "通知"}</Badge></td>
                          <td>{item.purpose}</td>
                          <td><code>@{item.recipient_domain}</code></td>
                          <td>{formatDateTime(item.occurred_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p className="flex items-center gap-2 text-xs text-emerald-700"><CheckCircle2 size={14} />近 7 日无邮件投递失败记录（仅展示收件域名，不泄露个人邮箱）。</p>
                )}
              </div>
            ) : (
              <Empty>正在读取邮件投递指标…</Empty>
            )}
          </div>
        </Box>

        <Box
          title="存储、证据状态与限流队列"
          action={rl && <Badge tone={rl.active_buckets_24h > 0 ? "blue" : "gray"}>24h 限流桶 {rl.active_buckets_24h}</Badge>}
        >
          <div className={styles.panelBody}>
            {storage ? (
              <div className={styles.stack}>
                <div className={styles.bindingMatrix}>
                  <div className={styles.bindingItem}><span>上传完成 / 待传 / 拒绝</span><strong>{storage.upload_completed} / {storage.upload_pending} / {storage.upload_rejected}</strong></div>
                  <div className={styles.bindingItem}><span>正式 / 待确认 / 作废撤回证据</span><strong>{storage.evidence_formal} / {storage.evidence_pending_confirmation} / {storage.evidence_withdrawn_or_void}</strong></div>
                  <div className={styles.bindingItem}><span>AI 提交摘要失败数</span><strong>{storage.activity_summaries_failed}</strong></div>
                  <div className={styles.bindingItem}><span>治理 Outbox 待投递</span><strong>{storage.outbox_pending}</strong></div>
                </div>
                {rl && rl.top_buckets.length > 0 ? (
                  <Table>
                    <thead><tr><th>限流分类前缀</th><th>24h 命中次数</th><th>最近窗口</th></tr></thead>
                    <tbody>
                      {rl.top_buckets.map((bucket) => (
                        <tr key={bucket.bucket_prefix}>
                          <td><span className="inline-flex items-center gap-1.5"><ShieldAlert size={13} className="text-amber-600" /><code>{bucket.bucket_prefix}</code></span></td>
                          <td>{bucket.total_hits}</td>
                          <td>{formatDateTime(bucket.latest_window)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p className="flex items-center gap-2 text-xs text-slate-500"><AlertTriangle size={14} className="text-slate-400" />近 24 小时暂无活跃限流计数桶。</p>
                )}
              </div>
            ) : (
              <Empty>正在读取存储与队列状态…</Empty>
            )}
          </div>
        </Box>
      </div>
    </main>
  );
}
