"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Activity, ArrowRight, BookOpen, CheckSquare, Folder, Plus, RefreshCw } from "lucide-react";
import { EmptyState, ListRow, PageHeader, ProgressBar, Section, Stat, StatusBadge } from "@/components/common";
import { buttonVariants } from "@/components/ui/button";
import { projectRequest } from "@/features/github-binding/integration-request";
import { AnnouncementBanner } from "@/features/b/AnnouncementBanner";
import { CreateProjectModal } from "@/features/b/CreateProjectModal";
import { CApiError, createCClient, type DailyActivityQuery } from "@/lib/api/c-client";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { useUrlQuery } from "./use-url-query";
import { MyAccessRequests } from "./GovernanceApiPages";
import { HomeInboxPanel } from "./HomeInboxPanel";

const client = createCClient();
const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-2xs transition-all hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";
const categoryLabels = { all: "全部", development: "开发", evidence: "证据", discussion: "讨论" } as const;
const activityLabels = {
  task_progress: "更新任务进度或状态", task_note_saved: "保存实现说明", file_version_uploaded: "登记项目文件版本",
  github_commit: "GitHub 提交", github_pull_request: "GitHub 拉取请求", github_ci_run: "GitHub CI 运行",
  evidence_submitted: "提交候选证据", evidence_adopted: "采纳证据", evidence_withdrawn: "撤回证据",
  evidence_source_changed: "证据来源变化", discussion_created: "发布讨论", discussion_replied: "回复讨论",
};

function QueryFailure({ error, retry }: { error: Error; retry: () => void }) {
  const message = error instanceof CApiError && error.status === 401
    ? "当前登录身份暂时无法读取此服务，请重新登录或稍后重试。"
    : error instanceof CApiError && error.status === 403
      ? "你目前没有权限读取这些数据。"
      : error instanceof CApiError ? error.message : "数据暂不可用，请重试。";
  return <div role="alert" className="gp-panel p-4"><p>{message}</p><button className={`${buttonClass} mt-3`} type="button" onClick={retry}>重试</button></div>;
}

function ProjectIntegrationStatus({ projectId, userId }: { projectId: string; userId: string }) {
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
  const githubConnected = repos.isSuccess && repos.data.length > 0;
  const feishuConnected = chats.isSuccess && chats.data.length > 0;
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      <Link
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
          githubConnected
            ? "border-emerald-200 bg-emerald-50/80 text-emerald-800 hover:bg-emerald-100/80"
            : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700"
        }`}
        href={`/projects/${encodeURIComponent(projectId)}/settings#github-integration`}
      >
        {githubLabel}
      </Link>
      <Link
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
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
  const isTeacher = role === "teacher" || role === "ta";
  const t = useTranslations("core.home");
  const [createOpen, setCreateOpen] = useState(false);
  const result = useQuery({ queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  const recentActivity = useQuery({
    queryKey: ["c-home-recent-activity", userId],
    queryFn: () => client.personalActivity({ category: "all", page: 1, page_size: 4 }),
    enabled: Boolean(data),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const activeProjects = data ? data.projects.filter((project) => project.lifecycle === "active").length : 0;
  const activeCourses = data ? data.courses.filter((course) => course.status === "active").length : 0;
  const taskTotal = data ? Math.max(1, data.my_task_count) : 1;

  return (
    <div className="space-y-5">
      <AnnouncementBanner />
      <PageHeader
        title={t("title")}
        description="聚焦当前课程、项目进度与待办通知，快速进入协作。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isTeacher && <Link href="/teacher/courses" className={buttonVariants()}>我的班级 / 创建班级</Link>}
            <button
              type="button"
              className={buttonVariants(isTeacher ? { variant: "outline" } : undefined)}
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={16} />
              {t("createProject")}
            </button>
            <Link href="/courses/join" className={buttonVariants({ variant: "outline" })}>
              <BookOpen size={16} />
              {t("joinCourse")}
            </Link>
            <button
              className={buttonVariants({ variant: "ghost" })}
              type="button"
              disabled={result.isFetching}
              onClick={() => void result.refetch()}
            >
              <RefreshCw size={15} className={result.isFetching ? "animate-spin" : ""} />
              刷新统计
            </button>
          </div>
        }
      />

      {result.isFetching && <p role="status" className="text-sm text-slate-500">正在读取首页…</p>}
      {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}

      {data && (
        <>
          {/* 紧凑核心指标概览条 */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={t("myProjects")}
              value={data.project_count}
              sub={tr("进行中 {0} 个", { 0: activeProjects })}
              icon={Folder}
              className="!min-h-0 !px-4 !py-3.5"
            />
            <Stat
              label={t("myCourses")}
              value={data.course_count}
              sub={tr("进行中 {0} 门", { 0: activeCourses })}
              icon={BookOpen}
              accent="#0f766e"
              className="!min-h-0 !px-4 !py-3.5"
            />
            <Stat
              label="我的已完成任务"
              value={data.my_completed_tasks}
              sub={
                data.my_task_count > 0
                  ? tr("共 {0} 项 · 进行中 {1} · 待验收 {2}", {
                      0: data.my_task_count,
                      1: data.task_counts.in_progress,
                      2: data.task_counts.pending_verification,
                    })
                  : "暂未分配任务"
              }
              icon={CheckSquare}
              accent="#0369a1"
              className="!min-h-0 !px-4 !py-3.5"
            />
            <Stat
              label={t("pending")}
              value={data.pending_action_items ?? "—"}
              sub={
                data.unread_notifications !== null && data.unread_notifications !== undefined
                  ? tr("未读通知 {0} 条", { 0: data.unread_notifications })
                  : "未读通知暂不可用"
              }
              accent="#b45309"
              className="!min-h-0 !px-4 !py-3.5"
            />
          </div>

          {/* 非对称双栏主工作台 */}
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,1fr)]">
            {/* 左栏：项目与课程独立分区 */}
            <div className="min-w-0 space-y-5">
              {/* 我的项目分区 */}
              <section
                aria-label={t("myProjects")}
                className="rounded-2xl border border-slate-200/85 bg-white p-5 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                      <Folder size={18} />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold tracking-tight text-slate-900">{t("myProjects")}</h2>
                        <span className="gp-pill">{data.project_count}</span>
                      </div>
                      <p className="text-xs text-slate-500">项目任务推进、代码与飞书协作同步</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-xs font-semibold text-[var(--gp-action)] hover:underline"
                    onClick={() => setCreateOpen(true)}
                  >
                    + {t("createProject")}
                  </button>
                </div>

                {data.projects.length > 0 ? (
                  <div className="mt-4 space-y-3">
                    {data.projects.map((project) => {
                      const baseHref = `/projects/${encodeURIComponent(project.id)}`;
                      return (
                        <div
                          key={project.id}
                          className="rounded-xl border border-slate-200/80 bg-slate-50/45 p-4 transition hover:border-sky-200 hover:bg-white"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-base font-semibold text-slate-900">{project.name}</span>
                                <StatusBadge status={project.lifecycle} />
                              </div>
                              <p className="mt-1 text-xs text-slate-500">
                                {project.progress === null
                                  ? "尚未规划任务 · 进入项目开始拆解任务"
                                  : tr("任务进度：{0}%", { 0: project.progress })}
                              </p>
                            </div>
                            <Link
                              href={baseHref}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--gp-action)] px-3 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-[var(--gp-action-hover)]"
                            >
                              {t("enterProject")}
                            </Link>
                          </div>

                          {project.progress !== null && (
                            <div className="mt-2.5">
                              <ProgressBar value={project.progress} />
                            </div>
                          )}

                          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                            <Link
                              href={`${baseHref}/tasks?view=tree`}
                              className="rounded-md border border-slate-200/80 bg-white px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                            >
                              任务
                            </Link>
                            <Link
                              href={`${baseHref}/github`}
                              className="rounded-md border border-slate-200/80 bg-white px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                            >
                              GitHub
                            </Link>
                            <Link
                              href={`${baseHref}/collaboration`}
                              className="rounded-md border border-slate-200/80 bg-white px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                            >
                              协作记录
                            </Link>
                            <Link
                              href={`${baseHref}/evidence`}
                              className="rounded-md border border-slate-200/80 bg-white px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:text-sky-700"
                            >
                              证据中心
                            </Link>
                          </div>

                          <ProjectIntegrationStatus projectId={project.id} userId={userId} />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-4">
                    <div>
                      <div className="text-sm font-semibold text-slate-700">{t("emptyProjects")}</div>
                      <p className="mt-0.5 text-xs text-slate-500">{t("emptyProjectHint")}</p>
                    </div>
                    <button type="button" className={buttonVariants()} onClick={() => setCreateOpen(true)}>
                      <Plus size={15} />
                      {t("createProject")}
                    </button>
                  </div>
                )}
              </section>

              {/* 我的课程分区（与项目完全独立） */}
              <section
                aria-label={t("myCourses")}
                className="rounded-2xl border border-slate-200/85 bg-white p-5 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
                      <BookOpen size={18} />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold tracking-tight text-slate-900">{t("myCourses")}</h2>
                        <span className="gp-pill">{data.course_count}</span>
                      </div>
                      <p className="text-xs text-slate-500">已加入课程、规则基线与班级组队入口</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs font-semibold">
                    <Link href="/courses" className="text-slate-600 hover:text-[var(--gp-action)] hover:underline">
                      全部课程
                    </Link>
                    <Link href="/courses/join" className="text-[var(--gp-action)] hover:underline">
                      + {t("joinCourse")}
                    </Link>
                  </div>
                </div>

                {isTeacher && (
                  <div className="mt-3">
                    <Link className="gp-link inline-block text-xs font-medium" href="/teacher/courses">
                      管理我的班级与学生组队广场 →
                    </Link>
                  </div>
                )}

                {data.courses.length > 0 ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {data.courses.map((course) => (
                      <div
                        key={course.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/45 p-3.5 transition hover:border-teal-200 hover:bg-white"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="truncate text-sm font-semibold text-slate-900">{course.name}</div>
                          <StatusBadge status={course.status} />
                        </div>
                        <Link
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-700"
                          href={course.href}
                        >
                          查看课程
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-3.5">
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

              {/* 个人任务分布概览（仅在有分配任务时展示） */}
              {data.my_task_count > 0 && (
                <section
                  aria-label="我的任务状态分布"
                  className="rounded-2xl border border-slate-200/85 bg-white p-5 shadow-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-bold text-slate-900">我的任务状态分布</h2>
                    <span className="text-xs text-slate-500">{tr("共 {0} 项任务", { 0: data.my_task_count })}</span>
                  </div>
                  <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
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
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 font-medium text-emerald-700">
                      {tr("已完成 {0}", { 0: data.task_counts.completed })}
                    </span>
                    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800">
                      {tr("待验收 {0}", { 0: data.task_counts.pending_verification })}
                    </span>
                    <span className="rounded-full bg-violet-50 px-2.5 py-0.5 font-medium text-violet-700">
                      {tr("待提交 {0}", { 0: data.task_counts.pending_submission })}
                    </span>
                    <span className="rounded-full bg-sky-50 px-2.5 py-0.5 font-medium text-sky-700">
                      {tr("进行中 {0}", { 0: data.task_counts.in_progress })}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-medium text-slate-600">
                      {tr("未开始 {0}", { 0: data.task_counts.not_started })}
                    </span>
                  </div>
                </section>
              )}
            </div>

            {/* 右栏：待办与通知合并细分中心 + 最近个人动态 */}
            <div className="min-w-0 space-y-5">
              <HomeInboxPanel
                userId={userId}
                pendingCount={data.pending_action_items}
                unreadCount={data.unread_notifications}
                onCountsChanged={() => void result.refetch()}
              />

              <section
                aria-label="最近个人动态"
                className="rounded-2xl border border-slate-200/85 bg-white p-5 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                      <Activity size={18} />
                    </span>
                    <div>
                      <h2 className="text-base font-bold tracking-tight text-slate-900">最近个人动态</h2>
                      <p className="text-xs text-slate-500">提交、证据与讨论的时间线摘要</p>
                    </div>
                  </div>
                  <Link
                    href="/activity"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--gp-action)] hover:underline"
                  >
                    查看个人动态 →
                  </Link>
                </div>

                <div className="mt-4 space-y-2.5">
                  {recentActivity.isPending && (
                    <div className="space-y-2">
                      <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
                      <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
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
                          <div key={item.id} className="py-2.5 first:pt-0 last:pb-0">
                            {safeHref ? (
                              <Link href={safeHref} className="block truncate text-sm font-medium text-slate-800 hover:text-[var(--gp-action)] hover:underline">
                                {item.title}
                              </Link>
                            ) : (
                              <div className="truncate text-sm font-medium text-slate-800">{item.title}</div>
                            )}
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                              <span>{activityLabels[item.event_type] ?? categoryLabels[item.category]}</span>
                              <span>·</span>
                              <span>{item.project_name}</span>
                              <span>·</span>
                              <span>{formatDate(item.occurred_at, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {recentActivity.isSuccess && recentActivity.data.items.length === 0 && (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-4 text-center text-xs text-slate-500">
                      暂无最近动态，开始推进任务或同步 GitHub 后将在此展示。
                    </div>
                  )}

                  {recentActivity.isError && (
                    <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3.5 py-3 text-xs text-slate-500">
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

      <MyAccessRequests key={userId} />
      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export function ActivityApiPage() {
  const { userId } = useWorkspace();
  const { query, updateQuery } = useUrlQuery();
  const t = useTranslations("core.activity");
  const githubText = useTranslations("account.githubIdentity");
  const rawCategory = query.get("category") ?? "all";
  const category = Object.hasOwn(categoryLabels, rawCategory) ? rawCategory as keyof typeof categoryLabels : "all";
  const rawPage = Number(query.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const filters: DailyActivityQuery = { category, page, page_size: 10, project_id: query.get("project_id") || undefined,
    date_from: query.get("date_from") || undefined, date_to: query.get("date_to") || undefined };
  const result = useQuery({ queryKey: ["c-personal-activity", userId, filters], queryFn: () => client.personalActivity(filters), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <PageHeader title={t("title")} description="查看自己的任务、文件版本、证据、讨论，以及项目中已同步并归属本人的 GitHub 活动。" />
    <p className="mb-4 text-sm text-slate-600">日期按 UTC 自然日筛选。个人飞书记录仍待发送者身份匹配。</p>
    {data && <Link className="gp-link mb-4 inline-block text-sm" href="/account/security#github-identity">{githubText("manage")}</Link>}
    <div className="gp-tabs mb-4" aria-label="动态分类">{Object.entries(categoryLabels).map(([value, label]) => <button className={`gp-tab ${category === value ? "active" : ""}`} type="button" key={value} aria-pressed={category === value} onClick={() => updateQuery({ category: value === "all" ? null : value, page: null })}>{label}</button>)}</div>
    <form key={query.toString()} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault(); const input = new FormData(event.currentTarget);
      updateQuery({ date_from: String(input.get("date_from") ?? "") || null, date_to: String(input.get("date_to") ?? "") || null, page: null });
    }}>
      <label className="flex flex-col gap-1 text-sm">开始日期<input className={inputClass} type="date" name="date_from" defaultValue={query.get("date_from") ?? ""} /></label>
      <label className="flex flex-col gap-1 text-sm">结束日期<input className={inputClass} type="date" name="date_to" defaultValue={query.get("date_to") ?? ""} /></label>
      <button className={buttonClass} type="submit">查询</button>
      <button className={buttonClass} type="button" onClick={() => updateQuery({ category: null, project_id: null, date_from: null, date_to: null, page: null })}>重置</button>
      <button className={buttonClass} type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>刷新动态</button>
    </form>
    {filters.project_id && <p className="mb-3 text-sm">当前仅显示指定项目；重置可查看全部可访问项目。</p>}
    {result.isFetching && <p role="status">正在读取个人动态…</p>}
    {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}
    {data && <Section title="动态时间线" description="按时间查看自己的开发、证据和协作记录。">
      <div className="gp-list">{data.items.map((item) => {
        const prefix = `/projects/${item.project_id}/`;
        const href = item.href.startsWith(prefix) && !/[\\\u0000-\u001f]/.test(item.href) ? item.href : null;
        return <ListRow key={item.id} title={href ? <Link className="gp-link" href={href}>{item.title}</Link> : item.title} meta={`${activityLabels[item.event_type] ?? categoryLabels[item.category]} · ${item.project_name} · ${formatDate(item.occurred_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`} />;
      })}</div>
      {!data.items.length && <EmptyState title="没有符合条件的个人动态" />}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span>共 {data.total} 条 · 第 {data.page} 页</span><div className="flex gap-2">
        <button className={buttonClass} type="button" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>上一页</button>
        <button className={buttonClass} type="button" disabled={data.page * data.page_size >= data.total} onClick={() => updateQuery({ page: String(page + 1) })}>下一页</button>
      </div></div>
    </Section>}
  </>;
}
