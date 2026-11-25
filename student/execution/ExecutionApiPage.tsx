"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { EmptyState, ProgressBar, StatusBadge } from "@/shared/components/common";
import { useConfirmDialog } from "@/shared/components/ConfirmDialog";
import { tr } from "@/shared/i18n/tr";
import { useWorkspace } from "@/shared/lib/workspace";
import { formatDate } from "@/shared/lib/utils";
import { EvidenceCapturePanel } from "@/student/execution/EvidenceCapturePanel";
import { readCriterionRechecks } from "@/student/api/c-criterion-rechecks";
import { readTaskPlanVersions } from "@/student/api/c-task-plan-versions";
import { CApiError } from "@/shared/daily-inbox/c-client";
import { TaskCriteriaPanel } from "@/student/execution/TaskCriteriaPanel";
import { TaskPlanHistory } from "@/student/execution/TaskPlanHistory";
import { TaskGithubActivities } from "@/student/execution/TaskGithubActivities";
import { TaskVerificationPanel } from "@/student/execution/TaskVerificationPanel";
import { readTaskVerification } from "@/student/api/c-task-verification";
import { DiscussionsApiPage } from "@/student/execution/DiscussionsApiPage";
import { useUrlQuery } from "@/shared/lib/use-url-query";
import {
  accessFailure,
  apiButton,
  ApiFailure,
  apiInput,
  ApiPager,
  apiPrimaryButton,
  isUuid,
  pageNumber,
  projectApi,
  queryPolicy,
  taskNoteQuery,
  useCommandKey,
  versionFailure,
} from "@/shared/lib/c-project-api";

const states: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  pending_submission: "待提交",
  pending_verification: "待验收",
  completed: "已完成",
};
const tabs = {
  overview: "任务概览",
  criteria: "验收标准",
  evidence: "任务证据",
  verification: "任务验收",
  history: "执行历史",
  discussion: "任务讨论",
} as const;
type NoteDraft = { title: string; body: string; expected: number };

const compactBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const compactPrimaryBtn =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";

function progressExplanation(status: string, progress: number): string {
  if (status === "completed") return "正式验收已完成，任务进度与任务状态一致。";
  if (progress >= 90) return "代码同步产生的候选证据最多计入 90%；手动进度也不会改变验收状态。请逐条确认交付标准并完成验收。";
  if (progress > 0) return "当前数值表示实现进度，不等于正式验收结果。候选证据仍需逐条确认。";
  return "尚未记录实现进度。开始任务后，可以补充实现进度和验收证据。";
}

function evidenceLabel(status: string, effective: boolean): string {
  if (effective) return "有效正式证据";
  if (status === "candidate" || status === "pending_confirmation") return "候选证据，待人工确认";
  return "当前不计入正式证据";
}

export function ExecutionApiPage({ projectId, taskId, submission = false }: { projectId: string; taskId: string; submission?: boolean }) {
  const { userId } = useWorkspace();
  return <ExecutionPage key={`${userId}:${projectId}:${taskId}:${submission}`} projectId={projectId} taskId={taskId} userId={userId} submission={submission} />;
}

function ExecutionPage({ projectId, taskId, userId, submission }: { projectId: string; taskId: string; userId: string; submission: boolean }) {
  const router = useRouter();
  const { query, updateQuery } = useUrlQuery();
  const tab = query.get("tab") && Object.hasOwn(tabs, query.get("tab")!) ? (query.get("tab") as keyof typeof tabs) : "overview";
  const noteFocus = isUuid(query.get("note") ?? "") ? query.get("note") : null;
  const progressFocus = isUuid(query.get("progress") ?? "") ? query.get("progress") : null;
  const enabled = isUuid(projectId) && isUuid(taskId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const execution = useQuery({ queryKey: ["c-execution", userId, projectId, taskId], queryFn: () => projectApi.execution(taskId), enabled, ...queryPolicy });
  const taskExists = context.isSuccess && !context.isFetching && context.data.tasks.some((task) => task.id === taskId);
  const showGithub = taskExists && !submission && tab === "evidence";
  const githubPage = pageNumber(query.get("github_page"));
  const github = useQuery({
    queryKey: ["c-task-github", userId, projectId, taskId, githubPage],
    queryFn: () => projectApi.activities(projectId, "github", { task_id: taskId, page: githubPage, page_size: 10 }),
    enabled: showGithub,
    ...queryPolicy,
  });
  const showRechecks = taskExists && !submission && tab === "criteria";
  const showPlanVersions = taskExists && !submission && tab === "history";
  const showVerification = taskExists && !submission && tab === "verification";
  const verification = useQuery({
    queryKey: ["c-task-verification", userId, projectId, taskId],
    queryFn: ({ signal }) => readTaskVerification(projectId, taskId, signal),
    enabled: showVerification,
    ...queryPolicy,
  });
  const planVersions = useQuery({
    queryKey: ["c-task-plan-versions", userId, projectId, taskId],
    queryFn: ({ signal }) => readTaskPlanVersions(projectId, taskId, signal),
    enabled: showPlanVersions,
    ...queryPolicy,
  });
  const rechecks = useQuery({
    queryKey: ["c-criterion-rechecks", userId, projectId, taskId],
    queryFn: ({ signal }) => readCriterionRechecks(projectId, taskId, signal),
    enabled: showRechecks,
    ...queryPolicy,
  });
  const note = useQuery({ ...taskNoteQuery(userId, projectId, taskId), enabled: taskExists });
  const evidence = useQuery({
    queryKey: ["c-task-evidence", userId, projectId, taskId, pageNumber(query.get("evidence_page"))],
    queryFn: () => projectApi.evidence(projectId, { task_id: taskId, page: pageNumber(query.get("evidence_page")), page_size: 10 }),
    enabled: taskExists && (submission || tab === "evidence"),
    ...queryPolicy,
  });
  const criteriaEvidence = useQuery({
    queryKey: ["c-task-criteria-evidence", userId, projectId, taskId],
    queryFn: () => projectApi.evidence(projectId, { task_id: taskId, page: 1, page_size: 50 }),
    enabled: showRechecks,
    ...queryPolicy,
  });
  const history = useQuery({
    queryKey: ["c-progress-history", userId, projectId, taskId, pageNumber(query.get("history_page")), progressFocus],
    queryFn: () => projectApi.progressHistory(projectId, taskId, pageNumber(query.get("history_page")), 10, progressFocus ?? undefined),
    enabled: taskExists && tab === "history" && !submission,
    ...queryPolicy,
  });

  const [blocked, setBlocked] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const key = useCommandKey();
  const [progress, setProgress] = useState<{ value: number; reason: string; expected: number } | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [prepareVersion, setPrepareVersion] = useState<number | null>(null);
  const [evidenceDirty, setEvidenceDirty] = useState(false);
  const [showAdvancedSubmission, setShowAdvancedSubmission] = useState(false);
  const [confirm, dialogElement] = useConfirmDialog();

  // B conceals a hidden project or task with a named 404. A generic 404
  // indicates that the individual optional route is unavailable.
  const hiddenTarget = [rechecks.error, planVersions.error, verification.error].find(
    (err) => err instanceof CApiError && err.status === 404 && ["PROJECT_NOT_FOUND", "TASK_NOT_FOUND"].includes(err.code),
  );
  const denial =
    blocked ||
    hiddenTarget ||
    [context.error, execution.error, note.error, evidence.error, history.error, rechecks.error, planVersions.error, github.error, verification.error].find(
      accessFailure,
    );
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const task = access?.tasks.find((item) => item.id === taskId);
  const state =
    task && execution.isSuccess && !execution.isFetching && execution.data.project_id === projectId && execution.data.task_id === taskId
      ? execution.data
      : undefined;
  const savedNote = access && note.isSuccess && !note.isFetching ? note.data : undefined;
  const noteReady = access && note.isSuccess && !note.isFetching;
  const canNote = Boolean(task?.can_capture_evidence && access?.permissions.can_capture_evidence);
  const canPrepare = Boolean(
    state && !state.read_only && ["in_progress", "pending_submission"].includes(state.status) && state.responsible_ids.includes(access!.actor.id),
  );
  const evidenceItems = evidence.isSuccess && !evidence.isFetching ? evidence.data.items : [];
  const submissionAllAiPassed = Boolean(
    submission &&
      task &&
      task.criteria.length > 0 &&
      evidence.isSuccess &&
      !evidence.isFetching &&
      task.criteria.every((criterion) =>
        evidenceItems.some(
          (ev) => !ev.source_changed && ["candidate", "pending_confirmation", "formal"].includes(ev.status) && ev.criterion_ids.includes(criterion.id),
        ),
      ),
  );
  const showManualSubmissionForms = Boolean(submission && ((!submissionAllAiPassed && state?.status !== "completed") || showAdvancedSubmission));
  const showRightCapture = Boolean(submission && state && canNote && showManualSubmissionForms);

  const focusTarget =
    state && tab === "history" && !submission
      ? noteFocus && savedNote?.versions.some((version) => version.id === noteFocus)
        ? `note-${noteFocus}`
        : progressFocus && history.isSuccess && !history.isFetching && history.data.items.some((event) => event.id === progressFocus)
          ? `progress-${progressFocus}`
          : null
      : null;

  useEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget);
    element?.scrollIntoView({ block: "center" });
    element?.focus({ preventScroll: true });
  }, [focusTarget]);

  function deny(next: unknown) {
    setBlocked(next);
    setProgress(null);
    setDraft(null);
    setPrepareVersion(null);
  }

  async function refresh() {
    const results = await Promise.all([
      context.refetch(),
      execution.refetch(),
      ...(taskExists ? [note.refetch()] : []),
      ...(taskExists && (submission || tab === "evidence") ? [evidence.refetch()] : []),
      ...(showPlanVersions ? [history.refetch(), planVersions.refetch()] : []),
      ...(showRechecks ? [rechecks.refetch()] : []),
      ...(showGithub ? [github.refetch()] : []),
      ...(showVerification ? [verification.refetch()] : []),
    ]);
    if (showRechecks) void criteriaEvidence.refetch();
    const denied = results.find((result) => accessFailure(result.error));
    if (denied) deny(denied.error);
    else if (results[0].isSuccess) setBlocked(null);
  }

  async function perform(action: "start" | "progress" | "note" | "prepare", openCheck = false) {
    if (!state || busyRef.current) return;
    if (action === "start" && !state.can_start) return;
    if (action === "progress" && (!state.can_update_progress || !progress)) return;
    if (action === "note" && (!canNote || !draft || !noteReady)) return;
    const expectedSubmissionVersion = openCheck ? state.version : prepareVersion;
    if (action === "prepare" && (!canPrepare || expectedSubmissionVersion === null || !noteReady)) return;
    if (action === "progress" && (!progress!.reason.trim() || !Number.isInteger(progress!.value) || progress!.value < 0 || progress!.value > 100)) {
      setNotice("请填写 0–100 的整数进度及变更原因。");
      return;
    }
    if ((action === "note" || action === "prepare") && draft && (!draft.title.trim() || !draft.body.trim())) {
      setNotice("任务说明的标题和正文不能为空。");
      return;
    }
    if (
      openCheck &&
      evidenceDirty &&
      !(await confirm({
        title: tr("放弃未保存的候选证据"),
        description: tr("候选证据还有未保存的内容。放弃这些输入并进入完整性检查？"),
        confirmLabel: tr("放弃并继续"),
        tone: "warning",
      }))
    ) {
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    let leavingForCheck = false;
    try {
      if (action === "start") await projectApi.start(taskId, state.version);
      if (action === "progress")
        await projectApi.progress(taskId, { expected_version: progress!.expected, progress: progress!.value, reason: progress!.reason.trim() });
      const noteInput = draft ? { title: draft.title.trim(), body: draft.body.trim(), expected_version: draft.expected } : null;
      if (action === "note" && noteInput) await projectApi.saveNote(projectId, taskId, noteInput, key({ action, projectId, taskId, noteInput }));
      if (action === "prepare") {
        const input = { expected_version: expectedSubmissionVersion!, note: noteInput };
        const saved = await projectApi.prepareSubmission(taskId, input, key({ action, projectId, taskId, input }));
        if (saved.execution.project_id !== projectId || saved.execution.task_id !== taskId || saved.execution.status !== "pending_submission") {
          throw new Error("Unexpected submission state");
        }
        if (openCheck) {
          router.push(`/projects/${projectId}/tasks/${taskId}/evidence-check`);
          leavingForCheck = true;
          return;
        }
      }
      key.reset();
      if (action === "progress") setProgress(null);
      if (action === "note" || action === "prepare") setDraft(null);
      setPrepareVersion(null);
      setNotice(action === "prepare" ? "提交准备已保存，任务处于待提交状态。" : "操作已保存。");
      await refresh();
    } catch (next) {
      setError(next);
      if (accessFailure(next)) deny(next);
    } finally {
      if (!leavingForCheck) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function reviewLatest() {
    const [latest, latestNote, permission] = await Promise.all([execution.refetch(), note.refetch(), context.refetch()]);
    const next = latest.error || latestNote.error || permission.error;
    if (next) {
      setError(next);
      if (accessFailure(next)) deny(next);
      return;
    }
    if (latest.data) {
      if (progress) setProgress({ ...progress, expected: latest.data.version });
      if (prepareVersion !== null) setPrepareVersion(latest.data.version);
    }
    if (draft) setDraft({ ...draft, expected: latestNote.data?.lock_version ?? 0 });
    setError(null);
    setNotice("最新状态和已保存说明已刷新，输入仍保留；请对照后再次确认。");
  }

  if (!enabled) return <EmptyState title="任务地址无效" />;

  if (
    !submission &&
    context.error instanceof CApiError &&
    context.error.code === "PROJECT_ACCESS_DENIED" &&
    execution.isSuccess &&
    !execution.isFetching &&
    execution.data.temporary_read &&
    execution.data.project_id === projectId &&
    execution.data.task_id === taskId
  ) {
    const grantedTask = execution.data;
    return (
      <div className="space-y-3.5">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{grantedTask.title ?? "任务详情"}</h1>
            <p className="mt-0.5 text-xs text-slate-500">临时只读访问</p>
          </div>
          <button className={compactBtn} onClick={() => void refresh()}>
            <RefreshCw size={13} />
            刷新任务
          </button>
        </div>
        <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
          <h2 className="text-sm font-semibold text-slate-900">任务概览</h2>
          <p className="mt-2 text-sm text-slate-700">
            {states[grantedTask.status]} · 进度 {grantedTask.progress}%
          </p>
          {grantedTask.description && <p className="mt-2.5 whitespace-pre-wrap text-sm leading-6 text-slate-600">{grantedTask.description}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {/* Compact Header */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight text-slate-900">
            {submission ? "证据确认与任务验收" : (task?.title ?? "任务执行")}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className={compactBtn} href={`/projects/${projectId}/tasks`}>
            返回任务列表
          </Link>
          <button
            className={compactBtn}
            disabled={busy || context.isFetching || execution.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={context.isFetching || execution.isFetching ? "animate-spin" : ""} />
            刷新任务
          </button>
        </div>
      </div>

      {denial ? (
        <ApiFailure error={denial} retry={() => void refresh()} />
      ) : (
        <>
          {(context.isFetching || execution.isFetching) && (
            <p role="status" className="text-xs text-slate-500">
              正在读取当前任务…
            </p>
          )}
          {context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
          {execution.isError && <ApiFailure error={execution.error} retry={() => void refresh()} />}
          {access && !task && <EmptyState title="当前项目中没有此任务" />}
          {task && execution.isSuccess && execution.data.project_id !== projectId && <EmptyState title="任务不属于当前项目" />}

          {/* Outer layout wrapper keeps <EvidenceCapturePanel> mounted across refresh() */}
          <div
            className={
              showRightCapture
                ? "grid gap-3.5 xl:grid-cols-[minmax(0,1.4fr)_minmax(350px,1fr)] xl:items-start"
                : "space-y-3.5"
            }
          >
            {state &&
              access &&
              task &&
              (() => {
                const responsibleNames =
                  state.responsible_ids
                    .map((id) => access.members.find((member) => member.id === id)?.title ?? "项目负责人")
                    .join("、") || "未指派";

                const noteSection = (
                  <div className="space-y-3.5">
                    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                      <div className="mb-2.5 flex items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold text-slate-900">任务说明版本</h2>
                        {submission && canNote && !draft && noteReady && (
                          <button
                            className={compactBtn}
                            onClick={() => {
                              const current = savedNote?.versions.find((version) => version.version_no === savedNote.current_version_no);
                              setDraft({ title: current?.title ?? task.title, body: current?.body ?? "", expected: savedNote?.lock_version ?? 0 });
                              setError(null);
                            }}
                          >
                            编辑任务说明
                          </button>
                        )}
                      </div>
                      {note.isFetching && (
                        <p role="status" className="text-xs text-slate-500">
                          正在读取说明…
                        </p>
                      )}
                      {note.isError && <ApiFailure error={note.error} retry={() => void note.refetch()} />}
                      {noteReady && (
                        <div className="space-y-2 text-xs">
                          {savedNote?.versions.map((version) => (
                            <details
                              id={`note-${version.id}`}
                              tabIndex={-1}
                              open={noteFocus === version.id || undefined}
                              className={`rounded-xl border px-3 py-2 ${
                                noteFocus === version.id ? "border-blue-400 bg-blue-50/40" : "border-slate-200/75 bg-slate-50/60"
                              }`}
                              key={version.id}
                            >
                              <summary className="cursor-pointer font-medium text-slate-800">
                                v{version.version_no} · {version.title} · {formatDate(version.created_at)}
                              </summary>
                              <p className="mt-2 whitespace-pre-wrap leading-5 text-slate-700">{version.body}</p>
                            </details>
                          ))}
                          {!savedNote && <p className="text-slate-500">尚未保存任务说明。</p>}
                          {noteFocus && !savedNote?.versions.some((version) => version.id === noteFocus) && (
                            <p role="status" className="text-amber-700">
                              所定位的说明版本不存在或已不可读取。
                            </p>
                          )}
                        </div>
                      )}
                    </section>

                    {submission && draft && canNote && (
                      <section className="rounded-2xl border border-sky-200/80 bg-white p-4 shadow-xs">
                        <h2 className="mb-2.5 text-sm font-semibold text-slate-900">编辑任务说明</h2>
                        <div className="space-y-2.5 text-xs">
                          <label className="block font-medium text-slate-700">
                            说明标题
                            <input
                              className={`${apiInput} mt-1 block w-full`}
                              maxLength={240}
                              value={draft.title}
                              disabled={busy}
                              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                            />
                          </label>
                          <div>
                            <label htmlFor="task-note-body" className="block font-medium text-slate-700">
                              说明正文
                            </label>
                            <textarea
                              id="task-note-body"
                              className={`${apiInput} mt-1 block min-h-32 w-full`}
                              maxLength={100000}
                              value={draft.body}
                              disabled={busy}
                              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                            />
                          </div>
                          <p className="text-slate-500">每次保存生成新版本，旧版本与其证据快照保留。</p>
                          <div className="flex flex-wrap gap-2">
                            <button className={apiPrimaryButton} disabled={busy || !noteReady} onClick={() => void perform("note")}>
                              保存说明新版本
                            </button>
                            <button
                              className={apiButton}
                              disabled={busy}
                              onClick={() => {
                                setDraft(null);
                                setPrepareVersion(null);
                              }}
                            >
                              取消编辑
                            </button>
                          </div>
                        </div>
                      </section>
                    )}
                  </div>
                );

                const prepareSection = (
                  <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                    <h2 className="text-sm font-semibold text-slate-900">提交准备</h2>
                    <p className="mt-1 text-xs text-slate-600">检查完整性前会先保存当前任务说明，并将任务设为待提交。</p>
                    {canPrepare && (
                      <div className="mt-3">
                        {prepareVersion === null ? (
                          <div className="flex flex-wrap gap-2">
                            <button className={compactBtn} disabled={busy || !noteReady} onClick={() => setPrepareVersion(state.version)}>
                              准备提交
                            </button>
                            <button className={compactPrimaryBtn} disabled={busy || !noteReady} onClick={() => void perform("prepare", true)}>
                              检查完整性
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-2.5 text-xs">
                            <p className="text-slate-700">
                              {draft ? "当前编辑的说明将与待提交状态一同保存。" : "将保留已保存的说明，并准备提交。"}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button className={compactPrimaryBtn} disabled={busy || !noteReady} onClick={() => void perform("prepare")}>
                                确认保存提交准备
                              </button>
                              <button className={compactBtn} disabled={busy} onClick={() => setPrepareVersion(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );

                const evidenceCard = (() => {
                  if (!submission && tab !== "evidence") return null;
                  const criterionIdSet = new Set(task.criteria.map((c) => c.id));
                  const displayItems =
                    submission && task.criteria.length > 0
                      ? evidenceItems.filter(
                          (ev) =>
                            !(
                              !ev.source_changed &&
                              ["candidate", "pending_confirmation", "formal"].includes(ev.status) &&
                              ev.criterion_ids.some((cid) => criterionIdSet.has(cid))
                            ),
                        )
                      : evidenceItems;
                  if (submission && task.criteria.length > 0 && !evidence.isFetching && !evidence.isError && displayItems.length === 0) {
                    return null;
                  }
                  return (
                    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                      <h2 className="mb-2.5 text-sm font-semibold text-slate-900">
                        {submission && task.criteria.length > 0 ? "其他历史或未关联标准的证据" : "任务已有证据"}
                      </h2>
                      {evidence.isFetching && (
                        <p role="status" className="text-xs text-slate-500">
                          正在读取证据…
                        </p>
                      )}
                      {evidence.isError && <ApiFailure error={evidence.error} retry={() => void evidence.refetch()} />}
                      {evidence.isSuccess && !evidence.isFetching && (
                        <>
                          {displayItems.length > 0 ? (
                            <ul className="divide-y divide-slate-100 text-xs">
                              {displayItems.map((item) => (
                                <li className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0" key={item.id}>
                                  <Link className="gp-link font-medium" href={`/projects/${projectId}/evidence?evidence=${item.id}`}>
                                    {item.title}
                                  </Link>
                                  <span className="text-slate-500">{evidenceLabel(item.status, item.effective)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-slate-500">暂无证据。</p>
                          )}
                          <ApiPager
                            page={evidence.data.page}
                            pageSize={evidence.data.page_size}
                            total={evidence.data.total}
                            change={(page) => updateQuery({ evidence_page: String(page) })}
                          />
                        </>
                      )}
                    </section>
                  );
                })();

                const quickFactsSidebar = (
                  <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                    <h2 className="mb-2.5 text-sm font-semibold text-slate-900">任务执行摘要</h2>
                    <dl className="space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">负责人</dt>
                        <dd className="text-right font-medium text-slate-800">{responsibleNames}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">项目进度</dt>
                        <dd className="font-mono font-semibold text-slate-800">
                          {state.project_progress === null ? "暂无" : `${state.project_progress}%`}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">验收标准</dt>
                        <dd className="font-mono font-semibold text-slate-800">{task.criteria.length} 条</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-slate-500">前置任务</dt>
                        <dd className="font-mono font-semibold text-slate-800">{state.dependencies.length} 项</dd>
                      </div>
                    </dl>
                    <p className="mt-3 border-t border-slate-100 pt-2.5 text-[11px] leading-5 text-slate-500">
                      100% 进度不会自动完成任务，正式结论以验收服务为准。
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Link className={`${compactBtn} flex-1`} href={`/projects/${projectId}/tasks/${taskId}/submit`}>
                        任务说明与候选证据
                      </Link>
                      <Link className={`${compactBtn} flex-1`} href={`/projects/${projectId}/tasks/${taskId}?tab=verification`}>
                        逐项验收结果
                      </Link>
                    </div>
                  </section>
                );

                return (
                  <div className="min-w-0 space-y-3.5">
                    {/* Compact Task Status & Progress Strip */}
                    <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="font-semibold text-slate-900">任务：{task.title}</span>
                            <StatusBadge status={state.status} label={states[state.status]} />
                            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                              状态：{states[state.status]} · 进度：{state.progress}%
                            </span>
                          </div>
                          {(!submission || !submissionAllAiPassed) && (
                            <p className="text-xs leading-5 text-slate-500">{progressExplanation(state.status, state.progress)}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {state.can_start && (
                            <button className={compactPrimaryBtn} disabled={busy} onClick={() => void perform("start")}>
                              开始任务
                            </button>
                          )}
                          {!submission && state.can_update_progress && (
                            <button
                              className={compactBtn}
                              disabled={busy}
                              onClick={() => {
                                setProgress({ value: state.progress, reason: "", expected: state.version });
                                setError(null);
                              }}
                            >
                              更新进度
                            </button>
                          )}
                          {submission ? (
                            <Link className={compactBtn} href={`/projects/${projectId}/tasks/${taskId}`}>
                              查看任务详情
                            </Link>
                          ) : (
                            <Link className={compactPrimaryBtn} href={`/projects/${projectId}/tasks/${taskId}/submit`}>
                              任务说明与候选证据
                            </Link>
                          )}
                        </div>
                      </div>
                      <div className="mt-2.5">
                        <ProgressBar value={state.progress} />
                      </div>
                    </section>

                    {/* Inline Progress Update Card */}
                    {progress && state.can_update_progress && (
                      <section className="rounded-2xl border border-sky-200/80 bg-white p-4 shadow-xs">
                        <h2 className="mb-2.5 text-sm font-semibold text-slate-900">更新任务进度</h2>
                        <div className="grid gap-3 md:grid-cols-[140px_minmax(0,1fr)]">
                          <label className="block text-xs font-medium text-slate-700">
                            任务进度
                            <input
                              className={`${apiInput} mt-1 block w-full`}
                              type="number"
                              min={0}
                              max={100}
                              step={1}
                              value={progress.value}
                              disabled={busy}
                              onChange={(event) => setProgress({ ...progress, value: Number(event.target.value) })}
                            />
                          </label>
                          <div>
                            <label htmlFor="progress-reason" className="block text-xs font-medium text-slate-700">
                              进度变更原因
                            </label>
                            <textarea
                              id="progress-reason"
                              className={`${apiInput} mt-1 block w-full`}
                              rows={2}
                              maxLength={2000}
                              disabled={busy}
                              value={progress.reason}
                              onChange={(event) => setProgress({ ...progress, reason: event.target.value })}
                            />
                          </div>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button className={compactPrimaryBtn} disabled={busy} onClick={() => void perform("progress")}>
                            保存进度
                          </button>
                          <button className={compactBtn} disabled={busy} onClick={() => setProgress(null)}>
                            取消
                          </button>
                        </div>
                      </section>
                    )}

                    {/* Error & Notice Feedback */}
                    {error ? <ApiFailure error={error} /> : null}
                    {versionFailure(error) && (
                      <button className={compactBtn} disabled={busy} onClick={() => void reviewLatest()}>
                        刷新并核对输入
                      </button>
                    )}
                    {notice && (
                      <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2 text-xs text-emerald-800">
                        {notice}
                      </p>
                    )}

                    {/* Non-Submission Mode: Tab Bar + 2-Column Bento */}
                    {!submission && (
                      <>
                        <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-slate-200/85 bg-white p-1.5 shadow-xs">
                          {Object.entries(tabs).map(([value, tabLabel]) => {
                            const active = tab === value;
                            return (
                              <button
                                key={value}
                                type="button"
                                aria-pressed={active}
                                onClick={() => updateQuery({ tab: value })}
                                className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
                                  active
                                    ? "bg-slate-900 text-white shadow-2xs"
                                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                                }`}
                              >
                                {tabLabel}
                              </button>
                            );
                          })}
                        </div>

                        {tab === "overview" && (
                          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)] xl:items-start">
                            <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                              <h2 className="text-sm font-semibold text-slate-900">执行概览</h2>
                              <div className="mt-3 space-y-3 text-sm">
                                <div>
                                  <h3 className="text-xs font-semibold text-slate-500">任务描述</h3>
                                  <p className="mt-1 whitespace-pre-wrap leading-6 text-slate-700">{task.description || "未填写任务描述。"}</p>
                                </div>
                                <div className="border-t border-slate-100 pt-3">
                                  <h3 className="text-xs font-semibold text-slate-500">前置任务</h3>
                                  {state.dependencies.length > 0 ? (
                                    <ul className="mt-1.5 divide-y divide-slate-100 text-xs">
                                      {state.dependencies.map((dependency) => (
                                        <li key={dependency.task_id} className="flex items-center justify-between py-1.5">
                                          <span className="text-slate-800">
                                            {access.tasks.find((item) => item.id === dependency.task_id)?.title ?? "前置任务"}
                                          </span>
                                          <StatusBadge
                                            tone={dependency.satisfied ? "green" : "amber"}
                                            label={dependency.satisfied ? "已满足" : "尚未满足"}
                                          />
                                        </li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <p className="mt-1 text-xs text-slate-500">没有前置任务。</p>
                                  )}
                                </div>
                              </div>
                            </section>

                            <div className="space-y-3.5 xl:sticky xl:top-4">
                              <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                                <h2 className="mb-2.5 text-sm font-semibold text-slate-900">执行信息</h2>
                                <div className="space-y-2 text-xs text-slate-700">
                                  <p>项目进度：{state.project_progress === null ? "暂无可计算进度" : `${state.project_progress}%`}</p>
                                  <p>负责人：{responsibleNames}</p>
                                  <p className="text-slate-500">100% 进度不会自动完成任务。验收结论由验收服务提供。</p>
                                </div>
                                <div className="mt-3 border-t border-slate-100 pt-2.5 text-xs">
                                  <Link className="gp-link" href={`/projects/${projectId}/tasks/${taskId}?tab=verification`}>
                                    查看逐项验收结果与人工决定
                                  </Link>
                                </div>
                              </section>
                            </div>
                          </div>
                        )}

                        {tab === "criteria" && (
                          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)] xl:items-start">
                            <TaskCriteriaPanel
                              projectId={projectId}
                              taskId={taskId}
                              taskStatus={state.status}
                              actorId={access.actor.id}
                              canLeadOrTeach={Boolean(access.actor.is_leader || access.actor.is_teacher)}
                              isLeader={Boolean(access.actor.is_leader)}
                              isResponsible={state.responsible_ids.includes(access.actor.id)}
                              canCaptureEvidence={Boolean(task.can_capture_evidence && access.permissions.can_capture_evidence)}
                              criteria={task.criteria}
                              requirements={access.requirements}
                              rechecks={rechecks}
                              evidences={criteriaEvidence.isSuccess && !criteriaEvidence.isFetching ? criteriaEvidence.data.items : []}
                              onChanged={refresh}
                            />
                            <div className="space-y-3.5 xl:sticky xl:top-4">{quickFactsSidebar}</div>
                          </div>
                        )}

                        {tab === "evidence" && (
                          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] xl:items-start">
                            <div className="min-w-0 space-y-3.5">{evidenceCard}</div>
                            <div className="min-w-0 space-y-3.5 xl:sticky xl:top-4">
                              {showGithub && (
                                <TaskGithubActivities
                                  projectId={projectId}
                                  taskId={taskId}
                                  query={github}
                                  changePage={(page) => updateQuery({ github_page: String(page) })}
                                />
                              )}
                            </div>
                          </div>
                        )}

                        {tab === "verification" && (
                          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)] xl:items-start">
                            <div className="min-w-0">
                              {showVerification && (
                                <TaskVerificationPanel
                                  projectId={projectId}
                                  taskId={taskId}
                                  query={verification}
                                  members={access.members}
                                />
                              )}
                            </div>
                            <div className="space-y-3.5 xl:sticky xl:top-4">{quickFactsSidebar}</div>
                          </div>
                        )}

                        {tab === "history" && (
                          <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)] xl:items-start">
                            <div className="min-w-0 space-y-3.5">
                              {showPlanVersions && <TaskPlanHistory query={planVersions} />}
                              <section className="rounded-2xl border border-slate-200/85 bg-white p-4 shadow-xs">
                                <h2 className="mb-3 text-sm font-semibold text-slate-900">任务进度与状态历史</h2>
                                {history.isFetching && (
                                  <p role="status" className="text-xs text-slate-500">
                                    正在读取执行历史…
                                  </p>
                                )}
                                {history.isError && <ApiFailure error={history.error} retry={() => void history.refetch()} />}
                                {history.isSuccess && !history.isFetching && (
                                  <>
                                    <div className="space-y-2.5 text-xs">
                                      {history.data.items.map((event) => (
                                        <article
                                          id={`progress-${event.id}`}
                                          tabIndex={-1}
                                          key={event.id}
                                          className={`rounded-r-lg border-l-2 py-1.5 pl-3 ${
                                            progressFocus === event.id ? "border-blue-500 bg-blue-50" : "border-slate-200"
                                          }`}
                                        >
                                          <p className="font-medium text-slate-800">
                                            {event.actor_name} · {formatDate(event.created_at)}
                                          </p>
                                          <p className="mt-0.5 text-slate-600">
                                            {event.from_status ? (states[event.from_status] ?? event.from_status) : "—"} →{" "}
                                            {event.to_status ? (states[event.to_status] ?? event.to_status) : "—"} ·{" "}
                                            {event.progress_before ?? "—"}% → {event.progress_after ?? "—"}%
                                          </p>
                                          <p className="mt-0.5 text-slate-700">{event.reason ?? "未提供原因"}</p>
                                        </article>
                                      ))}
                                      {!history.data.items.length && <p className="text-slate-500">暂无执行历史。</p>}
                                    </div>
                                    <ApiPager
                                      page={history.data.page}
                                      pageSize={history.data.page_size}
                                      total={history.data.total}
                                      change={(page) => updateQuery({ history_page: String(page), progress: null })}
                                    />
                                  </>
                                )}
                              </section>
                            </div>
                            <div className="min-w-0 space-y-3.5 xl:sticky xl:top-4">{noteSection}</div>
                          </div>
                        )}
                      </>
                    )}

                    {/* Submission Mode Content */}
                    {submission && (
                      <>
                        <TaskCriteriaPanel
                          projectId={projectId}
                          taskId={taskId}
                          taskStatus={state.status}
                          actorId={access.actor.id}
                          canLeadOrTeach={Boolean(access.actor.is_leader || access.actor.is_teacher)}
                          isLeader={Boolean(access.actor.is_leader)}
                          isResponsible={state.responsible_ids.includes(access.actor.id)}
                          canCaptureEvidence={Boolean(task.can_capture_evidence && access.permissions.can_capture_evidence)}
                          criteria={task.criteria}
                          requirements={access.requirements}
                          evidences={evidenceItems}
                          onChanged={refresh}
                        />
                        {evidenceCard}
                        {showManualSubmissionForms && (
                          <>
                            {noteSection}
                            {prepareSection}
                          </>
                        )}
                        {(!submissionAllAiPassed && state.status !== "completed" ? null : (
                          <div className="rounded-2xl border border-slate-200/85 bg-white px-4 py-2.5 text-xs text-slate-600 shadow-xs">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span>
                                {submissionAllAiPassed
                                  ? "已由代码证据覆盖全部交付标准，上方可直接一键确认完成；如需补充人工材料可展开手动选项。"
                                  : "如需查看说明版本或补充人工材料，可展开手动选项。"}
                              </span>
                              <div className="flex flex-wrap items-center gap-2">
                                {canPrepare && !showManualSubmissionForms && (
                                  <button type="button" className={compactBtn} disabled={busy || !noteReady} onClick={() => void perform("prepare", true)}>
                                    检查完整性
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={compactBtn}
                                  onClick={() => setShowAdvancedSubmission((open) => !open)}
                                >
                                  {showAdvancedSubmission ? "收起手动补充选项" : "展开手动补充选项"}
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })()}

            {/* Mounted outside {state && ...} so refresh() never unmounts EvidenceCapturePanel */}
            {submission && context.data && (
              <div className={showRightCapture ? "min-w-0 xl:sticky xl:top-4" : "hidden"}>
                <EvidenceCapturePanel
                  context={context.data}
                  userId={userId}
                  fixedTaskId={taskId}
                  visible={Boolean(state && canNote && showManualSubmissionForms)}
                  onSaved={() => {
                    setShowAdvancedSubmission(true);
                    void evidence.refetch();
                  }}
                  onDenied={deny}
                  onDirtyChange={setEvidenceDirty}
                />
              </div>
            )}
          </div>

          {!submission && tab === "discussion" && <DiscussionsApiPage projectId={projectId} taskId={taskId} visible={Boolean(state)} />}
        </>
      )}
      {dialogElement}
    </div>
  );
}
