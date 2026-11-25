"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import {
  Bell,
  ClipboardList,
  Eye,
  Folder,
  Megaphone,
  Pin,
  Plus,
  Send,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { errorText } from "@/shared/lib/b-ui";
import { TeacherConfirmDialog } from "@/teacher/components/TeacherConfirmDialog";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import {
  type AnnouncementPriority,
  teacherAnnouncementsApi,
  teacherAnnouncementsKeys,
} from "@/teacher/api/teacher-announcements-client";
import { useTeacherPermissions } from "@/teacher/hooks/use-teacher-permissions";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const inputClass =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)] disabled:cursor-not-allowed disabled:bg-[var(--gp-surface-subtle,#f8f9fa)] disabled:text-[var(--gp-muted,#646a73)]";
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

const priorityLabel: Record<AnnouncementPriority, string> = {
  normal: "普通公告",
  important: "重要通知",
  urgent: "紧急通知",
};

const priorityBadge: Record<AnnouncementPriority, string> = {
  normal: "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-ink-soft,#4e5969)]",
  important: "bg-amber-50 text-amber-800",
  urgent: "bg-red-50 text-[var(--gp-danger,#d93025)]",
};

export function TeacherAnnouncementsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const locale = useLocale();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const confirmDeleteLabel = [tr("确认"), tr("删除")].join(locale === "en" ? " " : "");

  const [composeOpen, setComposeOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [priority, setPriority] = useState<AnnouncementPriority>("normal");
  const [isPinned, setIsPinned] = useState(false);
  const [activeReadsId, setActiveReadsId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const listQuery = useQuery({
    queryKey: teacherAnnouncementsKeys.list(userId, courseId),
    queryFn: () => teacherAnnouncementsApi.list(courseId),
    enabled: Boolean(courseId),
  });

  const readsQuery = useQuery({
    queryKey: teacherAnnouncementsKeys.reads(userId, courseId, activeReadsId ?? ""),
    queryFn: () => teacherAnnouncementsApi.reads(courseId, activeReadsId as string),
    enabled: Boolean(courseId && activeReadsId),
  });

  const canPost = listQuery.data?.can_post ?? perms.postAnnouncements;

  const invalidate = async (opts?: { skipReadsId?: string }) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: teacherAnnouncementsKeys.list(userId, courseId) }),
      activeReadsId && activeReadsId !== opts?.skipReadsId
        ? qc.invalidateQueries({
            queryKey: teacherAnnouncementsKeys.reads(userId, courseId, activeReadsId),
          })
        : Promise.resolve(),
    ]);
  };

  const createMut = useMutation({
    mutationFn: (status: "draft" | "published") =>
      teacherAnnouncementsApi.create(courseId, {
        title: title.trim(),
        content: content.trim(),
        priority,
        is_pinned: isPinned,
        status,
      }),
    onSuccess: async (_res, status) => {
      setTitle("");
      setContent("");
      setPriority("normal");
      setIsPinned(false);
      setComposeOpen(false);
      setFeedback({
        tone: "success",
        text: status === "published" ? tr("公告已发布并通知全班学生") : tr("草稿已保存"),
      });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const togglePinMut = useMutation({
    mutationFn: (vars: { id: string; nextPinned: boolean }) =>
      teacherAnnouncementsApi.update(courseId, vars.id, { is_pinned: vars.nextPinned }),
    onSuccess: async (_res, vars) => {
      setFeedback({
        tone: "success",
        text: vars.nextPinned ? tr("已置顶公告") : tr("已取消置顶"),
      });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const publishDraftMut = useMutation({
    mutationFn: (annId: string) =>
      teacherAnnouncementsApi.update(courseId, annId, { status: "published" }),
    onSuccess: async () => {
      setFeedback({ tone: "success", text: tr("草稿已正式发布") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const deleteMut = useMutation({
    mutationFn: (annId: string) => teacherAnnouncementsApi.remove(courseId, annId),
    onSuccess: async (_res, annId) => {
      await qc.cancelQueries({
        queryKey: teacherAnnouncementsKeys.reads(userId, courseId, annId),
      });
      qc.removeQueries({
        queryKey: teacherAnnouncementsKeys.reads(userId, courseId, annId),
      });
      setActiveReadsId((prev) => (prev === annId ? null : prev));
      setConfirmDelete(null);
      setFeedback({ tone: "success", text: tr("公告已删除") });
      await invalidate({ skipReadsId: annId });
    },
    onError: (err) => {
      setConfirmDelete(null);
      setFeedback({ tone: "error", text: errorText(err) });
    },
  });

  const remindMut = useMutation({
    mutationFn: (annId: string) => teacherAnnouncementsApi.remind(courseId, annId),
    onSuccess: async (res) => {
      setFeedback({
        tone: "success",
        text: tr("已向 {0} 位未读学生发送催读通知", { 0: res.notified_count }),
      });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const items = listQuery.data?.items ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          variant="segmented"
          size="sm"
          ariaLabel={tr("切换子页面")}
          testId="hub5-segmented-tabs"
          activeId="announcements"
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
        <TeacherFeedbackPill
          tone={feedback?.tone ?? "idle"}
          message={feedback?.text}
          autoHideMs={3500}
          onDismiss={() => setFeedback(null)}
        />
      </div>

      <div className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--gp-ink,#1f2329)]">{tr("课程公告")}</h1>
          <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("发布班级置顶与分级公告，实时追踪学生已读回执并一键催读未读成员。")}
          </p>
        </div>
        {canPost && (
          <Button
            type="button"
            variant="default"
            size="sm"
            pill
            onClick={() => setComposeOpen(true)}
          >
            <Plus size={15} aria-hidden="true" />
            {tr("发布新公告")}
          </Button>
        )}
      </div>

      {listQuery.isLoading ? (
        <div role="status" className={`${panelClass} text-sm text-[var(--gp-muted,#646a73)]`}>
          {tr("正在加载课程公告…")}
        </div>
      ) : listQuery.isError ? (
        <div
          role="alert"
          className={`${panelClass} flex flex-wrap items-center justify-between gap-3 border-red-200 bg-red-50 text-sm text-[var(--gp-danger,#d93025)]`}
        >
          <span>{errorText(listQuery.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
            {tr("重试")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className={`${panelClass} py-10 text-center text-sm text-[var(--gp-muted,#646a73)]`}>
          {tr("暂无课程公告，点击右上角「发布新公告」触达全班学生。")}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const active = activeReadsId === item.id;
            return (
              <div
                key={item.id}
                className={`${panelClass} space-y-3 ${
                  item.is_pinned ? "border-blue-300 bg-blue-50/20" : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.is_pinned && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-[var(--gp-action,#3370ff)] px-1.5 py-0.5 text-[11px] font-semibold text-white">
                          <Pin size={11} aria-hidden="true" />
                          {tr("置顶")}
                        </span>
                      )}
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          priorityBadge[item.priority]
                        }`}
                      >
                        {tr(priorityLabel[item.priority])}
                      </span>
                      {item.status === "draft" && (
                        <span className="shrink-0 rounded bg-[var(--gp-surface-hover,#eff0f1)] px-1.5 py-0.5 text-[11px] text-[var(--gp-ink-soft,#4e5969)]">
                          {tr("草稿")}
                        </span>
                      )}
                      <h2 className="min-w-0 break-words text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                        {item.title}
                      </h2>
                    </div>
                    <p className="gp-tabular text-xs text-[var(--gp-muted,#646a73)]">
                      {tr("发布人：{0} · 已读 {1}/{2} 人", {
                        0: item.publisher_name ?? tr("教师"),
                        1: item.read_count,
                        2: item.total_students,
                      })}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant={active && item.status !== "draft" ? "tonal" : "outline"}
                      size="sm"
                      className={
                        active && item.status === "draft"
                          ? "border-[var(--gp-action,#3370ff)] text-[var(--gp-action-on-soft,#1d4ed8)]"
                          : undefined
                      }
                      onClick={() => setActiveReadsId(active ? null : item.id)}
                    >
                      <Eye size={13} aria-hidden="true" />
                      {tr("阅读统计")}
                    </Button>
                    {canPost && (
                      <>
                        {item.status === "draft" && (
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            pill
                            loading={
                              publishDraftMut.isPending && publishDraftMut.variables === item.id
                            }
                            preserveWidth
                            disabled={publishDraftMut.isPending}
                            onClick={() => publishDraftMut.mutate(item.id)}
                          >
                            {tr("正式发布")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          loading={
                            togglePinMut.isPending && togglePinMut.variables?.id === item.id
                          }
                          preserveWidth
                          disabled={togglePinMut.isPending}
                          onClick={() =>
                            togglePinMut.mutate({ id: item.id, nextPinned: !item.is_pinned })
                          }
                        >
                          <Pin size={13} aria-hidden="true" />
                          {item.is_pinned ? tr("取消置顶") : tr("置顶")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={deleteMut.isPending}
                          className="text-[var(--gp-danger,#d93025)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                          onClick={() => setConfirmDelete({ id: item.id, title: item.title })}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          {tr("删除")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--gp-ink-soft,#4e5969)]">
                  {item.content}
                </p>

                {active && (
                  <div className="space-y-3 rounded-[10px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3.5">
                    {readsQuery.isLoading ? (
                      <p role="status" className="text-xs text-[var(--gp-muted,#646a73)]">
                        {tr("正在加载…")}
                      </p>
                    ) : readsQuery.isError ? (
                      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--gp-danger,#d93025)]">
                        <span>{errorText(readsQuery.error)}</span>
                        <Button type="button" variant="outline" size="sm" onClick={() => void readsQuery.refetch()}>
                          {tr("重试")}
                        </Button>
                      </div>
                    ) : (
                      readsQuery.data && (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="gp-tabular flex items-center gap-2 text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
                              <Bell size={14} aria-hidden="true" />
                              {tr("已读 {0} 人 · 未读 {1} 人", {
                                0: readsQuery.data.read_count,
                                1: readsQuery.data.unread_count,
                              })}
                            </div>
                            {canPost &&
                              readsQuery.data.unread_count > 0 &&
                              item.status === "published" && (
                                <Button
                                  type="button"
                                  variant="tonal"
                                  size="sm"
                                  pill
                                  loading={remindMut.isPending && remindMut.variables === item.id}
                                  preserveWidth
                                  disabled={remindMut.isPending}
                                  onClick={() => remindMut.mutate(item.id)}
                                >
                                  <Send size={12} aria-hidden="true" />
                                  {tr("催读未读学生")}
                                </Button>
                              )}
                          </div>
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <div className="rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-2.5">
                              <div className="mb-1.5 text-xs font-semibold text-[var(--gp-success,#008a5c)]">
                                {tr("已读名单")}
                              </div>
                              {readsQuery.data.read_users.length === 0 ? (
                                <div className="text-xs text-[var(--gp-subtle,#8f959e)]">
                                  {tr("暂无已读记录")}
                                </div>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {readsQuery.data.read_users.map((u) => (
                                    <span
                                      key={u.user_id}
                                      className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-[var(--gp-success,#008a5c)]"
                                    >
                                      {u.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-2.5">
                              <div className="mb-1.5 text-xs font-semibold text-[var(--gp-warning,#d97706)]">
                                {tr("未读名单")}
                              </div>
                              {readsQuery.data.unread_users.length === 0 ? (
                                <div className="text-xs text-[var(--gp-subtle,#8f959e)]">
                                  {tr("全部学生已阅读")}
                                </div>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {readsQuery.data.unread_users.map((u) => (
                                    <span
                                      key={u.user_id}
                                      className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
                                    >
                                      {u.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Sheet
        open={composeOpen}
        onOpenChange={(open) => {
          if (createMut.isPending && !open) return;
          setComposeOpen(open);
        }}
      >
        <SheetContent
          side="right"
          className="flex flex-col justify-between"
          onEscapeKeyDown={(event) => {
            if (createMut.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (createMut.isPending) event.preventDefault();
          }}
        >
          <div className="space-y-4">
            <SheetHeader className="pr-8">
              <SheetTitle className="flex items-center gap-2 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                <Megaphone size={16} className="text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
                {tr("撰写课程公告")}
              </SheetTitle>
              <SheetDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                {tr("发布班级置顶与分级公告，实时追踪学生已读回执并一键催读未读成员。")}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-3">
              <div>
                <label className={labelClass} htmlFor="ann-title">
                  {tr("公告标题")}
                </label>
                <input
                  id="ann-title"
                  className={inputClass}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={tr("例如：中期答辩顺序与评分要求")}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="ann-priority">
                  {tr("重要程度")}
                </label>
                <select
                  id="ann-priority"
                  className={inputClass}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as AnnouncementPriority)}
                >
                  <option value="normal">{tr("普通公告")}</option>
                  <option value="important">{tr("重要通知")}</option>
                  <option value="urgent">{tr("紧急通知（强提醒）")}</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="ann-content">
                  {tr("公告正文")}
                </label>
                <textarea
                  id="ann-content"
                  rows={5}
                  className={inputClass}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={tr("请输入通知详细内容、截止时间或操作指引…")}
                />
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={(e) => setIsPinned(e.target.checked)}
                />
                {tr("置顶显示在班级公告栏与学生横条")}
              </label>
            </div>
          </div>

          <SheetFooter className="flex-wrap border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={createMut.isPending}
              onClick={() => setComposeOpen(false)}
            >
              {tr("取消")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={createMut.isPending && createMut.variables === "draft"}
              preserveWidth
              disabled={!title.trim() || !content.trim() || createMut.isPending}
              onClick={() => createMut.mutate("draft")}
            >
              {tr("存为草稿")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              pill
              loading={createMut.isPending && createMut.variables === "published"}
              preserveWidth
              disabled={!title.trim() || !content.trim() || createMut.isPending}
              onClick={() => createMut.mutate("published")}
            >
              {tr("立即发布")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <TeacherConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(open) => {
          if (!open && !deleteMut.isPending) setConfirmDelete(null);
        }}
        tone="danger"
        title={tr("删除")}
        description={confirmDelete?.title}
        confirmLabel={confirmDeleteLabel}
        loading={deleteMut.isPending}
        onConfirm={() => {
          if (confirmDelete) deleteMut.mutate(confirmDelete.id);
        }}
      />
    </div>
  );
}
