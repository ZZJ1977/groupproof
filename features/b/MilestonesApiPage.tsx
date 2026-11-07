"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, History, Plus } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bMilestonesApi, type BDeliverable, type BMilestone, type BMilestoneDetail, type BMilestoneMissing } from "@/lib/api/b-milestones";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";

type Notice = { tone: "success" | "error" | "warning"; text: string; items?: string[] } | undefined;

const statusLabel: Record<string, string> = { not_started: "未开始", in_progress: "进行中", completed: "已交付", at_risk: "有风险" };
const taskStatus: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收", completed: "已完成" };
const verifyState: Record<string, string> = { not_submitted: "还没提交验收", in_review: "正在验收", failed: "验收未通过", invalidated: "需要重新验收", unknown: "验收状态未知" };
const when = (value: string | null | undefined) => (value ? value.slice(0, 16).replace("T", " ") : "—");

function Progress({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-slate-400">没有关联任务</span>;
  return <div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-slate-100" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="进度"><div className="h-2 rounded bg-[var(--gp-action)]" style={{ width: `${value}%` }} /></div><span className="w-10 text-right text-xs font-semibold">{value}%</span></div>;
}

const riskLevel: Record<string, { label: string; tone: "red" | "amber" | "gray" }> = { high: { label: "高风险", tone: "red" }, medium: { label: "中风险", tone: "amber" }, low: { label: "低风险", tone: "gray" } };
const riskStatus: Record<string, string> = { open: "未处理", mitigating: "处理中" };

/** D owns risk; until D sends data the slot says so instead of guessing. */
function Risk({ risk }: { risk: BMilestone["risk"] }) {
  if (!risk) return <p data-testid="milestone-risk" className="text-xs text-slate-500">风险：暂无数据（由验收模块提供）</p>;
  if (!risk.level || risk.open_count === 0) return <p data-testid="milestone-risk" className="flex items-center gap-2 text-xs text-slate-500">风险：<StatusBadge tone="green" label="暂无风险" /></p>;
  const level = riskLevel[risk.level] ?? riskLevel.low;
  return <p data-testid="milestone-risk" className="flex items-center gap-2 text-xs text-slate-600">风险：<StatusBadge tone={level.tone} label={level.label} /><span>{risk.open_count} 项未关闭</span></p>;
}

/** Page 19: the open risks behind the summary, each with where it is recorded. */
function RiskList({ projectId, risk }: { projectId: string; risk: NonNullable<BMilestone["risk"]> }) {
  if (risk.items.length === 0) return <p className="text-sm text-slate-500">这个里程碑和它的关联任务没有未关闭的风险。</p>;
  return <ul className="divide-y divide-slate-100">{risk.items.map((r) => {
    const level = riskLevel[r.level] ?? riskLevel.low;
    return <li key={r.id} data-testid="milestone-risk-item" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <StatusBadge tone={level.tone} label={level.label} />
      <span className="font-medium">{r.title}</span>
      <span className="text-xs text-slate-500">{riskStatus[r.status] ?? r.status}</span>
      <span className="text-xs text-slate-500">{r.task ? <>任务 <Link className="gp-link" href={`/projects/${projectId}/tasks/${r.task.id}`}>{r.task.code ? `${r.task.code} ${r.task.title}` : r.task.title}</Link></> : "里程碑本身"}</span>
      <span className="ml-auto text-xs text-slate-400">负责人 {r.owner?.name ?? "—"} · 处理期限 {dateOnly(r.due_at)}</span>
    </li>;
  })}</ul>;
}

function Badge({ m }: { m: BMilestone }) {
  return m.overdue ? <StatusBadge tone="red" label="已逾期" /> : <StatusBadge tone={m.status === "completed" ? "green" : m.status === "in_progress" ? "blue" : "gray"} label={statusLabel[m.status] ?? m.status} />;
}

/** Page 18 (B7-01): milestones with live progress from linked tasks. */
export function MilestonesApiPage({ projectId }: { projectId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const list = useQuery({ queryKey: ["b-milestones", userId, projectId], queryFn: () => bMilestonesApi.list(projectId), ...queryPolicy });
  return <div>
    <PageHeader title="里程碑" description="进度按关联任务的权重实时汇总，和任务页面的口径一致。" />
    <div className="mt-5">
      {list.isPending ? <div role="status" className="gp-empty">正在加载…</div>
        : list.isError ? <Feedback tone="error">{errorText(list.error)}</Feedback>
        : list.data.items.length === 0 ? <Panel><EmptyState title="还没有里程碑" description="里程碑在项目设置里创建后会显示在这里。" /></Panel>
        : <div className="grid gap-3 md:grid-cols-2">{list.data.items.map((m) => <Panel key={m.id}>
          <article data-testid="milestone-card" className="space-y-3">
            <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900"><Link className="gp-link" href={m.href}>{m.title}</Link></h2><p className="mt-1 text-xs text-slate-500">截止 {dateOnly(m.deadline)}</p></div><Badge m={m} /></div>
            <Progress value={m.progress_percent} />
            <p className="text-xs text-slate-600">任务 {m.completed_task_count}/{m.task_count} 完成 · 交付物 {m.deliverables_done}/{m.deliverables_total} 已勾选</p>
            <Risk risk={m.risk} />
          </article>
        </Panel>)}</div>}
    </div>
  </div>;
}

function missingItems(error: unknown): string[] {
  if (!(error instanceof BApiError) || error.code !== "MILESTONE_NOT_READY") return [];
  const details = error.details as unknown as BMilestoneMissing;
  return [
    ...(details.tasks ?? []).map((t) => `任务 ${t.code ?? ""} ${t.title}：${verifyState[t.state] ?? t.state}`.replace("  ", " ")),
    ...(details.deliverables ?? []).map((d) => `交付物「${d.title}」还没勾选`),
  ];
}

/** Page 19 (B7-01 ~ B7-04): one milestone; deliverables, stage completion, rescheduling. */
export function MilestoneDetailApiPage({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
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
  const fail = (error: unknown) => { setNotice({ tone: "error", text: errorText(error), items: missingItems(error) }); settle(); };
  const add = useMutation({
    mutationFn: () => bMilestonesApi.addDeliverable(projectId, milestoneId, newTitle.trim()),
    onSuccess: (data) => { setNewTitle(""); setNotice({ tone: "success", text: "已添加交付物" }); settle(data); },
    onError: fail,
  });
  const check = useMutation({
    mutationFn: ({ item, done }: { item: BDeliverable; done: boolean }) => bMilestonesApi.check(projectId, milestoneId, item, done, done ? files[item.id] ?? item.file?.id : null),
    onSuccess: (data, { item, done }) => { setNotice({ tone: "success", text: done ? `已勾选「${item.title}」` : `已取消勾选「${item.title}」` }); settle(data); },
    onError: fail,
  });
  const complete = useMutation({
    mutationFn: (m: BMilestoneDetail) => bMilestonesApi.complete(projectId, m),
    onSuccess: (data) => { setNotice({ tone: "success", text: "阶段交付已确认，已通知课程老师" }); settle(data); },
    onError: fail,
  });
  const reschedule = useMutation({
    mutationFn: (m: BMilestoneDetail) => bMilestonesApi.reschedule(projectId, m, new Date(`${date}T23:59:00`).toISOString(), reason.trim()),
    onSuccess: (data) => { setDate(""); setReason(""); setNotice({ tone: "success", text: `已改期到 ${dateOnly(data.deadline)}，已通知老师和全组` }); settle(data); },
    onError: fail,
  });
  if (detail.isPending) return <div role="status" className="gp-empty">正在加载…</div>;
  if (detail.isError) return <Feedback tone="error">{errorText(detail.error)}</Feedback>;
  const m = detail.data;
  const locked = m.status === "completed";
  const busy = add.isPending || check.isPending || complete.isPending || reschedule.isPending;
  return <div>
    <PageHeader title={m.title} description={`截止 ${dateOnly(m.deadline)}${m.description ? ` · ${m.description}` : ""}`} actions={<Link href={`/projects/${projectId}/milestones`} className={secondary}>全部里程碑</Link>} />
    <div className="mt-5 space-y-4">
      {notice && <div data-testid="milestone-notice"><Feedback tone={notice.tone}>{notice.text}{notice.items?.length ? <ul className="mt-2 list-disc pl-5">{notice.items.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Feedback></div>}
      <Panel title="进度">
        <div className="space-y-2"><div className="flex items-center justify-between"><Badge m={m} /><span className="text-xs text-slate-500">任务 {m.completed_task_count}/{m.task_count} 完成</span></div><Progress value={m.progress_percent} /><Risk risk={m.risk} /></div>
      </Panel>
      {m.risk && <Panel title="风险"><RiskList projectId={projectId} risk={m.risk} /></Panel>}
      <Panel title="关联任务">
        {m.tasks.length === 0 ? <EmptyState title="没有关联任务" description="在任务计划里给任务选择这个里程碑。" /> : <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="py-2">编号</th><th>任务</th><th>负责人</th><th>状态</th><th className="text-right">进度</th></tr></thead>
          <tbody>{m.tasks.map((t) => <tr key={t.id} data-testid="milestone-task" className="border-t border-slate-100"><td className="py-2 text-xs text-slate-500">{t.code ?? "—"}</td><td><Link className="gp-link" href={t.href}>{t.title}</Link></td><td className="text-xs">{t.assignees.map((a) => a.name ?? "组员").join("、") || "—"}</td><td className="text-xs">{taskStatus[t.status] ?? t.status}</td><td className="text-right text-xs">{t.progress_percent}%</td></tr>)}</tbody></table>}
      </Panel>
      <Panel title="交付物">
        {m.deliverables.length === 0 && <p className="text-sm text-slate-500">还没有交付物。</p>}
        <ul className="divide-y divide-slate-100">{m.deliverables.map((d) => <li key={d.id} data-testid="deliverable" className="space-y-2 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2"><input type="checkbox" checked={d.done} disabled={!m.can_lead || locked || busy} title={!m.can_lead ? "只有组长可以勾选" : undefined} onChange={(e) => check.mutate({ item: d, done: e.target.checked })} /><span className={d.done ? "font-medium" : ""}>{d.title}</span></label>
            {d.done ? <span className="text-xs text-slate-500">{d.done_by?.name ?? "组长"} 于 {when(d.done_at)} 勾选{d.file ? <> · 文件 <Link className="gp-link" href={d.file.href}>{d.file.name}</Link></> : null}</span>
              : m.can_lead && !locked && m.files.length > 0 ? <><label className="sr-only" htmlFor={`file-${d.id}`}>关联文件</label><select id={`file-${d.id}`} className="rounded border border-slate-200 px-2 py-1 text-xs" value={files[d.id] ?? ""} onChange={(e) => setFiles({ ...files, [d.id]: e.target.value })}><option value="">不关联文件</option>{m.files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></> : null}
            {d.history.length > 0 && <button type="button" className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500" aria-expanded={history === d.id} onClick={() => setHistory(history === d.id ? null : d.id)}><History size={13} />记录</button>}
          </div>
          {history === d.id && <ul data-testid="deliverable-history" className="ml-6 space-y-1 text-xs text-slate-500">{d.history.map((h, i) => <li key={i}>{when(h.at)} {h.actor?.name ?? "组长"} {h.action === "checked" ? "勾选" : "取消勾选"}{h.file ? `（${h.file.name}）` : ""}</li>)}</ul>}
        </li>)}</ul>
        {m.can_lead && !locked && <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}><label className="sr-only" htmlFor="b-deliverable-title">交付物名称</label><input id="b-deliverable-title" className={input} placeholder="例如：中期报告" maxLength={200} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} /><button type="submit" className={secondary} disabled={busy || !newTitle.trim()}><Plus size={14} />添加</button></form>}
        {!m.can_lead && <p className="mt-2 text-xs text-slate-500">只有组长可以勾选交付物。</p>}
      </Panel>
      {m.can_lead && !locked && <Panel title="确认阶段交付">
        <p className="text-sm text-slate-600">关联任务全部通过验收、交付物全部勾选后才能确认。确认后会通知课程老师，里程碑不能再修改。</p>
        <div className="mt-3 flex justify-end"><button type="button" className={button} disabled={busy} onClick={() => complete.mutate(m)}><CheckCircle2 size={15} />确认阶段交付</button></div>
      </Panel>}
      {m.can_lead && !locked && <Panel title="改期">
        <form className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); reschedule.mutate(m); }}>
          <div><label className={label} htmlFor="b-ms-date">新的截止日期</label><input id="b-ms-date" type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} required /></div>
          <div><label className={label} htmlFor="b-ms-reason">改期原因（必填）</label><input id="b-ms-reason" className={input} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <button type="submit" className={button} disabled={busy || !date}><CalendarClock size={15} />改期</button>
        </form>
      </Panel>}
      <Panel title="改期记录">
        {m.date_changes.length === 0 ? <p className="text-sm text-slate-500">没有改过期。</p> : <ul className="divide-y divide-slate-100">{m.date_changes.map((c, i) => <li key={i} data-testid="date-change" className="py-2 text-sm"><span className="font-medium">{dateOnly(c.old_deadline)} → {dateOnly(c.new_deadline)}</span><span className="ml-2 text-slate-600">原因：{c.reason}</span><span className="ml-2 text-xs text-slate-400">{c.changed_by?.name ?? "组长"} · {when(c.changed_at)}</span></li>)}</ul>}
      </Panel>
    </div>
  </div>;
}
