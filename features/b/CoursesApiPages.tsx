"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, CheckCircle2, Clock, Plus } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { BApiError, newIdempotencyKey } from "@/lib/api/b-client";
import { bCoursesApi, type BCoursePreview, type BJoinRequest, type BJoinResult } from "@/lib/api/b-courses";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";


const myCourseTabs = ["all", "active", "ended"] as const;
const myCourseFilters = {
  tab: { kind: "enum", values: myCourseTabs, default: "all" },
  q: { kind: "string" },
  page: { kind: "int", default: 1, min: 1 },
} as const;
const PAGE_SIZE = 10;

/** Page 31 (B1-01): only the caller's current courses, tab/search/page in the URL. */
export function MyCoursesApiPage() {
  const t = useTranslations("pages.courses");
  const ts = useTranslations("pages.shared");
  const { userId } = useWorkspace();
  const errorText = useBErrorMessage();
  const { filters, setFilters } = useUrlFilters(myCourseFilters);
  const [search, setSearch] = useState(filters.q);
  const list = useQuery({
    queryKey: ["b-my-courses", userId, filters],
    queryFn: () => bCoursesApi.myCourses({ tab: filters.tab, q: filters.q, page: filters.page, page_size: PAGE_SIZE }),
    ...queryPolicy,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return <div>
    <PageHeader title={t("title")} description={t("description")} actions={<Link href="/courses/join" className={button}><Plus size={15} />{t("join")}</Link>} />
    <div role="tablist" className="mb-4 mt-5 flex flex-wrap gap-6 border-b border-slate-200">{myCourseTabs.map((key) => <button key={key} type="button" role="tab" aria-selected={filters.tab === key} onClick={() => setFilters({ tab: key })} className={`border-b-2 pb-3 text-sm font-medium ${filters.tab === key ? "border-blue-600 text-[var(--gp-action)]" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{t(`tabs.${key}`)}{data ? ` ${data.counts[key]}` : ""}</button>)}</div>
    <form className="mb-4 flex max-w-md gap-2" onSubmit={(event) => { event.preventDefault(); setFilters({ q: search.trim() }); }}>
      <label className="sr-only" htmlFor="b-course-search">{t("searchLabel")}</label>
      <input id="b-course-search" className={input} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchPlaceholder")} />
      <button type="submit" className={secondary}>{t("search")}</button>
    </form>
    {data && data.pending_joins.length > 0 && <div className="mb-4"><Feedback tone="warning">{data.pending_joins.map((item) => <span key={item.request_id} className="mr-3 inline-flex items-center gap-1"><Clock size={14} aria-hidden />{t("pendingJoin", { name: item.course_name })}</span>)}</Feedback></div>}
    {list.isPending ? <div role="status" className="gp-empty">{t("loading")}</div>
      : list.isError ? <div role="alert"><Feedback tone="error">{errorText(list.error)}</Feedback><button type="button" className={`${secondary} mt-3`} onClick={() => void list.refetch()}>{ts("retry")}</button></div>
      : data && data.items.length ? <div className="space-y-3">{data.items.map((course) => <Panel key={course.id}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">{course.name}</h2><p className="mt-1 text-xs text-slate-500">{t("teacherLine", { teacher: course.teacher?.name ?? t("toBeAssigned"), code: course.code, semester: course.semester })}</p></div><StatusBadge tone={course.status === "active" ? "green" : "gray"} label={course.status === "active" ? t("statusActive") : course.status === "ended" ? t("statusEnded") : t("statusNotStarted")} /></div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500"><span>{course.group ? t("currentGroup", { name: course.group.name }) : t("noGroup")}</span><span>{t("formationDeadline", { date: dateOnly(course.formation_deadline, ts("notSet")) })}</span><span>{t("projectDeadline", { date: dateOnly(course.project_deadline, ts("notSet")) })}</span>{course.pending_count > 0 && <span className="text-amber-600">{t("pendingCount", { count: course.pending_count })}</span>}</div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm"><Link href={course.project ? `/projects/${course.project.id}` : course.group ? `/courses/${course.id}/projects/new` : `/courses/${course.id}/groups`} className="font-medium text-[var(--gp-action)] hover:underline">{course.project ? t("enterProject") : course.group ? t("createProject") : t("startGrouping")} <ArrowRight size={14} className="inline" /></Link></div>
      </Panel>)}</div>
      : <Panel><EmptyState title={filters.q || filters.tab !== "all" ? t("emptyFiltered") : t("empty")} action={<Link href="/courses/join" className={button}>{t("joinWithCode")}</Link>} /></Panel>}
    {data && pages > 1 && <nav aria-label={ts("pagination")} className="mt-4 flex items-center justify-end gap-2 text-sm"><button type="button" className={secondary} disabled={filters.page <= 1} onClick={() => setFilters({ page: filters.page - 1 })}>{ts("prev")}</button><span>{ts("pagerOf", { page: filters.page, pages })}</span><button type="button" className={secondary} disabled={filters.page >= pages} onClick={() => setFilters({ page: filters.page + 1 })}>{ts("next")}</button></nav>}
  </div>;
}

function Row({ name, value }: { name: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b border-slate-100 pb-3 last:border-0"><span className="text-slate-500">{name}</span><span className="text-right font-medium text-slate-800">{value}</span></div>;
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
    onSuccess: (data) => { setPreview(data); setError(undefined); joinKey.current = newIdempotencyKey(); },
    onError: setError,
  });
  const join = useMutation({
    mutationFn: () => bCoursesApi.join(code.trim(), joinKey.current),
    onSuccess: (data) => { setResult(data); setError(undefined); void cache.invalidateQueries({ queryKey: ["b-my-courses", userId] }); },
    onError: setError,
  });
  const submitCode = () => { if (!code.trim()) { setError(new BApiError(422, "COURSE_INVITE_NOT_FOUND", "", null)); return; } lookup.mutate(); };

  return <div><PageHeader title={t("joinTitle")} description={t("joinDesc")} />
    <div className="mx-auto mt-6 max-w-[740px]">
      <ol aria-label={t("steps")} className="mb-6 flex justify-center gap-6 text-xs">{[t("stepCode"), t("stepConfirm"), t("stepDone")].map((item, index) => <li key={item} aria-current={index === step ? "step" : undefined} className={index === step ? "font-semibold text-[var(--gp-action)]" : "text-slate-400"}>{index + 1}. {item}</li>)}</ol>
      {step === 0 && <Panel title={t("codePanel")}>
        <label className={label} htmlFor="b-invite-code">{t("codeLabel")}</label>
        <input id="b-invite-code" className={input} value={code} autoComplete="off" onChange={(event) => { setCode(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") submitCode(); }} />
        {error !== undefined && <p role="alert" className="mt-3 text-sm text-red-600">{errorText(error)}{blockedByEmail && <Link className="ml-1 underline" href="/account">{t("goVerify")}</Link>}</p>}
        <div className="mt-4 flex justify-end"><button type="button" className={button} disabled={lookup.isPending || blockedByEmail} onClick={submitCode}>{lookup.isPending ? t("looking") : t("nextStep")} <ArrowRight size={15} /></button></div>
      </Panel>}
      {step === 1 && preview && <Panel title={t("confirmPanel")}>
        <div className="space-y-3 text-sm">
          <Row name={t("rowCourse")} value={preview.name} /><Row name={t("rowCode")} value={`${preview.code} · ${preview.semester}`} />
          <Row name={t("rowTeacher")} value={preview.teacher?.name ?? t("toBeAssigned")} />
          <Row name={t("rowGrouping")} value={t("groupSize", { mode: preview.grouping_mode === "free" ? t("groupingFree") : t("groupingApproval"), min: preview.min_group_size, max: preview.max_group_size })} />
          <Row name={t("rowFormation")} value={day(preview.formation_deadline)} /><Row name={t("rowProject")} value={day(preview.project_deadline)} />
          <Row name={t("rowJoinMode")} value={preview.join_mode === "direct" ? t("joinDirect") : t("joinApproval")} />
        </div>
        {preview.already_member && <div className="mt-4"><Feedback tone="info">{t("alreadyMember")}</Feedback></div>}
        {preview.pending_request_id && <div className="mt-4"><Feedback tone="warning">{t("requestPending")}</Feedback></div>}
        {error !== undefined && <p role="alert" className="mt-3 text-sm text-red-600">{errorText(error)}</p>}
        <div className="mt-6 flex justify-end gap-2"><button type="button" className={secondary} onClick={() => { setPreview(undefined); setError(undefined); }}>{t("prevStep")}</button>
          {preview.already_member ? <Link href="/courses" className={button}>{t("viewMyCourses")}</Link>
            : <button type="button" className={button} disabled={join.isPending || Boolean(preview.pending_request_id)} onClick={() => join.mutate()}>{join.isPending ? t("submitting") : preview.join_mode === "direct" ? t("confirmJoin") : t("submitRequest")}</button>}
        </div>
      </Panel>}
      {step === 2 && result && preview && <Panel><div className="py-8 text-center">
        {result.status === "joined" ? <><CheckCircle2 size={42} className="mx-auto text-emerald-600" aria-hidden /><h2 className="mt-4 text-xl font-semibold">{t("joined", { name: preview.name })}</h2><p className="mt-2 text-sm text-slate-500">{t("joinedNext")}</p><div className="mt-6 flex justify-center gap-2"><Link href="/courses" className={secondary}>{t("myCourses")}</Link><Link href={`/courses/${result.course_id}/groups`} className={button}>{t("startGrouping")} <ArrowRight size={15} /></Link></div></>
          : <><Clock size={42} className="mx-auto text-amber-500" aria-hidden /><h2 className="mt-4 text-xl font-semibold">{t("requestSent")}</h2><p className="mt-2 text-sm text-slate-500">{t("requestSentDesc")}</p><div className="mt-6 flex justify-center"><Link href="/courses" className={secondary}>{t("backToMyCourses")}</Link></div></>}
      </div></Panel>}
    </div>
  </div>;
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
  const refresh = () => { void cache.invalidateQueries({ queryKey: key }); void cache.invalidateQueries({ queryKey: ["b-join-policy", userId, courseId] }); };
  const decide = useMutation({
    mutationFn: ({ row, decision }: { row: BJoinRequest; decision: "approve" | "reject" }) => bCoursesApi.decide(row.id, { decision, reason: reasons[row.id]?.trim() || undefined, expected_version: row.lock_version }),
    onSuccess: (row) => { setFeedback({ tone: "success", text: row.status === "approved" ? t("approvedMsg", { name: row.student.name ?? "" }) : t("rejectedMsg", { name: row.student.name ?? "" }) }); refresh(); },
    onError: (error) => { setFeedback({ tone: "error", text: errorText(error) }); refresh(); },
  });
  const setMode = useMutation({
    mutationFn: (mode: "direct" | "approval") => bCoursesApi.setJoinPolicy(courseId, { mode, expected_version: policy.data?.lock_version ?? 0 }),
    onSuccess: () => { setFeedback({ tone: "success", text: t("modeUpdated") }); refresh(); },
    onError: (error) => { setFeedback({ tone: "error", text: errorText(error) }); refresh(); },
  });
  return <Panel title={t("requestsTitle")} action={policy.data && <label className="flex items-center gap-2 text-xs text-slate-600">{t("rowJoinMode")}<select aria-label={t("rowJoinMode")} className="rounded border border-slate-200 px-2 py-1" value={policy.data.mode} disabled={setMode.isPending} onChange={(event) => setMode.mutate(event.target.value as "direct" | "approval")}><option value="direct">{t("modeDirect")}</option><option value="approval">{t("modeApproval")}</option></select></label>}>
    {feedback && <div className="mb-3"><Feedback tone={feedback.tone}>{feedback.text}</Feedback></div>}
    {requests.isPending ? <div role="status" className="gp-empty">{t("loadingRequests")}</div>
      : requests.isError ? <div role="alert"><Feedback tone="error">{errorText(requests.error)}</Feedback></div>
      : requests.data.items.length === 0 ? <EmptyState title={t("noRequests")} />
      : <ul className="divide-y divide-slate-100">{requests.data.items.map((row) => <li key={row.id} className="py-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">{row.student.name ?? t("unnamedStudent")}</p><p className="text-xs text-slate-500">{row.student_number ?? ""} {row.student_email ?? ""} · {t("appliedAt", { time: row.created_at.slice(0, 16).replace("T", " ") })}</p>{row.message && <p className="mt-1 text-sm text-slate-600">{row.message}</p>}</div>
          <div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor={`reason-${row.id}`}>{t("rejectReason")}</label><input id={`reason-${row.id}`} className="rounded border border-slate-200 px-2 py-1.5 text-sm" placeholder={t("rejectPlaceholder")} value={reasons[row.id] ?? ""} onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })} />
            <button type="button" className={secondary} disabled={decide.isPending || !reasons[row.id]?.trim()} onClick={() => decide.mutate({ row, decision: "reject" })}>{t("reject")}</button>
            <button type="button" className={button} disabled={decide.isPending} onClick={() => decide.mutate({ row, decision: "approve" })}>{t("approve")}</button></div></div>
      </li>)}</ul>}
  </Panel>;
}
