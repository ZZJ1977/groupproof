"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronDown, ChevronUp, Pin } from "lucide-react";
import { apiMode } from "@/shared/lib/api-config";
import {
  type AnnouncementItem,
  teacherAnnouncementsApi,
  teacherAnnouncementsKeys,
} from "@/teacher/api/teacher-announcements-client";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

/** Student-only top banner for unread course announcements when B workspace API is active. */
export function AnnouncementBanner() {
  const qc = useQueryClient();
  const { userId, role } = useWorkspace();
  const [expandedItem, setExpandedItem] = useState<AnnouncementItem | null>(null);
  const enabled = role === "student" && apiMode("bworkspace") === "real" && Boolean(userId);

  const unread = useQuery({
    queryKey: teacherAnnouncementsKeys.studentUnread(userId),
    queryFn: () => teacherAnnouncementsApi.myUnread(),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  const markRead = useMutation({
    mutationFn: (vars: { courseId: string; announcementId: string }) =>
      teacherAnnouncementsApi.markRead(vars.courseId, vars.announcementId),
  });

  if (!enabled) return null;
  if (!expandedItem && (unread.isLoading || unread.isError)) return null;

  const items = unread.data?.items ?? [];
  const top = expandedItem ?? items[0];
  if (!top) return null;

  const expanded = Boolean(expandedItem && expandedItem.id === top.id);

  const handleToggle = () => {
    if (expanded) {
      setExpandedItem(null);
      void qc.invalidateQueries({ queryKey: teacherAnnouncementsKeys.studentUnread(userId) });
      return;
    }
    setExpandedItem(top);
    markRead.mutate({ courseId: top.course_id, announcementId: top.id });
  };

  return (
    <div
      className={`mb-4 rounded-xl border px-4 py-3 ${
        top.priority === "urgent"
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-amber-200 bg-amber-50 text-amber-950"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <Bell size={15} className="shrink-0" />
          {top.is_pinned && <Pin size={13} className="shrink-0" />}
          <span className="shrink-0 rounded bg-white/80 px-1.5 py-0.5 text-xs font-semibold">
            {top.course_name}
          </span>
          <button
            type="button"
            onClick={handleToggle}
            className="truncate text-left font-semibold hover:underline"
          >
            {top.title}
          </button>
          {items.length > 1 && (
            <span className="shrink-0 text-xs opacity-75">
              {tr("还有 {0} 条未读公告", { 0: items.length - 1 })}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleToggle}
          className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
        >
          {expanded ? (
            <>
              {tr("收起并标为已读")}
              <ChevronUp size={14} />
            </>
          ) : (
            <>
              {tr("展开查看")}
              <ChevronDown size={14} />
            </>
          )}
        </button>
      </div>
      {expanded && (
        <div className="mt-2.5 border-t border-black/10 pt-2.5 text-sm leading-relaxed">
          {top.content}
        </div>
      )}
    </div>
  );
}
