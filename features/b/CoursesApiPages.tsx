"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, BookOpen, Calendar, CheckCircle2, Clock, Plus, Search, Users } from "lucide-react";
import { EmptyState, Feedback, PageHeader, StatusBadge } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { useGpThemeScope } from "@/components/ui/theme-scope";
import { BApiError, newIdempotencyKey } from "@/lib/api/b-client";
import { bCoursesApi, type BCoursePreview, type BJoinRequest, type BJoinResult } from "@/lib/api/b-courses";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { AnnouncementBanner } from "@/features/b/AnnouncementBanner";
import { CreateProjectModal } from "@/features/b/CreateProjectModal";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";
import { TeacherFeedbackPill } from "@/features/teacher/components/TeacherFeedbackPill";
import { TeacherSegmentedTabs } from "@/features/teacher/components/TeacherSegmentedTabs";

const myCourseTabs = ["all", "active", "ended"] as const;
const myCourseFilters = {
  tab: { kind: "enum", values: myCourseTabs, default: "all" },
  q: { kind: "string" },
  page: { kind: "int", default: 1, min: 1 },
} as const;
const PAGE_SIZE = 10;
const feishuCard =
  "rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]";
const feishuInput =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-white px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[#3370ff]/15";

/** Page 31 (B1-01): only the caller's current courses, tab/search/page in the URL. */
export function MyCoursesApiPage() {
  const t = useTranslations("pages.courses");
  const ts = useTranslations("pages.shared");
  const { userId, role } = useWorkspace();
  const scope = useGpThemeScope();
  const isTeacher = role === "teacher" || role === "ta";
  const createIntent = useSearchParams().get("intent") === "create-project";
  const errorText = useBErrorMessage();
  const { filters, setFilters } = useUrlFilters(myCourseFilters);
  const [search, setSearch] = useState(filters.q);
  const [createOpen, setCreateOpen] = useState(false);
  const list = useQuery({
    queryKey: ["b-my-courses", userId, filters],
    queryFn: () => bCoursesApi.myCourses({ tab: filters.tab, q: filters.q, page: filters.page, page_size: PAGE_SIZE }),
    ...queryPolicy,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  if (scope === "teacher") {
    return (
      <div className="min-w-0 max-w-full space-y-5">
        <AnnouncementBanner />
        <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-4")}>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--gp-ink,#1f2329)]">
              <BookOpen size={20} className="shrink-0 text-[var(--gp-action,#3370ff)]" aria-hidden="true" />
              <span className="truncate">{createIntent ? t("createCourseProjectTitle") : t("title")}</span>
            </h1>
            <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
              {createIntent ? t("chooseProjectCourse") : t("description")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!createIntent && (
              <Link
                href="/teacher/courses"
                data-variant="default"
                className={buttonVariants({ variant: "default", size: "sm", pill: true })}
              >
                <Plus size={15} aria-hidden="true" />
                {tr("我的班级 / 创建班级")}
              </Link>
            )}
            <Link
              href="/courses/join"
              data-variant={createIntent ? "default" : "outline"}
              className={buttonVariants({ variant: createIntent ? "default" : "outline", size: "sm", pill: true })}
            >
              <Plus size={15} aria-hidden="true" />
              {t("join")}
            </Link>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <TeacherSegmentedTabs
            variant="segmented"
            size="sm"
            ariaLabel={t("title")}
            activeId={filters.tab}
            onChange={(key) => setFilters({ tab: key })}
            items={myCourseTabs.map((key) => ({
              id: key,
              label: data ? `${t(`tabs.${key}`)} ${data.counts[key]}` : t(`tabs.${key}`),
            }))}
          />
          <form
            className="flex w-full max-w-sm items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setFilters({ q: search.trim() });
            }}
          >
            <label className="sr-only" htmlFor="b-course-search">
              {t("searchLabel")}
            </label>
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gp-subtle,#8f959e)]"
                aria-hidden="true"
              />
              <input
                id="b-course-search"
                className={cn(feishuInput, "pl-8")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchPlaceholder")}
              />
            </div>
            <Button type="submit" variant="outline" size="sm" pill>
              {t("search")}
            </Button>
          </form>
        </div>

        {data && data.pending_joins.length > 0 && (
          <div className="rounded-[12px] border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-xs text-[#b45309] shadow-[var(--gp-shadow-card)]">
            {data.pending_joins.map((item) => (
              <span key={item.request_id} className="mr-3 inline-flex items-center gap-1.5 font-medium">
                <Clock size={14} aria-hidden="true" />
                {t("pendingJoin", { name: item.course_name })}
              </span>
            ))}
          </div>
        )}

        {list.isPending ? (
          <div role="status" className="space-y-4">
            <span className="sr-only">{t("loading")}</span>
            {[0, 1].map((idx) => (
              <div key={idx} className={cn(feishuCard, "animate-pulse space-y-3")}>
                <div className="h-5 w-48 rounded bg-[var(--gp-surface-hover,#eff0f1)]" />
                <div className="h-3 w-64 rounded bg-[var(--gp-surface-subtle,#f8f9fa)]" />
                <div className="h-8 w-full rounded bg-[var(--gp-surface-subtle,#f8f9fa)]" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <div className={cn(feishuCard, "flex flex-wrap items-center justify-between gap-3")}>
            <TeacherFeedbackPill tone="error" message={errorText(list.error)} />
            <Button type="button" variant="outline" size="sm" pill onClick={() => void list.refetch()}>
              {ts("retry")}
            </Button>
          </div>
        ) : data && data.items.length ? (
          <div className="space-y-4">
            {data.items.map((course) => (
              <div key={course.id} className={cn(feishuCard, "gp-card-interactive min-w-0")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2
                      className="truncate text-base font-semibold text-[var(--gp-ink,#1f2329)]"
                      title={course.name}
                    >
                      {course.name}
                    </h2>
                    <p className="mt-1 text-xs text-[var(--gp-muted,#646a73)]">
                      {t("teacherLine", {
                        teacher: course.teacher?.name ?? t("toBeAssigned"),
                        code: course.code,
                        semester: course.semester,
                      })}
                    </p>
                  </div>
                  <StatusBadge
                    tone={course.status === "active" ? "green" : "gray"}
                    label={
                      course.status === "active"
                        ? t("statusActive")
                        : course.status === "ended"
                          ? t("statusEnded")
                          : t("statusNotStarted")
                    }
                  />
                </div>
                <div className="gp-tabular mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-[var(--gp-ink-soft,#4e5969)]">
                  <span>{course.group ? t("currentGroup", { name: course.group.name }) : t("noGroup")}</span>
                  <span>{t("formationDeadline", { date: dateOnly(course.formation_deadline, ts("notSet")) })}</span>
                  <span>{t("projectDeadline", { date: dateOnly(course.project_deadline, ts("notSet")) })}</span>
                  {course.pending_count > 0 && (
                    <span className="rounded-full bg-[#fffbeb] px-2.5 py-0.5 font-medium text-[#b45309]">
                      {t("pendingCount", { count: course.pending_count })}
                    </span>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-3 text-sm">
                  <div className="flex flex-wrap items-center gap-4">
                    <Link
                      href={`/courses/${course.id}/rules`}
                      className="text-xs font-medium text-[var(--gp-ink-soft,#4e5969)] hover:text-[var(--gp-action,#3370ff)]"
                    >
                      {t("viewRules")}
                    </Link>
                    <Link
                      href={`/courses/${course.id}/files`}
                      className="text-xs font-medium text-[var(--gp-ink-soft,#4e5969)] hover:text-[var(--gp-action,#3370ff)]"
                    >
                      {t("viewFiles")}
                    </Link>
                  </div>
                  <Link
                    href={
                      course.project
                        ? `/projects/${course.project.id}`
                        : course.group
                          ? `/courses/${course.id}/projects/new`
                          : `/courses/${course.id}/groups`
                    }
                    data-variant="tonal"
                    className={buttonVariants({ variant: "tonal", size: "sm", pill: true })}
                  >
                    {course.project ? t("enterProject") : course.group ? t("createProject") : t("startGrouping")}
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={feishuCard}>
            <EmptyState
              title={filters.q || filters.tab !== "all" ? t("emptyFiltered") : t("empty")}
              description={createIntent ? t("joinBeforeCreate") : undefined}
              action={
                <Link
                  href="/teacher/courses"
                  data-variant="default"
                  className={buttonVariants({ variant: "default", size: "sm", pill: true })}
                >
                  {tr("前往我的班级创建课程")}
                </Link>
              }
            />
          </div>
        )}

        {data && pages > 1 && (
          <nav
            aria-label={ts("pagination")}
            className="flex items-center justify-end gap-2 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4 text-xs text-[var(--gp-muted,#646a73)]"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              pill
              disabled={filters.page <= 1}
              onClick={() => setFilters({ page: filters.page - 1 })}
            >
              {ts("prev")}
            </Button>
            <span className="gp-tabular px-2">{ts("pagerOf", { page: filters.page, pages })}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              pill
              disabled={filters.page >= pages}
              onClick={() => setFilters({ page: filters.page + 1 })}
            >
              {ts("next")}
            </Button>
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <AnnouncementBanner />
      <PageHeader
        title={createIntent ? t("createCourseProjectTitle") : t("title")}
        actions={
          <div className="flex flex-wrap gap-2">
            {isTeacher && !createIntent && (
              <Link href="/teacher/courses" className={`${button} !min-h-9 !px-3.5 !text-xs`}>
                <Plus size={14} />我的班级 / 创建班级
              </Link>
            )}
            {!isTeacher && !createIntent && (
              <button type="button" className={`${button} !min-h-9 !px-3.5 !text-xs`} onClick={() => setCreateOpen(true)}>
                <Plus size={14} />{t("createProjectTitle")}
              </button>
            )}
            <Link href="/courses/join" className={`${createIntent ? button : secondary} !min-h-9 !px-3.5 !text-xs`}>
              <Plus size={14} />{t("join")}
            </Link>
          </div>
        }
      />

      {/* 单行紧凑标签页 + 搜索栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-slate-200/85 bg-white px-3.5 py-2 shadow-xs">
        <div role="tablist" className="gp-segmented !p-0.5">
          {myCourseTabs.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filters.tab === key}
              data-active={filters.tab === key ? "true" : undefined}
              onClick={() => setFilters({ tab: key })}
              className="gp-segmented-item !min-h-8 !px-3 !py-1 !text-xs"
            >
              {t(`tabs.${key}`)}
              {data ? ` ${data.counts[key]}` : ""}
            </button>
          ))}
        </div>

        <form
          className="flex w-full items-center gap-2 sm:w-auto"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ q: search.trim() });
          }}
        >
          <label className="sr-only" htmlFor="b-course-search">{t("searchLabel")}</label>
          <div className="relative flex-1 sm:w-56">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              id="b-course-search"
              className="h-9 w-full rounded-lg border border-slate-200/90 bg-slate-50/50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/15"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchPlaceholder")}
            />
          </div>
          <button type="submit" className={`${secondary} !min-h-9 !px-3 !text-xs`}>{t("search")}</button>
        </form>
      </div>

      {data && data.pending_joins.length > 0 && (
        <Feedback tone="warning">
          {data.pending_joins.map((item) => (
            <span key={item.request_id} className="mr-3 inline-flex items-center gap-1 text-xs">
              <Clock size={13} aria-hidden />
              {t("pendingJoin", { name: item.course_name })}
            </span>
          ))}
        </Feedback>
      )}

      {list.isPending ? (
        <div role="status" className="gp-empty !py-8">{t("loading")}</div>
      ) : list.isError ? (
        <div role="alert" className="rounded-2xl border border-rose-200/85 bg-white p-4 shadow-xs">
          <Feedback tone="error">{errorText(list.error)}</Feedback>
          <button type="button" className={`${secondary} mt-3 !min-h-8 !text-xs`} onClick={() => void list.refetch()}>
            {ts("retry")}
          </button>
        </div>
      ) : data && data.items.length ? (
        <div className="grid gap-3.5 md:grid-cols-2">
          {data.items.map((course) => (
            <div
              key={course.id}
              className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs transition hover:border-sky-200/90 hover:shadow-sm"
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                      <BookOpen size={15} />
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold text-slate-900">{course.name}</h2>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {t("teacherLine", {
                          teacher: course.teacher?.name ?? t("toBeAssigned"),
                          code: course.code,
                          semester: course.semester,
                        })}
                      </p>
                    </div>
                  </div>
                  <StatusBadge
                    tone={course.status === "active" ? "green" : "gray"}
                    label={
                      course.status === "active"
                        ? t("statusActive")
                        : course.status === "ended"
                          ? t("statusEnded")
                          : t("statusNotStarted")
                    }
                  />
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    <Users size={12} className="text-slate-400" />
                    {course.group ? t("currentGroup", { name: course.group.name }) : t("noGroup")}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={12} className="text-slate-400" />
                    {t("formationDeadline", { date: dateOnly(course.formation_deadline, ts("notSet")) })}
                  </span>
                  <span>{t("projectDeadline", { date: dateOnly(course.project_deadline, ts("notSet")) })}</span>
                  {course.pending_count > 0 && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      {t("pendingCount", { count: course.pending_count })}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/courses/${course.id}/rules`}
                    className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
                  >
                    {t("viewRules")}
                  </Link>
                  <Link
                    href={`/courses/${course.id}/files`}
                    className="rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 font-medium text-slate-600 transition hover:border-sky-300 hover:bg-white hover:text-sky-700"
                  >
                    {t("viewFiles")}
                  </Link>
                </div>
                <Link
                  href={
                    course.project
                      ? `/projects/${course.project.id}`
                      : course.group
                        ? `/courses/${course.id}/projects/new`
                        : `/courses/${course.id}/groups`
                  }
                  className="inline-flex items-center gap-1 font-semibold text-[var(--gp-action)] hover:underline"
                >
                  {course.project ? t("enterProject") : course.group ? t("createProject") : t("startGrouping")}
                  <ArrowRight size={13} className="inline" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
          <EmptyState
            title={filters.q || filters.tab !== "all" ? t("emptyFiltered") : t("empty")}
            description={createIntent ? t("joinBeforeCreate") : undefined}
            action={
              isTeacher ? (
                <Link href="/teacher/courses" className={button}>前往我的班级创建课程</Link>
              ) : (
                <Link href="/courses/join" className={button}>{t("joinWithCode")}</Link>
              )
            }
          />
        </div>
      )}

      {data && pages > 1 && (
        <nav aria-label={ts("pagination")} className="flex items-center justify-end gap-2 text-xs text-slate-500">
          <button
            type="button"
            className={`${secondary} !min-h-8 !px-3 !text-xs`}
            disabled={filters.page <= 1}
            onClick={() => setFilters({ page: filters.page - 1 })}
          >
            {ts("prev")}
          </button>
          <span>{ts("pagerOf", { page: filters.page, pages })}</span>
          <button
            type="button"
            className={`${secondary} !min-h-8 !px-3 !text-xs`}
            disabled={filters.page >= pages}
            onClick={() => setFilters({ page: filters.page + 1 })}
          >
            {ts("next")}
          </button>
        </nav>
      )}
      <CreateProjectModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function Row({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-2 text-xs last:border-0">
      <span className="text-slate-500">{name}</span>
      <span className="text-right font-medium text-slate-800">{value}</span>
    </div>
  );
}

/** Page 32 (B1-02/03): code → preview → confirm. */
export function JoinCourseApiPage() {
  const t = useTranslations("pages.courses");
  const ts = useTranslations("pages.shared");
  const day = (value: string | null | undefined) => dateOnly(value, ts("notSet"));
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const errorText = useBErrorMessage();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<BCoursePreview>();
  const [result, setResult] = useState<BJoinResult>();
  const [error, setError] = useState<unknown>();
  const joinKey = useRef<string>("");
  const blockedByEmail = error instanceof BApiError && error.code === "EMAIL_NOT_VERIFIED";
  const step = result ? 2 : preview ? 1 : 0;

  const lookup = useMutation({
    mutationFn: () => bCoursesApi.preview(code.trim()),
    onSuccess: (data) => {
      setPreview(data);
      setError(undefined);
      joinKey.current = newIdempotencyKey();
    },
    onError: setError,
  });
  const join = useMutation({
    mutationFn: () => bCoursesApi.join(code.trim(), joinKey.current),
    onSuccess: (data) => {
      setResult(data);
      setError(undefined);
      void cache.invalidateQueries({ queryKey: ["b-my-courses", userId] });
      void cache.invalidateQueries({ queryKey: ["c-home-summary"] });
    },
    onError: setError,
  });
  const submitCode = () => {
    if (lookup.isPending) return;
    if (!code.trim()) {
      setError(new BApiError(422, "COURSE_INVITE_NOT_FOUND", "", null));
      return;
    }
    lookup.mutate();
  };

  return (
    <div className="space-y-3.5 [&_.gp-page-header]:!mb-0">
      <PageHeader title={t("joinTitle")} />
      <div className="mx-auto max-w-2xl space-y-3.5">
        <ol aria-label={t("steps")} className="flex flex-wrap justify-center gap-3 text-xs">
          {[t("stepCode"), t("stepConfirm"), t("stepDone")].map((item, index) => (
            <li
              key={item}
              aria-current={index === step ? "step" : undefined}
              className={`rounded-full px-3 py-1 transition ${
                index === step
                  ? "bg-sky-50 font-semibold text-[var(--gp-action)] ring-1 ring-sky-200"
                  : index < step
                    ? "bg-emerald-50 font-medium text-emerald-700"
                    : "bg-slate-100 text-slate-400"
              }`}
            >
              {index + 1}. {item}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
            <h2 className="mb-3 text-sm font-bold text-slate-900">{t("codePanel")}</h2>
            <label className={label} htmlFor="b-invite-code">{t("codeLabel")}</label>
            <input
              id="b-invite-code"
              className={`${input} h-9`}
              value={code}
              disabled={lookup.isPending}
              autoComplete="off"
              onChange={(event) => {
                setCode(event.target.value);
                setError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitCode();
              }}
            />
            {error !== undefined && (
              <p role="alert" className="mt-2.5 text-xs text-rose-600">
                {errorText(error)}
                {blockedByEmail && <Link className="ml-1 underline" href="/account">{t("goVerify")}</Link>}
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className={`${button} !min-h-9 !text-xs`}
                disabled={lookup.isPending || blockedByEmail}
                onClick={submitCode}
              >
                {lookup.isPending ? t("looking") : t("nextStep")} <ArrowRight size={14} />
              </button>
            </div>
          </section>
        )}

        {step === 1 && preview && (
          <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
            <h2 className="mb-2.5 text-sm font-bold text-slate-900">{t("confirmPanel")}</h2>
            <div>
              <Row name={t("rowCourse")} value={preview.name} />
              <Row name={t("rowCode")} value={`${preview.code} · ${preview.semester}`} />
              <Row name={t("rowTeacher")} value={preview.teacher?.name ?? t("toBeAssigned")} />
              <Row
                name={t("rowGrouping")}
                value={t("groupSize", {
                  mode: preview.grouping_mode === "free" ? t("groupingFree") : t("groupingApproval"),
                  min: preview.min_group_size,
                  max: preview.max_group_size,
                })}
              />
              <Row name={t("rowFormation")} value={day(preview.formation_deadline)} />
              <Row name={t("rowProject")} value={day(preview.project_deadline)} />
              <Row name={t("rowJoinMode")} value={preview.join_mode === "direct" ? t("joinDirect") : t("joinApproval")} />
            </div>
            {preview.already_member && <div className="mt-3"><Feedback tone="info">{t("alreadyMember")}</Feedback></div>}
            {preview.pending_request_id && <div className="mt-3"><Feedback tone="warning">{t("requestPending")}</Feedback></div>}
            {error !== undefined && <p role="alert" className="mt-2.5 text-xs text-rose-600">{errorText(error)}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={`${secondary} !min-h-9 !text-xs`}
                onClick={() => {
                  setPreview(undefined);
                  setError(undefined);
                }}
              >
                {t("prevStep")}
              </button>
              {preview.already_member ? (
                <Link href="/courses" className={`${button} !min-h-9 !text-xs`}>{t("viewMyCourses")}</Link>
              ) : (
                <button
                  type="button"
                  className={`${button} !min-h-9 !text-xs`}
                  disabled={join.isPending || Boolean(preview.pending_request_id)}
                  onClick={() => join.mutate()}
                >
                  {join.isPending ? t("submitting") : preview.join_mode === "direct" ? t("confirmJoin") : t("submitRequest")}
                </button>
              )}
            </div>
          </section>
        )}

        {step === 2 && result && preview && (
          <section className="rounded-2xl border border-slate-200/85 bg-white p-6 text-center shadow-xs">
            {result.status === "joined" ? (
              <>
                <CheckCircle2 size={36} className="mx-auto text-emerald-600" aria-hidden />
                <h2 className="mt-3 text-lg font-semibold text-slate-900">{t("joined", { name: preview.name })}</h2>
                <p className="mt-1.5 text-xs text-slate-500">{t("joinedNext")}</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Link href="/courses" className={`${secondary} !min-h-9 !text-xs`}>{t("myCourses")}</Link>
                  <Link href={`/courses/${result.course_id}/groups`} className={`${button} !min-h-9 !text-xs`}>
                    {t("startGrouping")} <ArrowRight size={14} />
                  </Link>
                </div>
              </>
            ) : (
              <>
                <Clock size={36} className="mx-auto text-amber-500" aria-hidden />
                <h2 className="mt-3 text-lg font-semibold text-slate-900">{t("requestSent")}</h2>
                <p className="mt-1.5 text-xs text-slate-500">{t("requestSentDesc")}</p>
                <div className="mt-4 flex justify-center">
                  <Link href="/courses" className={`${secondary} !min-h-9 !text-xs`}>{t("backToMyCourses")}</Link>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** Teacher side of B1-03 on page 48: pending join requests and the join mode. */
export function JoinRequestsApiPanel({ courseId }: { courseId: string }) {
  const t = useTranslations("pages.courses");
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const errorText = useBErrorMessage();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string }>();
  const key = ["b-join-requests", userId, courseId];
  const requests = useQuery({ queryKey: key, queryFn: () => bCoursesApi.joinRequests(courseId), ...queryPolicy });
  const policy = useQuery({ queryKey: ["b-join-policy", userId, courseId], queryFn: () => bCoursesApi.joinPolicy(courseId), ...queryPolicy });
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: key });
    void cache.invalidateQueries({ queryKey: ["b-join-policy", userId, courseId] });
  };
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BJoinRequest; decision: "approve" | "reject" }) =>
      bCoursesApi.decide(row.id, { decision, reason: reasons[row.id]?.trim() || undefined, expected_version: row.lock_version }),
    onSuccess: (row) => {
      setFeedback({
        tone: "success",
        text: row.status === "approved" ? t("approvedMsg", { name: row.student.name ?? "" }) : t("rejectedMsg", { name: row.student.name ?? "" }),
      });
      refresh();
    },
    onError: (error) => {
      setFeedback({ tone: "error", text: errorText(error) });
      refresh();
    },
  });
  const setMode = useMutation({
    mutationFn: (mode: "direct" | "approval") => bCoursesApi.setJoinPolicy(courseId, { mode, expected_version: policy.data?.lock_version ?? 0 }),
    onSuccess: () => {
      setFeedback({ tone: "success", text: t("modeUpdated") });
      refresh();
    },
    onError: (error) => {
      setFeedback({ tone: "error", text: errorText(error) });
      refresh();
    },
  });

  return (
    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <h2 className="text-sm font-bold text-slate-900">{t("requestsTitle")}</h2>
        {policy.data && (
          <label className="flex items-center gap-2 text-xs text-slate-600">
            {t("rowJoinMode")}
            <select
              aria-label={t("rowJoinMode")}
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-900 outline-none focus:border-sky-500"
              value={policy.data.mode}
              disabled={setMode.isPending}
              onChange={(event) => setMode.mutate(event.target.value as "direct" | "approval")}
            >
              <option value="direct">{t("modeDirect")}</option>
              <option value="approval">{t("modeApproval")}</option>
            </select>
          </label>
        )}
      </div>

      {feedback && <div className="mb-3"><Feedback tone={feedback.tone}>{feedback.text}</Feedback></div>}
      {requests.isPending ? (
        <div role="status" className="gp-empty !py-6">{t("loadingRequests")}</div>
      ) : requests.isError ? (
        <div role="alert"><Feedback tone="error">{errorText(requests.error)}</Feedback></div>
      ) : requests.data.items.length === 0 ? (
        <EmptyState title={t("noRequests")} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {requests.data.items.map((row) => (
            <li key={row.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{row.student.name ?? t("unnamedStudent")}</p>
                  <p className="text-xs text-slate-500">
                    {row.student_number ?? ""} {row.student_email ?? ""} · {t("appliedAt", { time: row.created_at.slice(0, 16).replace("T", " ") })}
                  </p>
                  {row.message && <p className="mt-0.5 text-xs text-slate-600">{row.message}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`reason-${row.id}`}>{t("rejectReason")}</label>
                  <input
                    id={`reason-${row.id}`}
                    className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs outline-none focus:border-sky-500"
                    placeholder={t("rejectPlaceholder")}
                    value={reasons[row.id] ?? ""}
                    onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })}
                  />
                  <button
                    type="button"
                    className={`${secondary} !min-h-8 !px-3 !text-xs`}
                    disabled={decide.isPending || !reasons[row.id]?.trim()}
                    onClick={() => decide.mutate({ row, decision: "reject" })}
                  >
                    {t("reject")}
                  </button>
                  <button
                    type="button"
                    className={`${button} !min-h-8 !px-3 !text-xs`}
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ row, decision: "approve" })}
                  >
                    {t("approve")}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
