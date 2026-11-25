"use client";

import { cloneElement, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Check, CircleAlert, Coins, Copy, Gauge, Layers3, ListFilter, RefreshCw, ShieldOff, Zap } from "lucide-react";
import { CApiError } from "@/lib/api/c-client";
import { createGovernanceClient, type AccessQuery, type AuditQuery, type AuthAuditQuery, type CourseQuery, type SharedAuditQuery, type UsageQuery } from "@/lib/api/c-governance-client";
import { CompactUserSelect, CopyableId, EntityLabel, describeAuditAction, describeAuditTargetType, formatDurationMs, isUuidString, useAdminLabels } from "@/features/c/AdminPrimitives";
import { useWorkspace } from "@/lib/workspace";
import type { components } from "@/packages/domain/api.generated";
import { Badge, Box, Empty, Header, Metric, Notice, Table, formatDateTime } from "@/features/governance/primitives";
import styles from "@/features/governance/governance.module.css";
import { useUrlQuery } from "./use-url-query";
import { tr } from "@/lib/i18n/tr";

type Schema = components["schemas"];
const api = createGovernanceClient();
const querySettings = { staleTime: 0, gcTime: 0, retry: false } as const;
const courseStatuses = { draft: "草稿", active: "已发布", ended: "已结束" } as const;
const requestStatuses = { pending: "待审批", approved: "已批准", rejected: "已拒绝" } as const;
const grantStatuses = { active: "生效中", expired: "已过期", revoked: "已撤销", all: "全部状态" } as const;
const auditRoles = { student: "学生", leader: "组长", teacher: "教师", ta: "助教", admin: "管理员", system: "系统" } as const;
const targetTypes = { user: "用户", course: "课程", project: "项目", task: "任务", evidence: "证据", system: "系统" } as const;
const courseActionLabels: Record<string, string> = { create: "创建草稿", publish: "发布课程", end: "结束课程" };
const usageScenarioDefinitions = [
  { key: "activity-summary", label: "提交与群聊活动摘要", description: "将 GitHub 提交与飞书消息提炼为待人工确认的过程摘要", feature: "summarize_activity" },
  { key: "project-blueprint", label: "AI 项目研发蓝图", description: "根据项目背景自动生成功能模块与阶段交付蓝图", feature: "generate_project_blueprint" },
  { key: "github-analysis", label: "GitHub 仓库提交分析", description: "根据同步代码与需求核对实现状态", feature: "analyze_implementation" },
  { key: "chat-tracking", label: "证据与群聊追踪", description: "群聊记录进入证据流后辅助验收匹配", feature: "match_evidence" },
  { key: "requirement-analysis", label: "需求文档解析", description: "从项目资料提取需求、模块与冲突", feature: "extract_requirements" },
  { key: "task-planning", label: "任务规划建议", description: "识别未覆盖需求并生成任务建议", feature: "suggest_tasks" },
  { key: "risk-analysis", label: "风险与进度解释", description: "结合任务进度和风险记录生成解释", feature: "explain_risk" },
] as const;
const aiFeatureLabels: Record<string, string> = Object.fromEntries(
  usageScenarioDefinitions.map((item) => [item.feature, item.label]),
);
const authActions = {
  "admin.bootstrapped": "初始化管理员", "auth.acceptance_test_entry": "验收测试入口", "auth.email_registered": "邮箱注册完成",
  "auth.google.account_exists": "Google 登录邮箱与已有账号冲突", "auth.google.cancelled": "取消 Google 登录",
  "auth.google.failed": "Google 登录或绑定失败", "auth.google.linked": "绑定 Google 账号", "auth.google.unlinked": "解除 Google 账号绑定",
  "auth.login": "登录", "auth.logout": "退出登录", "auth.password_change": "修改密码",
  "auth.password_login": "密码登录", "auth.password_login.rate_limited": "密码登录触发限流", "auth.password_register.closed_path": "已关闭的密码注册入口",
  "auth.registered": "账号注册", "auth.session_refresh": "刷新会话", "email_challenge.consume_failed": "邮箱验证码校验失败",
  "email_challenge.rate_limited": "邮箱验证触发限流", "email_challenge.send_failed": "验证码发送失败", "email_challenge.sent": "验证码已发送",
  "login_email.verified": "登录邮箱验证完成", "password_recovery.notice_failed": "密码恢复通知失败", "password_recovery.requested_ineligible": "不符合条件的密码恢复请求",
  "password_recovery.reset": "密码恢复完成", "password_recovery.sent": "密码恢复邮件已发送", "pre_registration.code_verified": "注册验证码验证完成",
  "pre_registration.created": "创建注册申请", "preferences.updated": "更新偏好", "profile.updated": "更新个人资料", "role.granted_student": "授予学生角色",
  "school_email.change_authorized": "授权变更学校邮箱", "school_email.change_requested": "申请变更学校邮箱", "school_email.verified": "学校邮箱验证完成",
  "teacher.role_revoked_basis_changed": "审核依据变化后撤销教师角色", "teacher_application.approved": "通过教师审核", "teacher_application.rejected": "拒绝教师审核",
  "teacher_application.resubmitted": "重新提交教师申请", "teacher_application.submitted": "提交教师申请", "user.disabled": "停用账号",
} satisfies Record<NonNullable<NonNullable<AuthAuditQuery>["action"]>, string>;

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
    return tr("{0}{1}", { 0: text, 1: error.requestId ? tr("（请求编号：{0}）", { 0: error.requestId }) : "" });
  }
  return error?.message || "服务暂不可用，请重试。";
}
function ErrorBox({ error, retry, label = "重试" }: { error: Error | null; retry?: () => void; label?: string }) {
  return error ? <div role="alert" className={styles.identityError}><p>{message(error)}</p>{retry && <button className={styles.button} type="button" onClick={retry}>{label}</button>}</div> : null;
}
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}
function Pager({ page, total, change }: { page: number; total: number; change: (page: number) => void }) {
  return <div className={styles.tableFooter}><span>{tr("共 {0} 条 · 第 {1} 页", { 0: total, 1: page })}</span><div className={styles.actions}><button className={styles.button} type="button" disabled={page <= 1} onClick={() => change(page - 1)}>上一页</button><button className={styles.button} type="button" disabled={page * 10 >= total} onClick={() => change(page + 1)}>下一页</button></div></div>;
}

function History({ items }: { items: Schema["GovernanceHistoryDTO"][] }) {
  const labels = useAdminLabels({ userIds: items.map((item) => item.actor_id), enabled: items.length > 0 });
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-slate-900">操作历史</h3>
      {!items.length ? (
        <Empty>暂无操作历史</Empty>
      ) : (
        <ol className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3">
          {items.map((item) => {
            const actorName = labels.users[item.actor_id]?.name;
            return (
              <li key={item.id} className="text-xs">
                <strong className="text-slate-900">
                  {tr("{0} · 版本 {1}", { 0: courseActionLabels[item.action] ?? item.action, 1: item.version_no })}
                </strong>
                <p className="my-1 text-slate-700">{item.reason}</p>
                <small className="text-slate-500">
                  {tr("{0} · 操作人 {1}", { 0: formatDateTime(item.created_at), 1: actorName || item.actor_id })}
                </small>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function unauthorized(error: unknown): error is CApiError { return error instanceof CApiError && (error.status === 401 || error.status === 403); }
async function readWithAccessCheck<T>(read: () => Promise<T>, onDenied: (error: CApiError) => void) {
  try { return await read(); }
  catch (error) { if (unauthorized(error)) onDenied(error); throw error; }
}
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
    <CompactUserSelect label="负责教师" value={owner} onChange={setOwner} teacherOnly required onUnauthorized={onUnauthorized} />
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
  const labels = useAdminLabels({ userIds: data ? [data.owner_id] : [], enabled: Boolean(data) });
  const [reason, setReason] = useState(""); const command = useCommand(onUnauthorized);
  const [initialized, setInitialized] = useState(false);
  const [intent, setIntent] = useState<Pick<Schema["TransitionCourse"], "action" | "expected_version"> | null>(null);
  const [notice, setNotice] = useState("");
  const [copiedInvite, setCopiedInvite] = useState(false);
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
  const ownerDisplay = data ? (labels.users[data.owner_id]?.name ? `${labels.users[data.owner_id].name} (${data.owner_id.slice(0, 8)})` : data.owner_id) : "";

  return <Box title="课程详情" action={<button type="button" className={styles.button} onClick={close}>关闭详情</button>}><div className={styles.panelBody}>
    <button className={styles.button} type="button" disabled={command.busy || detail.isFetching} onClick={() => void refresh()}>刷新详情</button>
    {detail.isFetching && <p role="status">正在读取课程详情…</p>}<ErrorBox error={detail.error} />
    {data && <div className="mt-3 space-y-2">
      <h3 className="m-0 text-base font-bold text-slate-900">{data.name}</h3>
      <p className="text-sm text-slate-700">{tr("{0} · {1} · {2} · 版本 {3}", { 0: data.code, 1: data.semester, 2: courseStatuses[data.status], 3: data.lock_version })}</p>
      <p className="text-xs text-slate-600">{tr("负责教师：{0} · 项目截止：{1}", { 0: ownerDisplay, 1: formatDateTime(data.project_deadline ?? undefined) })}</p>
      <p className="text-xs text-slate-600">{tr("组队方式：{0} · 组员人数：{1}–{2} · 组队截止：{3}", { 0: data.grouping_mode === "free" ? "自由组队" : "审批组队", 1: data.min_group_size, 2: data.max_group_size, 3: formatDateTime(data.formation_deadline ?? undefined) })}</p>
      {data.invite_code && <Notice>
        <div className="flex flex-wrap items-center gap-2">
          <span>课程邀请码：<strong>{data.invite_code}</strong>{data.invite_revoked_at ? "（已撤销）" : ""}</span>
          {!data.invite_revoked_at && (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                void navigator.clipboard?.writeText(data.invite_code!).then(() => {
                  setCopiedInvite(true);
                  window.setTimeout(() => setCopiedInvite(false), 1500);
                }).catch(() => {});
              }}
            >
              {copiedInvite ? <Check size={13} /> : <Copy size={13} />}
              {copiedInvite ? "已复制" : "复制邀请码"}
            </button>
          )}
        </div>
      </Notice>}
      <History items={data.history} />
    </div>}
    {changed && <Notice>课程状态或版本已变化，当前操作已暂停。请刷新详情并核对；填写的理由已保留。</Notice>}
    {notice && <Notice>{notice}</Notice>}
    {intent && <form className={`${styles.stack} mt-3`} onSubmit={submit}><Field label="变更理由"><textarea className={styles.textarea} required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={command.busy} /></Field>
      <Notice>{intent.action === "publish" ? "发布会激活课程并生成唯一邀请码，学生可通过邀请码或申请加入课程。" : "结束后课程将停止活动，邀请码会撤销。"}</Notice>
      <button className={intent.action === "end" ? styles.dangerButton : styles.primaryButton} type="submit" disabled={!data || changed || command.busy || !reason.trim() || conflictNeedsRefresh(command, detail.dataUpdatedAt)}>{command.busy ? "正在提交…" : intent.action === "end" ? "确认结束课程" : "确认发布课程"}</button></form>}
    {!intent && data && currentAction && <button className={`${styles.button} mt-3`} type="button" disabled={command.busy} onClick={beginNextAction}>{currentAction === "end" ? "开始结束确认" : "开始发布确认"}</button>}
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
  const courseIds = useMemo(() => (result?.items ?? []).map((item) => item.id), [result?.items]);
  const courseMetrics = useQuery({
    queryKey: ["admin-course-metrics", userId, courseIds],
    queryFn: () => api.workbenchCourseMetrics(courseIds),
    enabled: Boolean(result && courseIds.length > 0 && !denied),
    staleTime: 30_000,
    retry: false,
  });
  const refresh = () => { void list.refetch().then((current) => { if (current.isSuccess) setDenied(null); }); };
  const changed = () => { void cache.invalidateQueries({ queryKey: ["c-governance-courses", userId] }); void cache.invalidateQueries({ queryKey: ["admin-course-metrics", userId] }); };
  const isCreating = query.get("create") === "1";

  return <>
    <Header
      title="课程管理"
      action={
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={refresh}>刷新课程</button>
          <button
            type="button"
            className={isCreating ? styles.button : styles.primaryButton}
            onClick={() => updateQuery({ create: isCreating ? null : "1", course: null })}
          >
            {isCreating ? "收起创建表单" : "新建课程"}
          </button>
        </div>
      }
    />
    <form key={query.toString()} className={styles.filters} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); updateQuery({ q: inputValue(input, "q") || null, semester: inputValue(input, "semester") || null, status: inputValue(input, "status") || null, page: null, course: null }); }}>
      <Field label="搜索课程"><input className={styles.input} name="q" maxLength={200} defaultValue={filters.q ?? ""} placeholder="课程编号或名称" /></Field>
      <Field label="筛选学期"><input className={styles.input} name="semester" maxLength={64} defaultValue={filters.semester ?? ""} placeholder="例如 2026秋" /></Field>
      <Field label="课程状态"><select className={styles.select} name="status" aria-label="课程状态" defaultValue={status ?? ""}><option value="">全部</option>{Object.entries(courseStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <button type="submit" className={styles.primaryButton}>查询课程</button>
      <button type="button" className={styles.button} onClick={() => updateQuery({ q: null, semester: null, status: null, page: null, course: null })}>重置</button>
    </form>
    {!denied && !unauthorized(list.error) && isCreating && <div hidden={!result}><CourseCreate key={userId} canSubmit={Boolean(result)} onUnauthorized={setDenied} onCreated={(course) => { updateQuery({ course: course.id, create: null, page: null, q: null, semester: null, status: null }); changed(); }} /></div>}
    {list.isFetching && <p role="status">正在读取课程…</p>}<ErrorBox error={denied ?? list.error} retry={refresh} />
    {(result || (!denied && id && !unauthorized(list.error))) && (
      <div className={!denied && id && !unauthorized(list.error) ? styles.twoColumns : undefined}>
        {result && (
          <Box>
            <Table>
              <thead>
                <tr><th>课程编号</th><th>名称</th><th>学院 / 学期</th><th>负责教师</th><th>规模（学生 · 小组 · 项目）</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                {result.items.map((item) => {
                  const metric = courseMetrics.data?.items[item.id];
                  return (
                    <tr key={item.id}>
                      <td><code>{item.code}</code></td>
                      <td><strong>{item.name}</strong></td>
                      <td>{item.college} / {item.semester}</td>
                      <td>{metric ? metric.owner_name : <CopyableId value={item.owner_id} />}</td>
                      <td className="text-xs text-slate-600">{metric ? `${metric.member_count} 人 · ${metric.group_count} 组 · ${metric.project_count} 项目` : "—"}</td>
                      <td>
                        <Badge tone={item.status === "active" ? "green" : item.status === "ended" ? "gray" : "amber"}>
                          {courseStatuses[item.status]}
                        </Badge>
                      </td>
                      <td><button type="button" className={styles.button} onClick={() => updateQuery({ course: item.id, create: null })}>查看课程</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {!result.items.length && <Empty />}
            <Pager page={page} total={result.total} change={(next) => updateQuery({ page: String(next), course: null })} />
          </Box>
        )}
        {!denied && id && !unauthorized(list.error) && <CoursePanel key={`${userId}:${id}`} id={id} onChanged={changed} onUnauthorized={setDenied} close={() => updateQuery({ course: null })} />}
      </div>
    )}
  </>;
}

function AccessPanel({ id, onChanged, close, onUnauthorized }: { id: string; onChanged: () => void; close: () => void; onUnauthorized: (error: CApiError) => void }) {
  const { userId } = useWorkspace(); const cache = useQueryClient(); const command = useCommand(onUnauthorized);
  const detail = useQuery({ queryKey: ["c-governance-request", userId, id], queryFn: async () => { try { return await api.accessRequest(id); } catch (error) { if (unauthorized(error)) onUnauthorized(error); throw error; } }, ...querySettings });
  const data = detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const labels = useAdminLabels({
    userIds: data ? [data.applicant_id] : [],
    projectIds: data ? [data.scope.project_id] : [],
    enabled: Boolean(data),
  });
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
  const applicantDisplay = data ? (labels.users[data.applicant_id]?.name ? `${labels.users[data.applicant_id].name} (${data.applicant_id.slice(0, 8)})` : data.applicant_id) : "";
  const projectDisplay = data ? (labels.projects[data.scope.project_id]?.name ? `${labels.projects[data.scope.project_id].name} (${data.scope.project_id.slice(0, 8)})` : data.scope.project_id) : "";

  return <Box title="访问申请详情" action={<button className={styles.button} type="button" onClick={close}>关闭详情</button>}><div className={styles.panelBody}>
    <button className={styles.button} type="button" disabled={detail.isFetching || command.busy} onClick={() => void detail.refetch()}>刷新详情</button>{detail.isFetching && <p role="status">正在读取申请详情…</p>}<ErrorBox error={detail.error} />
    {data && <div className="mt-3 space-y-1.5 text-sm">
      <p>{tr("申请人：{0}", { 0: applicantDisplay })}</p>
      <p>{tr("申请理由：{0}", { 0: data.reason })}</p>
      <p>{tr("状态：{0} · 版本 {1}", { 0: requestStatuses[data.status], 1: data.lock_version })}</p>
      <p>{tr("访问范围：{0} / {1} · 只读 · 所属项目 {2}", { 0: targetTypes[data.scope.resource_type], 1: data.scope.resource_id, 2: projectDisplay })}</p>
      <p>{tr("申请截止：{0}", { 0: formatDateTime(data.requested_expires_at) })}</p>
      {data.status === "approved" && <Notice>{tr("此处显示审批结果；实际访问还需通过权限检查。{0}", { 0: data.approval_expired ? "授权期限已过。" : tr("批准截止：{0}", { 0: formatDateTime(data.approved_expires_at ?? undefined) }) })}</Notice>}
      <History items={data.history} />
    </div>}
    {requestExpired && <Notice>申请期限已过，无法批准；可填写理由拒绝此申请。</Notice>}
    {(!data || data.status === "pending") && <form className={`${styles.stack} mt-3`} onSubmit={submit}><Field label="审批决定"><select className={styles.select} aria-label="审批决定" value={decision} disabled={command.busy} onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}><option value="approved" disabled={requestExpired}>批准只读访问</option><option value="rejected">拒绝</option></select></Field>
      {decision === "approved" && <><Field label="批准截止时间"><input className={styles.input} type="datetime-local" required value={expiry ?? (data ? localTime(data.requested_expires_at) : "")} max={data ? localTime(data.requested_expires_at) : undefined} disabled={command.busy || requestExpired} onChange={(event) => setExpiry(event.target.value)} /></Field><Notice>批准后按申请范围授予只读访问，到期后自动失效。</Notice></>}
      <Field label="审批理由"><textarea className={styles.textarea} required maxLength={2000} value={reason} disabled={command.busy} onChange={(event) => setReason(event.target.value)} /></Field><button className={styles.primaryButton} type="submit" disabled={!data || command.busy || !reason.trim() || (decision === "approved" && requestExpired) || conflictNeedsRefresh(command, detail.dataUpdatedAt)}>{command.busy ? "正在提交…" : "确认审批决定"}</button></form>}
    <ErrorBox error={command.error} />
  </div></Box>;
}

function ActiveGrantsTab() {
  const { userId } = useWorkspace();
  const [status, setStatus] = useState<"active" | "expired" | "revoked" | "all">("active");
  const [page, setPage] = useState(1);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const grants = useQuery({
    queryKey: ["admin-workbench-grants", userId, status, page],
    queryFn: () => api.workbenchAccessGrants({ page, page_size: 10, status }),
    staleTime: 10_000,
    retry: false,
  });

  async function confirmRevoke(grantId: string) {
    if (!revokeReason.trim() || busy) return;
    setBusy(true);
    setFeedback("");
    try {
      await api.revokeAccessGrant(grantId, revokeReason.trim());
      setRevokingId(null);
      setRevokeReason("");
      setFeedback("临时只读授权已撤销，目标用户在下一次请求时立即失效。");
      await grants.refetch();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "撤销授权失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  const data = grants.data;

  return (
    <div className={styles.stack}>
      <div className={styles.filters}>
        <Field label="授权状态">
          <select
            className={styles.select}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status);
              setPage(1);
              setRevokingId(null);
            }}
          >
            {Object.entries(grantStatuses).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </Field>
        <button type="button" className={styles.button} disabled={grants.isFetching} onClick={() => void grants.refetch()}>
          刷新授权列表
        </button>
      </div>

      {feedback && <Notice>{feedback}</Notice>}
      {grants.isFetching && <p role="status">正在读取已生效授权…</p>}
      <ErrorBox error={grants.error} retry={() => void grants.refetch()} />

      {data && (
        <Box>
          <Table>
            <thead>
              <tr><th>申请人</th><th>项目 / 课程</th><th>授权范围</th><th>到期时间</th><th>状态 / 撤销信息</th><th>操作</th></tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <EntityLabel name={item.applicant_name} id={item.applicant_id} subtitle={item.applicant_email} />
                  </td>
                  <td>
                    <EntityLabel name={item.project_name} id={item.project_id} subtitle={item.course_code} />
                  </td>
                  <td>
                    <Badge tone="blue">{targetTypes[item.resource_type]} · 只读</Badge>
                    <div className="mt-1"><CopyableId value={item.resource_id} /></div>
                  </td>
                  <td className="text-xs">{formatDateTime(item.expires_at)}</td>
                  <td>
                    <Badge tone={item.state === "active" ? "green" : item.state === "revoked" ? "red" : "gray"}>
                      {grantStatuses[item.state]}
                    </Badge>
                    {item.revoked_at && (
                      <div className="mt-1 text-xs text-slate-500">
                        {item.revoked_by_name ? `${item.revoked_by_name} 撤销：` : ""}{item.revoke_reason}
                      </div>
                    )}
                  </td>
                  <td>
                    {item.state === "active" ? (
                      <button
                        type="button"
                        className={styles.dangerButton}
                        onClick={() => {
                          setRevokingId(revokingId === item.id ? null : item.id);
                          setRevokeReason("");
                        }}
                      >
                        <ShieldOff size={13} />
                        {revokingId === item.id ? "取消" : "撤销授权"}
                      </button>
                    ) : (
                      <span className={styles.muted}>已结束</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!data.items.length && <Empty>该状态下暂无临时授权记录</Empty>}
          <Pager page={page} total={data.total} change={setPage} />
        </Box>
      )}

      {revokingId && (
        <Box title="确认提前撤销临时只读授权" action={<button type="button" className={styles.button} onClick={() => setRevokingId(null)}>关闭</button>}>
          <div className={`${styles.panelBody} ${styles.stack}`}>
            <Field label="撤销原因">
              <textarea
                className={styles.textarea}
                value={revokeReason}
                maxLength={2000}
                placeholder="说明提前终止临时只读授权的依据（写入不可篡改审计日志）"
                onChange={(event) => setRevokeReason(event.target.value)}
              />
            </Field>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.dangerButton}
                disabled={busy || !revokeReason.trim()}
                onClick={() => void confirmRevoke(revokingId)}
              >
                {busy ? "正在撤销…" : "确认立即撤销"}
              </button>
            </div>
          </div>
        </Box>
      )}
    </div>
  );
}

function AccessPage() {
  const { userId } = useWorkspace(); const cache = useQueryClient(); const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  const tab = query.get("tab") === "grants" ? "grants" : "requests";
  const page = pageNumber(query.get("page")); const status = choice(query.get("status"), requestStatuses);
  const filters: AccessQuery = { page, page_size: 10, status };
  const list = useQuery({ queryKey: ["c-governance-requests", userId, filters], queryFn: () => api.accessRequests(filters), enabled: !denied && tab === "requests", ...querySettings });
  const data = !denied && list.isSuccess && !list.isFetching ? list.data : undefined; const id = selected(query.get("request"));
  const labels = useAdminLabels({
    userIds: (data?.items ?? []).map((item) => item.applicant_id),
    projectIds: (data?.items ?? []).map((item) => item.scope.project_id),
    enabled: Boolean(data?.items.length),
  });
  const refresh = () => { void list.refetch().then((current) => { if (current.isSuccess) setDenied(null); }); };

  return <>
    <Header
      title="访问审批"
      action={tab === "requests" ? <button type="button" className={styles.button} onClick={refresh}>刷新申请</button> : null}
    />
    <div className={styles.segmentedTabs} role="tablist" aria-label="访问治理视图">
      <button type="button" role="tab" aria-selected={tab === "requests"} className={styles.segmentedTab} onClick={() => updateQuery({ tab: null })}>
        访问申请审批
      </button>
      <button type="button" role="tab" aria-selected={tab === "grants"} className={styles.segmentedTab} onClick={() => updateQuery({ tab: "grants", request: null })}>
        已生效授权管理
      </button>
    </div>

    {tab === "grants" ? (
      <ActiveGrantsTab />
    ) : (
      <>
        <div className={styles.filters}>
          <Field label="申请状态">
            <select className={styles.select} aria-label="申请状态" value={status ?? ""} onChange={(event) => updateQuery({ status: event.target.value || null, page: null, request: null })}>
              <option value="">全部</option>
              {Object.entries(requestStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        {list.isFetching && <p role="status">正在读取访问申请…</p>}<ErrorBox error={denied ?? list.error} retry={refresh} />
        {data && (
          <div className={id ? styles.twoColumns : undefined}>
            <Box>
              <Table>
                <thead><tr><th>申请人</th><th>申请理由</th><th>范围</th><th>状态</th><th>申请截止</th><th>操作</th></tr></thead>
                <tbody>
                  {data.items.map((item) => {
                    const resolvedApplicant = labels.users[item.applicant_id]?.name;
                    const resolvedProject = labels.projects[item.scope.project_id]?.name;
                    return (
                      <tr key={item.id}>
                        <td>
                          {resolvedApplicant ? (
                            <EntityLabel name={resolvedApplicant} id={item.applicant_id} />
                          ) : (
                            item.applicant_id
                          )}
                        </td>
                        <td>{item.reason}</td>
                        <td>
                          <Badge tone="blue">{tr("{0} · 只读", { 0: targetTypes[item.scope.resource_type] })}</Badge>
                          {resolvedProject && <div className="mt-1 text-xs text-slate-500">{resolvedProject}</div>}
                        </td>
                        <td>
                          <Badge tone={item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "amber"}>
                            {requestStatuses[item.status]}
                          </Badge>
                        </td>
                        <td>{formatDateTime(item.requested_expires_at)}</td>
                        <td><button type="button" className={styles.button} onClick={() => updateQuery({ request: item.id })}>查看申请</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {!data.items.length && <Empty />}
              <Pager page={page} total={data.total} change={(next) => updateQuery({ page: String(next), request: null })} />
            </Box>
            {!denied && id && !unauthorized(list.error) && <div hidden={!data}><AccessPanel key={`${userId}:${id}`} id={id} onUnauthorized={setDenied} close={() => updateQuery({ request: null })} onChanged={() => { void cache.invalidateQueries({ queryKey: ["c-governance-requests", userId] }); }} /></div>}
          </div>
        )}
      </>
    )}
  </>;
}

function AuditPanel({ id, close, onDenied }: { id: string; close: () => void; onDenied: (error: CApiError) => void }) {
  const { userId } = useWorkspace();
  const detail = useQuery({ queryKey: ["c-governance-audit", userId, id], queryFn: () => readWithAccessCheck(() => api.auditLog(id), onDenied), ...querySettings });
  const item = detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const labels = useAdminLabels({
    userIds: item ? [item.actor_id, item.target_type === "user" ? item.target_id : undefined] : [],
    courseIds: item?.target_type === "course" ? [item.target_id] : [],
    projectIds: item?.target_type === "project" ? [item.target_id] : [],
    enabled: Boolean(item),
  });
  const actionMeta = item ? describeAuditAction(item.action) : null;
  const actorName = item ? labels.users[item.actor_id]?.name : undefined;
  const targetName = item?.target_id
    ? item.target_type === "course"
      ? labels.courses[item.target_id]?.name
      : item.target_type === "project"
        ? labels.projects[item.target_id]?.name
        : item.target_type === "user"
          ? labels.users[item.target_id]?.name
          : undefined
    : undefined;
  return <Box title="日志详情" action={<button type="button" className={styles.button} onClick={close}>关闭详情</button>}><div className={styles.panelBody}>
    {detail.isFetching && <p role="status">正在读取日志详情…</p>}<ErrorBox error={detail.error} retry={() => void detail.refetch()} label="重试详情" />
    {item && actionMeta && <>
      <p><strong>{actionMeta.label}</strong> <code className="text-xs text-slate-500">{item.action}</code> · {item.result === "success" ? "成功" : "失败"} · {formatDateTime(item.occurred_at)}</p>
      <p>{tr("操作人：{0}", { 0: actorName ? `${actorName} (${item.actor_id})` : item.actor_id })}</p>
      <p>{tr("目标：{0} / {1}", { 0: describeAuditTargetType(item.target_type), 1: targetName ? `${targetName} (${item.target_id})` : item.target_id ?? "系统" })}</p>
      <p>{tr("理由：{0}", { 0: item.reason })}</p>
      <h3>变更前</h3><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item.before, null, 2)}</pre>
      <h3>变更后</h3><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item.after, null, 2)}</pre>
    </>}
  </div></Box>;
}

function BusinessLogsPage() {
  const { userId } = useWorkspace(); const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  function block(error: CApiError) { setDenied(error); if (query.has("log")) updateQuery({ log: null }); }
  const page = pageNumber(query.get("page")); const resultFilter = choice(query.get("result"), { success: "成功", failure: "失败" });
  const filters: AuditQuery = { page, page_size: 10, actor_id: selected(query.get("actor")), actor_role: choice(query.get("actor_role"), auditRoles), target_type: choice(query.get("target_type"), targetTypes), target_id: selected(query.get("target_id")), action: query.get("action") || undefined, result: resultFilter, since: isoTime(query.get("since") ?? ""), until: isoTime(query.get("until") ?? "") };
  const formKey = JSON.stringify([filters.actor_role, filters.target_type, filters.action, filters.result, filters.since, filters.until]);
  const list = useQuery({ queryKey: ["c-governance-audits", userId, filters], queryFn: () => readWithAccessCheck(() => api.auditLogs(filters), block), enabled: !denied, ...querySettings });
  const data = list.isSuccess && !list.isFetching ? list.data : undefined; const id = selected(query.get("log"));
  const labels = useAdminLabels({
    userIds: (data?.items ?? []).flatMap((item) => [item.actor_id, item.target_type === "user" ? item.target_id : undefined]),
    courseIds: (data?.items ?? []).filter((item) => item.target_type === "course").map((item) => item.target_id),
    projectIds: (data?.items ?? []).filter((item) => item.target_type === "project").map((item) => item.target_id),
    enabled: Boolean(data?.items.length),
  });
  if (denied) return <ErrorBox error={denied} retry={() => window.location.reload()} label="重新验证管理权限" />;
  return <><Header title="全站业务日志" action={<button className={styles.button} type="button" onClick={() => void list.refetch()}>刷新日志</button>} />
    <CompactUserSelect label="操作人" value={filters.actor_id ?? ""} onUnauthorized={block} onChange={(value) => updateQuery({ actor: value || null, page: null, log: null })} />
    <form key={formKey} className={styles.filters} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); const targetType = inputValue(input, "target_type"); updateQuery({ action: inputValue(input, "action") || null, actor_role: inputValue(input, "actor_role") || null, target_type: targetType || null, target_id: targetType === (filters.target_type ?? "") ? filters.target_id ?? null : null, result: inputValue(input, "result") || null, since: isoTime(inputValue(input, "since")) || null, until: isoTime(inputValue(input, "until")) || null, page: null, log: null }); }}>
      <Field label="操作时角色"><select className={styles.select} name="actor_role" aria-label="操作时角色" defaultValue={filters.actor_role ?? ""}><option value="">全部角色</option>{Object.entries(auditRoles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="对象类型"><select className={styles.select} name="target_type" aria-label="对象类型" defaultValue={filters.target_type ?? ""}><option value="">全部对象</option>{Object.entries(targetTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="操作类型"><input className={styles.input} name="action" maxLength={100} defaultValue={filters.action ?? ""} /></Field><Field label="操作结果"><select className={styles.select} name="result" aria-label="操作结果" defaultValue={resultFilter ?? ""}><option value="">全部</option><option value="success">成功</option><option value="failure">失败</option></select></Field>
      <Field label="开始时间"><input className={styles.input} type="datetime-local" name="since" defaultValue={filters.since ? localTime(filters.since) : ""} /></Field><Field label="结束时间"><input className={styles.input} type="datetime-local" name="until" defaultValue={filters.until ? localTime(filters.until) : ""} /></Field><button className={styles.primaryButton} type="submit">查询日志</button><button className={styles.button} type="button" onClick={(event) => { event.currentTarget.form?.reset(); updateQuery({ actor: null, actor_role: null, target_type: null, target_id: null, action: null, result: null, since: null, until: null, page: null, log: null }); }}>重置</button>
    </form>{list.isFetching && <p role="status">正在读取审计记录…</p>}<ErrorBox error={list.error} retry={() => void list.refetch()} />
    {filters.target_id && <Notice>{tr("当前对象：{0} ", { 0: filters.target_id })}<button className={styles.button} type="button" onClick={() => updateQuery({ target_id: null, page: null, log: null })}>清除对象筛选</button></Notice>}
    {data && (
      <div className={id ? styles.twoColumns : undefined}>
        <Box><Table><thead><tr><th>时间</th><th>操作</th><th>操作人 / 角色</th><th>对象</th><th>结果</th><th>理由</th><th>详情</th></tr></thead><tbody>
          {data.items.map((item) => {
            const actionMeta = describeAuditAction(item.action);
            const actorName = labels.users[item.actor_id]?.name;
            const targetName = item.target_id
              ? item.target_type === "course"
                ? labels.courses[item.target_id]?.name
                : item.target_type === "project"
                  ? labels.projects[item.target_id]?.name
                  : item.target_type === "user"
                    ? labels.users[item.target_id]?.name
                    : undefined
              : undefined;
            return (
              <tr key={item.id}>
                <td className="whitespace-nowrap">{formatDateTime(item.occurred_at)}</td>
                <td>
                  <div className="space-y-0.5">
                    <strong className="block text-slate-900">{actionMeta.label}</strong>
                    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <Badge tone="gray">{actionMeta.category}</Badge>
                      <code>{item.action}</code>
                    </span>
                  </div>
                </td>
                <td>
                  {actorName ? (
                    <EntityLabel name={actorName} id={item.actor_id} subtitle={auditRoles[item.actor_role]} />
                  ) : (
                    `${item.actor_id} / ${auditRoles[item.actor_role]}`
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {targetName && item.target_id ? (
                      <EntityLabel name={targetName} id={item.target_id} subtitle={describeAuditTargetType(item.target_type)} />
                    ) : (
                      <span>{describeAuditTargetType(item.target_type)}</span>
                    )}
                    {item.target_id && <button className={styles.button} type="button" onClick={() => updateQuery({ target_type: item.target_type, target_id: item.target_id, page: null, log: null })}>筛选此对象</button>}
                  </div>
                </td>
                <td><Badge tone={item.result === "success" ? "green" : "red"}>{item.result === "success" ? "成功" : "失败"}</Badge></td>
                <td>{item.reason}</td>
                <td><button className={styles.button} type="button" onClick={() => updateQuery({ log: item.id })}>查看日志</button></td>
              </tr>
            );
          })}
        </tbody></Table>{!data.items.length && <Empty />}<Pager page={page} total={data.total} change={(next) => updateQuery({ page: String(next), log: null })} /></Box>
        {id && <AuditPanel key={`${userId}:${id}`} id={id} close={() => updateQuery({ log: null })} onDenied={block} />}
      </div>
    )}
  </>;
}

function authActor(value: string | null) { return value === "system" ? "系统" : value ?? "未记录"; }
const authResults = { success: "成功", failure: "失败", unknown: "未识别结果" } as const;

function AuthLogsPage() {
  const { userId } = useWorkspace(); const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  const page = pageNumber(query.get("auth_page"));
  const filters: AuthAuditQuery = { page, page_size: 10, action: choice(query.get("auth_action"), authActions),
    result: choice(query.get("auth_result"), { success: "成功", failure: "失败" }),
    actor_id: query.get("auth_actor") === "system" ? "system" : selected(query.get("auth_actor")), target_user_id: selected(query.get("auth_target")),
    since: isoTime(query.get("auth_since") ?? ""), until: isoTime(query.get("auth_until") ?? "") };
  const rawId = query.get("auth_log"); const id = rawId && /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : undefined;
  function block(error: CApiError) { setDenied(error); updateQuery({ auth_log: null }); }
  const list = useQuery({ queryKey: ["c-auth-audits", userId, filters], queryFn: async () => { try { return await api.authAuditLogs(filters); } catch (error) { if (unauthorized(error)) block(error); throw error; } }, enabled: !denied, ...querySettings });
  const data = !denied && list.isSuccess && !list.isFetching ? list.data : undefined;
  const labels = useAdminLabels({
    userIds: (data?.items ?? []).flatMap((row) => [row.actor_id, row.target_user_id]),
    enabled: Boolean(data?.items.length),
  });
  const detail = useQuery({ queryKey: ["c-auth-audit", userId, id], queryFn: async () => { try { return await api.authAuditLog(id!); } catch (error) { if (unauthorized(error)) block(error); throw error; } }, enabled: Boolean(id && data), ...querySettings });
  const item = data && detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const formKey = JSON.stringify([filters.action, filters.result, filters.since, filters.until]);
  async function refresh() {
    const result = await list.refetch();
    if (result.isSuccess) { setDenied(null); if (id && !denied) await detail.refetch(); }
  }
  const updateFilters = (patch: Record<string, string | null>) => updateQuery({ ...patch, auth_page: null, auth_log: null });
  return <>
    <Header title="认证日志" action={<button className={styles.button} type="button" disabled={list.isFetching || detail.isFetching} onClick={() => void refresh()}>刷新认证日志</button>} />
    <Notice>认证来源只记录事件、结果和变更字段名；操作时角色、操作理由、变更前后值均未记录。</Notice>
    <ErrorBox error={denied ?? list.error} retry={() => void refresh()} />
    {list.isFetching && <p role="status">正在读取认证日志…</p>}
    {!denied && <>
      <div className={styles.formGrid}>
        <CompactUserSelect label="认证操作人" includeSystem value={filters.actor_id ?? ""} onChange={(value) => updateFilters({ auth_actor: value || null })} onUnauthorized={block} />
        <CompactUserSelect label="目标账号" value={filters.target_user_id ?? ""} onChange={(value) => updateFilters({ auth_target: value || null })} onUnauthorized={block} />
      </div>
      <small>{tr("账号选项来自当前用户目录，仅用于筛选已记录的标识，不代表事件发生时的角色或资料。{0}{1}", { 0: filters.actor_id && tr(" 当前操作人筛选：{0}。", { 0: authActor(filters.actor_id) }), 1: filters.target_user_id && tr(" 当前目标账号筛选：{0}。", { 0: filters.target_user_id }) })}</small>
      <form key={formKey} className={styles.filters} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); updateFilters({ auth_action: inputValue(input, "action") || null, auth_result: inputValue(input, "result") || null, auth_since: isoTime(inputValue(input, "since")) || null, auth_until: isoTime(inputValue(input, "until")) || null }); }}>
        <Field label="认证事件"><select className={styles.select} name="action" defaultValue={filters.action ?? ""}><option value="">全部认证事件</option>{Object.entries(authActions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="认证结果"><select className={styles.select} name="result" defaultValue={filters.result ?? ""}><option value="">全部结果</option><option value="success">成功</option><option value="failure">失败</option></select></Field>
        <Field label="认证开始时间"><input className={styles.input} type="datetime-local" name="since" defaultValue={filters.since ? localTime(filters.since) : ""} /></Field>
        <Field label="认证结束时间"><input className={styles.input} type="datetime-local" name="until" defaultValue={filters.until ? localTime(filters.until) : ""} /></Field>
        <button className={styles.primaryButton} type="submit">查询认证日志</button><button className={styles.button} type="button" onClick={(event) => { event.currentTarget.form?.reset(); updateFilters({ auth_actor: null, auth_target: null, auth_action: null, auth_result: null, auth_since: null, auth_until: null }); }}>重置认证筛选</button>
      </form>
      <small>时间使用本地时区输入；查询包含开始时间、不包含结束时间。</small>
      {data && (
        <div className={id ? styles.twoColumns : undefined}>
          <Box><Table><thead><tr><th>时间</th><th>记录的操作人标识</th><th>认证事件</th><th>目标账号标识</th><th>结果</th><th>详情</th></tr></thead><tbody>{data.items.map((row) => {
            const actorResolved = row.actor_id && row.actor_id !== "system" ? labels.users[row.actor_id]?.name : undefined;
            const targetResolved = row.target_user_id ? labels.users[row.target_user_id]?.name : undefined;
            return (
              <tr key={row.id}>
                <td className="whitespace-nowrap">{formatDateTime(row.occurred_at)}</td>
                <td>{actorResolved ? <EntityLabel name={actorResolved} id={row.actor_id!} /> : authActor(row.actor_id)}</td>
                <td>{row.action === "unrecognized" ? "未识别认证事件" : authActions[row.action]}</td>
                <td>{targetResolved ? <EntityLabel name={targetResolved} id={row.target_user_id!} /> : row.target_user_id ?? "未记录"}</td>
                <td><Badge tone={row.result === "success" ? "green" : row.result === "failure" ? "red" : "gray"}>{authResults[row.result]}</Badge></td>
                <td><button className={styles.button} type="button" onClick={() => updateQuery({ auth_log: row.id })}>查看认证日志</button></td>
              </tr>
            );
          })}</tbody></Table>{!data.items.length && <Empty>没有符合条件的认证日志</Empty>}<Pager page={data.page} total={data.total} change={(next) => updateQuery({ auth_page: String(next), auth_log: null })} /></Box>
          {id && <Box title="认证日志详情" action={<button className={styles.button} type="button" onClick={() => updateQuery({ auth_log: null })}>关闭认证详情</button>}><div className={styles.panelBody}>
            {detail.isFetching && <p role="status">正在读取认证日志详情…</p>}<ErrorBox error={detail.error} retry={() => void detail.refetch()} label="重试认证详情" />
            {item && <><p>来源：认证日志（仅认证与账号管理）</p><p>{tr("事件：{0}", { 0: item.action === "unrecognized" ? "未识别认证事件" : authActions[item.action] })}</p><p>{tr("结果：{0} · {1}", { 0: authResults[item.result], 1: formatDateTime(item.occurred_at) })}</p><p>{tr("记录的操作人标识：{0}", { 0: authActor(item.actor_id) })}</p><p>{tr("记录的目标账号标识：{0}", { 0: item.target_user_id ?? "未记录" })}</p><h3>已记录的变更字段名</h3>{item.changed_fields.length ? <ul>{item.changed_fields.map((field, index) => <li key={`${index}:${field}`}>{field}</li>)}</ul> : <p>没有可展示的变更字段名；不能据此判断是否修改过数据。</p>}{item.metadata_redacted && <Notice>部分来源元数据已隐藏，不显示其原始内容。</Notice>}<p>操作时角色：未记录</p><p>操作理由：未记录</p><p>变更前值：未记录</p><p>变更后值：未记录</p></>}
          </div></Box>}
        </div>
      )}
    </>}
  </>;
}

function SharedLogsPage() {
  const { userId } = useWorkspace();
  const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  const page = pageNumber(query.get("shared_page"));
  const filters: SharedAuditQuery = {
    page, page_size: 10, actor_id: selected(query.get("shared_actor")),
    actor_role: (["student", "teacher", "ta", "admin"].includes(query.get("shared_role") ?? "") ? query.get("shared_role") : undefined) as NonNullable<SharedAuditQuery>["actor_role"],
    result: (["success", "failure", "denied"].includes(query.get("shared_result") ?? "") ? query.get("shared_result") : undefined) as NonNullable<SharedAuditQuery>["result"],
    action_prefix: query.get("shared_action") || undefined,
    target_type: query.get("shared_type") || undefined, target_id: query.get("shared_target") || undefined,
    since: query.get("shared_since") || undefined, until: query.get("shared_until") || undefined,
  };
  const result = useQuery({
    queryKey: ["c-shared-audit", userId, filters],
    queryFn: async () => {
      try { return await api.sharedAuditEvents(filters); }
      catch (error) { if (unauthorized(error)) setDenied(error); throw error; }
    },
    enabled: !denied, ...querySettings,
  });
  const data = !denied && result.isSuccess && !result.isFetching ? result.data : undefined;
  const labels = useAdminLabels({
    userIds: (data?.items ?? []).flatMap((row) => [row.actor_id, row.target_type === "user" ? row.target_id : undefined]),
    courseIds: (data?.items ?? []).filter((row) => row.target_type === "course").map((row) => row.target_id),
    projectIds: (data?.items ?? []).filter((row) => row.target_type === "project").map((row) => row.target_id),
    enabled: Boolean(data?.items.length),
  });
  async function refresh() { if ((await result.refetch()).isSuccess) setDenied(null); }
  const [error, setError] = useState("");
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const type = inputValue(form, "type"), target = inputValue(form, "target");
    if (Boolean(type) !== Boolean(target)) { setError("请同时填写对象类型和标识。"); return; }
    const since = isoTime(inputValue(form, "since")), until = isoTime(inputValue(form, "until"));
    if (since && until && since >= until) { setError("结束时间须晚于开始时间。"); return; }
    setError("");
    updateQuery({shared_action: inputValue(form, "prefix") || null, shared_type: type || null, shared_target: target || null,
      shared_role: inputValue(form, "role") || null, shared_result: inputValue(form, "result") || null,
      shared_since: since || null, shared_until: until || null, shared_page: null});
  }
  return <>
    <Header title="共享服务操作记录"
      action={<button className={styles.button} type="button" disabled={result.isFetching} onClick={() => void refresh()}>刷新操作记录</button>} />
    <ErrorBox error={denied ?? result.error} retry={() => void refresh()} />
    {result.isFetching && <p role="status">正在读取操作记录…</p>}
    {!denied && <>
    <CompactUserSelect label="筛选操作人" value={filters.actor_id || ""} onUnauthorized={setDenied} onChange={(value) => updateQuery({shared_actor: value || null, shared_page: null})}/>
    <form className={styles.filters} key={JSON.stringify([filters.action_prefix, filters.target_type, filters.target_id, filters.actor_role, filters.result, filters.since, filters.until])} onSubmit={search}>
      <Field label="操作时角色"><select className={styles.select} name="role" defaultValue={filters.actor_role || ""}><option value="">全部角色</option>{(["student", "teacher", "ta", "admin"] as const).map((role) => <option key={role} value={role}>{auditRoles[role]}</option>)}</select></Field>
      <Field label="执行结果"><select className={styles.select} name="result" defaultValue={filters.result || ""}><option value="">全部结果</option><option value="success">成功</option><option value="failure">失败</option><option value="denied">拒绝</option></select></Field>
      <Field label="操作前缀"><input className={styles.input} name="prefix" maxLength={120} defaultValue={filters.action_prefix || ""}/></Field>
      <Field label="对象类型"><input className={styles.input} name="type" maxLength={60} defaultValue={filters.target_type || ""}/></Field>
      <Field label="对象标识"><input className={styles.input} name="target" maxLength={120} defaultValue={filters.target_id || ""}/></Field>
      <Field label="起始时间"><input className={styles.input} name="since" type="datetime-local" defaultValue={filters.since ? localTime(filters.since) : ""}/></Field>
      <Field label="截止时间（不含）"><input className={styles.input} name="until" type="datetime-local" defaultValue={filters.until ? localTime(filters.until) : ""}/></Field>
      <button type="submit" className={styles.primaryButton}>查询操作记录</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {data && <Box><Table><thead><tr><th>时间</th><th>操作</th><th>结果</th><th>操作人</th><th>对象</th><th>详情</th></tr></thead><tbody>
      {data.items.map((row) => {
        const actionMeta = describeAuditAction(row.action);
        const actorName = row.actor_id ? labels.users[row.actor_id]?.name : undefined;
        const roleText = row.actor_role ? auditRoles[row.actor_role as keyof typeof auditRoles] ?? row.actor_role : "未记录角色";
        const targetLabel =
          row.target_type === "course"
            ? labels.courses[row.target_id]?.name
            : row.target_type === "project"
              ? labels.projects[row.target_id]?.name
              : row.target_type === "user"
                ? labels.users[row.target_id]?.name
                : undefined;
        const targetTypeLabel = describeAuditTargetType(row.target_type);
        const resultLabel = ({ success: "成功", failure: "失败", denied: "拒绝" } as Record<string, string>)[row.result] ?? row.result;
        return (
          <tr key={row.id}>
            <td className="whitespace-nowrap">{formatDateTime(row.occurred_at)}</td>
            <td>
              <div className="space-y-0.5">
                <strong className="block text-slate-900">{actionMeta.label}</strong>
                <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                  <Badge tone="gray">{actionMeta.category}</Badge>
                  <code>{row.action}</code>
                </span>
              </div>
            </td>
            <td>
              <Badge tone={row.result === "success" ? "green" : row.result === "denied" ? "amber" : "red"}>
                {resultLabel}
              </Badge>
            </td>
            <td>
              {actorName && row.actor_id ? (
                <EntityLabel name={actorName} id={row.actor_id} subtitle={roleText} />
              ) : (
                `${row.actor_id || "系统"} · ${roleText}`
              )}
            </td>
            <td>
              {targetLabel ? (
                <EntityLabel name={targetLabel} id={row.target_id} subtitle={targetTypeLabel} />
              ) : isUuidString(row.target_id) ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-slate-800">{targetTypeLabel}</span>
                  <CopyableId value={row.target_id} />
                </span>
              ) : (
                `${row.target_type} / ${row.target_id}`
              )}
            </td>
            <td>
              <details className={styles.jsonDetails}>
                <summary>查看操作详情</summary>
                <p>执行结果：{resultLabel}</p>
                <p>理由：{row.reason ?? "未记录"}</p>
                <h3>变更前</h3><pre>{row.before === null ? "无可展示的快照" : JSON.stringify(row.before, null, 2)}</pre>
                <h3>变更后</h3><pre>{row.after === null ? "无可展示的快照" : JSON.stringify(row.after, null, 2)}</pre>
                {row.metadata_redacted && <small>仅显示可公开的变更字段。</small>}
              </details>
            </td>
          </tr>
        );
      })}
    </tbody></Table>{!data.items.length && <Empty>没有符合条件的操作记录</Empty>}
    <Pager page={data.page} total={data.total} change={(next) => updateQuery({shared_page: String(next)})}/></Box>}
    </>}
  </>;
}

export function MyAccessRequests() {
  const [open, setOpen] = useState(false);
  return <section className="my-4">
    <button className={styles.button} type="button" aria-expanded={open} onClick={() => setOpen(!open)}>我的访问申请</button>
    {open && <ApplicantPanel />}
  </section>;
}

function ApplicantPanel() {
  const { userId } = useWorkspace();
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<"task" | "evidence" | "project">("task");
  const [denied, setDenied] = useState<CApiError | null>(null);
  const [feedback, setFeedback] = useState("");
  const command = useCommand(setDenied);
  const cache = useQueryClient();
  const list = useQuery({ queryKey: ["c-own-access", userId, page], queryFn: () =>
    readWithAccessCheck(() => api.ownAccessRequests(page), setDenied), enabled: !denied, ...querySettings });
  const data = !denied && list.isSuccess && !list.isFetching ? list.data : undefined;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const projectId = inputValue(form, "project"), resourceId = kind === "project" ? projectId : inputValue(form, "resource");
    const expires = isoTime(inputValue(form, "expiry"));
    if (!expires || Date.parse(expires) <= Date.now()) { setFeedback("请选择未来的截止时间。"); return; }
    const body: Schema["CreateAccessRequest"] = {
      scope: { project_id: projectId, resource_type: kind, resource_id: resourceId, operation: "read" },
      reason: inputValue(form, "reason"), expires_at: expires,
    };
    setFeedback("");
    void command.run(body, (key) => api.requestAccess(body, key), () => {
      target.reset(); setKind("task"); setPage(1); setFeedback("申请已提交，等待管理员审批。");
      void cache.invalidateQueries({ queryKey: ["c-own-access", userId] });
    });
  }
  if (denied) return <ErrorBox error={denied} retry={() => { setDenied(null); void list.refetch(); }} />;
  const idPattern = "[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}";
  return <Box title="申请只读访问"><div className={styles.panelBody}>
    <form onSubmit={submit}><fieldset disabled={command.busy} className={styles.filters}>
      <Field label="申请范围"><select className={styles.select} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="task">任务</option><option value="evidence">证据</option><option value="project">整个项目</option></select></Field>
      <Field label="所属项目 ID"><input className={styles.input} name="project" required pattern={idPattern} /></Field>
      {kind !== "project" && <Field label={kind === "task" ? "任务 ID" : "证据 ID"}><input className={styles.input} name="resource" required pattern={idPattern} /></Field>}
      <Field label="截止时间"><input className={styles.input} type="datetime-local" name="expiry" required /></Field>
      <Field label="申请理由"><textarea className={styles.input} name="reason" maxLength={2000} required /></Field>
      <button className={styles.primaryButton} type="submit">提交只读申请</button>
    </fieldset></form>
    {feedback && <p role="status">{feedback}</p>}<ErrorBox error={command.error ?? list.error} />
    <button className={styles.button} type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>刷新我的申请</button>
    {data && <><ul>{data.items.map((row) => {
      const scope = row.scope, base = `/projects/${scope.project_id}`;
      const href = scope.resource_type === "task" ? `${base}/tasks/${scope.resource_id}` : scope.resource_type === "evidence" ? `${base}/evidence?evidence=${scope.resource_id}` : `${base}/evidence`;
      return <li key={row.id} className="my-2">{targetTypes[scope.resource_type]} {scope.resource_id} · {requestStatuses[row.status]} · {row.reason}
        {row.status === "approved" && <> · {row.approval_expired ? "已到期" : <a className="gp-link" href={href}>查看获批范围</a>}</>}</li>;
    })}</ul>{!data.items.length && <Empty>暂无访问申请</Empty>}<Pager page={page} total={data.total} change={setPage}/></>}
  </div></Box>;
}

function LogsPage() {
  const { query, updateQuery } = useUrlQuery();
  const authentication = query.get("source") === "auth";
  const legacyBusinessFilters = ["log", "action", "actor", "actor_role", "target_type", "target_id", "result", "since", "until", "page"];
  const shared = query.get("source") === "shared" || (!query.has("source") && !legacyBusinessFilters.some((key) => query.has(key)));
  return <>
    <div className={styles.segmentedTabs} aria-label="日志来源">
      <button className={styles.segmentedTab} type="button" aria-pressed={shared} onClick={() => updateQuery({ source: "shared" })}>共享服务操作记录</button>
      <button className={styles.segmentedTab} type="button" aria-pressed={authentication} onClick={() => updateQuery({ source: "auth" })}>认证日志</button>
      <button className={styles.segmentedTab} type="button" aria-pressed={!authentication && !shared} onClick={() => updateQuery({ source: "business" })}>全站业务日志</button>
    </div>
    {authentication ? <AuthLogsPage /> : shared ? <SharedLogsPage /> : <BusinessLogsPage />}
  </>;
}

function costs(value: Record<string, string>) { return Object.entries(value).map(([currency, amount]) => `${currency} ${amount}`).join(" / ") || "无费用样本"; }
function metricCost(value: Record<string, string>, unpricedRequests = 0, requests = 0) {
  const formatted = Object.entries(value).map(([currency, amount]) => `${currency} ${amount}`).join(" · ");
  if (formatted) return formatted;
  if (unpricedRequests > 0) return "未计价";
  return requests > 0 ? "无费用样本" : "—";
}
function number(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function rate(value: number, total: number) { return total ? `${Math.round((value / total) * 100)}%` : "—"; }
function UsageTable({ title, items, formatDimension }: { title: string; items: (Schema["UsageBreakdownDTO"] | Schema["UsageDayDTO"])[]; formatDimension?: (key: string) => ReactNode }) {
  const hasSamples = items.some((item) => item.requests > 0 || item.succeeded > 0 || item.failed > 0 || item.input_tokens > 0 || item.output_tokens > 0 || Object.keys(item.cost_by_currency).length > 0);
  return <Box title={title}>{hasSamples ? <Table><thead><tr><th>维度</th><th>请求数</th><th>成功 / 失败</th><th>输入 / 输出 Token</th><th>费用（按币种）</th></tr></thead><tbody>{items.map((item) => {
    const dimKey = "key" in item ? item.key : item.date;
    return <tr key={dimKey}><td>{formatDimension ? formatDimension(dimKey) : dimKey}</td><td>{item.requests}</td><td>{item.succeeded} / {item.failed}</td><td>{item.input_tokens} / {item.output_tokens}</td><td>{costs(item.cost_by_currency)}{item.unpriced_requests > 0 && ` · ${item.unpriced_requests} 次费用未记录`}{item.incomplete_token_records > 0 && ` · ${item.incomplete_token_records} 次 Token 不完整`}</td></tr>;
  })}</tbody></Table> : <Empty>当前范围没有用量样本</Empty>}</Box>;
}

function UsagePage() {
  const { userId } = useWorkspace(); const { query, updateQuery } = useUrlQuery();
  const [denied, setDenied] = useState<CApiError | null>(null);
  const [usageTab, setUsageTab] = useState<"overview" | "scenarios" | "failures" | "tables">("overview");
  const [scenarioView, setScenarioView] = useState<"table" | "cards">("table");
  const [onlyActiveScenarios, setOnlyActiveScenarios] = useState(false);
  const [trendMode, setTrendMode] = useState<"24h" | "daily">("daily");
  const [trendMetric, setTrendMetric] = useState<"requests" | "tokens" | "cost">("requests");
  const [activeBucketKey, setActiveBucketKey] = useState<string | null>(null);
  const rawDays = Number(query.get("days") ?? 7); const days = rawDays === 30 || rawDays === 90 ? rawDays : 7;
  const filters: UsageQuery = { days, user_id: selected(query.get("user")), feature: query.get("feature") || undefined, model: query.get("model") || undefined };
  const formKey = JSON.stringify([filters.feature, filters.model]);
  const result = useQuery({ queryKey: ["c-governance-usage", userId, filters], queryFn: () => readWithAccessCheck(() => api.usage(filters), setDenied), enabled: !denied, ...querySettings });
  const data = result.isSuccess && !result.isFetching ? result.data : undefined;
  const diagnostics = useQuery({
    queryKey: ["admin-ai-diagnostics", userId, filters],
    queryFn: () => api.workbenchAiDiagnostics(filters),
    enabled: Boolean(!denied && data),
    staleTime: 15_000,
    retry: false,
  });

  if (denied) return <ErrorBox error={denied} retry={() => window.location.reload()} label="重新验证管理权限" />;

  const modelRows = data ? [...data.by_model].sort((left, right) => right.requests - left.requests) : [];
  const featureRows = data ? [...data.by_feature].sort((left, right) => right.requests - left.requests) : [];
  const scenarioEntries = [
    ...usageScenarioDefinitions.map((item) => ({ ...item })),
    ...featureRows
      .filter((row) => !usageScenarioDefinitions.some((def) => def.feature === row.key))
      .map((row) => ({
        key: `extra-${row.key}`,
        label: row.key,
        description: "后端已上报的其他 AI 调用场景",
        feature: row.key,
      })),
  ].sort((left, right) => {
    const leftCount = featureRows.find((r) => r.key === left.feature)?.requests ?? 0;
    const rightCount = featureRows.find((r) => r.key === right.feature)?.requests ?? 0;
    return rightCount - leftCount;
  });
  const maxModelRequests = Math.max(...modelRows.map((item) => item.requests), 1);
  const diag = !result.isError ? diagnostics.data : undefined;
  const maxErrCount = Math.max(...(diag?.error_breakdown.map((e) => e.count) ?? [0]), 1);

  type TrendBucket = {
    key: string;
    axisLabel: string;
    fullLabel: string;
    requests: number;
    succeeded: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costNumeric: number;
    costByCurrency: Record<string, string>;
  };
  const costSum = (map: Record<string, string>) =>
    Object.values(map).reduce((acc, val) => acc + (Number.parseFloat(val) || 0), 0);
  const formatHourAxis = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  };
  const formatHourRange = (iso: string) => {
    const start = new Date(iso);
    if (Number.isNaN(start.getTime())) return iso;
    const end = new Date(start.getTime() + 3600_000);
    const pad = (v: number) => String(v).padStart(2, "0");
    return `${start.getMonth() + 1}/${pad(start.getDate())} ${pad(start.getHours())}:00–${pad(end.getHours())}:00`;
  };
  const trendBuckets: TrendBucket[] =
    trendMode === "24h" && diag?.hourly_24h?.length
      ? diag.hourly_24h.map((slot) => ({
          key: slot.hour_start,
          axisLabel: formatHourAxis(slot.hour_start),
          fullLabel: formatHourRange(slot.hour_start),
          requests: slot.requests,
          succeeded: slot.succeeded,
          failed: slot.failed,
          inputTokens: slot.input_tokens,
          outputTokens: slot.output_tokens,
          totalTokens: slot.input_tokens + slot.output_tokens,
          costNumeric: costSum(slot.cost_by_currency),
          costByCurrency: slot.cost_by_currency,
        }))
      : (data?.daily ?? []).map((item) => ({
          key: item.date,
          axisLabel: item.date.slice(5),
          fullLabel: `${item.date}（UTC）`,
          requests: item.requests,
          succeeded: item.succeeded,
          failed: item.failed,
          inputTokens: item.input_tokens,
          outputTokens: item.output_tokens,
          totalTokens: item.input_tokens + item.output_tokens,
          costNumeric: costSum(item.cost_by_currency),
          costByCurrency: item.cost_by_currency,
        }));
  const trendMetricValue = (bucket: TrendBucket) =>
    trendMetric === "tokens" ? bucket.totalTokens : trendMetric === "cost" ? bucket.costNumeric : bucket.requests;
  const maxTrendValue = Math.max(...trendBuckets.map(trendMetricValue), 1e-9);
  const trendTotalRequests = trendBuckets.reduce((acc, b) => acc + b.requests, 0);
  const trendTotalTokens = trendBuckets.reduce((acc, b) => acc + b.totalTokens, 0);
  const trendStride = trendMode === "24h" ? 4 : days <= 14 ? 1 : days <= 30 ? 5 : 10;
  const defaultBucket =
    [...trendBuckets].reverse().find((b) => b.requests > 0) ?? trendBuckets[trendBuckets.length - 1] ?? null;
  const activeBucket =
    (activeBucketKey ? trendBuckets.find((b) => b.key === activeBucketKey) : null) ?? defaultBucket;
  const formatCompactMetric = (bucket: TrendBucket) => {
    if (trendMetric === "requests") return bucket.requests ? String(bucket.requests) : "";
    if (trendMetric === "tokens") {
      if (!bucket.totalTokens) return "";
      if (bucket.totalTokens >= 1_000_000) return `${(bucket.totalTokens / 1_000_000).toFixed(1)}M`;
      if (bucket.totalTokens >= 1_000) return `${Math.round(bucket.totalTokens / 1_000)}k`;
      return String(bucket.totalTokens);
    }
    return bucket.costNumeric > 0 ? bucket.costNumeric.toFixed(3) : "";
  };

  return <>
    <Header
      title="AI 使用情况"
      action={<button className={styles.button} type="button" onClick={() => { void result.refetch(); void diagnostics.refetch(); }}><RefreshCw size={15} aria-hidden="true" />刷新用量</button>}
    />
    <Box className={styles.usageFilterPanel} title="查询范围" action={<span className={styles.muted}>数据来源：OpenRouter 用量记录</span>}>
      <div className={styles.panelBody}>
        <div className={styles.usageToolbar}>
          <div className={styles.actions} aria-label="时间范围">{[7, 30, 90].map((value) => <button key={value} className={`${styles.button} ${days === value ? styles.primaryButton : ""}`} type="button" aria-pressed={days === value} onClick={() => updateQuery({ days: String(value) })}>{tr("最近 {0} 天", { 0: value })}</button>)}</div>
          <span className={styles.subtle}>{data ? `${formatDateTime(data.since)} — ${formatDateTime(data.until)} UTC` : "正在读取范围…"}</span>
        </div>
        <div className={styles.usageFilterGrid}>
          <CompactUserSelect label="使用者" value={filters.user_id ?? ""} onUnauthorized={setDenied} onChange={(value) => updateQuery({ user: value || null })} />
          <form className={styles.usageInlineForm} key={formKey} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); updateQuery({ feature: inputValue(input, "feature") || null, model: inputValue(input, "model") || null }); }}>
            <Field label="功能">
              <input className={styles.input} name="feature" list="ai-feature-suggestions" maxLength={100} defaultValue={filters.feature ?? ""} placeholder="例如：analyze_implementation" />
            </Field>
            <Field label="模型">
              <input className={styles.input} name="model" list="ai-model-suggestions" maxLength={160} defaultValue={filters.model ?? ""} placeholder="例如：provider/model" />
            </Field>
            <datalist id="ai-feature-suggestions">
              {usageScenarioDefinitions.map((item) => <option key={item.feature} value={item.feature}>{item.label}</option>)}
            </datalist>
            <datalist id="ai-model-suggestions">
              {modelRows.map((item) => <option key={item.key} value={item.key} />)}
            </datalist>
            <div className={styles.usageFormActions}><button className={styles.primaryButton} type="submit"><ListFilter size={15} aria-hidden="true" />查询用量</button><button className={styles.button} type="button" onClick={(event) => { event.currentTarget.form?.reset(); updateQuery({ user: null, feature: null, model: null, days: null }); }}>重置</button></div>
          </form>
        </div>
      </div>
    </Box>

    {result.isFetching && <p role="status">正在读取用量…</p>}<ErrorBox error={result.error} retry={() => void result.refetch()} />

    {data && <>
      <div className={`${styles.metrics} ${styles.usageMetrics}`} aria-label="用量关键指标">
        <Metric label="请求总数" value={number(data.requests)} hint={`${number(data.succeeded)} 次成功 · ${number(data.failed)} 次失败`} icon={Activity} />
        <Metric label="总费用" value={metricCost(data.cost_by_currency, data.unpriced_requests, data.requests)} hint="按币种累计已记录费用" icon={Coins} tone="green" />
        <Metric label="总 Token" value={number(data.input_tokens + data.output_tokens)} hint={`输入 ${number(data.input_tokens)} · 输出 ${number(data.output_tokens)}`} icon={Layers3} tone="blue" />
        <Metric label="成功率" value={rate(data.succeeded, data.requests)} hint={diag ? `平均延迟 ${formatDurationMs(diag.avg_latency_ms)} · P95 ${formatDurationMs(diag.p95_latency_ms)}` : "按请求结果统计"} icon={Gauge} tone={data.requests && data.succeeded / data.requests < 0.8 ? "red" : "blue"} />
        <Metric label="未计价记录" value={number(data.unpriced_requests)} hint={data.unpriced_requests ? "需要补充费用信息" : "计费记录完整"} icon={CircleAlert} tone={data.unpriced_requests ? "amber" : "green"} />
      </div>

      <Box title="用量汇总">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-xs text-slate-600">
          <span>{tr("范围：{0} 至 {1}（UTC 日历窗口）", { 0: formatDateTime(data.since), 1: formatDateTime(data.until) })}</span>
          <strong className="text-slate-900">{tr("请求总数：{0} · 成功：{1} · 失败：{2}", { 0: data.requests, 1: data.succeeded, 2: data.failed })}</strong>
          <span>{tr("输入 Token：{0} · 输出 Token：{1}", { 0: data.input_tokens, 1: data.output_tokens })}</span>
          <strong className="text-emerald-700">{tr("费用：{0}", { 0: costs(data.cost_by_currency) })}</strong>
          {data.unpriced_requests > 0 && <Badge tone="amber">{data.unpriced_requests} 次无完整计费</Badge>}
          {data.incomplete_token_records > 0 && <Badge tone="amber">{data.incomplete_token_records} 次 Token 不完整</Badge>}
        </div>
      </Box>

      <div className={styles.segmentedTabs} role="tablist" aria-label="AI 用量分析视图">
        {(
          [
            ["overview", "概览与趋势"],
            ["scenarios", "场景与排行"],
            ["failures", data.failed > 0 ? `失败与排障 (${data.failed})` : "失败与排障"],
            ["tables", "明细报表"],
          ] as const
        ).map(([tabKey, label]) => (
          <button
            key={tabKey}
            type="button"
            role="tab"
            aria-selected={usageTab === tabKey}
            aria-pressed={usageTab === tabKey}
            className={styles.segmentedTab}
            onClick={() => setUsageTab(tabKey)}
          >
            {label}
          </button>
        ))}
      </div>

      {usageTab === "overview" && (
        <>
          <div className={styles.twoColumns}>
        <Box
          title="调用趋势"
          action={
            <div className={styles.usageChartControls}>
              <div className={styles.usageTrendTabs} role="group" aria-label="趋势时间范围">
                {diag?.hourly_24h && (
                  <button
                    type="button"
                    className={styles.usageTrendTab}
                    aria-pressed={trendMode === "24h"}
                    onClick={() => {
                      setTrendMode("24h");
                      setActiveBucketKey(null);
                    }}
                  >
                    24 小时
                  </button>
                )}
                {([7, 30, 90] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={styles.usageTrendTab}
                    aria-pressed={trendMode === "daily" && days === value}
                    onClick={() => {
                      setTrendMode("daily");
                      setActiveBucketKey(null);
                      if (days !== value) updateQuery({ days: String(value) });
                    }}
                  >
                    {tr("{0} 天", { 0: value })}
                  </button>
                ))}
              </div>
              <div className={styles.usageTrendTabs} role="group" aria-label="趋势指标">
                {(
                  [
                    ["requests", "请求数"],
                    ["tokens", "Token"],
                    ["cost", "费用"],
                  ] as const
                ).map(([metricKey, label]) => (
                  <button
                    key={metricKey}
                    type="button"
                    className={styles.usageTrendTab}
                    aria-pressed={trendMetric === metricKey}
                    onClick={() => setTrendMetric(metricKey)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          <div className={styles.panelBody}>
            <div className={styles.chartSummary}>
              <span><strong>{number(trendTotalRequests)}</strong> 次请求</span>
              <span><strong>{number(trendTotalTokens)}</strong> Token</span>
              {trendMetric === "requests" && (
                <span className={styles.usageTrendLegend}>
                  <span><i className={styles.usageLegendDotSuccess} />成功</span>
                  <span><i className={styles.usageLegendDotFail} />失败</span>
                </span>
              )}
            </div>
            {activeBucket && trendTotalRequests > 0 && (
              <div className={styles.usageTrendInspector} aria-live="polite">
                <div>
                  <strong>{activeBucket.fullLabel}</strong>
                  <span className="ml-2">
                    请求 <strong>{number(activeBucket.requests)}</strong>（成功 <span className="font-semibold text-blue-700">{number(activeBucket.succeeded)}</span> / 失败 <span className="font-semibold text-rose-600">{number(activeBucket.failed)}</span> · 成功率 {rate(activeBucket.succeeded, activeBucket.requests)}）
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span>Token <strong>{number(activeBucket.totalTokens)}</strong>（入 {number(activeBucket.inputTokens)} / 出 {number(activeBucket.outputTokens)}）</span>
                  <span>费用 <strong>{costs(activeBucket.costByCurrency)}</strong></span>
                </div>
              </div>
            )}
            {trendTotalRequests === 0 ? <Empty>当前筛选范围没有用量记录</Empty> : (
              <div className={styles.usageChart} role="region" aria-label={trendMode === "24h" ? "近 24 小时按小时统计的 AI 调用趋势" : "按 UTC 日期统计的请求数趋势"}>
                {trendBuckets.map((bucket, idx) => {
                  const value = trendMetricValue(bucket);
                  const pct = value > 0 ? Math.max(8, (value / maxTrendValue) * 100) : 0;
                  const failPct = bucket.requests > 0 ? (bucket.failed / bucket.requests) * 100 : 0;
                  const successPct = bucket.requests > 0 ? 100 - failPct : 0;
                  const showLabel = idx % trendStride === 0 || idx === trendBuckets.length - 1;
                  const isActive = activeBucket?.key === bucket.key;
                  const showTopValue = (trendMode === "24h" ? isActive || value > 0 : days <= 30) && value > 0;
                  return (
                    <button
                      type="button"
                      className={styles.usageBarColumn}
                      data-active={isActive}
                      key={bucket.key}
                      aria-label={`${bucket.fullLabel}：${bucket.requests} 次请求，成功 ${bucket.succeeded}，失败 ${bucket.failed}`}
                      onMouseEnter={() => setActiveBucketKey(bucket.key)}
                      onFocus={() => setActiveBucketKey(bucket.key)}
                      onClick={() => setActiveBucketKey(bucket.key)}
                    >
                      <div className={styles.usageBarValue}>{showTopValue ? formatCompactMetric(bucket) : ""}</div>
                      <div className={styles.usageBarTrack}>
                        {trendMetric === "requests" ? (
                          <div className={styles.usageBarStack} style={{ height: `${pct}%` }}>
                            {bucket.failed > 0 && (
                              <div className={styles.usageBarFailSegment} style={{ height: `${failPct}%` }} />
                            )}
                            {bucket.succeeded > 0 && (
                              <div className={styles.usageBarSuccessSegment} style={{ height: `${successPct}%` }} />
                            )}
                          </div>
                        ) : (
                          <div className={styles.usageBar} style={{ height: `${pct}%` }} />
                        )}
                      </div>
                      <span>{showLabel ? bucket.axisLabel : ""}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Box>
        <Box title="数据质量与延迟诊断" action={<Zap size={18} aria-hidden="true" color="#b77a02" />}>
          <div className={styles.panelBody}>
            <div className={styles.qualityRow}><span>成功请求</span><strong>{number(data.succeeded)}</strong><div className={styles.qualityTrack}><div className={styles.qualitySuccess} style={{ width: `${data.requests ? (data.succeeded / data.requests) * 100 : 0}%` }} /></div></div>
            <div className={styles.qualityRow}><span>失败请求</span><strong>{number(data.failed)}</strong><div className={styles.qualityTrack}><div className={styles.qualityFailure} style={{ width: `${data.requests ? (data.failed / data.requests) * 100 : 0}%` }} /></div></div>
            <div className={styles.qualityRow}><span>Token 不完整</span><strong>{number(data.incomplete_token_records)}</strong><div className={styles.qualityTrack}><div className={styles.qualityWarning} style={{ width: `${data.requests ? (data.incomplete_token_records / data.requests) * 100 : 0}%` }} /></div></div>
            {diag && (
              <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-center text-xs">
                <div><span className="block text-slate-500">平均延迟</span><strong>{formatDurationMs(diag.avg_latency_ms)}</strong></div>
                <div><span className="block text-slate-500">P50</span><strong>{formatDurationMs(diag.p50_latency_ms)}</strong></div>
                <div><span className="block text-slate-500">P95</span><strong>{formatDurationMs(diag.p95_latency_ms)}</strong></div>
              </div>
            )}
            <p className={styles.chartNote}>{data.aggregation_scope}</p>
          </div>
        </Box>
      </div>

          <div className={styles.equalColumns}>
            <Box title="模型调用分析" action={<Badge tone="purple">OpenRouter</Badge>}>
              <div className={styles.panelBody}>
                {!modelRows.length ? <Empty>当前范围没有模型调用记录</Empty> : <div className={styles.breakdownList}>{modelRows.map((item) => <div className={styles.breakdownRow} key={item.key}><div className={styles.breakdownHeader}><span className={styles.breakdownName}>{item.key}</span><strong>{number(item.requests)}</strong></div><div className={styles.breakdownTrack}><div className={styles.breakdownFill} style={{ width: `${(item.requests / maxModelRequests) * 100}%` }} /></div><div className={styles.breakdownMeta}><span>{rate(item.succeeded, item.requests)} 成功率</span><span>{number(item.input_tokens + item.output_tokens)} Token</span><span>{costs(item.cost_by_currency)}</span></div></div>)}</div>}
              </div>
            </Box>

            {diag && (
              <Box
                title="GitHub 活动 AI 摘要队列"
                action={<Badge tone={diag.summary_jobs.failed > 0 ? "amber" : "blue"}>activity-summary</Badge>}
              >
                <div className={styles.panelBody}>
                  <div className={styles.bindingMatrix}>
                    <div className={styles.bindingItem}><span>累计生成摘要</span><strong>{diag.summary_jobs.total}</strong></div>
                    <div className={styles.bindingItem}><span>待人工确认</span><strong>{diag.summary_jobs.needs_human_review}</strong></div>
                    <div className={styles.bindingItem}><span>排队处理中</span><strong>{diag.summary_jobs.pending}</strong></div>
                    <div className={styles.bindingItem}><span>生成失败</span><strong className={diag.summary_jobs.failed > 0 ? "text-rose-700" : ""}>{diag.summary_jobs.failed}</strong></div>
                  </div>
                  <p className={styles.chartNote}>所有提交级 AI 摘要结果均标为待人工确认，不自动改写正式任务或证据状态。</p>
                </div>
              </Box>
            )}
          </div>
        </>
      )}

      {usageTab === "scenarios" && (
        <>
          <Box
            title="业务场景分布"
            action={
              <div className={styles.usageChartControls}>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={onlyActiveScenarios}
                    onChange={(event) => setOnlyActiveScenarios(event.target.checked)}
                  />
                  仅看有调用
                </label>
                <div className={styles.usageTrendTabs} role="group" aria-label="场景视图切换">
                  <button type="button" className={styles.usageTrendTab} aria-pressed={scenarioView === "table"} onClick={() => setScenarioView("table")}>表格</button>
                  <button type="button" className={styles.usageTrendTab} aria-pressed={scenarioView === "cards"} onClick={() => setScenarioView("cards")}>卡片</button>
                </div>
                <Badge tone="blue">按方案映射</Badge>
              </div>
            }
          >
            {(() => {
              const visibleScenarios = onlyActiveScenarios
                ? scenarioEntries.filter((scenario) => (featureRows.find((row) => row.key === scenario.feature)?.requests ?? 0) > 0)
                : scenarioEntries;
              const compactTok = (tok: number) =>
                tok >= 1_000_000 ? `${(tok / 1_000_000).toFixed(2)}M` : tok >= 10_000 ? `${(tok / 1_000).toFixed(1)}k` : number(tok);
              if (!visibleScenarios.length) {
                return <div className={styles.panelBody}><Empty>当前筛选范围暂无产生调用的业务场景</Empty></div>;
              }
              return scenarioView === "cards" ? (
                <div className={styles.scenarioGrid} aria-label="业务场景用量概览">{visibleScenarios.map((scenario, index) => {
                  const item = featureRows.find((row) => row.key === scenario.feature);
                  const hasData = Boolean(item && item.requests > 0);
                  const totalTok = item ? item.input_tokens + item.output_tokens : 0;
                  return <article className={styles.scenarioCard} data-has-data={hasData} key={`${scenario.key}-card`}>
                    <div className={styles.scenarioCardTop}><span className={styles.scenarioIndex}>{String(index + 1).padStart(2, "0")}</span><Badge tone={hasData ? "green" : "gray"}>{hasData ? "有记录" : "暂无样本"}</Badge></div>
                    <h3>{scenario.label}</h3><p>{scenario.description}</p>
                    <div className={styles.scenarioStats}>
                      <div><strong>{item ? number(item.requests) : "—"}</strong><span>请求</span></div>
                      <div><strong>{item ? rate(item.succeeded, item.requests) : "—"}</strong><span>成功率</span></div>
                      <div title={item ? number(totalTok) : undefined}><strong>{item ? compactTok(totalTok) : "—"}</strong><span>Token</span></div>
                    </div>
                  </article>;
                })}</div>
              ) : (
                <Table><thead><tr><th>业务场景</th><th>用途</th><th>请求</th><th>成功率</th><th>Token</th><th>费用</th></tr></thead><tbody>{visibleScenarios.map((scenario) => {
                  const item = featureRows.find((row) => row.key === scenario.feature);
                  return <tr key={scenario.key}><td><strong>{scenario.label}</strong><div className={styles.rowMeta}>{item ? `功能键：${scenario.feature}` : scenario.feature === "match_evidence" ? "群聊同步本身不调用模型" : "当前范围暂无调用"}</div></td><td>{scenario.description}</td><td>{item ? number(item.requests) : "—"}</td><td>{item ? rate(item.succeeded, item.requests) : "—"}</td><td>{item ? number(item.input_tokens + item.output_tokens) : "—"}</td><td>{item ? costs(item.cost_by_currency) : "—"}</td></tr>;
                })}</tbody></Table>
              );
            })()}
            <div className={styles.panelBody}><p className={styles.chartNote}>群聊记录同步属于来源接入，会记录同步结果但不会产生 OpenRouter 费用。只有群聊内容进入活动摘要或证据匹配等 AI 流程后，才会计入模型用量。</p></div>
          </Box>

          {diag && (
            <div className={styles.equalColumns}>
              <Box title="高消耗项目 Top 排行">
                {diag.top_projects.length ? (
                  <Table>
                    <thead><tr><th>项目 / 课程</th><th>请求（失败）</th><th>总 Token</th><th>费用</th></tr></thead>
                    <tbody>
                      {diag.top_projects.map((p) => (
                        <tr key={String(p.project_id ?? p.project_name)}>
                          <td><EntityLabel name={p.project_name} id={p.project_id} subtitle={p.course_code} /></td>
                          <td>{p.requests}（<span className={p.failed ? "text-rose-600" : ""}>{p.failed}</span>）</td>
                          <td>{number(p.total_tokens)}</td>
                          <td>{costs(p.cost_by_currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : <Empty>当前范围暂无项目级归因样本</Empty>}
              </Box>
              <Box title="高消耗用户 Top 排行">
                {diag.top_users.length ? (
                  <Table>
                    <thead><tr><th>用户</th><th>请求（失败）</th><th>总 Token</th><th>费用</th></tr></thead>
                    <tbody>
                      {diag.top_users.map((u) => (
                        <tr key={String(u.user_id ?? u.user_name)}>
                          <td><EntityLabel name={u.user_name} id={u.user_id} subtitle={u.role} /></td>
                          <td>{u.requests}（<span className={u.failed ? "text-rose-600" : ""}>{u.failed}</span>）</td>
                          <td>{number(u.total_tokens)}</td>
                          <td>{costs(u.cost_by_currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : <Empty>当前范围暂无用户级归因样本</Empty>}
              </Box>
            </div>
          )}
        </>
      )}

      {usageTab === "failures" && (
        <>
          {!diag ? (
            <Box title="失败与排障"><div className={styles.panelBody}><Empty>正在读取失败诊断或当前环境未启用诊断接口</Empty></div></Box>
          ) : (
            <>
              <Box
                title="失败错误码归因榜"
                action={
                  <Badge tone={diag.failed > 0 ? "red" : "green"}>
                    {diag.failed > 0 ? `${diag.failed} 次失败` : "零失败"}
                  </Badge>
                }
              >
                <div className={styles.panelBody}>
                  {!diag.error_breakdown.length ? (
                    <Empty>当前范围无失败调用记录</Empty>
                  ) : (
                    <div className={styles.errorRankList}>
                      {diag.error_breakdown.map((err) => (
                        <div key={err.error_code} className={styles.errorRankRow}>
                          <div className={styles.errorRankHead}>
                            <span className="inline-flex items-center gap-1.5 font-mono text-rose-800">
                              <AlertTriangle size={13} />
                              {err.error_code}
                            </span>
                            <span className="text-slate-600">
                              <strong className="text-slate-900">{err.count}</strong> 次 · 最近 {formatDateTime(err.last_seen_at ?? undefined)}
                            </span>
                          </div>
                          <div className={styles.errorRankTrack}>
                            <div className={styles.errorRankFill} style={{ width: `${Math.max(8, Math.round((err.count / maxErrCount) * 100))}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Box>

              <Box title="最近失败调用明细">
                {diag.recent_failures.length > 0 ? (
                  <Table>
                    <thead><tr><th>时间</th><th>功能</th><th>模型</th><th>错误码</th><th>延迟</th><th>用户</th><th>项目</th></tr></thead>
                    <tbody>
                      {diag.recent_failures.map((item) => (
                        <tr key={item.id}>
                          <td>{formatDateTime(item.occurred_at)}</td>
                          <td>
                            <strong className="block text-slate-900">{aiFeatureLabels[item.feature] ?? item.feature}</strong>
                            <code className="text-[11px] text-slate-500">{item.feature}</code>
                          </td>
                          <td><code>{item.model || "—"}</code></td>
                          <td><Badge tone="red">{item.error_code || "UNKNOWN"}</Badge></td>
                          <td>{formatDurationMs(item.latency_ms)}</td>
                          <td>{item.user_name}</td>
                          <td>{item.project_name || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <div className={styles.panelBody}><Empty>当前范围暂无失败调用明细</Empty></div>
                )}
              </Box>
            </>
          )}
        </>
      )}

      {usageTab === "tables" && (
        <div className={styles.equalColumns}>
          <UsageTable
            title="按功能明细"
            items={data.by_feature}
            formatDimension={(key) =>
              aiFeatureLabels[key] ? (
                <span>
                  <strong className="block text-slate-900">{aiFeatureLabels[key]}</strong>
                  <code className="text-[11px] text-slate-500">{key}</code>
                </span>
              ) : (
                <code>{key}</code>
              )
            }
          />
          <UsageTable title="按日期明细" items={data.daily} />
        </div>
      )}
    </>}
  </>;
}

export function GovernanceApiPage({ screen }: { screen: "courses" | "logs" | "ai-usage" | "access-requests" }) {
  const { userId } = useWorkspace();
  return <div className={styles.page} key={`${userId}:${screen}`}>{screen === "courses" ? <CoursesPage /> : screen === "logs" ? <LogsPage /> : screen === "ai-usage" ? <UsagePage /> : <AccessPage />}</div>;
}
