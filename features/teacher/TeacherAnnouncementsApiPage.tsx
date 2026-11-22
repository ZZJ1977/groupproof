"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Eye, Megaphone, Pin, Plus, Send, Trash2 } from "lucide-react";
import { button, card, errorText, input, label, secondary } from "@/features/b/ui";
import {
  type AnnouncementPriority,
  teacherAnnouncementsApi,
  teacherAnnouncementsKeys,
} from "@/lib/api/teacher-announcements-client";
import { useTeacherPermissions } from "@/lib/hooks/use-teacher-permissions";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

const priorityLabel: Record<AnnouncementPriority, string> = {
  normal: "普通公告",
  important: "重要通知",
  urgent: "紧急通知",
};

const priorityBadge: Record<AnnouncementPriority, string> = {
  normal: "bg-slate-100 text-slate-700",
  important: "bg-amber-50 text-amber-800",
  urgent: "bg-red-50 text-red-700",
};

const dangerBtn =
  "inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50";

export function TeacherAnnouncementsApiPage({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const { userId } = useWorkspace();
  const perms = useTeacherPermissions(courseId);

  const [composeOpen, setComposeOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [priority, setPriority] = useState<AnnouncementPriority>("normal");
  const [isPinned, setIsPinned] = useState(false);
  const [activeReadsId, setActiveReadsId] = useState<string | null>(null);
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

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: teacherAnnouncementsKeys.list(userId, courseId) }),
      activeReadsId
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
      if (activeReadsId === annId) setActiveReadsId(null);
      setFeedback({ tone: "success", text: tr("公告已删除") });
      await invalidate();
    },
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
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
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{tr("课程公告")}</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {tr("发布班级置顶与分级公告，实时追踪学生已读回执并一键催读未读成员。")}
          </p>
        </div>
        {canPost && (
          <button
            type="button"
            onClick={() => setComposeOpen((v) => !v)}
            className={`${button} inline-flex items-center gap-1.5`}
          >
            <Plus size={15} />
            {tr("发布新公告")}
          </button>
        )}
      </div>

      {feedback && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`rounded-xl border px-4 py-3 text-sm ${
            feedback.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {feedback.text}
        </div>
      )}

      {composeOpen && canPost && (
        <div className={`${card} space-y-4 border-blue-200 bg-slate-50/60`}>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Megaphone size={16} className="text-blue-600" />
            {tr("撰写课程公告")}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className={label} htmlFor="ann-title">
                {tr("公告标题")}
              </label>
              <input
                id="ann-title"
                className={input}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={tr("例如：中期答辩顺序与评分要求")}
              />
            </div>
            <div>
              <label className={label} htmlFor="ann-priority">
                {tr("重要程度")}
              </label>
              <select
                id="ann-priority"
                className={input}
                value={priority}
                onChange={(e) => setPriority(e.target.value as AnnouncementPriority)}
              >
                <option value="normal">{tr("普通公告")}</option>
                <option value="important">{tr("重要通知")}</option>
                <option value="urgent">{tr("紧急通知（强提醒）")}</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="ann-content">
              {tr("公告正文")}
            </label>
            <textarea
              id="ann-content"
              rows={4}
              className={input}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={tr("请输入通知详细内容、截止时间或操作指引…")}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
              <input
                type="checkbox"
                checked={isPinned}
                onChange={(e) => setIsPinned(e.target.checked)}
              />
              {tr("置顶显示在班级公告栏与学生横条")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setComposeOpen(false)}
                className={secondary}
              >
                {tr("取消")}
              </button>
              <button
                type="button"
                disabled={!title.trim() || !content.trim() || createMut.isPending}
                onClick={() => createMut.mutate("draft")}
                className={secondary}
              >
                {tr("存为草稿")}
              </button>
              <button
                type="button"
                disabled={!title.trim() || !content.trim() || createMut.isPending}
                onClick={() => createMut.mutate("published")}
                className={button}
              >
                {createMut.isPending ? tr("发布中…") : tr("立即发布")}
              </button>
            </div>
          </div>
        </div>
      )}

      {listQuery.isLoading ? (
        <div className={card}>{tr("正在加载课程公告…")}</div>
      ) : listQuery.isError ? (
        <div className={`${card} text-sm text-red-600`}>{errorText(listQuery.error)}</div>
      ) : items.length === 0 ? (
        <div className={`${card} py-10 text-center text-sm text-slate-500`}>
          {tr("暂无课程公告，点击右上角「发布新公告」触达全班学生。")}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const active = activeReadsId === item.id;
            return (
              <div
                key={item.id}
                className={`${card} space-y-3 ${
                  item.is_pinned ? "border-blue-300 bg-blue-50/20" : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.is_pinned && (
                        <span className="inline-flex items-center gap-1 rounded bg-blue-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                          <Pin size={11} />
                          {tr("置顶")}
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          priorityBadge[item.priority]
                        }`}
                      >
                        {tr(priorityLabel[item.priority])}
                      </span>
                      {item.status === "draft" && (
                        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                          {tr("草稿")}
                        </span>
                      )}
                      <h2 className="text-base font-semibold text-slate-900">{item.title}</h2>
                    </div>
                    <p className="text-xs text-slate-500">
                      {tr("发布人：{0} · 已读 {1}/{2} 人", {
                        0: item.publisher_name ?? tr("教师"),
                        1: item.read_count,
                        2: item.total_students,
                      })}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveReadsId(active ? null : item.id)}
                      className={`${secondary} inline-flex items-center gap-1 text-xs`}
                    >
                      <Eye size={13} />
                      {tr("阅读统计")}
                    </button>
                    {canPost && (
                      <>
                        {item.status === "draft" && (
                          <button
                            type="button"
                            onClick={() => publishDraftMut.mutate(item.id)}
                            className={`${button} text-xs`}
                          >
                            {tr("正式发布")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            togglePinMut.mutate({ id: item.id, nextPinned: !item.is_pinned })
                          }
                          className={`${secondary} inline-flex items-center gap-1 text-xs`}
                        >
                          <Pin size={13} />
                          {item.is_pinned ? tr("取消置顶") : tr("置顶")}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMut.mutate(item.id)}
                          className={dangerBtn}
                        >
                          <Trash2 size={13} />
                          {tr("删除")}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                  {item.content}
                </p>

                {active && readsQuery.data && (
                  <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                        <Bell size={14} />
                        {tr("已读 {0} 人 · 未读 {1} 人", {
                          0: readsQuery.data.read_count,
                          1: readsQuery.data.unread_count,
                        })}
                      </div>
                      {canPost && readsQuery.data.unread_count > 0 && item.status === "published" && (
                        <button
                          type="button"
                          disabled={remindMut.isPending}
                          onClick={() => remindMut.mutate(item.id)}
                          className={`${button} inline-flex items-center gap-1 text-xs`}
                        >
                          <Send size={12} />
                          {tr("催读未读学生")}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="rounded border border-slate-200 bg-white p-2.5">
                        <div className="mb-1.5 text-xs font-semibold text-emerald-700">
                          {tr("已读名单")}
                        </div>
                        {readsQuery.data.read_users.length === 0 ? (
                          <div className="text-xs text-slate-400">{tr("暂无已读记录")}</div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {readsQuery.data.read_users.map((u) => (
                              <span
                                key={u.user_id}
                                className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                              >
                                {u.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="rounded border border-slate-200 bg-white p-2.5">
                        <div className="mb-1.5 text-xs font-semibold text-amber-700">
                          {tr("未读名单")}
                        </div>
                        {readsQuery.data.unread_users.length === 0 ? (
                          <div className="text-xs text-slate-400">{tr("全部学生已阅读")}</div>
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
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
