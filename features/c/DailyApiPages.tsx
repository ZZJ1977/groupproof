"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { BookOpen, CheckSquare, Folder } from "lucide-react";
import { EmptyState, PageHeader, Panel, ProgressBar, Stat, StatusBadge } from "@/components/common";
import { CApiError, createCClient, type DailyActivityQuery } from "@/lib/api/c-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { useUrlQuery } from "./use-url-query";

const client = createCClient();
const buttonClass = "rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50";
const inputClass = "rounded-md border border-slate-300 px-3 py-2 text-sm";
const categoryLabels = { all: "全部", development: "任务执行", evidence: "证据", discussion: "讨论" } as const;

function QueryFailure({ error, retry }: { error: Error; retry: () => void }) {
  const message = error instanceof CApiError && error.status === 401
    ? "当前登录身份暂时无法读取此服务，请重新登录或稍后重试。"
    : error instanceof CApiError && error.status === 403
      ? "你目前没有权限读取这些数据。"
      : error instanceof CApiError ? error.message : "数据暂不可用，请重试。";
  return <div role="alert" className="gp-panel p-4"><p>{message}</p><button className={`${buttonClass} mt-3`} type="button" onClick={retry}>重试</button></div>;
}

/** Canonical queries only; workspace data and demo roles are never a data source. */
export function HomeApiPage() {
  const { userId } = useWorkspace();
  const t = useTranslations("core.home");
  const result = useQuery({ queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <PageHeader title={t("title")} description="根据你当前的课程、项目和任务计算。" actions={<button className={buttonClass} type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>刷新统计</button>} />
    {result.isFetching && <p role="status">正在读取首页…</p>}
    {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}
    {data && <>
      <div className="gp-grid-4 mb-5">
        <Stat label={t("myCourses")} value={data.course_count} icon={BookOpen} />
        <Stat label={t("myProjects")} value={data.project_count} icon={Folder} />
        <Stat label="我的已完成任务" value={data.my_completed_tasks} icon={CheckSquare} />
        <Stat label={t("pending")} value={data.pending_action_items ?? "—"} />
      </div>
      <p className="mb-3 text-sm text-slate-600">包含仍可访问的已结束课程及归档项目；已完成任务按验收后的任务状态统计。</p>
      <div className="mb-4 flex flex-wrap gap-4 text-sm">
        <Link className="gp-link" href="/notifications">未读通知：{data.unread_notifications ?? "暂不可用"}</Link>
        <Link className="gp-link" href="/action-items">待处理事项：{data.pending_action_items ?? "暂不可用"}</Link>
      </div>
      <div className="gp-grid-2">
        <Panel title={t("myProjects")}><p className="mb-3 text-xs text-slate-500">最近更新的最多 10 个项目</p>
          <div className="space-y-4">{data.projects.map((project) => <div key={project.id} className="border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong>{project.name}</strong><StatusBadge status={project.lifecycle} /></div>
            <p className="my-2 text-xs text-slate-600">任务进度：{project.progress === null ? "暂不可计算" : `${project.progress}%`}</p>
            {project.progress !== null && <ProgressBar value={project.progress} />}
            <Link className="gp-link mt-2 inline-block text-sm" href={`/projects/${encodeURIComponent(project.id)}`}>{t("enterProject")}</Link>
          </div>)}</div>
          {!data.projects.length && <EmptyState title={t("emptyProjects")} />}
        </Panel>
        <Panel title={t("myCourses")}><p className="mb-3 text-xs text-slate-500">最近更新的最多 10 门课程</p>
          <div className="space-y-4">{data.courses.map((course) => <div key={course.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div><strong>{course.name}</strong><span className="ml-2"><StatusBadge status={course.status} /></span></div>
            <Link className="gp-link text-sm" href={`/courses/${encodeURIComponent(course.id)}/rules`}>查看课程</Link>
          </div>)}</div>
          {!data.courses.length && <EmptyState title={t("emptyCourses")} />}
        </Panel>
      </div>
      <Link className="gp-link mt-4 inline-block" href="/activity">查看个人动态</Link>
    </>}
  </>;
}

export function ActivityApiPage() {
  const { userId } = useWorkspace();
  const { query, updateQuery } = useUrlQuery();
  const t = useTranslations("core.activity");
  const rawCategory = query.get("category") ?? "all";
  const category = Object.hasOwn(categoryLabels, rawCategory) ? rawCategory as keyof typeof categoryLabels : "all";
  const rawPage = Number(query.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const filters: DailyActivityQuery = { category, page, page_size: 10, project_id: query.get("project_id") || undefined,
    date_from: query.get("date_from") || undefined, date_to: query.get("date_to") || undefined };
  const result = useQuery({ queryKey: ["c-personal-activity", userId, filters], queryFn: () => client.personalActivity(filters), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <PageHeader title={t("title")} description="只显示你产生且目前仍有权限查看的任务、证据和讨论记录。" />
    <p className="mb-4 text-sm text-slate-600">任务执行包含进度和实现说明；GitHub、飞书动态尚未接入。日期按 UTC 自然日筛选。</p>
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
    {data && <Panel>
      <div className="space-y-4">{data.items.map((item) => {
        const prefix = `/projects/${item.project_id}/`;
        const href = item.href.startsWith(prefix) && !/[\\\u0000-\u001f]/.test(item.href) ? item.href : null;
        return <article key={item.id} className="border-b border-slate-100 pb-3">
          <p className="mb-1 text-xs text-slate-500">{categoryLabels[item.category]} · {item.project_name}</p>
          {href ? <Link className="gp-link" href={href}>{item.title}</Link> : <span>{item.title}</span>}
          <p className="mt-1 text-xs text-slate-500"><time dateTime={item.occurred_at}>{formatDate(item.occurred_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></p>
        </article>;
      })}</div>
      {!data.items.length && <EmptyState title="没有符合条件的个人动态" />}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span>共 {data.total} 条 · 第 {data.page} 页</span><div className="flex gap-2">
        <button className={buttonClass} type="button" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>上一页</button>
        <button className={buttonClass} type="button" disabled={data.page * data.page_size >= data.total} onClick={() => updateQuery({ page: String(page + 1) })}>下一页</button>
      </div></div>
    </Panel>}
  </>;
}
