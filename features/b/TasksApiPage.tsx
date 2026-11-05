"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Search } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { CApiError, createCClient } from "@/lib/api/c-client";
import { bTasksApi, type BTaskRow, type BTaskView, type BTransition } from "@/lib/api/b-tasks";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, input, label, queryPolicy, secondary } from "@/features/b/ui";

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
const viewLabel: Record<BTaskView, string> = { tree: "任务树", board: "看板", list: "列表" };
const titles: Record<BTaskView, [string, string]> = {
  tree: ["任务树", "按父子层级查看任务、负责人、权重和进度；数据有问题时会明确标出。"],
  board: ["任务看板", "按状态分列。拖动卡片会先确认，再交给任务执行接口处理。"],
  list: ["任务列表", "组合筛选、排序和分页；行内按钮直接去开始、提交或查看证据。"],
};

/** Pages 11–13 (B6-01 ~ B6-03): one query, three views; status changes go to C. */
export function TasksApiPage({ projectId, view }: { projectId: string; view: BTaskView }) {
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
  const query = {
    view, q: filters.q || undefined, status: filters.status || undefined, assignee: filters.assignee || undefined,
    module: filters.module || undefined, milestone: filters.milestone || undefined,
    sort: view === "list" ? filters.sort : undefined, page: view === "list" ? filters.page : undefined, page_size: view === "list" ? PAGE_SIZE : undefined,
  };
  const page = useQuery({ queryKey: ["b-tasks", userId, projectId, query], queryFn: () => bTasksApi.list(projectId, query), ...queryPolicy });
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
      setNotice({ tone: "success", text: `${row.code ?? row.title} 已改为“${statusLabel[transition.to]}”。` });
      // Every view shares the prefix, so tree, board and list all refetch.
      await client.invalidateQueries({ queryKey: ["b-tasks", userId, projectId] });
    } catch (error) {
      const reason = error instanceof CApiError ? cErrors[error.code] ?? `任务执行接口拒绝了这次操作（${error.code}）。` : "网络异常，请重试。";
      setNotice({ tone: "error", text: `没有改动：${reason}` });
    } finally {
      setBusy(false);
      setPending(undefined);
    }
  };

  const [title, description] = titles[view];
  return <div>
    <PageHeader title={title} description={description} actions={<Link href={`/projects/${projectId}/planning`} className={secondary}>任务计划</Link>} />
    <nav aria-label="任务视图" className="mt-4 flex gap-2">{(["tree", "board", "list"] as const).map((v) => <Link key={v} href={viewHref(v)} aria-current={v === view ? "page" : undefined} className={v === view ? button : secondary}>{viewLabel[v]}</Link>)}</nav>
    <Panel className="mt-3">
      <form className="grid grid-cols-2 gap-2 md:grid-cols-6" onSubmit={(e) => { e.preventDefault(); setFilters({ q: q.trim() || null, page: null }); }}>
        <div className="col-span-2"><label className={label} htmlFor="tasks-q">搜索</label><input id="tasks-q" className={input} placeholder="名称、说明或编号 T-001" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div><label className={label} htmlFor="tasks-status">状态</label><select id="tasks-status" className={input} value={filters.status} onChange={(e) => setFilters({ status: e.target.value || null, page: null })}><option value="">全部</option>{Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label className={label} htmlFor="tasks-assignee">负责人</label><select id="tasks-assignee" className={input} value={filters.assignee} onChange={(e) => setFilters({ assignee: e.target.value || null, page: null })}><option value="">全部</option><option value="me">我</option><option value="none">未分配</option>{page.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name ?? "组员"}</option>)}</select></div>
        <div><label className={label} htmlFor="tasks-module">模块</label><select id="tasks-module" className={input} value={filters.module} onChange={(e) => setFilters({ module: e.target.value || null, page: null })}><option value="">全部</option>{page.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        <div><label className={label} htmlFor="tasks-milestone">里程碑</label><select id="tasks-milestone" className={input} value={filters.milestone} onChange={(e) => setFilters({ milestone: e.target.value || null, page: null })}><option value="">全部</option>{page.data?.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        {view === "list" && <div><label className={label} htmlFor="tasks-sort">排序</label><select id="tasks-sort" className={input} value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value, page: null })}>
          <option value="code">编号</option><option value="priority">优先级</option><option value="-weight">权重从高到低</option><option value="-progress">进度从高到低</option><option value="status">状态</option><option value="-updated">最近更新</option>
        </select></div>}
        <div className="col-span-2 flex items-end gap-2 md:col-span-1"><button type="submit" className={button}><Search size={14} />查询</button><button type="button" className={secondary} onClick={clearFilters}>清空</button></div>
      </form>
    </Panel>
    {notice && <div className="mt-3" data-testid="tasks-notice"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
    {pending && <div role="dialog" aria-modal="true" aria-label="确认修改状态" className="mt-3"><Panel title="确认修改状态">
      <p className="text-sm text-slate-700">把 {pending.row.code ?? ""} {pending.row.title} 从“{statusLabel[pending.row.status]}”改为“{statusLabel[pending.transition.to]}”？{pending.transition.kind === "page" ? "将打开提交页面完成这一步。" : ""}</p>
      <div className="mt-3 flex gap-2"><button type="button" className={button} disabled={busy} onClick={() => void run()}>确认</button><button type="button" className={secondary} onClick={() => setPending(undefined)}>取消</button></div>
    </Panel></div>}
    <div className="mt-3">
      {page.isPending ? <div role="status" className="gp-empty">正在加载任务…</div>
        : page.isError ? <div role="alert"><Feedback tone="error">{errorText(page.error)}</Feedback></div>
        : page.data.plan_status !== "frozen" && page.data.items.length === 0 ? <Panel><EmptyState title="还没有任务" description="先在任务计划里拆分任务。" action={<Link className={button} href={`/projects/${projectId}/planning`}>去任务计划</Link>} /></Panel>
        : view === "tree" ? <TreeView rows={page.data.items} issues={page.data.integrity_issues} collapsed={filters.collapsed} onCollapsed={(next) => setFilters({ collapsed: next })} />
        : view === "board" ? <BoardView page={page.data} onMove={(row, transition) => setPending({ row, transition })} />
        : <ListView page={page.data} current={filters.page} onPage={(next) => setFilters({ page: next })} />}
    </div>
  </div>;
}

function Assignees({ row }: { row: BTaskRow }) {
  return <>{row.assignees.map((a) => a.name ?? "组员").join("、") || <span className="text-amber-700">未分配</span>}</>;
}

function TreeView({ rows, issues, collapsed, onCollapsed }: { rows: BTaskRow[]; issues: BTasksPageIssue[]; collapsed: string[]; onCollapsed: (next: string[]) => void }) {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, BTaskRow[]>();
  for (const r of rows) if (r.parent_task_id && ids.has(r.parent_task_id)) children.set(r.parent_task_id, [...(children.get(r.parent_task_id) ?? []), r]);
  const flagged = new Set(issues.flatMap((i) => [i.task_id, ...i.task_ids]).filter(Boolean) as string[]);
  const seen = new Set<string>();
  const out: { row: BTaskRow; depth: number; hasChildren: boolean }[] = [];
  const visit = (r: BTaskRow, depth: number, visible: boolean) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const kids = children.get(r.id) ?? [];
    if (visible) out.push({ row: r, depth, hasChildren: kids.length > 0 });
    for (const k of kids) visit(k, depth + 1, visible && !collapsed.includes(r.id));
  };
  for (const r of rows) if (!r.parent_task_id || !ids.has(r.parent_task_id)) visit(r, 0, true);
  for (const r of rows) visit(r, 0, true); // tasks on a parent cycle have no root; show them at the top
  return <div className="space-y-3">
    {issues.length > 0 && <div data-testid="tree-issues"><Feedback tone="warning"><div className="flex items-center gap-1 font-semibold"><AlertTriangle size={14} />任务数据有 {issues.length} 处问题（只读诊断，未自动修改）</div><ul className="mt-1 list-disc pl-5">{issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}</ul></Feedback></div>}
    <Panel noPadding><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
      <thead className="border-b border-slate-100 text-xs text-slate-500"><tr><th className="px-4 py-2">任务</th><th className="px-4 py-2">负责人</th><th className="px-4 py-2">权重</th><th className="px-4 py-2">状态</th><th className="px-4 py-2">进度</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{out.map(({ row, depth, hasChildren }) => <tr key={row.id} data-testid="tree-row" className={row.matched ? "" : "text-slate-400"}>
        <td className="px-4 py-2" style={{ paddingLeft: 12 + depth * 22 }}>
          {hasChildren ? <button type="button" aria-label={collapsed.includes(row.id) ? `展开 ${row.code ?? row.title}` : `收起 ${row.code ?? row.title}`} className="mr-1 align-middle text-slate-500" onClick={() => onCollapsed(collapsed.includes(row.id) ? collapsed.filter((x) => x !== row.id) : [...collapsed, row.id])}>{collapsed.includes(row.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : <span className="mr-1 inline-block w-[14px]" />}
          <span className="mr-2 font-mono text-xs">{row.code ?? "—"}</span><Link className="font-medium hover:underline" href={row.links.detail}>{row.title}</Link>
          {flagged.has(row.id) && <span className="ml-2 rounded bg-amber-50 px-1.5 text-xs text-amber-700">数据有问题</span>}
        </td>
        <td className="px-4 py-2"><Assignees row={row} /></td><td className="px-4 py-2">{row.weight}</td>
        <td className="px-4 py-2">{statusLabel[row.status] ?? row.status}</td><td className="px-4 py-2">{row.progress_percent}%</td>
      </tr>)}</tbody>
    </table></div>{out.length === 0 && <div className="p-4"><EmptyState title="没有符合条件的任务" /></div>}</Panel>
  </div>;
}

type BTasksPageIssue = { code: string; message: string; task_id: string | null; task_ids: string[] };

function BoardView({ page, onMove }: { page: { items: BTaskRow[]; columns: { status: string; label: string; count: number }[] }; onMove: (row: BTaskRow, transition: BTransition) => void }) {
  const [dragged, setDragged] = useState<BTaskRow>();
  const target = (status: string) => dragged?.transitions.find((t) => t.to === status);
  return <div className="grid gap-3 overflow-x-auto md:grid-cols-5">{page.columns.map((col) => <section key={col.status} aria-label={col.label} data-testid={`column-${col.status}`}
    className={`min-h-40 rounded border bg-slate-50 p-2 ${dragged && target(col.status) ? "border-blue-400" : "border-slate-200"}`}
    onDragOver={(e) => { if (target(col.status)) e.preventDefault(); }}
    onDrop={(e) => { e.preventDefault(); const t = target(col.status); if (dragged && t) onMove(dragged, t); setDragged(undefined); }}>
    <h2 className="mb-2 flex justify-between text-xs font-semibold text-slate-600"><span>{col.label}</span><span>{col.count}</span></h2>
    <div className="space-y-2">{page.items.filter((r) => r.status === col.status).map((row) => <article key={row.id} data-testid="board-card" draggable={row.transitions.length > 0} data-movable={row.transitions.length > 0 ? "true" : "false"}
      title={row.blocked_reason ?? "拖到下一列"} onDragStart={() => setDragged(row)} onDragEnd={() => setDragged(undefined)}
      className={`rounded border border-slate-200 bg-white p-2 text-sm shadow-sm ${row.transitions.length ? "cursor-grab" : "cursor-not-allowed opacity-90"}`}>
      <div className="font-mono text-xs text-slate-500">{row.code}</div>
      <Link className="font-medium text-slate-900 hover:underline" href={row.links.detail}>{row.title}</Link>
      <div className="mt-1 text-xs text-slate-500"><Assignees row={row} /> · {row.progress_percent}%</div>
      {row.blocked_reason && <div className="mt-1 text-xs text-slate-400">{row.blocked_reason}</div>}
      {row.transitions.map((t) => <button key={t.to} type="button" className="mt-1 text-xs text-blue-700 underline" onClick={() => onMove(row, t)}>移到“{statusLabel[t.to]}”</button>)}
    </article>)}</div>
  </section>)}</div>;
}

function ListView({ page, current, onPage }: { page: { items: BTaskRow[]; total: number; page_size: number }; current: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(page.total / page.page_size));
  if (page.items.length === 0) return <Panel><EmptyState title="没有符合条件的任务" /></Panel>;
  return <Panel noPadding>
    <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm">
      <thead className="border-b border-slate-100 text-xs text-slate-500"><tr><th className="px-4 py-2">编号</th><th className="px-4 py-2">任务</th><th className="px-4 py-2">模块</th><th className="px-4 py-2">负责人</th><th className="px-4 py-2">优先级</th><th className="px-4 py-2">权重</th><th className="px-4 py-2">状态</th><th className="px-4 py-2">进度</th><th className="px-4 py-2">操作</th></tr></thead>
      <tbody className="divide-y divide-slate-100">{page.items.map((row) => <tr key={row.id} data-testid="list-row">
        <td className="px-4 py-2 font-mono text-xs">{row.code ?? "—"}</td>
        <td className="px-4 py-2"><Link className="font-medium hover:underline" href={row.links.detail}>{row.title}</Link></td>
        <td className="px-4 py-2 text-slate-600">{row.module.name}</td><td className="px-4 py-2 text-slate-600"><Assignees row={row} /></td>
        <td className="px-4 py-2">{priorityLabel[row.priority] ?? row.priority}</td><td className="px-4 py-2">{row.weight}</td>
        <td className="px-4 py-2"><StatusBadge tone={row.status === "completed" ? "green" : row.status === "not_started" ? "gray" : "blue"} label={statusLabel[row.status] ?? row.status} /></td>
        <td className="px-4 py-2">{row.progress_percent}%</td>
        <td className="space-x-2 whitespace-nowrap px-4 py-2 text-xs">
          {row.status === "not_started" && <Link className="text-blue-700 underline" href={row.links.detail}>开始任务</Link>}
          {["in_progress", "pending_submission"].includes(row.status) && <Link className="text-blue-700 underline" href={row.links.submit}>提交验收</Link>}
          {["pending_verification", "completed"].includes(row.status) && <Link className="text-blue-700 underline" href={row.links.verification}>查看验收</Link>}
          <Link className="text-blue-700 underline" href={row.links.evidence}>查看证据</Link>
        </td>
      </tr>)}</tbody>
    </table></div>
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
      <span>共 {page.total} 个 · 第 {current} / {pages} 页</span>
      <span className="flex gap-2"><button type="button" className={secondary} disabled={current <= 1} onClick={() => onPage(current - 1)}>上一页</button><button type="button" className={secondary} disabled={current >= pages} onClick={() => onPage(current + 1)}>下一页</button></span>
    </div>
  </Panel>;
}
