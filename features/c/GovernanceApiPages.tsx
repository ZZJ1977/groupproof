"use client";

import { cloneElement, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CApiError, createCClient } from "@/lib/api/c-client";
import { createGovernanceClient, type AccessQuery, type AuditQuery, type CourseQuery, type UsageQuery } from "@/lib/api/c-governance-client";
import { useWorkspace } from "@/lib/workspace";
import type { components } from "@/packages/domain/api.generated";
import { Box, Empty, Header, Notice, Table, formatDateTime } from "@/features/governance/primitives";
import styles from "@/features/governance/governance.module.css";
import { useUrlQuery } from "./use-url-query";

type Schema = components["schemas"];
const api = createGovernanceClient();
const directory = createCClient();
const querySettings = { staleTime: 0, gcTime: 0, retry: false } as const;
const courseStatuses = { draft: "草稿", active: "已发布", ended: "已结束" } as const;
const requestStatuses = { pending: "待审批", approved: "已批准", rejected: "已拒绝" } as const;
const auditRoles = { student: "学生", leader: "组长", teacher: "教师", ta: "助教", admin: "管理员", system: "系统" } as const;
const targetTypes = { user: "用户", course: "课程", project: "项目", task: "任务", evidence: "证据", system: "系统" } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function selected(value: string | null) { return value && uuid.test(value) ? value : undefined; }
function pageNumber(value: string | null) { const n = Number(value ?? 1); return Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1; }
function choice<T extends string>(value: string | null, choices: Record<T, string>): T | undefined { return value && Object.hasOwn(choices, value) ? value as T : undefined; }
function inputValue(form: FormData, key: string) { return String(form.get(key) ?? "").trim(); }
function localTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function isoTime(value: string) { const date = new Date(value); return value && !Number.isNaN(date.valueOf()) ? date.toISOString() : undefined; }
function useExpiredAt(value: string | undefined) {
  const deadline = value ? Date.parse(value) : NaN;
  const [checkedAt, setCheckedAt] = useState(Date.now);
  const expired = Number.isFinite(deadline) && deadline <= Math.max(checkedAt, Date.now());
  useEffect(() => {
    if (!Number.isFinite(deadline) || expired) return;
    // Long deadlines are checked in bounded intervals; an open form also expires on time.
    const timer = window.setTimeout(() => setCheckedAt(Date.now()), Math.min(deadline - Date.now() + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [deadline, expired, checkedAt]);
  return expired;
}

function message(error: Error | null) {
  if (error instanceof CApiError) {
    const text = error.status === 401 ? "需要有效的管理员登录身份。"
      : error.status === 403 ? "当前账户无权执行此操作。"
        : error.status === 409 && error.code === "VERSION_CONFLICT" ? "记录已变更。请刷新详情后核对，再次提交；填写的理由已保留。"
          : error.status === 503 ? "所需服务尚不可用，请稍后重试。" : error.message;
    return `${text}${error.requestId ? `（请求编号：${error.requestId}）` : ""}`;
  }
  return error?.message || "服务暂不可用，请重试。";
}
function ErrorBox({ error, retry, label = "重试" }: { error: Error | null; retry?: () => void; label?: string }) {
  return error ? <div role="alert"><p>{message(error)}</p>{retry && <button className={styles.button} type="button" onClick={retry}>{label}</button>}</div> : null;
}
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  // Keep the label text separate from textarea content and select options.
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}
function Pager({ page, total, change }: { page: number; total: number; change: (page: number) => void }) {
  return <div className={styles.tableFooter}><span>共 {total} 条 · 第 {page} 页</span><div className={styles.actions}><button className={styles.button} type="button" disabled={page <= 1} onClick={() => change(page - 1)}>上一页</button><button className={styles.button} type="button" disabled={page * 10 >= total} onClick={() => change(page + 1)}>下一页</button></div></div>;
}
function History({ items }: { items: Schema["GovernanceHistoryDTO"][] }) {
  return <><h3>操作历史</h3>{!items.length ? <Empty>暂无操作历史</Empty> : <ol>{items.map((item) => <li key={item.id}><strong>{item.action} · 版本 {item.version_no}</strong><p>{item.reason}</p><small>{formatDateTime(item.created_at)} · 操作人 {item.actor_id}</small></li>)}</ol>}</>;
}

/** A synchronous gate closes the double-click gap; retries preserve the original key. */
function unauthorized(error: unknown): error is CApiError { return error instanceof CApiError && (error.status === 401 || error.status === 403); }
function useCommand(onUnauthorized?: (error: CApiError) => void) {
  const active = useRef(false);
  const prior = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [failedAt, setFailedAt] = useState(0);
  async function run<T>(body: unknown, invoke: (key: string) => Promise<T>, success: (result: T) => void) {
    if (active.current) return;
    active.current = true; setBusy(true); setError(null);
    const fingerprint = JSON.stringify(body);
    if (prior.current?.fingerprint !== fingerprint) prior.current = { fingerprint, key: crypto.randomUUID() };
    try { const result = await invoke(prior.current.key); prior.current = null; success(result); }
    catch (caught) { setError(caught instanceof Error ? caught : new Error("网络请求失败，请重试。")); setFailedAt(Date.now()); if (unauthorized(caught)) onUnauthorized?.(caught); }
    finally { active.current = false; setBusy(false); }
  }
  function reset() {
    if (active.current) return;
    prior.current = null; setError(null); setFailedAt(0);
  }
  return { busy, error, failedAt, run, reset };
}

function conflictNeedsRefresh(command: ReturnType<typeof useCommand>, dataUpdatedAt: number) {
  return command.error instanceof CApiError && command.error.code === "VERSION_CONFLICT" && dataUpdatedAt <= command.failedAt;
}

/** Options come only from the canonical Admin directory, with explicit search/paging. */
function UserSelect({ label, value, onChange, teacherOnly = false, required = false, onUnauthorized }: {
  label: string; value: string; onChange: (value: string) => void; teacherOnly?: boolean; required?: boolean; onUnauthorized?: (error: CApiError) => void;
}) {
  const { userId } = useWorkspace();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = { page, page_size: 10, q: search || undefined, ...(teacherOnly ? { role: "teacher" as const, status: "active" as const } : {}) };
  const list = useQuery({ queryKey: ["c-governance-users", userId, query], queryFn: async () => { try { return await directory.adminUsers(query); } catch (error) { if (unauthorized(error)) onUnauthorized?.(error); throw error; } }, ...querySettings });
  const options = list.isSuccess && !list.isFetching ? list.data.items.filter((item) => !teacherOnly || item.email_verified) : [];
  const selectedUser = useQuery({ queryKey: ["c-governance-selected-user", userId, value], queryFn: async () => { try { return await directory.adminUser(value); } catch (error) { if (unauthorized(error)) onUnauthorized?.(error); throw error; } }, enabled: Boolean(value) && list.isSuccess && !list.isFetching, ...querySettings });
  const retained = list.isSuccess && !list.isFetching && selectedUser.isSuccess && !selectedUser.isFetching && selectedUser.data.id === value
    && (!teacherOnly || (selectedUser.data.global_role === "teacher" && selectedUser.data.status === "active" && selectedUser.data.email_verified)) ? selectedUser.data : undefined;
  const combined = retained && !options.some((item) => item.id === retained.id) ? [retained, ...options] : options;
  return <div className={styles.stack}>
    <Field label={`${label}搜索`}><input className={styles.input} type="search" maxLength={200} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></Field>
    <Field label={label}><select className={styles.select} aria-label={label} value={combined.some((item) => item.id === value) ? value : ""} required={required} disabled={list.isFetching || list.isError} onChange={(event) => onChange(event.target.value)}><option value="">{required ? "请选择有效教师" : "全部用户"}</option>{combined.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.email}</option>)}</select></Field>
    {list.isError && <ErrorBox error={list.error} retry={() => void list.refetch()} label="重试用户目录" />}
    {list.isFetching && <p role="status">正在读取用户选项…</p>}
    {list.isSuccess && !list.isFetching && <><small>{teacherOnly ? "仅可选择已验证邮箱的有效教师。" : "搜索后选择已有用户。"}{!options.length && "当前查询没有可选用户。"}</small><div className={styles.actions}><button type="button" className={styles.button} disabled={page === 1} onClick={() => setPage(page - 1)}>用户上一页</button><span>用户第 {page} 页</span><button type="button" className={styles.button} disabled={page * 10 >= list.data.total} onClick={() => setPage(page + 1)}>用户下一页</button></div></>}
  </div>;
}

function CourseCreate({ onCreated, onUnauthorized, canSubmit }: { onCreated: (course: Schema["CourseDetailDTO"]) => void; onUnauthorized: (error: CApiError) => void; canSubmit: boolean }) {
  const [owner, setOwner] = useState("");
  const command = useCommand(onUnauthorized);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const input = new FormData(event.currentTarget);
    const projectDeadline = isoTime(inputValue(input, "project_deadline"));
    if (!canSubmit || !owner || !projectDeadline) return;
    const body: Schema["CreateCourse"] = { code: inputValue(input, "code"), name: inputValue(input, "name"), college: inputValue(input, "college"), semester: inputValue(input, "semester"), owner_id: owner,
      reason: inputValue(input, "reason"), project_deadline: projectDeadline, formation_deadline: isoTime(inputValue(input, "formation_deadline")) ?? null,
      grouping_mode: inputValue(input, "grouping_mode") === "approval" ? "approval" : "free", min_group_size: Number(input.get("min_group_size")), max_group_size: Number(input.get("max_group_size")) };
    void command.run(body, (key) => api.createCourse(body, key), onCreated);
  }
  return <Box title="创建课程草稿"><form className={styles.panelBody} onSubmit={submit}><fieldset disabled={command.busy || !canSubmit} className={styles.stack}>
    <div className={styles.formGrid}>{[["code", "课程编号", 64], ["name", "课程名称", 200], ["college", "学院", 160], ["semester", "学期", 64]].map(([name, label, max]) => <Field key={name} label={String(label)}><input className={styles.input} name={String(name)} maxLength={Number(max)} required pattern={name === "code" ? "[A-Za-z0-9][A-Za-z0-9_-]*" : undefined} /></Field>)}</div>
    <UserSelect label="负责教师" value={owner} onChange={setOwner} teacherOnly required onUnauthorized={onUnauthorized} />
    <div className={styles.formGrid}><Field label="项目截止时间"><input className={styles.input} type="datetime-local" name="project_deadline" required /></Field><Field label="组队截止时间"><input className={styles.input} type="datetime-local" name="formation_deadline" /></Field>
      <Field label="组队方式"><select className={styles.select} name="grouping_mode" aria-label="组队方式"><option value="free">自由组队</option><option value="approval">审批组队</option></select></Field>
      <Field label="最少组员"><input className={styles.input} type="number" name="min_group_size" min={1} max={32767} defaultValue={1} required /></Field><Field label="最多组员"><input className={styles.input} type="number" name="max_group_size" min={1} max={32767} defaultValue={8} required /></Field></div>
    <Field label="创建理由"><textarea className={styles.textarea} name="reason" maxLength={2000} required /></Field><button className={styles.primaryButton} type="submit" disabled={!owner || command.busy}>{command.busy ? "正在创建…" : "创建草稿"}</button>
  </fieldset><ErrorBox error={command.error} /></form></Box>;
}

function CoursePanel({ id, onChanged, close, onUnauthorized }: { id: string; onChanged: () => void; close: () => void; onUnauthorized: (error: CApiError) => void }) {
  const { userId } = useWorkspace(); const cache = useQueryClient();
  const detail = useQuery({ queryKey: ["c-governance-course", userId, id], queryFn: async () => { try { return await api.course(id); } catch (error) { if (unauthorized(error)) onUnauthorized(error); throw error; } }, ...querySettings });
  const data = detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const [reason, setReason] = useState(""); const command = useCommand(onUnauthorized);
  const [initialized, setInitialized] = useState(false);
  const [intent, setIntent] = useState<Pick<Schema["TransitionCourse"], "action" | "expected_version"> | null>(null);
  const [notice, setNotice] = useState("");
  const currentAction = data?.status === "draft" ? "publish" : data?.status === "active" ? "end" : null;
  if (!initialized && data) {
    setInitialized(true);
    if (currentAction) setIntent({ action: currentAction, expected_version: data.lock_version });
  }
  const changed = Boolean(data && intent && (intent.action !== currentAction || intent.expected_version !== data.lock_version));
  async function refresh() {
    const latest = await detail.refetch();
    if (!latest.isSuccess || !intent) return;
    const action = latest.data.status === "draft" ? "publish" : latest.data.status === "active" ? "end" : null;
    if (action === intent.action) {
      setIntent({ ...intent, expected_version: latest.data.lock_version });
      setNotice("最新课程设置已读取，理由已保留；请核对后重新确认。");
    } else {
      setIntent(null); setReason(""); command.reset();
      setNotice(latest.data.status === "active" ? "课程已经发布，原发布确认已关闭。若需结束课程，请开始新的结束确认。" : "课程已经结束，原操作确认已关闭。");
    }
  }
  function beginNextAction() {
    if (!data || !currentAction || command.busy) return;
    setReason(""); setNotice(""); command.reset();
    setIntent({ action: currentAction, expected_version: data.lock_version });
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!data || !intent || changed || !reason.trim() || conflictNeedsRefresh(command, detail.dataUpdatedAt)) return;
    const body: Schema["TransitionCourse"] = { ...intent, reason: reason.trim() };
    void command.run(body, (key) => api.transitionCourse(id, body, key), (result) => {
      cache.setQueryData(["c-governance-course", userId, id], result); setReason(""); setIntent(null);
      setNotice(body.action === "publish" ? "发布已保存。如需结束课程，请开始新的结束确认。" : "课程结束操作已保存。"); onChanged();
    });
  }
  return <Box title="课程详情" action={<button type="button" className={styles.button} onClick={close}>关闭详情</button>}><div className={styles.panelBody}>
    <button className={styles.button} type="button" disabled={command.busy || detail.isFetching} onClick={() => void refresh()}>刷新详情</button>
    {detail.isFetching && <p role="status">正在读取课程详情…</p>}<ErrorBox error={detail.error} />
    {data && <><h3>{data.name}</h3><p>{data.code} · {data.semester} · {courseStatuses[data.status]} · 版本 {data.lock_version}</p><p>负责教师：{data.owner_id} · 项目截止：{formatDateTime(data.project_deadline ?? undefined)}</p>
      <p>组队方式：{data.grouping_mode === "free" ? "自由组队" : "审批组队"} · 组员人数：{data.min_group_size}–{data.max_group_size} · 组队截止：{formatDateTime(data.formation_deadline ?? undefined)}</p>
      {data.invite_code && <Notice>课程邀请码：<strong>{data.invite_code}</strong>{data.invite_revoked_at ? "（已撤销）" : "。加入课程流程尚待对接，此处不代表加入操作已可用。"}</Notice>}<History items={data.history} /></>}
    {changed && <Notice>课程状态或版本已变化，当前操作已暂停。请刷新详情并核对；填写的理由已保留。</Notice>}
    {notice && <Notice>{notice}</Notice>}
    {intent && <form className={styles.stack} onSubmit={submit}><Field label="变更理由"><textarea className={styles.textarea} required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={command.busy} /></Field>
      <Notice>{intent.action === "publish" ? "发布会激活课程并生成唯一邀请码，请确认课程设置。" : "结束后课程将停止活动，邀请码会撤销。"}</Notice>
      <button className={styles.primaryButton} type="submit" disabled={!data || changed || command.busy || !reason.trim() || conflictNeedsRefresh(command, detail.dataUpdatedAt)}>{command.busy ? "正在提交…" : intent.action === "end" ? "确认结束课程" : "确认发布课程"}</button></form>}
    {!intent && data && currentAction && <button className={styles.button} type="button" disabled={command.busy} onClick={beginNextAction}>{currentAction === "end" ? "开始结束确认" : "开始发布确认"}</button>}
    <ErrorBox error={command.error} />
  </div></Box>;
}

function CoursesPage() {
  const { userId } = useWorkspace(); const cache = useQueryClient(); const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  const page = pageNumber(query.get("page")); const status = choice(query.get("status"), courseStatuses);
  const filters: CourseQuery = { page, page_size: 10, q: query.get("q") || undefined, semester: query.get("semester") || undefined, status };
  const list = useQuery({ queryKey: ["c-governance-courses", userId, filters], queryFn: () => api.courses(filters), enabled: !denied, ...querySettings });
  const result = !denied && list.isSuccess && !list.isFetching ? list.data : undefined; const id = selected(query.get("course"));
  const refresh = () => { void list.refetch().then((current) => { if (current.isSuccess) setDenied(null); }); };
  const changed = () => { void cache.invalidateQueries({ queryKey: ["c-governance-courses", userId] }); };
  return <><Header title="课程管理" description="管理课程草稿、发布和结束，操作需要填写理由，并记录历史。" action={<button type="button" className={styles.button} onClick={refresh}>刷新课程</button>} />
    <form key={query.toString()} className={styles.filters} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); updateQuery({ q: inputValue(input, "q") || null, semester: inputValue(input, "semester") || null, status: inputValue(input, "status") || null, page: null, course: null }); }}>
      <Field label="搜索课程"><input className={styles.input} name="q" maxLength={200} defaultValue={filters.q ?? ""} /></Field><Field label="筛选学期"><input className={styles.input} name="semester" maxLength={64} defaultValue={filters.semester ?? ""} /></Field><Field label="课程状态"><select className={styles.select} name="status" aria-label="课程状态" defaultValue={status ?? ""}><option value="">全部</option>{Object.entries(courseStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><button type="submit" className={styles.primaryButton}>查询课程</button><button type="button" className={styles.button} onClick={() => updateQuery({ q: null, semester: null, status: null, page: null, course: null })}>重置</button>
    </form>{list.isFetching && <p role="status">正在读取课程…</p>}<ErrorBox error={denied ?? list.error} retry={refresh} />
    {result && <><Box><Table><thead><tr><th>课程编号</th><th>名称</th><th>学院 / 学期</th><th>状态</th><th>操作</th></tr></thead><tbody>{result.items.map((item) => <tr key={item.id}><td>{item.code}</td><td>{item.name}</td><td>{item.college} / {item.semester}</td><td>{courseStatuses[item.status]}</td><td><button type="button" className={styles.button} onClick={() => updateQuery({ course: item.id, create: null })}>查看课程</button></td></tr>)}</tbody></Table>{!result.items.length && <Empty />}<Pager page={page} total={result.total} change={(next) => updateQuery({ page: String(next), course: null })} /></Box>
      <button type="button" className={styles.button} onClick={() => updateQuery({ create: query.get("create") === "1" ? null : "1", course: null })}>{query.get("create") === "1" ? "收起创建表单" : "新建课程"}</button>
    </>}
    {!denied && !unauthorized(list.error) && query.get("create") === "1" && <div hidden={!result}><CourseCreate key={userId} canSubmit={Boolean(result)} onUnauthorized={setDenied} onCreated={(course) => { updateQuery({ course: course.id, create: null, page: null, q: null, semester: null, status: null }); changed(); }} /></div>}
    {!denied && id && !unauthorized(list.error) && <div hidden={!result}><CoursePanel key={`${userId}:${id}`} id={id} onChanged={changed} onUnauthorized={setDenied} close={() => updateQuery({ course: null })} /></div>}
  </>;
}

function AccessPanel({ id, onChanged, close, onUnauthorized }: { id: string; onChanged: () => void; close: () => void; onUnauthorized: (error: CApiError) => void }) {
  const { userId } = useWorkspace(); const cache = useQueryClient(); const command = useCommand(onUnauthorized);
  const detail = useQuery({ queryKey: ["c-governance-request", userId, id], queryFn: async () => { try { return await api.accessRequest(id); } catch (error) { if (unauthorized(error)) onUnauthorized(error); throw error; } }, ...querySettings });
  const data = detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const [reason, setReason] = useState(""); const [expiry, setExpiry] = useState<string | null>(null); const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const requestExpired = useExpiredAt(data?.status === "pending" ? data.requested_expires_at : undefined);
  function submit(event: FormEvent) {
    event.preventDefault(); if (!data || data.status !== "pending") return;
    if (decision === "approved" && Date.parse(data.requested_expires_at) <= Date.now()) return;
    const expires = decision === "approved" ? isoTime(expiry ?? localTime(data.requested_expires_at)) : undefined;
    if (decision === "approved" && !expires) return;
    const body: Schema["DecideAccessRequest"] = { decision, reason: reason.trim(), expected_version: data.lock_version, expires_at: expires ?? null };
    void command.run(body, (key) => api.decideAccess(id, body, key), (result) => { cache.setQueryData(["c-governance-request", userId, id], result); setReason(""); onChanged(); });
  }
  return <Box title="访问申请详情" action={<button className={styles.button} type="button" onClick={close}>关闭详情</button>}><div className={styles.panelBody}>
    <button className={styles.button} type="button" disabled={detail.isFetching || command.busy} onClick={() => void detail.refetch()}>刷新详情</button>{detail.isFetching && <p role="status">正在读取申请详情…</p>}<ErrorBox error={detail.error} />
    {data && <><p>申请人：{data.applicant_id}</p><p>申请理由：{data.reason}</p><p>状态：{requestStatuses[data.status]} · 版本 {data.lock_version}</p><p>访问范围：{targetTypes[data.scope.resource_type]} / {data.scope.resource_id} · 只读 · 所属项目 {data.scope.project_id}</p><p>申请截止：{formatDateTime(data.requested_expires_at)}</p>
      {data.status === "approved" && <Notice>此处显示审批结果；实际访问还需通过权限检查。{data.approval_expired ? "授权期限已过。" : `批准截止：${formatDateTime(data.approved_expires_at ?? undefined)}`}</Notice>}<History items={data.history} /></>}
    {requestExpired && <Notice>申请期限已过，无法批准；可填写理由拒绝此申请。</Notice>}
    {(!data || data.status === "pending") && <form className={styles.stack} onSubmit={submit}><Field label="审批决定"><select className={styles.select} aria-label="审批决定" value={decision} disabled={command.busy} onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}><option value="approved" disabled={requestExpired}>批准只读访问</option><option value="rejected">拒绝</option></select></Field>
      {decision === "approved" && <><Field label="批准截止时间"><input className={styles.input} type="datetime-local" required value={expiry ?? (data ? localTime(data.requested_expires_at) : "")} max={data ? localTime(data.requested_expires_at) : undefined} disabled={command.busy || requestExpired} onChange={(event) => setExpiry(event.target.value)} /></Field><Notice>当前批准功能需授权服务支持；操作失败时申请会保持待审批。</Notice></>}
      <Field label="审批理由"><textarea className={styles.textarea} required maxLength={2000} value={reason} disabled={command.busy} onChange={(event) => setReason(event.target.value)} /></Field><button className={styles.primaryButton} type="submit" disabled={!data || command.busy || !reason.trim() || (decision === "approved" && requestExpired) || conflictNeedsRefresh(command, detail.dataUpdatedAt)}>{command.busy ? "正在提交…" : "确认审批决定"}</button></form>}
    <ErrorBox error={command.error} />
  </div></Box>;
}

function AccessPage() {
  const { userId } = useWorkspace(); const cache = useQueryClient(); const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  const page = pageNumber(query.get("page")); const status = choice(query.get("status"), requestStatuses);
  const filters: AccessQuery = { page, page_size: 10, status };
  const list = useQuery({ queryKey: ["c-governance-requests", userId, filters], queryFn: () => api.accessRequests(filters), enabled: !denied, ...querySettings });
  const data = !denied && list.isSuccess && !list.isFetching ? list.data : undefined; const id = selected(query.get("request"));
  const refresh = () => { void list.refetch().then((current) => { if (current.isSuccess) setDenied(null); }); };
  return <><Header title="访问审批" description="审批精确的项目、任务或证据只读范围；不会扩大申请范围。" action={<button type="button" className={styles.button} onClick={refresh}>刷新申请</button>} />
    <Field label="申请状态"><select className={styles.select} aria-label="申请状态" value={status ?? ""} onChange={(event) => updateQuery({ status: event.target.value || null, page: null, request: null })}><option value="">全部</option>{Object.entries(requestStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    {list.isFetching && <p role="status">正在读取访问申请…</p>}<ErrorBox error={denied ?? list.error} retry={refresh} />
    {data && <Box><Table><thead><tr><th>申请人</th><th>申请理由</th><th>范围</th><th>状态</th><th>申请截止</th><th>操作</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.applicant_id}</td><td>{item.reason}</td><td>{item.scope.resource_type} · 只读</td><td>{requestStatuses[item.status]}</td><td>{formatDateTime(item.requested_expires_at)}</td><td><button type="button" className={styles.button} onClick={() => updateQuery({ request: item.id })}>查看申请</button></td></tr>)}</tbody></Table>{!data.items.length && <Empty />}<Pager page={page} total={data.total} change={(next) => updateQuery({ page: String(next), request: null })} /></Box>}
    {!denied && id && !unauthorized(list.error) && <div hidden={!data}><AccessPanel key={`${userId}:${id}`} id={id} onUnauthorized={setDenied} close={() => updateQuery({ request: null })} onChanged={() => { void cache.invalidateQueries({ queryKey: ["c-governance-requests", userId] }); }} /></div>}
  </>;
}

function AuditPanel({ id, close }: { id: string; close: () => void }) {
  const { userId } = useWorkspace();
  const detail = useQuery({ queryKey: ["c-governance-audit", userId, id], queryFn: () => api.auditLog(id), ...querySettings });
  return <Box title="日志详情" action={<button type="button" className={styles.button} onClick={close}>关闭详情</button>}><div className={styles.panelBody}>{detail.isFetching && <p role="status">正在读取日志详情…</p>}<ErrorBox error={detail.error} retry={() => void detail.refetch()} label="重试详情" />{detail.isSuccess && !detail.isFetching && <><p>{detail.data.action} · {detail.data.result} · {formatDateTime(detail.data.occurred_at)}</p><p>操作人：{detail.data.actor_id}</p><p>目标：{detail.data.target_type} / {detail.data.target_id ?? "系统"}</p><p>理由：{detail.data.reason}</p><h3>变更前</h3><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(detail.data.before, null, 2)}</pre><h3>变更后</h3><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(detail.data.after, null, 2)}</pre></>}</div></Box>;
}

function LogsPage() {
  const { userId } = useWorkspace(); const { query, updateQuery } = useUrlQuery();
  const page = pageNumber(query.get("page")); const resultFilter = choice(query.get("result"), { success: "成功", failure: "失败" });
  const filters: AuditQuery = { page, page_size: 10, actor_id: selected(query.get("actor")), actor_role: choice(query.get("actor_role"), auditRoles), target_type: choice(query.get("target_type"), targetTypes), target_id: selected(query.get("target_id")), action: query.get("action") || undefined, result: resultFilter, since: isoTime(query.get("since") ?? ""), until: isoTime(query.get("until") ?? "") };
  // Independent actor/page/detail navigation must not remount and erase this draft.
  // Back/Forward or reset still restores the fields when their own URL values change.
  const formKey = JSON.stringify([filters.actor_role, filters.target_type, filters.action, filters.result, filters.since, filters.until]);
  const list = useQuery({ queryKey: ["c-governance-audits", userId, filters], queryFn: () => api.auditLogs(filters), ...querySettings });
  const data = list.isSuccess && !list.isFetching ? list.data : undefined; const id = selected(query.get("log"));
  return <><Header title="系统日志" description="按操作、角色、结果和对象查询操作历史及变更摘要。" action={<button className={styles.button} type="button" onClick={() => void list.refetch()}>刷新日志</button>} />
    <UserSelect label="操作人" value={filters.actor_id ?? ""} onChange={(value) => updateQuery({ actor: value || null, page: null, log: null })} />
    <form key={formKey} className={styles.filters} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); const targetType = inputValue(input, "target_type"); updateQuery({ action: inputValue(input, "action") || null, actor_role: inputValue(input, "actor_role") || null, target_type: targetType || null, target_id: targetType === (filters.target_type ?? "") ? filters.target_id ?? null : null, result: inputValue(input, "result") || null, since: isoTime(inputValue(input, "since")) || null, until: isoTime(inputValue(input, "until")) || null, page: null, log: null }); }}>
      <Field label="操作时角色"><select className={styles.select} name="actor_role" aria-label="操作时角色" defaultValue={filters.actor_role ?? ""}><option value="">全部角色</option>{Object.entries(auditRoles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="对象类型"><select className={styles.select} name="target_type" aria-label="对象类型" defaultValue={filters.target_type ?? ""}><option value="">全部对象</option>{Object.entries(targetTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="操作类型"><input className={styles.input} name="action" maxLength={100} defaultValue={filters.action ?? ""} /></Field><Field label="操作结果"><select className={styles.select} name="result" aria-label="操作结果" defaultValue={resultFilter ?? ""}><option value="">全部</option><option value="success">成功</option><option value="failure">失败</option></select></Field>
      <Field label="开始时间"><input className={styles.input} type="datetime-local" name="since" defaultValue={filters.since ? localTime(filters.since) : ""} /></Field><Field label="结束时间"><input className={styles.input} type="datetime-local" name="until" defaultValue={filters.until ? localTime(filters.until) : ""} /></Field><button className={styles.primaryButton} type="submit">查询日志</button><button className={styles.button} type="button" onClick={(event) => { event.currentTarget.form?.reset(); updateQuery({ actor: null, actor_role: null, target_type: null, target_id: null, action: null, result: null, since: null, until: null, page: null, log: null }); }}>重置</button>
    </form>{list.isFetching && <p role="status">正在读取审计记录…</p>}<ErrorBox error={list.error} retry={() => void list.refetch()} />
    {filters.target_id && <Notice>当前对象：{filters.target_id} <button className={styles.button} type="button" onClick={() => updateQuery({ target_id: null, page: null, log: null })}>清除对象筛选</button></Notice>}
    {data && <Box><Table><thead><tr><th>时间</th><th>操作人 / 角色</th><th>操作</th><th>对象</th><th>结果</th><th>理由</th><th>详情</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{formatDateTime(item.occurred_at)}</td><td>{item.actor_id} / {auditRoles[item.actor_role]}</td><td>{item.action}</td><td>{targetTypes[item.target_type]} {item.target_id && <button className={styles.button} type="button" onClick={() => updateQuery({ target_type: item.target_type, target_id: item.target_id, page: null, log: null })}>筛选此对象</button>}</td><td>{item.result === "success" ? "成功" : "失败"}</td><td>{item.reason}</td><td><button className={styles.button} type="button" onClick={() => updateQuery({ log: item.id })}>查看日志</button></td></tr>)}</tbody></Table>{!data.items.length && <Empty />}<Pager page={page} total={data.total} change={(next) => updateQuery({ page: String(next), log: null })} /></Box>}
    {id && data && <AuditPanel key={`${userId}:${id}`} id={id} close={() => updateQuery({ log: null })} />}
  </>;
}

function costs(value: Record<string, string>) { return Object.entries(value).map(([currency, amount]) => `${currency} ${amount}`).join(" / ") || "无费用样本"; }
function UsageTable({ title, items }: { title: string; items: (Schema["UsageBreakdownDTO"] | Schema["UsageDayDTO"])[] }) {
  return <Box title={title}><Table><thead><tr><th>维度</th><th>请求数</th><th>成功 / 失败</th><th>输入 / 输出 Token</th><th>费用（按币种）</th></tr></thead><tbody>{items.map((item) => <tr key={"key" in item ? item.key : item.date}><td>{"key" in item ? item.key : item.date}</td><td>{item.requests}</td><td>{item.succeeded} / {item.failed}</td><td>{item.input_tokens} / {item.output_tokens}</td><td>{costs(item.cost_by_currency)}</td></tr>)}</tbody></Table>{!items.length && <Empty>当前范围没有用量样本</Empty>}</Box>;
}
function UsagePage() {
  const { userId } = useWorkspace(); const { query, updateQuery } = useUrlQuery();
  const rawDays = Number(query.get("days") ?? 7); const days = rawDays === 30 || rawDays === 90 ? rawDays : 7;
  const filters: UsageQuery = { days, user_id: selected(query.get("user")), feature: query.get("feature") || undefined, model: query.get("model") || undefined };
  // Changing the independent period/user query preserves unsubmitted text filters.
  const formKey = JSON.stringify([filters.feature, filters.model]);
  const result = useQuery({ queryKey: ["c-governance-usage", userId, filters], queryFn: () => api.usage(filters), ...querySettings });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  return <><Header title="AI 使用情况" description="按 UTC 日期聚合真实请求样本，费用按币种分别统计。" action={<button className={styles.button} type="button" onClick={() => void result.refetch()}>刷新用量</button>} />
    <div className={styles.actions}>{[7, 30, 90].map((value) => <button key={value} className={styles.button} type="button" aria-pressed={days === value} onClick={() => updateQuery({ days: String(value) })}>最近 {value} 天</button>)}</div>
    <UserSelect label="使用者" value={filters.user_id ?? ""} onChange={(value) => updateQuery({ user: value || null })} />
    <form className={styles.filters} key={formKey} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); updateQuery({ feature: inputValue(input, "feature") || null, model: inputValue(input, "model") || null }); }}><Field label="功能"><input className={styles.input} name="feature" maxLength={100} defaultValue={filters.feature ?? ""} /></Field><Field label="模型"><input className={styles.input} name="model" maxLength={160} defaultValue={filters.model ?? ""} /></Field><button className={styles.primaryButton} type="submit">查询用量</button><button className={styles.button} type="button" onClick={(event) => { event.currentTarget.form?.reset(); updateQuery({ user: null, feature: null, model: null, days: null }); }}>重置</button></form>
    {result.isFetching && <p role="status">正在读取用量…</p>}<ErrorBox error={result.error} retry={() => void result.refetch()} />
    {data && <><Box title="用量汇总"><div className={styles.panelBody}><p>范围：{formatDateTime(data.since)} 至 {formatDateTime(data.until)}（UTC 日历窗口）</p><p>请求总数：{data.requests} · 成功：{data.succeeded} · 失败：{data.failed}</p><p>输入 Token：{data.input_tokens} · 输出 Token：{data.output_tokens}</p><p>费用：{costs(data.cost_by_currency)}</p><p>{data.aggregation_scope}</p></div></Box><UsageTable title="按日期" items={data.daily} /><UsageTable title="按功能" items={data.by_feature} /><UsageTable title="按模型" items={data.by_model} /></>}
  </>;
}

export function GovernanceApiPage({ screen }: { screen: "courses" | "logs" | "ai-usage" | "access-requests" }) {
  const { userId } = useWorkspace();
  return <div className={styles.page} key={`${userId}:${screen}`}>{screen === "courses" ? <CoursesPage /> : screen === "logs" ? <LogsPage /> : screen === "ai-usage" ? <UsagePage /> : <AccessPage />}</div>;
}
