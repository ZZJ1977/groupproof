"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, History, Plus } from "lucide-react";
import { EmptyState, Feedback, PageHeader, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bMilestonesApi, type BDeliverable, type BMilestone, type BMilestoneDetail, type BMilestoneMissing } from "@/lib/api/b-milestones";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { useUiText } from "@/lib/i18n/use-ui-text";

type Notice = { tone: "success" | "error" | "warning"; text: string; items?: string[] } | undefined;

const statusLabel: Record<string, string> = { not_started: "未开始", in_progress: "进行中", completed: "已交付", at_risk: "有风险" };
const taskStatus: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" };
const verifyState: Record<string, string> = { not_submitted: "还没提交验收", in_review: "正在验收", failed: "验收未通过", invalidated: "需要重新验收", unknown: "验收状态未知" };
const when = (value: string | null | undefined) => (value ? value.slice(0, 16).replace("T", " ") : "—");
const cardClass = "rounded-2xl border border-slate-200/85 bg-white shadow-xs";

function Progress({ value }: { value: number | null }) {
  const tr = useUiText();
  if (value === null) return <span className="text-xs text-slate-400">{tr("没有关联任务")}</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-slate-100" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={tr("进度")}>
        <div className={`h-1.5 rounded-full transition-all ${value >= 100 ? "bg-emerald-600" : "bg-[var(--gp-action)]"}`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-9 text-right text-xs font-semibold tabular-nums text-slate-700">{value}%</span>
    </div>
  );
}

const riskLevel: Record<string, { label: string; tone: "red" | "amber" | "gray" }> = {
  high: { label: "高风险", tone: "red" },
  medium: { label: "中风险", tone: "amber" },
  low: { label: "低风险", tone: "gray" },
};
const riskStatus: Record<string, string> = { open: "未处理", mitigating: "处理中" };

/** D owns risk; until D sends data the slot says so instead of guessing. */
function Risk({ risk }: { risk: BMilestone["risk"] }) {
  const tr = useUiText();
  if (!risk) return <p data-testid="milestone-risk" className="text-xs text-slate-400">{tr("风险：暂无数据（由验收模块提供）")}</p>;
  if (!risk.level || risk.open_count === 0) return <p data-testid="milestone-risk" className="flex items-center gap-1.5 text-xs text-slate-500">{tr("风险：")}<span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">{tr("暂无风险")}</span></p>;
  const level = riskLevel[risk.level] ?? riskLevel.low;
  return <p data-testid="milestone-risk" className="flex items-center gap-1.5 text-xs text-slate-600">{tr("风险：")}<StatusBadge tone={level.tone} label={tr(level.label)} /><span>{tr("{0} 项未关闭", { 0: risk.open_count })}</span></p>;
}

/** Page 19: the open risks behind the summary, each with where it is recorded. */
function RiskList({ projectId, risk }: { projectId: string; risk: NonNullable<BMilestone["risk"]> }) {
  const tr = useUiText();
  if (risk.items.length === 0) return <p className="text-xs text-slate-500">{tr("这个里程碑和它的关联任务没有未关闭的风险。")}</p>;
  return <ul className="divide-y divide-slate-100">{risk.items.map((r) => {
    const level = riskLevel[r.level] ?? riskLevel.low;
    return <li key={r.id} data-testid="milestone-risk-item" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 text-xs">
      <StatusBadge tone={level.tone} label={tr(level.label)} />
      <span className="font-medium text-slate-900">{r.title}</span>
      <span className="text-slate-500">{tr(riskStatus[r.status] ?? r.status)}</span>
      <span className="text-slate-500">{r.task ? <>{tr("任务")}<Link className="gp-link" href={`/projects/${projectId}/tasks/${r.task.id}`}>{r.task.code ? `${r.task.code} ${r.task.title}` : r.task.title}</Link></> : tr("里程碑本身")}</span>
      <span className="ml-auto text-slate-400">{tr("负责人 {0} · 处理期限 {1}", { 0: r.owner?.name ?? "—", 1: dateOnly(r.due_at, tr("未设置")) })}</span>
    </li>;
  })}</ul>;
}

function Badge({ m }: { m: BMilestone }) {
  const tr = useUiText();
  return m.overdue
    ? <StatusBadge tone="red" label={tr("已逾期")} />
    : <StatusBadge tone={m.status === "completed" ? "green" : m.status === "in_progress" ? "blue" : "gray"} label={tr(statusLabel[m.status]) ?? m.status} />;
}

/** Page 18 (B7-01): milestones with live progress from linked tasks. */
export function MilestonesApiPage({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["b-milestones", userId, projectId], queryFn: () => bMilestonesApi.list(projectId), ...queryPolicy });
  const items = list.data?.items ?? [];
  const withProgress = items.filter((m) => m.progress_percent !== null);
  const avgProgress = withProgress.length > 0 ? Math.round(withProgress.reduce((s, m) => s + (m.progress_percent ?? 0), 0) / withProgress.length) : 0;
  const doneCount = items.filter((m) => m.status === "completed").length;
  const deliverablesDone = items.reduce((s, m) => s + m.deliverables_done, 0);
  const deliverablesTotal = items.reduce((s, m) => s + m.deliverables_total, 0);

  return <div className="space-y-3">
    <PageHeader
      title={tr("里程碑")}
    />

    {items.length > 0 && (
      <div className={`${cardClass} grid grid-cols-3 divide-x divide-slate-100 px-4 py-2.5`}>
        <div className="flex items-baseline justify-between gap-2 pr-3">
          <span className="text-xs text-slate-500">{tr("阶段里程碑")}</span>
          <span className="text-sm font-bold tabular-nums text-slate-900">
            {items.length}
            <span className="ml-1.5 text-[11px] font-normal text-slate-400">{tr("已交付 {0} 个", { 0: doneCount })}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-2.5 px-3">
          <span className="text-xs text-slate-500">{tr("整体平均进度")}</span>
          <div className="flex flex-1 items-center justify-end gap-2">
            <div className="hidden h-1.5 max-w-24 flex-1 rounded-full bg-slate-100 sm:block">
              <div className="h-1.5 rounded-full bg-[var(--gp-action)]" style={{ width: `${avgProgress}%` }} />
            </div>
            <span className="text-sm font-bold tabular-nums text-slate-900">{avgProgress}%</span>
          </div>
        </div>
        <div className="flex items-baseline justify-between gap-2 pl-3">
          <span className="text-xs text-slate-500">{tr("交付物核验")}</span>
          <span className="text-sm font-bold tabular-nums text-slate-900">
            {deliverablesDone}/{deliverablesTotal}
            <span className="ml-1.5 hidden text-[11px] font-normal text-slate-400 sm:inline">{tr("已勾选交付项")}</span>
          </span>
        </div>
      </div>
    )}

    <div>
      {list.isPending ? (
        <div role="status" className="gp-empty">{tr("正在加载…")}</div>
      ) : list.isError ? (
        <Feedback tone="error">{errorText(list.error)}</Feedback>
      ) : list.data.items.length === 0 ? (
        <div className={`${cardClass} p-6`}><EmptyState title={tr("还没有里程碑")} description={tr("里程碑在项目设置里创建后会显示在这里。")} /></div>
      ) : (
        <div className="grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.data.items.map((m) => {
            const isExpanded = expandedId === m.id;
            return (
              <article
                key={m.id}
                data-testid="milestone-card"
                className="flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-slate-200/85 bg-white p-3.5 shadow-xs transition-shadow hover:shadow-sm"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-semibold text-slate-900" title={m.title}>
                        <Link className="gp-link" href={m.href}>{m.title}</Link>
                      </h2>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{tr("截止 {0}", { 0: dateOnly(m.deadline, tr("未设置")) })}</p>
                    </div>
                    <div className="shrink-0">
                      <Badge m={m} />
                    </div>
                  </div>
                  <Progress value={m.progress_percent} />
                </div>

                <div className="space-y-1.5 border-t border-slate-100 pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span>{tr("任务 {0}/{1} 完成 · 交付物 {2}/{3} 已勾选", { 0: m.completed_task_count, 1: m.task_count, 2: m.deliverables_done, 3: m.deliverables_total })}</span>
                    <div className="flex items-center gap-2">
                      {m.description && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-0.5 text-[11px] text-slate-500 hover:text-slate-800"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedId(isExpanded ? null : m.id)}
                        >
                          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          {isExpanded ? tr("收起") : tr("说明")}
                        </button>
                      )}
                      <Link className="inline-flex items-center gap-0.5 text-[11px] font-medium text-sky-700 hover:underline" href={m.href}>
                        {tr("详情")}<ArrowRight size={11} />
                      </Link>
                    </div>
                  </div>
                  <Risk risk={m.risk} />
                  {isExpanded && m.description && (
                    <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">{m.description}</p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  </div>;
}

function missingItems(error: unknown, tr: ReturnType<typeof useUiText>): string[] {
  if (!(error instanceof BApiError) || error.code !== "MILESTONE_NOT_READY") return [];
  const details = error.details as unknown as BMilestoneMissing;
  return [
    ...(details.tasks ?? []).map((t) => tr("任务 {0} {1}：{2}", { 0: t.code ?? "", 1: t.title, 2: tr(verifyState[t.state] ?? t.state) }).replace("  ", " ")),
    ...(details.deliverables ?? []).map((d) => tr("交付物「{0}」还没勾选", { 0: d.title })),
  ];
}

/** Page 19 (B7-01 ~ B7-04): one milestone; deliverables, stage completion, rescheduling. */
export function MilestoneDetailApiPage({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const client = useQueryClient();
  const [notice, setNotice] = useState<Notice>();
  const [newTitle, setNewTitle] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const key = ["b-milestone", userId, projectId, milestoneId];
  const detail = useQuery({ queryKey: key, queryFn: () => bMilestonesApi.detail(projectId, milestoneId), ...queryPolicy });

  const settle = (data?: BMilestoneDetail) => {
    if (data) client.setQueryData(key, data);
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ["b-milestones", userId, projectId] });
  };
  const fail = (error: unknown) => { setNotice({ tone: "error", text: errorText(error), items: missingItems(error, tr) }); settle(); };
  const add = useMutation({
    mutationFn: () => bMilestonesApi.addDeliverable(projectId, milestoneId, newTitle.trim()),
    onSuccess: (data) => { setNewTitle(""); setNotice({ tone: "success", text: tr("已添加交付物") }); settle(data); },
    onError: fail,
  });
  const check = useMutation({
    mutationFn: ({ item, done }: { item: BDeliverable; done: boolean }) => bMilestonesApi.check(projectId, milestoneId, item, done, done ? files[item.id] ?? item.file?.id : null),
    onSuccess: (data, { item, done }) => { setNotice({ tone: "success", text: done ? tr("已勾选「{0}」", { 0: item.title }) : tr("已取消勾选「{0}」", { 0: item.title }) }); settle(data); },
    onError: fail,
  });
  const complete = useMutation({
    mutationFn: (m: BMilestoneDetail) => bMilestonesApi.complete(projectId, m),
    onSuccess: (data) => { setNotice({ tone: "success", text: tr("阶段交付已确认，已通知课程老师") }); settle(data); },
    onError: fail,
  });
  const reschedule = useMutation({
    mutationFn: (m: BMilestoneDetail) => bMilestonesApi.reschedule(projectId, m, new Date(`${date}T23:59:00`).toISOString(), reason.trim()),
    onSuccess: (data) => { setDate(""); setReason(""); setNotice({ tone: "success", text: tr("已改期到 {0}，已通知老师和全组", { 0: dateOnly(data.deadline, tr("未设置")) }) }); settle(data); },
    onError: fail,
  });

  if (detail.isPending) return <div role="status" className="gp-empty">{tr("正在加载…")}</div>;
  if (detail.isError) return <Feedback tone="error">{errorText(detail.error)}</Feedback>;
  const m = detail.data;
  const locked = m.status === "completed";
  const busy = add.isPending || check.isPending || complete.isPending || reschedule.isPending;

  return <div className="space-y-3.5">
    <PageHeader
      title={m.title}
      description={tr("截止 {0}{1}", { 0: dateOnly(m.deadline, tr("未设置")), 1: m.description ? ` · ${m.description}` : "" })}
      actions={<div className="flex items-center gap-2"><Badge m={m} /><Link href={`/projects/${projectId}/milestones`} className={secondary}>{tr("全部里程碑")}</Link></div>}
    />

    {notice && (
      <div data-testid="milestone-notice">
        <Feedback tone={notice.tone}>
          {notice.text}
          {notice.items?.length ? <ul className="mt-1.5 list-disc pl-5">{notice.items.map((i) => <li key={i}>{i}</li>)}</ul> : null}
        </Feedback>
      </div>
    )}

    <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
      <div className="space-y-3.5">
        <section className={`${cardClass} space-y-2.5 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{tr("进度")}</h2>
            <span className="text-xs text-slate-500">{tr("任务 {0}/{1} 完成", { 0: m.completed_task_count, 1: m.task_count })}</span>
          </div>
          <Progress value={m.progress_percent} />
          <Risk risk={m.risk} />
        </section>

        <section className={`${cardClass} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">{tr("关联任务")}</h2>
            <span className="text-xs text-slate-400">{m.tasks.length}</span>
          </div>
          {m.tasks.length === 0 ? (
            <div className="p-4"><EmptyState title={tr("没有关联任务")} description={tr("在任务计划里给任务选择这个里程碑。")} /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-slate-100 bg-slate-50/70 text-left text-[11px] font-semibold text-slate-500">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-2">{tr("编号")}</th>
                    <th className="px-3 py-2">{tr("任务")}</th>
                    <th className="whitespace-nowrap px-3 py-2">{tr("负责人")}</th>
                    <th className="whitespace-nowrap px-3 py-2">{tr("状态")}</th>
                    <th className="whitespace-nowrap px-4 py-2 text-right">{tr("进度")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {m.tasks.map((t) => (
                    <tr key={t.id} data-testid="milestone-task" className="hover:bg-slate-50/70">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-slate-500">{t.code ?? "—"}</td>
                      <td className="px-3 py-2 font-medium text-slate-900"><Link className="gp-link" href={t.href}>{t.title}</Link></td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{t.assignees.map((a) => a.name ?? tr("组员")).join("、") || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{tr(taskStatus[t.status]) ?? t.status}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums text-slate-700">{t.progress_percent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={`${cardClass} p-4`}>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">{tr("交付物")}</h2>
            <span className="text-xs text-slate-400">{m.deliverables_done}/{m.deliverables_total}</span>
          </div>
          {m.deliverables.length === 0 && <p className="text-xs text-slate-500">{tr("还没有交付物。")}</p>}
          <ul className="divide-y divide-slate-100">
            {m.deliverables.map((d) => (
              <li key={d.id} data-testid="deliverable" className="space-y-1.5 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={d.done} disabled={!m.can_lead || locked || busy} title={!m.can_lead ? tr("只有组长可以勾选") : undefined} onChange={(e) => check.mutate({ item: d, done: e.target.checked })} />
                    <span className={d.done ? "font-medium text-slate-900" : "text-slate-700"}>{d.title}</span>
                  </label>
                  {d.done ? (
                    <span className="text-xs text-slate-500">
                      {tr("{0} 于 {1} 勾选", { 0: d.done_by?.name ?? tr("组长"), 1: when(d.done_at) })}
                      {d.file ? <> {tr("· 文件")}<Link className="gp-link" href={d.file.href}>{d.file.name}</Link></> : null}
                    </span>
                  ) : m.can_lead && !locked && m.files.length > 0 ? (
                    <>
                      <label className="sr-only" htmlFor={`file-${d.id}`}>{tr("关联文件")}</label>
                      <select id={`file-${d.id}`} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs" value={files[d.id] ?? ""} onChange={(e) => setFiles({ ...files, [d.id]: e.target.value })}>
                        <option value="">{tr("不关联文件")}</option>
                        {m.files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </>
                  ) : null}
                  {d.history.length > 0 && (
                    <button type="button" className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" aria-expanded={history === d.id} onClick={() => setHistory(history === d.id ? null : d.id)}>
                      <History size={12} />{tr("记录")}
                    </button>
                  )}
                </div>
                {history === d.id && (
                  <ul data-testid="deliverable-history" className="ml-6 space-y-0.5 text-[11px] text-slate-500">
                    {d.history.map((h, i) => <li key={i}>{when(h.at)} {h.actor?.name ?? tr("组长")} {h.action === "checked" ? tr("勾选") : tr("取消勾选")}{h.file ? `（${h.file.name}）` : ""}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {m.can_lead && !locked && (
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
              <label className="sr-only" htmlFor="b-deliverable-title">{tr("交付物名称")}</label>
              <input id="b-deliverable-title" className={input} placeholder={tr("例如：中期报告")} maxLength={200} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
              <button type="submit" className={secondary} disabled={busy || !newTitle.trim()}><Plus size={14} />{tr("添加")}</button>
            </form>
          )}
          {!m.can_lead && <p className="mt-2 text-xs text-slate-500">{tr("只有组长可以勾选交付物。")}</p>}
        </section>

        {m.risk && (
          <section className={`${cardClass} p-4`}>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">{tr("风险")}</h2>
            <RiskList projectId={projectId} risk={m.risk} />
          </section>
        )}
      </div>

      <div className="space-y-3.5">
        {m.can_lead && !locked && (
          <section className={`${cardClass} space-y-2.5 p-4`}>
            <h2 className="text-sm font-semibold text-slate-900">{tr("确认阶段交付")}</h2>
            <p className="text-xs leading-relaxed text-slate-600">{tr("关联任务全部通过验收、交付物全部勾选后才能确认。确认后会通知课程老师，里程碑不能再修改。")}</p>
            <div className="flex justify-end">
              <button type="button" className={button} disabled={busy} onClick={() => complete.mutate(m)}>
                <CheckCircle2 size={14} />{tr("确认阶段交付")}
              </button>
            </div>
          </section>
        )}

        {m.can_lead && !locked && (
          <section className={`${cardClass} p-4`}>
            <h2 className="mb-2.5 text-sm font-semibold text-slate-900">{tr("改期")}</h2>
            <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); reschedule.mutate(m); }}>
              <div>
                <label className={label} htmlFor="b-ms-date">{tr("新的截止日期")}</label>
                <input id="b-ms-date" type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div>
                <label className={label} htmlFor="b-ms-reason">{tr("改期原因（必填）")}</label>
                <input id="b-ms-reason" className={input} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <button type="submit" className={button} disabled={busy || !date}>
                  <CalendarClock size={14} />{tr("改期")}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className={`${cardClass} p-4`}>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">{tr("改期记录")}</h2>
          {m.date_changes.length === 0 ? (
            <p className="text-xs text-slate-500">{tr("没有改过期。")}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {m.date_changes.map((c, i) => (
                <li key={i} data-testid="date-change" className="space-y-0.5 py-2 text-xs">
                  <div className="font-medium text-slate-900">{dateOnly(c.old_deadline, tr("未设置"))} → {dateOnly(c.new_deadline, tr("未设置"))}</div>
                  <div className="text-slate-600">{tr("原因：{0}", { 0: c.reason })}</div>
                  <div className="text-[11px] text-slate-400">{c.changed_by?.name ?? tr("组长")} · {when(c.changed_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  </div>;
}
