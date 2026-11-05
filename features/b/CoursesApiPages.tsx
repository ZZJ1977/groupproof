"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock, Plus } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, StatusBadge } from "@/components/common";
import { BApiError, newIdempotencyKey } from "@/lib/api/b-client";
import { bCoursesApi, type BCoursePreview, type BJoinRequest, type BJoinResult } from "@/lib/api/b-courses";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";


const myCourseTabs = [["all", "全部课程"], ["active", "进行中"], ["ended", "已结束"]] as const;
const myCourseFilters = {
  tab: { kind: "enum", values: myCourseTabs.map(([key]) => key), default: "all" },
  q: { kind: "string" },
  page: { kind: "int", default: 1, min: 1 },
} as const;
const PAGE_SIZE = 10;

/** Page 31 (B1-01): only the caller's current courses, tab/search/page in the URL. */
export function MyCoursesApiPage() {
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
    <PageHeader title="我的课程" description="查看你已加入的课程、组队状态和课程项目入口。" actions={<Link href="/courses/join" className={button}><Plus size={15} />加入课程</Link>} />
    <div role="tablist" className="mb-4 mt-5 flex flex-wrap gap-6 border-b border-slate-200">{myCourseTabs.map(([key, text]) => <button key={key} type="button" role="tab" aria-selected={filters.tab === key} onClick={() => setFilters({ tab: key })} className={`border-b-2 pb-3 text-sm font-medium ${filters.tab === key ? "border-blue-600 text-[var(--gp-action)]" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{text}{data ? ` ${data.counts[key]}` : ""}</button>)}</div>
    <form className="mb-4 flex max-w-md gap-2" onSubmit={(event) => { event.preventDefault(); setFilters({ q: search.trim() }); }}>
      <label className="sr-only" htmlFor="b-course-search">搜索课程</label>
      <input id="b-course-search" className={input} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按课程名称或代码搜索" />
      <button type="submit" className={secondary}>搜索</button>
    </form>
    {data && data.pending_joins.length > 0 && <div className="mb-4"><Feedback tone="warning">{data.pending_joins.map((item) => <span key={item.request_id} className="mr-3 inline-flex items-center gap-1"><Clock size={14} aria-hidden />《{item.course_name}》的加入申请等待老师审批</span>)}</Feedback></div>}
    {list.isPending ? <div role="status" className="gp-empty">正在加载课程…</div>
      : list.isError ? <div role="alert"><Feedback tone="error">{errorText(list.error)}</Feedback><button type="button" className={`${secondary} mt-3`} onClick={() => void list.refetch()}>重试</button></div>
      : data && data.items.length ? <div className="space-y-3">{data.items.map((course) => <Panel key={course.id}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">{course.name}</h2><p className="mt-1 text-xs text-slate-500">授课教师：{course.teacher?.name ?? "待指定"} · {course.code} · {course.semester}</p></div><StatusBadge tone={course.status === "active" ? "green" : "gray"} label={course.status === "active" ? "进行中" : course.status === "ended" ? "已结束" : "未开始"} /></div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500"><span>{course.group ? `当前小组：${course.group.name}` : "尚未加入小组"}</span><span>组队截止 {dateOnly(course.formation_deadline)}</span><span>项目截止 {dateOnly(course.project_deadline)}</span>{course.pending_count > 0 && <span className="text-amber-600">待处理 {course.pending_count} 项</span>}</div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm"><Link href={course.project ? `/projects/${course.project.id}` : course.group ? `/courses/${course.id}/projects/new` : `/courses/${course.id}/groups`} className="font-medium text-[var(--gp-action)] hover:underline">{course.project ? "进入项目" : course.group ? "创建项目" : "开始组队"} <ArrowRight size={14} className="inline" /></Link></div>
      </Panel>)}</div>
      : <Panel><EmptyState title={filters.q || filters.tab !== "all" ? "当前筛选下暂无课程" : "你还没有加入课程"} action={<Link href="/courses/join" className={button}>用邀请码加入课程</Link>} /></Panel>}
    {data && pages > 1 && <nav aria-label="分页" className="mt-4 flex items-center justify-end gap-2 text-sm"><button type="button" className={secondary} disabled={filters.page <= 1} onClick={() => setFilters({ page: filters.page - 1 })}>上一页</button><span>第 {filters.page} / {pages} 页</span><button type="button" className={secondary} disabled={filters.page >= pages} onClick={() => setFilters({ page: filters.page + 1 })}>下一页</button></nav>}
  </div>;
}

function Row({ name, value }: { name: string; value: string }) {
  return <div className="flex justify-between gap-4 border-b border-slate-100 pb-3 last:border-0"><span className="text-slate-500">{name}</span><span className="text-right font-medium text-slate-800">{value}</span></div>;
}

/** Page 32 (B1-02/03): code → preview → confirm. */
export function JoinCourseApiPage() {
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

  return <div><PageHeader title="加入课程" description="输入课程邀请码，确认课程信息后加入。" />
    <div className="mx-auto mt-6 max-w-[740px]">
      <ol aria-label="加入步骤" className="mb-6 flex justify-center gap-6 text-xs">{["输入邀请码", "确认课程", "完成"].map((item, index) => <li key={item} aria-current={index === step ? "step" : undefined} className={index === step ? "font-semibold text-[var(--gp-action)]" : "text-slate-400"}>{index + 1}. {item}</li>)}</ol>
      {step === 0 && <Panel title="课程邀请码">
        <label className={label} htmlFor="b-invite-code">输入教师提供的邀请码</label>
        <input id="b-invite-code" className={input} value={code} autoComplete="off" onChange={(event) => { setCode(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") submitCode(); }} />
        {error !== undefined && <p role="alert" className="mt-3 text-sm text-red-600">{errorText(error)}{blockedByEmail && <Link className="ml-1 underline" href="/account">前往验证</Link>}</p>}
        <div className="mt-4 flex justify-end"><button type="button" className={button} disabled={lookup.isPending || blockedByEmail} onClick={submitCode}>{lookup.isPending ? "正在查询…" : "下一步"} <ArrowRight size={15} /></button></div>
      </Panel>}
      {step === 1 && preview && <Panel title="确认课程">
        <div className="space-y-3 text-sm">
          <Row name="课程" value={preview.name} /><Row name="课程代码" value={`${preview.code} · ${preview.semester}`} />
          <Row name="授课教师" value={preview.teacher?.name ?? "待指定"} />
          <Row name="组队规则" value={`${preview.grouping_mode === "free" ? "自由组队" : "组队需老师审批"}，每组 ${preview.min_group_size}–${preview.max_group_size} 人`} />
          <Row name="组队截止" value={dateOnly(preview.formation_deadline)} /><Row name="项目截止" value={dateOnly(preview.project_deadline)} />
          <Row name="加入方式" value={preview.join_mode === "direct" ? "确认后直接加入" : "提交申请，老师批准后加入"} />
        </div>
        {preview.already_member && <div className="mt-4"><Feedback tone="info">你已经是这门课程的成员。</Feedback></div>}
        {preview.pending_request_id && <div className="mt-4"><Feedback tone="warning">你的加入申请正在等待老师审批。</Feedback></div>}
        {error !== undefined && <p role="alert" className="mt-3 text-sm text-red-600">{errorText(error)}</p>}
        <div className="mt-6 flex justify-end gap-2"><button type="button" className={secondary} onClick={() => { setPreview(undefined); setError(undefined); }}>上一步</button>
          {preview.already_member ? <Link href="/courses" className={button}>查看我的课程</Link>
            : <button type="button" className={button} disabled={join.isPending || Boolean(preview.pending_request_id)} onClick={() => join.mutate()}>{join.isPending ? "正在提交…" : preview.join_mode === "direct" ? "确认加入" : "提交加入申请"}</button>}
        </div>
      </Panel>}
      {step === 2 && result && preview && <Panel><div className="py-8 text-center">
        {result.status === "joined" ? <><CheckCircle2 size={42} className="mx-auto text-emerald-600" aria-hidden /><h2 className="mt-4 text-xl font-semibold">已加入《{preview.name}》</h2><p className="mt-2 text-sm text-slate-500">接下来可以按课程规则创建或加入小组。</p><div className="mt-6 flex justify-center gap-2"><Link href="/courses" className={secondary}>我的课程</Link><Link href={`/courses/${result.course_id}/groups`} className={button}>开始组队 <ArrowRight size={15} /></Link></div></>
          : <><Clock size={42} className="mx-auto text-amber-500" aria-hidden /><h2 className="mt-4 text-xl font-semibold">申请已提交</h2><p className="mt-2 text-sm text-slate-500">老师批准后你会收到通知，届时课程会出现在“我的课程”。</p><div className="mt-6 flex justify-center"><Link href="/courses" className={secondary}>返回我的课程</Link></div></>}
      </div></Panel>}
    </div>
  </div>;
}

/** Teacher side of B1-03 on page 48: pending join requests and the join mode. */
export function JoinRequestsApiPanel({ courseId }: { courseId: string }) {
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
    onSuccess: (row) => { setFeedback({ tone: "success", text: row.status === "approved" ? `已批准 ${row.student.name ?? ""} 加入课程` : `已驳回 ${row.student.name ?? ""} 的申请` }); refresh(); },
    onError: (error) => { setFeedback({ tone: "error", text: errorText(error) }); refresh(); },
  });
  const setMode = useMutation({
    mutationFn: (mode: "direct" | "approval") => bCoursesApi.setJoinPolicy(courseId, { mode, expected_version: policy.data?.lock_version ?? 0 }),
    onSuccess: () => { setFeedback({ tone: "success", text: "加入方式已更新" }); refresh(); },
    onError: (error) => { setFeedback({ tone: "error", text: errorText(error) }); refresh(); },
  });
  return <Panel title="课程加入申请" action={policy.data && <label className="flex items-center gap-2 text-xs text-slate-600">加入方式<select aria-label="加入方式" className="rounded border border-slate-200 px-2 py-1" value={policy.data.mode} disabled={setMode.isPending} onChange={(event) => setMode.mutate(event.target.value as "direct" | "approval")}><option value="direct">凭邀请码直接加入</option><option value="approval">需要老师批准</option></select></label>}>
    {feedback && <div className="mb-3"><Feedback tone={feedback.tone}>{feedback.text}</Feedback></div>}
    {requests.isPending ? <div role="status" className="gp-empty">正在加载申请…</div>
      : requests.isError ? <div role="alert"><Feedback tone="error">{errorText(requests.error)}</Feedback></div>
      : requests.data.items.length === 0 ? <EmptyState title="暂无待处理的加入申请" />
      : <ul className="divide-y divide-slate-100">{requests.data.items.map((row) => <li key={row.id} className="py-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">{row.student.name ?? "未命名学生"}</p><p className="text-xs text-slate-500">{row.student_number ?? ""} {row.student_email ?? ""} · 申请于 {row.created_at.slice(0, 16).replace("T", " ")}</p>{row.message && <p className="mt-1 text-sm text-slate-600">{row.message}</p>}</div>
          <div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor={`reason-${row.id}`}>驳回原因</label><input id={`reason-${row.id}`} className="rounded border border-slate-200 px-2 py-1.5 text-sm" placeholder="驳回原因（驳回时必填）" value={reasons[row.id] ?? ""} onChange={(event) => setReasons({ ...reasons, [row.id]: event.target.value })} />
            <button type="button" className={secondary} disabled={decide.isPending || !reasons[row.id]?.trim()} onClick={() => decide.mutate({ row, decision: "reject" })}>驳回</button>
            <button type="button" className={button} disabled={decide.isPending} onClick={() => decide.mutate({ row, decision: "approve" })}>批准</button></div></div>
      </li>)}</ul>}
  </Panel>;
}
