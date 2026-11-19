"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpen, CheckSquare, Folder } from "lucide-react";
import { EmptyState, PageHeader, Panel, ProgressBar, Stat, StatusBadge } from "@/components/common";
import { CApiError, createCClient, type DailyActivityQuery } from "@/lib/api/c-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { AnnouncementBanner } from "@/features/b/AnnouncementBanner";
import { useUrlQuery } from "./use-url-query";
import { MyAccessRequests } from "./GovernanceApiPages";

const client = createCClient();
const buttonClass = "rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50";
const inputClass = "rounded-md border border-slate-300 px-3 py-2 text-sm";
// Values are message keys under pages.daily.categories.*
const categoryLabels = { all: "all", development: "development", evidence: "evidence", discussion: "discussion" } as const;
const activityLabels = {
  task_progress: "更新任务进度或状态", task_note_saved: "保存实现说明", file_version_uploaded: "登记项目文件版本",
  github_commit: "GitHub 提交", github_pull_request: "GitHub 拉取请求", github_ci_run: "GitHub CI 运行",
  evidence_submitted: "提交候选证据", evidence_adopted: "采纳证据", evidence_withdrawn: "撤回证据",
  evidence_source_changed: "证据来源变化", discussion_created: "发布讨论", discussion_replied: "回复讨论",
};

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
  const { userId, role } = useWorkspace();
  const isTeacher = role === "teacher" || role === "ta";
  const t = useTranslations("core.home");
  const td = useTranslations("pages.daily");
  const result = useQuery({ queryKey: ["c-home-summary", userId], queryFn: () => client.homeSummary(), staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <>
    <AnnouncementBanner />
    <PageHeader
      title={t("title")}
      description={td("homeDesc")}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {isTeacher && <Link className="inline-flex items-center rounded-md bg-[#246bfa] px-3 py-2 text-sm font-medium text-white hover:bg-[#1b5be0]" href="/teacher/courses">我的班级 / 创建班级</Link>}
          <button className={buttonClass} type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>{td("refreshStats")}</button>
        </div>
      }
    />
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
          {isTeacher && <div className="mb-3"><Link className="gp-link text-sm font-medium" href="/teacher/courses">管理我的班级与学生组队广场 →</Link></div>}
          <div className="space-y-4">{data.courses.map((course) => <div key={course.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div><strong>{course.name}</strong><span className="ml-2"><StatusBadge status={course.status} /></span></div>
            <Link className="gp-link text-sm" href={isTeacher ? `/teacher/courses/${encodeURIComponent(course.id)}` : `/courses/${encodeURIComponent(course.id)}/rules`}>{td("viewCourse")}</Link>
          </div>)}</div>
          {!data.courses.length && <EmptyState title={t("emptyCourses")} action={isTeacher ? <Link className="inline-flex rounded-md bg-[#246bfa] px-3 py-2 text-sm font-medium text-white hover:bg-[#1b5be0]" href="/teacher/courses">前往我的班级创建课程</Link> : undefined} />}
        </Panel>
      </div>
      <Link className="gp-link mt-4 inline-block" href="/activity">{td("viewActivity")}</Link>
    </>}
    <MyAccessRequests key={userId} />
  </>;
}

function GithubAuthorForm() {
  const [login, setLogin] = useState("");
  const change = useMutation({
    mutationFn: (value: string | null) => client.setGithubLogin(value),
    retry: false,
    onSuccess: (reply) => setLogin(reply.login ?? ""),
  });
  return <details className="my-4">
    <summary className="cursor-pointer font-medium">设置个人 GitHub 用户名</summary>
    <form className="mt-3" onSubmit={(event) => { event.preventDefault(); if (login.trim() && !change.isPending) change.mutate(login.trim()); }}>
      <p className="mb-2 text-sm">填写本人使用的 GitHub 用户名，供下次项目同步时匹配作者。此设置只用于作者归属，仓库访问权限由项目绑定管理。</p>
      <label className="block">GitHub 用户名<input className={`${inputClass} ml-2`} value={login} maxLength={120} autoCapitalize="none" spellCheck={false}
        disabled={change.isPending} onChange={(event) => { change.reset(); setLogin(event.target.value); }} /></label>
      <div className="my-2 flex gap-2"><button className={buttonClass} disabled={change.isPending || !login.trim()}>保存用户名</button>
        <button className={buttonClass} type="button" disabled={change.isPending} onClick={() => change.mutate(null)}>清除作者映射</button></div>
      {change.isPending && <p role="status">正在保存…</p>}
      {change.isSuccess && <p role="status">{change.data.login ? `已保存 GitHub 用户名 @${change.data.login}。` : "已清除 GitHub 用户名映射。"}</p>}
      {change.isError && <p role="alert">{change.error instanceof CApiError ? change.error.message : "保存失败，请重试。"}</p>}
    </form>
  </details>;
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
    {data && <GithubAuthorForm key={userId} />}
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
          <p className="mb-1 text-xs text-slate-500">{activityLabels[item.event_type] ?? td(`categories.${categoryLabels[item.category]}`)} · {item.project_name}</p>
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
