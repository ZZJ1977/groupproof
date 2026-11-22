"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ListTree } from "lucide-react";
import { card, errorText } from "@/features/b/ui";
import { ProjectOverviewCard } from "@/features/teacher/ProjectOverviewCard";
import { teacherProjectsApi, teacherProjectsKeys } from "@/lib/api/teacher-projects-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";

type ProjectFilter = "all" | "initialized" | "uninitialized" | "at_risk";

export function TeacherProjectsApiPage({ courseId }: { courseId: string }) {
  const { userId } = useWorkspace();
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const listQuery = useQuery({
    queryKey: teacherProjectsKeys.list(userId, courseId),
    queryFn: () => teacherProjectsApi.list(courseId),
    enabled: Boolean(courseId),
  });

  const remindMut = useMutation({
    mutationFn: (groupId: string) => teacherProjectsApi.remind(courseId, groupId),
    onSuccess: (res) =>
      setFeedback({
        tone: "success",
        text: tr("已向组内 {0} 名成员发送催办通知", { 0: res.notified_count }),
      }),
    onError: (err) => setFeedback({ tone: "error", text: errorText(err) }),
  });

  const filtered = useMemo(() => {
    const items = listQuery.data?.items ?? [];
    if (filter === "initialized") return items.filter((i) => i.has_project);
    if (filter === "uninitialized") return items.filter((i) => !i.has_project);
    if (filter === "at_risk") {
      return items.filter(
        (i) => i.risk_level === "high" || i.risk_level === "medium" || i.overdue_milestones > 0,
      );
    }
    return items;
  }, [listQuery.data?.items, filter]);

  const counts = listQuery.data?.counts ?? {};

  return (
    <div className="space-y-5">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <ListTree size={18} className="text-blue-600" />
            {tr("项目总览与督办")}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {tr("全班小组项目进展卡片视图，直观识别未立项小组与滞后项目并一键发送催办。")}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            { key: "all" as const, label: tr("全部小组 ({0})", { 0: counts.all ?? 0 }) },
            {
              key: "initialized" as const,
              label: tr("已立项 ({0})", { 0: counts.initialized ?? 0 }),
            },
            {
              key: "uninitialized" as const,
              label: tr("未立项 ({0})", { 0: counts.uninitialized ?? 0 }),
            },
            { key: "at_risk" as const, label: tr("风险预警 ({0})", { 0: counts.at_risk ?? 0 }) },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                filter === tab.key
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
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

      {listQuery.isLoading ? (
        <div className={card}>{tr("正在加载全班项目总览…")}</div>
      ) : listQuery.isError ? (
        <div className={`${card} text-sm text-red-600`}>{errorText(listQuery.error)}</div>
      ) : filtered.length === 0 ? (
        <div className={`${card} py-10 text-center text-sm text-slate-500`}>
          {tr("当前筛选条件下暂无小组")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <ProjectOverviewCard
              key={item.group_id}
              item={item}
              canRemind={listQuery.data?.can_remind ?? true}
              reminding={remindMut.isPending}
              onRemind={(groupId) => remindMut.mutate(groupId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
