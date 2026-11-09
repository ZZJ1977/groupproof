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
// Values are message keys under pages.daily.categories.*
const categoryLabels = { all: "all", development: "development", evidence: "evidence", discussion: "discussion" } as const;

function QueryFailure({ error, retry }: { error: Error; retry: () => void }) {
  const t = useTranslations("pages.daily");
  const ts = useTranslations("pages.shared");
  const message = error instanceof CApiError && error.status === 401
    ? t("fail401")
    : error instanceof CApiError && error.status === 403
      ? t("fail403")
      : error instanceof CApiError ? error.message : t("failDefault");
  return <div role="alert" className="gp-panel p-4"><p>{message}</p><button className={`${buttonClass} mt-3`} type="button" onClick={retry}>{ts("retry")}</button></div>;
}

/** Canonical queries only; workspace data and demo roles are never a data source. */
export function HomeApiPage() {
  const { userId } = useWorkspace();
  const t = useTranslations("core.home");
  const td = useTranslations("pages.daily");
  const result = useQuery({ queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <PageHeader title={t("title")} description={td("homeDesc")} actions={<button className={buttonClass} type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>{td("refreshStats")}</button>} />
    {result.isFetching && <p role="status">{td("loadingHome")}</p>}
    {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}
    {data && <>
      <div className="gp-grid-4 mb-5">
        <Stat label={t("myCourses")} value={data.course_count} icon={BookOpen} />
        <Stat label={t("myProjects")} value={data.project_count} icon={Folder} />
        <Stat label={td("completedTasks")} value={data.my_completed_tasks} icon={CheckSquare} />
        <Stat label={t("pending")} value={data.pending_action_items ?? "—"} />
      </div>
      <p className="mb-3 text-sm text-slate-600">{td("statsNote")}</p>
      <div className="mb-4 flex flex-wrap gap-4 text-sm">
        <Link className="gp-link" href="/notifications">{td("unreadNotifications", { value: String(data.unread_notifications ?? td("unavailable")) })}</Link>
        <Link className="gp-link" href="/action-items">{td("pendingActions", { value: String(data.pending_action_items ?? td("unavailable")) })}</Link>
      </div>
      <div className="gp-grid-2">
        <Panel title={t("myProjects")}><p className="mb-3 text-xs text-slate-500">{td("recentProjects")}</p>
          <div className="space-y-4">{data.projects.map((project) => <div key={project.id} className="border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong>{project.name}</strong><StatusBadge status={project.lifecycle} /></div>
            <p className="my-2 text-xs text-slate-600">{td("taskProgress", { value: project.progress === null ? td("notComputable") : `${project.progress}%` })}</p>
            {project.progress !== null && <ProgressBar value={project.progress} />}
            <Link className="gp-link mt-2 inline-block text-sm" href={`/projects/${encodeURIComponent(project.id)}`}>{t("enterProject")}</Link>
          </div>)}</div>
          {!data.projects.length && <EmptyState title={t("emptyProjects")} />}
        </Panel>
        <Panel title={t("myCourses")}><p className="mb-3 text-xs text-slate-500">{td("recentCourses")}</p>
          <div className="space-y-4">{data.courses.map((course) => <div key={course.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div><strong>{course.name}</strong><span className="ml-2"><StatusBadge status={course.status} /></span></div>
            <Link className="gp-link text-sm" href={`/courses/${encodeURIComponent(course.id)}/rules`}>{td("viewCourse")}</Link>
          </div>)}</div>
          {!data.courses.length && <EmptyState title={t("emptyCourses")} />}
        </Panel>
      </div>
      <Link className="gp-link mt-4 inline-block" href="/activity">{td("viewActivity")}</Link>
    </>}
  </>;
}

export function ActivityApiPage() {
  const { userId } = useWorkspace();
  const { query, updateQuery } = useUrlQuery();
  const t = useTranslations("core.activity");
  const td = useTranslations("pages.daily");
  const ts = useTranslations("pages.shared");
  const rawCategory = query.get("category") ?? "all";
  const category = Object.hasOwn(categoryLabels, rawCategory) ? rawCategory as keyof typeof categoryLabels : "all";
  const rawPage = Number(query.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const filters: DailyActivityQuery = { category, page, page_size: 10, project_id: query.get("project_id") || undefined,
    date_from: query.get("date_from") || undefined, date_to: query.get("date_to") || undefined };
  const result = useQuery({ queryKey: ["c-personal-activity", userId, filters], queryFn: () => client.personalActivity(filters), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <PageHeader title={t("title")} description={td("activityDesc")} />
    <p className="mb-4 text-sm text-slate-600">{td("activityNote")}</p>
    <div className="gp-tabs mb-4" aria-label={td("categoryLabel")}>{Object.entries(categoryLabels).map(([value, label]) => <button className={`gp-tab ${category === value ? "active" : ""}`} type="button" key={value} aria-pressed={category === value} onClick={() => updateQuery({ category: value === "all" ? null : value, page: null })}>{td(`categories.${label}`)}</button>)}</div>
    <form key={query.toString()} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault(); const input = new FormData(event.currentTarget);
      updateQuery({ date_from: String(input.get("date_from") ?? "") || null, date_to: String(input.get("date_to") ?? "") || null, page: null });
    }}>
      <label className="flex flex-col gap-1 text-sm">{td("dateFrom")}<input className={inputClass} type="date" name="date_from" defaultValue={query.get("date_from") ?? ""} /></label>
      <label className="flex flex-col gap-1 text-sm">{td("dateTo")}<input className={inputClass} type="date" name="date_to" defaultValue={query.get("date_to") ?? ""} /></label>
      <button className={buttonClass} type="submit">{td("search")}</button>
      <button className={buttonClass} type="button" onClick={() => updateQuery({ category: null, project_id: null, date_from: null, date_to: null, page: null })}>{td("reset")}</button>
      <button className={buttonClass} type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>{td("refreshActivity")}</button>
    </form>
    {filters.project_id && <p className="mb-3 text-sm">{td("projectOnly")}</p>}
    {result.isFetching && <p role="status">{td("loadingActivity")}</p>}
    {result.isError && <QueryFailure error={result.error} retry={() => void result.refetch()} />}
    {data && <Panel>
      <div className="space-y-4">{data.items.map((item) => {
        const prefix = `/projects/${item.project_id}/`;
        const href = item.href.startsWith(prefix) && !/[\\\u0000-\u001f]/.test(item.href) ? item.href : null;
        return <article key={item.id} className="border-b border-slate-100 pb-3">
          <p className="mb-1 text-xs text-slate-500">{td(`categories.${categoryLabels[item.category]}`)} · {item.project_name}</p>
          {href ? <Link className="gp-link" href={href}>{item.title}</Link> : <span>{item.title}</span>}
          <p className="mt-1 text-xs text-slate-500"><time dateTime={item.occurred_at}>{formatDate(item.occurred_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></p>
        </article>;
      })}</div>
      {!data.items.length && <EmptyState title={td("emptyActivity")} />}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span>{ts("pagerTotal", { total: data.total, page: data.page })}</span><div className="flex gap-2">
        <button className={buttonClass} type="button" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1) })}>{ts("prev")}</button>
        <button className={buttonClass} type="button" disabled={data.page * data.page_size >= data.total} onClick={() => updateQuery({ page: String(page + 1) })}>{ts("next")}</button>
      </div></div>
    </Panel>}
  </>;
}
