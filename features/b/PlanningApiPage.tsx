"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, History, Lock, Plus, Sparkles, Trash2, Unlock, X } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bPlanningApi, type BPlan, type BPlanIssue, type BPlanTask, type BTaskInput } from "@/lib/api/b-planning";
import type { BPriority } from "@/lib/api/b-requirements";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, input, label, queryPolicy, secondary } from "@/features/b/ui";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string; items?: string[] } | undefined;

const priorityLabel: Record<BPriority, string> = { high: "高", medium: "中", low: "低" };
const statusLabel: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" };
const confirmLabel = { confirmed: "已确认", stale: "分配有变化，需重新确认", pending: "未确认" } as const;
const filterSchema = { task: { kind: "string" } } as const;

/** Tasks in tree order with depth; tasks on a broken parent chain are listed at the top level. */
function treeOrder(tasks: BPlanTask[]): { task: BPlanTask; depth: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string, BPlanTask[]>();
  for (const t of tasks) if (t.parent_task_id && ids.has(t.parent_task_id)) children.set(t.parent_task_id, [...(children.get(t.parent_task_id) ?? []), t]);
  const seen = new Set<string>();
  const out: { task: BPlanTask; depth: number }[] = [];
  const visit = (t: BPlanTask, depth: number) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ task: t, depth });
    for (const c of children.get(t.id) ?? []) visit(c, depth + 1);
  };
  for (const t of tasks) if (!t.parent_task_id || !ids.has(t.parent_task_id)) visit(t, 0);
  for (const t of tasks) visit(t, 0);
  return out;
}

function errorItems(error: unknown): string[] {
  if (!(error instanceof BApiError)) return [];
  const issues = (error.details.issues as BPlanIssue[] | undefined) ?? [];
  const unconfirmed = (error.details.unconfirmed as { name: string | null }[] | undefined) ?? [];
  return [...issues.map((i) => i.message), ...unconfirmed.map((u) => `${u.name ?? "组员"} 还没确认任务分配`)];
}

/** Page 10 (B5-01 ~ B5-05): shared task plan draft, AI suggestions, confirmation, freeze and unlock. */
export function PlanningApiPage({ projectId }: { projectId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const client = useQueryClient();
  const { filters, setFilters } = useUrlFilters(filterSchema);
  const [notice, setNotice] = useState<Notice>();
  const [creating, setCreating] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const planKey = ["b-plan", userId, projectId];
  const plan = useQuery({ queryKey: planKey, queryFn: () => bPlanningApi.plan(projectId), ...queryPolicy });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: planKey }), client.invalidateQueries({ queryKey: ["b-plan-suggestions", userId, projectId] })]);
  const fail = (error: unknown) => setNotice({ tone: "error", text: errorText(error), items: errorItems(error) });
  const freeze = useMutation({
    mutationFn: (current: BPlan) => bPlanningApi.freeze(projectId, current),
    onSuccess: async () => { setNotice({ tone: "success", text: "任务计划已冻结，全组都收到了通知。" }); await refresh(); },
    onError: fail,
  });
  const unlock = useMutation({
    mutationFn: (current: BPlan) => bPlanningApi.unlock(projectId, current, unlockReason.trim()),
    onSuccess: async () => { setUnlockOpen(false); setUnlockReason(""); setNotice({ tone: "info", text: "计划已解锁，已生成新草稿；所有人需要重新确认分配。" }); await refresh(); },
    onError: fail,
  });
  const confirm = useMutation({
    mutationFn: (current: BPlan) => bPlanningApi.confirm(projectId, current.my_task_versions),
    onSuccess: async () => { setNotice({ tone: "success", text: "已确认你的任务分配。" }); await refresh(); },
    onError: async (error) => { fail(error); await refresh(); },
  });

  if (plan.isPending) return <div role="status" className="gp-empty">正在加载任务计划…</div>;
  if (plan.isError) return <div role="alert"><Feedback tone="error">{errorText(plan.error)}</Feedback></div>;
  const data = plan.data;
  const frozen = data.status === "frozen";
  const selected = data.tasks.find((t) => t.id === filters.task);
  const unassigned = data.tasks.filter((t) => t.assignees.length === 0).length;
  const me = data.confirmations.find((c) => c.user.id === userId);
  const badge = data.status === "none" ? "还没有计划" : `计划 v${data.version_no} · ${frozen ? "已冻结" : "草稿"}`;

  return <div>
    <PageHeader title="任务计划" description="组员一起拆任务、写验收标准、分配负责人；全员确认后由组长冻结，C 的任务执行只认冻结的计划。"
      actions={<>
        <StatusBadge tone={frozen ? "green" : data.status === "draft" ? "blue" : "gray"} label={badge} />
        {data.can_lead && data.status === "draft" && <button type="button" className={button} disabled={freeze.isPending} onClick={() => freeze.mutate(data)}><Lock size={14} />冻结计划</button>}
        {data.can_lead && frozen && <button type="button" className={secondary} onClick={() => setUnlockOpen(true)}><Unlock size={14} />解锁修改</button>}
        <Link href={`/projects/${projectId}`} className={secondary}>项目总览</Link>
      </>} />
    <div className="mt-4 space-y-3">
      {!data.baseline_frozen && <Feedback tone="warning">需求基线冻结后才能制定任务计划。<Link className="ml-2 underline" href={`/projects/${projectId}/setup`}>前往项目初始化</Link></Feedback>}
      {frozen && <Feedback tone="info">计划已冻结，任务只读。{data.can_lead ? "需要修改时请解锁并写明原因。" : "需要修改时请联系组长解锁。"}</Feedback>}
      {notice && <div data-testid="plan-notice" role={notice.tone === "error" ? "alert" : "status"}><Feedback tone={notice.tone}>{notice.text}{notice.items && notice.items.length > 0 && <ul className="mt-1 list-disc pl-5">{notice.items.map((item) => <li key={item}>{item}</li>)}</ul>}</Feedback></div>}
      {unlockOpen && <Panel title="解锁任务计划">
        <label className={label} htmlFor="plan-unlock-reason">解锁原因（必填，全组都会看到）</label>
        <textarea id="plan-unlock-reason" className={input} rows={2} value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
        <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={unlock.isPending} onClick={() => unlock.mutate(data)}>确认解锁</button><button type="button" className={secondary} onClick={() => setUnlockOpen(false)}>取消</button></div>
      </Panel>}
    </div>
    <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="任务" value={String(data.tasks.length)} />
      <Stat label="未分配负责人" value={String(unassigned)} warn={unassigned > 0} />
      <Stat label="顶层权重合计" value={`${data.root_weight_total}`} warn={data.tasks.length > 0 && data.root_weight_total !== 100} note="冻结前必须是 100" />
      <Stat label="待处理问题" value={String(data.issues.length)} warn={data.issues.length > 0} />
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <Panel title="任务" action={data.can_edit && <button type="button" className={secondary} onClick={() => { setCreating(true); setFilters({ task: null }); }}><Plus size={14} />新建任务</button>} noPadding>
          {data.tasks.length === 0 ? <div className="p-4"><EmptyState title="还没有任务" description={data.can_edit ? "新建任务，或先生成 AI 建议再逐条采纳。" : undefined} /></div>
            : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-xs text-slate-500"><tr><th className="px-4 py-2">任务</th><th className="px-4 py-2">负责人</th><th className="px-4 py-2">权重</th><th className="px-4 py-2">标准</th><th className="px-4 py-2">状态</th><th className="px-4 py-2">版本</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{treeOrder(data.tasks).map(({ task, depth }) => <tr key={task.id} aria-selected={task.id === filters.task} className={`cursor-pointer hover:bg-slate-50 ${task.id === filters.task ? "bg-blue-50" : ""}`} onClick={() => { setCreating(false); setFilters({ task: task.id }); }}>
                <td className="px-4 py-2" style={{ paddingLeft: 16 + depth * 20 }}><span className="mr-2 font-mono text-xs text-slate-500">{task.code ?? "—"}</span><span className="font-medium text-slate-900">{task.title}</span>{task.origin === "ai" && <span className="ml-2 text-xs text-slate-500">AI</span>}</td>
                <td className="px-4 py-2 text-slate-600">{task.assignees.map((a) => a.name ?? "组员").join("、") || <span className="text-amber-700">未分配</span>}</td>
                <td className="px-4 py-2 text-slate-600">{task.weight}</td>
                <td className="px-4 py-2 text-slate-600">{task.criteria.length || <span className="text-amber-700">0</span>}</td>
                <td className="px-4 py-2 text-slate-600">{statusLabel[task.status] ?? task.status}</td>
                <td className="px-4 py-2 text-slate-600">v{task.content_version}</td>
              </tr>)}</tbody>
            </table></div>}
        </Panel>
        {data.issues.length > 0 && <Panel title={`冻结前要处理的问题（${data.issues.length}）`}>
          <ul className="space-y-1 text-sm text-slate-700">{data.issues.map((issue, index) => <li key={`${issue.code}-${issue.task_id}-${index}`} className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" /><span>{issue.message}</span>{issue.task_id && data.tasks.some((t) => t.id === issue.task_id) && <button type="button" className="text-xs text-blue-700 underline" onClick={() => setFilters({ task: issue.task_id })}>查看</button>}</li>)}</ul>
        </Panel>}
        <SuggestionsPanel projectId={projectId} plan={data} onNotice={setNotice} onChanged={refresh} />
      </div>
      <div className="space-y-4">
        {(creating || selected) && <TaskEditor key={selected ? `${selected.id}:${selected.content_version}` : "new"} projectId={projectId} plan={data} task={creating ? undefined : selected}
          onSaved={async (task, message) => { setCreating(false); setFilters({ task: task?.id ?? null }); setNotice({ tone: "success", text: message }); await refresh(); }}
          onError={async (error) => { fail(error); await refresh(); }} onCancel={() => { setCreating(false); setFilters({ task: null }); }} />}
        <Panel title="分配确认">
          <p className="mb-2 text-xs text-slate-500">每位组员确认分给自己的任务；任务改动后，相关的人需要重新确认。</p>
          <ul className="space-y-1 text-sm">{data.confirmations.map((c) => <li key={c.user.id} className="flex items-center justify-between gap-2" data-testid="plan-confirmation">
            <span>{c.user.name ?? "组员"}<span className="ml-1 text-xs text-slate-500">（{c.task_count} 个任务）</span></span>
            <span className={c.state === "confirmed" ? "text-emerald-700" : c.state === "stale" ? "text-amber-700" : "text-slate-500"}>{confirmLabel[c.state]}</span>
          </li>)}</ul>
          {me && data.can_edit && me.state !== "confirmed" && <button type="button" className={`${button} mt-3`} disabled={confirm.isPending} onClick={() => confirm.mutate(data)}><Check size={14} />确认我的分配</button>}
        </Panel>
        {data.history.length > 0 && <Panel title="计划版本">
          <ul className="space-y-1 text-sm text-slate-600">{data.history.map((h) => <li key={h.id}>v{h.version_no} · {h.status === "frozen" ? "已冻结" : h.status === "archived" ? "已解锁（历史）" : "草稿"}{h.frozen_at ? ` · 冻结于 ${h.frozen_at.slice(0, 16).replace("T", " ")}` : ""}</li>)}</ul>
          {data.baseline_version_no && <p className="mt-2 text-xs text-slate-500">基于需求基线 v{data.baseline_version_no}</p>}
        </Panel>}
      </div>
    </div>
  </div>;
}

function Stat({ label: name, value, warn, note }: { label: string; value: string; warn?: boolean; note?: string }) {
  return <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{name}</div><div className={`text-xl font-semibold ${warn ? "text-amber-700" : "text-slate-900"}`}>{value}</div>{note && <div className="text-xs text-slate-400">{note}</div>}</div>;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Checks({ legend, options, value, onChange, disabled }: { legend: string; options: { id: string; name: string }[]; value: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  return <fieldset><legend className={label}>{legend}</legend>
    {options.length === 0 ? <p className="text-xs text-slate-400">没有可选项</p>
      : <div className="max-h-32 space-y-1 overflow-y-auto rounded border border-slate-200 p-2">{options.map((o) => <label key={o.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.includes(o.id)} disabled={disabled} onChange={() => onChange(toggle(value, o.id))} />{o.name}</label>)}</div>}
  </fieldset>;
}

function TaskEditor({ projectId, plan, task, onSaved, onError, onCancel }: {
  projectId: string; plan: BPlan; task?: BPlanTask;
  onSaved: (task: BPlanTask | undefined, message: string) => void; onError: (error: unknown) => void; onCancel: () => void;
}) {
  const { userId } = useWorkspace();
  const [form, setForm] = useState<BTaskInput>(() => ({
    title: task?.title ?? "", description: task?.description ?? "", module_id: task?.module_id ?? plan.modules[0]?.id ?? "",
    parent_task_id: task?.parent_task_id ?? null, requirement_ids: task?.requirement_ids ?? [], assignee_ids: task?.assignees.map((a) => a.id) ?? [],
    dependency_ids: task?.dependency_ids ?? [], milestone_ids: task?.milestone_ids ?? [], priority: task?.priority ?? "medium", weight: task?.weight ?? 10,
    criteria: task?.criteria.map((c) => ({ id: c.id, text: c.text })) ?? [{ text: "" }],
  }));
  const [showHistory, setShowHistory] = useState(false);
  const readOnly = !plan.can_edit;
  const set = (patch: Partial<BTaskInput>) => setForm((current) => ({ ...current, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, title: form.title.trim(), criteria: form.criteria.filter((c) => c.text.trim()) };
      return task ? bPlanningApi.updateTask(projectId, task, body) : bPlanningApi.createTask(projectId, body);
    },
    onSuccess: (saved) => onSaved(saved, task ? `已保存 ${saved.code ?? "任务"}（v${saved.content_version}）。` : `已新建 ${saved.code ?? "任务"}。`),
    onError,
  });
  const remove = useMutation({ mutationFn: () => bPlanningApi.deleteTask(projectId, task!), onSuccess: () => onSaved(undefined, "任务已删除。"), onError });
  const versions = useQuery({ queryKey: ["b-plan-task-versions", userId, projectId, task?.id, task?.content_version], queryFn: () => bPlanningApi.versions(projectId, task!.id), enabled: Boolean(task && showHistory), ...queryPolicy });
  const others = plan.tasks.filter((t) => t.id !== task?.id).map((t) => ({ id: t.id, name: `${t.code ?? ""} ${t.title}`.trim() }));
  const recheck = new Set(task?.criteria.filter((c) => c.needs_recheck).map((c) => c.id));

  return <Panel title={task ? `${task.code ?? "任务"} · ${readOnly ? "查看" : "编辑"}` : "新建任务"} action={<button type="button" aria-label="关闭" className="text-slate-400 hover:text-slate-700" onClick={onCancel}><X size={16} /></button>}>
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div><label className={label} htmlFor="plan-task-title">任务名称</label><input id="plan-task-title" className={input} value={form.title} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} required maxLength={240} /></div>
      <div><label className={label} htmlFor="plan-task-desc">说明</label><textarea id="plan-task-desc" className={input} rows={2} value={form.description} disabled={readOnly} onChange={(e) => set({ description: e.target.value })} /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className={label} htmlFor="plan-task-module">所属模块</label><select id="plan-task-module" className={input} value={form.module_id} disabled={readOnly} onChange={(e) => set({ module_id: e.target.value })}>{plan.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        <div><label className={label} htmlFor="plan-task-parent">父任务</label><select id="plan-task-parent" className={input} value={form.parent_task_id ?? ""} disabled={readOnly} onChange={(e) => set({ parent_task_id: e.target.value || null })}><option value="">无（顶层任务）</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div><label className={label} htmlFor="plan-task-priority">优先级</label><select id="plan-task-priority" className={input} value={form.priority} disabled={readOnly} onChange={(e) => set({ priority: e.target.value as BPriority })}>{Object.entries(priorityLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label className={label} htmlFor="plan-task-weight">权重（1–100）</label><input id="plan-task-weight" type="number" min={1} max={100} className={input} value={form.weight} disabled={readOnly} onChange={(e) => set({ weight: Number(e.target.value) })} /></div>
      </div>
      <Checks legend="负责人" options={plan.members.map((m) => ({ id: m.id, name: m.name ?? "组员" }))} value={form.assignee_ids} onChange={(v) => set({ assignee_ids: v })} disabled={readOnly} />
      <Checks legend="关联需求" options={plan.requirements.map((r) => ({ id: r.id, name: `${r.code ?? ""} ${r.name}`.trim() }))} value={form.requirement_ids} onChange={(v) => set({ requirement_ids: v })} disabled={readOnly} />
      <Checks legend="前置任务" options={others} value={form.dependency_ids} onChange={(v) => set({ dependency_ids: v })} disabled={readOnly} />
      <Checks legend="里程碑" options={plan.milestones} value={form.milestone_ids} onChange={(v) => set({ milestone_ids: v })} disabled={readOnly} />
      <fieldset><legend className={label}>验收标准（至少一条）</legend>
        <div className="space-y-2">{form.criteria.map((c, index) => <div key={c.id ?? `new-${index}`} className="flex items-start gap-2">
          <input aria-label={`验收标准 ${index + 1}`} className={input} value={c.text} disabled={readOnly} onChange={(e) => set({ criteria: form.criteria.map((item, i) => (i === index ? { ...item, text: e.target.value } : item)) })} />
          {c.id && recheck.has(c.id) && <span className="mt-2 whitespace-nowrap text-xs text-amber-700">需要重新检查</span>}
          {!readOnly && <button type="button" aria-label={`删除验收标准 ${index + 1}`} className="mt-2 text-slate-400 hover:text-red-600" onClick={() => set({ criteria: form.criteria.filter((_, i) => i !== index) })}><Trash2 size={14} /></button>}
        </div>)}</div>
        {!readOnly && <button type="button" className="mt-2 text-sm text-blue-700" onClick={() => set({ criteria: [...form.criteria, { text: "" }] })}>+ 添加一条</button>}
      </fieldset>
      {!readOnly && <div className="flex flex-wrap gap-2">
        <button type="submit" className={button} disabled={save.isPending}>{task ? "保存任务" : "新建任务"}</button>
        {task && <button type="button" className={secondary} disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={14} />删除</button>}
      </div>}
    </form>
    {task && <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between text-xs text-slate-500"><span>当前版本 v{task.content_version}</span><button type="button" className="inline-flex items-center gap-1 text-blue-700" onClick={() => setShowHistory((v) => !v)}><History size={13} />{showHistory ? "收起历史" : "查看历史版本"}</button></div>
      {showHistory && (versions.isPending ? <p className="mt-2 text-xs text-slate-500">加载中…</p>
        : versions.isError ? <p className="mt-2 text-xs text-red-600">历史版本加载失败</p>
        : <ol className="mt-2 space-y-1 text-xs text-slate-600">{versions.data.map((v) => <li key={v.version_no}>v{v.version_no} · {String(v.snapshot.title ?? "")} · 权重 {String(v.snapshot.weight ?? "")} · {v.created_by?.name ?? "组员"} · {v.created_at.slice(0, 16).replace("T", " ")}</li>)}</ol>)}
      <Link className="mt-2 inline-block text-xs text-blue-700 underline" href={task.href}>打开任务执行页</Link>
    </div>}
  </Panel>;
}

function SuggestionsPanel({ projectId, plan, onNotice, onChanged }: { projectId: string; plan: BPlan; onNotice: (n: Notice) => void; onChanged: () => Promise<unknown> }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const list = useQuery({ queryKey: ["b-plan-suggestions", userId, projectId], queryFn: () => bPlanningApi.suggestions(projectId), enabled: plan.baseline_frozen, ...queryPolicy });
  const fail = (error: unknown) => onNotice({ tone: "error", text: errorText(error) });
  const generate = useMutation({
    mutationFn: () => bPlanningApi.generate(projectId),
    onSuccess: async (batch) => { onNotice({ tone: "info", text: `新增 ${batch.created} 条建议${batch.duplicates ? `，${batch.duplicates} 条与已有建议重复已跳过` : ""}。采纳后才会进入计划。` }); await onChanged(); },
    onError: fail,
  });
  const adopt = useMutation({ mutationFn: (id: string) => bPlanningApi.adopt(projectId, id, 1), onSuccess: async (task) => { onNotice({ tone: "success", text: `已采纳为 ${task.code ?? "任务"}，请补充负责人和权重。` }); await onChanged(); }, onError: fail });
  const dismiss = useMutation({ mutationFn: (id: string) => bPlanningApi.dismiss(projectId, id), onSuccess: () => onChanged(), onError: fail });
  if (!plan.baseline_frozen) return null;
  const items = list.data ?? [];
  return <Panel title="AI 任务建议" action={plan.can_edit && <button type="button" className={secondary} disabled={generate.isPending} onClick={() => generate.mutate()}><Sparkles size={14} />{generate.isPending ? "生成中…" : "生成建议"}</button>}>
    <p className="mb-2 text-xs text-slate-500">建议只列在这里，不会自动进入计划，也不会改动已有任务；逐条采纳或忽略。</p>
    {list.isPending ? <p className="text-sm text-slate-500">加载中…</p>
      : list.isError ? <Feedback tone="error">{errorText(list.error)}</Feedback>
      : items.length === 0 ? <p className="text-sm text-slate-500">暂无待处理的建议。</p>
      : <ul className="space-y-3">{items.map((s) => <li key={s.id} className="rounded border border-slate-200 p-3" data-testid="plan-suggestion">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-900">{s.title}</span>{s.is_placeholder && <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-700">示例结果</span>}</div>
        <div className="mt-1 text-xs text-slate-500">对应需求 {s.requirement_code ?? ""} {s.requirement_title}</div>
        <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">{s.acceptance_criteria.map((c) => <li key={c}>{c}</li>)}</ul>
        {plan.can_edit && <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={adopt.isPending} onClick={() => adopt.mutate(s.id)}>采纳</button><button type="button" className={secondary} disabled={dismiss.isPending} onClick={() => dismiss.mutate(s.id)}>忽略</button></div>}
      </li>)}</ul>}
  </Panel>;
}
