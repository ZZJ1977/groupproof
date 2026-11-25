"use client";

import { type DragEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal, Lock, RefreshCw, Search } from "lucide-react";
import { Avatar, EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/shared/components/common";
import { CApiError, createCClient } from "@/shared/daily-inbox/c-client";
import { bTasksApi, type BTaskRow, type BTaskView, type BTransition } from "@/student/api/b-tasks";
import { useUrlFilters } from "@/shared/lib/use-url-filters";
import { useWorkspace } from "@/shared/lib/workspace";
import { useBErrorMessage } from "@/student/projects/use-b-error";
import { projectApi } from "@/shared/lib/c-project-api";
import { button, queryPolicy, secondary } from "@/shared/lib/b-ui";
import { useUiText } from "@/shared/i18n/use-ui-text";

const c = createCClient();
const PAGE_SIZE = 20;
const statusLabel: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" };
const priorityLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
const cErrors: Record<string, string> = {
  DEPENDENCIES_INCOMPLETE: "前置任务还没完成。",
  TASK_ASSIGNEE_REQUIRED: "只有负责人可以开始这个任务。",
  PLAN_NOT_FROZEN: "任务计划还没冻结。",
  TASK_NOT_IN_PLAN: "任务不在已冻结的计划里。",
  VERSION_CONFLICT: "任务刚被别人改过，请刷新后再试。",
  INVALID_TASK_STATE: "任务当前状态不能这样改。",
  EMAIL_NOT_VERIFIED: "请先验证学校邮箱。",
};
const filterSchema = {
  q: { kind: "string" },
  status: { kind: "enum", values: ["", ...Object.keys(statusLabel)], default: "" },
  assignee: { kind: "string" },
  module: { kind: "string" },
  milestone: { kind: "string" },
  sort: { kind: "enum", values: ["code", "-code", "priority", "-weight", "weight", "-progress", "progress", "status", "-updated"], default: "code" },
  page: { kind: "int", default: 1, min: 1 },
  collapsed: { kind: "list" },
} as const;
const titles: Record<BTaskView, string> = {
  tree: "任务列表",
  board: "任务看板",
  list: "任务列表",
};

const cardClass = "rounded-2xl border border-slate-200/85 bg-white shadow-xs";
const filterInput = "h-9 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";
const compactBtn = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const compactSecondary = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

/** Unified tasks workspace: merged tree/list table + kanban board + link to planning. */
export function TasksApiPage({ projectId, view }: { projectId: string; view: BTaskView }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const client = useQueryClient();
  const router = useRouter();
  const { filters, setFilters, clearFilters } = useUrlFilters(filterSchema);
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  const [pending, setPending] = useState<{ row: BTaskRow; transition: BTransition }>();
  const [busy, setBusy] = useState(false);
  const [confirmingTaskId, setConfirmingTaskId] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const query = {
    view,
    q: filters.q || undefined,
    status: filters.status || undefined,
    assignee: filters.assignee || undefined,
    module: filters.module || undefined,
    milestone: filters.milestone || undefined,
    sort: view === "list" ? filters.sort : undefined,
    page: view === "list" ? filters.page : undefined,
    page_size: view === "list" ? PAGE_SIZE : undefined,
  };
  const page = useQuery({ queryKey: ["b-tasks", userId, projectId, query], queryFn: () => bTasksApi.list(projectId, query), ...queryPolicy });
  const projectContext = useQuery({
    queryKey: ["c-project-context", userId, projectId],
    queryFn: () => projectApi.projectContext(projectId),
    ...queryPolicy,
    retry: false,
  });
  const isLeader = Boolean(projectContext.data?.actor.is_leader);

  const invalidateAll = () => {
    for (const name of ["b-tasks", "b-milestones", "b-plan", "c-evidence", "c-task-evidence", "c-project-context"]) {
      void client.invalidateQueries({ queryKey: [name, userId, projectId] });
    }
  };

  const syncCode = useMutation({
    mutationFn: () => bTasksApi.syncCodeProgress(projectId),
    onSuccess: (res) => {
      setNotice({
        tone: "success",
        text: (res.evidences_created ?? 0) > 0 || res.commits_matched > 0
          ? tr("已扫描 {0} 条成员提交，关联 {1} 条提交并生成 {2} 条代码候选证据，覆盖 {3} 条交付标准（需人工确认后正式完成）。", { 0: res.commits_scanned, 1: res.commits_matched, 2: res.evidences_created ?? 0, 3: res.criteria_covered ?? 0 })
          : tr("已扫描 {0} 条成员提交，当前交付标准与代码证据已保持最新。", { 0: res.commits_scanned }),
      });
      invalidateAll();
    },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });

  const confirmAiTask = async (row: BTaskRow) => {
    if (confirmingTaskId !== null || confirmingAll) return;
    setConfirmingTaskId(row.id);
    setNotice(undefined);
    try {
      const res = await bTasksApi.completeByCriteria(
        projectId,
        row.id,
        "核对 AI 自动验收结果无误，一键确认并完成任务。",
        true,
      );
      invalidateAll();
      setNotice({
        tone: "success",
        text: res.task_status === "completed"
          ? tr("已确认 {0} 的 AI 验收结果，任务已完成（100%）。", { 0: row.code ?? row.title })
          : tr("已记录 {0} 的验收确认，等待其余负责人确认后完成。", { 0: row.code ?? row.title }),
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setConfirmingTaskId(null);
    }
  };

  const confirmAllAiPassed = async (targets: BTaskRow[]) => {
    if (confirmingTaskId !== null || confirmingAll || targets.length === 0) return;
    setConfirmingAll(true);
    setNotice(undefined);
    let done = 0;
    try {
      for (const row of targets) {
        await bTasksApi.completeByCriteria(
          projectId,
          row.id,
          "批量核对 AI 自动验收结果无误，一键确认并完成任务。",
          true,
        );
        done += 1;
      }
      invalidateAll();
      setNotice({
        tone: "success",
        text: tr("已一键确认 {0} 个 AI 验收通过的任务，进度已更新为已完成（100%）。", { 0: done }),
      });
    } catch (error) {
      if (done > 0) invalidateAll();
      setNotice({
        tone: "error",
        text: done > 0
          ? tr("已确认 {0} 个任务，其余失败：{1}", { 0: done, 1: errorText(error) })
          : errorText(error),
      });
    } finally {
      setConfirmingAll(false);
    }
  };

  const search = useSearchParams();
  const viewHref = (next: BTaskView) => {
    const params = new URLSearchParams(search.toString());
    params.set("view", next);
    params.delete("page");
    return `/projects/${projectId}/tasks?${params.toString()}`;
  };

  const run = async () => {
    if (!pending) return;
    const { row, transition } = pending;
    if (transition.kind === "page" && transition.href) { setPending(undefined); router.push(transition.href); return; }
    setBusy(true);
    try {
      await c.start(row.id, transition.expected_version);
      setNotice({ tone: "success", text: tr("{0} 已改为“{1}”。", { 0: row.code ?? row.title, 1: tr(statusLabel[transition.to]) }) });
      await client.invalidateQueries({ queryKey: ["b-tasks", userId, projectId] });
    } catch (error) {
      const reason = error instanceof CApiError ? cErrors[error.code] ? tr(cErrors[error.code]) : tr("任务执行接口拒绝了这次操作（{0}）。", { 0: error.code }) : tr("网络异常，请重试。");
      setNotice({ tone: "error", text: tr("没有改动：{0}", { 0: reason }) });
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  };

  const title = titles[view];
  const items = page.data?.items ?? [];
  const rootItems = items.filter((r) => !r.parent_task_id);
  const weightSum = rootItems.reduce((s, r) => s + Math.max(1, r.weight), 0);
  const avgProgress = weightSum > 0 ? Math.round(rootItems.reduce((s, r) => s + r.progress_percent * Math.max(1, r.weight), 0) / weightSum) : 0;
  const totalCriteria = items.reduce((s, r) => s + (r.criteria_total ?? 0), 0);
  const confirmedCriteria = items.reduce((s, r) => s + (r.criteria_confirmed ?? 0), 0);
  const candidateCriteria = items.reduce((s, r) => s + Math.max(0, (r.criteria_evidenced ?? 0) - (r.criteria_confirmed ?? 0)), 0);
  const inProgressTasks = (page.data?.columns ?? []).filter((col) => ["in_progress", "pending_submission", "pending_verification"].includes(col.status)).reduce((s, col) => s + col.count, 0);
  const completedTasks = (page.data?.columns ?? []).find((col) => col.status === "completed")?.count ?? 0;
  const myAiPassedTasks = items.filter((r) =>
    r.status !== "completed"
    && (r.criteria_total ?? 0) > 0
    && (r.criteria_evidenced ?? 0) >= (r.criteria_total ?? 0)
    && (isLeader || r.assignees.some((a) => a.id === userId)),
  );

  return <div className="space-y-3">
    <PageHeader
      title={tr(title)}
      actions={<div className="flex flex-wrap items-center gap-2">
        {myAiPassedTasks.length > 0 && (
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-700 disabled:opacity-50"
            disabled={confirmingAll || confirmingTaskId !== null}
            onClick={() => void confirmAllAiPassed(myAiPassedTasks)}
          >
            <CheckCircle2 size={14} />
            {confirmingAll
              ? tr("正在批量确认…")
              : tr("一键确认 AI 已通过任务 ({0})", { 0: myAiPassedTasks.length })}
          </button>
        )}
        <button type="button" className={compactSecondary} disabled={syncCode.isPending} onClick={() => syncCode.mutate()}>
          <RefreshCw size={13} className={syncCode.isPending ? "animate-spin" : ""} />
          {syncCode.isPending ? tr("正在关联代码证据…") : tr("同步代码证据")}
        </button>
      </div>}
    />

    {page.data && page.data.total > 0 && (
      <div className={`${cardClass} grid grid-cols-2 divide-y divide-slate-100 px-4 py-2.5 lg:grid-cols-4 lg:divide-x lg:divide-y-0`}>
        <div className="flex items-baseline justify-between gap-2 py-0.5 lg:pr-4">
          <span className="text-xs text-slate-500">{tr("任务总数")}</span>
          <span className="text-sm font-bold tabular-nums text-slate-900">
            {page.data.total}
            <span className="ml-1.5 text-[11px] font-normal text-slate-400">{tr("完成 {0}", { 0: completedTasks })}</span>
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 py-0.5 lg:px-4">
          <span className="text-xs text-slate-500">{tr("进行中")}</span>
          <span className="text-sm font-bold tabular-nums text-sky-700">{inProgressTasks}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2 py-0.5 lg:px-4">
          <span className="text-xs text-slate-500">{tr("交付标准")}</span>
          <span className="text-xs font-semibold tabular-nums text-slate-900">
            {totalCriteria > 0 ? (
              <>
                <span className="text-sky-700">{tr("候选 {0}/{1}", { 0: candidateCriteria, 1: totalCriteria })}</span>
                <span className="mx-1 text-slate-300">·</span>
                <span className="text-emerald-700">{tr("正式 {0}/{1}", { 0: confirmedCriteria, 1: totalCriteria })}</span>
              </>
            ) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2.5 py-0.5 lg:pl-4">
          <span className="text-xs text-slate-500">{tr("加权进度")}</span>
          <div className="flex flex-1 items-center justify-end gap-2">
            <div className="h-1.5 max-w-24 flex-1 rounded-full bg-slate-100">
              <div className="h-1.5 rounded-full bg-[var(--gp-action)]" style={{ width: `${avgProgress}%` }} />
            </div>
            <span className="text-sm font-bold tabular-nums text-slate-900">{avgProgress}%</span>
          </div>
        </div>
      </div>
    )}

    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <nav aria-label={tr("任务视图")} className="gp-segmented">
        <Link href={viewHref("tree")} aria-current={view === "tree" ? "page" : undefined} data-active={view === "tree" ? "true" : undefined} className="gp-segmented-item">
          {tr("任务树")}
        </Link>
        <Link href={viewHref("board")} aria-current={view === "board" ? "page" : undefined} data-active={view === "board" ? "true" : undefined} className="gp-segmented-item">
          {tr("看板")}
        </Link>
        <Link href={viewHref("list")} aria-current={view === "list" ? "page" : undefined} data-active={view === "list" ? "true" : undefined} className="gp-segmented-item">
          {tr("列表")}
        </Link>
        <Link href={`/projects/${projectId}/tasks?view=plan`} className="gp-segmented-item">
          {tr("规划")}
        </Link>
      </nav>
      {page.data && <span className="text-xs text-slate-400">{tr("共 {0} 个任务", { 0: page.data.total })}</span>}
    </div>

    <div className={`${cardClass} px-3 py-2`}>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ q: q.trim() || null, page: null });
        }}
      >
        <label className="sr-only" htmlFor="tasks-q">{tr("搜索")}</label>
        <input id="tasks-q" className={`${filterInput} min-w-[160px] flex-1`} placeholder={tr("名称、说明或编号 T-001")} value={q} onChange={(e) => setQ(e.target.value)} />

        <label className="sr-only" htmlFor="tasks-status">{tr("状态")}</label>
        <select id="tasks-status" className={`${filterInput} w-26`} value={filters.status} onChange={(e) => setFilters({ status: e.target.value || null, page: null })}>
          <option value="">{tr("全部状态")}</option>
          {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}
        </select>

        <label className="sr-only" htmlFor="tasks-assignee">{tr("负责人")}</label>
        <select id="tasks-assignee" className={`${filterInput} w-28`} value={filters.assignee} onChange={(e) => setFilters({ assignee: e.target.value || null, page: null })}>
          <option value="">{tr("全部负责人")}</option>
          <option value="me">{tr("我")}</option>
          <option value="none">{tr("未分配")}</option>
          {page.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name ?? tr("组员")}</option>)}
        </select>

        <label className="sr-only" htmlFor="tasks-module">{tr("模块")}</label>
        <select id="tasks-module" className={`${filterInput} w-28`} value={filters.module} onChange={(e) => setFilters({ module: e.target.value || null, page: null })}>
          <option value="">{tr("全部模块")}</option>
          {page.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        <label className="sr-only" htmlFor="tasks-milestone">{tr("里程碑")}</label>
        <select id="tasks-milestone" className={`${filterInput} w-28`} value={filters.milestone} onChange={(e) => setFilters({ milestone: e.target.value || null, page: null })}>
          <option value="">{tr("全部里程碑")}</option>
          {page.data?.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        {view === "list" && (
          <>
            <label className="sr-only" htmlFor="tasks-sort">{tr("排序")}</label>
            <select id="tasks-sort" className={`${filterInput} w-28`} value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value, page: null })}>
              <option value="code">{tr("按编号")}</option>
              <option value="priority">{tr("按优先级")}</option>
              <option value="-weight">{tr("权重从高到低")}</option>
              <option value="-progress">{tr("进度从高到低")}</option>
              <option value="status">{tr("按状态")}</option>
              <option value="-updated">{tr("最近更新")}</option>
            </select>
          </>
        )}

        <button type="submit" className={compactBtn}><Search size={13} />{tr("查询")}</button>
        <button type="button" className={compactSecondary} onClick={clearFilters}>{tr("清空")}</button>
      </form>
    </div>

    {notice && (
      <div data-testid="tasks-notice" className="relative">
        <Feedback tone={notice.tone}>
          <div className="flex items-center justify-between gap-3">
            <span>{notice.text}</span>
            <button type="button" className="shrink-0 text-xs opacity-70 hover:opacity-100" onClick={() => setNotice(undefined)}>{tr("收起")}</button>
          </div>
        </Feedback>
      </div>
    )}

    {pending && (
      <div role="dialog" aria-modal="true" aria-label={tr("确认修改状态")}>
        <Panel title={tr("确认修改状态")}>
          <p className="text-sm text-slate-700">
            {tr("把 {0} {1} 从“{2}”改为“{3}”？{4}", {
              0: pending.row.code ?? "",
              1: pending.row.title,
              2: tr(statusLabel[pending.row.status]),
              3: tr(statusLabel[pending.transition.to]),
              4: pending.transition.kind === "page" ? tr("将打开提交页面完成这一步。") : "",
            })}
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => void run()}>{tr("确认")}</button>
            <button type="button" className={secondary} onClick={() => setPending(undefined)}>{tr("取消")}</button>
          </div>
        </Panel>
      </div>
    )}

    <div>
      {page.isPending ? (
        <div role="status" className="gp-empty">{tr("正在加载任务…")}</div>
      ) : page.isError ? (
        <div role="alert"><Feedback tone="error">{errorText(page.error)}</Feedback></div>
      ) : page.data.plan_status !== "frozen" && page.data.items.length === 0 ? (
        <div className={`${cardClass} p-6`}>
          <EmptyState
            title={tr("还没有任务")}
            description={tr("先在分工与规划里拆分任务。")}
            action={<Link className={button} href={`/projects/${projectId}/tasks?view=plan`}>{tr("去分工与规划")}</Link>}
          />
        </div>
      ) : view === "board" ? (
        <BoardView page={page.data} onMove={(row, transition) => setPending({ row, transition })} />
      ) : (
        <UnifiedTaskTable
          mode={view === "tree" ? "tree" : "list"}
          rows={page.data.items}
          total={page.data.total}
          pageSize={page.data.page_size}
          current={filters.page}
          issues={page.data.integrity_issues}
          collapsed={filters.collapsed}
          onCollapsed={(next) => setFilters({ collapsed: next })}
          onPage={(next) => setFilters({ page: next })}
          userId={userId}
          isLeader={isLeader}
          confirmingTaskId={confirmingTaskId}
          confirmingAll={confirmingAll}
          onConfirmAiTask={(row) => void confirmAiTask(row)}
        />
      )}
    </div>
  </div>;
}

function Assignees({ row, withAvatar = false }: { row: BTaskRow; withAvatar?: boolean }) {
  const tr = useUiText();
  if (row.assignees.length === 0) return <span className="text-amber-700">{tr("未分配")}</span>;
  const first = row.assignees[0].name ?? tr("组员");
  const names = row.assignees.map((a) => a.name ?? tr("组员")).join("、");
  return <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
    {withAvatar && <Avatar name={first} size={18} />}
    <span className="truncate">{names}</span>
  </span>;
}

function CriteriaPill({ row }: { row: BTaskRow }) {
  const tr = useUiText();
  const total = row.criteria_total ?? 0;
  const evidenced = row.criteria_evidenced ?? 0;
  const confirmed = row.criteria_confirmed ?? 0;
  const candidate = Math.max(0, evidenced - confirmed);
  if (total === 0) return <Link href={`${row.links.detail}?tab=criteria`} className="text-[11px] text-slate-400 hover:underline">{tr("未设标准")}</Link>;
  const allConfirmed = confirmed >= total;
  const allAiPassed = !allConfirmed && evidenced >= total && candidate > 0;
  const tone = allConfirmed
    ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
    : allAiPassed
      ? "bg-teal-50 text-teal-700 hover:bg-teal-100"
      : candidate > 0
        ? "bg-sky-50 text-sky-700 hover:bg-sky-100"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200";
  const labelText = allConfirmed
    ? tr("{0}/{1} 已确认", { 0: confirmed, 1: total })
    : allAiPassed
      ? tr("AI 通过 · {0}/{1} 候选证据", { 0: candidate, 1: total })
      : candidate > 0
        ? tr("AI 部分通过 · {0}/{1} 候选证据", { 0: candidate, 1: total })
        : tr("{0}/{1} 待提交", { 0: confirmed, 1: total });
  const detailText = allConfirmed
    ? tr("全部交付标准已有正式证据，仍需完成验收。")
    : allAiPassed
      ? tr("AI 已核验全部 {0}/{1} 条标准达标（候选证据待人工一键确认）。", { 0: evidenced, 1: total })
      : candidate > 0 && confirmed > 0
        ? tr("{0}/{1} 条候选证据待确认，{2}/{1} 条已确认。", { 0: candidate, 1: total, 2: confirmed })
        : candidate > 0
          ? tr("AI 已核验部分标准达标，候选代码证据需人工确认并补充其余标准。")
          : tr("尚无与交付标准关联的有效证据。点击查看。");
  return <Link href={allConfirmed ? `${row.links.detail}?tab=criteria` : row.links.submit} title={detailText} aria-label={detailText} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${tone}`}>
    {(allConfirmed || allAiPassed) && <CheckCircle2 size={11} />}
    {labelText}
  </Link>;
}

function progressMeta(row: BTaskRow): { label: string; detail: string; tone: string } {
  const total = row.criteria_total ?? 0;
  const evidenced = row.criteria_evidenced ?? 0;
  const confirmed = row.criteria_confirmed ?? 0;
  const candidate = Math.max(0, evidenced - confirmed);
  if (row.status === "completed") return { label: "已完成", detail: "正式验收已完成", tone: "text-emerald-700" };
  if (total > 0 && evidenced >= total && candidate > 0) return { label: "AI 验收通过（候选证据）", detail: `${candidate}/${total} 条待人工确认`, tone: "text-emerald-700" };
  if (candidate > 0) return { label: "AI 部分通过（候选证据）", detail: `已通过 ${evidenced}/${total} · 缺 ${Math.max(0, total - evidenced)} 条`, tone: "text-sky-700" };
  if (confirmed > 0) return { label: "正式证据", detail: `${confirmed}/${total} 条已确认，等待验收`, tone: "text-amber-700" };
  if (row.progress_percent > 0) return { label: "手动进度", detail: "尚未关联交付证据", tone: "text-slate-600" };
  return { label: "未开始", detail: "尚无实现进度", tone: "text-slate-400" };
}

function ProgressCell({ row }: { row: BTaskRow }) {
  const tr = useUiText();
  const meta = progressMeta(row);
  const progress = Math.max(0, Math.min(100, row.progress_percent));
  return <div className="min-w-[116px]" data-testid="task-progress" title={tr("{0}：{1}", { 0: meta.label, 1: meta.detail })}>
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 rounded-full bg-slate-100" role="progressbar" aria-label={tr("任务进度 {0}%", { 0: progress })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <div className={`h-1.5 rounded-full ${row.status === "completed" ? "bg-emerald-600" : "bg-[var(--gp-action)]"}`} style={{ width: `${progress}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums text-slate-800">{progress}%</span>
    </div>
    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] leading-tight">
      <span className={`font-medium ${meta.tone}`}>{tr(meta.label)}</span>
      <span className="text-slate-400">· {tr(meta.detail)}</span>
    </div>
  </div>;
}

type BTasksPageIssue = { code: string; message: string; task_id: string | null; task_ids: string[] };

function UnifiedTaskTable({
  mode, rows, total, pageSize, current, issues, collapsed, onCollapsed, onPage, userId, isLeader, confirmingTaskId, confirmingAll, onConfirmAiTask,
}: {
  mode: "tree" | "list";
  rows: BTaskRow[];
  total: number;
  pageSize: number;
  current: number;
  issues: BTasksPageIssue[];
  collapsed: string[];
  onCollapsed: (next: string[]) => void;
  onPage: (page: number) => void;
  userId: string;
  isLeader: boolean;
  confirmingTaskId: string | null;
  confirmingAll: boolean;
  onConfirmAiTask: (row: BTaskRow) => void;
}) {
  const tr = useUiText();
  const [issuesOpen, setIssuesOpen] = useState(true);
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, BTaskRow[]>();
  for (const r of rows) if (r.parent_task_id && ids.has(r.parent_task_id)) children.set(r.parent_task_id, [...(children.get(r.parent_task_id) ?? []), r]);
  const hasAnyHierarchy = children.size > 0;
  const flagged = new Set(issues.flatMap((i) => [i.task_id, ...i.task_ids]).filter(Boolean) as string[]);

  const ordered: { row: BTaskRow; depth: number; hasChildren: boolean }[] = [];
  if (mode === "tree") {
    const seen = new Set<string>();
    const visit = (r: BTaskRow, depth: number, visible: boolean) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      const kids = children.get(r.id) ?? [];
      if (visible) ordered.push({ row: r, depth, hasChildren: kids.length > 0 });
      for (const k of kids) visit(k, depth + 1, visible && !collapsed.includes(r.id));
    };
    for (const r of rows) if (!r.parent_task_id || !ids.has(r.parent_task_id)) visit(r, 0, true);
    for (const r of rows) visit(r, 0, true);
  } else {
    for (const r of rows) ordered.push({ row: r, depth: 0, hasChildren: false });
  }

  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const testId = mode === "tree" ? "tree-row" : "list-row";

  return <div className="space-y-3">
    {issues.length > 0 && (
      <div data-testid="tree-issues" className="rounded-xl border border-amber-200/90 bg-amber-50/80 px-3.5 py-2 text-xs text-amber-900">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={13} className="shrink-0 text-amber-600" />
            <span>{tr("任务数据有 {0} 处问题（只读诊断，未自动修改）", { 0: issues.length })}</span>
          </div>
          <button type="button" className="text-[11px] font-medium text-amber-800 hover:underline" onClick={() => setIssuesOpen((v) => !v)}>
            {issuesOpen ? tr("收起") : tr("展开详情")}
          </button>
        </div>
        {issuesOpen && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-amber-800">
            {issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}
          </ul>
        )}
      </div>
    )}

    {ordered.length === 0 ? (
      <div className={`${cardClass} p-6`}><EmptyState title={tr("没有符合条件的任务")} /></div>
    ) : (
      <section className={`${cardClass} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
              <tr>
                <th className="whitespace-nowrap px-3.5 py-2">{tr("编号")}</th>
                <th className="px-3 py-2">{tr("任务")}</th>
                <th className="whitespace-nowrap px-2.5 py-2">{tr("模块")}</th>
                <th className="whitespace-nowrap px-2.5 py-2">{tr("负责人")}</th>
                <th className="whitespace-nowrap px-2.5 py-2">{tr("交付标准")}</th>
                <th className="whitespace-nowrap px-2.5 py-2">{tr("权重")}</th>
                <th className="whitespace-nowrap px-2.5 py-2">{tr("状态")}</th>
                <th className="whitespace-nowrap px-2.5 py-2">{tr("进度")}</th>
                <th className="whitespace-nowrap px-3.5 py-2 text-right">{tr("操作")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ordered.map(({ row, depth, hasChildren }) => (
                <tr key={row.id} data-testid={testId} className={row.matched ? "transition-colors hover:bg-slate-50/80" : "text-slate-400"}>
                  <td className="whitespace-nowrap px-3.5 py-2 font-mono text-xs text-slate-500">{row.code ?? "—"}</td>
                  <td className="px-3 py-2" style={hasAnyHierarchy ? { paddingLeft: 12 + depth * 20 } : undefined}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {hasAnyHierarchy && (hasChildren
                        ? <button type="button" aria-label={collapsed.includes(row.id) ? tr("展开 {0}", { 0: row.code ?? row.title }) : tr("收起 {0}", { 0: row.code ?? row.title })} className="text-slate-400 hover:text-slate-700" onClick={() => onCollapsed(collapsed.includes(row.id) ? collapsed.filter((x) => x !== row.id) : [...collapsed, row.id])}>{collapsed.includes(row.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
                        : <span className="inline-block w-[13px]" />)}
                      <Link className="font-medium text-slate-900 hover:text-sky-700 hover:underline" href={row.links.detail}>{row.title}</Link>
                      {(row.evidence_count ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                          <GitCommitHorizontal size={10} />{tr("{0} 证据", { 0: row.evidence_count ?? 0 })}
                        </span>
                      )}
                      {flagged.has(row.id) && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{tr("数据有问题")}</span>}
                    </div>
                  </td>
                  <td className="max-w-[130px] truncate whitespace-nowrap px-2.5 py-2 text-slate-600" title={row.module.name}>{row.module.name}</td>
                  <td className="whitespace-nowrap px-2.5 py-2 text-slate-600"><Assignees row={row} withAvatar /></td>
                  <td className="px-2.5 py-2"><CriteriaPill row={row} /></td>
                  <td className="whitespace-nowrap px-2.5 py-2 text-slate-600">{row.weight}<span className="ml-1 text-[10px] text-slate-400">· {tr(priorityLabel[row.priority]) ?? row.priority}</span></td>
                  <td className="whitespace-nowrap px-2.5 py-2"><StatusBadge tone={row.status === "completed" ? "green" : row.status === "not_started" ? "gray" : "blue"} label={tr(statusLabel[row.status]) ?? row.status} /></td>
                  <td className="whitespace-nowrap px-2.5 py-2"><ProgressCell row={row} /></td>
                  <td className="space-x-2 whitespace-nowrap px-3.5 py-2 text-right text-xs">
                    {row.status !== "completed"
                      && (row.criteria_total ?? 0) > 0
                      && (row.criteria_evidenced ?? 0) >= (row.criteria_total ?? 0)
                      && (isLeader || row.assignees.some((a) => a.id === userId)) && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                          disabled={confirmingTaskId !== null || confirmingAll}
                          onClick={() => onConfirmAiTask(row)}
                        >
                          {confirmingTaskId === row.id ? tr("确认中…") : tr("一键确认完成")}
                        </button>
                    )}
                    {row.status === "not_started" && <Link className="font-medium text-sky-700 hover:underline" href={row.links.detail}>{tr("开始任务")}</Link>}
                    {["in_progress", "pending_submission"].includes(row.status) && <Link className="font-medium text-sky-700 hover:underline" href={row.links.submit}>{tr("提交验收")}</Link>}
                    {["pending_verification", "completed"].includes(row.status) && <Link className="font-medium text-sky-700 hover:underline" href={row.links.verification}>{tr("查看验收")}</Link>}
                    <Link className="text-slate-600 hover:text-sky-700 hover:underline" href={row.links.evidence}>{tr("查看证据")}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mode === "list" && (
          <div className="flex items-center justify-between border-t border-slate-100 bg-white px-3.5 py-2 text-xs text-slate-500">
            <span>{tr("共 {0} 个 · 第 {1} / {2} 页", { 0: total, 1: current, 2: pages })}</span>
            <span className="flex gap-1.5">
              <button type="button" className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-45" disabled={current <= 1} onClick={() => onPage(current - 1)}>{tr("上一页")}</button>
              <button type="button" className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-45" disabled={current >= pages} onClick={() => onPage(current + 1)}>{tr("下一页")}</button>
            </span>
          </div>
        )}
      </section>
    )}
  </div>;
}

const statusDot: Record<string, string> = {
  not_started: "bg-slate-400",
  in_progress: "bg-sky-500",
  pending_submission: "bg-indigo-500",
  pending_verification: "bg-amber-500",
  completed: "bg-emerald-500",
};
const WORKFLOW_LOCKED_STATUSES = new Set(["pending_submission", "pending_verification", "completed"]);

function BoardView({ page, onMove }: { page: { items: BTaskRow[]; columns: { status: string; label: string; count: number }[] }; onMove: (row: BTaskRow, transition: BTransition) => void }) {
  const tr = useUiText();
  const [dragged, setDragged] = useState<BTaskRow>();
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);
  const [expandedEmpty, setExpandedEmpty] = useState<string[]>([]);

  const target = (status: string) => dragged?.transitions.find((t) => t.to === status);
  const hasNonEmpty = page.columns.some((col) => col.count > 0);
  const toggleEmpty = (status: string) =>
    setExpandedEmpty((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));

  return (
    <div className="flex flex-col gap-3 overflow-x-auto pb-1 lg:flex-row lg:items-start">
      {page.columns.map((col) => {
        const colRows = page.items.filter((r) => r.status === col.status);
        const isEmpty = col.count === 0 && colRows.length === 0;
        const isCollapsed = hasNonEmpty && isEmpty && !expandedEmpty.includes(col.status);
        const canDrop = Boolean(dragged && target(col.status));
        const isOver = canDrop && dragOverStatus === col.status;
        const columnLockedReason =
          colRows.length > 0 &&
          WORKFLOW_LOCKED_STATUSES.has(col.status) &&
          colRows.every((r) => r.blocked_reason && r.blocked_reason === colRows[0].blocked_reason && r.transitions.length === 0)
            ? colRows[0].blocked_reason
            : null;
        const dotClass = statusDot[col.status] ?? "bg-slate-400";

        const dropHandlers = {
          onDragOver: (e: DragEvent) => {
            if (target(col.status)) {
              e.preventDefault();
              if (dragOverStatus !== col.status) setDragOverStatus(col.status);
            }
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dragOverStatus === col.status) {
              setDragOverStatus(null);
            }
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            const t = target(col.status);
            if (dragged && t) onMove(dragged, t);
            setDragged(undefined);
            setDragOverStatus(null);
          },
        };

        if (isCollapsed) {
          return (
            <section
              key={col.status}
              aria-label={col.label}
              data-testid={`column-${col.status}`}
              data-collapsed="true"
              className={`rounded-2xl border p-2 transition-colors lg:flex lg:min-h-[280px] lg:w-[88px] lg:shrink-0 lg:flex-col ${
                isOver
                  ? "border-sky-500 bg-sky-50/80 ring-2 ring-sky-400/30"
                  : canDrop
                    ? "border-sky-400 bg-sky-50/45"
                    : "border-slate-200/80 bg-slate-50/70"
              }`}
              {...dropHandlers}
            >
              <h2 className="flex items-center justify-between gap-1.5 px-1 py-0.5 text-xs font-semibold text-slate-600 lg:flex-col lg:items-center lg:gap-1.5 lg:px-0 lg:pt-1">
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
                  <span>{col.label}</span>
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-400 shadow-2xs ring-1 ring-slate-200/70">
                  {col.count}
                </span>
              </h2>
              <button
                type="button"
                onClick={() => toggleEmpty(col.status)}
                aria-label={tr("展开 {0}", { 0: col.label })}
                title={tr("展开 {0}", { 0: col.label })}
                className={`mt-1.5 flex w-full items-center justify-center gap-1 rounded-xl border border-dashed px-2 py-1.5 text-[11px] transition-colors lg:mt-2 lg:flex-1 lg:flex-col lg:px-1 lg:py-4 ${
                  isOver
                    ? "border-sky-400 bg-sky-100/60 text-sky-700"
                    : canDrop
                      ? "border-sky-300 bg-sky-50/70 text-sky-600"
                      : "border-slate-200/90 bg-white/50 text-slate-400 hover:border-slate-300 hover:bg-white hover:text-slate-600"
                }`}
              >
                <ChevronRight size={14} className="shrink-0" />
                <span className="lg:sr-only">{tr("暂无任务")}</span>
              </button>
            </section>
          );
        }

        const widthClass = !hasNonEmpty
          ? "lg:flex-1 lg:min-w-[190px]"
          : isEmpty
            ? "lg:w-[220px] lg:shrink-0 lg:min-h-[280px]"
            : "lg:flex-1 lg:min-w-[260px] lg:max-h-[calc(100vh-270px)]";

        return (
          <section
            key={col.status}
            aria-label={col.label}
            data-testid={`column-${col.status}`}
            data-collapsed="false"
            className={`flex min-h-40 flex-col rounded-2xl border p-3 transition-colors ${widthClass} ${
              isOver
                ? "border-sky-500 bg-sky-50/75 ring-2 ring-sky-400/30"
                : canDrop
                  ? "border-sky-400 bg-sky-50/40"
                  : "border-slate-200/80 bg-slate-50/75"
            }`}
            {...dropHandlers}
          >
            <div className="mb-2.5 shrink-0 px-0.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
                  <span>{col.label}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 shadow-2xs ring-1 ring-slate-200/70">
                    {col.count}
                  </span>
                </h2>
                {hasNonEmpty && isEmpty && (
                  <button
                    type="button"
                    onClick={() => toggleEmpty(col.status)}
                    aria-label={tr("收起 {0}", { 0: col.label })}
                    title={tr("收起 {0}", { 0: col.label })}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-600"
                  >
                    <ChevronLeft size={14} />
                  </button>
                )}
              </div>
              {columnLockedReason && (
                <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-slate-400" title={columnLockedReason}>
                  <Lock size={10} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{columnLockedReason}</span>
                </p>
              )}
            </div>

            {colRows.length === 0 ? (
              <div
                className={`flex min-h-24 flex-1 items-center justify-center rounded-xl border border-dashed px-3 py-6 text-center text-xs ${
                  isOver
                    ? "border-sky-400 bg-sky-100/50 text-sky-700"
                    : canDrop
                      ? "border-sky-300 bg-sky-50/50 text-sky-600"
                      : "border-slate-200/90 bg-white/50 text-slate-400"
                }`}
              >
                {tr("暂无任务")}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
                  {colRows.map((row) => {
                    const cardBlockedReason = row.blocked_reason && row.blocked_reason !== columnLockedReason ? row.blocked_reason : null;
                    const movable = row.transitions.length > 0;
                    const allConfirmed = (row.criteria_total ?? 0) > 0 && (row.criteria_confirmed ?? 0) >= (row.criteria_total ?? 0);
                    return (
                      <article
                        key={row.id}
                        data-testid="board-card"
                        draggable={movable}
                        data-movable={movable ? "true" : "false"}
                        title={row.blocked_reason ?? tr("拖到下一列")}
                        onDragStart={() => setDragged(row)}
                        onDragEnd={() => {
                          setDragged(undefined);
                          setDragOverStatus(null);
                        }}
                        className={`flex flex-col justify-between rounded-xl border border-slate-200/85 bg-white p-3 text-xs shadow-2xs transition-all hover:border-slate-300 hover:shadow-sm ${
                          movable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="font-mono text-[11px] font-medium text-slate-400">{row.code}</span>
                            <div className="flex items-center gap-1.5">
                              {(row.evidence_count ?? 0) > 0 && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                                  <GitCommitHorizontal size={10} />
                                  {row.evidence_count}
                                </span>
                              )}
                              {(row.criteria_total ?? 0) > 0 && (
                                <span
                                  className={`inline-flex items-center gap-0.5 text-[10px] tabular-nums ${
                                    allConfirmed ? "font-medium text-emerald-600" : "text-slate-400"
                                  }`}
                                >
                                  {allConfirmed && <CheckCircle2 size={10} />}
                                  {row.criteria_confirmed ?? 0}/{row.criteria_total}
                                </span>
                              )}
                            </div>
                          </div>
                          <Link
                            className="mt-1 line-clamp-2 block text-[13px] font-semibold leading-snug text-slate-900 hover:text-sky-700 hover:underline"
                            draggable={false}
                            href={row.links.detail}
                            title={row.title}
                          >
                            {row.title}
                          </Link>
                        </div>

                        <div className="mt-2.5">
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <div className="min-w-0 flex-1">
                              <Assignees row={row} withAvatar />
                            </div>
                            <span className="shrink-0 font-semibold tabular-nums text-slate-700">{row.progress_percent}%</span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-1.5 rounded-full transition-all ${row.status === "completed" ? "bg-emerald-600" : "bg-[var(--gp-action)]"}`}
                              style={{ width: `${Math.max(0, Math.min(100, row.progress_percent))}%` }}
                            />
                          </div>
                          {cardBlockedReason && (
                            <div className="mt-2 rounded-md bg-amber-50/85 px-2 py-1 text-[11px] leading-snug text-amber-800">
                              {cardBlockedReason}
                            </div>
                          )}
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-100 pt-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {row.transitions.length > 0 ? (
                                row.transitions.map((t) => (
                                  <button
                                    key={t.to}
                                    type="button"
                                    className="text-[11px] font-medium text-sky-700 hover:underline"
                                    onClick={() => onMove(row, t)}
                                  >
                                    {tr("移到“{0}”", { 0: tr(statusLabel[t.to]) })}
                                  </button>
                                ))
                              ) : ["pending_verification", "completed"].includes(row.status) ? (
                                <Link
                                  className="text-[11px] font-medium text-slate-500 hover:text-sky-700 hover:underline"
                                  draggable={false}
                                  href={row.links.verification}
                                >
                                  {tr("查看验收")}
                                </Link>
                              ) : row.status === "pending_submission" ? (
                                <Link
                                  className="text-[11px] font-medium text-sky-700 hover:underline"
                                  draggable={false}
                                  href={row.links.submit}
                                >
                                  {tr("提交验收")}
                                </Link>
                              ) : (
                                <Link
                                  className="text-[11px] text-slate-400 hover:text-sky-700 hover:underline"
                                  draggable={false}
                                  href={row.links.detail}
                                >
                                  {tr("详情")}
                                </Link>
                              )}
                            </div>
                            <Link className="text-[11px] text-slate-400 hover:text-sky-700 hover:underline" draggable={false} href={row.links.evidence}>
                              {tr("证据")}
                            </Link>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
