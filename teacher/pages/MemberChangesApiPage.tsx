"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, ShieldCheck, UserCog } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/shared/components/ui/button";
import { tr } from "@/shared/i18n/tr";
import { useUiText } from "@/shared/i18n/use-ui-text";
import { dateOnly, queryPolicy } from "@/shared/lib/b-ui";
import { useWorkspace } from "@/shared/lib/workspace";
import { bCoursesApi, type BJoinRequest } from "@/student/api/b-courses";
import { bGroupsApi, type BInvitation } from "@/student/api/b-groups";
import { bMembershipApi, type BMembershipChange } from "@/student/api/b-membership";
import { useBErrorMessage } from "@/student/projects/use-b-error";
import { teacherActionsApi, teacherActionsKeys } from "@/teacher/api/teacher-actions-client";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";

const feishuCard =
  "min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuRowCard =
  "rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3.5";
const feishuInputCompact =
  "rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-2.5 py-1.5 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)]";

function JoinRequestsSection({ courseId }: { courseId: string }) {
  const t = useTranslations("pages.courses");
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const bErrorText = useBErrorMessage();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string }>();
  const key = ["b-join-requests", userId, courseId];
  const requests = useQuery({
    queryKey: key,
    queryFn: () => bCoursesApi.joinRequests(courseId),
    ...queryPolicy,
  });
  const policy = useQuery({
    queryKey: ["b-join-policy", userId, courseId],
    queryFn: () => bCoursesApi.joinPolicy(courseId),
    ...queryPolicy,
  });
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: key });
    void cache.invalidateQueries({ queryKey: ["b-join-policy", userId, courseId] });
    void cache.invalidateQueries({ queryKey: teacherActionsKeys.badge(userId, courseId) });
  };
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BJoinRequest; decision: "approve" | "reject" }) =>
      bCoursesApi.decide(row.id, {
        decision,
        reason: reasons[row.id]?.trim() || undefined,
        expected_version: row.lock_version,
      }),
    onSuccess: (row) => {
      setFeedback({
        tone: "success",
        text:
          row.status === "approved"
            ? t("approvedMsg", { name: row.student.name ?? "" })
            : t("rejectedMsg", { name: row.student.name ?? "" }),
      });
      refresh();
    },
    onError: (error) => {
      setFeedback({ tone: "error", text: bErrorText(error) });
      refresh();
    },
  });
  const setMode = useMutation({
    mutationFn: (mode: "direct" | "approval") =>
      bCoursesApi.setJoinPolicy(courseId, {
        mode,
        expected_version: policy.data?.lock_version ?? 0,
      }),
    onSuccess: () => {
      setFeedback({ tone: "success", text: t("modeUpdated") });
      refresh();
    },
    onError: (error) => {
      setFeedback({ tone: "error", text: bErrorText(error) });
      refresh();
    },
  });

  return (
    <section className={feishuCard}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
          {t("requestsTitle")}
        </h2>
        {policy.data && (
          <label className="flex items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <span>{t("rowJoinMode")}</span>
            <select
              aria-label={t("rowJoinMode")}
              className="rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-2.5 py-1 text-xs text-[var(--gp-ink,#1f2329)] outline-none focus:border-[var(--gp-action,#3370ff)]"
              value={policy.data.mode}
              disabled={setMode.isPending}
              onChange={(event) => setMode.mutate(event.target.value as "direct" | "approval")}
            >
              <option value="direct">{t("modeDirect")}</option>
              <option value="approval">{t("modeApproval")}</option>
            </select>
          </label>
        )}
      </div>

      {feedback && (
        <div className="mb-3">
          <TeacherFeedbackPill tone={feedback.tone} message={feedback.text} />
        </div>
      )}

      {requests.isPending ? (
        <div role="status" className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
          {t("loadingRequests")}
        </div>
      ) : requests.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-red-200 bg-red-50 p-3 text-sm text-[var(--gp-danger,#d93025)]"
        >
          <span>{bErrorText(requests.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void requests.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : requests.data.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
          {t("noRequests")}
        </p>
      ) : (
        <ul className="space-y-3">
          {requests.data.items.map((row) => (
            <li key={row.id} data-testid="join-request-row" className={feishuRowCard}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--gp-ink,#1f2329)]">
                    {row.student.name ?? t("unnamedStudent")}
                  </p>
                  <p className="gp-tabular text-xs text-[var(--gp-muted,#646a73)]">
                    {row.student_number ?? ""} {row.student_email ?? ""} ·{" "}
                    {t("appliedAt", { time: row.created_at.slice(0, 16).replace("T", " ") })}
                  </p>
                  {row.message && (
                    <p className="mt-1 text-sm text-[var(--gp-ink-soft,#4e5969)]">{row.message}</p>
                  )}
                </div>
                <div
                  role="toolbar"
                  aria-label={t("requestsTitle")}
                  className="flex flex-wrap items-center gap-2"
                >
                  <label className="sr-only" htmlFor={`reason-${row.id}`}>
                    {t("rejectReason")}
                  </label>
                  <input
                    id={`reason-${row.id}`}
                    className={feishuInputCompact}
                    placeholder={t("rejectPlaceholder")}
                    value={reasons[row.id] ?? ""}
                    onChange={(event) =>
                      setReasons({ ...reasons, [row.id]: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={decide.isPending || !reasons[row.id]?.trim()}
                    className="border-[#fecaca] text-[#d93025] hover:bg-[#fee2e2] hover:text-[#b91c1c]"
                    onClick={() => decide.mutate({ row, decision: "reject" })}
                  >
                    {t("reject")}
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    pill
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ row, decision: "approve" })}
                  >
                    {t("approve")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupInvitationsSection({ courseId }: { courseId: string }) {
  const uiText = useUiText();
  const bErrorText = useBErrorMessage();
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string }>();
  const key = ["b-awaiting-invitations", userId, courseId];
  const rows = useQuery({
    queryKey: key,
    queryFn: () => bGroupsApi.awaitingTeacher(courseId),
    ...queryPolicy,
  });
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BInvitation; decision: "approve" | "reject" }) =>
      bGroupsApi.decideInvitation(row, decision, reasons[row.id]?.trim() || undefined),
    onSuccess: (row) => {
      setNotice({
        tone: "success",
        text:
          row.status === "approved"
            ? uiText("已批准 {0} 加入「{1}」", {
                0: row.invitee?.name ?? "",
                1: row.group_name,
              })
            : uiText("已驳回"),
      });
      void cache.invalidateQueries({ queryKey: key });
      void cache.invalidateQueries({ queryKey: teacherActionsKeys.badge(userId, courseId) });
    },
    onError: (error) => {
      setNotice({ tone: "error", text: bErrorText(error) });
      void cache.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <section className={feishuCard}>
      <h2 className="mb-4 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
        {uiText("截止后的组队邀请")}
      </h2>

      {notice && (
        <div className="mb-3">
          <TeacherFeedbackPill tone={notice.tone} message={notice.text} />
        </div>
      )}

      {rows.isPending ? (
        <div role="status" className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
          {uiText("正在加载…")}
        </div>
      ) : rows.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-red-200 bg-red-50 p-3 text-sm text-[var(--gp-danger,#d93025)]"
        >
          <span>{bErrorText(rows.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void rows.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : rows.data.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
          {uiText("暂无需要审批的组队邀请")}
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.data.map((row) => (
            <li
              key={row.id}
              data-testid="invitation-request-row"
              className={`${feishuRowCard} flex flex-wrap items-center justify-between gap-3 text-sm`}
            >
              <span className="min-w-0 font-medium text-[var(--gp-ink,#1f2329)]">
                {uiText("「{0}」邀请 {1}（邀请人 {2}）", {
                  0: row.group_name,
                  1: row.invitee?.name ?? uiText("同学"),
                  2: row.inviter?.name ?? "—",
                })}
              </span>
              <div
                role="toolbar"
                aria-label={uiText("截止后的组队邀请")}
                className="flex flex-wrap items-center gap-2"
              >
                <label className="sr-only" htmlFor={`inv-reason-${row.id}`}>
                  {uiText("驳回原因")}
                </label>
                <input
                  id={`inv-reason-${row.id}`}
                  className={feishuInputCompact}
                  placeholder={uiText("驳回原因（驳回时必填）")}
                  value={reasons[row.id] ?? ""}
                  onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={decide.isPending || !reasons[row.id]?.trim()}
                  className="border-[#fecaca] text-[#d93025] hover:bg-[#fee2e2] hover:text-[#b91c1c]"
                  onClick={() => decide.mutate({ row, decision: "reject" })}
                >
                  {uiText("驳回")}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  pill
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ row, decision: "approve" })}
                >
                  {uiText("批准")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MembershipChangesSection({ courseId }: { courseId: string }) {
  const uiText = useUiText();
  const bErrorText = useBErrorMessage();
  const client = useQueryClient();
  const { userId } = useWorkspace();
  const [comments, setComments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string }>();
  const key = ["b-course-membership-changes", userId, courseId];
  const rows = useQuery({
    queryKey: key,
    queryFn: () => bMembershipApi.courseChanges(courseId, "pending"),
    ...queryPolicy,
  });
  const decide = useMutation({
    mutationFn: ({
      row,
      decision,
    }: {
      row: BMembershipChange;
      decision: "approve" | "reject" | "needs_info";
    }) => bMembershipApi.decide(row, decision, comments[row.id]?.trim() || undefined),
    onSuccess: (row) => {
      setNotice({
        tone: "success",
        text:
          row.status === "applied"
            ? uiText("已批准，{0} 已离开「{1}」，任务已转交", {
                0: row.member?.name ?? uiText("成员"),
                1: row.group_name,
              })
            : row.status === "needs_info"
              ? uiText("已要求补充，申请人会收到通知")
              : uiText("已驳回，申请人会收到通知"),
      });
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: teacherActionsKeys.badge(userId, courseId) });
    },
    onError: (error) => {
      setNotice({ tone: "error", text: bErrorText(error) });
      void client.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <section className={feishuCard}>
      <h2 className="mb-4 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
        {uiText("小组成员移出 / 退出")}
      </h2>

      {notice && (
        <div className="mb-3" data-testid="membership-notice">
          <TeacherFeedbackPill tone={notice.tone} message={notice.text} />
        </div>
      )}

      {rows.isPending ? (
        <div role="status" className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
          {uiText("正在加载…")}
        </div>
      ) : rows.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-red-200 bg-red-50 p-3 text-sm text-[var(--gp-danger,#d93025)]"
        >
          <span>{bErrorText(rows.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void rows.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : rows.data.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--gp-muted,#646a73)]">
          {uiText("暂无需要审批的成员变动")}
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.data.map((row) => (
            <li
              key={row.id}
              data-testid="membership-request"
              className={`${feishuRowCard} space-y-2.5 text-sm`}
            >
              <p className="font-medium text-[var(--gp-ink,#1f2329)]">
                「{row.group_name}」
                {row.change_type === "leave"
                  ? uiText("{0} 申请退出", { 0: row.member?.name ?? uiText("成员") })
                  : uiText("组长 {0} 申请移出 {1}", {
                      0: row.requested_by?.name ?? "",
                      1: row.member?.name ?? uiText("成员"),
                    })}
              </p>
              <p className="gp-tabular text-xs text-[var(--gp-muted,#646a73)]">
                {uiText("原因：{0} · 提交于 {1}", {
                  0: row.reason,
                  1: dateOnly(row.created_at, uiText("未设置")),
                })}
              </p>
              {row.handovers.length > 0 ? (
                <ul className="ml-4 list-disc text-xs text-[var(--gp-ink-soft,#4e5969)]">
                  {row.handovers.map((h) => (
                    <li key={h.task_id}>
                      {h.code ?? ""} {h.title} → {h.to_user?.name ?? uiText("组员")}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[var(--gp-muted,#646a73)]">
                  {uiText("没有需要交接的任务。")}
                </p>
              )}
              <div
                role="toolbar"
                aria-label={uiText("小组成员移出 / 退出")}
                className="flex flex-wrap items-center gap-2 pt-1"
              >
                <label className="sr-only" htmlFor={`mc-comment-${row.id}`}>
                  {uiText("老师意见")}
                </label>
                <input
                  id={`mc-comment-${row.id}`}
                  className={`${feishuInputCompact} min-w-[220px] flex-1`}
                  placeholder={uiText("意见（驳回或要求补充时必填）")}
                  value={comments[row.id] ?? ""}
                  onChange={(e) => setComments({ ...comments, [row.id]: e.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={decide.isPending || !comments[row.id]?.trim()}
                  onClick={() => decide.mutate({ row, decision: "needs_info" })}
                >
                  {uiText("要求补充")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={decide.isPending || !comments[row.id]?.trim()}
                  className="border-[#fecaca] text-[#d93025] hover:bg-[#fee2e2] hover:text-[#b91c1c]"
                  onClick={() => decide.mutate({ row, decision: "reject" })}
                >
                  {uiText("驳回")}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  pill
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ row, decision: "approve" })}
                >
                  {uiText("批准")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Page 48 in real mode: course join approvals (B1-03), invitations after the
 * formation deadline (B2-03) and group removals / leaving with task handover (B2-07).
 */
export function MemberChangesApiPage({ courseId }: { courseId: string }) {
  const { userId } = useWorkspace();

  const badgeQuery = useQuery({
    queryKey: teacherActionsKeys.badge(userId, courseId),
    queryFn: () => teacherActionsApi.list(courseId, { status: "pending", page: 1, page_size: 1 }),
    enabled: Boolean(courseId && userId),
  });

  return (
    <div className="min-w-0 max-w-full space-y-4">
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          activeId="member-changes"
          variant="segmented"
          size="sm"
          ariaLabel={tr("审批与申诉")}
          testId="hub3-segmented-tabs"
          className="max-w-full"
          items={[
            {
              id: "actions",
              label: tr("待办审批"),
              href: `/teacher/courses/${courseId}/actions`,
              icon: CheckSquare,
              badge:
                (badgeQuery.data?.pending_count ?? 0) > 0
                  ? badgeQuery.data?.pending_count
                  : undefined,
            },
            {
              id: "member-changes",
              label: tr("成员变动"),
              href: `/teacher/courses/${courseId}/member-changes`,
              icon: UserCog,
            },
            {
              id: "appeals",
              label: tr("申诉裁决"),
              href: `/teacher/courses/${courseId}/appeals`,
              icon: ShieldCheck,
            },
          ]}
        />
      </div>

      <div className={feishuCard}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-[var(--gp-ink,#1f2329)]">
              {tr("成员变动审批")}
            </h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              {tr("处理学生加入课程的申请、组队截止后的邀请，以及小组成员的移出和退出。")}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center rounded-full bg-[#e8f0fe] px-2.5 py-0.5 text-[11px] font-medium text-[#1d4ed8]">
            {tr("未完成任务交接")}
          </span>
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        <JoinRequestsSection courseId={courseId} />
        <GroupInvitationsSection courseId={courseId} />
        <MembershipChangesSection courseId={courseId} />
      </div>
    </div>
  );
}
