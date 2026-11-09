"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GitCompare, History, Network, PenLine, Search } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bManageApi, type BRequirementDetail } from "@/lib/api/b-manage";
import type { BPriority } from "@/lib/api/b-requirements";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { tr } from "@/lib/i18n/tr";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;

const statusLabel: Record<string, string> = { draft: "草稿", confirmed: "已确认", in_progress: "进行中", implemented: "已实现", verified: "已验收" };
const priorityLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
const filterSchema = {
  code: { kind: "string" },
  q: { kind: "string" },
  source: { kind: "string" },
  module: { kind: "string" },
  status: { kind: "enum", values: ["", "draft", "confirmed", "in_progress", "implemented", "verified"], default: "" },
  page: { kind: "int", default: 1, min: 1 },
  req: { kind: "string" },
  tab: { kind: "enum", values: ["detail", "versions", "trace"], default: "detail" },
} as const;
const PAGE_SIZE = 20;

/** Page 09 (B4-01 ~ B4-03): requirement list with URL filters, change with reason, versions, trace. */
export function RequirementsApiPage({ projectId }: { projectId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const { filters, setFilters, clearFilters } = useUrlFilters(filterSchema);
  const [draft, setDraft] = useState({ code: filters.code, q: filters.q });
  useEffect(() => setDraft({ code: filters.code, q: filters.q }), [filters.code, filters.q]);
  const query = { code: filters.code || undefined, q: filters.q || undefined, source: filters.source || undefined, module: filters.module || undefined, status: filters.status || undefined, page: filters.page, page_size: PAGE_SIZE };
  const list = useQuery({ queryKey: ["b-req-list", userId, projectId, query], queryFn: () => bManageApi.list(projectId, query), ...queryPolicy });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  return <div>
    <PageHeader title="需求管理" description="按编号、名称、来源、模块和状态查找需求；筛选条件写在链接里，可以直接分享。" actions={<Link href={`/projects/${projectId}`} className={secondary}>项目总览</Link>} />
    <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-3">
        <Panel>
          <form className="grid grid-cols-2 gap-2 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); setFilters({ code: draft.code.trim() || null, q: draft.q.trim() || null, page: null }); }}>
            <div><label className={label} htmlFor="req-f-code">编号</label><input id="req-f-code" className={input} placeholder="R-001" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} /></div>
            <div><label className={label} htmlFor="req-f-q">名称或说明</label><input id="req-f-q" className={input} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} /></div>
            <div><label className={label} htmlFor="req-f-source">来源</label><select id="req-f-source" className={input} value={filters.source} onChange={(e) => setFilters({ source: e.target.value || null, page: null })}><option value="">全部</option><option value="ai">AI 分析</option><option value="manual">手工录入</option></select></div>
            <div><label className={label} htmlFor="req-f-module">模块</label><select id="req-f-module" className={input} value={filters.module} onChange={(e) => setFilters({ module: e.target.value || null, page: null })}><option value="">全部</option>{list.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
            <div><label className={label} htmlFor="req-f-status">状态</label><select id="req-f-status" className={input} value={filters.status} onChange={(e) => setFilters({ status: e.target.value || null, page: null })}><option value="">全部</option>{Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="col-span-2 flex items-end justify-end gap-2 md:col-span-1"><button type="submit" className={button}><Search size={14} />查询</button><button type="button" className={secondary} onClick={clearFilters}>清空</button></div>
          </form>
        </Panel>
        {list.isPending ? <div role="status" className="gp-empty">正在加载需求…</div>
          : list.isError ? <div role="alert"><Feedback tone="error">{errorText(list.error)}</Feedback></div>
          : list.data.items.length === 0 ? <Panel><EmptyState title="没有符合条件的需求" /></Panel>
          : <Panel noPadding>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs text-slate-500"><tr><th className="px-4 py-2">编号</th><th className="px-4 py-2">需求</th><th className="px-4 py-2">模块</th><th className="px-4 py-2">来源</th><th className="px-4 py-2">状态</th><th className="px-4 py-2">版本</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{list.data.items.map((item) => <tr key={item.id} aria-selected={filters.req === item.id} className={`cursor-pointer hover:bg-slate-50 ${filters.req === item.id ? "bg-blue-50" : ""}`} onClick={() => setFilters({ req: item.id, tab: null })}>
                <td className="px-4 py-2 font-mono text-xs">{item.code ?? "—"}</td>
                <td className="px-4 py-2"><button type="button" className="text-left font-medium text-slate-900 hover:underline" onClick={(e) => { e.stopPropagation(); setFilters({ req: item.id, tab: null }); }}>{item.title}</button></td>
                <td className="px-4 py-2 text-slate-600">{item.module.name}</td>
                <td className="px-4 py-2 text-slate-600">{item.origin === "ai" ? "AI" : "手工"}</td>
                <td className="px-4 py-2"><StatusBadge tone={item.status === "draft" ? "gray" : "blue"} label={statusLabel[item.status] ?? item.status} /></td>
                <td className="px-4 py-2 text-slate-600">v{item.version_no}</td>
              </tr>)}</tbody>
            </table></div>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              <span>{tr("共 {0} 条 · 第 {1} / {2} 页", { 0: list.data.total, 1: filters.page, 2: pages })}</span>
              <span className="flex gap-2"><button type="button" className={secondary} disabled={filters.page <= 1} onClick={() => setFilters({ page: filters.page - 1 })}>上一页</button><button type="button" className={secondary} disabled={filters.page >= pages} onClick={() => setFilters({ page: filters.page + 1 })}>下一页</button></span>
            </div>
          </Panel>}
      </div>
      <div>{filters.req ? <RequirementPanel key={filters.req} projectId={projectId} requirementId={filters.req} tab={filters.tab} onTab={(tab) => setFilters({ tab })} /> : <Panel><EmptyState title="选择一条需求" description="查看详情、修改记录和它关联的任务与证据。" /></Panel>}</div>
    </div>
  </div>;
}

function RequirementPanel({ projectId, requirementId, tab, onTab }: { projectId: string; requirementId: string; tab: string; onTab: (tab: "detail" | "versions" | "trace") => void }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const detail = useQuery({ queryKey: ["b-req-detail", userId, projectId, requirementId], queryFn: () => bManageApi.detail(projectId, requirementId), ...queryPolicy });
  if (detail.isPending) return <div role="status" className="gp-empty">正在加载…</div>;
  if (detail.isError) return <div role="alert"><Feedback tone="error">{errorText(detail.error)}</Feedback></div>;
  const data = detail.data;
  const tabs = [["detail", "详情", PenLine], ["versions", "修改记录", History], ["trace", "证据链", Network]] as const;
  return <Panel title={`${data.requirement.code ?? ""} ${data.requirement.title}`}>
    <div role="tablist" className="mb-3 flex gap-1 border-b border-slate-100">{tabs.map(([key, text, Icon]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={`flex items-center gap-1 px-3 py-2 text-sm ${tab === key ? "border-b-2 border-blue-500 font-semibold text-blue-700" : "text-slate-500"}`} onClick={() => onTab(key)}><Icon size={14} />{text}</button>)}</div>
    {tab === "detail" && <DetailTab projectId={projectId} data={data} />}
    {tab === "versions" && <VersionsTab projectId={projectId} requirementId={requirementId} />}
    {tab === "trace" && <TraceTab projectId={projectId} requirementId={requirementId} />}
  </Panel>;
}

function DetailTab({ projectId, data }: { projectId: string; data: BRequirementDetail }) {
  const errorText = useBErrorMessage();
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const row = data.requirement;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: row.title, description: row.description ?? "", priority: row.priority as BPriority, reason: "" });
  const [notice, setNotice] = useState<Notice>();
  const impact = useQuery({ queryKey: ["b-req-impact", userId, projectId, row.id], queryFn: () => bManageApi.impact(projectId, row.id), enabled: editing, ...queryPolicy });
  const save = useMutation({
    mutationFn: () => bManageApi.update(projectId, row, { module_id: row.module_id, title: form.title.trim(), description: form.description.trim() || undefined, priority: form.priority, reason: form.reason.trim() || undefined }),
    onSuccess: () => {
      setEditing(false);
      setNotice({ tone: "success", text: impact.data?.criteria_count ? tr("已保存为新版本，{0} 条验收标准已标记“需要重新检查”", { 0: impact.data.criteria_count }) : "已保存为新版本" });
      for (const key of ["b-req-list", "b-req-detail", "b-req-versions", "b-req-trace", "b-req-impact"]) void cache.invalidateQueries({ queryKey: [key, userId, projectId] });
    },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); if (error instanceof BApiError && error.code === "VERSION_CONFLICT") void cache.invalidateQueries({ queryKey: ["b-req-detail", userId, projectId, row.id] }); },
  });
  if (!editing) return <div className="space-y-3 text-sm">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <dl className="space-y-2">
      <div className="flex gap-3"><dt className="w-16 text-slate-500">模块</dt><dd>{data.module.name}</dd></div>
      <div className="flex gap-3"><dt className="w-16 text-slate-500">优先级</dt><dd>{priorityLabel[row.priority]}</dd></div>
      <div className="flex gap-3"><dt className="w-16 text-slate-500">状态</dt><dd>{statusLabel[row.status] ?? row.status}</dd></div>
      <div className="flex gap-3"><dt className="w-16 text-slate-500">版本</dt><dd>v{data.version_no}</dd></div>
      <div className="flex gap-3"><dt className="w-16 text-slate-500">说明</dt><dd className="whitespace-pre-wrap">{row.description || "—"}</dd></div>
    </dl>
    {row.sources.length > 0 && <ul className="space-y-1">{row.sources.map((s, i) => <li key={i} className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-500">{tr("出处：{0} —— “{1}”", { 0: s.material_title ?? "资料", 1: s.quote })}</li>)}</ul>}
    {data.can_edit && !row.excluded && <button type="button" className={secondary} onClick={() => setEditing(true)}><PenLine size={14} />{data.reason_required ? "提出修改" : "编辑"}</button>}
    {data.baseline_frozen && <p className="text-xs text-slate-500">需求基线已冻结，修改需要写明原因，并会生成新版本。</p>}
  </div>;
  return <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <div><label className={label} htmlFor="req-edit-title">需求标题</label><input id="req-edit-title" className={input} maxLength={240} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
    <div><label className={label} htmlFor="req-edit-desc">说明</label><textarea id="req-edit-desc" className={input} rows={3} maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
    <div><label className={label} htmlFor="req-edit-priority">优先级</label><select id="req-edit-priority" className={input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as BPriority })}>{(["high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{priorityLabel[v]}</option>)}</select></div>
    {data.reason_required && <div><label className={label} htmlFor="req-edit-reason">修改原因（必填）</label><textarea id="req-edit-reason" className={input} rows={2} maxLength={2000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>}
    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" data-testid="b-impact">
      <p className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle size={13} />保存后会影响</p>
      {impact.isPending ? "正在查找关联的任务…" : impact.isError ? errorText(impact.error) : impact.data.tasks.length === 0 ? "没有关联的任务。" : <ul className="list-disc pl-4">{impact.data.tasks.map((t) => <li key={t.id}>{tr("{0}（{1} 条验收标准将标记“需要重新检查”）", { 0: t.title, 1: t.criteria.length })}</li>)}</ul>}
    </div>
    <div className="flex justify-end gap-2"><button type="button" className={secondary} onClick={() => setEditing(false)}>取消</button><button type="submit" className={button} disabled={save.isPending || !form.title.trim() || (data.reason_required && !form.reason.trim())}>保存为新版本</button></div>
  </form>;
}

function VersionsTab({ projectId, requirementId }: { projectId: string; requirementId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [picked, setPicked] = useState<number[]>([]);
  const compare = picked.length === 2 ? { from: Math.min(...picked), to: Math.max(...picked) } : undefined;
  const versions = useQuery({ queryKey: ["b-req-versions", userId, projectId, requirementId, compare?.from, compare?.to], queryFn: () => bManageApi.versions(projectId, requirementId, compare), ...queryPolicy });
  if (versions.isPending && !versions.data) return <div role="status" className="gp-empty">正在加载版本…</div>;
  if (versions.isError) return <div role="alert"><Feedback tone="error">{errorText(versions.error)}</Feedback></div>;
  const data = versions.data!;
  const toggle = (no: number) => setPicked((current) => current.includes(no) ? current.filter((v) => v !== no) : [...current.slice(-1), no]);
  return <div className="space-y-3 text-sm">
    <p className="text-xs text-slate-500">勾选两个版本查看差异。</p>
    <ul className="divide-y divide-slate-100">{[...data.versions].reverse().map((v) => <li key={v.version_no} className="flex items-start gap-2 py-2">
      <input id={`ver-${v.version_no}`} type="checkbox" className="mt-1" checked={picked.includes(v.version_no)} onChange={() => toggle(v.version_no)} />
      <label htmlFor={`ver-${v.version_no}`} className="min-w-0 flex-1"><span className="font-medium">v{v.version_no}</span> · {v.snapshot.title} <span className="text-xs text-slate-400">{v.created_by?.name ?? ""} {dateOnly(v.created_at)}</span>{v.reason && <span className="block text-xs text-slate-500">{tr("原因：{0}", { 0: v.reason })}</span>}</label>
    </li>)}</ul>
    {data.compare && <div className="rounded border border-slate-200" data-testid="b-version-diff">
      <p className="flex items-center gap-1 border-b border-slate-100 px-3 py-2 text-xs font-semibold"><GitCompare size={13} />v{data.compare.from} → v{data.compare.to}</p>
      {data.compare.changes.length === 0 ? <p className="px-3 py-2 text-xs text-slate-500">两个版本内容相同。</p>
        : <table className="w-full text-xs"><tbody>{data.compare.changes.map((c) => <tr key={c.field} className="border-b border-slate-50 align-top"><th className="w-20 px-3 py-2 text-left font-normal text-slate-500">{c.label}</th><td className="px-3 py-2"><del className="bg-red-50 text-red-700">{display(c.field, c.before)}</del></td><td className="px-3 py-2"><ins className="bg-green-50 text-green-800 no-underline">{display(c.field, c.after)}</ins></td></tr>)}</tbody></table>}
    </div>}
  </div>;
}

function display(field: string, value: string | null) {
  if (value === null || value === "") return "（空）";
  if (field === "priority") return priorityLabel[value] ?? value;
  if (field === "status") return statusLabel[value] ?? value;
  return value;
}

function Unavailable({ text }: { text: string }) { return <span className="text-xs text-slate-400">{text}</span>; }

function TraceTab({ projectId, requirementId }: { projectId: string; requirementId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const trace = useQuery({ queryKey: ["b-req-trace", userId, projectId, requirementId], queryFn: () => bManageApi.trace(projectId, requirementId), ...queryPolicy });
  if (trace.isPending) return <div role="status" className="gp-empty">正在加载证据链…</div>;
  if (trace.isError) return <div role="alert"><Feedback tone="error">{errorText(trace.error)}</Feedback></div>;
  const data = trace.data;
  return <div className="space-y-2 text-sm" data-testid="b-trace">
    <p>模块：<Link className="gp-link" href={data.module_href}>{data.module.name}</Link></p>
    {data.tasks.length === 0 ? <p className="text-xs text-slate-500">还没有任务关联这条需求。</p> : <ul className="space-y-3">{data.tasks.map((task) => <li key={task.id} className="rounded border border-slate-200 p-3">
      <p>任务：<Link className="gp-link" href={task.href}>{task.title}</Link></p>
      <ul className="mt-2 space-y-2 pl-3">{task.criteria.map((c) => <li key={c.id} className="border-l-2 border-slate-200 pl-3">
        <p>{tr("验收标准 {0}：{1} ", { 0: c.key, 1: c.text })}{c.needs_recheck && <StatusBadge tone="amber" label="需要重新检查" />}</p>
        <p className="mt-1 text-xs">证据：{data.evidence_status === "unavailable" ? <Unavailable text={tr("暂不可用{0}", { 0: data.evidence_reason ? `（${data.evidence_reason}）` : "" })} /> : c.evidence.length === 0 ? <Unavailable text="还没有证据" /> : c.evidence.map((e) => <Link key={e.id} className="gp-link mr-2" href={e.href}>{e.title}</Link>)}</p>
      </li>)}</ul>
      <p className="mt-2 text-xs">验收结果：{task.verification.status === "unavailable" ? <Unavailable text="暂不可用（验收服务未接入）" /> : <Link className="gp-link" href={task.verification.href}>{task.verification.state ?? "查看"}</Link>}</p>
    </li>)}</ul>}
  </div>;
}
