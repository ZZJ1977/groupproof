"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Crown, UserPlus, Users } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { newIdempotencyKey } from "@/lib/api/b-client";
import { bGroupsApi, type BInvitation } from "@/lib/api/b-groups";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";

type Notice = { tone: "success" | "error" | "warning"; text: string } | undefined;

function useGroupCache() {
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  return {
    userId,
    refresh: () => {
      for (const key of ["b-groups", "b-group", "b-my-invitations", "b-my-courses", "b-candidates"]) void cache.invalidateQueries({ queryKey: [key, userId] });
    },
  };
}

function Loading({ text = "正在加载…" }: { text?: string }) { return <div role="status" className="gp-empty">{text}</div>; }

/** Page 33 (B2-01/02/03): course groups, create a group, invitations to me. */
export function GroupsApiPage({ courseId }: { courseId: string }) {
  const router = useRouter();
  const errorText = useBErrorMessage();
  const { userId, refresh } = useGroupCache();
  const [notice, setNotice] = useState<Notice>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("");
  const [createKey, setCreateKey] = useState(newIdempotencyKey);
  const groups = useQuery({ queryKey: ["b-groups", userId, courseId], queryFn: () => bGroupsApi.list(courseId), ...queryPolicy });
  const invitations = useQuery({ queryKey: ["b-my-invitations", userId], queryFn: bGroupsApi.myInvitations, ...queryPolicy });
  const create = useMutation({
    mutationFn: () => bGroupsApi.create(courseId, { name: name.trim(), direction: direction.trim() || undefined }, createKey),
    onSuccess: (group) => { refresh(); router.push(`/courses/${courseId}/groups/${group.id}`); },
    // Keep what the student typed; a new key lets the corrected form be submitted.
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); setCreateKey(newIdempotencyKey()); },
  });
  const join = useMutation({
    mutationFn: (groupId: string) => bGroupsApi.join(groupId),
    onSuccess: (group) => { refresh(); router.push(`/courses/${courseId}/groups/${group.id}`); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  const respond = useMutation({
    mutationFn: ({ invitation, accept }: { invitation: BInvitation; accept: boolean }) => bGroupsApi.respond(invitation, accept),
    onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "accepted" ? `已加入「${row.group_name}」` : "已拒绝邀请" }); refresh(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  const data = groups.data;
  const courseInvites = (invitations.data ?? []).filter((item) => item.course_id === courseId && item.status === "pending");
  return <div>
    <PageHeader title="课程小组" description={data ? `组队截止 ${dateOnly(data.formation_deadline)}${data.formation_open ? "" : "（已截止）"}` : "查看小组、创建或加入小组。"}
      actions={data && !data.my_group_id && data.formation_open ? <button type="button" className={button} onClick={() => setCreating(true)}><Users size={15} />创建小组</button> : data?.my_group_id ? <Link className={button} href={`/courses/${courseId}/groups/${data.my_group_id}`}>我的小组 <ArrowRight size={15} /></Link> : undefined} />
    <div className="mt-5 space-y-4">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      {courseInvites.length > 0 && <Panel title="我收到的组队邀请"><ul className="divide-y divide-slate-100">{courseInvites.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><span>{item.inviter?.name ?? "同学"} 邀请你加入「{item.group_name}」</span><span className="flex gap-2"><button type="button" className={secondary} disabled={respond.isPending} onClick={() => respond.mutate({ invitation: item, accept: false })}>拒绝</button><button type="button" className={button} disabled={respond.isPending} onClick={() => respond.mutate({ invitation: item, accept: true })}>接受</button></span></li>)}</ul></Panel>}
      {creating && <Panel title="创建小组"><form onSubmit={(event) => { event.preventDefault(); create.mutate(); }} className="space-y-3">
        <div><label className={label} htmlFor="b-group-name">小组名称</label><input id="b-group-name" className={input} value={name} maxLength={160} onChange={(event) => setName(event.target.value)} required /></div>
        <div><label className={label} htmlFor="b-group-direction">项目方向（可选）</label><input id="b-group-direction" className={input} value={direction} maxLength={200} onChange={(event) => setDirection(event.target.value)} /></div>
        <p className="text-xs text-slate-500">创建后你将成为组长。</p>
        <div className="flex justify-end gap-2"><button type="button" className={secondary} onClick={() => setCreating(false)}>取消</button><button type="submit" className={button} disabled={create.isPending || !name.trim()}>{create.isPending ? "正在创建…" : "创建小组"}</button></div>
      </form></Panel>}
      {groups.isPending ? <Loading text="正在加载小组…" /> : groups.isError ? <div role="alert"><Feedback tone="error">{errorText(groups.error)}</Feedback></div>
        : data && data.items.length ? <div className="grid gap-3 md:grid-cols-2">{data.items.map((group) => <Panel key={group.id}>
          <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">{group.name}</h2><p className="mt-1 text-xs text-slate-500">{group.direction ?? "未填写方向"} · 组长 {group.leader?.name ?? "—"}</p></div><StatusBadge tone={group.full ? "gray" : "green"} label={`${group.member_count}/${group.max_group_size} 人`} /></div>
          <div className="mt-4 flex justify-end gap-2">
            <Link className={secondary} href={`/courses/${courseId}/groups/${group.id}`}>查看</Link>
            {!data.my_group_id && <button type="button" className={button} disabled={join.isPending || group.full || !data.formation_open} title={group.full ? "小组人数已满" : !data.formation_open ? "组队已截止" : undefined} onClick={() => join.mutate(group.id)}>加入</button>}
          </div>
        </Panel>)}</div>
        : <Panel><EmptyState title="本课程还没有小组" description={data?.formation_open ? "你可以先创建一个小组，再邀请同学加入。" : "组队已截止。"} /></Panel>}
    </div>
  </div>;
}

/** Page 34 (B2-02/03): members, invite classmates, open invitations. */
export function GroupDetailApiPage({ courseId, groupId }: { courseId: string; groupId: string }) {
  const errorText = useBErrorMessage();
  const { userId, refresh } = useGroupCache();
  const [notice, setNotice] = useState<Notice>();
  const [search, setSearch] = useState("");
  const detail = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId), ...queryPolicy });
  const isMember = Boolean(detail.data?.members.some((member) => member.id === userId));
  const candidates = useQuery({ queryKey: ["b-candidates", userId, courseId, search], queryFn: () => bGroupsApi.candidates(courseId, search), enabled: isMember && !detail.data?.full, ...queryPolicy });
  const invite = useMutation({
    mutationFn: (inviteeId: string) => bGroupsApi.invite(groupId, inviteeId),
    onSuccess: (row) => { setNotice(row.status === "pending" ? { tone: "success", text: `已邀请 ${row.invitee?.name ?? "同学"}，等待对方确认` } : { tone: "warning", text: `组队已截止，邀请 ${row.invitee?.name ?? "同学"} 需要老师批准，已提交给老师` }); refresh(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError) return <div role="alert"><Feedback tone="error">{errorText(detail.error)}</Feedback></div>;
  const group = detail.data;
  return <div>
    <PageHeader title={group.name} description={`${group.direction ?? "未填写方向"} · ${group.member_count}/${group.max_group_size} 人${group.formation_open ? "" : " · 组队已截止"}`}
      actions={<div className="flex gap-2"><Link href={`/courses/${courseId}/groups`} className={secondary}>全部小组</Link>{isMember && <Link href={`/courses/${courseId}/groups/${groupId}/change-leader`} className={secondary}><Crown size={15} />更换组长</Link>}{group.project_id ? <Link href={`/projects/${group.project_id}`} className={button}>进入项目</Link> : isMember ? <Link href={`/courses/${courseId}/projects/new`} className={button}>创建项目</Link> : null}</div>} />
    <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="小组成员"><ul className="divide-y divide-slate-100">{group.members.map((member) => <li key={member.id} className="flex items-center justify-between py-3 text-sm"><span>{member.name ?? "未命名"}</span>{member.role === "leader" ? <StatusBadge tone="blue" label="组长" /> : <span className="text-xs text-slate-400">成员</span>}</li>)}</ul></Panel>
      <div className="space-y-4">
        {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
        {isMember && (group.full ? <Panel title="邀请同学"><p className="text-sm text-slate-500">小组人数已满，不能再邀请。</p></Panel> : <Panel title="邀请同学">
          <label className={label} htmlFor="b-invite-search">搜索本课程未入组的同学</label>
          <input id="b-invite-search" className={input} value={search} placeholder="姓名、学号或邮箱" onChange={(event) => setSearch(event.target.value)} />
          {!group.formation_open && <p className="mt-2 text-xs text-amber-700">组队已截止，邀请需要老师批准后才生效。</p>}
          <ul className="mt-3 max-h-64 divide-y divide-slate-100 overflow-auto">{(candidates.data ?? []).map((candidate) => <li key={candidate.id} className="flex items-center justify-between gap-2 py-2 text-sm"><span>{candidate.name ?? "未命名"} <span className="text-xs text-slate-400">{candidate.student_number ?? ""}</span></span><button type="button" className={secondary} disabled={invite.isPending} onClick={() => invite.mutate(candidate.id)}><UserPlus size={14} />邀请</button></li>)}</ul>
          {candidates.data?.length === 0 && <p className="mt-2 text-xs text-slate-500">没有可邀请的同学。</p>}
        </Panel>)}
        {group.invitations.length > 0 && <Panel title="等待处理的邀请"><ul className="divide-y divide-slate-100">{group.invitations.map((row) => <li key={row.id} className="flex justify-between py-2 text-sm"><span>{row.invitee?.name ?? "同学"}</span><span className="text-xs text-amber-700">{row.status === "pending" ? "等待对方确认" : "等待老师批准"}</span></li>)}</ul></Panel>}
      </div>
    </div>
  </div>;
}

/** Page 36 (B2-05): start a leader change, or confirm/reject a pending one. */
export function ChangeLeaderApiPage({ courseId, groupId }: { courseId: string; groupId: string }) {
  const errorText = useBErrorMessage();
  const { userId, refresh } = useGroupCache();
  const [candidate, setCandidate] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const detail = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId), ...queryPolicy });
  const start = useMutation({
    mutationFn: () => bGroupsApi.startLeaderChange(groupId, { candidate_id: candidate, reason: reason.trim() }),
    onSuccess: () => { setNotice({ tone: "success", text: "已发起，等待其他组员逐一确认" }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const confirm = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "confirm" | "reject" }) => bGroupsApi.confirmLeaderChange(id, decision),
    onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "approved" ? "所有组员已确认，组长已更换" : row.status === "rejected" ? "已拒绝，本次变更结束" : "已确认，等待其他组员" }); refresh(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); },
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError) return <div role="alert"><Feedback tone="error">{errorText(detail.error)}</Feedback></div>;
  const group = detail.data;
  const change = group.leader_change?.status === "pending" ? group.leader_change : null;
  const mustConfirm = Boolean(change?.waiting_for.some((person) => person.id === userId));
  const others = group.members.filter((member) => member.role !== "leader");
  return <div>
    <PageHeader title="更换组长" description={`${group.name} · 当前组长 ${group.members.find((m) => m.role === "leader")?.name ?? "—"}`} actions={<Link href={`/courses/${courseId}/groups/${groupId}`} className={secondary}>返回小组</Link>} />
    <div className="mx-auto mt-5 max-w-[720px] space-y-4">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      {change ? <Panel title="正在确认的组长变更">
        <div className="space-y-2 text-sm"><p>发起人：{change.requested_by?.name ?? "—"}</p><p>新组长：<strong>{change.candidate?.name ?? "—"}</strong></p><p>原因：{change.reason}</p>
          <p className="text-slate-500">还需确认：{change.waiting_for.map((p) => p.name ?? "组员").join("、") || "无"}</p></div>
        {mustConfirm && <div className="mt-4 flex justify-end gap-2"><button type="button" className={secondary} disabled={confirm.isPending} onClick={() => confirm.mutate({ id: change.id, decision: "reject" })}>不同意</button><button type="button" className={button} disabled={confirm.isPending} onClick={() => confirm.mutate({ id: change.id, decision: "confirm" })}>同意</button></div>}
        <p className="mt-3 text-xs text-slate-500">所有组员同意后组长才会更换；任何一人不同意，本次变更结束。</p>
      </Panel> : <Panel title="发起组长变更"><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); start.mutate(); }}>
        <div><label className={label} htmlFor="b-leader-candidate">新组长</label><select id="b-leader-candidate" className={input} value={candidate} onChange={(event) => setCandidate(event.target.value)} required><option value="">请选择本组成员</option>{others.map((member) => <option key={member.id} value={member.id}>{member.name ?? "未命名"}</option>)}</select></div>
        <div><label className={label} htmlFor="b-leader-reason">原因（必填）</label><textarea id="b-leader-reason" className={input} rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} required /></div>
        <div className="flex justify-end"><button type="submit" className={button} disabled={start.isPending || !candidate || !reason.trim()}>发起，请组员确认</button></div>
      </form></Panel>}
      {group.leader_change && group.leader_change.status !== "pending" && <p className="text-xs text-slate-500">上一次变更：{group.leader_change.status === "approved" ? "已完成" : "未通过"}（{dateOnly(group.leader_change.completed_at)}）</p>}
    </div>
  </div>;
}

/** Teacher side of B2-03 on page 48: invitations made after the formation deadline. */
export function GroupInvitationsApiPanel({ courseId }: { courseId: string }) {
  const errorText = useBErrorMessage();
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>();
  const key = ["b-awaiting-invitations", userId, courseId];
  const rows = useQuery({ queryKey: key, queryFn: () => bGroupsApi.awaitingTeacher(courseId), ...queryPolicy });
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BInvitation; decision: "approve" | "reject" }) => bGroupsApi.decideInvitation(row, decision, reasons[row.id]?.trim() || undefined),
    onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "approved" ? `已批准 ${row.invitee?.name ?? ""} 加入「${row.group_name}」` : "已驳回" }); void cache.invalidateQueries({ queryKey: key }); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); void cache.invalidateQueries({ queryKey: key }); },
  });
  return <Panel title="截止后的组队邀请">
    {notice && <div className="mb-3"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
    {rows.isPending ? <Loading /> : rows.isError ? <div role="alert"><Feedback tone="error">{errorText(rows.error)}</Feedback></div>
      : rows.data.length === 0 ? <EmptyState title="暂无需要审批的组队邀请" />
      : <ul className="divide-y divide-slate-100">{rows.data.map((row) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <span>「{row.group_name}」邀请 {row.invitee?.name ?? "同学"}（邀请人 {row.inviter?.name ?? "—"}）</span>
        <span className="flex flex-wrap gap-2"><label className="sr-only" htmlFor={`inv-reason-${row.id}`}>驳回原因</label><input id={`inv-reason-${row.id}`} className="rounded border border-slate-200 px-2 py-1.5 text-sm" placeholder="驳回原因（驳回时必填）" value={reasons[row.id] ?? ""} onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })} />
          <button type="button" className={secondary} disabled={decide.isPending || !reasons[row.id]?.trim()} onClick={() => decide.mutate({ row, decision: "reject" })}>驳回</button>
          <button type="button" className={button} disabled={decide.isPending} onClick={() => decide.mutate({ row, decision: "approve" })}>批准</button></span>
      </li>)}</ul>}
  </Panel>;
}
