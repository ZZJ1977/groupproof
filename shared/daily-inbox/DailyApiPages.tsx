"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Activity, ArrowRight, Bell, BookOpen, CheckSquare, Folder, Home, Plus, RefreshCw } from "lucide-react";
import "@/shared/styles/lux-teacher.css";
import { JellyActionRow } from "@/shared/components/lux/JellyActionRow";
import { EmptyState, PageHeader, ProgressBar, Stat, StatusBadge } from "@/shared/components/common";
import { Button, buttonVariants } from "@/shared/components/ui/button";
import { useGpThemeScope } from "@/shared/components/ui/theme-scope";
import { projectRequest } from "@/shared/lib/integration-request";
import { AnnouncementBanner } from "@/shared/components/AnnouncementBanner";
import { CreateProjectModal } from "@/student/projects/CreateProjectModal";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/teacher/components/TeacherSegmentedTabs";
import { CApiError, createCClient, type DailyActivityQuery } from "@/shared/daily-inbox/c-client";
import { apiErrorText } from "@/shared/i18n/api-error-text";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";
import { cn, formatDate } from "@/shared/lib/utils";
import { useUrlQuery } from "@/shared/lib/use-url-query";
import { MyAccessRequests } from "@/admin/pages/GovernanceApiPages";
import { HomeInboxPanel } from "@/shared/daily-inbox/HomeInboxPanel";

const client = createCClient();
const buttonClass = "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-all hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "h-9 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";
const feishuCard =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuInput =
  "rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-1.5 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[#3370ff]/15";
const categoryLabels = { all: "全部", development: "开发", evidence: "证据", discussion: "讨论" } as const;
const categoryDotClass: Record<keyof typeof categoryLabels, string> = {
  all: "bg-slate-400",
  development: "bg-sky-500",
  evidence: "bg-emerald-500",
  discussion: "bg-violet-500",
};
const activityLabels = {
  task_progress: "更新任务进度或状态", task_note_saved: "保存实现说明", file_version_uploaded: "登记项目文件版本",
  github_commit: "GitHub 提交", github_pull_request: "GitHub 拉取请求", github_ci_run: "GitHub CI 运行",
  evidence_submitted: "提交候选证据", evidence_adopted: "采纳证据", evidence_withdrawn: "撤回证据",
  evidence_source_changed: "证据来源变化", discussion_created: "发布讨论", discussion_replied: "回复讨论",
};

function QueryFailure({ error, retry }: { error: Error; retry: () => void }) {
  const isTeacher = useGpThemeScope() === "teacher";
  const message = error instanceof CApiError && error.status === 401
    ? "当前登录身份暂时无法读取此服务，请重新登录或稍后重试。"
    : error instanceof CApiError && error.status === 403
      ? "你目前没有权限读取这些数据。"
      : error instanceof CApiError ? apiErrorText(error) : "数据暂不可用，请重试。";
  if (isTeacher) {
    return (
      <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}>
        <TeacherFeedbackPill tone="error" message={tr(message)} />
        <Button type="button" variant="outline" size="sm" pill onClick={retry}>
          {tr("重试")}
        </Button>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-2xl border border-rose-200/85 bg-rose-50/40 p-4 text-sm text-rose-800 shadow-xs">
      <p>{message}</p>
      <button className={`${buttonClass} mt-3`} type="button" onClick={retry}>重试</button>
    </div>
  );
}

function ProjectIntegrationStatus({ projectId, userId }: { projectId: string; userId: string }) {
  const isTeacher = useGpThemeScope() === "teacher";
  const repos = useQuery({
    queryKey: ["project-integration-repos", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${projectId}/github/repos`, { signal }),
    retry: false,
  });
  const chats = useQuery({
    queryKey: ["project-integration-chats", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${projectId}/feishu/chats`, { signal }),
    retry: false,
  });
  const githubLabel = repos.isPending
    ? "GitHub 状态读取中"
    : repos.isError
      ? "GitHub 状态暂不可用"
      : repos.data.length > 0
        ? tr("GitHub 已连接 · {0} 个仓库", { 0: repos.data.length })
        : "GitHub 未连接";
  const feishuLabel = chats.isPending
    ? "飞书状态读取中"
    : chats.isError
      ? "飞书状态暂不可用"
      : chats.data.length > 0
        ? tr("飞书已接入 · {0} 个群", { 0: chats.data.length })
        : "飞书未接入";
  if (isTeacher) {
    const chipClass =
      "inline-flex items-center rounded-full border border-[var(--gp-border-subtle,#ebedf0)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-2.5 py-1 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)] transition-colors hover:border-[var(--gp-action,#3370ff)]/45 hover:text-[var(--gp-action,#3370ff)]";
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        <Link className={chipClass} href={`/projects/${encodeURIComponent(projectId)}/settings#github-integration`}>
          {githubLabel}
        </Link>
        <Link className={chipClass} href={`/projects/${encodeURIComponent(projectId)}/settings#feishu-integration`}>
          {feishuLabel}
        </Link>
      </div>
    );
  }
  const githubConnected = repos.isSuccess && repos.data.length > 0;
  const feishuConnected = chats.isSuccess && chats.data.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <Link
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition ${
          githubConnected
            ? "border-emerald-200 bg-emerald-50/80 text-emerald-800 hover:bg-emerald-100/80"
            : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700"
        }`}
        href={`/projects/${encodeURIComponent(projectId)}/settings#github-integration`}
      >
        {githubLabel}
      </Link>
      <Link
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition ${
          feishuConnected
            ? "border-sky-200 bg-sky-50/80 text-sky-800 hover:bg-sky-100/80"
            : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700"
        }`}
        href={`/projects/${encodeURIComponent(projectId)}/settings#feishu-integration`}
      >
        {feishuLabel}
      </Link>
    </div>
  );
}

/** Canonical queries only; workspace data and demo roles are never a data source. */
export function HomeApiPage() {
  const { userId, role } = useWorkspace();
  const scope = useGpThemeScope();
  const isTeacher = role === "teacher" || role === "ta";
  const t = useTranslations("core.home");
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [refreshPulse, setRefreshPulse] = useState(false);
  const result = useQuery({ queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;

  useEffect(() => {
    if (result.isFetching || !refreshPulse) return;
    const timer = window.setTimeout(() => setRefreshPulse(false), 480);
    return () => window.clearTimeout(timer);
  }, [result.isFetching, refreshPulse]);

  const isRefreshing = result.isFetching || refreshPulse;
  const refreshDir = refreshSeq === 0 ? "init" : refreshSeq % 2 === 1 ? "next" : "prev";
  const triggerRefresh = () => {
    setRefreshSeq((prev) => prev + 1);
    setRefreshPulse(true);
    void result.refetch();
  };
  const recentActivity = useQuery({
    queryKey: ["c-home-recent-activity", userId],
    queryFn: () => client.personalActivity({ category: "all", page: 1, page_size: 4 }),
    enabled: scope !== "teacher" && Boolean(data),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  if (scope === "teacher") {
    const quickCards = [
      {
        href: "/teacher/dashboard",
        title: tr("教师工作台"),
        desc: tr("跨班统计、风险与预警概览"),
        icon: Activity,
        badge: null as string | number | null,
        badgeTone: "neutral" as const,
      },
      {
        href: "/teacher/courses",
        title: tr("我的班级"),
        desc: tr("班级管理、邀请码与组队广场"),
        icon: BookOpen,
        badge: data ? data.course_count : null,
        badgeTone: "blue" as const,
      },
      {
        href: "/notifications",
        title: tr("通知"),
        desc: tr("接收学生消息与动态通知"),
        icon: Bell,
        badge: data ? (data.unread_notifications ?? tr("暂不可用")) : null,
        badgeTone:
          typeof data?.unread_notifications === "number" && data.unread_notifications > 0
            ? ("danger" as const)
            : ("neutral" as const),
      },
      {
        href: "/action-items",
        title: tr("待处理事项"),
        desc: tr("待审批与需要处理事项"),
        icon: CheckSquare,
        badge: data ? (data.pending_action_items ?? tr("暂不可用")) : null,
        badgeTone:
          typeof data?.pending_action_items === "number" && data.pending_action_items > 0
            ? ("warning" as const)
            : ("neutral" as const),
      },
    ];

    return (
      <div className="min-w-0 max-w-full space-y-6">
        <AnnouncementBanner />

        <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-4")}>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--gp-ink,#1f2329)]">
              <Home size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
              <span className="truncate">{t("title")}</span>
            </h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              {tr("根据你当前的课程、项目和任务计算。")}
            </p>
          </div>
          <JellyActionRow pill ariaLabel={t("title")}>
            <Link
              href="/teacher/courses"
              data-variant="default"
              className={buttonVariants({ variant: "default", size: "sm", pill: true })}
            >
              <Plus size={15} aria-hidden="true" />
              {tr("我的班级 / 创建班级")}
            </Link>
            <Link
              href="/teacher/dashboard"
              data-variant="outline"
              className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
            >
              <Activity size={15} aria-hidden="true" />
              {tr("教师工作台")}
            </Link>
            <Link
              href="/projects/new"
              data-variant="outline"
              className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
            >
              <Folder size={15} aria-hidden="true" />
              {t("createProject")}
            </Link>
            <Link
              href="/courses/join"
              data-variant="outline"
              className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
            >
              <BookOpen size={15} aria-hidden="true" />
              {t("joinCourse")}
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              pill
              disabled={result.isFetching}
              aria-busy={result.isFetching || undefined}
              onClick={triggerRefresh}
            >
              <RefreshCw
                size={14}
                className={cn("gp-refresh-icon", isRefreshing && "is-spinning")}
                aria-hidden="true"
              />
              {tr("刷新统计")}
            </Button>
          </JellyActionRow>
        </div>

        <div className="gp-stagger-list grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {quickCards.map((card) => {
            const CardIcon = card.icon;
            return (
              <Link
                key={card.href}
                href={card.href}
                className="gp-card-interactive flex min-w-0 flex-col justify-between gap-2.5 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] hover:border-[var(--gp-action,#3370ff)]/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action,#3370ff)]">
                      <CardIcon size={16} aria-hidden="true" />
                    </span>
                    <span className="truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                      {card.title}
                    </span>
                  </div>
                  {card.badge !== null ? (
                    <span
                      className={cn(
                        "gp-tabular shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        card.badgeTone === "danger"
                          ? "bg-[#fef2f2] text-[#d93025]"
                          : card.badgeTone === "warning"
                            ? "bg-[#fffbeb] text-[#b45309]"
                            : card.badgeTone === "blue"
                              ? "bg-[var(--gp-action-soft,#e8f0fe)] text-[var(--gp-action-on-soft,#1d4ed8)]"
                              : "bg-[var(--gp-surface-hover,#eff0f1)] text-[var(--gp-muted,#646a73)]",
                      )}
                    >
                      {card.badge}
                    </span>
                  ) : (
                    <ArrowRight size={14} className="shrink-0 text-[var(--gp-subtle,#8f959e)]" aria-hidden="true" />
                  )}
                </div>
                <p className="text-xs text-[var(--gp-muted,#646a73)]">{card.desc}</p>
              </Link>
            );
          })}
        </div>

        {result.isFetching && (
          <div role="status" className="space-y-5">
            <span className="sr-only">{tr("正在读取首页…")}</span>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className={cn(feishuCard, "animate-pulse space-y-3")}>
                  <div className="h-3 w-24 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
                  <div className="h-7 w-16 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {[0, 1].map((idx) => (
                <div key={idx} className={cn(feishuCard, "animate-pulse space-y-3")}>
                  <div className="h-4 w-32 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
                  <div className="h-24 rounded-[12px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
                  <div className="h-24 rounded-[12px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
                </div>
              ))}
            </div>
          </div>
        )}

        {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}

        {data && (
          <>
            <div className="space-y-2">
              <div
                key={refreshSeq}
                data-refresh-dir={refreshDir}
                className="gp-jelly-stat-grid grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <Stat label={t("myCourses")} value={data.course_count} icon={BookOpen} />
                <Stat label={t("myProjects")} value={data.project_count} icon={Folder} />
                <Stat
                  label={tr("我的已完成任务")}
                  value={data.my_completed_tasks}
                  icon={CheckSquare}
                  accent="var(--gp-success,#008a5c)"
                />
                <Stat
                  label={t("pending")}
                  value={data.pending_action_items ?? "—"}
                  icon={Bell}
                  accent="var(--gp-warning,#d97706)"
                />
              </div>
              <p className="text-xs text-[var(--gp-muted,#646a73)]">
                {tr("包含仍可访问的已结束课程及归档项目；已完成任务按验收后的任务状态统计。")}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div className={cn(feishuCard, "min-w-0 space-y-4")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                      <Folder size={17} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
                      <span>{t("myProjects")}</span>
                    </h2>
                    <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
                      {tr("最近更新的最多 10 个项目")}
                    </p>
                  </div>
                </div>

                {data.projects.length > 0 ? (
                  <div className="gp-stagger-list space-y-3">
                    {data.projects.map((project) => (
                      <div
                        key={project.id}
                        className="gp-card-interactive min-w-0 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] hover:border-[var(--gp-action,#3370ff)]/50"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="min-w-0 truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                            {project.name}
                          </strong>
                          <StatusBadge status={project.lifecycle} />
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-[var(--gp-muted,#646a73)]">
                          <span>{tr("任务进度")}</span>
                          <span className="gp-tabular font-medium text-[var(--gp-ink-soft,#4e5969)]">
                            {project.progress === null ? tr("暂不可计算") : `${project.progress}%`}
                          </span>
                        </div>
                        {project.progress !== null && <ProgressBar value={project.progress} className="mt-1.5" />}
                        <ProjectIntegrationStatus projectId={project.id} userId={userId} />
                        <div className="mt-3 flex items-center justify-end border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3">
                          <Link
                            data-variant="tonal"
                            className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
                            href={`/projects/${encodeURIComponent(project.id)}`}
                          >
                            {t("enterProject")}
                            <ArrowRight size={13} aria-hidden="true" />
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={t("emptyProjects")}
                    description={t("emptyProjectHint")}
                    action={
                      <Link
                        href="/projects/new"
                        data-variant="default"
                        className={buttonVariants({ variant: "default", size: "sm", pill: true })}
                      >
                        <Plus size={15} aria-hidden="true" />
                        {t("createProject")}
                      </Link>
                    }
                  />
                )}
              </div>

              <div className={cn(feishuCard, "min-w-0 space-y-4")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                      <BookOpen size={17} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
                      <span>{t("myCourses")}</span>
                    </h2>
                    <p className="mt-0.5 text-xs text-[var(--gp-muted,#646a73)]">
                      {tr("最近更新的最多 10 门课程")}
                    </p>
                  </div>
                  <Link
                    href="/teacher/courses"
                    data-variant="outline"
                    className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
                  >
                    {tr("管理我的班级与学生组队广场")}
                  </Link>
                </div>

                {data.courses.length > 0 ? (
                  <div className="gp-stagger-list space-y-3">
                    {data.courses.map((course) => (
                      <div
                        key={course.id}
                        className="gp-card-interactive flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] hover:border-[var(--gp-action,#3370ff)]/50"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <strong className="truncate text-sm font-semibold text-[var(--gp-ink,#1f2329)]">
                            {course.name}
                          </strong>
                          <StatusBadge status={course.status} />
                        </div>
                        <Link
                          data-variant="tonal"
                          className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
                          href={course.href}
                        >
                          {tr("查看课程")}
                          <ArrowRight size={13} aria-hidden="true" />
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={t("emptyCourses")}
                    description={t("emptyCourseHint")}
                    action={
                      <Link
                        href="/courses/join"
                        data-variant="outline"
                        className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
                      >
                        <BookOpen size={15} aria-hidden="true" />
                        {t("joinCourse")}
                      </Link>
                    }
                  />
                )}
              </div>
            </div>

            <div className="flex justify-end">
              <Link
                href="/activity"
                data-variant="outline"
                className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
              >
                <Activity size={14} aria-hidden="true" />
                {tr("查看个人动态")}
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </>
        )}

        <MyAccessRequests key={userId} userId={userId} />
      </div>
    );
  }

  const activeProjects = data ? data.projects.filter((project) => project.lifecycle === "active").length : 0;
  const activeCourses = data ? data.courses.filter((course) => course.status === "active").length : 0;
  const taskTotal = data ? Math.max(1, data.my_task_count) : 1;

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <AnnouncementBanner />
      <PageHeader
        title={t("title")}
        actions={
          <JellyActionRow ariaLabel={t("title")}>
            {isTeacher && (
              <Link
                href="/teacher/courses"
                data-variant="default"
                className={cn(buttonVariants({ size: "sm" }), "gp-rainbow-ring")}
              >
                我的班级 / 创建班级
              </Link>
            )}
            <Button
              type="button"
              size="sm"
              variant={isTeacher ? "outline" : "default"}
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={15} />
              {t("createProject")}
            </Button>
            <Link href="/courses/join" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <BookOpen size={15} />
              {t("joinCourse")}
            </Link>
            <button
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              type="button"
              disabled={result.isFetching}
              aria-busy={result.isFetching || undefined}
              onClick={triggerRefresh}
            >
              <RefreshCw size={14} className={cn("gp-refresh-icon", isRefreshing && "is-spinning")} />
              刷新统计
            </button>
          </JellyActionRow>
        }
      />

      {result.isFetching && <p role="status" className="text-xs text-slate-500">正在读取首页…</p>}
      {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}

      {data && (
        <>
          {/* 单行紧凑 KPI 分隔指标条 */}
          <div
            key={refreshSeq}
            data-refresh-dir={refreshDir}
            className="gp-jelly-stat-bar overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs"
          >
            <div className="grid grid-cols-2 divide-y divide-slate-100 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
              <div className="gp-stat !min-h-0 !transform-none !rounded-none !border-0 !bg-transparent !px-4 !py-2.5 !shadow-none flex items-center justify-between gap-2.5 border-r border-slate-100 lg:border-r-0">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                    <Folder size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="gp-stat-label truncate !text-xs font-medium text-slate-600">{t("myProjects")}</div>
                    <div className="gp-stat-sub !mt-0.5 truncate !text-[11px] text-slate-400">
                      {tr("进行中 {0} 个", { 0: activeProjects })}
                    </div>
                  </div>
                </div>
                <div className="gp-stat-value !mt-0 shrink-0 !text-xl !leading-none font-bold text-slate-900">
                  {data.project_count}
                </div>
              </div>

              <div className="gp-stat !min-h-0 !transform-none !rounded-none !border-0 !bg-transparent !px-4 !py-2.5 !shadow-none flex items-center justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                    <BookOpen size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="gp-stat-label truncate !text-xs font-medium text-slate-600">{t("myCourses")}</div>
                    <div className="gp-stat-sub !mt-0.5 truncate !text-[11px] text-slate-400">
                      {tr("进行中 {0} 门", { 0: activeCourses })}
                    </div>
                  </div>
                </div>
                <div className="gp-stat-value !mt-0 shrink-0 !text-xl !leading-none font-bold text-teal-700">
                  {data.course_count}
                </div>
              </div>

              <div className="gp-stat !min-h-0 !transform-none !rounded-none !border-0 !bg-transparent !px-4 !py-2.5 !shadow-none flex items-center justify-between gap-2.5 border-r border-slate-100 lg:border-r-0">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                    <CheckSquare size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="gp-stat-label truncate !text-xs font-medium text-slate-600">我的已完成任务</div>
                    <div className="gp-stat-sub !mt-0.5 truncate !text-[11px] text-slate-400">
                      {data.my_task_count > 0
                        ? tr("共 {0} 项 · 进行中 {1} · 待验收 {2}", {
                            0: data.my_task_count,
                            1: data.task_counts.in_progress,
                            2: data.task_counts.pending_verification,
                          })
                        : "暂未分配任务"}
                    </div>
                  </div>
                </div>
                <div className="gp-stat-value !mt-0 shrink-0 !text-xl !leading-none font-bold text-sky-700">
                  {data.my_completed_tasks}
                </div>
              </div>

              <div className="gp-stat !min-h-0 !transform-none !rounded-none !border-0 !bg-transparent !px-4 !py-2.5 !shadow-none flex items-center justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                    <Bell size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="gp-stat-label truncate !text-xs font-medium text-slate-600">{t("pending")}</div>
                    <div className="gp-stat-sub !mt-0.5 truncate !text-[11px] text-slate-400">
                      {data.unread_notifications !== null && data.unread_notifications !== undefined
                        ? tr("未读通知 {0} 条", { 0: data.unread_notifications })
                        : "未读通知暂不可用"}
                    </div>
                  </div>
                </div>
                <div className="gp-stat-value !mt-0 shrink-0 !text-xl !leading-none font-bold text-amber-700">
                  {data.pending_action_items ?? "—"}
                </div>
              </div>
            </div>
          </div>

          {/* 紧凑非对称双栏主工作台 */}
          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,1fr)]">
            {/* 左栏：项目、课程与任务分布 */}
            <div className="min-w-0 space-y-3.5">
              {/* 我的项目分区 */}
              <section
                aria-label={t("myProjects")}
                className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                      <Folder size={15} />
                    </span>
                    <h2 className="text-sm font-bold tracking-tight text-slate-900">{t("myProjects")}</h2>
                    <span className="gp-pill !min-h-5 !px-2 !py-0">{data.project_count}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-semibold">
                    <Link href="/projects" className="text-slate-500 hover:text-[var(--gp-action)] hover:underline">
                      全部项目
                    </Link>
                    <button
                      type="button"
                      className="text-[var(--gp-action)] hover:underline"
                      onClick={() => setCreateOpen(true)}
                    >
                      + {t("createProject")}
                    </button>
                  </div>
                </div>

                {data.projects.length > 0 ? (
                  <div className="mt-3 space-y-2.5">
                    {data.projects.map((project) => {
                      const baseHref = `/projects/${encodeURIComponent(project.id)}`;
                      return (
                        <div
                          key={project.id}
                          className="rounded-xl border border-slate-200/80 bg-slate-50/45 px-3.5 py-2.5 transition hover:border-sky-200 hover:bg-white"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-semibold text-slate-900">{project.name}</span>
                              <StatusBadge status={project.lifecycle} />
                              <span className="text-xs text-slate-500">
                                {project.progress === null
                                  ? "尚未规划任务"
                                  : tr("任务进度：{0}%", { 0: project.progress })}
                              </span>
                            </div>
                            <Link
                              href={baseHref}
                              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-[var(--gp-action)] px-2.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-[var(--gp-action-hover)]"
                            >
                              {t("enterProject")}
                            </Link>
                          </div>

                          {project.progress !== null && (
                            <div className="mt-2">
                              <ProgressBar value={project.progress} className="!h-1.5" />
                            </div>
                          )}

                          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              <Link
                                href={`${baseHref}/tasks?view=tree`}
                                className="rounded-md border border-slate-200/80 bg-white px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                              >
                                任务
                              </Link>
                              <Link
                                href={`${baseHref}/github`}
                                className="rounded-md border border-slate-200/80 bg-white px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                              >
                                GitHub
                              </Link>
                              <Link
                                href={`${baseHref}/collaboration`}
                                className="rounded-md border border-slate-200/80 bg-white px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                              >
                                协作记录
                              </Link>
                              <Link
                                href={`${baseHref}/evidence`}
                                className="rounded-md border border-slate-200/80 bg-white px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                              >
                                证据中心
                              </Link>
                            </div>
                            <ProjectIntegrationStatus projectId={project.id} userId={userId} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-3.5 py-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-700">{t("emptyProjects")}</div>
                      <p className="mt-0.5 text-xs text-slate-500">{t("emptyProjectHint")}</p>
                    </div>
                    <button type="button" className={buttonVariants({ size: "sm" })} onClick={() => setCreateOpen(true)}>
                      <Plus size={14} />
                      {t("createProject")}
                    </button>
                  </div>
                )}
              </section>

              {/* 我的课程分区 */}
              <section
                aria-label={t("myCourses")}
                className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                      <BookOpen size={15} />
                    </span>
                    <h2 className="text-sm font-bold tracking-tight text-slate-900">{t("myCourses")}</h2>
                    <span className="gp-pill !min-h-5 !px-2 !py-0">{data.course_count}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs font-semibold">
                    {isTeacher && (
                      <Link className="text-teal-700 hover:underline" href="/teacher/courses">
                        班级与组队广场
                      </Link>
                    )}
                    <Link href="/courses" className="text-slate-500 hover:text-[var(--gp-action)] hover:underline">
                      全部课程
                    </Link>
                    <Link href="/courses/join" className="text-[var(--gp-action)] hover:underline">
                      + {t("joinCourse")}
                    </Link>
                  </div>
                </div>

                {data.courses.length > 0 ? (
                  <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
                    {data.courses.map((course) => (
                      <div
                        key={course.id}
                        className="flex items-center justify-between gap-2.5 rounded-xl border border-slate-200/80 bg-slate-50/45 px-3 py-2.5 transition hover:border-teal-200 hover:bg-white"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-900">{course.name}</div>
                          <div className="mt-1">
                            <StatusBadge status={course.status} />
                          </div>
                        </div>
                        <Link
                          className="inline-flex h-7 shrink-0 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-700"
                          href={course.href}
                        >
                          查看课程
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-3.5 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-700">{t("emptyCourses")}</div>
                      <p className="mt-0.5 text-xs text-slate-500">{t("emptyCourseHint")}</p>
                    </div>
                    <Link href="/courses/join" className={buttonVariants({ variant: "outline", size: "sm" })}>
                      <BookOpen size={14} />
                      {t("joinCourse")}
                    </Link>
                  </div>
                )}
              </section>

              {/* 个人任务分布概览 */}
              {data.my_task_count > 0 && (
                <section
                  aria-label="我的任务状态分布"
                  className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700">
                        <CheckSquare size={14} />
                      </span>
                      <h2 className="text-sm font-bold text-slate-900">我的任务状态分布</h2>
                    </div>
                    <span className="text-xs font-medium text-slate-500">{tr("共 {0} 项任务", { 0: data.my_task_count })}</span>
                  </div>
                  <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    {data.task_counts.completed > 0 && (
                      <div
                        className="bg-emerald-500"
                        style={{ width: `${(data.task_counts.completed / taskTotal) * 100}%` }}
                      />
                    )}
                    {data.task_counts.pending_verification > 0 && (
                      <div
                        className="bg-amber-500"
                        style={{ width: `${(data.task_counts.pending_verification / taskTotal) * 100}%` }}
                      />
                    )}
                    {data.task_counts.pending_submission > 0 && (
                      <div
                        className="bg-violet-500"
                        style={{ width: `${(data.task_counts.pending_submission / taskTotal) * 100}%` }}
                      />
                    )}
                    {data.task_counts.in_progress > 0 && (
                      <div
                        className="bg-sky-500"
                        style={{ width: `${(data.task_counts.in_progress / taskTotal) * 100}%` }}
                      />
                    )}
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                      {tr("已完成 {0}", { 0: data.task_counts.completed })}
                    </span>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                      {tr("待验收 {0}", { 0: data.task_counts.pending_verification })}
                    </span>
                    <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700">
                      {tr("待提交 {0}", { 0: data.task_counts.pending_submission })}
                    </span>
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700">
                      {tr("进行中 {0}", { 0: data.task_counts.in_progress })}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                      {tr("未开始 {0}", { 0: data.task_counts.not_started })}
                    </span>
                  </div>
                </section>
              )}
            </div>

            {/* 右栏：待办与通知 + 最近个人动态 */}
            <div className="min-w-0 space-y-3.5">
              <HomeInboxPanel
                userId={userId}
                pendingCount={data.pending_action_items}
                unreadCount={data.unread_notifications}
                onCountsChanged={() => void result.refetch()}
              />

              <section
                aria-label="最近个人动态"
                className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
                      <Activity size={15} />
                    </span>
                    <h2 className="text-sm font-bold tracking-tight text-slate-900">最近个人动态</h2>
                  </div>
                  <Link
                    href="/activity"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--gp-action)] hover:underline"
                  >
                    查看个人动态 →
                  </Link>
                </div>

                <div className="mt-2">
                  {recentActivity.isPending && (
                    <div className="space-y-2 py-1">
                      <div className="h-9 animate-pulse rounded-lg bg-slate-100" />
                      <div className="h-9 animate-pulse rounded-lg bg-slate-100" />
                    </div>
                  )}

                  {recentActivity.isSuccess && recentActivity.data.items.length > 0 && (
                    <div className="divide-y divide-slate-100">
                      {recentActivity.data.items.map((item) => {
                        const prefix = `/projects/${item.project_id}/`;
                        const safeHref =
                          item.href.startsWith(prefix) && !/[\\\u0000-\u001f]/.test(item.href)
                            ? item.href
                            : null;
                        return (
                          <div key={item.id} className="flex items-start justify-between gap-2.5 py-2 first:pt-1 last:pb-0.5">
                            <div className="min-w-0 flex-1">
                              {safeHref ? (
                                <Link href={safeHref} className="block truncate text-xs font-semibold text-slate-800 hover:text-[var(--gp-action)] hover:underline">
                                  {item.title}
                                </Link>
                              ) : (
                                <div className="truncate text-xs font-semibold text-slate-800">{item.title}</div>
                              )}
                              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                                <span>{activityLabels[item.event_type] ?? categoryLabels[item.category]}</span>
                                <span>·</span>
                                <span className="truncate">{item.project_name}</span>
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                              {formatDate(item.occurred_at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {recentActivity.isSuccess && recentActivity.data.items.length === 0 && (
                    <div className="mt-1 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-3.5 py-3 text-center text-xs text-slate-500">
                      暂无最近动态，开始推进任务或同步 GitHub 后将在此展示。
                    </div>
                  )}

                  {recentActivity.isError && (
                    <div className="mt-1 flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
                      <span>动态摘要暂不可用</span>
                      <Link href="/activity" className="font-semibold text-[var(--gp-action)] hover:underline">
                        前往个人动态 <ArrowRight size={12} className="inline" />
                      </Link>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </>
      )}

      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export function ActivityApiPage() {
  const { userId } = useWorkspace();
  const scope = useGpThemeScope();
  const { query, updateQuery } = useUrlQuery();
  const t = useTranslations("core.activity");
  const githubText = useTranslations("account.githubIdentity");
  const rawCategory = query.get("category") ?? "all";
  const category = Object.hasOwn(categoryLabels, rawCategory) ? rawCategory as keyof typeof categoryLabels : "all";
  const rawPage = Number(query.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const filters: DailyActivityQuery = {
    category,
    page,
    page_size: 10,
    project_id: query.get("project_id") || undefined,
    date_from: query.get("date_from") || undefined,
    date_to: query.get("date_to") || undefined,
  };
  const result = useQuery({ queryKey: ["c-personal-activity", userId, filters], queryFn: () => client.personalActivity(filters), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;

  if (scope === "teacher") {
    return (
      <div className="min-w-0 max-w-full space-y-5">
        <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-4")}>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--gp-ink,#1f2329)]">
              <Activity size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
              <span className="truncate">{t("title")}</span>
            </h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              {tr("查看自己的任务、文件版本、证据、讨论，以及项目中已同步并归属本人的 GitHub 活动。")}
            </p>
            <p className="mt-1 text-xs text-[var(--gp-subtle,#8f959e)]">
              {tr("日期按 UTC 自然日筛选。个人飞书记录仍待发送者身份匹配。")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data && (
              <Link
                href="/account/security#github-identity"
                data-variant="outline"
                className={buttonVariants({ variant: "outline", size: "sm", pill: true })}
              >
                {githubText("manage")}
              </Link>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              pill
              disabled={result.isFetching}
              onClick={() => void result.refetch()}
            >
              <RefreshCw size={14} className={cn(result.isFetching && "animate-spin")} aria-hidden="true" />
              {tr("刷新动态")}
            </Button>
          </div>
        </div>

        <div className={cn(feishuCard, "space-y-4")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TeacherSegmentedTabs
              variant="segmented"
              size="sm"
              ariaLabel={tr("动态分类")}
              activeId={category}
              onChange={(value) => updateQuery({ category: value === "all" ? null : value, page: null })}
              items={Object.entries(categoryLabels).map(([value, label]) => ({
                id: value as keyof typeof categoryLabels,
                label: tr(label),
              }))}
            />
          </div>

          <form
            key={query.toString()}
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const input = new FormData(event.currentTarget);
              updateQuery({
                date_from: String(input.get("date_from") ?? "") || null,
                date_to: String(input.get("date_to") ?? "") || null,
                page: null,
              });
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
              {tr("开始日期")}
              <input className={feishuInput} type="date" name="date_from" defaultValue={query.get("date_from") ?? ""} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--gp-ink-soft,#4e5969)]">
              {tr("结束日期")}
              <input className={feishuInput} type="date" name="date_to" defaultValue={query.get("date_to") ?? ""} />
            </label>
            <Button type="submit" variant="default" size="sm" pill>
              {tr("查询")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              pill
              onClick={() => updateQuery({ category: null, project_id: null, date_from: null, date_to: null, page: null })}
            >
              {tr("重置")}
            </Button>
          </form>

          {filters.project_id && (
            <TeacherFeedbackPill
              tone="info"
              message={tr("当前仅显示指定项目；重置可查看全部可访问项目。")}
            />
          )}
        </div>

        {result.isFetching && (
          <div role="status" className={cn(feishuCard, "animate-pulse space-y-3")}>
            <span className="sr-only">{tr("正在读取个人动态…")}</span>
            {[0, 1, 2].map((idx) => (
              <div key={idx} className="h-16 rounded-[10px] bg-[var(--gp-surface-subtle,#f8f9fa)]" />
            ))}
          </div>
        )}

        {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}

        {data && (
          <div className={cn(feishuCard, "space-y-4")}>
            {data.items.length > 0 ? (
              <div className="space-y-3">
                {data.items.map((item) => {
                  const prefix = `/projects/${item.project_id}/`;
                  const href = item.href.startsWith(prefix) && !/[\\\u0000-\u001f]/.test(item.href) ? item.href : null;
                  return (
                    <article
                      key={item.id}
                      className="gp-card-interactive rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-4 shadow-[var(--gp-shadow-card)] hover:border-[var(--gp-action,#3370ff)]/50"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-full bg-[var(--gp-action-soft,#e8f0fe)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--gp-action-on-soft,#1d4ed8)]">
                          {tr(activityLabels[item.event_type] ?? categoryLabels[item.category])}
                        </span>
                        <span className="font-medium text-[var(--gp-muted,#646a73)]">{item.project_name}</span>
                        <time
                          className="gp-tabular ml-auto text-[var(--gp-subtle,#8f959e)]"
                          dateTime={item.occurred_at}
                        >
                          {formatDate(item.occurred_at, {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <div className="mt-2">
                        {href ? (
                          <Link
                            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--gp-ink,#1f2329)] transition-colors hover:text-[var(--gp-action,#3370ff)]"
                            href={href}
                          >
                            <span>{item.title}</span>
                            <ArrowRight size={13} aria-hidden="true" />
                          </Link>
                        ) : (
                          <span className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">{item.title}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState title={tr("没有符合条件的个人动态")} />
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4 text-xs text-[var(--gp-muted,#646a73)]">
              <span className="gp-tabular">{tr("共 {0} 条 · 第 {1} 页", { 0: data.total, 1: data.page })}</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  pill
                  disabled={page <= 1}
                  onClick={() => updateQuery({ page: String(page - 1) })}
                >
                  {tr("上一页")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  pill
                  disabled={data.page * data.page_size >= data.total}
                  onClick={() => updateQuery({ page: String(page + 1) })}
                >
                  {tr("下一页")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader
        title={t("title")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data && (
              <Link
                className={buttonClass}
                href="/account/security#github-identity"
              >
                {githubText("manage")}
              </Link>
            )}
            <button
              className={buttonClass}
              type="button"
              disabled={result.isFetching}
              onClick={() => void result.refetch()}
            >
              <RefreshCw size={13} className={result.isFetching ? "animate-spin" : ""} />
              刷新动态
            </button>
          </div>
        }
      />

      {/* 单行紧凑筛选与日期工具条 */}
      <div className="rounded-2xl border border-slate-200/85 bg-white px-3.5 py-2.5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl bg-slate-100/90 p-1" aria-label="动态分类">
            {Object.entries(categoryLabels).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => updateQuery({ category: value === "all" ? null : value, page: null })}
                className={`inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium transition ${
                  category === value
                    ? "bg-white font-semibold text-[var(--gp-action)] shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <form
            key={query.toString()}
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const input = new FormData(event.currentTarget);
              updateQuery({
                date_from: String(input.get("date_from") ?? "") || null,
                date_to: String(input.get("date_to") ?? "") || null,
                page: null,
              });
            }}
          >
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <span>开始日期</span>
              <input className={inputClass} type="date" name="date_from" defaultValue={query.get("date_from") ?? ""} />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <span>结束日期</span>
              <input className={inputClass} type="date" name="date_to" defaultValue={query.get("date_to") ?? ""} />
            </label>
            <button className={buttonClass} type="submit">查询</button>
            <button
              className={buttonClass}
              type="button"
              onClick={() => updateQuery({ category: null, project_id: null, date_from: null, date_to: null, page: null })}
            >
              重置
            </button>
          </form>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span>日期按 UTC 自然日筛选。个人飞书记录仍待发送者身份匹配。</span>
          {filters.project_id && (
            <span className="font-medium text-sky-700">当前仅显示指定项目；重置可查看全部可访问项目。</span>
          )}
        </div>
      </div>

      {result.isFetching && <p role="status" className="text-xs text-slate-500">正在读取个人动态…</p>}
      {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}

      {data && (
        <section
          aria-label="动态时间线"
          className="overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-900">动态时间线</h2>
              <span className="text-xs text-slate-500">按时间查看自己的开发、证据和协作记录</span>
            </div>
            <span className="text-xs text-slate-500 tabular-nums">共 {data.total} 条 · 第 {data.page} 页</span>
          </div>

          {data.items.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {data.items.map((item) => {
                const prefix = `/projects/${item.project_id}/`;
                const href = item.href.startsWith(prefix) && !/[\\\u0000-\u001f]/.test(item.href) ? item.href : null;
                const dotColor = categoryDotClass[item.category] ?? "bg-slate-400";
                return (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-slate-50/70"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {href ? (
                            <Link className="truncate text-sm font-semibold text-slate-900 hover:text-[var(--gp-action)] hover:underline" href={href}>
                              {item.title}
                            </Link>
                          ) : (
                            <span className="truncate text-sm font-semibold text-slate-900">{item.title}</span>
                          )}
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {categoryLabels[item.category]}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {`${activityLabels[item.event_type] ?? categoryLabels[item.category]} · ${item.project_name}`}
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">
                      {formatDate(item.occurred_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4">
              <EmptyState title="没有符合条件的个人动态" />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-xs text-slate-500">
            <span>共 {data.total} 条 · 第 {data.page} 页</span>
            <div className="flex items-center gap-2">
              <button className={buttonClass} type="button" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>
                上一页
              </button>
              <button className={buttonClass} type="button" disabled={data.page * data.page_size >= data.total} onClick={() => updateQuery({ page: String(page + 1) })}>
                下一页
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
