"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CheckCircle2,
  Cpu,
  FolderKanban,
  GitBranch,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { CApiError } from "@/lib/api/c-client";
import {
  createGovernanceClient,
  type AdminProjectDetailDTO,
  type AdminProjectListItemDTO,
  type WorkbenchProjectsQuery,
} from "@/lib/api/c-governance-client";
import {
  CopyableId,
  describeAuditAction,
  formatBytes,
  formatRelativeTime,
} from "@/features/c/AdminPrimitives";
import { useUrlQuery } from "@/features/c/use-url-query";
import { Badge, Box, Empty, Header, Metric, Notice, Table, formatDateTime } from "@/features/governance/primitives";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useWorkspace } from "@/lib/workspace";
import { tr } from "@/lib/i18n/tr";
import styles from "@/features/governance/governance.module.css";

const api = createGovernanceClient();
const querySettings = { staleTime: 10_000, gcTime: 60_000, retry: false } as const;

const lifecycleLabels: Record<AdminProjectListItemDTO["lifecycle"], string> = {
  active: "进行中",
  finalized: "已定稿",
  archived: "已归档",
};

const setupStatusLabels: Record<string, string> = {
  not_initialized: "未初始化",
  draft: "配置草稿",
  pending_confirmation: "待成员确认",
  frozen: "基线已冻结",
};

const visibilityLabels: Record<AdminProjectListItemDTO["visibility"], string> = {
  members: "仅成员可见",
  course: "课程内公开",
};

function formatCosts(costs: Record<string, string>) {
  const parts = Object.entries(costs).map(([cur, amt]) => `${cur} ${amt}`);
  return parts.length ? parts.join(" / ") : "—";
}

function pageNumber(raw: string | null) {
  const num = Number(raw);
  return Number.isInteger(num) && num >= 1 ? num : 1;
}

function ProjectDetailDrawer({
  projectId,
  onClose,
  onChanged,
}: {
  projectId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { userId } = useWorkspace();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const detail = useQuery({
    queryKey: ["admin-workbench-project", userId, projectId],
    queryFn: () => api.workbenchProjectDetail(projectId!),
    enabled: Boolean(projectId),
    ...querySettings,
  });

  const data: AdminProjectDetailDTO | undefined =
    detail.isSuccess && !detail.isFetching ? detail.data : undefined;

  async function runLifecycle(action: "archive" | "restore" | "finalize") {
    if (!data || !reason.trim() || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await api.workbenchUpdateProjectLifecycle(data.id, {
        action,
        expected_version: data.lock_version,
        reason: reason.trim(),
      });
      cache.setQueryData(["admin-workbench-project", userId, data.id], updated);
      setReason("");
      setFeedback({
        tone: "ok",
        text:
          action === "archive"
            ? "项目已归档并记录管理审计日志。"
            : action === "restore"
              ? "项目已恢复为进行中状态。"
              : "项目已标记为定稿状态。",
      });
      onChanged();
    } catch (error) {
      const msg =
        error instanceof CApiError && error.code === "VERSION_CONFLICT"
          ? "项目状态版本已变化，请点击刷新后再提交。"
          : error instanceof Error
            ? error.message
            : "状态变更失败，请重试。";
      setFeedback({ tone: "err", text: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={Boolean(projectId)}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          setFeedback(null);
          onClose();
        }
      }}
    >
      <SheetContent
        className={styles.identityDrawer}
        aria-describedby="admin-project-drawer-desc"
        aria-modal="true"
      >
        <div className={styles.identityDrawerBody}>
          <div className={styles.identityDrawerHeader}>
            <div className={styles.identityDrawerHeading}>
              <SheetTitle className={styles.identityDrawerTitle}>
                {data?.name ?? "项目详情"}
              </SheetTitle>
              <SheetDescription id="admin-project-drawer-desc">
                {data
                  ? data.origin === "standalone"
                    ? "独立项目（未加入课程）"
                    : `课程项目 · ${data.course_code ?? ""} ${data.course_name ?? ""}`.trim()
                  : "正在读取项目元数据…"}
              </SheetDescription>
              {projectId && (
                <div className="mt-1.5">
                  <CopyableId value={projectId} compact={false} />
                </div>
              )}
            </div>
            <button
              type="button"
              className={styles.button}
              disabled={detail.isFetching || busy}
              onClick={() => void detail.refetch()}
            >
              <RefreshCw size={14} />
              刷新
            </button>
            {data && (
              <div className={styles.identityBadgeGroup}>
                <Badge tone={data.origin === "standalone" ? "purple" : "blue"}>
                  {data.origin === "standalone" ? "独立项目" : "课程项目"}
                </Badge>
                <Badge
                  tone={
                    data.lifecycle === "active"
                      ? "green"
                      : data.lifecycle === "finalized"
                        ? "blue"
                        : "gray"
                  }
                >
                  {lifecycleLabels[data.lifecycle]}
                </Badge>
                <Badge tone="gray">{visibilityLabels[data.visibility]}</Badge>
              </div>
            )}
          </div>

          <div className={styles.identityDrawerContent}>
            <Notice>
              遵循 GroupProof 隐私边界：管理端仅展示项目元数据、成员名录、同步健康度与 AI 消耗，不读取项目描述、任务正文、正式证据正文或飞书聊天内容。
            </Notice>

            {detail.isFetching && <p role="status" className="text-xs text-slate-500">正在加载项目 360 元数据…</p>}
            {detail.isError && (
              <p role="alert" className="text-sm text-rose-700">
                {detail.error instanceof Error ? detail.error.message : "无法读取项目详情"}
              </p>
            )}

            {data && (
              <>
                <div className={styles.user360Section}>
                  <h4>项目基础元数据</h4>
                  <div className={styles.bindingMatrix}>
                    <div className={styles.bindingItem}>
                      <span>配置阶段</span>
                      <strong>{setupStatusLabels[data.setup_status] ?? data.setup_status}（Step {data.setup_step}）</strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>类型 / 语言</span>
                      <strong>{data.project_type || "未标注"} · {data.language || "默认"}</strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>创建时间</span>
                      <strong>{formatDateTime(data.created_at)}</strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>最近更新</span>
                      <strong>{formatRelativeTime(data.updated_at)}</strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>任务 / 需求 / 正式证据</span>
                      <strong>
                        任务 {data.counts.tasks_done}/{data.counts.tasks_total} · 需求 {data.counts.requirements_total} · 证据 {data.counts.formal_evidences_total}
                      </strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>存储 / 有效临时授权</span>
                      <strong>
                        {data.counts.upload_completed_count} 文件（{formatBytes(data.counts.upload_total_bytes)}）· 授权 {data.counts.active_access_grants}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className={styles.user360Section}>
                  <h4 className="flex items-center gap-1.5">
                    <GitBranch size={14} />
                    过程证明链路 &amp; 近 30 日 AI 消耗
                  </h4>
                  <div className={styles.bindingMatrix}>
                    <div className={styles.bindingItem}>
                      <span>GitHub 仓库</span>
                      <strong>
                        {data.github.linked
                          ? `${data.github.repo_full_name} (${data.github.activity_count} 条活动)`
                          : "未绑定"}
                      </strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>GitHub 最近同步</span>
                      <strong>
                        {data.github.linked
                          ? data.github.last_synced_at
                            ? formatRelativeTime(data.github.last_synced_at)
                            : "尚未同步"
                          : "—"}
                      </strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>飞书群追踪（脱敏）</span>
                      <strong>
                        {data.feishu.linked
                          ? `${data.feishu.chat_id_masked} · ${data.feishu.message_count} 条消息`
                          : "未绑定"}
                      </strong>
                    </div>
                    <div className={styles.bindingItem}>
                      <span>近 30 日 AI 消耗</span>
                      <strong>
                        {data.ai_30d.requests} 次（失败 {data.ai_30d.failed}）· {formatCosts(data.ai_30d.cost_by_currency)}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className={styles.user360Section}>
                  <h4 className="flex items-center gap-1.5">
                    <Users size={14} />
                    当前成员名录（{data.members.length} 人）
                  </h4>
                  {data.members.length ? (
                    <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                      {data.members.map((m) => (
                        <div key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                          <div>
                            <strong className="text-slate-900">{m.name}</strong>
                            <span className="ml-2 text-slate-500">
                              {m.student_id || "无学号"} · {m.college || "未填学院"}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Badge tone={m.role === "leader" ? "blue" : "gray"}>
                              {m.role === "leader" ? "组长" : "成员"}
                            </Badge>
                            <Badge tone={m.school_email_verified ? "green" : "amber"}>
                              {m.school_email_verified ? "邮箱已验" : "待验证"}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">暂无在册成员</p>
                  )}
                </div>

                <div className={styles.user360Section}>
                  <h4 className="flex items-center gap-1.5">
                    <ShieldCheck size={14} />
                    管理员生命周期治理（版本 v{data.lock_version}）
                  </h4>
                  {feedback && (
                    <p
                      role={feedback.tone === "err" ? "alert" : "status"}
                      className={`text-xs ${feedback.tone === "err" ? "text-rose-700" : "text-emerald-700"}`}
                    >
                      {feedback.text}
                    </p>
                  )}
                  <label className={styles.field}>
                    <span>治理操作理由（写入审计日志）</span>
                    <textarea
                      className={styles.textarea}
                      rows={2}
                      maxLength={2000}
                      placeholder="例如：学期结束统一归档、违规项目下线或按团队申请恢复活跃"
                      value={reason}
                      disabled={busy}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {data.lifecycle !== "archived" && (
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={busy || !reason.trim()}
                        onClick={() => void runLifecycle("archive")}
                      >
                        <Archive size={14} />
                        归档项目
                      </button>
                    )}
                    {data.lifecycle !== "active" && (
                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={busy || !reason.trim()}
                        onClick={() => void runLifecycle("restore")}
                      >
                        <RotateCcw size={14} />
                        恢复为进行中
                      </button>
                    )}
                    {data.lifecycle === "active" && (
                      <button
                        type="button"
                        className={styles.button}
                        disabled={busy || !reason.trim()}
                        onClick={() => void runLifecycle("finalize")}
                      >
                        <CheckCircle2 size={14} />
                        标记为已定稿
                      </button>
                    )}
                  </div>
                </div>

                <div className={styles.user360Section}>
                  <h4>近期项目审计轨迹（最近 8 条）</h4>
                  {data.recent_audit_events.length ? (
                    <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                      {data.recent_audit_events.map((ev) => {
                        const meta = describeAuditAction(ev.action);
                        return (
                          <div key={ev.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                            <div>
                              <strong className="text-slate-900">{meta.label}</strong>
                              <span className="ml-2 text-slate-500">{ev.actor_name}</span>
                              {ev.reason && <div className="mt-0.5 text-slate-500">理由：{ev.reason}</div>}
                            </div>
                            <div className="flex items-center gap-1.5 text-slate-500">
                              <Badge tone={ev.result === "success" ? "green" : "red"}>
                                {ev.result === "success" ? "成功" : ev.result}
                              </Badge>
                              <span>{formatRelativeTime(ev.occurred_at)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">暂无项目审计记录</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function AdminProjectsPage() {
  const { userId } = useWorkspace();
  const { query, updateQuery } = useUrlQuery();
  const page = pageNumber(query.get("page"));
  const rawPageSize = Number(query.get("pageSize") ?? 10);
  const pageSize = rawPageSize === 20 || rawPageSize === 50 ? rawPageSize : 10;
  const originParam = (["all", "standalone", "course"].includes(query.get("origin") ?? "")
    ? query.get("origin")
    : "all") as NonNullable<WorkbenchProjectsQuery>["origin"];
  const lifecycleParam = (["all", "active", "finalized", "archived"].includes(query.get("lifecycle") ?? "")
    ? query.get("lifecycle")
    : "all") as NonNullable<WorkbenchProjectsQuery>["lifecycle"];
  const githubParam = (["all", "yes", "no"].includes(query.get("github") ?? "")
    ? query.get("github")
    : "all") as NonNullable<WorkbenchProjectsQuery>["has_github"];
  const feishuParam = (["all", "yes", "no"].includes(query.get("feishu") ?? "")
    ? query.get("feishu")
    : "all") as NonNullable<WorkbenchProjectsQuery>["has_feishu"];
  const selectedProjectId = query.get("project") || null;

  const filters: WorkbenchProjectsQuery = {
    page,
    page_size: pageSize,
    q: query.get("q") || undefined,
    origin: originParam,
    lifecycle: lifecycleParam,
    has_github: githubParam,
    has_feishu: feishuParam,
  };

  const list = useQuery({
    queryKey: ["admin-workbench-projects", userId, filters],
    queryFn: () => api.workbenchProjects(filters),
    ...querySettings,
  });

  const data = list.isSuccess && !list.isFetching ? list.data : undefined;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    updateQuery({
      q: String(form.get("q") ?? "").trim() || null,
      origin: String(form.get("origin") ?? "all") === "all" ? null : String(form.get("origin")),
      lifecycle: String(form.get("lifecycle") ?? "all") === "all" ? null : String(form.get("lifecycle")),
      github: String(form.get("github") ?? "all") === "all" ? null : String(form.get("github")),
      feishu: String(form.get("feishu") ?? "all") === "all" ? null : String(form.get("feishu")),
      pageSize: String(form.get("pageSize") ?? "10") === "10" ? null : String(form.get("pageSize")),
      page: null,
    });
  }

  return (
    <div className={styles.page}>
      <Header
        title="项目管理"
        description="统一查看与治理全平台项目（覆盖未加入课程的独立项目与课程项目），严守元数据隔离边界。"
        action={
          <button
            type="button"
            className={styles.button}
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            <RefreshCw size={15} />
            刷新项目
          </button>
        }
      />

      {data && (
        <div className={styles.metrics}>
          <Metric
            label="项目总数"
            value={data.summary.total}
            hint={`独立项目 ${data.summary.standalone} · 课程项目 ${data.summary.course_bound}`}
            icon={FolderKanban}
            tone="blue"
          />
          <Metric
            label="活跃 / 已归档"
            value={`${data.summary.active} / ${data.summary.archived}`}
            hint={`已定稿 ${data.summary.finalized} 个`}
            icon={CheckCircle2}
            tone="green"
          />
          <Metric
            label="已接 GitHub 仓库"
            value={data.summary.github_linked}
            hint="已绑定自动或手动同步仓"
            icon={GitBranch}
            tone="purple"
          />
          <Metric
            label="已绑飞书协作群"
            value={data.summary.feishu_linked}
            hint="仅统计绑定元数据"
            icon={MessageSquare}
            tone="amber"
          />
        </div>
      )}

      <form
        className={`${styles.toolbarPanel} ${styles.toolbar} ${styles.identityUserFilters}`}
        key={query.toString()}
        onSubmit={onSubmit}
      >
        <label className={styles.field}>
          <span>搜索项目</span>
          <input
            className={styles.input}
            name="q"
            placeholder="项目名称、类型或课程编号"
            defaultValue={query.get("q") ?? ""}
          />
        </label>
        <label className={styles.field}>
          <span>项目来源</span>
          <select className={styles.input} name="origin" aria-label="项目来源" defaultValue={originParam}>
            <option value="all">全部来源</option>
            <option value="standalone">独立项目（无课程）</option>
            <option value="course">课程项目</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>生命周期</span>
          <select className={styles.input} name="lifecycle" aria-label="生命周期" defaultValue={lifecycleParam}>
            <option value="all">全部状态</option>
            <option value="active">进行中</option>
            <option value="finalized">已定稿</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>GitHub 集成</span>
          <select className={styles.input} name="github" aria-label="GitHub 集成" defaultValue={githubParam}>
            <option value="all">全部</option>
            <option value="yes">已绑定</option>
            <option value="no">未绑定</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>飞书群</span>
          <select className={styles.input} name="feishu" aria-label="飞书群" defaultValue={feishuParam}>
            <option value="all">全部</option>
            <option value="yes">已绑定</option>
            <option value="no">未绑定</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>每页条数</span>
          <select className={styles.input} name="pageSize" aria-label="每页条数" defaultValue={String(pageSize)}>
            <option value="10">10 条</option>
            <option value="20">20 条</option>
            <option value="50">50 条</option>
          </select>
        </label>
        <div className={styles.identityFilterActions}>
          <button type="submit" className={styles.primaryButton}>查询</button>
          <button
            type="button"
            className={styles.button}
            onClick={() =>
              updateQuery({
                q: null,
                origin: null,
                lifecycle: null,
                github: null,
                feishu: null,
                pageSize: null,
                page: null,
              })
            }
          >
            重置筛选
          </button>
        </div>
        <div className={styles.identityQuickFilters} role="group" aria-label="快捷项目筛选">
          {(
            [
              ["all", "all", "全部项目"],
              ["standalone", "all", "仅独立项目"],
              ["course", "all", "仅课程项目"],
              ["all", "archived", "已归档"],
            ] as const
          ).map(([orig, life, label]) => {
            const pressed = originParam === orig && lifecycleParam === life;
            return (
              <button
                key={label}
                type="button"
                className={styles.identityQuickFilter}
                aria-pressed={pressed}
                onClick={() =>
                  updateQuery({
                    origin: orig === "all" ? null : orig,
                    lifecycle: life === "all" ? null : life,
                    page: null,
                  })
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </form>

      {list.isFetching && <p role="status" className="text-xs text-slate-500">正在读取项目目录…</p>}
      {list.isError && (
        <Notice>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{list.error instanceof Error ? list.error.message : "项目工作台接口暂不可用"}</span>
            <button type="button" className={styles.button} onClick={() => void list.refetch()}>
              重试
            </button>
          </div>
        </Notice>
      )}

      {data && (
        <Box>
          <Table>
            <thead>
              <tr>
                <th>项目名称 / 来源</th>
                <th>组长 / 成员</th>
                <th>任务 / 证据</th>
                <th>外部集成</th>
                <th>近 30 日 AI</th>
                <th>状态</th>
                <th>最近更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="space-y-1">
                      <strong className="block text-slate-900">{item.name}</strong>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge tone={item.origin === "standalone" ? "purple" : "blue"}>
                          {item.origin === "standalone" ? "独立项目" : `课程 ${item.course_code ?? ""}`.trim()}
                        </Badge>
                        <CopyableId value={item.id} />
                      </div>
                    </div>
                  </td>
                  <td className="text-xs">
                    <strong className="block text-slate-900">{item.leader_name || "未指定组长"}</strong>
                    <span className="text-slate-500">{item.member_count} 名成员</span>
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-700">
                    {item.task_count} 任务 · {item.evidence_formal_count} 证据
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge tone={item.github_linked ? "green" : "gray"}>
                        {item.github_linked ? "GitHub" : "无 GitHub"}
                      </Badge>
                      <Badge tone={item.feishu_linked ? "blue" : "gray"}>
                        {item.feishu_linked ? "飞书" : "无飞书"}
                      </Badge>
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-700">
                    {item.ai_requests_30d > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <Cpu size={12} className="text-blue-600" />
                        {item.ai_requests_30d} 次 · {formatCosts(item.ai_cost_30d_by_currency)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        item.lifecycle === "active"
                          ? "green"
                          : item.lifecycle === "finalized"
                            ? "blue"
                            : "gray"
                      }
                    >
                      {lifecycleLabels[item.lifecycle]}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    {formatRelativeTime(item.updated_at)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => updateQuery({ project: item.id })}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!data.items.length && <Empty>暂无符合条件的项目</Empty>}
          <div className={styles.tableFooter}>
            <span>
              {tr("共 {0} 条 · 第 {1} 页", { 0: data.total, 1: page })}
            </span>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                disabled={page <= 1}
                onClick={() => updateQuery({ page: String(page - 1) })}
              >
                上一页
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={page * pageSize >= data.total}
                onClick={() => updateQuery({ page: String(page + 1) })}
              >
                下一页
              </button>
            </div>
          </div>
        </Box>
      )}

      <ProjectDetailDrawer
        projectId={selectedProjectId}
        onClose={() => updateQuery({ project: null })}
        onChanged={() => void list.refetch()}
      />
    </div>
  );
}
