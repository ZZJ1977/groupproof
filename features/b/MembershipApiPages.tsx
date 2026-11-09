"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, UserMinus } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { bGroupsApi } from "@/lib/api/b-groups";
import { bMembershipApi, type BHandover, type BMembershipChange, type BOpenTasks } from "@/lib/api/b-membership";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { tr } from "@/lib/i18n/tr";

type Notice = { tone: "success" | "error" | "warning"; text: string } | undefined;
type Plan = Record<string, string>;

const statusText: Record<BMembershipChange["status"], string> = { pending: "等待老师审批", needs_info: "老师要求补充", approved: "已批准", rejected: "未批准", applied: "已生效" };
const statusTone: Record<BMembershipChange["status"], "blue" | "green" | "amber" | "red" | "gray"> = { pending: "amber", needs_info: "amber", approved: "green", rejected: "red", applied: "green" };
const taskStatus: Record<string, string> = { not_started: "未开始", in_progress: "进行中", pending_submission: "待提交", pending_verification: "待验收" };

const toHandovers = (plan: Plan): BHandover[] => Object.entries(plan).filter(([, to]) => to).map(([task_id, to_user_id]) => ({ task_id, to_user_id }));
const covered = (open: BOpenTasks | undefined, plan: Plan) => Boolean(open && open.tasks.every((t) => plan[t.id]));

function useMembershipCache(groupId: string) {
  const client = useQueryClient();
  const { userId } = useWorkspace();
  return () => {
    for (const key of [["b-open-tasks", userId, groupId], ["b-group-changes", userId, groupId], ["b-group", userId, groupId]]) void client.invalidateQueries({ queryKey: key });
  };
}

/** One receiver per unfinished task (B2-04/B2-06); the departing member is never offered. */
function HandoverFields({ open, plan, onChange }: { open: BOpenTasks; plan: Plan; onChange: (plan: Plan) => void }) {
  if (open.tasks.length === 0) return <p className="text-sm text-slate-500">{tr("{0} 没有未完成的任务，不需要交接。", { 0: open.member.name ?? "这位同学" })}</p>;
  return <div className="space-y-2">
    <p className="text-sm text-slate-600">{tr("{0} 还有 {1} 个未完成任务，每个都要指定接手人：", { 0: open.member.name ?? "这位同学", 1: open.tasks.length })}</p>
    <ul className="divide-y divide-slate-100 rounded border border-slate-100">{open.tasks.map((t) => <li key={t.id} data-testid="handover-row" className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span><span className="text-xs text-slate-500">{t.code ?? ""}</span> <Link className="gp-link" href={t.href}>{t.title}</Link> <span className="text-xs text-slate-400">{taskStatus[t.status] ?? t.status}</span></span>
      <span><label className="sr-only" htmlFor={`handover-${t.id}`}>{tr("{0} 的接手人", { 0: t.code ?? t.title })}</label>
        <select id={`handover-${t.id}`} className="rounded border border-slate-200 px-2 py-1.5 text-sm" value={plan[t.id] ?? ""} onChange={(e) => onChange({ ...plan, [t.id]: e.target.value })}>
          <option value="">选择接手人</option>{open.candidates.map((c) => <option key={c.id} value={c.id}>{c.name ?? "组员"}</option>)}
        </select></span>
    </li>)}</ul>
  </div>;
}

function deadlineHint(open: BOpenTasks) {
  return open.applies_immediately ? "组队截止前提交会立即生效，任务马上转给接手人。" : "组队已截止，提交后需要老师审批；批准前成员和任务都保持不变。";
}

/** Page 34 (B2-04): the leader removes a member after handing over every unfinished task. */
export function RemoveMemberPanel({ groupId, members }: { groupId: string; members: { id: string; name: string | null; role: string }[] }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const refresh = useMembershipCache(groupId);
  const [memberId, setMemberId] = useState("");
  const [plan, setPlan] = useState<Plan>({});
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const open = useQuery({ queryKey: ["b-open-tasks", userId, groupId, memberId], queryFn: () => bMembershipApi.openTasks(groupId, memberId), enabled: Boolean(memberId), ...queryPolicy });
  const start = useMutation({
    mutationFn: () => bMembershipApi.start(groupId, { change_type: "remove", member_id: memberId, reason: reason.trim(), handovers: toHandovers(plan) }),
    onSuccess: (row) => { setNotice(row.status === "applied" ? { tone: "success", text: tr("已移出 {0}，任务已转给接手人", { 0: row.member?.name ?? "成员" }) } : { tone: "warning", text: "已提交给老师审批，批准前成员仍在组内" }); setMemberId(""); setPlan({}); setReason(""); refresh(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  const ready = Boolean(memberId) && open.isSuccess && covered(open.data, plan) && Boolean(reason.trim());
  return <Panel title="移出成员">
    {notice && <div className="mb-3"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <div><label className={label} htmlFor="b-remove-member">要移出的成员</label><select id="b-remove-member" className={input} value={memberId} onChange={(e) => { setMemberId(e.target.value); setPlan({}); }}><option value="">请选择</option>{members.filter((m) => m.id !== userId).map((m) => <option key={m.id} value={m.id}>{m.name ?? "未命名"}</option>)}</select></div>
      {memberId && (open.isPending ? <p className="text-sm text-slate-500">正在查看未完成任务…</p> : open.isError ? <Feedback tone="error">{errorText(open.error)}</Feedback> : <><HandoverFields open={open.data} plan={plan} onChange={setPlan} /><p className="text-xs text-slate-500">{deadlineHint(open.data)}</p></>)}
      <div><label className={label} htmlFor="b-remove-reason">原因（必填）</label><textarea id="b-remove-reason" className={input} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <div className="flex justify-end"><button type="submit" className={button} disabled={!ready || start.isPending} title={!ready ? "请为每个未完成任务指定接手人并填写原因" : undefined}><UserMinus size={15} />移出</button></div>
    </form>
  </Panel>;
}

/** Requests of this group; the requester edits one after the teacher asks for more (B2-07). */
export function GroupMembershipChanges({ groupId }: { groupId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const refresh = useMembershipCache(groupId);
  const [editing, setEditing] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan>({});
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const rows = useQuery({ queryKey: ["b-group-changes", userId, groupId], queryFn: () => bMembershipApi.groupChanges(groupId), ...queryPolicy });
  const target = rows.data?.find((r) => r.id === editing);
  const open = useQuery({ queryKey: ["b-open-tasks", userId, groupId, target?.member?.id], queryFn: () => bMembershipApi.openTasks(groupId, target!.member!.id), enabled: Boolean(target?.member), ...queryPolicy });
  const edit = useMutation({
    mutationFn: (row: BMembershipChange) => bMembershipApi.edit(row, reason.trim(), toHandovers(plan)),
    onSuccess: () => { setNotice({ tone: "success", text: "已重新提交给老师" }); setEditing(null); refresh(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  if (!rows.data?.length) return null;
  return <Panel title="成员变动申请">
    {notice && <div className="mb-3"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
    <ul className="divide-y divide-slate-100">{rows.data.map((row) => <li key={row.id} data-testid="membership-change" className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><span>{row.change_type === "leave" ? tr("{0} 申请退出", { 0: row.member?.name ?? "成员" }) : tr("移出 {0}", { 0: row.member?.name ?? "成员" })} · {dateOnly(row.created_at)}</span><StatusBadge tone={statusTone[row.status]} label={statusText[row.status]} /></div>
      <p className="text-xs text-slate-500">{tr("原因：{0}{1}", { 0: row.reason, 1: row.teacher_comment ? tr(" · 老师意见：{0}", { 0: row.teacher_comment }) : "" })}</p>
      {row.can_edit && editing !== row.id && <button type="button" className={secondary} onClick={() => { setEditing(row.id); setReason(row.reason); setPlan(Object.fromEntries(row.handovers.map((h) => [h.task_id, h.to_user?.id ?? ""]))); }}>修改后重新提交</button>}
      {editing === row.id && <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); edit.mutate(row); }}>
        {open.data && <HandoverFields open={open.data} plan={plan} onChange={setPlan} />}
        <div><label className={label} htmlFor={`b-edit-reason-${row.id}`}>补充说明（必填）</label><textarea id={`b-edit-reason-${row.id}`} className={input} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div className="flex justify-end gap-2"><button type="button" className={secondary} onClick={() => setEditing(null)}>取消</button><button type="submit" className={button} disabled={edit.isPending || !reason.trim() || !covered(open.data, plan)}>重新提交</button></div>
      </form>}
    </li>)}</ul>
    {rows.isError && <Feedback tone="error">{errorText(rows.error)}</Feedback>}
  </Panel>;
}

/** Page 37 (B2-06): leave the group with a reason and a receiver for every unfinished task. */
export function LeaveGroupApiPage({ courseId, groupId }: { courseId: string; groupId: string }) {
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const refresh = useMembershipCache(groupId);
  const [plan, setPlan] = useState<Plan>({});
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const group = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId), ...queryPolicy });
  const me = group.data?.members.find((m) => m.id === userId);
  const open = useQuery({ queryKey: ["b-open-tasks", userId, groupId, userId], queryFn: () => bMembershipApi.openTasks(groupId, userId), enabled: Boolean(me) && me?.role !== "leader", ...queryPolicy });
  const leave = useMutation({
    mutationFn: () => bMembershipApi.start(groupId, { change_type: "leave", reason: reason.trim(), handovers: toHandovers(plan) }),
    onSuccess: (row) => { setNotice(row.status === "applied" ? { tone: "success", text: "你已退出小组，任务已转给接手人" } : { tone: "warning", text: "已提交给老师审批，批准前你仍在组内" }); setPlan({}); setReason(""); refresh(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  const back = <Link href={`/courses/${courseId}/groups/${groupId}`} className={secondary}>返回小组</Link>;
  if (group.isPending) return <div role="status" className="gp-empty">正在加载…</div>;
  if (group.isError) return <Feedback tone="error">{errorText(group.error)}</Feedback>;
  const ready = open.isSuccess && covered(open.data, plan) && Boolean(reason.trim());
  return <div>
    <PageHeader title="退出小组" description={group.data.name} actions={back} />
    <div className="mx-auto mt-5 max-w-[760px] space-y-4">
      {notice && <div data-testid="leave-notice"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
      {!me ? <Panel><EmptyState title="你不在这个小组" /></Panel>
        : me.role === "leader" ? <Panel><p className="text-sm text-slate-600">你是组长，需要先把组长交给其他成员才能退出。</p><div className="mt-3"><Link className={button} href={`/courses/${courseId}/groups/${groupId}/change-leader`}>更换组长</Link></div></Panel>
        : <Panel title="退出申请"><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); leave.mutate(); }}>
          {open.isPending ? <p className="text-sm text-slate-500">正在查看你的未完成任务…</p> : open.isError ? <Feedback tone="error">{errorText(open.error)}</Feedback> : <><HandoverFields open={open.data} plan={plan} onChange={setPlan} /><p className="text-xs text-slate-500">{deadlineHint(open.data)}</p></>}
          <div><label className={label} htmlFor="b-leave-reason">退出原因（必填）</label><textarea id="b-leave-reason" className={input} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="flex justify-end"><button type="submit" className={button} disabled={!ready || leave.isPending} title={!ready ? "请为每个未完成任务指定接手人并填写原因" : undefined}><LogOut size={15} />提交退出</button></div>
        </form></Panel>}
      <GroupMembershipChanges groupId={groupId} />
    </div>
  </div>;
}

/** Page 48 (B2-07): the teacher approves, rejects or asks for more on removals and leaving. */
export function MembershipChangesApiPanel({ courseId }: { courseId: string }) {
  const errorText = useBErrorMessage();
  const client = useQueryClient();
  const { userId } = useWorkspace();
  const [comments, setComments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>();
  const key = ["b-course-membership-changes", userId, courseId];
  const rows = useQuery({ queryKey: key, queryFn: () => bMembershipApi.courseChanges(courseId, "pending"), ...queryPolicy });
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BMembershipChange; decision: "approve" | "reject" | "needs_info" }) => bMembershipApi.decide(row, decision, comments[row.id]?.trim() || undefined),
    onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "applied" ? tr("已批准，{0} 已离开「{1}」，任务已转交", { 0: row.member?.name ?? "成员", 1: row.group_name }) : row.status === "needs_info" ? "已要求补充，申请人会收到通知" : "已驳回，申请人会收到通知" }); void client.invalidateQueries({ queryKey: key }); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); void client.invalidateQueries({ queryKey: key }); },
  });
  return <Panel title="小组成员移出 / 退出">
    {notice && <div className="mb-3" data-testid="membership-notice"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
    {rows.isPending ? <div role="status" className="gp-empty">正在加载…</div> : rows.isError ? <Feedback tone="error">{errorText(rows.error)}</Feedback>
      : rows.data.length === 0 ? <EmptyState title="暂无需要审批的成员变动" />
      : <ul className="divide-y divide-slate-100">{rows.data.map((row) => <li key={row.id} data-testid="membership-request" className="space-y-2 py-3 text-sm">
        <p className="font-medium">「{row.group_name}」{row.change_type === "leave" ? tr("{0} 申请退出", { 0: row.member?.name ?? "成员" }) : tr("组长 {0} 申请移出 {1}", { 0: row.requested_by?.name ?? "", 1: row.member?.name ?? "成员" })}</p>
        <p className="text-xs text-slate-500">{tr("原因：{0} · 提交于 {1}", { 0: row.reason, 1: dateOnly(row.created_at) })}</p>
        {row.handovers.length > 0 ? <ul className="ml-4 list-disc text-xs text-slate-600">{row.handovers.map((h) => <li key={h.task_id}>{h.code ?? ""} {h.title} → {h.to_user?.name ?? "组员"}</li>)}</ul> : <p className="text-xs text-slate-500">没有需要交接的任务。</p>}
        <div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor={`mc-comment-${row.id}`}>老师意见</label><input id={`mc-comment-${row.id}`} className="min-w-[240px] flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm" placeholder="意见（驳回或要求补充时必填）" value={comments[row.id] ?? ""} onChange={(e) => setComments({ ...comments, [row.id]: e.target.value })} />
          <button type="button" className={secondary} disabled={decide.isPending || !comments[row.id]?.trim()} onClick={() => decide.mutate({ row, decision: "needs_info" })}>要求补充</button>
          <button type="button" className={secondary} disabled={decide.isPending || !comments[row.id]?.trim()} onClick={() => decide.mutate({ row, decision: "reject" })}>驳回</button>
          <button type="button" className={button} disabled={decide.isPending} onClick={() => decide.mutate({ row, decision: "approve" })}>批准</button></div>
      </li>)}</ul>}
  </Panel>;
}
