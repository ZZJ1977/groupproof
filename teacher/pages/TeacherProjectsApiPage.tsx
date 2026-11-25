"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, ListTree } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { errorText } from "@/shared/lib/b-ui";
import { ProjectOverviewCard } from "@/teacher/components/ProjectOverviewCard";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import { teacherProjectsApi, teacherProjectsKeys } from "@/teacher/api/teacher-projects-client";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";

type ProjectFilter = "all" | "initialized" | "uninitialized" | "at_risk";

const panelClass =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";

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
  const remindingGroupId = remindMut.isPending ? (remindMut.variables ?? null) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeacherSegmentedTabs
          variant="segmented"
          size="sm"
          ariaLabel={tr("项目与报告")}
          testId="hub4-segmented-tabs"
          activeId="projects"
          items={[
            {
              id: "projects",
              label: tr("项目监控"),
              href: `/teacher/courses/${courseId}/projects`,
              icon: ListTree,
            },
            {
              id: "reports",
              label: tr("班级数据报告"),
              href: `/teacher/courses/${courseId}/reports`,
              icon: BarChart3,
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
          <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--gp-ink,#1f2329)]">
            <ListTree size={18} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
            <span>{tr("项目总览与督办")}</span>
          </h1>
          <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
            {tr("全班小组项目进展卡片视图，直观识别未立项小组与滞后项目并一键发送催办。")}
          </p>
        </div>

        <TeacherSegmentedTabs<ProjectFilter>
          variant="segmented"
          size="sm"
          ariaLabel={tr("项目总览与督办")}
          activeId={filter}
          onChange={setFilter}
          className="max-w-full"
          items={[
            { id: "all", label: tr("全部小组 ({0})", { 0: counts.all ?? 0 }) },
            { id: "initialized", label: tr("已立项 ({0})", { 0: counts.initialized ?? 0 }) },
            { id: "uninitialized", label: tr("未立项 ({0})", { 0: counts.uninitialized ?? 0 }) },
            { id: "at_risk", label: tr("风险预警 ({0})", { 0: counts.at_risk ?? 0 }) },
          ]}
        />
      </div>

      {listQuery.isLoading ? (
        <div role="status" className={`${panelClass} text-sm text-[var(--gp-muted,#646a73)]`}>
          {tr("正在加载全班项目总览…")}
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
      ) : filtered.length === 0 ? (
        <div className={`${panelClass} py-10 text-center text-sm text-[var(--gp-muted,#646a73)]`}>
          {tr("当前筛选条件下暂无小组")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((item) => (
            <ProjectOverviewCard
              key={item.group_id}
              item={item}
              canRemind={listQuery.data?.can_remind ?? true}
              reminding={remindingGroupId === item.group_id}
              remindDisabled={remindMut.isPending}
              onRemind={(groupId) => remindMut.mutate(groupId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
