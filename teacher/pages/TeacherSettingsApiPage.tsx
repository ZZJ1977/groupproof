"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Bell,
  ClipboardList,
  Folder,
  Power,
  RotateCcw,
  Save,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";
import { SaveState } from "@/shared/components/common";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import { errorText } from "@/shared/lib/b-ui";
import { InviteCodeCard } from "@/teacher/components/InviteCodeCard";
import { TeacherConfirmDialog } from "@/teacher/components/TeacherConfirmDialog";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { type JoinMode, newIdempotencyKey, teacherClassesApi, teacherKeys } from "@/teacher/api/teacher-client";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const inputClass =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)] disabled:cursor-not-allowed disabled:bg-[var(--gp-surface-subtle,#f8f9fa)] disabled:text-[var(--gp-muted,#646a73)]";
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

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
  const perms = useTeacherPermissions(courseId);

  const settingsQuery = useQuery({
    queryKey: teacherKeys.settings(userId, courseId),
    queryFn: () => teacherClassesApi.settings(courseId),
    enabled: Boolean(courseId),
  });

  const [name, setName] = useState("");
  const [semester, setSemester] = useState("");
  const [college, setCollege] = useState("");
  const [description, setDescription] = useState("");
  const [formationDeadline, setFormationDeadline] = useState("");
  const [projectDeadline, setProjectDeadline] = useState("");
  const [joinMode, setJoinMode] = useState<JoinMode>("direct");
  const [saveOutcome, setSaveOutcome] = useState<"clean" | "saved" | "error">("clean");
  const justSavedRef = useRef(false);
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
    setFormationDeadline(toLocalDateTime(s.formation_deadline));
    setProjectDeadline(toLocalDateTime(s.project_deadline));
    setJoinMode(s.join_mode);
    if (justSavedRef.current) {
      justSavedRef.current = false;
    } else {
      setSaveOutcome("clean");
    }
  }, [settingsQuery.data]);

  const isDirty = useMemo(() => {
    const s = settingsQuery.data;
    if (!s) return false;
    return (
      name !== s.name ||
      semester !== s.semester ||
      college !== s.college ||
      description !== (s.description ?? "") ||
      formationDeadline !== toLocalDateTime(s.formation_deadline) ||
      projectDeadline !== toLocalDateTime(s.project_deadline) ||
      joinMode !== s.join_mode
    );
  }, [
    settingsQuery.data,
    name,
    semester,
    college,
    description,
    formationDeadline,
    projectDeadline,
    joinMode,
  ]);

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
          formation_deadline: formationDeadline ? new Date(formationDeadline).toISOString() : null,
          project_deadline: projectDeadline ? new Date(projectDeadline).toISOString() : null,
          join_mode: joinMode,
          expected_version: settingsQuery.data?.lock_version ?? 0,
        },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      justSavedRef.current = true;
      setSaveOutcome("saved");
      setFeedback({ tone: "success", text: "班级设置已保存。" });
      await invalidateAll();
    },
    onError: (err) => {
      setSaveOutcome("error");
      setFeedback({ tone: "error", text: errorText(err) });
    },
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

  const hub5Tabs = (
    <TeacherSegmentedTabs
      variant="segmented"
      size="sm"
      ariaLabel={tr("切换子页面")}
      testId="hub5-segmented-tabs"
      activeId="settings"
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
          hidden: !perms.isOwner,
        },
      ]}
    />
  );

  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-5">
        {hub5Tabs}
        <div role="status" className="gp-empty">
          {tr("正在加载…")}
        </div>
      </div>
    );
  }

  if (settingsQuery.error || !settingsQuery.data) {
    return (
      <div className="space-y-5">
        {hub5Tabs}
        <div role="alert" className="rounded-[12px] border border-red-200 bg-red-50 p-4 text-xs text-[var(--gp-danger,#d93025)]">
          <p>{errorText(settingsQuery.error)}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void settingsQuery.refetch()}
          >
            {tr("重试")}
          </Button>
        </div>
      </div>
    );
  }

  const s = settingsQuery.data;
  const editable = s.can_manage && s.status === "active";
  const saveState: "clean" | "dirty" | "saving" | "saved" | "error" = saveMutation.isPending
    ? "saving"
    : saveOutcome === "error"
      ? "error"
      : isDirty
        ? "dirty"
        : saveOutcome;

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

      {s.status === "ended" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <span className="min-w-0">当前课程已结束，所有写操作已锁定为只读。</span>
          {s.can_manage && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <input
                className="min-w-0 flex-1 rounded-[8px] border border-amber-300 bg-white px-2.5 py-1.5 text-xs text-[var(--gp-ink,#1f2329)] sm:w-48"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="重开原因"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={reopenMutation.isPending}
                preserveWidth
                disabled={reopenMutation.isPending || !reopenReason.trim()}
                onClick={() => reopenMutation.mutate()}
              >
                <RotateCcw size={13} aria-hidden="true" />
                重新开启课程
              </Button>
            </div>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!editable) return;
          saveMutation.mutate();
        }}
        className={`${panelClass} space-y-4`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-[var(--gp-ink,#1f2329)]">班级设置</h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              管理班级基础信息、入班方式及课程生命周期。
            </p>
          </div>
          {editable && (
            <div className="flex flex-wrap items-center gap-2.5">
              <SaveState state={saveState} />
              <Button
                type="submit"
                variant="default"
                size="sm"
                pill
                loading={saveMutation.isPending}
                preserveWidth
                disabled={saveMutation.isPending}
              >
                <Save size={14} aria-hidden="true" />
                {tr("保存修改")}
              </Button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <label className={labelClass} htmlFor="settings-name">
              班级名称
            </label>
            <input
              id="settings-name"
              className={inputClass}
              disabled={!editable}
              required
              value={name}
              onChange={(e) => {
                setSaveOutcome("clean");
                setName(e.target.value);
              }}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="settings-code">
              课程代码（只读）
            </label>
            <input id="settings-code" className={inputClass} disabled value={s.code} />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="settings-semester">
              学期
            </label>
            <input
              id="settings-semester"
              className={inputClass}
              disabled={!editable}
              required
              value={semester}
              onChange={(e) => {
                setSaveOutcome("clean");
                setSemester(e.target.value);
              }}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="settings-college">
              学院
            </label>
            <input
              id="settings-college"
              className={inputClass}
              disabled={!editable}
              required
              value={college}
              onChange={(e) => {
                setSaveOutcome("clean");
                setCollege(e.target.value);
              }}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="settings-formation-deadline">
              组队截止时间
            </label>
            <input
              id="settings-formation-deadline"
              type="datetime-local"
              className={inputClass}
              disabled={!editable}
              value={formationDeadline}
              onChange={(e) => {
                setSaveOutcome("clean");
                setFormationDeadline(e.target.value);
              }}
            />
          </div>
          <div className="min-w-0">
            <label className={labelClass} htmlFor="settings-project-deadline">
              结项截止时间
            </label>
            <input
              id="settings-project-deadline"
              type="datetime-local"
              className={inputClass}
              disabled={!editable}
              value={projectDeadline}
              onChange={(e) => {
                setSaveOutcome("clean");
                setProjectDeadline(e.target.value);
              }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-3.5 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--gp-ink-soft,#4e5969)]">{tr("只读")}</span>
            <span className="gp-tabular text-[var(--gp-ink,#1f2329)]">
              {tr("队伍人数要求：{0}-{1} 人", {
                0: s.min_group_size,
                1: s.max_group_size,
              })}
            </span>
          </div>
          <Link
            href={`/teacher/courses/${courseId}/rules`}
            className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
          >
            {tr("规则与模板")}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>

        <div>
          <label className={labelClass} htmlFor="settings-desc">
            班级说明
          </label>
          <textarea
            id="settings-desc"
            rows={3}
            className={inputClass}
            disabled={!editable}
            value={description}
            onChange={(e) => {
              setSaveOutcome("clean");
              setDescription(e.target.value);
            }}
            placeholder="填写班级简介、上课时间或项目主题说明"
          />
        </div>
      </form>

      <div className={`${panelClass} space-y-4`}>
        <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">加入设置与邀请码</h2>
        <div className="flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <input
              type="radio"
              name="settings-join-mode"
              disabled={!editable}
              checked={joinMode === "direct"}
              onChange={() => {
                setSaveOutcome("clean");
                setJoinMode("direct");
              }}
            />
            直接加入（凭邀请码立即入班）
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--gp-ink-soft,#4e5969)]">
            <input
              type="radio"
              name="settings-join-mode"
              disabled={!editable}
              checked={joinMode === "approval"}
              onChange={() => {
                setSaveOutcome("clean");
                setJoinMode("approval");
              }}
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
        <div className={`${panelClass} space-y-4`}>
          <h2 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">课程状态与危险操作</h2>
          <div className="flex flex-wrap gap-3">
            {s.status === "active" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirmKind("end");
                  setConfirmName("");
                }}
              >
                <Power size={14} aria-hidden="true" />
                结束课程
              </Button>
            )}
            {!s.archived_at && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={archiveMutation.isPending}
                preserveWidth
                disabled={archiveMutation.isPending}
                onClick={() => archiveMutation.mutate()}
              >
                <Archive size={14} aria-hidden="true" />
                归档课程
              </Button>
            )}
            {s.is_owner && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!s.can_delete}
                className="border-red-200 text-[var(--gp-danger,#d93025)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                title={s.can_delete ? "永久删除空班级" : "需先结束课程且班级无学生和队伍"}
                onClick={() => {
                  setConfirmKind("delete");
                  setConfirmName("");
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                删除课程
              </Button>
            )}
          </div>
          <p className="gp-tabular text-xs text-[var(--gp-muted,#646a73)]">
            {tr("当前班级统计：{0} 名学生 · {1} 个队伍；仅已结束且无学生无队伍的空班级支持永久删除。", {
              0: s.student_count,
              1: s.group_count,
            })}
          </p>
        </div>
      )}

      <TeacherConfirmDialog
        open={Boolean(confirmKind)}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmKind(null);
            setConfirmName("");
          }
        }}
        tone="danger"
        title={confirmKind === "end" ? "二次确认：结束课程" : "二次确认：永久删除课程"}
        description={
          confirmKind === "end"
            ? "结束课程后，学生端所有项目内容将变为只读；您可以随时在设置中重新开启课程。"
            : "永久删除后该空班级及邀请码、规则记录将全部清理且无法恢复。"
        }
        confirmLabel={confirmKind === "end" ? tr("确认结束课程") : tr("确认永久删除")}
        confirmDisabled={
          confirmName.trim() !== s.name ||
          (confirmKind === "end" && !endReason.trim())
        }
        loading={endMutation.isPending || deleteMutation.isPending}
        onConfirm={() => {
          if (confirmKind === "end") endMutation.mutate();
          else if (confirmKind === "delete") deleteMutation.mutate();
        }}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--gp-danger,#d93025)]">
            <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
            <span>{tr("请输入班级名称「{0}」确认操作", { 0: s.name })}</span>
          </div>
          {confirmKind === "end" && (
            <div>
              <label className={labelClass} htmlFor="end-class-reason">
                结课原因
              </label>
              <input
                id="end-class-reason"
                className={inputClass}
                value={endReason}
                onChange={(e) => setEndReason(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor="confirm-class-name-input">
              {tr("请输入班级名称「{0}」确认操作", { 0: s.name })}
            </label>
            <input
              id="confirm-class-name-input"
              className={inputClass}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={s.name}
            />
          </div>
        </div>
      </TeacherConfirmDialog>
    </div>
  );
}
