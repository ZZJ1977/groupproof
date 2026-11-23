"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, GitCommitHorizontal, RefreshCw, Search } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { CApiError, createCClient } from "@/lib/api/c-client";
import { bTasksApi, type BTaskRow, type BTaskView, type BTransition } from "@/lib/api/b-tasks";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { useUiText } from "@/lib/i18n/use-ui-text";

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
const titles: Record<BTaskView, [string, string]> = {
  tree: ["任务列表", "按交付标准与真实代码证据追踪进度；支持父子层级展开、筛选及一键进入验收与证据核对。"],
  board: ["任务看板", "按状态分列。拖动卡片会先确认，再交给任务执行接口处理。"],
  list: ["任务列表", "按交付标准与真实代码证据追踪进度；支持父子层级展开、筛选及一键进入验收与证据核对。"],
};

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
    view, q: filters.q || undefined, status: filters.status || undefined, assignee: filters.assignee || undefined,
    module: filters.module || undefined, milestone: filters.milestone || undefined,
    sort: view === "list" ? filters.sort : undefined, page: view === "list" ? filters.page : undefined, page_size: view === "list" ? PAGE_SIZE : undefined,
  };
  const page = useQuery({ queryKey: ["b-tasks", userId, projectId, query], queryFn: () => bTasksApi.list(projectId, query), ...queryPolicy });
  const invalidateAll = () => {
    for (const name of ["b-tasks", "b-milestones", "b-plan", "c-evidence", "c-task-evidence"]) {
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

  const [title, description] = titles[view];
  const items = page.data?.items ?? [];
  const rootItems = items.filter((r) => !r.parent_task_id);
  const weightSum = rootItems.reduce((s, r) => s + Math.max(1, r.weight), 0);
  const avgProgress = weightSum > 0 ? Math.round(rootItems.reduce((s, r) => s + r.progress_percent * Math.max(1, r.weight), 0) / weightSum) : 0;
  const totalCriteria = items.reduce((s, r) => s + (r.criteria_total ?? 0), 0);
  const confirmedCriteria = items.reduce((s, r) => s + (r.criteria_confirmed ?? 0), 0);
  const candidateCriteria = items.reduce((s, r) => s + Math.max(0, (r.criteria_evidenced ?? 0) - (r.criteria_confirmed ?? 0)), 0);
  const inProgressTasks = (page.data?.columns ?? []).filter((c) => ["in_progress", "pending_submission", "pending_verification"].includes(c.status)).reduce((s, c) => s + c.count, 0);
  const completedTasks = (page.data?.columns ?? []).find((c) => c.status === "completed")?.count ?? 0;
  const myAiPassedTasks = items.filter((r) =>
    r.status !== "completed"
    && (r.criteria_total ?? 0) > 0
    && (r.criteria_evidenced ?? 0) >= (r.criteria_total ?? 0)
    && r.assignees.some((a) => a.id === userId),
  );

  return <div>
    <PageHeader
      title={tr(title)}
      description={tr(description)}
      actions={<div className="flex flex-wrap items-center gap-2">
        {myAiPassedTasks.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-2xs transition hover:bg-emerald-700 disabled:opacity-50"
            disabled={confirmingAll || confirmingTaskId !== null}
            onClick={() => void confirmAllAiPassed(myAiPassedTasks)}
          >
            <CheckCircle2 size={14} />
            {confirmingAll
              ? tr("正在批量确认…")
              : tr("一键确认 AI 已通过任务 ({0})", { 0: myAiPassedTasks.length })}
          </button>
        )}
        <button type="button" className={secondary} disabled={syncCode.isPending} onClick={() => syncCode.mutate()}><RefreshCw size={14} className={syncCode.isPending ? "animate-spin" : ""} />{syncCode.isPending ? tr("正在关联代码证据…") : tr("同步代码证据")}</button>
      </div>}
    />
    {page.data && page.data.total > 0 && <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <div className="gp-surface-card flex items-baseline justify-between gap-2 py-2.5"><span className="text-xs text-slate-500">{tr("任务总数")}</span><span className="text-base font-bold text-slate-900">{page.data.total}<span className="ml-1 text-[11px] font-normal text-slate-400">({tr("完成 {0}", { 0: completedTasks })})</span></span></div>
      <div className="gp-surface-card flex items-baseline justify-between gap-2 py-2.5"><span className="text-xs text-slate-500">{tr("进行中")}</span><span className="text-base font-bold text-sky-700">{inProgressTasks}</span></div>
      <div className="gp-surface-card flex items-baseline justify-between gap-2 py-2.5"><span className="text-xs text-slate-500">{tr("交付标准")}</span><span className="text-right text-base font-bold text-slate-900">{totalCriteria > 0 ? <><span className="block">{tr("候选 {0}/{1}", { 0: candidateCriteria, 1: totalCriteria })}</span><span className="block text-[11px] font-normal text-emerald-700">{tr("正式 {0}/{1}", { 0: confirmedCriteria, 1: totalCriteria })}</span></> : <span>—</span>}<span className="block text-[10px] font-normal text-slate-400">{totalCriteria > 0 ? tr("候选证据需人工确认") : tr("尚未设置")}</span></span></div>
      <div className="gp-surface-card flex items-center justify-between gap-3 py-2.5"><span className="text-xs text-slate-500">{tr("加权进度")}</span><div className="flex flex-1 items-center justify-end gap-2"><div className="h-1.5 max-w-20 flex-1 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-[var(--gp-action)]" style={{ width: `${avgProgress}%` }} /></div><span className="text-base font-bold text-slate-900">{avgProgress}%</span></div></div>
    </div>}
    <nav aria-label={tr("任务视图")} className="gp-segmented mt-3">
      <Link href={viewHref("list")} aria-current={view !== "board" ? "page" : undefined} data-active={view !== "board" ? "true" : undefined} className="gp-segmented-item">
        {tr("任务列表")}
      </Link>
      <Link href={viewHref("board")} aria-current={view === "board" ? "page" : undefined} data-active={view === "board" ? "true" : undefined} className="gp-segmented-item">
        {tr("看板")}
      </Link>
      <Link href={`/projects/${projectId}/tasks?view=plan`} className="gp-segmented-item">
        {tr("分工与规划")}
      </Link>
    </nav>
    <Panel className="mt-3">
      <form className={`grid grid-cols-2 gap-2 ${view === "list" ? "md:grid-cols-[minmax(140px,1.4fr)_repeat(5,minmax(0,1fr))_auto]" : "md:grid-cols-[minmax(160px,1.5fr)_repeat(4,minmax(0,1fr))_auto]"}`} onSubmit={(e) => { e.preventDefault(); setFilters({ q: q.trim() || null, page: null }); }}>
        <div className="col-span-2 md:col-span-1"><label className={label} htmlFor="tasks-q">{tr("搜索")}</label><input id="tasks-q" className={input} placeholder={tr("名称、说明或编号 T-001")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div><label className={label} htmlFor="tasks-status">{tr("状态")}</label><select id="tasks-status" className={input} value={filters.status} onChange={(e) => setFilters({ status: e.target.value || null, page: null })}><option value="">{tr("全部")}</option>{Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}</select></div>
        <div><label className={label} htmlFor="tasks-assignee">{tr("负责人")}</label><select id="tasks-assignee" className={input} value={filters.assignee} onChange={(e) => setFilters({ assignee: e.target.value || null, page: null })}><option value="">{tr("全部")}</option><option value="me">{tr("我")}</option><option value="none">{tr("未分配")}</option>{page.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name ?? tr("组员")}</option>)}</select></div>
        <div><label className={label} htmlFor="tasks-module">{tr("模块")}</label><select id="tasks-module" className={input} value={filters.module} onChange={(e) => setFilters({ module: e.target.value || null, page: null })}><option value="">{tr("全部")}</option>{page.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        <div><label className={label} htmlFor="tasks-milestone">{tr("里程碑")}</label><select id="tasks-milestone" className={input} value={filters.milestone} onChange={(e) => setFilters({ milestone: e.target.value || null, page: null })}><option value="">{tr("全部")}</option>{page.data?.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        {view === "list" && <div><label className={label} htmlFor="tasks-sort">{tr("排序")}</label><select id="tasks-sort" className={input} value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value, page: null })}>
          <option value="code">{tr("编号")}</option><option value="priority">{tr("优先级")}</option><option value="-weight">{tr("权重从高到低")}</option><option value="-progress">{tr("进度从高到低")}</option><option value="status">{tr("状态")}</option><option value="-updated">{tr("最近更新")}</option>
        </select></div>}
        <div className="col-span-2 flex items-end gap-2 md:col-span-1"><button type="submit" className={button}><Search size={14} />{tr("查询")}</button><button type="button" className={secondary} onClick={clearFilters}>{tr("清空")}</button></div>
      </form>
    </Panel>
    {notice && <div className="mt-3" data-testid="tasks-notice"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
    {pending && <div role="dialog" aria-modal="true" aria-label={tr("确认修改状态")} className="mt-3"><Panel title={tr("确认修改状态")}>
      <p className="text-sm text-slate-700">{tr("把 {0} {1} 从“{2}”改为“{3}”？{4}", { 0: pending.row.code ?? "", 1: pending.row.title, 2: tr(statusLabel[pending.row.status]), 3: tr(statusLabel[pending.transition.to]), 4: pending.transition.kind === "page" ? tr("将打开提交页面完成这一步。") : "" })}</p>
      <div className="mt-3 flex gap-2"><button type="button" className={button} disabled={busy} onClick={() => void run()}>{tr("确认")}</button><button type="button" className={secondary} onClick={() => setPending(undefined)}>{tr("取消")}</button></div>
    </Panel></div>}
    <div className="mt-3">
      {page.isPending ? <div role="status" className="gp-empty">{tr("正在加载任务…")}</div>
        : page.isError ? <div role="alert"><Feedback tone="error">{errorText(page.error)}</Feedback></div>
        : page.data.plan_status !== "frozen" && page.data.items.length === 0 ? <Panel><EmptyState title={tr("还没有任务")} description={tr("先在分工与规划里拆分任务。")} action={<Link className={button} href={`/projects/${projectId}/tasks?view=plan`}>{tr("去分工与规划")}</Link>} /></Panel>
        : view === "board" ? <BoardView page={page.data} onMove={(row, transition) => setPending({ row, transition })} />
        : <UnifiedTaskTable
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
            confirmingTaskId={confirmingTaskId}
            confirmingAll={confirmingAll}
            onConfirmAiTask={(row) => void confirmAiTask(row)}
          />}
    </div>
  </div>;
}

function Assignees({ row }: { row: BTaskRow }) {
  const tr = useUiText();
  return <>{row.assignees.map((a) => a.name ?? tr("组员")).join("、") || <span className="text-amber-700">{tr("未分配")}</span>}</>;
}

function CriteriaPill({ row }: { row: BTaskRow }) {
  const tr = useUiText();
  const total = row.criteria_total ?? 0;
  const evidenced = row.criteria_evidenced ?? 0;
  const confirmed = row.criteria_confirmed ?? 0;
  const candidate = Math.max(0, evidenced - confirmed);
  if (total === 0) return <Link href={`${row.links.detail}?tab=criteria`} className="text-xs text-slate-400 hover:underline">{tr("未设标准")}</Link>;
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
  return <div className="min-w-[112px]" data-testid="task-progress" title={tr("{0}：{1}", { 0: meta.label, 1: meta.detail })}>
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 rounded-full bg-slate-100" role="progressbar" aria-label={tr("任务进度 {0}%", { 0: progress })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div className={`h-1.5 rounded-full ${row.status === "completed" ? "bg-emerald-600" : "bg-[var(--gp-action)]"}`} style={{ width: `${progress}%` }} /></div>
      <span className="text-xs font-medium tabular-nums">{progress}%</span>
    </div>
    <span className={`mt-1 block text-[10px] font-medium ${meta.tone}`}>{tr(meta.label)}</span>
    <span className="block text-[10px] text-slate-400">{tr(meta.detail)}</span>
  </div>;
}

type BTasksPageIssue = { code: string; message: string; task_id: string | null; task_ids: string[] };

function UnifiedTaskTable({
  mode, rows, total, pageSize, current, issues, collapsed, onCollapsed, onPage, userId, confirmingTaskId, confirmingAll, onConfirmAiTask,
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
  confirmingTaskId: string | null;
  confirmingAll: boolean;
  onConfirmAiTask: (row: BTaskRow) => void;
}) {
  const tr = useUiText();
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
    {issues.length > 0 && <div data-testid="tree-issues"><Feedback tone="warning"><div className="flex items-center gap-1 font-semibold"><AlertTriangle size={14} />{tr("任务数据有 {0} 处问题（只读诊断，未自动修改）", { 0: issues.length })}</div><ul className="mt-1 list-disc pl-5">{issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}</ul></Feedback></div>}
    {ordered.length === 0 ? <Panel><EmptyState title={tr("没有符合条件的任务")} /></Panel>
      : <Panel noPadding>
        <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-sm">
          <thead className="border-b border-slate-100 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2">{tr("编号")}</th>
              <th className="px-4 py-2">{tr("任务")}</th>
              <th className="px-3 py-2">{tr("模块")}</th>
              <th className="px-3 py-2">{tr("负责人")}</th>
              <th className="px-3 py-2">{tr("交付标准")}</th>
              <th className="px-3 py-2">{tr("权重")}</th>
              <th className="px-3 py-2">{tr("状态")}</th>
              <th className="px-3 py-2"><span className="block">{tr("进度")}</span><span className="font-normal text-[10px] text-slate-400">{tr("实现 / 验收")}</span></th>
              <th className="px-4 py-2">{tr("操作")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">{ordered.map(({ row, depth, hasChildren }) => <tr key={row.id} data-testid={testId} className={row.matched ? "hover:bg-slate-50/70" : "text-slate-400"}>
            <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">{row.code ?? "—"}</td>
            <td className="px-4 py-2.5" style={hasAnyHierarchy ? { paddingLeft: 12 + depth * 22 } : undefined}>
              {hasAnyHierarchy && (hasChildren
                ? <button type="button" aria-label={collapsed.includes(row.id) ? tr("展开 {0}", { 0: row.code ?? row.title }) : tr("收起 {0}", { 0: row.code ?? row.title })} className="mr-1 align-middle text-slate-500" onClick={() => onCollapsed(collapsed.includes(row.id) ? collapsed.filter((x) => x !== row.id) : [...collapsed, row.id])}>{collapsed.includes(row.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>
                : <span className="mr-1 inline-block w-[14px]" />)}
              <Link className="font-medium text-slate-900 hover:underline" href={row.links.detail}>{row.title}</Link>
              {(row.evidence_count ?? 0) > 0 && <span className="ml-2 inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700"><GitCommitHorizontal size={11} />{tr("{0} 证据", { 0: row.evidence_count ?? 0 })}</span>}
              {flagged.has(row.id) && <span className="ml-2 rounded bg-amber-50 px-1.5 text-xs text-amber-700">{tr("数据有问题")}</span>}
            </td>
            <td className="max-w-[160px] truncate px-3 py-2.5 text-xs text-slate-600" title={row.module.name}>{row.module.name}</td>
            <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-600"><Assignees row={row} /></td>
            <td className="px-3 py-2.5"><CriteriaPill row={row} /></td>
            <td className="px-3 py-2.5 text-xs text-slate-600">{row.weight}<span className="ml-1 text-[11px] text-slate-400">· {tr(priorityLabel[row.priority]) ?? row.priority}</span></td>
            <td className="whitespace-nowrap px-3 py-2.5"><StatusBadge tone={row.status === "completed" ? "green" : row.status === "not_started" ? "gray" : "blue"} label={tr(statusLabel[row.status]) ?? row.status} /></td>
            <td className="whitespace-nowrap px-3 py-2.5"><ProgressCell row={row} /></td>
            <td className="space-x-2 whitespace-nowrap px-4 py-2.5 text-xs">
              {row.status !== "completed"
                && (row.criteria_total ?? 0) > 0
                && (row.criteria_evidenced ?? 0) >= (row.criteria_total ?? 0)
                && row.assignees.some((a) => a.id === userId) && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    disabled={confirmingTaskId !== null || confirmingAll}
                    onClick={() => onConfirmAiTask(row)}
                  >
                    {confirmingTaskId === row.id ? tr("确认中…") : tr("一键确认完成")}
                  </button>
              )}
              {row.status === "not_started" && <Link className="text-blue-700 underline" href={row.links.detail}>{tr("开始任务")}</Link>}
              {["in_progress", "pending_submission"].includes(row.status) && <Link className="text-blue-700 underline" href={row.links.submit}>{tr("提交验收")}</Link>}
              {["pending_verification", "completed"].includes(row.status) && <Link className="text-blue-700 underline" href={row.links.verification}>{tr("查看验收")}</Link>}
              <Link className="text-blue-700 underline" href={row.links.evidence}>{tr("查看证据")}</Link>
            </td>
          </tr>)}</tbody>
        </table></div>
        {mode === "list" && <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          <span>{tr("共 {0} 个 · 第 {1} / {2} 页", { 0: total, 1: current, 2: pages })}</span>
          <span className="flex gap-2"><button type="button" className={secondary} disabled={current <= 1} onClick={() => onPage(current - 1)}>{tr("上一页")}</button><button type="button" className={secondary} disabled={current >= pages} onClick={() => onPage(current + 1)}>{tr("下一页")}</button></span>
        </div>}
      </Panel>}
  </div>;
}

function BoardView({ page, onMove }: { page: { items: BTaskRow[]; columns: { status: string; label: string; count: number }[] }; onMove: (row: BTaskRow, transition: BTransition) => void }) {
  const tr = useUiText();
  const [dragged, setDragged] = useState<BTaskRow>();
  const target = (status: string) => dragged?.transitions.find((t) => t.to === status);
  return <div className="grid gap-3.5 overflow-x-auto md:grid-cols-5">{page.columns.map((col) => <section key={col.status} aria-label={col.label} data-testid={`column-${col.status}`}
    className={`min-h-44 rounded-2xl border p-3 transition-colors ${dragged && target(col.status) ? "border-sky-400 bg-sky-50/40" : "border-slate-200/70 bg-slate-50/75"}`}
    onDragOver={(e) => { if (target(col.status)) e.preventDefault(); }}
    onDrop={(e) => { e.preventDefault(); const t = target(col.status); if (dragged && t) onMove(dragged, t); setDragged(undefined); }}>
    <h2 className="mb-2.5 flex items-center justify-between text-xs font-semibold text-slate-600"><span>{col.label}</span><span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-500 shadow-2xs">{col.count}</span></h2>
    <div className="space-y-2.5">{page.items.filter((r) => r.status === col.status).map((row) => <article key={row.id} data-testid="board-card" draggable={row.transitions.length > 0} data-movable={row.transitions.length > 0 ? "true" : "false"}
      title={row.blocked_reason ?? tr("拖到下一列")} onDragStart={() => setDragged(row)} onDragEnd={() => setDragged(undefined)}
      className={`rounded-xl border border-slate-200/80 bg-white p-3 text-sm shadow-2xs transition-shadow hover:shadow-sm ${row.transitions.length ? "cursor-grab" : "cursor-not-allowed opacity-90"}`}>
      <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs text-slate-500">{row.code}</span>{(row.criteria_total ?? 0) > 0 && <span className="text-[11px] text-slate-400">{row.criteria_confirmed ?? 0}/{row.criteria_total}</span>}</div>
      <Link className="font-medium text-slate-900 hover:underline" draggable={false} href={row.links.detail}>{row.title}</Link>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500"><span><Assignees row={row} /> · {row.progress_percent}% · {tr(progressMeta(row).label)}</span>{(row.evidence_count ?? 0) > 0 && <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-700"><GitCommitHorizontal size={11} />{row.evidence_count}</span>}</div>
      <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-[var(--gp-action)]" style={{ width: `${row.progress_percent}%` }} /></div>
      {row.blocked_reason && <div className="mt-1 text-xs text-slate-400">{row.blocked_reason}</div>}
      {row.transitions.map((t) => <button key={t.to} type="button" className="mt-1 text-xs text-blue-700 underline" onClick={() => onMove(row, t)}>{tr("移到“{0}”", { 0: tr(statusLabel[t.to]) })}</button>)}
    </article>)}</div>
  </section>)}</div>;
}
