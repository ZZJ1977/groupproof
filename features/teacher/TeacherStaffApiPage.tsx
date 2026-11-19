"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Trash2, UserPlus } from "lucide-react";
import { button, card, dateTime, errorText, input, label, secondary } from "@/features/b/ui";
import {
  type StaffMember,
  type StaffPermissions,
  newIdempotencyKey,
  teacherStaffApi,
  teacherStaffKeys,
} from "@/lib/api/teacher-staff-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

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

  if (staffQuery.isLoading) {
    return (
      <div role="status" className="gp-empty">
        正在加载…
      </div>
    );
  }

  if (staffQuery.error || !staffQuery.data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        <p>{errorText(staffQuery.error)}</p>
        <button type="button" className={`${secondary} mt-3`} onClick={() => void staffQuery.refetch()}>
          重试
        </button>
      </div>
    );
  }

  const { items, can_manage_staff } = staffQuery.data;

  return (
    <div className="space-y-5">
      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-900">助教管理</h1>
            <p className="mt-1 text-xs text-slate-500">
              参考子管理员授权模型：默认助教仅拥有只读观察权限，课程创建者可按业务粒度按需授权。
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {tr("共 {0} 位教职成员", { 0: items.length })}
          </span>
        </div>

        {feedback && (
          <div
            role={feedback.tone === "error" ? "alert" : "status"}
            className={`rounded-lg border px-3.5 py-2.5 text-xs ${
              feedback.tone === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="divide-y divide-slate-100">
          {items.map((member) => {
            const granted = PERMISSION_LABELS.filter((p) => member.permissions[p.key]).map(
              (p) => p.label,
            );
            return (
              <div
                key={member.user_id}
                className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-1 last:pb-1"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{member.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        member.is_owner
                          ? "bg-blue-50 text-blue-700"
                          : member.role === "teacher"
                            ? "bg-indigo-50 text-indigo-700"
                            : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {member.is_owner ? "课程负责人" : member.role === "teacher" ? "协同教师" : "助教"}
                    </span>
                    {member.email && <span className="text-xs text-slate-500">{member.email}</span>}
                  </div>
                  <p className="text-xs text-slate-500">
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
                  <div className="flex items-center gap-2">
                    {member.role === "ta" && (
                      <button
                        type="button"
                        className={secondary}
                        onClick={() => {
                          setEditing(member);
                          setDraftPerms({ ...member.permissions });
                        }}
                      >
                        <Shield size={14} />
                        编辑权限
                      </button>
                    )}
                    <button
                      type="button"
                      className={secondary}
                      onClick={() => {
                        setRemoving(member);
                        setRemoveReason("");
                      }}
                    >
                      <Trash2 size={14} />
                      移除
                    </button>
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
          className={`${card} space-y-4`}
        >
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-blue-600" />
            <h2 className="text-sm font-semibold text-slate-900">邀请助教或协同教师</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_auto]">
            <div>
              <label className={label} htmlFor="staff-invite-email">
                学校邮箱
              </label>
              <input
                id="staff-invite-email"
                type="email"
                required
                className={input}
                placeholder="例如：ta@school.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className={label} htmlFor="staff-invite-role">
                团队身份
              </label>
              <select
                id="staff-invite-role"
                className={input}
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "ta" | "teacher")}
              >
                <option value="ta">助教（可配权限）</option>
                <option value="teacher">协同教师（全权限）</option>
              </select>
            </div>
            <div className="flex items-end">
              <button type="submit" className={button} disabled={invite.isPending || !email.trim()}>
                <UserPlus size={14} />
                {invite.isPending ? "正在邀请…" : "发送邀请"}
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            提示：被邀请人须已注册 GroupProof 教师或助教账号；新加入的助教默认仅拥有只读观察权限。
          </p>
        </form>
      )}

      {editing && draftPerms && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">
              {tr("配置助教权限：{0}", { 0: editing.name })}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              勾选需要授予该助教的操作能力，未勾选项将保持只读拦截。
            </p>
            <div className="mt-4 space-y-2.5">
              {PERMISSION_LABELS.map((item) => (
                <label
                  key={item.key}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                    checked={draftPerms[item.key]}
                    onChange={(e) =>
                      setDraftPerms((prev) => (prev ? { ...prev, [item.key]: e.target.checked } : prev))
                    }
                  />
                  <span>
                    <span className="block text-xs font-semibold text-slate-900">{item.label}</span>
                    <span className="block text-[11px] text-slate-500">{item.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={secondary} onClick={() => setEditing(null)}>
                取消
              </button>
              <button
                type="button"
                className={button}
                disabled={savePermissions.isPending}
                onClick={() => savePermissions.mutate()}
              >
                {savePermissions.isPending ? "正在保存…" : "保存权限"}
              </button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!removeReason.trim()) return;
              remove.mutate();
            }}
            className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <h2 className="text-base font-bold text-slate-900">
              {tr("确认移出 {0}", { 0: removing.name })}
            </h2>
            <p className="text-xs text-slate-500">
              移出后该成员将立即失去本班级管理与访问权限，操作将写入审计日志。
            </p>
            <div>
              <label className={label} htmlFor="remove-staff-reason">
                移出原因
              </label>
              <input
                id="remove-staff-reason"
                required
                className={input}
                placeholder="请填写移出原因"
                value={removeReason}
                onChange={(e) => setRemoveReason(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={secondary} onClick={() => setRemoving(null)}>
                取消
              </button>
              <button
                type="submit"
                className={button}
                disabled={remove.isPending || !removeReason.trim()}
              >
                {remove.isPending ? "正在处理…" : "确认移除"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
