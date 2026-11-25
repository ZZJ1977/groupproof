"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ClipboardList, Folder, Settings, Shield, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { dateTime, errorText } from "@/shared/lib/b-ui";
import { TeacherConfirmDialog } from "@/teacher/components/TeacherConfirmDialog";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import {
  type StaffMember,
  type StaffPermissions,
  newIdempotencyKey,
  teacherStaffApi,
  teacherStaffKeys,
} from "@/teacher/api/teacher-staff-client";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const inputClass =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)] disabled:cursor-not-allowed disabled:bg-[var(--gp-surface-subtle,#f8f9fa)] disabled:text-[var(--gp-muted,#646a73)]";
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

const PERMISSION_LABELS: { key: keyof StaffPermissions; label: string; desc: string }[] = [
  { key: "approve_joins", label: "审批入班申请", desc: "允许在操作中心批准或拒绝学生的入班申请" },
  { key: "manage_groups", label: "拖拽与分组管理", desc: "允许创建空队伍、拖拽分配学生及调整队长" },
  { key: "manage_files", label: "管理课程资料", desc: "允许上传资料、创建文件夹及调整可见范围" },
  { key: "approve_changes", label: "审批成员变动", desc: "允许审批逾期退组或移出成员申请" },
  { key: "export_reports", label: "导出班级报告", desc: "允许下载班级进度、风险及贡献度报表" },
  { key: "post_announcements", label: "发布课程公告", desc: "允许向本班级学生发送或催读课程公告" },
];

export function TeacherStaffApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ta" | "teacher">("ta");
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [draftPerms, setDraftPerms] = useState<StaffPermissions | null>(null);
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const staffQuery = useQuery({
    queryKey: teacherStaffKeys.staff(userId, courseId),
    queryFn: () => teacherStaffApi.list(courseId),
    enabled: Boolean(courseId),
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: teacherStaffKeys.staff(userId, courseId) }),
      qc.invalidateQueries({ queryKey: teacherStaffKeys.myPermissions(userId, courseId) }),
    ]);
  };

  const invite = useMutation({
    mutationFn: () =>
      teacherStaffApi.invite(
        courseId,
        { email: email.trim(), role: inviteRole },
        newIdempotencyKey(),
      ),
    onSuccess: async (member) => {
      setEmail("");
      setFeedback({ tone: "success", text: tr("已邀请 {0} 加入教学团队。", { 0: member.name }) });
      await refresh();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const savePermissions = useMutation({
    mutationFn: () => {
      if (!editing || !draftPerms) throw new Error("missing target");
      return teacherStaffApi.updatePermissions(
        courseId,
        editing.user_id,
        draftPerms,
        newIdempotencyKey(),
      );
    },
    onSuccess: async () => {
      setEditing(null);
      setDraftPerms(null);
      setFeedback({ tone: "success", text: "助教权限已保存并立即生效。" });
      await refresh();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const remove = useMutation({
    mutationFn: () => {
      if (!removing) throw new Error("missing target");
      return teacherStaffApi.remove(
        courseId,
        removing.user_id,
        removeReason.trim(),
        newIdempotencyKey(),
      );
    },
    onSuccess: async () => {
      setRemoving(null);
      setRemoveReason("");
      setFeedback({ tone: "success", text: "已将该成员移出教学团队。" });
      await refresh();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const hub5Tabs = (
    <TeacherSegmentedTabs
      variant="segmented"
      size="sm"
      ariaLabel={tr("切换子页面")}
      testId="hub5-segmented-tabs"
      activeId="staff"
      items={[
        {
          id: "settings",
          label: tr("基础设置"),
          href: `/teacher/courses/${courseId}/settings`,
          icon: Settings,
        },
        {
          id: "rules",
          label: tr("规则与模板"),
          href: `/teacher/courses/${courseId}/rules`,
          icon: ClipboardList,
        },
        {
          id: "files",
          label: tr("课程资料"),
          href: `/teacher/courses/${courseId}/files`,
          icon: Folder,
        },
        {
          id: "announcements",
          label: tr("课程公告"),
          href: `/teacher/courses/${courseId}/announcements`,
          icon: Bell,
        },
        {
          id: "staff",
          label: tr("助教管理"),
          href: `/teacher/courses/${courseId}/staff`,
          icon: Shield,
        },
      ]}
    />
  );

  if (staffQuery.isLoading) {
    return (
      <div className="space-y-5">
        {hub5Tabs}
        <div role="status" className="gp-empty">
          {tr("正在加载…")}
        </div>
      </div>
    );
  }

  if (staffQuery.error || !staffQuery.data) {
    return (
      <div className="space-y-5">
        {hub5Tabs}
        <div role="alert" className="rounded-[12px] border border-red-200 bg-red-50 p-4 text-xs text-[var(--gp-danger,#d93025)]">
          <p>{errorText(staffQuery.error)}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void staffQuery.refetch()}
          >
            {tr("重试")}
          </Button>
        </div>
      </div>
    );
  }

  const { items, can_manage_staff } = staffQuery.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {hub5Tabs}
        <TeacherFeedbackPill
          tone={feedback?.tone ?? "idle"}
          message={feedback?.text}
          autoHideMs={3500}
          onDismiss={() => setFeedback(null)}
        />
      </div>

      <div className={`${panelClass} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-[var(--gp-ink,#1f2329)]">助教管理</h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              参考子管理员授权模型：默认助教仅拥有只读观察权限，课程创建者可按业务粒度按需授权。
            </p>
          </div>
          <span className="gp-tabular shrink-0 rounded-full bg-[var(--gp-surface-hover,#eff0f1)] px-3 py-1 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
            {tr("共 {0} 位教职成员", { 0: items.length })}
          </span>
        </div>

        {!can_manage_staff && (
          <div className="rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3.5 py-2.5 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <span className="mr-2 rounded bg-[var(--gp-surface-hover,#eff0f1)] px-1.5 py-0.5 font-semibold text-[var(--gp-ink,#1f2329)]">
              {tr("只读")}
            </span>
            {tr("权限：仅查看（只读观察者）")}
          </div>
        )}

        <div className="divide-y divide-[var(--gp-border-subtle,#ebedf0)]">
          {items.map((member) => {
            const granted = PERMISSION_LABELS.filter((p) => member.permissions[p.key]).map(
              (p) => p.label,
            );
            return (
              <div
                key={member.user_id}
                className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-1 last:pb-1"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                      {member.name}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        member.is_owner
                          ? "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action-on-soft,#1d4ed8)]"
                          : member.role === "teacher"
                            ? "bg-indigo-50 text-indigo-700"
                            : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]"
                      }`}
                    >
                      {member.is_owner ? "课程负责人" : member.role === "teacher" ? "协同教师" : "助教"}
                    </span>
                    {member.email && (
                      <span className="break-all text-xs text-[var(--gp-muted,#646a73)]">
                        {member.email}
                      </span>
                    )}
                  </div>
                  <p className="gp-tabular break-words text-xs text-[var(--gp-muted,#646a73)]">
                    {member.role === "teacher"
                      ? "权限：拥有本班级全部管理权限"
                      : granted.length > 0
                        ? tr("权限：{0}", { 0: granted.map((item) => tr(item)).join(" · ") })
                        : "权限：仅查看（只读观察者）"}
                    {" · "}
                    {tr("加入时间：{0}", { 0: dateTime(member.joined_at) })}
                  </p>
                </div>

                {can_manage_staff && !member.is_owner && (
                  <div className="flex shrink-0 items-center gap-2">
                    {member.role === "ta" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(member);
                          setDraftPerms({ ...member.permissions });
                        }}
                      >
                        <Shield size={14} aria-hidden="true" />
                        编辑权限
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-[var(--gp-danger,#d93025)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                      onClick={() => {
                        setRemoving(member);
                        setRemoveReason("");
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      移除
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {can_manage_staff && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!email.trim()) return;
            invite.mutate();
          }}
          className={`${panelClass} space-y-4`}
        >
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
              邀请助教或协同教师
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]">
            <div className="min-w-0">
              <label className={labelClass} htmlFor="staff-invite-email">
                学校邮箱
              </label>
              <input
                id="staff-invite-email"
                type="email"
                required
                className={inputClass}
                placeholder="例如：ta@school.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="min-w-0">
              <label className={labelClass} htmlFor="staff-invite-role">
                团队身份
              </label>
              <select
                id="staff-invite-role"
                className={inputClass}
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "ta" | "teacher")}
              >
                <option value="ta">助教（可配权限）</option>
                <option value="teacher">协同教师（全权限）</option>
              </select>
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                variant="default"
                size="sm"
                pill
                loading={invite.isPending}
                preserveWidth
                disabled={invite.isPending || !email.trim()}
              >
                <UserPlus size={14} aria-hidden="true" />
                {"发送邀请"}
              </Button>
            </div>
          </div>
          <p className="text-xs text-[var(--gp-muted,#646a73)]">
            提示：被邀请人须已注册 GroupProof 教师或助教账号；新加入的助教默认仅拥有只读观察权限。
          </p>
        </form>
      )}

      <Dialog
        open={Boolean(editing && draftPerms)}
        onOpenChange={(open) => {
          if (savePermissions.isPending && !open) return;
          if (!open) {
            setEditing(null);
            setDraftPerms(null);
          }
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (savePermissions.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (savePermissions.isPending) event.preventDefault();
          }}
        >
          {editing && draftPerms && (
            <>
              <DialogHeader className="pr-8">
                <DialogTitle className="text-base font-bold text-[var(--gp-ink,#1f2329)]">
                  {tr("配置助教权限：{0}", { 0: editing.name })}
                </DialogTitle>
                <DialogDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                  勾选需要授予该助教的操作能力，未勾选项将保持只读拦截。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2.5">
                {PERMISSION_LABELS.map((item) => (
                  <label
                    key={item.key}
                    className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-[var(--gp-border,#dee0e3)] p-3 transition-colors hover:bg-[var(--gp-surface-subtle,#f8f9fa)]"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[var(--gp-action,#3370ff)]"
                      checked={draftPerms[item.key]}
                      onChange={(e) =>
                        setDraftPerms((prev) =>
                          prev ? { ...prev, [item.key]: e.target.checked } : prev,
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-[var(--gp-ink,#1f2329)]">
                        {item.label}
                      </span>
                      <span className="block text-[11px] text-[var(--gp-muted,#646a73)]">
                        {item.desc}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={savePermissions.isPending}
                  onClick={() => {
                    setEditing(null);
                    setDraftPerms(null);
                  }}
                >
                  {tr("取消")}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  pill
                  loading={savePermissions.isPending}
                  preserveWidth
                  disabled={savePermissions.isPending}
                  onClick={() => savePermissions.mutate()}
                >
                  {tr("保存权限")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <TeacherConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoving(null);
            setRemoveReason("");
          }
        }}
        tone="danger"
        title={removing ? tr("确认移出 {0}", { 0: removing.name }) : ""}
        description="移出后该成员将立即失去本班级管理与访问权限，操作将写入审计日志。"
        confirmLabel={tr("确认移除")}
        confirmDisabled={!removeReason.trim()}
        loading={remove.isPending}
        onConfirm={() => {
          if (!removeReason.trim()) return;
          remove.mutate();
        }}
      >
        <div>
          <label className={labelClass} htmlFor="remove-staff-reason">
            移出原因
          </label>
          <input
            id="remove-staff-reason"
            required
            className={inputClass}
            placeholder="请填写移出原因"
            value={removeReason}
            onChange={(e) => setRemoveReason(e.target.value)}
          />
        </div>
      </TeacherConfirmDialog>
    </div>
  );
}
