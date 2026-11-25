"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Folder, FolderKanban, Plus, RefreshCw, Search, Users } from "lucide-react";
import { EmptyState, Feedback, PageHeader, ProgressBar, StatusBadge } from "@/components/common";
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
    <div className="flex flex-wrap gap-1.5 text-[11px]">
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/settings#github-integration`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition ${
          githubConnected
            ? "border-emerald-200 bg-emerald-50/80 text-emerald-800 hover:bg-emerald-100/80"
            : "border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700"
        }`}
      >
        {githubLabel}
      </Link>
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/settings#feishu-integration`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition ${
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
    <div className="flex flex-col justify-between gap-2.5 rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs transition hover:border-sky-200/90 hover:shadow-sm">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                href={baseHref}
                className="truncate text-sm font-semibold text-slate-900 hover:text-[var(--gp-action)] hover:underline"
              >
                {item.name}
              </Link>
              <StatusBadge status={item.lifecycle} />
              {item.isCourseProject ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700">
                  <BookOpen size={11} />
                  {item.courseName ? tr("课程：{0}", { 0: item.courseName }) : tr("课程项目")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                  <Folder size={11} />
                  {tr("独立项目")}
                </span>
              )}
            </div>
            <p className="line-clamp-1 text-xs text-slate-500">
              {item.description?.trim() ? item.description : tr("暂无项目简介，可在项目总览或设置中完善。")}
            </p>
          </div>
          <Link href={baseHref} className={`${button} shrink-0 !min-h-7 !px-2.5 !py-1 !text-xs`}>
            {tr("进入项目")}
            <ArrowRight size={13} />
          </Link>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <div className="flex flex-wrap items-center gap-2.5">
              {item.memberCount !== null && (
                <span className="inline-flex items-center gap-1">
                  <Users size={12} className="text-slate-400" />
                  <span>{tr("{0} 位成员", { 0: item.memberCount })}</span>
                </span>
              )}
              {item.taskCount !== null && item.taskCount > 0 && (
                <span>
                  {tr("已完成 {0}/{1} 项任务", { 0: item.completedCount ?? 0, 1: item.taskCount })}
                </span>
              )}
            </div>
            <span className="font-semibold tabular-nums text-slate-700">
              {item.progress !== null && item.progress_status === "available"
                ? tr("项目进度 {0}%", { 0: item.progress })
                : tr("尚未规划任务")}
            </span>
          </div>
          {item.progress !== null && item.progress_status === "available" && (
            <ProgressBar value={item.progress} className="!h-1.5" />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
        <ProjectIntegrationBadges projectId={item.id} userId={userId} />
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <Link
            href={`${baseHref}/tasks?view=tree`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("任务")}
          </Link>
          <Link
            href={`${baseHref}/github`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            GitHub
          </Link>
          <Link
            href={`${baseHref}/collaboration`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("协作记录")}
          </Link>
          <Link
            href={`${baseHref}/files`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
          >
            {tr("文件资料")}
          </Link>
          <Link
            href={`${baseHref}/settings`}
            className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2 py-0.5 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
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
  const [keyword, setKeyword] = useState("");
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

  const normalizedTerm = keyword.trim().toLowerCase();
  const independentProjects = useMemo(
    () =>
      projects.filter(
        (item) =>
          !item.isCourseProject &&
          (!normalizedTerm || item.name.toLowerCase().includes(normalizedTerm) || (item.description ?? "").toLowerCase().includes(normalizedTerm)),
      ),
    [normalizedTerm, projects],
  );
  const courseProjects = useMemo(
    () =>
      projects.filter(
        (item) =>
          item.isCourseProject &&
          (!normalizedTerm || item.name.toLowerCase().includes(normalizedTerm) || (item.courseName ?? "").toLowerCase().includes(normalizedTerm)),
      ),
    [normalizedTerm, projects],
  );

  const totalIndependent = useMemo(() => projects.filter((item) => !item.isCourseProject).length, [projects]);
  const totalCourse = useMemo(() => projects.filter((item) => item.isCourseProject).length, [projects]);

  const isLoading = homeSummary.isPending && myCourses.isPending;
  const isError = homeSummary.isError && !homeSummary.data && !myCourses.data;
  const isFetching = homeSummary.isFetching || myCourses.isFetching;

  const refreshAll = () => {
    void homeSummary.refetch();
    void myCourses.refetch();
    void cache.invalidateQueries({ queryKey: ["b-project-overview", userId] });
  };

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <AnnouncementBanner />
      <PageHeader
        title={tr("我的项目")}
        icon={FolderKanban}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${button} !min-h-9 !px-3.5 !text-xs`}
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={14} />
              {tr("创建项目")}
            </button>
            <Link href="/courses?intent=create-project" className={`${secondary} !min-h-9 !px-3 !text-xs`}>
              <BookOpen size={14} />
              {tr("我的课程")}
            </Link>
            <button
              type="button"
              className={`${secondary} !min-h-9 !px-3 !text-xs`}
              disabled={isFetching}
              onClick={refreshAll}
            >
              <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} />
              {tr("刷新")}
            </button>
          </div>
        }
      />

      {/* 单行紧凑分类筛选 + 搜索条 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-slate-200/85 bg-white px-3.5 py-2 shadow-xs">
        <div role="tablist" aria-label={tr("项目分类筛选")} className="gp-segmented !p-0.5">
          {(
            [
              ["all", tr("全部"), projects.length],
              ["independent", tr("独立项目"), totalIndependent],
              ["course", tr("课程项目"), totalCourse],
            ] as const
          ).map(([key, text, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              data-active={tab === key ? "true" : undefined}
              onClick={() => setTab(key)}
              className="gp-segmented-item !min-h-8 !px-3 !py-1 !text-xs"
            >
              <span>{text}</span>
              {!isLoading && (
                <span className="rounded-full bg-slate-200/70 px-1.5 py-0.2 text-[11px] font-semibold text-slate-600">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-60">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label={tr("搜索项目")}
            placeholder={tr("搜索项目或课程名称…")}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            className="h-9 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/15"
          />
        </div>
      </div>

      {isLoading && <div role="status" className="gp-empty !py-8">{tr("正在加载项目列表…")}</div>}

      {isError && (
        <div role="alert" className="rounded-2xl border border-rose-200/85 bg-white p-4 shadow-xs">
          <Feedback tone="error">{errorText(homeSummary.error)}</Feedback>
          <button type="button" className={`${secondary} mt-3 !min-h-8 !text-xs`} onClick={refreshAll}>
            {tr("重试")}
          </button>
        </div>
      )}

      {!isLoading && !isError && projects.length === 0 && (
        <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
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
        </div>
      )}

      {!isLoading && !isError && projects.length > 0 && (
        <>
          {(tab === "all" || tab === "independent") && (
            <section aria-label={tr("独立项目")} className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-50 text-sky-700">
                    <Folder size={13} />
                  </span>
                  <h2 className="text-sm font-bold text-slate-800">{tr("独立项目")}</h2>
                  <span className="gp-pill !min-h-5 !px-2 !py-0">{independentProjects.length}</span>
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
                <div className="grid gap-3.5 md:grid-cols-2">
                  {independentProjects.map((item) => (
                    <ProjectCard key={item.id} item={item} userId={userId} />
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                  <EmptyState
                    title={tr("暂无独立项目")}
                    description={tr("独立项目无需加入课程即可创建，适合个人探索或自由组队协作。")}
                    action={
                      <button type="button" className={`${button} !min-h-8 !text-xs`} onClick={() => setCreateOpen(true)}>
                        <Plus size={14} />
                        {tr("创建项目")}
                      </button>
                    }
                  />
                </div>
              )}
            </section>
          )}

          {(tab === "all" || tab === "course") && (
            <section aria-label={tr("课程项目")} className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-50 text-teal-700">
                    <BookOpen size={13} />
                  </span>
                  <h2 className="text-sm font-bold text-slate-800">{tr("课程项目")}</h2>
                  <span className="gp-pill !min-h-5 !px-2 !py-0">{courseProjects.length}</span>
                </div>
                <Link href="/courses?intent=create-project" className="text-xs font-semibold text-[var(--gp-action)] hover:underline">
                  {tr("前往我的课程 →")}
                </Link>
              </div>
              {courseProjects.length > 0 ? (
                <div className="grid gap-3.5 md:grid-cols-2">
                  {courseProjects.map((item) => (
                    <ProjectCard key={item.id} item={item} userId={userId} />
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                  <EmptyState
                    title={tr("暂无课程项目")}
                    description={tr("加入课程并在小组内完成组队后，即可按课程规则创建课程项目。")}
                    action={
                      <Link href="/courses?intent=create-project" className={`${secondary} !min-h-8 !text-xs`}>
                        {tr("前往我的课程")}
                      </Link>
                    }
                  />
                </div>
              )}
            </section>
          )}
        </>
      )}

      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
