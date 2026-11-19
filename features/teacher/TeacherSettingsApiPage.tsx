"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Power, RotateCcw, Save, Trash2 } from "lucide-react";
import { button, card, errorText, input, label, secondary } from "@/features/b/ui";

const danger =
  "inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50";
import { InviteCodeCard } from "@/features/teacher/InviteCodeCard";
import { type JoinMode, newIdempotencyKey, teacherClassesApi, teacherKeys } from "@/lib/api/teacher-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

function toLocalDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TeacherSettingsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { userId } = useWorkspace();

  const settingsQuery = useQuery({
    queryKey: teacherKeys.settings(userId, courseId),
    queryFn: () => teacherClassesApi.settings(courseId),
    enabled: Boolean(courseId),
  });

  const [name, setName] = useState("");
  const [semester, setSemester] = useState("");
  const [college, setCollege] = useState("");
  const [description, setDescription] = useState("");
  const [minSize, setMinSize] = useState(1);
  const [maxSize, setMaxSize] = useState(6);
  const [formationDeadline, setFormationDeadline] = useState("");
  const [projectDeadline, setProjectDeadline] = useState("");
  const [joinMode, setJoinMode] = useState<JoinMode>("direct");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [confirmKind, setConfirmKind] = useState<"end" | "delete" | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [endReason, setEndReason] = useState("学期课程已完成");
  const [reopenReason, setReopenReason] = useState("开放补充提交与复核");

  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setName(s.name);
    setSemester(s.semester);
    setCollege(s.college);
    setDescription(s.description ?? "");
    setMinSize(s.min_group_size);
    setMaxSize(s.max_group_size);
    setFormationDeadline(toLocalDateTime(s.formation_deadline));
    setProjectDeadline(toLocalDateTime(s.project_deadline));
    setJoinMode(s.join_mode);
  }, [settingsQuery.data]);

  const invalidateAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: teacherKeys.settings(userId, courseId) }),
      qc.invalidateQueries({ queryKey: teacherKeys.classDetail(userId, courseId) }),
      qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      teacherClassesApi.updateSettings(
        courseId,
        {
          name: name.trim(),
          semester: semester.trim(),
          college: college.trim(),
          description: description.trim(),
          min_group_size: minSize,
          max_group_size: maxSize,
          formation_deadline: formationDeadline ? new Date(formationDeadline).toISOString() : null,
          project_deadline: projectDeadline ? new Date(projectDeadline).toISOString() : null,
          join_mode: joinMode,
          expected_version: settingsQuery.data?.lock_version ?? 0,
        },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: "班级设置已保存。" });
      await invalidateAll();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const rotateMutation = useMutation({
    mutationFn: () =>
      teacherClassesApi.rotateInvite(
        courseId,
        settingsQuery.data?.lock_version ?? 0,
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: "邀请码已重置，旧邀请码已失效。" });
      await invalidateAll();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const endMutation = useMutation({
    mutationFn: () =>
      teacherClassesApi.endClass(
        courseId,
        {
          reason: endReason.trim(),
          expected_version: settingsQuery.data?.lock_version ?? 0,
        },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      setConfirmKind(null);
      setConfirmName("");
      setFeedback({ tone: "success", text: "课程已结束，现有学生与项目数据已设为只读。" });
      await invalidateAll();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      teacherClassesApi.archiveClass(
        courseId,
        settingsQuery.data?.lock_version ?? 0,
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: "课程已归档，可在「全部」班级标签下查看。" });
      await invalidateAll();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const reopenMutation = useMutation({
    mutationFn: () =>
      teacherClassesApi.reopenClass(
        courseId,
        {
          reason: reopenReason.trim(),
          expected_version: settingsQuery.data?.lock_version ?? 0,
        },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: "课程已重新开启。" });
      await invalidateAll();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => teacherClassesApi.deleteClass(courseId, newIdempotencyKey()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["b-teacher-classes", userId] });
      router.push("/teacher/courses");
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  if (settingsQuery.isLoading) {
    return (
      <div role="status" className="gp-empty">
        正在加载…
      </div>
    );
  }

  if (settingsQuery.error || !settingsQuery.data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
        <p>{errorText(settingsQuery.error)}</p>
        <button type="button" className={`${secondary} mt-3`} onClick={() => void settingsQuery.refetch()}>
          重试
        </button>
      </div>
    );
  }

  const s = settingsQuery.data;
  const editable = s.can_manage && s.status === "active";

  return (
    <div className="space-y-5">
      {s.status === "ended" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <span>当前课程已结束，所有写操作已锁定为只读。</span>
          {s.can_manage && (
            <div className="flex items-center gap-2">
              <input
                className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs text-slate-900"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="重开原因"
              />
              <button
                type="button"
                className={secondary}
                disabled={reopenMutation.isPending || !reopenReason.trim()}
                onClick={() => reopenMutation.mutate()}
              >
                <RotateCcw size={13} />
                重新开启课程
              </button>
            </div>
          )}
        </div>
      )}

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!editable) return;
          saveMutation.mutate();
        }}
        className={`${card} space-y-4`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold text-slate-900">班级设置</h1>
            <p className="mt-1 text-xs text-slate-500">管理班级基础信息、入班方式及课程生命周期。</p>
          </div>
          {editable && (
            <button type="submit" className={button} disabled={saveMutation.isPending}>
              <Save size={14} />
              {saveMutation.isPending ? "正在保存…" : "保存修改"}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={label} htmlFor="settings-name">
              班级名称
            </label>
            <input
              id="settings-name"
              className={input}
              disabled={!editable}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="settings-code">
              课程代码（只读）
            </label>
            <input id="settings-code" className={input} disabled value={s.code} />
          </div>
          <div>
            <label className={label} htmlFor="settings-semester">
              学期
            </label>
            <input
              id="settings-semester"
              className={input}
              disabled={!editable}
              required
              value={semester}
              onChange={(e) => setSemester(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="settings-college">
              学院
            </label>
            <input
              id="settings-college"
              className={input}
              disabled={!editable}
              required
              value={college}
              onChange={(e) => setCollege(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="settings-min-size">
              队伍最小人数
            </label>
            <input
              id="settings-min-size"
              type="number"
              min={1}
              max={50}
              className={input}
              disabled={!editable}
              value={minSize}
              onChange={(e) => setMinSize(Number(e.target.value))}
            />
          </div>
          <div>
            <label className={label} htmlFor="settings-max-size">
              队伍最大人数
            </label>
            <input
              id="settings-max-size"
              type="number"
              min={1}
              max={50}
              className={input}
              disabled={!editable}
              value={maxSize}
              onChange={(e) => setMaxSize(Number(e.target.value))}
            />
          </div>
          <div>
            <label className={label} htmlFor="settings-formation-deadline">
              组队截止时间
            </label>
            <input
              id="settings-formation-deadline"
              type="datetime-local"
              className={input}
              disabled={!editable}
              value={formationDeadline}
              onChange={(e) => setFormationDeadline(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="settings-project-deadline">
              结项截止时间
            </label>
            <input
              id="settings-project-deadline"
              type="datetime-local"
              className={input}
              disabled={!editable}
              value={projectDeadline}
              onChange={(e) => setProjectDeadline(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="settings-desc">
            班级说明
          </label>
          <textarea
            id="settings-desc"
            rows={3}
            className={input}
            disabled={!editable}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="填写班级简介、上课时间或项目主题说明"
          />
        </div>
      </form>

      <div className={`${card} space-y-4`}>
        <h2 className="text-sm font-semibold text-slate-900">加入设置与邀请码</h2>
        <div className="flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="radio"
              name="settings-join-mode"
              disabled={!editable}
              checked={joinMode === "direct"}
              onChange={() => setJoinMode("direct")}
            />
            直接加入（凭邀请码立即入班）
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="radio"
              name="settings-join-mode"
              disabled={!editable}
              checked={joinMode === "approval"}
              onChange={() => setJoinMode("approval")}
            />
            审批加入（学生提交后需教师确认入班）
          </label>
        </div>

        <InviteCodeCard
          inviteCode={s.invite_code}
          joinUrl={s.join_url}
          canManage={editable}
          rotating={rotateMutation.isPending}
          onRotate={() => rotateMutation.mutate()}
        />
      </div>

      {s.can_manage && (
        <div className={`${card} space-y-4`}>
          <h2 className="text-sm font-semibold text-slate-900">课程状态与危险操作</h2>
          <div className="flex flex-wrap gap-3">
            {s.status === "active" && (
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  setConfirmKind("end");
                  setConfirmName("");
                }}
              >
                <Power size={14} />
                结束课程
              </button>
            )}
            {!s.archived_at && (
              <button
                type="button"
                className={secondary}
                disabled={archiveMutation.isPending}
                onClick={() => archiveMutation.mutate()}
              >
                <Archive size={14} />
                归档课程
              </button>
            )}
            {s.is_owner && (
              <button
                type="button"
                className={danger}
                disabled={!s.can_delete}
                title={s.can_delete ? "永久删除空班级" : "需先结束课程且班级无学生和队伍"}
                onClick={() => {
                  setConfirmKind("delete");
                  setConfirmName("");
                }}
              >
                <Trash2 size={14} />
                删除课程
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500">
            {tr("当前班级统计：{0} 名学生 · {1} 个队伍；仅已结束且无学生无队伍的空班级支持永久删除。", {
              0: s.student_count,
              1: s.group_count,
            })}
          </p>
        </div>
      )}

      {confirmKind && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-center gap-2 text-red-600">
              <AlertTriangle size={18} />
              <h2 className="text-base font-bold text-slate-900">
                {confirmKind === "end" ? "二次确认：结束课程" : "二次确认：永久删除课程"}
              </h2>
            </div>
            <p className="text-xs text-slate-600">
              {confirmKind === "end"
                ? "结束课程后，学生端所有项目内容将变为只读；您可以随时在设置中重新开启课程。"
                : "永久删除后该空班级及邀请码、规则记录将全部清理且无法恢复。"}
            </p>
            {confirmKind === "end" && (
              <div>
                <label className={label} htmlFor="end-class-reason">
                  结课原因
                </label>
                <input
                  id="end-class-reason"
                  className={input}
                  value={endReason}
                  onChange={(e) => setEndReason(e.target.value)}
                />
              </div>
            )}
            <div>
              <label className={label} htmlFor="confirm-class-name-input">
                {tr("请输入班级名称「{0}」确认操作", { 0: s.name })}
              </label>
              <input
                id="confirm-class-name-input"
                className={input}
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={s.name}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={secondary} onClick={() => setConfirmKind(null)}>
                取消
              </button>
              <button
                type="button"
                className={danger}
                disabled={
                  confirmName.trim() !== s.name ||
                  (confirmKind === "end" && !endReason.trim()) ||
                  endMutation.isPending ||
                  deleteMutation.isPending
                }
                onClick={() =>
                  confirmKind === "end" ? endMutation.mutate() : deleteMutation.mutate()
                }
              >
                {confirmKind === "end" ? "确认结束课程" : "确认永久删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
