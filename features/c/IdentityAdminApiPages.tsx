"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ApiError, authClient } from "@/lib/api/auth-client";
import { cIdentityClient, type IdentityAdminPage, type IdentityAdminUser, type IdentityTeacherApplication, type TeacherApplicationStatus } from "@/lib/api/c-identity-client";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import styles from "@/features/governance/governance.module.css";
import { useUrlQuery } from "./use-url-query";

const control = "rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50";
const buttonControl = `${control} ${styles.button}`;
const inputControl = `${control} ${styles.input}`;
const applicationStatuses = { pending: "待审核", approved: "已通过", rejected: "已拒绝", all: "全部状态" } as const;
const roleLabels = { student: "学生", teacher: "教师", ta: "助教", admin: "管理员", leader: "组长" } as const;
const accountStatusLabels = { enabled: "可用", disabled: "已停用" } as const;
function normalizedPage(value: string | null) {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1;
}
function teacherStatus(value: string | null): TeacherApplicationStatus {
  return value && Object.hasOwn(applicationStatuses, value) ? value as TeacherApplicationStatus : "pending";
}
function roleLabel(value: string) {
  return roleLabels[value as keyof typeof roleLabels] ?? value;
}
function accountStatusLabel(value: string) {
  return accountStatusLabels[value as keyof typeof accountStatusLabels] ?? value;
}
function emailStatusLabel(verified: boolean) {
  return verified ? "已验证" : "待验证";
}
function isIdentityUser(row: IdentityAdminUser | IdentityTeacherApplication): row is IdentityAdminUser {
  return "roles" in row;
}
function message(error: unknown, context: "action" | "read" | "form" = "action") {
  let text = "暂不能确认操作结果，请检查输入并刷新核对后重试。";
  let retryAfter: number | null = null;
  let requestId: string | null = null;
  if (error instanceof ApiError) {
    requestId = error.requestId;
    retryAfter = error.retryAfterSeconds;
    if (error.status === 409) text = "记录已变化，请刷新后重新确认；刚才的输入已保留。";
    else if ([401, 403].includes(error.status)) text = "登录已失效或没有管理权限，请重新登录后再试。";
    else if (context === "read" && (error.status === 0 || error.code === "NETWORK_ERROR")) text = "网络连接失败，暂时无法读取用户目录，请检查网络后重试。";
    else if (context === "read" && [500, 502, 503, 504].includes(error.status)) text = "身份服务暂时不可用，请稍后重试。";
    else if (context === "form" && error.status === 422) text = "提交内容未通过校验，请检查标记字段后重试。";
  }
  if (retryAfter && retryAfter > 0) text += `（建议 ${retryAfter} 秒后重试）`;
  if (requestId) text += `（请求编号：${requestId}）`;
  return text;
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
  const data = !accessBlocked ? result.data : undefined;
  const [selectedIdState, setSelectedIdState] = useState<string | null>(null);
  const [acknowledgedVersion, setAcknowledgedVersion] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [conflict, setConflict] = useState(false);
  const locked = useRef(false);
  const selectedTriggerRef = useRef<HTMLButtonElement | null>(null);
  // User directory selection is URL-replayable; teacher history keeps its existing local selection.
  const selectedId = teachers ? selectedIdState : query.get("user");
  // Display fresh details, but require an explicit refresh before accepting a changed version.
  const selected = data?.items.find((row) => row.id === selectedId);
  const selectionChanged = Boolean(selected && recordVersion(selected) !== acknowledgedVersion);
  useEffect(() => {
    if (!accessBlocked && result.error instanceof ApiError && [401, 403].includes(result.error.status)) {
      setAccessBlocked(true);
      if (teachers) setSelectedIdState(null);
      else if (query.get("user")) updateQuery({ user: null });
      setAcknowledgedVersion(null); setReason(""); setConflict(false); setFeedback("");
    }
  }, [accessBlocked, result.error, teachers, query, updateQuery]);
  useEffect(() => {
    if (!result.isError || !selectedId || (result.error instanceof ApiError && [401, 403].includes(result.error.status))) return;
    if (teachers) setSelectedIdState(null);
    else updateQuery({ user: null });
    setAcknowledgedVersion(null); setReason(""); setConflict(false); setFeedback("");
  }, [result.error, result.isError, selectedId, teachers, updateQuery]);
  useEffect(() => {
    if (!teachers && data && selectedId && !selected) {
      updateQuery({ user: null });
      setAcknowledgedVersion(null); setReason(""); setConflict(false);
      setFeedback("这条记录不在当前结果中，请调整筛选后重试。");
    }
  }, [data, selected, selectedId, teachers, updateQuery]);
  useEffect(() => {
    if (selected && acknowledgedVersion === null) setAcknowledgedVersion(recordVersion(selected));
  }, [selected, acknowledgedVersion]);
  useEffect(() => {
    if (selected && "applicationVersion" in selected && selected.status !== "pending" && reason) {
      setReason(""); setConflict(false);
    }
  }, [selected, reason]);
  function clearSelection() {
    if (teachers) setSelectedIdState(null);
    else updateQuery({ user: null });
    setAcknowledgedVersion(null); setReason(""); setConflict(false);
  }
  function selectRow(row: IdentityAdminUser | IdentityTeacherApplication, trigger?: HTMLButtonElement | null) {
    if (!teachers && trigger) selectedTriggerRef.current = trigger;
    if (selectedId !== row.id) setReason("");
    if (teachers) setSelectedIdState(row.id);
    else updateQuery({ user: row.id });
    setAcknowledgedVersion(recordVersion(row)); setConflict(false); setFeedback("");
  }
  function closeDetail() {
    clearSelection();
    const trigger = selectedTriggerRef.current;
    selectedTriggerRef.current = null;
    window.requestAnimationFrame(() => trigger?.focus());
  }
  const currentPageUsers = !teachers && data ? data.items.filter(isIdentityUser) : [];
  const enabledOnPage = currentPageUsers.filter((row) => row.status === "enabled").length;
  const disabledOnPage = currentPageUsers.filter((row) => row.status === "disabled").length;
  const unverifiedOnPage = currentPageUsers.filter((row) => !row.schoolEmailVerified).length;
  const activeFilters = !teachers ? ([
    ["q", "搜索", query.get("q")],
    ["college", "学院", query.get("college")],
    ["role", "角色", query.get("role") ? roleLabel(query.get("role")!) : null],
    ["status", "状态", query.get("status") ? accountStatusLabel(query.get("status")!) : null],
  ] as const).filter(([, , value]) => value) : [];
  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || locked.current) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "").trim();
    const teacher = value("identity") === "teacher";
    locked.current = true; setPending(true); setFeedback(""); setCreateFieldErrors({});
    try {
      await cIdentityClient.create({
        identity: teacher ? "teacher" : "student", submitForReview: teacher || undefined,
        name: value("name"), username: value("username"), schoolEmail: value("schoolEmail"),
        studentId: value("studentId") || undefined, college: value("college") || undefined,
      }, userId);
      setCreating(false); setCreateFieldErrors({}); setFeedback(teacher
        ? "账号已创建，教师申请已提交审核。审核通过后获得教师权限。"
        : "账号已创建。本人可用学校邮箱通过“忘记密码”设置登录密码。");
      await result.refetch();
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        setAccessBlocked(true); setCreating(false); clearSelection();
      }
      setCreateFieldErrors(error instanceof ApiError ? Object.fromEntries(Object.entries(error.fieldErrors).map(([key, value]) => [key, String(value)])) : {});
      setFeedback(error instanceof ApiError && error.status === 409 ? "用户名或学校邮箱已登记，请核对后再提交。" : message(error, "form"));
    } finally { locked.current = false; setPending(false); }
  }
  async function decide(decision: "approve" | "reject" | "disable" | "enable") {
    if (!selected || !reason.trim() || locked.current || conflict || selectionChanged) return;
    locked.current = true; setPending(true); setFeedback("");
    try {
      let saved = "决定已保存。";
      if (decision === "disable" && "canDisable" in selected) {
        const receipt = await cIdentityClient.disable(selected, reason.trim(), userId);
        if (receipt.inboxNotified === true) saved = "账号已停用，停用原因已写入该账号的站内收件箱。";
        if (receipt.inboxNotified === false) saved = "账号已停用，站内通知服务尚未接入。";
      } else if (decision === "enable" && "canDisable" in selected && selected.status === "disabled") {
        await cIdentityClient.enable(selected, reason.trim(), userId);
        saved = "账号已恢复，可重新登录。";
      } else if ((decision === "approve" || decision === "reject") && "applicationVersion" in selected && selected.status === "pending") await cIdentityClient.review(selected, decision, reason.trim(), userId);
      else return;
      clearSelection(); setFeedback(saved); await result.refetch();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        clearSelection();
        setFeedback("这条记录已不存在，详情已关闭。");
        await result.refetch();
      } else {
        setFeedback(message(error));
        if (error instanceof ApiError && error.status === 409) setConflict(true);
        if (error instanceof ApiError && [401, 403].includes(error.status)) { setAccessBlocked(true); clearSelection(); }
      }
    } finally { locked.current = false; setPending(false); }
  }
  async function refresh() {
    if (accessBlocked) {
      try {
        const session = await authClient.session();
        if (!session.authenticated || session.user?.id !== userId) { window.location.reload(); return; }
      } catch { setFeedback("暂时无法验证登录状态，请重新登录后再试。"); return; }
    }
    const response = await result.refetch();
    if (response.isSuccess) {
      setAccessBlocked(false);
      const latest = response.data.items.find((row) => row.id === selectedId);
      setAcknowledgedVersion(latest ? recordVersion(latest) : null);
      setConflict(false);
      setFeedback(selected ? "已刷新记录，请核对后重新确认。处理原因已保留。" : "");
    }
  }
  return <div className={`${styles.page} ${styles.identityPage}`}>
    <PageHeader title={teachers ? "教师审核" : "用户管理"} description={teachers ? "审核待处理申请，查询已保存的审核结果与原因。" : "创建学生或教师账号，管理账号的停用与恢复。"} actions={!teachers && <div className={styles.identityHeaderActions}><button type="button" className={buttonControl} disabled={pending || result.isFetching} onClick={() => void refresh()}>刷新列表</button><button type="button" className={`${buttonControl} ${styles.primaryButton}`} disabled={pending} aria-expanded={creating} onClick={() => { setCreating(!creating); setCreateFieldErrors({}); setFeedback(""); }}>{creating ? "取消新增" : "新增账号"}</button></div>} />
    {teachers && <section className={styles.toolbarPanel}><form className={styles.toolbar} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); updateQuery({ status: String(form.get("status")), page: null }); }}><label className={styles.fieldInline}>审核状态<select className={`${inputControl} block`} name="status" defaultValue={applicationStatus} disabled={pending}>{Object.entries(applicationStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className={buttonControl} disabled={pending}>筛选申请</button></form></section>}
    {!teachers && creating && <form className={`${styles.formGrid} ${styles.identityCreateForm}`} onSubmit={createAccount}>
      <label className={styles.field}>身份<select className={inputControl} name="identity" aria-label="身份" disabled={pending}><option value="student">学生</option><option value="teacher">教师</option></select></label>
      {([["name", "姓名", 120], ["username", "用户名", 80], ["schoolEmail", "学校邮箱", 255], ["studentId", "学号（选填）", 80], ["college", "学院（选填）", 160]] as const).map(([key, label, length]) => {
        const fieldId = `identity-create-${key}`;
        const fieldError = createFieldErrors[key];
        return <div className={styles.field} key={key}><label htmlFor={fieldId}>{label}</label><input id={fieldId} className={inputControl} name={key} type={key === "schoolEmail" ? "email" : "text"} required={["name", "username", "schoolEmail"].includes(key)} maxLength={length} disabled={pending} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? `${fieldId}-error` : undefined} />{fieldError && <span id={`${fieldId}-error`} className={styles.fieldError} data-field-error={key} role="alert">{fieldError}</span>}</div>;
      })}
      <button className={`${buttonControl} ${styles.identityCreateSubmit}`} disabled={pending}>确认创建</button>
      <p className={`${styles.fieldHint} ${styles.identityFormHint}`}>创建前请核对身份和学校邮箱。教师申请将进入审核列表。本人可用学校邮箱通过“忘记密码”设置密码。</p>
    </form>}
    {!teachers && <form className={`${styles.toolbarPanel} ${styles.toolbar} ${styles.identityUserFilters}`} key={query.toString()} onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      updateQuery(Object.fromEntries(["q", "role", "status", "college"].map((key) => [key, String(form.get(key) || "") || null]).concat([["page", null], ["user", null]])));
    }}>
      <label className={styles.field}><span>搜索用户</span><input className={inputControl} name="q" aria-label="姓名、邮箱或学号" placeholder="姓名、邮箱或学号" defaultValue={query.get("q") ?? ""} /></label>
      <label className={styles.field}><span>学院</span><input className={inputControl} name="college" aria-label="学院" placeholder="学院" defaultValue={query.get("college") ?? ""} /></label>
      <label className={styles.field}><span>角色</span><select className={inputControl} name="role" aria-label="角色" defaultValue={query.get("role") ?? ""}><option value="">全部角色</option>{["student", "teacher", "ta", "admin", "leader"].map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <label className={styles.field}><span>账号状态</span><select className={inputControl} name="status" aria-label="账号状态" defaultValue={query.get("status") ?? ""}><option value="">全部状态</option><option value="enabled">可用</option><option value="disabled">已停用</option></select></label>
      <div className={styles.identityFilterActions}><button className={`${buttonControl} ${styles.primaryButton}`}>查询</button><button type="button" className={buttonControl} onClick={() => updateQuery({ q: null, college: null, role: null, status: null, page: null, user: null })}>重置筛选</button></div>
      <div className={styles.identityQuickFilters} role="group" aria-label="快捷状态筛选">{[["", "全部"], ["enabled", "可用"], ["disabled", "已停用"]].map(([value, label]) => <button key={value || "all"} type="button" className={styles.identityQuickFilter} aria-pressed={(query.get("status") ?? "") === value} onClick={() => updateQuery({ status: value || null, page: null, user: null })}>{label}</button>)}</div>
    </form>}
    {!teachers && activeFilters.length > 0 && <div className={styles.identityFilterChips} aria-label="已生效筛选">{activeFilters.map(([key, label, value]) => <button type="button" className={styles.identityFilterChip} key={key} onClick={() => updateQuery({ [key]: null, page: null, user: null })}>{label}：{value}<span aria-hidden="true">×</span></button>)}</div>}
    {teachers && <div className={styles.identityToolbarFooter}><button className={`${buttonControl} mb-4`} type="button" disabled={pending || result.isFetching} onClick={() => void refresh()}>刷新列表</button><span className={styles.muted}>数据来自当前环境的身份服务</span></div>}
    {result.isFetching && <p role="status" className={styles.identityLoading}>正在读取…</p>}
    {result.isError && <div role="alert" className={styles.identityError}><p>{message(result.error, "read")}</p><button type="button" className={buttonControl} disabled={pending || result.isFetching} onClick={() => void refresh()}>重试</button></div>}
    {feedback && <p role="status" className="mb-4">{feedback}</p>}
    {!teachers && data && <div className={styles.identitySummary} aria-label="用户目录摘要"><div className={styles.identitySummaryCard}><span>结果总数</span><strong>{data.total}</strong><small>当前筛选结果</small></div><div className={styles.identitySummaryCard}><span>当前页可用</span><strong>{enabledOnPage}</strong><small>本页账号</small></div><div className={styles.identitySummaryCard}><span>当前页已停用</span><strong>{disabledOnPage}</strong><small>本页账号</small></div><div className={styles.identitySummaryCard}><span>当前页待验证</span><strong>{unverifiedOnPage}</strong><small>学校邮箱</small></div></div>}
    {data && <Panel className={styles.identityTablePanel}><>{!teachers ? <div className={styles.identityTableWrap}><table className={styles.identityTable}><thead><tr><th scope="col">用户</th><th scope="col">学院</th><th scope="col">角色</th><th scope="col">账号状态</th><th scope="col">学校邮箱</th><th scope="col">操作</th></tr></thead><tbody>{data.items.map((row) => { const user = isIdentityUser(row) ? row : null; const application = !user && "applicationVersion" in row ? row : null; return <tr key={row.id} aria-selected={selectedId === row.id}><td><div className={styles.identityUserCell}><span className={styles.identityAvatar} aria-hidden="true">{row.name.slice(0, 1) || "?"}</span><div><strong>{row.name}</strong>{user && <small>{user.studentId || "未填写学号"}</small>}</div></div></td><td>{row.college || "未填写"}</td><td>{user ? <div className={styles.identityBadgeGroup}>{user.roles.length ? user.roles.map((role) => <span className={styles.identityBadge} data-identity-role={role} key={role}>{roleLabel(role)}</span>) : <span className={styles.identityBadge}>未分配</span>}</div> : application ? <span className={styles.identityBadge}>{applicationStatuses[application.status]}</span> : "—"}</td><td>{user ? <span className={styles.identityBadge} data-identity-status={user.status}>{accountStatusLabel(user.status)}</span> : "—"}</td><td>{user ? <div className={styles.identityEmailCell}><span>{user.schoolEmail || "未绑定"}</span><span className={styles.identityBadge} data-identity-email-status={user.schoolEmailVerified ? "verified" : "unverified"}>{emailStatusLabel(user.schoolEmailVerified)}</span></div> : "—"}</td><td><button className={buttonControl} disabled={pending || ((conflict || selectionChanged) && selectedId === row.id)} onClick={(event) => selectRow(row, event.currentTarget)}>查看</button></td></tr>; })}</tbody></table>{!data.items.length && <EmptyState title="没有符合条件的记录" />}</div> : <div className={styles.identityRows}>{data.items.length ? data.items.map((row) => <article key={row.id} className={styles.identityRow}><div><strong>{row.name}</strong><p className="text-sm text-slate-600">{row.college} · {"roles" in row ? row.roles.map(roleLabel).join("、") : `${applicationStatuses[row.status]} · 当前邮箱：${row.emailDomain || "未绑定"} · ${row.emailVerified ? "已验证" : "未验证"}`}</p></div><button className={buttonControl} disabled={pending || ((conflict || selectionChanged) && selectedId === row.id)} onClick={(event) => selectRow(row, event.currentTarget)}>查看</button></article>) : <EmptyState title="没有符合条件的记录" />}</div>}</><div className={styles.tableFooter}><span>共 {data.total} 条 · 第 {data.page} 页</span><div className={styles.actions}><button className={buttonControl} disabled={page <= 1 || pending} onClick={() => { clearSelection(); updateQuery({ page: String(page - 1) }); }}>上一页</button><button className={buttonControl} disabled={page * data.pageSize >= data.total || pending} onClick={() => { clearSelection(); updateQuery({ page: String(page + 1) }); }}>下一页</button></div></div></Panel>}
    {teachers && selected && <Panel title={selected.name} className={`${styles.identityDetailPanel} mt-4`}>
      {"schoolEmail" in selected && <p>{selected.schoolEmail ?? "尚未验证学校邮箱"} · {selected.studentId ?? "无学号"}</p>}
      {"applicationVersion" in selected && <div className="space-y-3"><div><h3 className="font-semibold">提交时的申请资料</h3><p>姓名：{selected.submittedName ?? "未记录"}</p><p>申请身份：{selected.submittedIdentity === "teacher" ? "教师" : selected.submittedIdentity === "student" ? "学生" : "未记录"}</p><p>学校邮箱域：{selected.submittedEmailDomain ?? "未记录"}</p><p>申请版本：{selected.applicationVersion} · 提交时间：{formatDate(selected.createdAt)}</p></div><div><h3 className="font-semibold">当前账号资料</h3><p>姓名：{selected.name}</p><p>当前学校邮箱域：{selected.emailDomain || "未绑定"} · {selected.emailVerified ? "已验证" : "未验证"}</p>{!selected.emailVerified && <p className={styles.identityActionHint}>学校邮箱尚未验证，验证后才能通过审核。</p>}<p className="text-sm text-slate-600">当前资料可能已变化，不代表提交或审核时的资料。</p></div>{selected.status !== "pending" && <div><h3 className="font-semibold">已保存的审核结果：{applicationStatuses[selected.status]}</h3><p>审核时间：{selected.reviewedAt ? formatDate(selected.reviewedAt) : "未记录"}</p><p>审核人（当前姓名）：{selected.reviewerName ?? "未记录或账号已不存在"}</p><p className="whitespace-pre-wrap">审核原因：{selected.reviewReason ?? "未记录"}</p><p className="text-sm text-slate-600">此记录只读；结果取自当时保存的审核决定，不根据当前账号角色推断。</p></div>}</div>}
      {selectionChanged && <p role="alert">此记录已被其他人修改，请刷新列表并核对后再提交；处理原因已保留。</p>}
      {("canDisable" in selected || selected.status === "pending") && <><label className={`${styles.field} my-3`}>处理原因<textarea className={`${inputControl} mt-1 block w-full`} aria-label="处理原因" value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)} maxLength={2000} /></label><div className={styles.actions}>{"canDisable" in selected ? <button className={buttonControl} disabled={pending || conflict || selectionChanged || !reason.trim() || (selected.status !== "disabled" && !selected.canDisable)} onClick={() => void decide(selected.status === "disabled" ? "enable" : "disable")}>{selected.status === "disabled" ? "确认恢复" : "确认停用"}</button> : <><button className={buttonControl} disabled={pending || conflict || selectionChanged || !reason.trim() || !selected.emailVerified} onClick={() => void decide("approve")}>通过</button><button className={buttonControl} disabled={pending || conflict || selectionChanged || !reason.trim()} onClick={() => void decide("reject")}>拒绝</button></>}</div></>}
      <button className={`${buttonControl} mt-3`} disabled={pending} onClick={clearSelection}>取消</button>
    </Panel>}
    {!teachers && <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) closeDetail(); }}>
      <SheetContent className={styles.identityDrawer} aria-describedby="identity-drawer-description" aria-modal="true">
        {selected && <div className={styles.identityDrawerBody}>
          <div className={styles.identityDrawerHeader}>
            <div className={styles.identityDrawerHeading}><SheetTitle className={styles.identityDrawerTitle}>{selected.name}</SheetTitle><SheetDescription id="identity-drawer-description">用户账号详情 · {selected.college || "未填写学院"}</SheetDescription></div>
            <button type="button" className={buttonControl} disabled={pending || result.isFetching} onClick={() => void refresh()}>刷新列表</button>
            <div className={styles.identityBadgeGroup}>{"roles" in selected && selected.roles.map((role) => <span className={styles.identityBadge} key={role}>{roleLabel(role)}</span>)}{"status" in selected && <span className={styles.identityBadge} data-identity-status={selected.status}>{accountStatusLabel(selected.status)}</span>}</div>
          </div>
          <div className={styles.identityDrawerContent}>
            {"schoolEmail" in selected && <div className={styles.identityDetailIntro}><strong>账号资料</strong><p>{selected.schoolEmail || "尚未绑定学校邮箱"}</p><p>{selected.studentId || "未填写学号"}</p></div>}
            {selectionChanged && <p role="alert">此记录已被其他人修改，请刷新列表并核对后再提交；处理原因已保留。</p>}
            {"canDisable" in selected && <><div className={styles.identityDetailIntro}><strong>账号状态</strong><p>{selected.canDisable ? "当前账号可停用" : selected.status === "disabled" ? "当前账号已停用，可恢复" : "当前账号暂不可停用"}</p></div><label className={styles.field}>处理原因<textarea className={`${inputControl} mt-1 block w-full`} aria-label="处理原因" value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)} maxLength={2000} placeholder="说明本次停用或恢复的依据" /></label><div className={styles.actions}><button className={`${buttonControl} ${styles.primaryButton}`} disabled={pending || conflict || selectionChanged || !reason.trim() || (selected.status !== "disabled" && !selected.canDisable)} onClick={() => void decide(selected.status === "disabled" ? "enable" : "disable")}>{selected.status === "disabled" ? "确认恢复" : "确认停用"}</button></div></>}
          </div>
          <div className={styles.identityDrawerFooter}><button className={buttonControl} disabled={pending} onClick={closeDetail}>取消</button></div>
        </div>}
      </SheetContent>
    </Sheet>}
  </div>;
}
