"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Crown, Mail, Search, UserPlus, Users } from "lucide-react";
import { Avatar, EmptyState, Feedback, PageHeader, StatusBadge } from "@/shared/components/common";
import { newIdempotencyKey } from "@/student/api/b-client";
import { bGroupsApi, type BInvitation } from "@/student/api/b-groups";
import { useWorkspace } from "@/shared/lib/workspace";
import { useBErrorMessage } from "@/student/projects/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/shared/lib/b-ui";
import { GroupMembershipChanges, RemoveMemberPanel } from "@/student/courses/MembershipApiPages";
import { useUiText } from "@/shared/i18n/use-ui-text";

type Notice = { tone: "success" | "error" | "warning"; text: string } | undefined;

function useGroupCache() {
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  return {
    userId,
    refresh: () => {
      for (const key of ["b-groups", "b-group", "b-my-invitations", "b-my-courses", "b-candidates"]) {
        void cache.invalidateQueries({ queryKey: [key, userId] });
      }
    },
  };
}

function Loading({ text }: { text?: string }) {
  const tr = useUiText();
  return <div role="status" className="gp-empty !py-8">{text ?? tr("正在加载…")}</div>;
}

/** Page 33 (B2-01/02/03): course groups, create a group, invitations to me. */
export function GroupsApiPage({ courseId }: { courseId: string }) {
  const tr = useUiText();
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
    onSuccess: (group) => {
      refresh();
      router.push(`/courses/${courseId}/groups/${group.id}`);
    },
    // Keep what the student typed; a new key lets the corrected form be submitted.
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      setCreateKey(newIdempotencyKey());
    },
  });
  const join = useMutation({
    mutationFn: (groupId: string) => bGroupsApi.join(groupId),
    onSuccess: (group) => {
      refresh();
      router.push(`/courses/${courseId}/groups/${group.id}`);
    },
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      refresh();
    },
  });
  const respond = useMutation({
    mutationFn: ({ invitation, accept }: { invitation: BInvitation; accept: boolean }) => bGroupsApi.respond(invitation, accept),
    onSuccess: (row) => {
      setNotice({
        tone: "success",
        text: row.status === "accepted" ? tr("已加入「{0}」", { 0: row.group_name }) : tr("已拒绝邀请"),
      });
      refresh();
    },
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      refresh();
    },
  });
  const data = groups.data;
  const courseInvites = (invitations.data ?? []).filter((item) => item.course_id === courseId && item.status === "pending");

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={tr("课程小组")}
        description={
          data
            ? tr("组队截止 {0}{1}", { 0: dateOnly(data.formation_deadline, tr("未设置")), 1: data.formation_open ? "" : tr("（已截止）") })
            : undefined
        }
        actions={
          data && !data.my_group_id && data.formation_open ? (
            <button type="button" className={`${button} !min-h-9 !px-3.5 !text-xs`} onClick={() => setCreating(true)}>
              <Users size={14} />{tr("创建小组")}
            </button>
          ) : data?.my_group_id ? (
            <Link className={`${button} !min-h-9 !px-3.5 !text-xs`} href={`/courses/${courseId}/groups/${data.my_group_id}`}>
              {tr("我的小组")}<ArrowRight size={14} />
            </Link>
          ) : undefined
        }
      />

      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      {invitations.isError && (
        <Feedback tone="error">
          {errorText(invitations.error)}{" "}
          <button type="button" className="underline" onClick={() => void invitations.refetch()}>
            {tr("重试")}
          </button>
        </Feedback>
      )}

      {courseInvites.length > 0 && (
        <section className="rounded-2xl border border-amber-200/85 bg-amber-50/35 p-4 shadow-xs">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold text-amber-900">
            <Mail size={14} />
            <h2>{tr("我收到的组队邀请")}</h2>
          </div>
          <ul className="divide-y divide-amber-200/50">
            {courseInvites.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2.5 py-2 text-xs first:pt-0 last:pb-0">
                <span className="font-medium text-slate-800">
                  {tr("{0} 邀请你加入「{1}」", { 0: item.inviter?.name ?? tr("同学"), 1: item.group_name })}
                </span>
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    className={`${secondary} !min-h-7 !px-2.5 !text-xs`}
                    disabled={respond.isPending}
                    onClick={() => respond.mutate({ invitation: item, accept: false })}
                  >
                    {tr("拒绝")}
                  </button>
                  <button
                    type="button"
                    className={`${button} !min-h-7 !px-2.5 !text-xs`}
                    disabled={respond.isPending}
                    onClick={() => respond.mutate({ invitation: item, accept: true })}
                  >
                    {tr("接受")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {creating && (
        <section className="rounded-2xl border border-sky-200/85 bg-white p-4 shadow-xs">
          <h2 className="mb-3 text-sm font-bold text-slate-900">{tr("创建小组")}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending) create.mutate();
            }}
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={label} htmlFor="b-group-name">{tr("小组名称")}</label>
                <input
                  id="b-group-name"
                  className={`${input} h-9`}
                  value={name}
                  maxLength={160}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
              <div>
                <label className={label} htmlFor="b-group-direction">{tr("项目方向（可选）")}</label>
                <input
                  id="b-group-direction"
                  className={`${input} h-9`}
                  value={direction}
                  maxLength={200}
                  onChange={(event) => setDirection(event.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">{tr("创建后你将成为组长。")}</p>
              <div className="flex justify-end gap-2">
                <button type="button" className={`${secondary} !min-h-8 !px-3 !text-xs`} disabled={create.isPending} onClick={() => setCreating(false)}>
                  {tr("取消")}
                </button>
                <button type="submit" className={`${button} !min-h-8 !px-3 !text-xs`} disabled={create.isPending || !name.trim()}>
                  {create.isPending ? tr("正在创建…") : tr("创建小组")}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {groups.isPending ? (
        <Loading text={tr("正在加载小组…")} />
      ) : groups.isError ? (
        <div role="alert" className="rounded-2xl border border-rose-200/85 bg-white p-4 shadow-xs">
          <Feedback tone="error">{errorText(groups.error)}</Feedback>
          <button type="button" className={`${secondary} mt-3 !min-h-8 !text-xs`} onClick={() => void groups.refetch()}>
            {tr("重试")}
          </button>
        </div>
      ) : data && data.items.length ? (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((group) => {
            const ratio = group.max_group_size > 0 ? Math.min(100, Math.round((group.member_count / group.max_group_size) * 100)) : 0;
            return (
              <div
                key={group.id}
                className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs transition hover:border-sky-200/90 hover:shadow-sm"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold text-slate-900">{group.name}</h2>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {tr("{0} · 组长 {1}", { 0: group.direction ?? tr("未填写方向"), 1: group.leader?.name ?? "—" })}
                      </p>
                    </div>
                    <StatusBadge tone={group.full ? "gray" : "green"} label={tr("{0}/{1} 人", { 0: group.member_count, 1: group.max_group_size })} />
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${group.full ? "bg-slate-400" : "bg-emerald-500"}`}
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-2.5">
                  <Link className={`${secondary} !min-h-8 !px-3 !text-xs`} href={`/courses/${courseId}/groups/${group.id}`}>
                    {tr("查看")}
                  </Link>
                  {!data.my_group_id && (
                    <button
                      type="button"
                      className={`${button} !min-h-8 !px-3 !text-xs`}
                      disabled={join.isPending || group.full || !data.formation_open}
                      title={group.full ? tr("小组人数已满") : !data.formation_open ? tr("组队已截止") : undefined}
                      onClick={() => join.mutate(group.id)}
                    >
                      {tr("加入")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
          <EmptyState
            title={tr("本课程还没有小组")}
            description={data?.formation_open ? tr("你可以先创建一个小组，再邀请同学加入。") : tr("组队已截止。")}
            action={
              data?.formation_open && !data.my_group_id ? (
                <button type="button" className={`${button} !min-h-9 !text-xs`} onClick={() => setCreating(true)}>
                  {tr("创建小组")}
                </button>
              ) : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

/** Page 34 (B2-02/03): members, invite classmates, open invitations. */
export function GroupDetailApiPage({ courseId, groupId }: { courseId: string; groupId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId, refresh } = useGroupCache();
  const [notice, setNotice] = useState<Notice>();
  const [search, setSearch] = useState("");
  const detail = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId), ...queryPolicy });
  const isMember = Boolean(detail.data?.members.some((member) => member.id === userId));
  const candidates = useQuery({
    queryKey: ["b-candidates", userId, courseId, search],
    queryFn: () => bGroupsApi.candidates(courseId, search),
    enabled: isMember && !detail.data?.full,
    ...queryPolicy,
  });
  const invite = useMutation({
    mutationFn: (inviteeId: string) => bGroupsApi.invite(groupId, inviteeId),
    onSuccess: (row) => {
      setNotice(
        row.status === "pending"
          ? { tone: "success", text: tr("已邀请 {0}，等待对方确认", { 0: row.invitee?.name ?? tr("同学") }) }
          : { tone: "warning", text: tr("组队已截止，邀请 {0} 需要老师批准，已提交给老师", { 0: row.invitee?.name ?? tr("同学") }) },
      );
      refresh();
    },
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      refresh();
    },
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-200/85 bg-white p-4 shadow-xs">
        <Feedback tone="error">{errorText(detail.error)}</Feedback>
        <button type="button" className={`${secondary} mt-3 !min-h-8 !text-xs`} onClick={() => void detail.refetch()}>
          {tr("重试")}
        </button>
      </div>
    );
  }
  const group = detail.data;
  const isLeader = group.members.some((member) => member.id === userId && member.role === "leader");

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={group.name}
        description={tr("{0} · {1}/{2} 人{3}", {
          0: group.direction ?? tr("未填写方向"),
          1: group.member_count,
          2: group.max_group_size,
          3: group.formation_open ? "" : tr(" · 组队已截止"),
        })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/courses/${courseId}/groups`} className={`${secondary} !min-h-9 !px-3 !text-xs`}>{tr("全部小组")}</Link>
            {isMember && (
              <Link href={`/courses/${courseId}/groups/${groupId}/change-leader`} className={`${secondary} !min-h-9 !px-3 !text-xs`}>
                <Crown size={14} />{tr("更换组长")}
              </Link>
            )}
            {isMember && !isLeader && (
              <Link href={`/courses/${courseId}/groups/${groupId}/leave`} className={`${secondary} !min-h-9 !px-3 !text-xs`}>
                {tr("退出小组")}
              </Link>
            )}
            {group.project_id ? (
              <Link href={`/projects/${group.project_id}`} className={`${button} !min-h-9 !px-3.5 !text-xs`}>{tr("进入项目")}</Link>
            ) : isMember ? (
              <Link href={`/courses/${courseId}/projects/new`} className={`${button} !min-h-9 !px-3.5 !text-xs`}>{tr("创建项目")}</Link>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_350px]">
        <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
          <div className="mb-2.5 flex items-center justify-between border-b border-slate-100 pb-2">
            <h2 className="text-sm font-bold text-slate-900">{tr("小组成员")}</h2>
            <span className="gp-pill !min-h-5 !px-2 !py-0">{tr("{0}/{1} 人", { 0: group.member_count, 1: group.max_group_size })}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {group.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2 py-2.5 text-sm first:pt-0.5 last:pb-0.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={member.name ?? tr("未命名")} size={26} />
                  <span className="truncate font-medium text-slate-800">{member.name ?? tr("未命名")}</span>
                </div>
                {member.role === "leader" ? (
                  <StatusBadge tone="blue" label={tr("组长")} />
                ) : (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{tr("成员")}</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-3.5">
          {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}

          {isMember && (
            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <h2 className="mb-2.5 text-sm font-bold text-slate-900">{tr("邀请同学")}</h2>
              {group.full ? (
                <p className="text-xs text-slate-500">{tr("小组人数已满，不能再邀请。")}</p>
              ) : (
                <>
                  <label className={label} htmlFor="b-invite-search">{tr("搜索本课程未入组的同学")}</label>
                  <div className="relative">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      id="b-invite-search"
                      className={`${input} h-9 pl-8 text-xs`}
                      value={search}
                      placeholder={tr("姓名、学号或邮箱")}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  {!group.formation_open && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
                      {tr("组队已截止，邀请需要老师批准后才生效。")}
                    </p>
                  )}
                  <ul className="mt-2.5 max-h-56 divide-y divide-slate-100 overflow-auto">
                    {(candidates.data ?? []).map((candidate) => (
                      <li key={candidate.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                        <span className="min-w-0 truncate font-medium text-slate-800">
                          {candidate.name ?? tr("未命名")}{" "}
                          <span className="font-normal text-slate-400">{candidate.student_number ?? ""}</span>
                        </span>
                        <button
                          type="button"
                          className={`${secondary} !min-h-7 !px-2.5 !text-xs`}
                          disabled={invite.isPending}
                          onClick={() => invite.mutate(candidate.id)}
                        >
                          <UserPlus size={12} />{tr("邀请")}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {candidates.isError && (
                    <Feedback tone="error">
                      {errorText(candidates.error)}{" "}
                      <button type="button" className="underline" onClick={() => void candidates.refetch()}>
                        {tr("重试")}
                      </button>
                    </Feedback>
                  )}
                  {candidates.data?.length === 0 && (
                    <p className="mt-2 text-xs text-slate-500">{tr("没有可邀请的同学。")}</p>
                  )}
                </>
              )}
            </section>
          )}

          {isLeader && group.members.length > 1 && <RemoveMemberPanel groupId={groupId} members={group.members} />}
          {isMember && <GroupMembershipChanges groupId={groupId} />}

          {group.invitations.length > 0 && (
            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
              <h2 className="mb-2 text-sm font-bold text-slate-900">{tr("等待处理的邀请")}</h2>
              <ul className="divide-y divide-slate-100">
                {group.invitations.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2 py-2 text-xs first:pt-0 last:pb-0">
                    <span className="font-medium text-slate-800">{row.invitee?.name ?? tr("同学")}</span>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      {row.status === "pending" ? tr("等待对方确认") : tr("等待老师批准")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Page 36 (B2-05): start a leader change, or confirm/reject a pending one. */
export function ChangeLeaderApiPage({ courseId, groupId }: { courseId: string; groupId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId, refresh } = useGroupCache();
  const [candidate, setCandidate] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const detail = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId), ...queryPolicy });
  const start = useMutation({
    mutationFn: () => bGroupsApi.startLeaderChange(groupId, { candidate_id: candidate, reason: reason.trim() }),
    onSuccess: () => {
      setNotice({ tone: "success", text: tr("已发起，等待其他组员逐一确认") });
      refresh();
    },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const confirm = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "confirm" | "reject" }) => bGroupsApi.confirmLeaderChange(id, decision),
    onSuccess: (row) => {
      setNotice({
        tone: "success",
        text: row.status === "approved"
          ? tr("所有组员已确认，组长已更换")
          : row.status === "rejected"
            ? tr("已拒绝，本次变更结束")
            : tr("已确认，等待其他组员"),
      });
      refresh();
    },
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      refresh();
    },
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError) {
    return (
      <div role="alert" className="rounded-2xl border border-rose-200/85 bg-white p-4 shadow-xs">
        <Feedback tone="error">{errorText(detail.error)}</Feedback>
        <button type="button" className={`${secondary} mt-3 !min-h-8 !text-xs`} onClick={() => void detail.refetch()}>
          {tr("重试")}
        </button>
      </div>
    );
  }
  const group = detail.data;
  const change = group.leader_change?.status === "pending" ? group.leader_change : null;
  const mustConfirm = Boolean(change?.waiting_for.some((person) => person.id === userId));
  const others = group.members.filter((member) => member.role !== "leader");

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={tr("更换组长")}
        description={tr("{0} · 当前组长 {1}", { 0: group.name, 1: group.members.find((m) => m.role === "leader")?.name ?? "—" })}
        actions={<Link href={`/courses/${courseId}/groups/${groupId}`} className={`${secondary} !min-h-9 !px-3 !text-xs`}>{tr("返回小组")}</Link>}
      />
      <div className="mx-auto max-w-2xl space-y-3.5">
        {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
        {change ? (
          <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
            <h2 className="mb-2.5 text-sm font-bold text-slate-900">{tr("正在确认的组长变更")}</h2>
            <div className="space-y-1.5 text-xs text-slate-700">
              <p>{tr("发起人：{0}", { 0: change.requested_by?.name ?? "—" })}</p>
              <p>{tr("新组长：")}<strong className="text-slate-900">{change.candidate?.name ?? "—"}</strong></p>
              <p>{tr("原因：{0}", { 0: change.reason })}</p>
              <p className="text-slate-500">{tr("还需确认：{0}", { 0: change.waiting_for.map((p) => p.name ?? tr("组员")).join("、") || tr("无") })}</p>
            </div>
            {mustConfirm && (
              <div className="mt-3.5 flex justify-end gap-2">
                <button
                  type="button"
                  className={`${secondary} !min-h-8 !px-3 !text-xs`}
                  disabled={confirm.isPending}
                  onClick={() => confirm.mutate({ id: change.id, decision: "reject" })}
                >
                  {tr("不同意")}
                </button>
                <button
                  type="button"
                  className={`${button} !min-h-8 !px-3 !text-xs`}
                  disabled={confirm.isPending}
                  onClick={() => confirm.mutate({ id: change.id, decision: "confirm" })}
                >
                  {tr("同意")}
                </button>
              </div>
            )}
            <p className="mt-3 text-[11px] text-slate-500">{tr("所有组员同意后组长才会更换；任何一人不同意，本次变更结束。")}</p>
          </section>
        ) : (
          <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
            <h2 className="mb-3 text-sm font-bold text-slate-900">{tr("发起组长变更")}</h2>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                start.mutate();
              }}
            >
              <div>
                <label className={label} htmlFor="b-leader-candidate">{tr("新组长")}</label>
                <select
                  id="b-leader-candidate"
                  className={`${input} h-9`}
                  value={candidate}
                  onChange={(event) => setCandidate(event.target.value)}
                  required
                >
                  <option value="">{tr("请选择本组成员")}</option>
                  {others.map((member) => (
                    <option key={member.id} value={member.id}>{member.name ?? tr("未命名")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="b-leader-reason">{tr("原因（必填）")}</label>
                <textarea
                  id="b-leader-reason"
                  className={input}
                  rows={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                />
              </div>
              <div className="flex justify-end">
                <button type="submit" className={`${button} !min-h-9 !text-xs`} disabled={start.isPending || !candidate || !reason.trim()}>
                  {tr("发起，请组员确认")}
                </button>
              </div>
            </form>
          </section>
        )}
        {group.leader_change && group.leader_change.status !== "pending" && (
          <p className="text-xs text-slate-500">
            {tr("上一次变更：{0}（{1}）", {
              0: group.leader_change.status === "approved" ? tr("已完成") : tr("未通过"),
              1: dateOnly(group.leader_change.completed_at, tr("未设置")),
            })}
          </p>
        )}
      </div>
    </div>
  );
}

/** Teacher side of B2-03 on page 48: invitations made after the formation deadline. */
export function GroupInvitationsApiPanel({ courseId }: { courseId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>();
  const key = ["b-awaiting-invitations", userId, courseId];
  const rows = useQuery({ queryKey: key, queryFn: () => bGroupsApi.awaitingTeacher(courseId), ...queryPolicy });
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BInvitation; decision: "approve" | "reject" }) =>
      bGroupsApi.decideInvitation(row, decision, reasons[row.id]?.trim() || undefined),
    onSuccess: (row) => {
      setNotice({
        tone: "success",
        text: row.status === "approved" ? tr("已批准 {0} 加入「{1}」", { 0: row.invitee?.name ?? "", 1: row.group_name }) : tr("已驳回"),
      });
      void cache.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      void cache.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <h2 className="mb-2.5 border-b border-slate-100 pb-2 text-sm font-bold text-slate-900">{tr("截止后的组队邀请")}</h2>
      {notice && <div className="mb-3"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
      {rows.isPending ? (
        <Loading />
      ) : rows.isError ? (
        <div role="alert"><Feedback tone="error">{errorText(rows.error)}</Feedback></div>
      ) : rows.data.length === 0 ? (
        <EmptyState title={tr("暂无需要审批的组队邀请")} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.data.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2.5 py-2.5 text-xs first:pt-0 last:pb-0">
              <span className="font-medium text-slate-800">
                {tr("「{0}」邀请 {1}（邀请人 {2}）", { 0: row.group_name, 1: row.invitee?.name ?? tr("同学"), 2: row.inviter?.name ?? "—" })}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`inv-reason-${row.id}`}>{tr("驳回原因")}</label>
                <input
                  id={`inv-reason-${row.id}`}
                  className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs outline-none focus:border-sky-500"
                  placeholder={tr("驳回原因（驳回时必填）")}
                  value={reasons[row.id] ?? ""}
                  onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })}
                />
                <button
                  type="button"
                  className={`${secondary} !min-h-8 !px-3 !text-xs`}
                  disabled={decide.isPending || !reasons[row.id]?.trim()}
                  onClick={() => decide.mutate({ row, decision: "reject" })}
                >
                  {tr("驳回")}
                </button>
                <button
                  type="button"
                  className={`${button} !min-h-8 !px-3 !text-xs`}
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ row, decision: "approve" })}
                >
                  {tr("批准")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
