"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { BookOpen, CheckSquare, Folder, Plus, RefreshCw } from "lucide-react";
import { EmptyState, ListRow, PageHeader, ProgressBar, Section, Stat, StatusBadge } from "@/components/common";
import { buttonVariants } from "@/components/ui/button";
import { projectRequest } from "@/features/github-binding/integration-request";
import { AnnouncementBanner } from "@/features/b/AnnouncementBanner";
import { CApiError, createCClient, type DailyActivityQuery } from "@/lib/api/c-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { useUrlQuery } from "./use-url-query";
import { MyAccessRequests } from "./GovernanceApiPages";

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
        ? `GitHub 已连接 · ${repos.data.length} 个仓库`
        : "GitHub 未连接";
  const feishuLabel = chats.isPending
    ? "飞书状态读取中"
    : chats.isError
      ? "飞书状态暂不可用"
      : chats.data.length > 0
        ? `飞书已接入 · ${chats.data.length} 个群`
        : "飞书未接入";
  return <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
    <Link className="gp-link" href={`/projects/${encodeURIComponent(projectId)}/settings#github-integration`}>{githubLabel}</Link>
    <Link className="gp-link" href={`/projects/${encodeURIComponent(projectId)}/settings#feishu-integration`}>{feishuLabel}</Link>
  </div>;
}

/** Canonical queries only; workspace data and demo roles are never a data source. */
export function HomeApiPage() {
  const { userId, role } = useWorkspace();
  const isTeacher = role === "teacher" || role === "ta";
  const t = useTranslations("core.home");
  const result = useQuery({ queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <AnnouncementBanner />
    <PageHeader title={t("title")} description="根据你当前的课程、项目和任务计算。" actions={<div className="flex flex-wrap items-center gap-2">
      {isTeacher && <Link href="/teacher/courses" className={buttonVariants()}>我的班级 / 创建班级</Link>}
      <Link href="/projects/new" className={buttonVariants(isTeacher ? { variant: "outline" } : undefined)}><Plus size={16} />{t("createProject")}</Link>
      <Link href="/courses/join" className={buttonVariants({ variant: "outline" })}><BookOpen size={16} />{t("joinCourse")}</Link>
      <button className={buttonVariants({ variant: "ghost" })} type="button" disabled={result.isFetching} onClick={() => void result.refetch()}><RefreshCw size={15} />刷新统计</button>
    </div>} />
    {result.isFetching && <p role="status">正在读取首页…</p>}
    {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}
    {data && <>
      <div className="gp-grid-4 mb-5">
        <Stat label={t("myCourses")} value={data.course_count} icon={BookOpen} />
        <Stat label={t("myProjects")} value={data.project_count} icon={Folder} />
        <Stat label="我的已完成任务" value={data.my_completed_tasks} icon={CheckSquare} />
        <Stat label={t("pending")} value={data.pending_action_items ?? "—"} />
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <Link className="gp-pill hover:bg-sky-100/80" href="/notifications">未读通知：{data.unread_notifications ?? "暂不可用"}</Link>
        <Link className="gp-pill hover:bg-sky-100/80" href="/action-items">待处理事项：{data.pending_action_items ?? "暂不可用"}</Link>
        <Link className="gp-pill hover:bg-sky-100/80" href="/activity">查看个人动态 →</Link>
      </div>
      <div className="gp-grid-2">
        <Section title={t("myProjects")} description="最近更新的项目" surface>
          <div className="gp-list">{data.projects.map((project) => <ListRow key={project.id} title={<span className="inline-flex flex-wrap items-center gap-2"><span>{project.name}</span> <StatusBadge status={project.lifecycle} /></span>} meta={project.progress === null ? "尚未规划任务 · 进入项目开始拆解任务" : `任务进度：${project.progress}%`} actions={<Link className="gp-link text-sm" href={`/projects/${encodeURIComponent(project.id)}`}>{t("enterProject")}</Link>}>
            {project.progress !== null && <div className="mt-2"><ProgressBar value={project.progress} /></div>}
            <ProjectIntegrationStatus projectId={project.id} userId={userId} />
          </ListRow>)}</div>
          {!data.projects.length && <EmptyState title={t("emptyProjects")} description={t("emptyProjectHint")} action={<Link href="/projects/new" className={buttonVariants()}><Plus size={16} />{t("createProject")}</Link>} />}
        </Section>
        <Section title={t("myCourses")} description="最近更新的课程" surface>
          {isTeacher && <Link className="gp-link mb-3 inline-block text-sm font-medium" href="/teacher/courses">管理我的班级与学生组队广场 →</Link>}
          <div className="gp-list">{data.courses.map((course) => <ListRow key={course.id} title={<span className="inline-flex flex-wrap items-center gap-2"><span>{course.name}</span> <StatusBadge status={course.status} /></span>} actions={<Link className="gp-link text-sm" href={course.href}>查看课程</Link>} />)}</div>
          {!data.courses.length && <EmptyState title={t("emptyCourses")} description={t("emptyCourseHint")} action={<Link href="/courses/join" className={buttonVariants({ variant: "outline" })}><BookOpen size={16} />{t("joinCourse")}</Link>} />}
        </Section>
      </div>
    </>}
    <MyAccessRequests key={userId} />
  </>;
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
