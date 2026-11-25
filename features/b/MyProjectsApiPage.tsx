"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Folder, FolderKanban, Plus, RefreshCw, Users } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, ProgressBar, StatusBadge } from "@/components/common";
import { AnnouncementBanner } from "@/features/b/AnnouncementBanner";
import { CreateProjectModal } from "@/features/b/CreateProjectModal";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, queryPolicy, secondary } from "@/features/b/ui";
import { projectRequest } from "@/features/github-binding/integration-request";
import { bCoursesApi } from "@/lib/api/b-courses";
import { bProjectsApi, type BProjectOverview } from "@/lib/api/b-projects";
import { createCClient } from "@/lib/api/c-client";
import { useUiText } from "@/lib/i18n/use-ui-text";
import { useWorkspace } from "@/lib/workspace";

type ProjectFilterTab = "all" | "independent" | "course";

type ProjectSeed = {
  id: string;
  name: string;
  lifecycle: "active" | "finalized" | "archived";
  progress: number | null;
  progress_status: "available" | "no_weighted_tasks" | "invalid_task_tree";
  courseId: string | null;
  courseName: string | null;
};

type ProjectItem = ProjectSeed & {
  description: string | null;
  memberCount: number | null;
  taskCount: number | null;
  completedCount: number | null;
  isCourseProject: boolean;
  overviewLoaded: boolean;
};

const dailyClient = createCClient();

function ProjectIntegrationBadges({ projectId, userId }: { projectId: string; userId: string }) {
  const tr = useUiText();
  const repos = useQuery({
    queryKey: ["project-integration-repos", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${encodeURIComponent(projectId)}/github/repos`, { signal }),
    retry: false,
  });
  const chats = useQuery({
    queryKey: ["project-integration-chats", userId, projectId],
    queryFn: ({ signal }) => projectRequest<unknown[]>(`/api/v1/a/projects/${encodeURIComponent(projectId)}/feishu/chats`, { signal }),
    retry: false,
  });

  const githubConnected = repos.isSuccess && repos.data.length > 0;
  const feishuConnected = chats.isSuccess && chats.data.length > 0;
  const githubLabel = repos.isPending
    ? tr("GitHub 状态读取中")
    : repos.isError
      ? tr("GitHub 状态暂不可用")
      : repos.data.length > 0
        ? tr("GitHub 已连接 · {0} 个仓库", { 0: repos.data.length })
        : tr("GitHub 未连接");
  const feishuLabel = chats.isPending
    ? tr("飞书状态读取中")
    : chats.isError
      ? tr("飞书状态暂不可用")
      : chats.data.length > 0
        ? tr("飞书已接入 · {0} 个群", { 0: chats.data.length })
        : tr("飞书未接入");

  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/settings#github-integration`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
          githubConnected
            ? "border-emerald-200 bg-emerald-50/80 text-emerald-800 hover:bg-emerald-100/80"
            : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700"
        }`}
      >
        {githubLabel}
      </Link>
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/settings#feishu-integration`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
          feishuConnected
            ? "border-sky-200 bg-sky-50/80 text-sky-800 hover:bg-sky-100/80"
            : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700"
        }`}
      >
        {feishuLabel}
      </Link>
    </div>
  );
}

function ProjectCard({ item, userId }: { item: ProjectItem; userId: string }) {
  const tr = useUiText();
  const baseHref = `/projects/${encodeURIComponent(item.id)}`;

  return (
    <div className="rounded-xl border border-slate-200/85 bg-white p-4 shadow-2xs transition hover:border-sky-200/90 hover:shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={baseHref}
              className="truncate text-base font-semibold text-slate-900 hover:text-[var(--gp-action)] hover:underline"
            >
              {item.name}
            </Link>
            <StatusBadge status={item.lifecycle} />
            {item.isCourseProject ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700">
                <BookOpen size={12} />
                {item.courseName ? tr("课程：{0}", { 0: item.courseName }) : tr("课程项目")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700">
                <Folder size={12} />
                {tr("独立项目")}
              </span>
            )}
          </div>

          <p className="line-clamp-2 text-xs text-slate-500">
            {item.description?.trim() ? item.description : tr("暂无项目简介，可在项目总览或设置中完善。")}
          </p>
        </div>

        <Link href={baseHref} className={`${button} shrink-0 !min-h-8 !px-3 !py-1.5 !text-xs`}>
          {tr("进入项目")}
          <ArrowRight size={14} />
        </Link>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-3">
            {item.memberCount !== null && (
              <span className="inline-flex items-center gap-1">
                <Users size={13} className="text-slate-400" />
                {tr("{0} 位成员", { 0: item.memberCount })}
              </span>
            )}
            {item.taskCount !== null && item.taskCount > 0 && (
              <span>
                {tr("已完成 {0}/{1} 项任务", { 0: item.completedCount ?? 0, 1: item.taskCount })}
              </span>
            )}
          </div>
          <span className="font-medium text-slate-700">
            {item.progress !== null && item.progress_status === "available"
              ? tr("项目进度 {0}%", { 0: item.progress })
              : tr("尚未规划任务")}
          </span>
        </div>
        {item.progress !== null && item.progress_status === "available" && (
          <ProgressBar value={item.progress} />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5 border-t border-slate-100 pt-3">
        <ProjectIntegrationBadges projectId={item.id} userId={userId} />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Link
            href={`${baseHref}/tasks?view=tree`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("任务")}
          </Link>
          <Link
            href={`${baseHref}/github`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            GitHub
          </Link>
          <Link
            href={`${baseHref}/collaboration`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("协作记录")}
          </Link>
          <Link
            href={`${baseHref}/files`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("文件资料")}
          </Link>
          <Link
            href={`${baseHref}/settings`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("项目设置")}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Student My Projects directory: clearly separates independent projects and course projects. */
export function MyProjectsApiPage() {
  const tr = useUiText();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [tab, setTab] = useState<ProjectFilterTab>("all");
  const [createOpen, setCreateOpen] = useState(false);

  const homeSummary = useQuery({
    queryKey: ["c-home-summary", userId],
    queryFn: () => dailyClient.homeSummary(),
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const myCourses = useQuery({
    queryKey: ["b-my-courses", userId, "projects-index"],
    queryFn: () => bCoursesApi.myCourses({ tab: "all", q: "", page: 1, page_size: 50 }),
    ...queryPolicy,
  });

  const seeds = useMemo<ProjectSeed[]>(() => {
    const courseByProjectId = new Map<string, { id: string; name: string }>();
    for (const course of myCourses.data?.items ?? []) {
      if (course.project) {
        courseByProjectId.set(course.project.id, { id: course.id, name: course.name });
      }
    }
    const map = new Map<string, ProjectSeed>();
    for (const project of homeSummary.data?.projects ?? []) {
      const course = courseByProjectId.get(project.id);
      map.set(project.id, {
        id: project.id,
        name: project.name,
        lifecycle: project.lifecycle,
        progress: project.progress,
        progress_status: project.progress_status,
        courseId: course?.id ?? null,
        courseName: course?.name ?? null,
      });
    }
    for (const course of myCourses.data?.items ?? []) {
      if (!course.project || map.has(course.project.id)) continue;
      map.set(course.project.id, {
        id: course.project.id,
        name: course.project.name,
        lifecycle: course.status === "ended" ? "archived" : "active",
        progress: null,
        progress_status: "no_weighted_tasks",
        courseId: course.id,
        courseName: course.name,
      });
    }
    return [...map.values()];
  }, [homeSummary.data?.projects, myCourses.data?.items]);

  const overviewQueries = useQueries({
    queries: seeds.map((seed) => ({
      queryKey: ["b-project-overview", userId, seed.id],
      queryFn: () => bProjectsApi.overview(seed.id),
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });

  const projects = useMemo<ProjectItem[]>(() => {
    return seeds.map((seed, index) => {
      const overview: BProjectOverview | undefined = overviewQueries[index]?.data;
      const resolvedCourseId = overview ? overview.course_id : seed.courseId;
      return {
        ...seed,
        name: overview?.name ?? seed.name,
        lifecycle: overview?.lifecycle ?? seed.lifecycle,
        progress: overview
          ? (overview.stats.progress_status === "available" ? overview.stats.progress : null)
          : seed.progress,
        progress_status: overview?.stats.progress_status ?? seed.progress_status,
        courseId: resolvedCourseId,
        description: overview?.description ?? null,
        memberCount: overview?.stats.member_count ?? null,
        taskCount: overview?.stats.task_count ?? null,
        completedCount: overview?.stats.completed_count ?? null,
        isCourseProject: resolvedCourseId !== null,
        overviewLoaded: Boolean(overview),
      };
    });
  }, [overviewQueries, seeds]);

  const independentProjects = useMemo(
    () => projects.filter((item) => !item.isCourseProject),
    [projects],
  );
  const courseProjects = useMemo(
    () => projects.filter((item) => item.isCourseProject),
    [projects],
  );

  const isLoading = homeSummary.isPending && myCourses.isPending;
  const isError = homeSummary.isError && !homeSummary.data && !myCourses.data;
  const isFetching = homeSummary.isFetching || myCourses.isFetching;

  const refreshAll = () => {
    void homeSummary.refetch();
    void myCourses.refetch();
    void cache.invalidateQueries({ queryKey: ["b-project-overview", userId] });
  };

  return (
    <div className="space-y-5">
      <AnnouncementBanner />
      <PageHeader
        title={tr("我的项目")}
        description={tr("集中管理你的独立项目与课程项目，快速查看进度、成员与 GitHub / 飞书集成状态。")}
        icon={FolderKanban}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={button}
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={15} />
              {tr("创建项目")}
            </button>
            <Link href="/courses?intent=create-project" className={secondary}>
              <BookOpen size={15} />
              {tr("我的课程")}
            </Link>
            <button
              type="button"
              className={secondary}
              disabled={isFetching}
              onClick={refreshAll}
            >
              <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
              {tr("刷新")}
            </button>
          </div>
        }
      />

      <div role="tablist" aria-label={tr("项目分类筛选")} className="flex flex-wrap gap-6 border-b border-slate-200">
        {(
          [
            ["all", tr("全部"), projects.length],
            ["independent", tr("独立项目"), independentProjects.length],
            ["course", tr("课程项目"), courseProjects.length],
          ] as const
        ).map(([key, text, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
              tab === key
                ? "border-blue-600 text-[var(--gp-action)]"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {text}
            {!isLoading && <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{count}</span>}
          </button>
        ))}
      </div>

      {isLoading && <div role="status" className="gp-empty">{tr("正在加载项目列表…")}</div>}

      {isError && (
        <div role="alert">
          <Feedback tone="error">{errorText(homeSummary.error)}</Feedback>
          <button type="button" className={`${secondary} mt-3`} onClick={refreshAll}>
            {tr("重试")}
          </button>
        </div>
      )}

      {!isLoading && !isError && projects.length === 0 && (
        <Panel>
          <EmptyState
            title={tr("还没有参与任何项目")}
            description={tr("点击「创建项目」立即开启一个独立项目，或加入课程后在小组内创建课程项目。")}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" className={button} onClick={() => setCreateOpen(true)}>
                  <Plus size={15} />
                  {tr("创建项目")}
                </button>
                <Link href="/courses/join" className={secondary}>
                  {tr("加入课程")}
                </Link>
              </div>
            }
          />
        </Panel>
      )}

      {!isLoading && !isError && projects.length > 0 && (
        <>
          {(tab === "all" || tab === "independent") && (
            <section aria-label={tr("独立项目")} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                    <Folder size={15} />
                  </span>
                  <h2 className="text-sm font-bold text-slate-800">{tr("独立项目")}</h2>
                  <span className="gp-pill">{independentProjects.length}</span>
                </div>
                <button
                  type="button"
                  className="text-xs font-semibold text-[var(--gp-action)] hover:underline"
                  onClick={() => setCreateOpen(true)}
                >
                  + {tr("创建项目")}
                </button>
              </div>
              {independentProjects.length > 0 ? (
                <div className="space-y-3">
                  {independentProjects.map((item) => (
                    <ProjectCard key={item.id} item={item} userId={userId} />
                  ))}
                </div>
              ) : (
                <Panel>
                  <EmptyState
                    title={tr("暂无独立项目")}
                    description={tr("独立项目无需加入课程即可创建，适合个人探索或自由组队协作。")}
                    action={
                      <button type="button" className={button} onClick={() => setCreateOpen(true)}>
                        <Plus size={15} />
                        {tr("创建项目")}
                      </button>
                    }
                  />
                </Panel>
              )}
            </section>
          )}

          {(tab === "all" || tab === "course") && (
            <section aria-label={tr("课程项目")} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                    <BookOpen size={15} />
                  </span>
                  <h2 className="text-sm font-bold text-slate-800">{tr("课程项目")}</h2>
                  <span className="gp-pill">{courseProjects.length}</span>
                </div>
                <Link href="/courses?intent=create-project" className="text-xs font-semibold text-[var(--gp-action)] hover:underline">
                  {tr("前往我的课程 →")}
                </Link>
              </div>
              {courseProjects.length > 0 ? (
                <div className="space-y-3">
                  {courseProjects.map((item) => (
                    <ProjectCard key={item.id} item={item} userId={userId} />
                  ))}
                </div>
              ) : (
                <Panel>
                  <EmptyState
                    title={tr("暂无课程项目")}
                    description={tr("加入课程并在小组内完成组队后，即可按课程规则创建课程项目。")}
                    action={
                      <Link href="/courses?intent=create-project" className={secondary}>
                        {tr("前往我的课程")}
                      </Link>
                    }
                  />
                </Panel>
              )}
            </section>
          )}
        </>
      )}

      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
