"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, History, Lock, Plus, Sparkles, Trash2, Unlock, X } from "lucide-react";
import { Avatar, EmptyState, Feedback, Panel, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bPlanningApi, type BPlan, type BPlanIssue, type BPlanTask, type BTaskInput } from "@/lib/api/b-planning";
import type { BPriority } from "@/lib/api/b-requirements";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { useUiText } from "@/lib/i18n/use-ui-text";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string; items?: string[] } | undefined;

const priorityLabel: Record<BPriority, string> = { high: "高", medium: "中", low: "低" };
const statusLabel: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" };
const confirmLabel = { confirmed: "已确认", stale: "分配有变化，需重新确认", pending: "未确认" } as const;
const filterSchema = { task: { kind: "string" } } as const;
const cardClass = "rounded-2xl border border-slate-200/85 bg-white shadow-xs";
const compactBtn = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const compactSecondary = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

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

function errorItems(error: unknown, tr: ReturnType<typeof useUiText>): string[] {
  if (!(error instanceof BApiError)) return [];
  const issues = (error.details.issues as BPlanIssue[] | undefined) ?? [];
  const unconfirmed = (error.details.unconfirmed as { name: string | null }[] | undefined) ?? [];
  return [...issues.map((i) => i.message), ...unconfirmed.map((u) => tr("{0} 还没确认任务分配", { 0: u.name ?? tr("组员") }))];
}

/** Page 10 (B5-01 ~ B5-05): shared task plan draft, AI suggestions, confirmation, freeze and unlock. */
export function PlanningApiPage({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const client = useQueryClient();
  const { filters, setFilters } = useUrlFilters(filterSchema);
  const [notice, setNotice] = useState<Notice>();
  const [creating, setCreating] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(false);

  const planKey = ["b-plan", userId, projectId];
  const plan = useQuery({ queryKey: planKey, queryFn: () => bPlanningApi.plan(projectId), ...queryPolicy });
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: planKey }),
    client.invalidateQueries({ queryKey: ["b-plan-suggestions", userId, projectId] }),
    client.invalidateQueries({ queryKey: ["b-tasks", userId, projectId] }),
  ]);
  const fail = (error: unknown) => setNotice({ tone: "error", text: errorText(error), items: errorItems(error, tr) });
  const freeze = useMutation({
    mutationFn: (current: BPlan) => bPlanningApi.freeze(projectId, current),
    onSuccess: async () => { setNotice({ tone: "success", text: tr("任务计划已冻结，全组都收到了通知。") }); await refresh(); },
    onError: fail,
  });
  const unlock = useMutation({
    mutationFn: (current: BPlan) => bPlanningApi.unlock(projectId, current, unlockReason.trim()),
    onSuccess: async () => { setUnlockOpen(false); setUnlockReason(""); setNotice({ tone: "info", text: tr("计划已解锁，已生成新草稿；所有人需要重新确认分配。") }); await refresh(); },
    onError: fail,
  });
  const confirm = useMutation({
    mutationFn: (current: BPlan) => bPlanningApi.confirm(projectId, current.my_task_versions),
    onSuccess: async () => { setNotice({ tone: "success", text: tr("已确认你的任务分配。") }); await refresh(); },
    onError: async (error) => { fail(error); await refresh(); },
  });

  if (plan.isPending) return <div role="status" className="gp-empty">{tr("正在加载任务计划…")}</div>;
  if (plan.isError) return <div role="alert"><Feedback tone="error">{errorText(plan.error)}</Feedback></div>;
  const data = plan.data;
  const frozen = data.status === "frozen";
  const selected = data.tasks.find((t) => t.id === filters.task);
  const unassigned = data.tasks.filter((t) => t.assignees.length === 0).length;
  const me = data.confirmations.find((c) => c.user.id === userId);
  const badge = data.status === "none" ? tr("还没有计划") : tr("计划 v{0} · {1}", { 0: data.version_no, 1: frozen ? tr("已冻结") : tr("草稿") });

  return <div className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="gp-page-title">{tr("任务计划")}</h1>
          <StatusBadge tone={frozen ? "green" : data.status === "draft" ? "blue" : "gray"} label={badge} />
        </div>
        <p className="gp-page-description">{tr("与队友一起拆解任务、写明验收标准并分配负责人；全员确认并冻结计划后，即可进入任务执行与提交验收。")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {data.can_lead && data.status === "draft" && (
          <button type="button" className={button} disabled={freeze.isPending} onClick={() => freeze.mutate(data)}>
            <Lock size={14} />{tr("冻结计划")}
          </button>
        )}
        {data.can_lead && frozen && (
          <button type="button" className={secondary} onClick={() => setUnlockOpen(true)}>
            <Unlock size={14} />{tr("解锁修改")}
          </button>
        )}
        <Link href={`/projects/${projectId}`} className={secondary}>{tr("项目总览")}</Link>
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <nav aria-label={tr("任务视图")} className="gp-segmented">
        <Link href={`/projects/${projectId}/tasks?view=tree`} className="gp-segmented-item">{tr("任务树")}</Link>
        <Link href={`/projects/${projectId}/tasks?view=board`} className="gp-segmented-item">{tr("看板")}</Link>
        <Link href={`/projects/${projectId}/tasks?view=list`} className="gp-segmented-item">{tr("列表")}</Link>
        <Link href={`/projects/${projectId}/tasks?view=plan`} aria-current="page" data-active="true" className="gp-segmented-item">{tr("规划")}</Link>
      </nav>
      {data.baseline_version_no && <span className="text-xs text-slate-400">{tr("基于需求基线 v{0}", { 0: data.baseline_version_no })}</span>}
    </div>

    <div className={`${cardClass} grid grid-cols-2 divide-y divide-slate-100 px-4 py-2.5 md:grid-cols-4 md:divide-x md:divide-y-0`}>
      <div className="flex items-baseline justify-between gap-2 py-0.5 md:pr-4">
        <span className="text-xs text-slate-500">{tr("任务")}</span>
        <span className="text-sm font-bold tabular-nums text-slate-900">{data.tasks.length}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2 py-0.5 md:px-4">
        <span className="text-xs text-slate-500">{tr("未分配负责人")}</span>
        <span className={`text-sm font-bold tabular-nums ${unassigned > 0 ? "text-amber-600" : "text-slate-900"}`}>{unassigned}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2 py-0.5 md:px-4">
        <span className="text-xs text-slate-500">{tr("顶层权重合计")}</span>
        <span className="flex items-baseline gap-1.5">
          <span className={`text-sm font-bold tabular-nums ${data.tasks.length > 0 && data.root_weight_total !== 100 ? "text-amber-600" : "text-slate-900"}`}>{data.root_weight_total}</span>
          <span className="text-[10px] text-slate-400">{tr("冻结前必须是 100")}</span>
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2 py-0.5 md:pl-4">
        <span className="text-xs text-slate-500">{tr("待处理问题")}</span>
        <span className={`text-sm font-bold tabular-nums ${data.issues.length > 0 ? "text-amber-600" : "text-emerald-700"}`}>{data.issues.length}</span>
      </div>
    </div>

    {!tipDismissed && (
      <div className="space-y-2">
        {data.baseline_required && !data.baseline_frozen && (
          <Feedback tone="warning">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{tr("课程项目需要先确认需求基线，才能制定正式任务计划。")}<Link className="ml-2 underline" href={`/projects/${projectId}/requirements`}>{tr("前往需求工作区")}</Link></span>
              <button type="button" className="text-xs opacity-70 hover:opacity-100" onClick={() => setTipDismissed(true)}>{tr("收起")}</button>
            </div>
          </Feedback>
        )}
        {!data.baseline_required && !data.baseline_frozen && (
          <Feedback tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{tr("个人项目不要求冻结需求基线，可以直接制定任务计划。需求可随项目推进继续补充。")}<Link className="ml-2 underline" href={`/projects/${projectId}/requirements`}>{tr("整理需求（可选）")}</Link></span>
              <button type="button" className="text-xs opacity-70 hover:opacity-100" onClick={() => setTipDismissed(true)}>{tr("收起")}</button>
            </div>
          </Feedback>
        )}
        {frozen && (
          <Feedback tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{tr("计划已冻结，任务只读。{0}", { 0: data.can_lead ? tr("需要修改时请解锁并写明原因。") : tr("需要修改时请联系组长解锁。") })}</span>
              <button type="button" className="text-xs opacity-70 hover:opacity-100" onClick={() => setTipDismissed(true)}>{tr("收起")}</button>
            </div>
          </Feedback>
        )}
      </div>
    )}

    {notice && (
      <div data-testid="plan-notice" role={notice.tone === "error" ? "alert" : "status"}>
        <Feedback tone={notice.tone}>
          {notice.text}
          {notice.items && notice.items.length > 0 && (
            <ul className="mt-1 list-disc pl-5">{notice.items.map((item) => <li key={item}>{item}</li>)}</ul>
          )}
        </Feedback>
      </div>
    )}

    {unlockOpen && (
      <Panel title={tr("解锁任务计划")}>
        <label className={label} htmlFor="plan-unlock-reason">{tr("解锁原因（必填，全组都会看到）")}</label>
        <textarea id="plan-unlock-reason" className={input} rows={2} value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <button type="button" className={button} disabled={unlock.isPending} onClick={() => unlock.mutate(data)}>{tr("确认解锁")}</button>
          <button type="button" className={secondary} onClick={() => setUnlockOpen(false)}>{tr("取消")}</button>
        </div>
      </Panel>
    )}

    <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.35fr)_400px]">
      <div className="space-y-3.5">
        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">{tr("任务")}</h2>
            {data.can_edit && (
              <button type="button" className={compactSecondary} onClick={() => { setCreating(true); setFilters({ task: null }); }}>
                <Plus size={13} />{tr("新建任务")}
              </button>
            )}
          </div>
          {data.tasks.length === 0 ? (
            <div className="p-4"><EmptyState title={tr("还没有任务")} description={data.can_edit ? tr("新建任务，或先生成 AI 建议再逐条采纳。") : undefined} /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                  <tr>
                    <th className="px-3.5 py-2">{tr("任务")}</th>
                    <th className="whitespace-nowrap px-3 py-2">{tr("负责人")}</th>
                    <th className="whitespace-nowrap px-2.5 py-2">{tr("权重")}</th>
                    <th className="whitespace-nowrap px-2.5 py-2">{tr("标准")}</th>
                    <th className="whitespace-nowrap px-2.5 py-2">{tr("状态")}</th>
                    <th className="whitespace-nowrap px-3 py-2 text-right">{tr("版本")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {treeOrder(data.tasks).map(({ task, depth }) => (
                    <tr
                      key={task.id}
                      aria-selected={task.id === filters.task}
                      className={`cursor-pointer transition-colors ${task.id === filters.task ? "bg-sky-50/85" : "hover:bg-slate-50/80"}`}
                      onClick={() => { setCreating(false); setFilters({ task: task.id }); }}
                    >
                      <td className="px-3.5 py-2" style={{ paddingLeft: 14 + depth * 18 }}>
                        <span className="mr-1.5 whitespace-nowrap font-mono text-xs text-slate-500">{task.code ?? "—"}</span>
                        <span className="font-medium text-slate-900">{task.title}</span>
                        {task.origin === "ai" && <span className="ml-1.5 rounded bg-sky-50 px-1 py-0.5 text-[10px] font-medium text-sky-700">AI</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{task.assignees.map((a) => a.name ?? tr("组员")).join("、") || <span className="text-amber-700">{tr("未分配")}</span>}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 tabular-nums text-slate-600">{task.weight}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 tabular-nums text-slate-600">{task.criteria.length || <span className="text-amber-700">0</span>}</td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-slate-600">{tr(statusLabel[task.status]) ?? task.status}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-500">v{task.content_version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {data.issues.length > 0 && (
          <div className="rounded-xl border border-amber-200/90 bg-amber-50/75 px-3.5 py-2.5 text-xs text-amber-900">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle size={13} className="shrink-0 text-amber-600" />
                <span>{tr("冻结前要处理的问题（{0}）", { 0: data.issues.length })}</span>
              </div>
              <button type="button" className="text-[11px] font-medium text-amber-800 hover:underline" onClick={() => setIssuesOpen((v) => !v)}>
                {issuesOpen ? tr("收起") : tr("展开")}
              </button>
            </div>
            {issuesOpen && (
              <ul className="mt-1.5 space-y-1 text-amber-800">
                {data.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.task_id}-${index}`} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                    <span>{issue.message}</span>
                    {issue.task_id && data.tasks.some((t) => t.id === issue.task_id) && (
                      <button type="button" className="font-medium text-sky-700 underline" onClick={() => setFilters({ task: issue.task_id })}>{tr("查看")}</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <SuggestionsPanel projectId={projectId} plan={data} onNotice={setNotice} onChanged={refresh} />
      </div>

      <div className="space-y-3.5">
        {(creating || selected) && (
          <TaskEditor
            key={selected ? `${selected.id}:${selected.content_version}` : "new"}
            projectId={projectId}
            plan={data}
            task={creating ? undefined : selected}
            onSaved={async (task, message) => { setCreating(false); setFilters({ task: task?.id ?? null }); setNotice({ tone: "success", text: message }); await refresh(); }}
            onError={async (error) => { fail(error); await refresh(); }}
            onCancel={() => { setCreating(false); setFilters({ task: null }); }}
          />
        )}

        <section className={`${cardClass} p-4`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{tr("分配确认")}</h2>
            <span className="text-xs text-slate-400">
              {data.confirmations.filter((c) => c.state === "confirmed").length}/{data.confirmations.length}
            </span>
          </div>
          <p className="mb-2.5 text-[11px] text-slate-500">{tr("每位组员确认分给自己的任务；任务改动后，相关的人需要重新确认。")}</p>
          <ul className="space-y-1.5 text-xs">
            {data.confirmations.map((c) => {
              const name = c.user.name ?? tr("组员");
              return (
                <li key={c.user.id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/50 px-2.5 py-2" data-testid="plan-confirmation">
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar name={name} size={22} />
                    <span className="truncate font-medium text-slate-800">{name}</span>
                    <span className="text-[11px] text-slate-400">{tr("（{0} 个任务）", { 0: c.task_count })}</span>
                  </span>
                  <span className={`shrink-0 font-medium ${c.state === "confirmed" ? "text-emerald-700" : c.state === "stale" ? "text-amber-700" : "text-slate-500"}`}>
                    {tr(confirmLabel[c.state])}
                  </span>
                </li>
              );
            })}
          </ul>
          {me && data.can_edit && me.state !== "confirmed" && (
            <button type="button" className={`${button} mt-3 w-full`} disabled={confirm.isPending} onClick={() => confirm.mutate(data)}>
              <Check size={14} />{tr("确认我的分配")}
            </button>
          )}
        </section>

        {data.history.length > 0 && (
          <section className={`${cardClass} overflow-hidden`}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold text-slate-800 hover:bg-slate-50/70"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <span className="flex items-center gap-1.5">
                {historyOpen ? <ChevronDown size={13} className="text-slate-400" /> : <ChevronRight size={13} className="text-slate-400" />}
                {tr("计划版本")} ({data.history.length})
              </span>
              {data.baseline_version_no && <span className="font-normal text-slate-400">{tr("基于需求基线 v{0}", { 0: data.baseline_version_no })}</span>}
            </button>
            {historyOpen && (
              <div className="border-t border-slate-100 px-4 py-2.5">
                <ul className="space-y-1 text-xs text-slate-600">
                  {data.history.map((h) => (
                    <li key={h.id}>
                      v{h.version_no} · {h.status === "frozen" ? tr("已冻结") : h.status === "archived" ? tr("已解锁（历史）") : tr("草稿")}
                      {h.frozen_at ? tr(" · 冻结于 {0}", { 0: h.frozen_at.slice(0, 16).replace("T", " ") }) : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  </div>;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Checks({ legend, options, value, onChange, disabled }: { legend: string; options: { id: string; name: string }[]; value: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  const tr = useUiText();
  return <fieldset>
    <legend className={label}>{legend}</legend>
    {options.length === 0 ? (
      <p className="text-xs text-slate-400">{tr("没有可选项")}</p>
    ) : (
      <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={value.includes(o.id)} disabled={disabled} onChange={() => onChange(toggle(value, o.id))} />
            {o.name}
          </label>
        ))}
      </div>
    )}
  </fieldset>;
}

function TaskEditor({ projectId, plan, task, onSaved, onError, onCancel }: {
  projectId: string; plan: BPlan; task?: BPlanTask;
  onSaved: (task: BPlanTask | undefined, message: string) => void; onError: (error: unknown) => void; onCancel: () => void;
}) {
  const tr = useUiText();
  const { userId } = useWorkspace();
  const [form, setForm] = useState<BTaskInput>(() => ({
    title: task?.title ?? "",
    description: task?.description ?? "",
    module_id: task?.module_id ?? plan.modules[0]?.id ?? "",
    parent_task_id: task?.parent_task_id ?? null,
    requirement_ids: task?.requirement_ids ?? [],
    assignee_ids: task?.assignees.map((a) => a.id) ?? [],
    dependency_ids: task?.dependency_ids ?? [],
    milestone_ids: task?.milestone_ids ?? [],
    priority: task?.priority ?? "medium",
    weight: task?.weight ?? 10,
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
    onSuccess: (saved) => onSaved(saved, task ? tr("已保存 {0}（v{1}）。", { 0: saved.code ?? tr("任务"), 1: saved.content_version }) : tr("已新建 {0}。", { 0: saved.code ?? tr("任务") })),
    onError,
  });
  const remove = useMutation({ mutationFn: () => bPlanningApi.deleteTask(projectId, task!), onSuccess: () => onSaved(undefined, tr("任务已删除。")), onError });
  const versions = useQuery({ queryKey: ["b-plan-task-versions", userId, projectId, task?.id, task?.content_version], queryFn: () => bPlanningApi.versions(projectId, task!.id), enabled: Boolean(task && showHistory), ...queryPolicy });
  const others = plan.tasks.filter((t) => t.id !== task?.id).map((t) => ({ id: t.id, name: `${t.code ?? ""} ${t.title}`.trim() }));
  const recheck = new Set(task?.criteria.filter((c) => c.needs_recheck).map((c) => c.id));

  return <section className={`${cardClass} p-4`}>
    <div className="mb-3 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
      <h2 className="text-sm font-semibold text-slate-900">{task ? tr("{0} · {1}", { 0: task.code ?? tr("任务"), 1: readOnly ? tr("查看") : tr("编辑") }) : tr("新建任务")}</h2>
      <button type="button" aria-label={tr("关闭")} className="text-slate-400 hover:text-slate-700" onClick={onCancel}><X size={15} /></button>
    </div>
    <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div><label className={label} htmlFor="plan-task-title">{tr("任务名称")}</label><input id="plan-task-title" className={input} value={form.title} disabled={readOnly} onChange={(e) => set({ title: e.target.value })} required maxLength={240} /></div>
      <div><label className={label} htmlFor="plan-task-desc">{tr("说明")}</label><textarea id="plan-task-desc" className={input} rows={2} value={form.description} disabled={readOnly} onChange={(e) => set({ description: e.target.value })} /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className={label} htmlFor="plan-task-module">{tr("所属模块")}</label><select id="plan-task-module" className={input} value={form.module_id} disabled={readOnly} onChange={(e) => set({ module_id: e.target.value })}>{plan.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        <div><label className={label} htmlFor="plan-task-parent">{tr("父任务")}</label><select id="plan-task-parent" className={input} value={form.parent_task_id ?? ""} disabled={readOnly} onChange={(e) => set({ parent_task_id: e.target.value || null })}><option value="">{tr("无（顶层任务）")}</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div><label className={label} htmlFor="plan-task-priority">{tr("优先级")}</label><select id="plan-task-priority" className={input} value={form.priority} disabled={readOnly} onChange={(e) => set({ priority: e.target.value as BPriority })}>{Object.entries(priorityLabel).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}</select></div>
        <div><label className={label} htmlFor="plan-task-weight">{tr("权重（1–100）")}</label><input id="plan-task-weight" type="number" min={1} max={100} className={input} value={form.weight} disabled={readOnly} onChange={(e) => set({ weight: Number(e.target.value) })} /></div>
      </div>
      <Checks legend={tr("负责人")} options={plan.members.map((m) => ({ id: m.id, name: m.name ?? tr("组员") }))} value={form.assignee_ids} onChange={(v) => set({ assignee_ids: v })} disabled={readOnly} />
      <Checks legend={tr("关联需求")} options={plan.requirements.map((r) => ({ id: r.id, name: `${r.code ?? ""} ${r.name}`.trim() }))} value={form.requirement_ids} onChange={(v) => set({ requirement_ids: v })} disabled={readOnly} />
      <Checks legend={tr("前置任务")} options={others} value={form.dependency_ids} onChange={(v) => set({ dependency_ids: v })} disabled={readOnly} />
      <Checks legend={tr("里程碑")} options={plan.milestones} value={form.milestone_ids} onChange={(v) => set({ milestone_ids: v })} disabled={readOnly} />
      <fieldset>
        <legend className={label}>{tr("验收标准（至少一条）")}</legend>
        <div className="space-y-1.5">
          {form.criteria.map((c, index) => (
            <div key={c.id ?? `new-${index}`} className="flex items-start gap-1.5">
              <input aria-label={tr("验收标准 {0}", { 0: index + 1 })} className={input} value={c.text} disabled={readOnly} onChange={(e) => set({ criteria: form.criteria.map((item, i) => (i === index ? { ...item, text: e.target.value } : item)) })} />
              {c.id && recheck.has(c.id) && <span className="mt-2 whitespace-nowrap text-[11px] text-amber-700">{tr("需要重新检查")}</span>}
              {!readOnly && <button type="button" aria-label={tr("删除验收标准 {0}", { 0: index + 1 })} className="mt-2 text-slate-400 hover:text-red-600" onClick={() => set({ criteria: form.criteria.filter((_, i) => i !== index) })}><Trash2 size={14} /></button>}
            </div>
          ))}
        </div>
        {!readOnly && <button type="button" className="mt-1.5 text-xs font-medium text-sky-700 hover:underline" onClick={() => set({ criteria: [...form.criteria, { text: "" }] })}>{tr("+ 添加一条")}</button>}
      </fieldset>
      {!readOnly && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" className={button} disabled={save.isPending}>{task ? tr("保存任务") : tr("新建任务")}</button>
          {task && <button type="button" className={secondary} disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={14} />{tr("删除")}</button>}
        </div>
      )}
    </form>
    {task && (
      <div className="mt-3 border-t border-slate-100 pt-2.5 text-xs">
        <div className="flex items-center justify-between text-slate-500">
          <span>{tr("当前版本 v{0}", { 0: task.content_version })}</span>
          <button type="button" className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline" onClick={() => setShowHistory((v) => !v)}>
            <History size={12} />{showHistory ? tr("收起历史") : tr("查看历史版本")}
          </button>
        </div>
        {showHistory && (versions.isPending ? <p className="mt-2 text-slate-500">{tr("加载中…")}</p>
          : versions.isError ? <p className="mt-2 text-red-600">{tr("历史版本加载失败")}</p>
          : <ol className="mt-2 space-y-1 text-slate-600">{versions.data.map((v) => <li key={v.version_no}>{tr("v{0} · {1} · 权重 {2} · {3} · {4}", { 0: v.version_no, 1: String(v.snapshot.title ?? ""), 2: String(v.snapshot.weight ?? ""), 3: v.created_by?.name ?? tr("组员"), 4: v.created_at.slice(0, 16).replace("T", " ") })}</li>)}</ol>)}
        <Link className="mt-2 inline-block font-medium text-sky-700 hover:underline" href={task.href}>{tr("打开任务执行页")}</Link>
      </div>
    )}
  </section>;
}

function SuggestionsPanel({ projectId, plan, onNotice, onChanged }: { projectId: string; plan: BPlan; onNotice: (n: Notice) => void; onChanged: () => Promise<unknown> }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const baselineReady = plan.baseline_frozen || !plan.baseline_required;
  const list = useQuery({ queryKey: ["b-plan-suggestions", userId, projectId], queryFn: () => bPlanningApi.suggestions(projectId), enabled: baselineReady, ...queryPolicy });
  const fail = (error: unknown) => onNotice({ tone: "error", text: errorText(error) });
  const generate = useMutation({
    mutationFn: () => bPlanningApi.generate(projectId),
    onSuccess: async (batch) => { onNotice({ tone: "info", text: tr("新增 {0} 条建议{1}。采纳后才会进入计划。", { 0: batch.created, 1: batch.duplicates ? tr("，{0} 条与已有建议重复已跳过", { 0: batch.duplicates }) : "" }) }); await onChanged(); },
    onError: fail,
  });
  const adopt = useMutation({ mutationFn: (id: string) => bPlanningApi.adopt(projectId, id, 1), onSuccess: async (task) => { onNotice({ tone: "success", text: tr("已采纳为 {0}，请补充负责人和权重。", { 0: task.code ?? tr("任务") }) }); await onChanged(); }, onError: fail });
  const dismiss = useMutation({ mutationFn: (id: string) => bPlanningApi.dismiss(projectId, id), onSuccess: () => onChanged(), onError: fail });
  if (!baselineReady) return null;
  const items = list.data ?? [];
  return <section className={`${cardClass} p-4`}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{tr("AI 任务建议")}</h2>
        <p className="text-[11px] text-slate-400">{tr("建议只列在这里，不会自动进入计划，也不会改动已有任务；逐条采纳或忽略。")}</p>
      </div>
      {plan.can_edit && (
        <button type="button" className={compactSecondary} disabled={generate.isPending} onClick={() => generate.mutate()}>
          <Sparkles size={13} />{generate.isPending ? tr("生成中…") : tr("生成建议")}
        </button>
      )}
    </div>
    {list.isPending ? <p className="text-xs text-slate-500">{tr("加载中…")}</p>
      : list.isError ? <Feedback tone="error">{errorText(list.error)}</Feedback>
      : items.length === 0 ? <p className="text-xs text-slate-400">{tr("暂无待处理的建议。")}</p>
      : <ul className="space-y-2">{items.map((s) => (
        <li key={s.id} className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 text-xs" data-testid="plan-suggestion">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-slate-900">{s.title}</span>
              {s.is_placeholder && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{tr("示例结果")}</span>}
            </div>
            {plan.can_edit && (
              <div className="flex gap-1.5">
                <button type="button" className={compactBtn} disabled={adopt.isPending} onClick={() => adopt.mutate(s.id)}>{tr("采纳")}</button>
                <button type="button" className={compactSecondary} disabled={dismiss.isPending} onClick={() => dismiss.mutate(s.id)}>{tr("忽略")}</button>
              </div>
            )}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{tr("对应需求 {0} {1}", { 0: s.requirement_code ?? "", 1: s.requirement_title })}</div>
          {s.acceptance_criteria.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-slate-600">{s.acceptance_criteria.map((c) => <li key={c}>{c}</li>)}</ul>
          )}
        </li>
      ))}</ul>}
  </section>;
}
