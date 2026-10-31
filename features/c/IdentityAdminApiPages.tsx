"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { ApiError } from "@/lib/api/auth-client";
import { cIdentityClient, type IdentityAdminPage, type IdentityAdminUser, type IdentityTeacherApplication, type TeacherApplicationStatus } from "@/lib/api/c-identity-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import { useUrlQuery } from "./use-url-query";

const control = "rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50";
const applicationStatuses = { pending: "待审核", approved: "已通过", rejected: "已拒绝", all: "全部状态" } as const;
function normalizedPage(value: string | null) {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1;
}
function teacherStatus(value: string | null): TeacherApplicationStatus {
  return value && Object.hasOwn(applicationStatuses, value) ? value as TeacherApplicationStatus : "pending";
}
function message(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return "记录已变化，请刷新后重新确认；刚才的输入已保留。";
  if (error instanceof ApiError && [401, 403].includes(error.status)) return "登录已失效或没有管理权限，请重新登录后再试。";
  return "暂不能确认操作结果，请检查输入并刷新核对后重试。";
}
function recordVersion(row: IdentityAdminUser | IdentityTeacherApplication) {
  return "version" in row ? row.version : row.applicationVersion;
}

export function IdentityAdminApiPage({ teachers = false }: { teachers?: boolean }) {
  const { userId } = useWorkspace();
  const { query } = useUrlQuery();
  // Only teacher history's actual filter/page changes reset its selection.
  const scope = teachers ? `${teacherStatus(query.get("status"))}:${normalizedPage(query.get("page"))}` : "directory";
  return <IdentityAdminContent key={`${userId}:${teachers}:${scope}`} teachers={teachers} userId={userId} />;
}

function IdentityAdminContent({ teachers, userId }: { teachers: boolean; userId: string }) {
  const [accessBlocked, setAccessBlocked] = useState(false);
  const { query, updateQuery } = useUrlQuery();
  const page = normalizedPage(query.get("page"));
  const applicationStatus = teacherStatus(query.get("status"));
  const filters = new URLSearchParams({ page: String(page) });
  if (teachers) filters.set("status", applicationStatus);
  else for (const key of ["q", "role", "status", "college"]) if (query.get(key)) filters.set(key, query.get(key)!);
  const result = useQuery<IdentityAdminPage<IdentityAdminUser | IdentityTeacherApplication>>({ queryKey: ["c-identity-admin", userId, teachers, filters.toString()],
    queryFn: () => teachers ? cIdentityClient.applications(page, applicationStatus) : cIdentityClient.users(filters),
    enabled: !accessBlocked, staleTime: 0, gcTime: 0, retry: false });
  const data = result.isSuccess && !result.isFetching && !accessBlocked ? result.data : undefined;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acknowledgedVersion, setAcknowledgedVersion] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const locked = useRef(false);
  // Display fresh details, but require an explicit refresh before accepting a changed version.
  const selected = data?.items.find((row) => row.id === selectedId);
  const selectionChanged = Boolean(selected && recordVersion(selected) !== acknowledgedVersion);
  if (!accessBlocked && result.error instanceof ApiError && [401, 403].includes(result.error.status)) {
    setAccessBlocked(true); setSelectedId(null); setAcknowledgedVersion(null); setReason(""); setConflict(false); setFeedback("");
  } else if (selectedId && data && !selected) {
    setSelectedId(null); setAcknowledgedVersion(null); setReason("");
  } else if (selected && "applicationVersion" in selected && selected.status !== "pending" && reason) {
    setReason(""); setConflict(false);
  }
  async function decide(decision: "approve" | "reject" | "disable") {
    if (!selected || !reason.trim() || locked.current || conflict || selectionChanged) return;
    locked.current = true; setPending(true); setFeedback("");
    try {
      if (decision === "disable" && "canDisable" in selected) await cIdentityClient.disable(selected, reason.trim(), userId);
      else if (decision !== "disable" && "applicationVersion" in selected && selected.status === "pending") await cIdentityClient.review(selected, decision, reason.trim(), userId);
      else return;
      setSelectedId(null); setReason(""); setFeedback("决定已保存。"); await result.refetch();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setSelectedId(null); setAcknowledgedVersion(null); setReason(""); setConflict(false);
        setFeedback("这条记录已不存在，详情已关闭。");
        await result.refetch();
      } else {
        setFeedback(message(error));
        if (error instanceof ApiError && error.status === 409) setConflict(true);
        if (error instanceof ApiError && [401, 403].includes(error.status)) { setAccessBlocked(true); setSelectedId(null); setAcknowledgedVersion(null); setReason(""); }
      }
    } finally { locked.current = false; setPending(false); }
  }
  async function refresh() {
    if (accessBlocked) { window.location.reload(); return; }
    const response = await result.refetch();
    if (response.isSuccess) {
      const latest = response.data.items.find((row) => row.id === selectedId);
      setAcknowledgedVersion(latest ? recordVersion(latest) : null);
      setConflict(false);
      setFeedback(selected ? "已刷新记录，请核对后重新确认。处理原因已保留。" : "");
    }
  }
  return <>
    <PageHeader title={teachers ? "教师审核" : "用户管理"} description={teachers ? "审核待处理申请，查询已保存的审核结果与原因。" : "查询账号并按规则停用；停用会撤销该账号的现有会话。"} />
    {teachers && <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); updateQuery({ status: String(form.get("status")), page: null }); }}><label>审核状态<select className={`${control} block`} name="status" defaultValue={applicationStatus} disabled={pending}>{Object.entries(applicationStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={control} disabled={pending}>筛选申请</button></form>}
    {!teachers && <p className="mb-4 text-sm text-slate-600">恢复账号和新增账号暂不可用。</p>}
    {!teachers && <form className="mb-4 flex flex-wrap gap-2" key={query.toString()} onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      updateQuery(Object.fromEntries(["q", "role", "status", "college"].map((key) => [key, String(form.get(key) || "") || null]).concat([["page", null]])));
    }}>
      <input className={control} name="q" aria-label="姓名、邮箱或学号" placeholder="姓名、邮箱或学号" defaultValue={query.get("q") ?? ""} />
      <input className={control} name="college" aria-label="学院" placeholder="学院" defaultValue={query.get("college") ?? ""} />
      <select className={control} name="role" aria-label="角色" defaultValue={query.get("role") ?? ""}><option value="">全部角色</option>{["student", "teacher", "ta", "admin"].map((role) => <option key={role}>{role}</option>)}</select>
      <select className={control} name="status" aria-label="账号状态" defaultValue={query.get("status") ?? ""}><option value="">全部状态</option><option value="enabled">可用</option><option value="disabled">停用</option></select>
      <button className={control}>查询</button>
    </form>}
    <button className={`${control} mb-4`} type="button" disabled={pending || result.isFetching} onClick={() => void refresh()}>刷新列表</button>
    {result.isFetching && <p role="status">正在读取…</p>}
    {result.isError && <p role="alert">{message(result.error)}</p>}
    {feedback && <p role="status" className="mb-4">{feedback}</p>}
    {data && <Panel><div className="space-y-3">{data.items.map((row) => <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <div><strong>{row.name}</strong><p className="text-sm text-slate-600">{row.college} · {"roles" in row ? `${row.roles.join("、")} · ${row.status}` : `${applicationStatuses[row.status]} · 当前邮箱：${row.emailDomain || "未绑定"} · ${row.emailVerified ? "已验证" : "未验证"}`}</p></div>
      <button className={control} disabled={pending || ((conflict || selectionChanged) && selectedId === row.id)} onClick={() => { if (selectedId !== row.id) setReason(""); setSelectedId(row.id); setAcknowledgedVersion(recordVersion(row)); setConflict(false); setFeedback(""); }}>查看</button>
    </article>)}</div>
      {!data.items.length && <EmptyState title="没有符合条件的记录" />}
      <div className="mt-4 flex gap-3"><span>共 {data.total} 条 · 第 {data.page} 页</span><button className={control} disabled={page <= 1 || pending} onClick={() => { setSelectedId(null); updateQuery({ page: String(page - 1) }); }}>上一页</button><button className={control} disabled={page * 10 >= data.total || pending} onClick={() => { setSelectedId(null); updateQuery({ page: String(page + 1) }); }}>下一页</button></div>
    </Panel>}
    {selected && <Panel title={selected.name} className="mt-4">
      {"schoolEmail" in selected && <p>{selected.schoolEmail ?? "尚未验证学校邮箱"} · {selected.studentId ?? "无学号"}</p>}
      {"applicationVersion" in selected && <div className="space-y-3"><div><h3 className="font-semibold">提交时的申请资料</h3><p>姓名：{selected.submittedName ?? "未记录"}</p><p>申请身份：{selected.submittedIdentity === "teacher" ? "教师" : selected.submittedIdentity === "student" ? "学生" : "未记录"}</p><p>学校邮箱域：{selected.submittedEmailDomain ?? "未记录"}</p><p>申请版本：{selected.applicationVersion} · 提交时间：{formatDate(selected.createdAt)}</p></div><div><h3 className="font-semibold">当前账号资料</h3><p>姓名：{selected.name}</p><p>当前学校邮箱域：{selected.emailDomain || "未绑定"} · {selected.emailVerified ? "已验证" : "未验证"}</p><p className="text-sm text-slate-600">当前资料可能已变化，不代表提交或审核时的资料。</p></div>{selected.status !== "pending" && <div><h3 className="font-semibold">已保存的审核结果：{applicationStatuses[selected.status]}</h3><p>审核时间：{selected.reviewedAt ? formatDate(selected.reviewedAt) : "未记录"}</p><p>审核人（当前姓名）：{selected.reviewerName ?? "未记录或账号已不存在"}</p><p className="whitespace-pre-wrap">审核原因：{selected.reviewReason ?? "未记录"}</p><p className="text-sm text-slate-600">此记录只读；结果取自当时保存的审核决定，不根据当前账号角色推断。</p></div>}</div>}
      {selectionChanged && <p role="alert">此记录已被其他人修改，请刷新列表并核对后再提交；处理原因已保留。</p>}
      {("canDisable" in selected || selected.status === "pending") && <><label className="block my-3">处理原因<textarea className={`${control} mt-1 block w-full`} aria-label="处理原因" value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)} maxLength={2000} /></label><div className="flex gap-3">{"canDisable" in selected ? <button className={control} disabled={pending || conflict || selectionChanged || !reason.trim() || !selected.canDisable} onClick={() => void decide("disable")}>确认停用</button> : <><button className={control} disabled={pending || conflict || selectionChanged || !reason.trim() || !selected.emailVerified} onClick={() => void decide("approve")}>通过</button><button className={control} disabled={pending || conflict || selectionChanged || !reason.trim()} onClick={() => void decide("reject")}>拒绝</button></>}</div></>}
      <button className={`${control} mt-3`} disabled={pending} onClick={() => { setSelectedId(null); setAcknowledgedVersion(null); setReason(""); setConflict(false); }}>取消</button>
    </Panel>}
  </>;
}
