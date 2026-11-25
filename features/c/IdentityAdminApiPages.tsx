"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileSpreadsheet, KeyRound, LogOut, ShieldAlert, Upload } from "lucide-react";
import { EmptyState, PageHeader, Panel } from "@/components/common";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ApiError, authClient } from "@/lib/api/auth-client";
import {
  cIdentityClient,
  type BulkImportResponse,
  type IdentityAdminPage,
  type IdentityAdminUser,
  type IdentityTeacherApplication,
  type NewIdentityAccount,
  type TeacherApplicationStatus,
} from "@/lib/api/c-identity-client";
import { createGovernanceClient } from "@/lib/api/c-governance-client";
import { CopyableId, formatRelativeTime, isUuidString } from "@/features/c/AdminPrimitives";
import { Badge, formatDateTime } from "@/features/governance/primitives";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import styles from "@/features/governance/governance.module.css";
import { useUrlQuery } from "./use-url-query";
import { tr } from "@/lib/i18n/tr";

const governanceClient = createGovernanceClient();
const control = "rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50";
const buttonControl = `${control} ${styles.button}`;
const inputControl = `${control} ${styles.input}`;
const applicationStatuses = { pending: "待审核", approved: "已通过", rejected: "已拒绝", all: "全部状态" } as const;
const roleLabels = { student: "学生", teacher: "教师", ta: "助教", admin: "管理员" } as const;
const accountStatusLabels = { enabled: "可用", disabled: "已停用" } as const;
const emailFilterLabels = { true: "已验证", false: "待验证" } as const;

const SAMPLE_CSV = [
  "identity,name,username,schoolEmail,studentId,college,submitForReview",
  "student,张三,zhangsan,1240000001@student.must.edu.mo,1240000001,创新工程学院,false",
  "teacher,李老师,li.teacher,li.teacher@must.edu.mo,,创新工程学院,true",
].join("\n");

function parseCsvRows(raw: string): NewIdentityAccount[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const firstCols = lines[0].split(",").map((col) => col.trim().toLowerCase());
  const hasHeader = firstCols.includes("schoolemail") || firstCols.includes("username") || firstCols.includes("name");
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const parts = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    const [identityRaw, name = "", username = "", schoolEmail = "", studentId = "", college = "", submitRaw = ""] = parts;
    const identity = identityRaw === "teacher" ? "teacher" : "student";
    return {
      identity,
      name,
      username,
      schoolEmail,
      studentId: studentId || undefined,
      college: college || undefined,
      submitForReview: identity === "teacher" && ["true", "1", "yes", "是"].includes(submitRaw.toLowerCase()),
    };
  });
}

function normalizedPage(value: string | null) {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1;
}
function normalizedPageSize(value: string | null): 10 | 20 | 50 {
  const n = Number(value ?? 10);
  return n === 20 || n === 50 ? n : 10;
}
function teacherStatus(value: string | null): TeacherApplicationStatus {
  return value && Object.hasOwn(applicationStatuses, value) ? (value as TeacherApplicationStatus) : "pending";
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
  const scope = teachers ? `${teacherStatus(query.get("status"))}:${normalizedPage(query.get("page"))}:${query.get("q") ?? ""}` : "directory";
  return <IdentityAdminContent key={`${userId}:${teachers}:${scope}`} teachers={teachers} userId={userId} />;
}

function IdentityAdminContent({ teachers, userId }: { teachers: boolean; userId: string }) {
  const [accessBlocked, setAccessBlocked] = useState(false);
  const { query, updateQuery } = useUrlQuery();
  const page = normalizedPage(query.get("page"));
  const pageSize = normalizedPageSize(query.get("pageSize"));
  const applicationStatus = teacherStatus(query.get("status"));
  const teacherQ = query.get("q") ?? "";
  const filters = new URLSearchParams({ page: String(page) });
  if (!teachers) {
    if (pageSize !== 10) filters.set("pageSize", String(pageSize));
    for (const key of ["q", "role", "status", "college", "emailVerified"]) {
      const val = query.get(key);
      if (val) filters.set(key, val);
    }
  }

  const result = useQuery<IdentityAdminPage<IdentityAdminUser | IdentityTeacherApplication>>({
    queryKey: ["c-identity-admin", userId, teachers, filters.toString(), applicationStatus, teacherQ],
    queryFn: () =>
      teachers
        ? cIdentityClient.applications(page, applicationStatus, { q: teacherQ.trim() || undefined })
        : cIdentityClient.users(filters),
    enabled: !accessBlocked,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const data = !accessBlocked ? result.data : undefined;
  const [selectedIdState, setSelectedIdState] = useState<string | null>(null);
  const [acknowledgedVersion, setAcknowledgedVersion] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [bulkReport, setBulkReport] = useState<BulkImportResponse | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const locked = useRef(false);
  const selectedTriggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedId = teachers ? selectedIdState : query.get("user");
  const selected = data?.items.find((row) => row.id === selectedId);
  const selectionChanged = Boolean(selected && recordVersion(selected) !== acknowledgedVersion);

  // Progressive 360° telemetry for selected user drawer; degrades silently in fixture tests.
  const user360 = useQuery({
    queryKey: ["admin-user-360", userId, selected?.id],
    queryFn: () => governanceClient.workbenchUserProfile(selected!.id),
    enabled: Boolean(!teachers && selected && isUuidString(selected.id) && !accessBlocked),
    staleTime: 15_000,
    retry: false,
  });

  useEffect(() => {
    if (!accessBlocked && result.error instanceof ApiError && [401, 403].includes(result.error.status)) {
      setAccessBlocked(true);
      if (teachers) setSelectedIdState(null);
      else if (query.get("user")) updateQuery({ user: null });
      setAcknowledgedVersion(null);
      setReason("");
      setConflict(false);
      setFeedback("");
    }
  }, [accessBlocked, result.error, teachers, query, updateQuery]);

  useEffect(() => {
    if (!result.isError || !selectedId || (result.error instanceof ApiError && [401, 403].includes(result.error.status))) return;
    if (teachers) setSelectedIdState(null);
    else updateQuery({ user: null });
    setAcknowledgedVersion(null);
    setReason("");
    setConflict(false);
  }, [result.error, result.isError, selectedId, teachers, updateQuery]);

  useEffect(() => {
    if (!teachers && data && selectedId && !selected) {
      updateQuery({ user: null });
      setAcknowledgedVersion(null);
      setReason("");
      setConflict(false);
      setFeedback("这条记录不在当前结果中，请调整筛选后重试。");
    }
  }, [data, selected, selectedId, teachers, updateQuery]);

  useEffect(() => {
    if (selected && acknowledgedVersion === null) setAcknowledgedVersion(recordVersion(selected));
  }, [selected, acknowledgedVersion]);

  useEffect(() => {
    if (selected && "applicationVersion" in selected && selected.status !== "pending" && reason) {
      setReason("");
      setConflict(false);
    }
  }, [selected, reason]);

  function clearSelection() {
    if (teachers) setSelectedIdState(null);
    else updateQuery({ user: null });
    setAcknowledgedVersion(null);
    setReason("");
    setRevokeReason("");
    setRevokeOpen(false);
    setConflict(false);
  }

  function selectRow(row: IdentityAdminUser | IdentityTeacherApplication, trigger?: HTMLButtonElement | null) {
    if (!teachers && trigger) selectedTriggerRef.current = trigger;
    if (selectedId !== row.id) {
      setReason("");
      setRevokeReason("");
      setRevokeOpen(false);
    }
    if (teachers) setSelectedIdState(row.id);
    else updateQuery({ user: row.id });
    setAcknowledgedVersion(recordVersion(row));
    setConflict(false);
    setFeedback("");
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

  const activeFilters = !teachers
    ? (
        [
          ["q", "搜索", query.get("q")],
          ["college", "学院", query.get("college")],
          ["role", "角色", query.get("role") ? roleLabel(query.get("role")!) : null],
          ["status", "状态", query.get("status") ? accountStatusLabel(query.get("status")!) : null],
          ["emailVerified", "邮箱验证", query.get("emailVerified") ? emailFilterLabels[query.get("emailVerified") as "true" | "false"] : null],
        ] as const
      ).filter(([, , value]) => value)
    : [];

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || locked.current) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "").trim();
    const teacher = value("identity") === "teacher";
    locked.current = true;
    setPending(true);
    setFeedback("");
    setCreateFieldErrors({});
    try {
      await cIdentityClient.create(
        {
          identity: teacher ? "teacher" : "student",
          submitForReview: teacher || undefined,
          name: value("name"),
          username: value("username"),
          schoolEmail: value("schoolEmail"),
          studentId: value("studentId") || undefined,
          college: value("college") || undefined,
        },
        userId,
      );
      setCreating(false);
      setCreateFieldErrors({});
      setFeedback(
        teacher
          ? "账号已创建，教师申请已提交审核。审核通过后获得教师权限。"
          : "账号已创建。本人可用学校邮箱通过“忘记密码”设置登录密码。",
      );
      await result.refetch();
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        setAccessBlocked(true);
        setCreating(false);
        clearSelection();
      }
      setCreateFieldErrors(
        error instanceof ApiError
          ? Object.fromEntries(Object.entries(error.fieldErrors).map(([key, val]) => [key, String(val)]))
          : {},
      );
      setFeedback(
        error instanceof ApiError && error.status === 409
          ? "用户名或学校邮箱已登记，请核对后再提交。"
          : message(error, "form"),
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  async function runBulkImport(dryRun: boolean) {
    if (bulkBusy) return;
    const rows = parseCsvRows(csvText);
    if (!rows.length) {
      setFeedback("请先输入或上传至少一行有效的 CSV 用户数据。");
      return;
    }
    setBulkBusy(true);
    setFeedback("");
    try {
      const report = await cIdentityClient.bulkImport({ dryRun, rows }, userId);
      setBulkReport(report);
      if (!dryRun) {
        setFeedback(`批量导入完成：成功创建 ${report.createdCount} 个账号，失败 ${report.invalidCount} 行。`);
        await result.refetch();
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        setAccessBlocked(true);
        setBulkOpen(false);
      }
      setFeedback(message(error, "form"));
    } finally {
      setBulkBusy(false);
    }
  }

  function downloadSampleCsv() {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "groupproof-users-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleCsvFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setBulkReport(null);
  }

  async function decide(decision: "approve" | "reject" | "disable" | "enable") {
    if (!selected || !reason.trim() || locked.current || conflict || selectionChanged) return;
    locked.current = true;
    setPending(true);
    setFeedback("");
    try {
      let saved = "决定已保存。";
      if (decision === "disable" && "canDisable" in selected) {
        const receipt = await cIdentityClient.disable(selected, reason.trim(), userId);
        if (receipt.inboxNotified === true) saved = "账号已停用，停用原因已写入该账号的站内收件箱。";
        if (receipt.inboxNotified === false) saved = "账号已停用，站内通知服务尚未接入。";
      } else if (decision === "enable" && "canDisable" in selected && selected.status === "disabled") {
        await cIdentityClient.enable(selected, reason.trim(), userId);
        saved = "账号已恢复，可重新登录。";
      } else if ((decision === "approve" || decision === "reject") && "applicationVersion" in selected && selected.status === "pending") {
        await cIdentityClient.review(selected, decision, reason.trim(), userId);
      } else {
        return;
      }
      clearSelection();
      setFeedback(saved);
      await result.refetch();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        clearSelection();
        setFeedback("这条记录已不存在，详情已关闭。");
        await result.refetch();
      } else {
        setFeedback(message(error));
        if (error instanceof ApiError && error.status === 409) setConflict(true);
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          setAccessBlocked(true);
          clearSelection();
        }
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  async function forceRevokeSessions() {
    if (!selected || !revokeReason.trim() || revokeBusy) return;
    setRevokeBusy(true);
    setFeedback("");
    try {
      const res = await governanceClient.workbenchRevokeUserSessions(selected.id, revokeReason.trim());
      setRevokeReason("");
      setRevokeOpen(false);
      setFeedback(`已强制下线 ${res.revoked_count} 个活跃会话，目标账号需重新登录。`);
      await user360.refetch();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "强制下线失败，请重试。");
    } finally {
      setRevokeBusy(false);
    }
  }

  async function refresh() {
    if (accessBlocked) {
      try {
        const session = await authClient.session();
        if (!session.authenticated || session.user?.id !== userId) {
          window.location.reload();
          return;
        }
      } catch {
        setFeedback("暂时无法验证登录状态，请重新登录后再试。");
        return;
      }
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

  const profileData = user360.data;
  const teacherAppSelected = teachers && selected && "applicationVersion" in selected ? selected : null;
  const teacherMismatch = Boolean(
    teacherAppSelected &&
      ((teacherAppSelected.submittedName && teacherAppSelected.submittedName !== teacherAppSelected.name) ||
        (teacherAppSelected.submittedEmailDomain && teacherAppSelected.submittedEmailDomain !== teacherAppSelected.emailDomain)),
  );

  return (
    <div className={`${styles.page} ${styles.identityPage}`}>
      <PageHeader
        title={teachers ? "教师审核" : "用户管理"}
        actions={
          !teachers ? (
            <div className={styles.identityHeaderActions}>
              <button type="button" className={buttonControl} disabled={pending || result.isFetching} onClick={() => void refresh()}>
                刷新列表
              </button>
              <button
                type="button"
                className={buttonControl}
                disabled={pending}
                onClick={() => {
                  setBulkOpen(!bulkOpen);
                  setCreating(false);
                  setBulkReport(null);
                  setFeedback("");
                }}
              >
                <FileSpreadsheet size={15} />
                {bulkOpen ? "收起批量导入" : "批量导入 CSV"}
              </button>
              <button
                type="button"
                className={`${buttonControl} ${styles.primaryButton}`}
                disabled={pending}
                aria-expanded={creating}
                onClick={() => {
                  setCreating(!creating);
                  setBulkOpen(false);
                  setCreateFieldErrors({});
                  setFeedback("");
                }}
              >
                {creating ? "取消新增" : "新增账号"}
              </button>
            </div>
          ) : (
            <div className={styles.identityHeaderActions}>
              <button className={buttonControl} type="button" disabled={pending || result.isFetching} onClick={() => void refresh()}>
                刷新列表
              </button>
            </div>
          )
        }
      />

      {teachers && (
        <section className={styles.toolbarPanel}>
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className={styles.segmentedTabs} role="tablist" aria-label="快捷状态视图">
              {(["pending", "approved", "rejected", "all"] as const).map((statusKey) => (
                <button
                  key={statusKey}
                  type="button"
                  role="tab"
                  aria-selected={applicationStatus === statusKey}
                  className={styles.segmentedTab}
                  disabled={pending}
                  onClick={() => updateQuery({ status: statusKey, page: null })}
                >
                  {applicationStatuses[statusKey]}
                </button>
              ))}
            </div>
            <form
              className={styles.toolbar}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                updateQuery({ status: String(form.get("status")), q: String(form.get("q") ?? "").trim() || null, page: null });
              }}
            >
              <label className={styles.fieldInline}>
                关键词
                <input
                  className={inputControl}
                  name="q"
                  placeholder="姓名、学院或邮箱"
                  defaultValue={teacherQ}
                  disabled={pending}
                />
              </label>
              <label className={styles.fieldInline}>
                审核状态
                <select className={`${inputControl} block`} name="status" defaultValue={applicationStatus} disabled={pending}>
                  {Object.entries(applicationStatuses).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button className={`${buttonControl} ${styles.primaryButton}`} disabled={pending}>
                筛选申请
              </button>
            </form>
          </div>
        </section>
      )}

      {!teachers && creating && (
        <form className={`${styles.formGrid} ${styles.identityCreateForm}`} onSubmit={createAccount}>
          <label className={styles.field}>
            身份
            <select className={inputControl} name="identity" aria-label="身份" disabled={pending}>
              <option value="student">学生</option>
              <option value="teacher">教师</option>
            </select>
          </label>
          {(
            [
              ["name", "姓名", 120],
              ["username", "用户名", 80],
              ["schoolEmail", "学校邮箱", 255],
              ["studentId", "学号（选填）", 80],
              ["college", "学院（选填）", 160],
            ] as const
          ).map(([key, label, length]) => {
            const fieldId = `identity-create-${key}`;
            const fieldError = createFieldErrors[key];
            return (
              <div className={styles.field} key={key}>
                <label htmlFor={fieldId}>{label}</label>
                <input
                  id={fieldId}
                  className={inputControl}
                  name={key}
                  type={key === "schoolEmail" ? "email" : "text"}
                  required={["name", "username", "schoolEmail"].includes(key)}
                  maxLength={length}
                  disabled={pending}
                  aria-invalid={Boolean(fieldError)}
                  aria-describedby={fieldError ? `${fieldId}-error` : undefined}
                />
                {fieldError && (
                  <span id={`${fieldId}-error`} className={styles.fieldError} data-field-error={key} role="alert">
                    {fieldError}
                  </span>
                )}
              </div>
            );
          })}
          <button className={`${buttonControl} ${styles.identityCreateSubmit}`} disabled={pending}>
            确认创建
          </button>
          <p className={`${styles.fieldHint} ${styles.identityFormHint}`}>
            创建前请核对身份和学校邮箱。教师申请将进入审核列表。本人可用学校邮箱通过“忘记密码”设置密码。
          </p>
        </form>
      )}

      {!teachers && bulkOpen && (
        <section className={styles.bulkImportPanel} aria-label="CSV 批量导入账号">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0 text-sm font-bold text-slate-900">批量导入师生账号（CSV）</h2>
              <p className="mt-1 text-xs text-slate-500">支持先执行预校验（Dry-run，不写库），确认全部格式与邮箱域名合法后再正式入库。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={buttonControl} onClick={downloadSampleCsv}>
                <Download size={14} />下载模板
              </button>
              <label className={`${buttonControl} cursor-pointer`}>
                <Upload size={14} />选择 CSV 文件
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(event) => void handleCsvFile(event.target.files?.[0])}
                />
              </label>
            </div>
          </div>
          <textarea
            className={`${styles.textarea} font-mono text-xs`}
            rows={5}
            aria-label="CSV 导入内容"
            value={csvText}
            disabled={bulkBusy}
            onChange={(event) => {
              setCsvText(event.target.value);
              setBulkReport(null);
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={buttonControl} disabled={bulkBusy} onClick={() => void runBulkImport(true)}>
              {bulkBusy ? "校验中…" : "预校验（Dry-run）"}
            </button>
            <button type="button" className={`${buttonControl} ${styles.primaryButton}`} disabled={bulkBusy} onClick={() => void runBulkImport(false)}>
              {bulkBusy ? "导入中…" : "确认批量导入"}
            </button>
          </div>
          {bulkReport && (
            <div className="mt-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="blue">总计 {bulkReport.total} 行</Badge>
                <Badge tone="green">{bulkReport.dryRun ? `校验通过 ${bulkReport.validCount}` : `成功创建 ${bulkReport.createdCount}`}</Badge>
                <Badge tone={bulkReport.invalidCount ? "red" : "gray"}>异常 {bulkReport.invalidCount}</Badge>
              </div>
              <div className={styles.identityTableWrap}>
                <table className={styles.identityTable}>
                  <thead>
                    <tr><th>行号</th><th>姓名</th><th>用户名</th><th>学校邮箱</th><th>身份</th><th>结果</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    {bulkReport.results.map((item) => (
                      <tr key={`${item.index}:${item.username}`}>
                        <td>#{item.index + 1}</td>
                        <td>{item.name || "—"}</td>
                        <td><code>{item.username || "—"}</code></td>
                        <td>{item.schoolEmail || "—"}</td>
                        <td>{roleLabel(item.identity)}</td>
                        <td>
                          <Badge tone={item.status === "error" ? "red" : "green"}>
                            {item.status === "valid" ? "校验通过" : item.status === "created" ? "已创建" : "失败"}
                          </Badge>
                        </td>
                        <td>{item.errorCode ? `${item.errorCode}${item.fieldErrors ? ` (${Object.keys(item.fieldErrors).join(", ")})` : ""}` : "通过"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {!teachers && (
        <form
          className={`${styles.toolbarPanel} ${styles.toolbar} ${styles.identityUserFilters}`}
          key={query.toString()}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            updateQuery(
              Object.fromEntries(
                ["q", "role", "status", "college", "emailVerified", "pageSize"]
                  .map((key) => [key, String(form.get(key) || "") || null])
                  .concat([
                    ["page", null],
                    ["user", null],
                  ]),
              ),
            );
          }}
        >
          <label className={styles.field}>
            <span>搜索用户</span>
            <input className={inputControl} name="q" aria-label="姓名、邮箱或学号" placeholder="姓名、邮箱或学号" defaultValue={query.get("q") ?? ""} />
          </label>
          <label className={styles.field}>
            <span>学院</span>
            <input className={inputControl} name="college" aria-label="学院" placeholder="学院" defaultValue={query.get("college") ?? ""} />
          </label>
          <label className={styles.field}>
            <span>角色</span>
            <select className={inputControl} name="role" aria-label="角色" defaultValue={query.get("role") ?? ""}>
              <option value="">全部角色</option>
              {["student", "teacher", "ta", "admin"].map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>账号状态</span>
            <select className={inputControl} name="status" aria-label="账号状态" defaultValue={query.get("status") ?? ""}>
              <option value="">全部状态</option>
              <option value="enabled">可用</option>
              <option value="disabled">已停用</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>邮箱验证</span>
            <select className={inputControl} name="emailVerified" aria-label="邮箱验证" defaultValue={query.get("emailVerified") ?? ""}>
              <option value="">全部验证状态</option>
              <option value="true">已验证</option>
              <option value="false">待验证</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>每页条数</span>
            <select className={inputControl} name="pageSize" aria-label="每页条数" defaultValue={String(pageSize)}>
              <option value="10">10 条</option>
              <option value="20">20 条</option>
              <option value="50">50 条</option>
            </select>
          </label>
          <div className={styles.identityFilterActions}>
            <button className={`${buttonControl} ${styles.primaryButton}`}>查询</button>
            <button
              type="button"
              className={buttonControl}
              onClick={() =>
                updateQuery({
                  q: null,
                  college: null,
                  role: null,
                  status: null,
                  emailVerified: null,
                  pageSize: null,
                  page: null,
                  user: null,
                })
              }
            >
              重置筛选
            </button>
          </div>
          <div className={styles.identityQuickFilters} role="group" aria-label="快捷状态筛选">
            {(
              [
                ["", "全部"],
                ["enabled", "可用"],
                ["disabled", "已停用"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value || "all"}
                type="button"
                className={styles.identityQuickFilter}
                aria-pressed={(query.get("status") ?? "") === value}
                onClick={() => updateQuery({ status: value || null, page: null, user: null })}
              >
                {label}
              </button>
            ))}
          </div>
        </form>
      )}

      {!teachers && activeFilters.length > 0 && (
        <div className={styles.identityFilterChips} aria-label="已生效筛选">
          {activeFilters.map(([key, label, value]) => (
            <button
              type="button"
              className={styles.identityFilterChip}
              key={key}
              onClick={() => updateQuery({ [key]: null, page: null, user: null })}
            >
              {label}：{value}
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {result.isFetching && (
        <p role="status" className={styles.identityLoading}>
          正在读取…
        </p>
      )}
      {result.isError && (
        <div role="alert" className={styles.identityError}>
          <p>{message(result.error, "read")}</p>
          <button type="button" className={buttonControl} disabled={pending || result.isFetching} onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}
      {feedback && (
        <p role="status" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-sm text-blue-900">
          {feedback}
        </p>
      )}

      {!teachers && data && (
        <div className={styles.identitySummary} aria-label="用户目录摘要">
          <div className={styles.identitySummaryCard}>
            <span>结果总数</span>
            <strong>{data.total}</strong>
            <small>当前筛选结果</small>
          </div>
          <div className={styles.identitySummaryCard}>
            <span>当前页可用</span>
            <strong>{enabledOnPage}</strong>
            <small>本页账号</small>
          </div>
          <div className={styles.identitySummaryCard}>
            <span>当前页已停用</span>
            <strong>{disabledOnPage}</strong>
            <small>本页账号</small>
          </div>
          <div className={styles.identitySummaryCard}>
            <span>当前页待验证</span>
            <strong>{unverifiedOnPage}</strong>
            <small>学校邮箱</small>
          </div>
        </div>
      )}

      {data && (
        <div className={teachers && selected ? styles.twoColumns : undefined}>
          <Panel className={styles.identityTablePanel}>
            <>
              {!teachers ? (
                <div className={styles.identityTableWrap}>
                  <table className={styles.identityTable}>
                    <thead>
                      <tr>
                        <th scope="col">用户</th>
                        <th scope="col">学院</th>
                        <th scope="col">角色</th>
                        <th scope="col">账号状态</th>
                        <th scope="col">学校邮箱</th>
                        <th scope="col">最近登录</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((row) => {
                        const user = isIdentityUser(row) ? row : null;
                        return (
                          <tr key={row.id} aria-selected={selectedId === row.id}>
                            <td>
                              <div className={styles.identityUserCell}>
                                <span className={styles.identityAvatar} aria-hidden="true">
                                  {row.name.slice(0, 1) || "?"}
                                </span>
                                <div>
                                  <strong>{row.name}</strong>
                                  {user && <small>{user.studentId || "未填写学号"}</small>}
                                </div>
                              </div>
                            </td>
                            <td>{row.college || "未填写"}</td>
                            <td>
                              {user ? (
                                <div className={styles.identityBadgeGroup}>
                                  {user.roles.length ? (
                                    user.roles.map((role) => (
                                      <span className={styles.identityBadge} data-identity-role={role} key={role}>
                                        {roleLabel(role)}
                                      </span>
                                    ))
                                  ) : (
                                    <span className={styles.identityBadge}>未分配</span>
                                  )}
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              {user ? (
                                <span className={styles.identityBadge} data-identity-status={user.status}>
                                  {accountStatusLabel(user.status)}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              {user ? (
                                <div className={styles.identityEmailCell}>
                                  <span>{user.schoolEmail || "未绑定"}</span>
                                  <span
                                    className={styles.identityBadge}
                                    data-identity-email-status={user.schoolEmailVerified ? "verified" : "unverified"}
                                  >
                                    {emailStatusLabel(user.schoolEmailVerified)}
                                  </span>
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="whitespace-nowrap text-xs text-slate-500">
                              {user?.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : "从未登录"}
                            </td>
                            <td>
                              <button
                                className={buttonControl}
                                disabled={pending || ((conflict || selectionChanged) && selectedId === row.id)}
                                onClick={(event) => selectRow(row, event.currentTarget)}
                              >
                                查看
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!data.items.length && <EmptyState title="没有符合条件的记录" />}
                </div>
              ) : (
                <div className={styles.identityTableWrap}>
                  <table className={styles.identityTable}>
                    <thead>
                      <tr>
                        <th scope="col">申请人</th>
                        <th scope="col">学院</th>
                        <th scope="col">学校邮箱域</th>
                        <th scope="col">邮箱验证</th>
                        <th scope="col">审核状态</th>
                        <th scope="col">提交 / 审核时间</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((row) => {
                        const app = !isIdentityUser(row) && "applicationVersion" in row ? row : null;
                        if (!app) return null;
                        return (
                          <tr key={app.id} aria-selected={selectedId === app.id}>
                            <td>
                              <div className={styles.identityUserCell}>
                                <span className={styles.identityAvatar} aria-hidden="true">
                                  {app.name.slice(0, 1) || "?"}
                                </span>
                                <div>
                                  <strong>{app.name}</strong>
                                  <small>版本 v{app.applicationVersion}</small>
                                </div>
                              </div>
                            </td>
                            <td>{app.college || "未填写"}</td>
                            <td><code>{app.emailDomain || "未绑定"}</code></td>
                            <td>
                              <span
                                className={styles.identityBadge}
                                data-identity-email-status={app.emailVerified ? "verified" : "unverified"}
                              >
                                {app.emailVerified ? "已验证" : "未验证"}
                              </span>
                            </td>
                            <td>
                              <Badge tone={app.status === "approved" ? "green" : app.status === "rejected" ? "red" : "amber"}>
                                {applicationStatuses[app.status]}
                              </Badge>
                            </td>
                            <td className="text-xs text-slate-500">
                              <div>提交：{formatDate(app.createdAt)}</div>
                              {app.reviewedAt && <div>审核：{formatDate(app.reviewedAt)}</div>}
                            </td>
                            <td>
                              <button
                                className={buttonControl}
                                disabled={pending || ((conflict || selectionChanged) && selectedId === app.id)}
                                onClick={(event) => selectRow(app, event.currentTarget)}
                              >
                                查看
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!data.items.length && <EmptyState title="没有符合条件的记录" />}
                </div>
              )}
              <div className={styles.tableFooter}>
                <span>{tr("共 {0} 条 · 第 {1} 页", { 0: data.total, 1: data.page })}</span>
                <div className={styles.actions}>
                  <button
                    className={buttonControl}
                    disabled={page <= 1 || pending}
                    onClick={() => {
                      clearSelection();
                      updateQuery({ page: String(page - 1) });
                    }}
                  >
                    上一页
                  </button>
                  <button
                    className={buttonControl}
                    disabled={page * data.pageSize >= data.total || pending}
                    onClick={() => {
                      clearSelection();
                      updateQuery({ page: String(page + 1) });
                    }}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          </Panel>

          {teachers && selected && (
            <Panel title={selected.name} className={styles.identityDetailPanel}>
              {"schoolEmail" in selected && (
                <p className="text-xs text-slate-500">
                  {selected.schoolEmail ?? "尚未验证学校邮箱"} · {selected.studentId ?? "无学号"}
                </p>
              )}
              {"applicationVersion" in selected && (
                <div className="space-y-3">
                  <div className={styles.diffGrid}>
                    <div className={`${styles.diffCard} ${teacherMismatch ? styles.diffMismatch : ""}`}>
                      <h3>提交时的申请资料</h3>
                      <p>{tr("姓名：{0}", { 0: selected.submittedName ?? "未记录" })}</p>
                      <p>{tr("申请身份：{0}", { 0: selected.submittedIdentity === "teacher" ? "教师" : selected.submittedIdentity === "student" ? "学生" : "未记录" })}</p>
                      <p>{tr("学校邮箱域：{0}", { 0: selected.submittedEmailDomain ?? "未记录" })}</p>
                      <p>{tr("申请版本：{0} · 提交时间：{1}", { 0: selected.applicationVersion, 1: formatDate(selected.createdAt) })}</p>
                    </div>
                    <div className={`${styles.diffCard} ${teacherMismatch ? styles.diffMismatch : ""}`}>
                      <h3>当前账号资料</h3>
                      <p>{tr("姓名：{0}", { 0: selected.name })}</p>
                      <p>{tr("当前学校邮箱域：{0} · {1}", { 0: selected.emailDomain || "未绑定", 1: selected.emailVerified ? "已验证" : "未验证" })}</p>
                      {!selected.emailVerified && <p className={styles.identityActionHint}>学校邮箱尚未验证，验证后才能通过审核。</p>}
                      <p className="text-xs text-slate-500">当前资料可能已变化，不代表提交或审核时的资料。</p>
                    </div>
                  </div>
                  {teacherMismatch && (
                    <div className={styles.identityActionHint} role="status">
                      提交快照与当前资料存在差异，请人工确认是否为本人合规变更后再决定。
                    </div>
                  )}
                  {selected.status !== "pending" && (
                    <div className={styles.diffCard}>
                      <h3>{tr("已保存的审核结果：{0}", { 0: applicationStatuses[selected.status] })}</h3>
                      <p>{tr("审核时间：{0}", { 0: selected.reviewedAt ? formatDate(selected.reviewedAt) : "未记录" })}</p>
                      <p>{tr("审核人（当前姓名）：{0}", { 0: selected.reviewerName ?? "未记录或账号已不存在" })}</p>
                      <p className="whitespace-pre-wrap">{tr("审核原因：{0}", { 0: selected.reviewReason ?? "未记录" })}</p>
                      <p className="text-xs text-slate-500">此记录只读；结果取自当时保存的审核决定，不根据当前账号角色推断。</p>
                    </div>
                  )}
                </div>
              )}
              {selectionChanged && (
                <p role="alert" className="mt-3 text-sm text-rose-700">
                  此记录已被其他人修改，请刷新列表并核对后再提交；处理原因已保留。
                </p>
              )}
              {("canDisable" in selected || selected.status === "pending") && (
                <>
                  <label className={`${styles.field} my-3`}>
                    处理原因
                    <textarea
                      className={`${inputControl} mt-1 block w-full`}
                      aria-label="处理原因"
                      value={reason}
                      disabled={pending}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={2000}
                    />
                  </label>
                  <div className={styles.actions}>
                    {"canDisable" in selected ? (
                      <button
                        className={buttonControl}
                        disabled={pending || conflict || selectionChanged || !reason.trim() || (selected.status !== "disabled" && !selected.canDisable)}
                        onClick={() => void decide(selected.status === "disabled" ? "enable" : "disable")}
                      >
                        {selected.status === "disabled" ? "确认恢复" : "确认停用"}
                      </button>
                    ) : (
                      <>
                        <button
                          className={`${buttonControl} ${styles.primaryButton}`}
                          disabled={pending || conflict || selectionChanged || !reason.trim() || !selected.emailVerified}
                          onClick={() => void decide("approve")}
                        >
                          通过
                        </button>
                        <button
                          className={`${buttonControl} ${styles.dangerButton}`}
                          disabled={pending || conflict || selectionChanged || !reason.trim()}
                          onClick={() => void decide("reject")}
                        >
                          拒绝
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
              <button className={`${buttonControl} mt-3`} disabled={pending} onClick={clearSelection}>
                取消
              </button>
            </Panel>
          )}
        </div>
      )}

      {!teachers && (
        <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) closeDetail(); }}>
          <SheetContent className={styles.identityDrawer} aria-describedby="identity-drawer-description" aria-modal="true">
            {selected && (
              <div className={styles.identityDrawerBody}>
                <div className={styles.identityDrawerHeader}>
                  <div className={styles.identityDrawerHeading}>
                    <SheetTitle className={styles.identityDrawerTitle}>{selected.name}</SheetTitle>
                    <SheetDescription id="identity-drawer-description">
                      用户账号详情 · {selected.college || "未填写学院"}
                    </SheetDescription>
                    <div className="mt-1.5">
                      <CopyableId value={selected.id} compact={false} />
                    </div>
                  </div>
                  <button type="button" className={buttonControl} disabled={pending || result.isFetching} onClick={() => void refresh()}>
                    刷新列表
                  </button>
                  <div className={styles.identityBadgeGroup}>
                    {"roles" in selected &&
                      selected.roles.map((role) => (
                        <span className={styles.identityBadge} key={role}>
                          {roleLabel(role)}
                        </span>
                      ))}
                    {"status" in selected && (
                      <span className={styles.identityBadge} data-identity-status={selected.status}>
                        {accountStatusLabel(selected.status)}
                      </span>
                    )}
                  </div>
                </div>

                <div className={styles.identityDrawerContent}>
                  {"schoolEmail" in selected && (
                    <div className={styles.identityDetailIntro}>
                      <strong>账号资料</strong>
                      <p>{selected.schoolEmail || "尚未绑定学校邮箱"}</p>
                      <p>{selected.studentId || "未填写学号"}</p>
                    </div>
                  )}

                  {profileData && (
                    <>
                      <div className={styles.user360Section}>
                        <h4 className="flex items-center gap-1.5"><KeyRound size={14} />身份凭据与绑定矩阵</h4>
                        <div className={styles.bindingMatrix}>
                          <div className={styles.bindingItem}>
                            <span>学校邮箱</span>
                            <strong>{profileData.verification.school_email_verified ? (profileData.verification.school_email_verified_at ? `已验证 (${formatDate(profileData.verification.school_email_verified_at)})` : "已验证") : "未验证"}</strong>
                          </div>
                          <div className={styles.bindingItem}>
                            <span>Google 账号</span>
                            <strong>{profileData.verification.google_linked ? profileData.verification.google_email || "已绑定" : "未绑定"}</strong>
                          </div>
                          <div className={styles.bindingItem}>
                            <span>密码登录凭据</span>
                            <strong>{profileData.verification.has_password ? (profileData.verification.login_email_verified ? "已设密码 · 邮箱已验" : "已设密码 · 邮箱未验") : "未设置密码"}</strong>
                          </div>
                          <div className={styles.bindingItem}>
                            <span>GitHub 实名归属</span>
                            <strong>{profileData.verification.github_verified ? `@${profileData.verification.github_login}` : "未绑定"}</strong>
                          </div>
                          <div className={styles.bindingItem}>
                            <span>入台时间</span>
                            <strong>{formatDateTime(profileData.created_at)}</strong>
                          </div>
                          <div className={styles.bindingItem}>
                            <span>最近登录</span>
                            <strong>{profileData.last_login_at ? formatRelativeTime(profileData.last_login_at) : "从未登录"}</strong>
                          </div>
                        </div>
                      </div>

                      <div className={styles.user360Section}>
                        <h4>教学参与元数与 30 日 AI 消耗</h4>
                        <div className={styles.bindingMatrix}>
                          <div className={styles.bindingItem}>
                            <span>课程 / 小组 / 项目</span>
                            <strong>负责 {profileData.teaching_summary.owned_courses} · 选修 {profileData.teaching_summary.enrolled_courses} · 项目 {profileData.teaching_summary.member_projects}</strong>
                          </div>
                          <div className={styles.bindingItem}>
                            <span>近 30 天 AI 调用</span>
                            <strong>{profileData.ai_30d.requests} 次（失败 {profileData.ai_30d.failed}）· {profileData.ai_30d.input_tokens + profileData.ai_30d.output_tokens} Token</strong>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1 text-xs">
                          <Link className="gp-link" href={`/admin/logs?source=auth&auth_target=${encodeURIComponent(selected.id)}`}>
                            查看该用户认证日志 →
                          </Link>
                          <Link className="gp-link" href={`/admin/ai-usage?user=${encodeURIComponent(selected.id)}`}>
                            查看该用户 AI 用量 →
                          </Link>
                        </div>
                      </div>

                      <div className={styles.user360Section}>
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="flex items-center gap-1.5"><ShieldAlert size={14} />活跃会话 ({profileData.sessions.active_count})</h4>
                          {selected.id !== userId && profileData.sessions.active_count > 0 && (
                            <button
                              type="button"
                              className={`${buttonControl} ${styles.dangerButton}`}
                              onClick={() => setRevokeOpen(!revokeOpen)}
                            >
                              <LogOut size={13} />强制下线
                            </button>
                          )}
                        </div>
                        {revokeOpen && (
                          <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
                            <label className={styles.field}>
                              强制下线原因
                              <input
                                className={inputControl}
                                value={revokeReason}
                                maxLength={500}
                                placeholder="例如：怀疑会话泄露或账号异常登录"
                                onChange={(event) => setRevokeReason(event.target.value)}
                              />
                            </label>
                            <button
                              type="button"
                              className={`${buttonControl} ${styles.dangerButton}`}
                              disabled={revokeBusy || !revokeReason.trim()}
                              onClick={() => void forceRevokeSessions()}
                            >
                              {revokeBusy ? "正在撤销…" : "确认强制下线全部会话"}
                            </button>
                          </div>
                        )}
                        <div className="space-y-1.5">
                          {profileData.sessions.recent.slice(0, 4).map((sess) => (
                            <div key={sess.id} className={styles.sessionItem}>
                              <span>
                                <strong>{sess.auth_method || "unknown"}</strong> · {sess.scope}
                                <span className="ml-2 text-slate-500">{formatRelativeTime(sess.last_seen_at)}</span>
                              </span>
                              <Badge tone={sess.revoked_at ? "gray" : "green"}>
                                {sess.revoked_at ? sess.revoke_reason || "已撤销" : "活跃"}
                              </Badge>
                            </div>
                          ))}
                          {!profileData.sessions.recent.length && <p className="text-xs text-slate-500 m-0">暂无历史会话记录</p>}
                        </div>
                      </div>
                    </>
                  )}

                  {selectionChanged && (
                    <p role="alert" className="text-sm text-rose-700">
                      此记录已被其他人修改，请刷新列表并核对后再提交；处理原因已保留。
                    </p>
                  )}

                  {"canDisable" in selected && (
                    <>
                      <div className={styles.identityDetailIntro}>
                        <strong>账号状态</strong>
                        <p>
                          {selected.canDisable
                            ? "当前账号可停用"
                            : selected.status === "disabled"
                              ? "当前账号已停用，可恢复"
                              : "当前账号暂不可停用"}
                        </p>
                      </div>
                      <label className={styles.field}>
                        处理原因
                        <textarea
                          className={`${inputControl} mt-1 block w-full`}
                          aria-label="处理原因"
                          value={reason}
                          disabled={pending}
                          onChange={(event) => setReason(event.target.value)}
                          maxLength={2000}
                          placeholder="说明本次停用或恢复的依据"
                        />
                      </label>
                      <div className={styles.actions}>
                        <button
                          className={
                            selected.status === "disabled"
                              ? `${buttonControl} ${styles.primaryButton}`
                              : `${buttonControl} ${styles.dangerButton}`
                          }
                          disabled={
                            pending ||
                            conflict ||
                            selectionChanged ||
                            !reason.trim() ||
                            (selected.status !== "disabled" && !selected.canDisable)
                          }
                          onClick={() => void decide(selected.status === "disabled" ? "enable" : "disable")}
                        >
                          {selected.status === "disabled" ? "确认恢复" : "确认停用"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <div className={styles.identityDrawerFooter}>
                  <button className={buttonControl} disabled={pending} onClick={closeDetail}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
