"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import {
  Avatar,
  DetailDrawer,
  EmptyState,
  Feedback,
  ListRow,
  PageHeader,
  Section,
  StateBlock,
  StatusBadge,
} from "@/components/common";
import { projectRequest } from "@/features/github-binding/integration-request";
import { useWorkspace } from "@/lib/workspace";
import { formatDate } from "@/lib/utils";
import {
  CApiError,
  type ActivityQuery,
  type ActivitySourceType,
  type ActivitySummary,
} from "@/lib/api/c-client";
import { readProjectBindings } from "@/lib/api/c-project-bindings";
import type { components } from "@/packages/domain/api.generated";
import { useUrlQuery } from "./use-url-query";
import {
  accessFailure,
  ApiFailure,
  ApiPager,
  apiButton,
  apiInput,
  apiPrimaryButton,
  isUuid,
  pageNumber,
  projectApi,
  queryPolicy,
  safeHttps,
  useCommandKey,
  versionFailure,
} from "./c-project-api";

type Activity = components["schemas"]["ActivityDTO"];
type Action = "associate" | "adopt" | "ignore" | "restore";
type Command = {
  sourceId: string;
  action: Action;
  expected: number;
  taskId: string;
  criteria: string[];
  reason: string;
};

const statuses = { candidate: "待处理", adopted: "已采纳", ignored: "已忽略" } as const;
const actionLabels = {
  associate: "关联任务",
  adopt: "采纳为候选证据",
  ignore: "忽略记录",
  restore: "恢复待处理",
} as const;
const kindLabels: Record<string, string> = {
  commit: "提交记录",
  pull_request: "拉取请求",
  ci_run: "持续集成",
  pr: "拉取请求",
  ci: "持续集成",
  sync: "同步事件",
  document: "文档",
  message: "消息",
};
const summaryStatusLabels: Record<ActivitySummary["status"], string> = {
  not_generated: "待生成摘要",
  pending: "生成中",
  ready: "AI 已生成 · 待人工确认",
  failed: "生成失败，可重试",
  unsupported: "暂不支持摘要",
};

function selectedFilter(value: string | null) {
  return value && value !== "all" ? value : undefined;
}

function snapshotText(snapshot: Record<string, unknown>, key: string) {
  return typeof snapshot[key] === "string" ? (snapshot[key] as string) : "";
}

function summaryTone(status: ActivitySummary["status"]): "blue" | "green" | "amber" | "red" | "gray" {
  if (status === "ready") return "green";
  if (status === "pending" || status === "not_generated") return "blue";
  if (status === "failed") return "red";
  if (status === "unsupported") return "gray";
  return "gray";
}

function formatActivityPreview(raw: string): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*\[\s*[xX]?\s*\]\s*/, "").trim())
    .filter((line) => Boolean(line))
    .join(" · ");
  return cleaned.length > 180 ? `${cleaned.slice(0, 180)}…` : cleaned;
}

export function ActivityApiPage({ projectId, sourceType }: { projectId: string; sourceType: ActivitySourceType }) {
  const { userId } = useWorkspace();
  return <ActivityPage key={`${userId}:${projectId}:${sourceType}`} projectId={projectId} sourceType={sourceType} userId={userId} />;
}

function ActivityPage({ projectId, sourceType, userId }: { projectId: string; sourceType: ActivitySourceType; userId: string }) {
  const { query, updateQuery } = useUrlQuery();
  const rawStatus = query.get("status");
  const groupFilter = query.has("group_id") ? query.get("group_id") || undefined : selectedFilter(query.get("group"));
  const filters: ActivityQuery = {
    page: pageNumber(query.get("page")),
    page_size: 10,
    q: query.get("q") || undefined,
    status: rawStatus && Object.hasOwn(statuses, rawStatus) ? rawStatus as keyof typeof statuses : undefined,
    task_id: query.get("task") || undefined,
    author_id: query.get("author") || undefined,
    since: query.get("date_from") ? `${query.get("date_from")}T00:00:00Z` : undefined,
    until: query.get("date_to") ? `${query.get("date_to")}T23:59:59.999999Z` : undefined,
    group_id: sourceType === "feishu" ? groupFilter : undefined,
    kind: selectedFilter(query.get("kind")),
  };
  const selectedId = query.get("record");
  const enabled = isUuid(projectId);
  const context = useQuery({ queryKey: ["c-project-context", userId, projectId], queryFn: () => projectApi.projectContext(projectId), enabled, ...queryPolicy });
  const bindings = useQuery({
    queryKey: ["c-project-bindings", userId, projectId, sourceType],
    queryFn: ({ signal }) => readProjectBindings(projectId, sourceType, signal),
    enabled: enabled && context.isSuccess && context.data.actor.is_member,
    ...queryPolicy,
  });
  const list = useQuery({ queryKey: ["c-project-activities", userId, projectId, sourceType, filters], queryFn: () => projectApi.activities(projectId, sourceType, filters), enabled, ...queryPolicy });
  const selectedEnabled = enabled && Boolean(selectedId && isUuid(selectedId)) && context.isSuccess && !context.isFetching;
  const detail = useQuery({ queryKey: ["c-project-activity", userId, projectId, sourceType, selectedId], queryFn: () => projectApi.activity(projectId, sourceType, selectedId!), enabled: selectedEnabled, ...queryPolicy });
  const history = useQuery({ queryKey: ["c-project-activity-history", userId, projectId, sourceType, selectedId], queryFn: () => projectApi.activityHistory(projectId, sourceType, selectedId!), enabled: selectedEnabled, ...queryPolicy });
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const busyRef = useRef(false);
  const [summaryBusy, setSummaryBusy] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const commandKey = useCommandKey();
  const hiddenProject = bindings.error instanceof CApiError && bindings.error.code === "PROJECT_NOT_FOUND" ? bindings.error : null;
  const denial = blocked || hiddenProject || [context.error, list.error, detail.error, history.error, bindings.error].find(accessFailure);
  const access = context.isSuccess && !context.isFetching && !denial ? context.data : undefined;
  const rows = access && list.isSuccess && !list.isFetching ? list.data : undefined;
  const connected = access?.actor.is_member && bindings.isSuccess && !bindings.isFetching ? bindings.data : undefined;
  const summaryIds = sourceType === "github" ? (rows?.items.filter((item) => item.kind === "commit").map((item) => item.source_id) ?? []) : [];
  const summaries = useQuery({
    queryKey: ["a-github-activity-summaries", userId, projectId, summaryIds],
    queryFn: ({ signal }) => projectApi.githubActivitySummaries(projectId, summaryIds, signal),
    enabled: enabled && sourceType === "github" && summaryIds.length > 0 && Boolean(access?.actor.is_member),
    ...queryPolicy,
  });
  const selectedSummaryQuery = useQuery({
    queryKey: ["a-github-activity-summary", userId, projectId, selectedId],
    queryFn: ({ signal }) => projectApi.githubActivitySummary(projectId, selectedId!, signal),
    enabled: selectedEnabled && sourceType === "github" && Boolean(selectedId),
    ...queryPolicy,
  });
  const summaryById = new Map<string, ActivitySummary>((summaries.data ?? []).map((item) => [item.source_id, item]));
  const groups = [...new Set([
    ...(connected?.kind === "feishu" ? connected.items.map((group) => group.chat_id) : []),
    ...(rows?.items.flatMap((item) => item.group_id ? [item.group_id] : []) ?? []),
  ])];
  const kinds = [...new Set([...(sourceType === "github" ? ["commit", "pull_request", "ci_run"] : []), ...(rows?.items.map((item) => item.kind) ?? [])])];
  const authors = [...new Map([
    ...(sourceType === "github" ? access?.members.map((member) => [member.id, member.title] as const) ?? [] : []),
    ...(rows?.items.flatMap((item) => item.author_id ? [[item.author_id, item.author_name || "来源未提供作者名称"] as const] : []) ?? []),
  ]).entries()];
  const record = access && detail.isSuccess && !detail.isFetching ? detail.data : undefined;
  const savedHistory = access && history.isSuccess && !history.isFetching ? history.data : undefined;
  const selectedSummary = selectedSummaryQuery.data ?? (selectedId ? summaryById.get(selectedId) : undefined);
  const targetTask = command && access?.tasks.find((task) => task.id === command.taskId);
  const taskName = (taskId: string | null) => access?.tasks.find((task) => task.id === taskId)?.title ?? "未关联任务";
  const canChange = Boolean(record && access?.permissions.can_manage_activity && record.availability === "available" && record.kind !== "sync");

  function fail(error: unknown) {
    setOperationError(error);
    if (accessFailure(error)) {
      setBlocked(error);
      setCommand(null);
    }
  }

  async function verifyAttachment(id: string) {
    if (busyRef.current || !record || record.availability !== "available") return;
    busyRef.current = true;
    setBusy(true);
    setOperationError(null);
    try {
      await projectApi.verifyFeishuAttachment(projectId, id);
      await detail.refetch();
    } catch (error) {
      fail(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    const results = await Promise.all([
      context.refetch(),
      list.refetch(),
      ...(context.data?.actor.is_member ? [bindings.refetch()] : []),
      ...(selectedId ? [detail.refetch(), history.refetch()] : []),
      ...(summaryIds.length ? [summaries.refetch()] : []),
      ...(selectedId && sourceType === "github" ? [selectedSummaryQuery.refetch()] : []),
    ]);
    const failed = results.find((result) => accessFailure(result.error));
    if (failed) {
      setBlocked(failed.error);
      setCommand(null);
    } else if (results[0].isSuccess) {
      setBlocked(null);
    }
  }

  async function syncExternalSource() {
    if (syncing || busyRef.current || !access?.actor.is_leader) return;
    setSyncing(true);
    setOperationError(null);
    setNotice("");
    try {
      if (sourceType === "github") {
        const result = await projectRequest<components["schemas"]["GithubSyncDTO"]>(
          `/api/v1/a/projects/${projectId}/github/sync`,
          { method: "POST" },
        );
        await refresh();
        setNotice(`已同步最新仓库数据（覆盖默认及活跃分支）：文件 ${result.files} 个、新增提交 ${result.commits ?? 0} 条、PR ${result.pulls ?? 0} 个、CI ${result.ci_runs ?? 0} 次。`);
      } else {
        const result = await projectRequest<{ messages?: number; chats?: number }>(
          `/api/v1/a/projects/${projectId}/feishu/sync`,
          { method: "POST" },
        );
        await refresh();
        setNotice(`已同步飞书协作记录${typeof result.messages === "number" ? `（新增 ${result.messages} 条消息）` : ""}。`);
      }
    } catch (error) {
      fail(error);
    } finally {
      setSyncing(false);
    }
  }

  async function generateSummary(id: string) {
    if (summaryBusy || sourceType !== "github") return;
    setSummaryBusy(id);
    setOperationError(null);
    setNotice("");
    try {
      const result = await projectApi.generateGithubActivitySummary(projectId, id);
      await Promise.all([summaries.refetch(), ...(selectedId === id ? [selectedSummaryQuery.refetch()] : [])]);
      setNotice(result.status === "ready" ? "摘要已生成，内容仍需人工确认。" : "摘要暂未生成，请查看状态后重试。");
    } catch (error) {
      fail(error);
    } finally {
      setSummaryBusy(null);
    }
  }

  async function generatePageSummaries() {
    if (summaryBusy || !summaryIds.length || sourceType !== "github") return;
    setSummaryBusy("batch");
    setOperationError(null);
    setNotice("");
    try {
      const results = await projectApi.generateGithubActivitySummaries(projectId, summaryIds);
      await Promise.all([summaries.refetch(), ...(selectedId ? [selectedSummaryQuery.refetch()] : [])]);
      const failed = results.filter((result) => result.status === "failed").length;
      setNotice(failed ? `${failed} 条摘要生成失败，其余结果仍可查看。` : "本页摘要已生成，内容仍需人工确认。");
    } catch (error) {
      fail(error);
    } finally {
      setSummaryBusy(null);
    }
  }

  function begin(item: Activity, action: Action) {
    setCommand({ sourceId: item.source_id, action, expected: item.lock_version, taskId: item.task_id ?? "", criteria: [], reason: "" });
    setOperationError(null);
    setNotice("");
  }

  async function submit() {
    if (!command || !canChange || busyRef.current || record?.source_id !== command.sourceId) return;
    if (command.action === "adopt" && record.snapshot_complete === false) { setNotice("来源仅提供摘要，需要完整正文才能采纳。"); return; }
    if (!command.reason.trim()) { setNotice("请填写本次操作的原因。"); return; }
    if (command.action === "adopt" && (!targetTask?.can_capture_evidence || !command.criteria.length)) { setNotice("请选择可接收证据的任务及至少一条验收标准。"); return; }
    if (command.action === "associate" && command.taskId && !targetTask?.can_associate) { setNotice("所选任务当前不可关联，请刷新任务范围。"); return; }
    busyRef.current = true;
    setBusy(true);
    setOperationError(null);
    setNotice("");
    try {
      if (command.action === "associate") {
        const input = { task_id: command.taskId || null, expected_version: command.expected, reason: command.reason.trim() };
        await projectApi.associateActivity(projectId, sourceType, command.sourceId, input, commandKey({ projectId, sourceType, sourceId: command.sourceId, action: command.action, input }));
      } else {
        const input = { action: command.action, expected_version: command.expected, reason: command.reason.trim(), ...(command.action === "adopt" ? { task_id: command.taskId, criterion_ids: command.criteria } : {}) };
        await projectApi.decideActivity(projectId, sourceType, command.sourceId, input, commandKey({ projectId, sourceType, sourceId: command.sourceId, input }));
      }
      setCommand(null);
      setNotice(command.action === "adopt" ? "已生成候选证据，尚未成为正式证据。" : "操作已保存，来源历史仍保留。");
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function reviewLatest() {
    if (!command || busyRef.current) return;
    const [latest, permission] = await Promise.all([detail.refetch(), context.refetch()]);
    if (latest.error || permission.error) { fail(latest.error || permission.error); return; }
    if (latest.data && permission.data?.permissions.can_manage_activity) {
      const required = command.action === "restore" ? "ignored" : "candidate";
      if (latest.data.status !== required || latest.data.availability !== "available" || (command.action === "adopt" && latest.data.snapshot_complete === false)) {
        setCommand(null);
        setOperationError(null);
        setNotice("记录状态已变化，请重新选择可用操作。");
      } else {
        setCommand({ ...command, expected: latest.data.lock_version });
        setOperationError(null);
        setNotice("已读取最新状态，请核对输入后再次提交。");
      }
    }
  }

  function selectRecord(id: string) {
    updateQuery({ record: id });
    setCommand(null);
    setOperationError(null);
    setNotice("");
  }

  function closeRecord() {
    updateQuery({ record: null });
    setCommand(null);
    setOperationError(null);
  }

  if (!enabled) return <EmptyState title="项目地址无效" description="请从已授权项目入口打开活动页。" />;

  const canSyncExternal = Boolean(
    access?.actor.is_leader &&
    access.project.lifecycle === "active" &&
    connected &&
    connected.items.length > 0,
  );

  return <>
    <PageHeader
      title={sourceType === "github" ? "GitHub 开发活动" : "飞书协作记录"}
      description={access?.project.name ?? "正在验证项目权限…"}
      actions={<div className="flex flex-wrap items-center gap-2">
        {canSyncExternal && (
          <button
            type="button"
            className={apiPrimaryButton}
            disabled={syncing || busy || Boolean(summaryBusy)}
            onClick={() => void syncExternalSource()}
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? "同步中…" : sourceType === "github" ? "同步 GitHub" : "同步飞书记录"}
          </button>
        )}
        {access?.actor.is_leader && connected && connected.items.length === 0 && (
          <Link
            className={apiPrimaryButton}
            href={`/projects/${projectId}/settings#${sourceType === "github" ? "github-integration" : "feishu-integration"}`}
          >
            {sourceType === "github" ? "连接 GitHub 仓库" : "绑定飞书群"}
          </Link>
        )}
        {sourceType === "github" && summaryIds.length > 0 && <button className={apiButton} disabled={Boolean(summaryBusy) || syncing || summaries.isFetching} onClick={() => void generatePageSummaries()}>{summaryBusy === "batch" ? "生成中…" : "生成本页摘要"}</button>}
        <button className={apiButton} disabled={busy || syncing || Boolean(summaryBusy) || context.isFetching || list.isFetching} onClick={() => void refresh()}>刷新活动</button>
      </div>}
    />
    {denial ? <ApiFailure error={denial} retry={() => void refresh()} /> : <>
      {context.isFetching && <StateBlock tone="loading" title="正在验证项目权限" />}
      {context.isError && <ApiFailure error={context.error} retry={() => void refresh()} />}
      {access && <>
        {syncing && <div className="mb-4"><Feedback tone="info">{sourceType === "github" ? "正在并发同步默认分支与活跃分支的最新提交、PR 与 CI，请稍候…" : "正在同步最新飞书协作记录，请稍候…"}</Feedback></div>}
        {notice && <div className="mb-4"><Feedback tone="success">{notice}</Feedback></div>}
        {operationError ? <ApiFailure error={operationError} /> : null}
        {access.actor.is_member && <Section title="项目绑定状态" surface className="mb-5" action={connected && access.actor.is_leader ? <Link className="gp-link text-sm" href={sourceType === "github" ? `/github/${projectId}` : `/feishu/${projectId}`}>{sourceType === "github" ? "管理 GitHub 仓库绑定" : "管理飞书群绑定"}</Link> : undefined}>
          {bindings.isFetching && <p role="status" className="text-sm text-slate-500">正在读取绑定状态…</p>}
          {bindings.isError && <p className="text-sm text-slate-600">暂时无法读取绑定状态。 <button type="button" className={apiButton} onClick={() => void bindings.refetch()}>重试绑定查询</button></p>}
          {connected?.kind === "feishu" && <p className="text-sm text-slate-700">{connected.items.length ? `已绑定 ${connected.items.length} 个飞书群` : "此项目尚未绑定飞书群。"}</p>}
          {connected?.kind === "github" && (connected.items.length ? <div className="space-y-2"><div className="flex flex-wrap items-center gap-3">{connected.items.map((repo) => <div key={repo.owner + "/" + repo.repo} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50/90 px-3.5 py-2 text-sm"><a className="gp-link font-semibold" href={`https://github.com/${repo.owner}/${repo.repo}`} target="_blank" rel="noopener noreferrer">{repo.owner}/{repo.repo}</a><span className="gp-pill">默认分支 {repo.default_branch} + 活跃分支</span><span className="text-xs text-slate-500">{repo.last_synced_at ? `仓库文件与开发活动上次同步 ${formatDate(repo.last_synced_at)}` : "尚未同步仓库文件与开发活动"}</span></div>)}</div><p className="text-xs text-slate-500">分页总数按当前筛选统计本项目已同步的活动快照；记录谁在何时提交了代码，并由 AI 按统一结构化规范分析具体实现的功能。</p></div> : <p className="text-sm text-slate-600">此项目尚未绑定 GitHub 仓库。</p>)}
        </Section>}
        {!access.permissions.can_manage_activity && (
          access.actor.is_member && access.project.lifecycle === "active" && access.tasks.length === 0 ? (
            <div className="mb-4">
              <Feedback tone="info">
                任务计划尚未冻结：当前可以随时同步代码并用 AI 分析每次提交实现的功能；冻结任务计划后，即可将提交直接关联任务或采纳为证据。
                <Link className="ml-2 font-medium underline" href={`/projects/${projectId}/planning`}>前往任务规划 →</Link>
              </Feedback>
            </div>
          ) : (
            <p className="mb-4 text-sm text-slate-500">当前活动记录只读。</p>
          )
        )}
        {sourceType === "github" && (
          <div className="gp-segmented mb-4" role="tablist" aria-label="GitHub 活动类型快捷筛选">
            {([
              ["", "全部活动"],
              ["commit", "代码提交"],
              ["pull_request", "拉取请求"],
              ["ci_run", "持续集成"],
            ] as const).map(([value, label]) => {
              const active = (filters.kind ?? "") === value;
              return (
                <button
                  key={value || "all"}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-active={active ? "true" : undefined}
                  className="gp-segmented-item"
                  onClick={() => { updateQuery({ kind: value || null, page: null, record: null }); setCommand(null); }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <form key={`${filters.q}:${filters.status}:${filters.task_id}:${filters.author_id}:${filters.since}:${filters.until}:${filters.group_id}:${filters.kind}`} className="gp-toolbar mb-5" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const fields = Object.fromEntries(["q", "status", "task", "author", "date_from", "date_to", "kind"].map((field) => [field, String(form.get(field) ?? "").trim() || null]));
          updateQuery({ ...fields, group_id: sourceType === "feishu" ? String(form.get("group_id") ?? "") || null : null, group: null, page: null, record: null });
          setCommand(null);
        }}>
          <label>搜索记录<input className={`${apiInput} block`} name="q" maxLength={200} defaultValue={filters.q ?? ""} placeholder="标题或关键字" /></label>
          {sourceType === "feishu" && <label>来源群组<select className={`${apiInput} block max-w-xs`} name="group_id" defaultValue={filters.group_id ?? ""}><option value="">全部群组</option>{filters.group_id && <option value={filters.group_id}>{groups.includes(filters.group_id) ? filters.group_id : "当前 URL 群组筛选（待来源核对）"}</option>}{groups.filter((group) => group !== filters.group_id).map((group) => <option key={group} value={group}>{group}</option>)}</select></label>}
          <label>记录类型<select className={`${apiInput} block`} name="kind" defaultValue={filters.kind ?? ""}><option value="">全部类型</option>{filters.kind && <option value={filters.kind}>{Object.hasOwn(kindLabels, filters.kind) ? kindLabels[filters.kind] : kinds.includes(filters.kind) ? filters.kind : "当前 URL 类型筛选（待来源核对）"}</option>}{kinds.filter((kind) => kind !== filters.kind).map((kind) => <option key={kind} value={kind}>{Object.hasOwn(kindLabels, kind) ? kindLabels[kind] : kind}</option>)}</select></label>
          <label>处理状态<select className={`${apiInput} block`} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>关联任务<select className={`${apiInput} block`} name="task" defaultValue={filters.task_id ?? ""}><option value="">全部任务</option>{access.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
          <label>记录作者<select className={`${apiInput} block`} name="author" defaultValue={filters.author_id ?? ""}><option value="">全部作者</option>{filters.author_id && !authors.some(([id]) => id === filters.author_id) && <option value={filters.author_id}>当前 URL 作者筛选（待来源核对）</option>}{authors.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label>开始日期<input className={`${apiInput} block`} type="date" name="date_from" defaultValue={query.get("date_from") ?? ""} /></label>
          <label>结束日期<input className={`${apiInput} block`} type="date" name="date_to" defaultValue={query.get("date_to") ?? ""} /></label>
          <div className="flex flex-wrap gap-2"><button className={apiButton} type="submit">查询活动</button><button className={apiButton} type="button" onClick={() => { updateQuery({ q: null, status: null, task: null, author: null, date_from: null, date_to: null, group_id: null, group: null, kind: null, page: null, record: null }); setCommand(null); }}>重置</button></div>
        </form>
        {list.isFetching && <StateBlock tone="loading" title="正在读取活动" />}
        {list.isError && <ApiFailure error={list.error} retry={() => void refresh()} />}
        {rows && <Section title={`${sourceType === "github" ? "开发活动" : "协作记录"} · ${rows.total}`}>
          <div className="gp-list">
            {rows.items.map((item) => {
              const isCommit = sourceType === "github" && item.kind === "commit";
              const summary = isCommit ? summaryById.get(item.source_id) : undefined;
              const displayTitle = isCommit ? summary?.headline || item.title : item.title;
              const cleanedPreview = formatActivityPreview(item.summary);
              const distinctPreview = cleanedPreview && cleanedPreview !== item.title.trim() ? cleanedPreview : "";
              const displaySummary = isCommit
                ? summary?.implementation || distinctPreview || "尚未生成 AI 摘要。点击“生成摘要”查看实现说明，或点“查看记录”浏览原始提交。"
                : cleanedPreview;
              return <ListRow key={item.source_id} leading={<Avatar name={item.author_name || "来"} />} title={displayTitle} meta={<>{item.author_name || "来源未提供作者名称"} · {kindLabels[item.kind] ?? item.kind}{item.github_state && ` · ${item.github_state}`} · {formatDate(item.occurred_at)} · {taskName(item.task_id)}</>} actions={<div className="flex flex-wrap items-center gap-2"><StatusBadge status={item.status} label={statuses[item.status]} />{isCommit && summary && <StatusBadge label={summaryStatusLabels[summary.status]} tone={summaryTone(summary.status)} />}{isCommit && (!summary || summary.status === "not_generated" || summary.status === "failed") && <button className={apiButton} type="button" disabled={Boolean(summaryBusy)} onClick={() => void generateSummary(item.source_id)}><Sparkles size={13} />{summaryBusy === item.source_id ? "分析中…" : summary?.status === "failed" ? "重试摘要" : "生成摘要"}</button>}<button className={apiButton} type="button" onClick={() => selectRecord(item.source_id)}>查看记录</button></div>}>
                {isCommit && summary?.status === "ready" ? (
                  <div className="mt-2.5 max-w-3xl rounded-xl border border-sky-100/90 bg-sky-50/45 px-3.5 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1 font-semibold text-sky-700"><Sparkles size={12} />AI 功能分析</span>
                      {summary.confidence !== null && summary.confidence !== undefined && <span>置信度 {Math.round(summary.confidence * 100)}%</span>}
                      <span>·</span>
                      <span>提交人：{item.author_name || "未知"}</span>
                    </div>
                    {summary.implementation && <p className="mt-1.5 leading-6 text-slate-700"><strong className="font-semibold text-slate-800">实现内容：</strong>{summary.implementation}</p>}
                    {summary.impact && <p className="mt-1 text-xs leading-5 text-slate-600"><strong className="font-semibold text-slate-700">影响范围：</strong>{summary.impact}</p>}
                    {((summary.verification?.length ?? 0) > 0 || (summary.risks?.length ?? 0) > 0) && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                        {summary.verification?.slice(0, 2).map((v) => <span key={v} className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">验证：{v}</span>)}
                        {summary.risks?.slice(0, 2).map((r) => <span key={r} className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">风险：{r}</span>)}
                      </div>
                    )}
                  </div>
                ) : (
                  displaySummary && <p className="mt-1.5 line-clamp-2 max-w-3xl text-sm leading-6 text-slate-600">{displaySummary}</p>
                )}
              </ListRow>;
            })}
          </div>
          {!rows.items.length && <EmptyState title="没有符合条件的来源记录" description={sourceType === "github" ? "点击右上角“同步 GitHub”后，默认分支与活跃分支的提交、PR 和 CI 会在这里出现。" : "点击右上角“同步飞书记录”后，消息会在这里出现。"} />}
          <ApiPager page={rows.page} pageSize={rows.page_size} total={rows.total} change={(page) => { updateQuery({ page: String(page), record: null }); setCommand(null); }} />
        </Section>}
        <DetailDrawer open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) closeRecord(); }} title={record?.title ?? "记录详情"} description={record ? `${record.author_name || "来源未提供作者名称"} · ${kindLabels[record.kind] ?? record.kind} · ${formatDate(record.occurred_at)}` : "正在读取来源快照…"}>
          {detail.isFetching && <StateBlock tone="loading" title="正在读取来源" />}
          {detail.isError && <ApiFailure error={detail.error} retry={() => void detail.refetch()} label="重试来源" />}
          {record && <div className="space-y-5">
            {sourceType === "github" && record.kind === "commit" && <Section title="AI 代码功能分析" description="由统一代码分析系统提示词基于真实代码差异与提交信息生成，输出格式严格一致；结果仅供人工确认。" surface>
              {selectedSummaryQuery.isFetching && <p role="status" className="text-sm text-slate-500">正在读取分析结果…</p>}
              {selectedSummary && <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><StatusBadge label={summaryStatusLabels[selectedSummary.status]} tone={summaryTone(selectedSummary.status)} />{selectedSummary.confidence !== null && selectedSummary.confidence !== undefined && <span className="gp-pill">置信度 {Math.round(selectedSummary.confidence * 100)}%</span>}<span className="text-xs text-slate-500">提交人：{record.author_name || "未知"} · {formatDate(record.occurred_at)}</span></div>{selectedSummary.headline && <p className="text-base font-semibold text-slate-900">{selectedSummary.headline}</p>}{selectedSummary.implementation && <div className="rounded-xl bg-slate-50/90 p-3 text-sm leading-6 text-slate-700"><strong className="mb-1 block text-xs font-semibold text-slate-500">实现功能</strong>{selectedSummary.implementation}</div>}{selectedSummary.impact && <p className="text-sm leading-6 text-slate-600"><strong className="font-semibold text-slate-800">影响范围：</strong>{selectedSummary.impact}</p>}{selectedSummary.verification?.length ? <div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">测试与验证</h3><ul className="mt-1 list-disc pl-5 text-sm text-slate-600">{selectedSummary.verification.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}{selectedSummary.risks?.length ? <div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">风险与待核验</h3><ul className="mt-1 list-disc pl-5 text-sm text-slate-600">{selectedSummary.risks.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}{selectedSummary.insufficient_context?.length ? <p className="rounded-lg bg-amber-50/70 px-3 py-2 text-xs text-amber-800">上下文不足：{selectedSummary.insufficient_context.join("；")}</p> : null}{selectedSummary.evidence?.length ? <div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">代码与来源引证</h3><ul className="mt-1.5 space-y-2 text-xs text-slate-600">{selectedSummary.evidence.map((item, index) => <li key={`${item.source}-${index}`} className="rounded-lg bg-slate-50 px-2.5 py-1.5"><span className="gp-pill mr-2">{item.source}</span>“{item.quote}”</li>)}</ul></div> : null}{(selectedSummary.status === "not_generated" || selectedSummary.status === "failed") && <button className={apiPrimaryButton} type="button" disabled={Boolean(summaryBusy)} onClick={() => void generateSummary(record.source_id)}><Sparkles size={14} />{summaryBusy === record.source_id ? "分析中…" : selectedSummary.status === "failed" ? "重试摘要" : "生成摘要"}</button>}</div>}
              {!selectedSummary && !selectedSummaryQuery.isFetching && <StateBlock title="尚未生成分析摘要" description="点击下方按钮，由 AI 按统一代码分析规范提炼本次提交实现的功能。" action={<button className={apiPrimaryButton} type="button" disabled={Boolean(summaryBusy)} onClick={() => void generateSummary(record.source_id)}><Sparkles size={14} />生成摘要</button>} />}
            </Section>}
            <Section title="来源详情" description="原始内容是事实来源，AI 摘要不会替代它。">
              <p className="text-sm leading-6 text-slate-700">{record.summary}</p>
              <p className="mt-3 text-xs text-slate-500">{statuses[record.status]} · {taskName(record.task_id)}{record.snapshot_complete === false ? " · 当前快照不完整" : ""}</p>
              {safeHttps(record.source_url, sourceType === "github") && <a className="gp-link mt-3 inline-block" href={safeHttps(record.source_url, sourceType === "github")!} target="_blank" rel="noopener noreferrer">查看原始来源</a>}
              <details className="mt-4 rounded-lg bg-slate-50 p-3"><summary className="cursor-pointer text-sm font-semibold">展开原始提交 / 消息</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-600">{record.title}{record.summary ? `\n\n${record.summary}` : ""}</pre></details>
              {record.suggested_task_ids.length > 0 && <p className="mt-3 text-sm">关联建议：{record.suggested_task_ids.map((id) => access.tasks.find((task) => task.id === id)?.title).filter(Boolean).join("、") || "暂无可读任务"}（需人工确认）</p>}
              {record.snapshot_complete === false && <p className="mt-3 text-sm text-amber-800">{record.feishu_attachments?.some((attachment) => !attachment.verified) ? "请先核验当前消息的附件指纹，再采纳证据。" : "当前来源仅提供摘要，获得完整正文后才可采纳为候选证据。"}</p>}
              {record.source_changed && <p className="mt-3 text-sm text-amber-800">来源与最近保存的快照不同，旧快照仍保留。正式证据状态需另行核查。</p>}
              {record.availability === "deleted" && <p className="mt-3 text-sm">来源已删除，不可进行新的采纳或关联。</p>}
              {sourceType === "feishu" && record.feishu_attachments?.map((attachment) => <div key={attachment.id} className="mt-3 text-sm">{attachment.name || attachment.kind} · {attachment.verified ? <span className="break-all">已核验 · {attachment.size_bytes} 字节 · SHA-256 {attachment.sha256}</span> : <button className={apiButton} disabled={busy || record.availability === "deleted"} onClick={() => void verifyAttachment(attachment.id)}>核验附件指纹</button>}</div>)}
              {(record.evidence_id || record.source_changed) && <p className="mt-3 text-sm"><Link className="gp-link" href={record.evidence_id && isUuid(record.evidence_id) ? `/projects/${projectId}/evidence?evidence=${encodeURIComponent(record.evidence_id)}` : `/projects/${projectId}/evidence?${new URLSearchParams({ source: sourceType, ...(record.task_id && isUuid(record.task_id) ? { task: record.task_id } : {}) })}`}>{record.evidence_id && isUuid(record.evidence_id) ? "查看关联证据并检查来源" : "到证据中心查找相关来源"}</Link>{record.source_changed && <span> · 在证据详情中，由有权限的成员填写原因并主动检查；打开页面不会改变证据。</span>}</p>}
            </Section>
            {canChange && <Section title="下一步操作" description="操作会写入来源历史；正式证据仍需要人工确认。"><div className="flex flex-wrap gap-2">{record.status === "candidate" && <><button className={apiButton} disabled={busy} onClick={() => begin(record, "associate")}>关联任务</button><button className={apiPrimaryButton} disabled={busy || record.snapshot_complete === false || !access.permissions.can_capture_evidence} onClick={() => begin(record, "adopt")}>采纳为候选证据</button><button className={apiButton} disabled={busy} onClick={() => begin(record, "ignore")}>忽略记录</button></>}{record.status === "ignored" && <button className={apiButton} disabled={busy} onClick={() => begin(record, "restore")}>恢复待处理</button>}</div></Section>}
            <Section title="操作历史"><div>{history.isFetching && <p role="status">正在读取历史…</p>}{history.isError && !(history.error instanceof CApiError && history.error.code === "ACTIVITY_HISTORY_NOT_FOUND") && <ApiFailure error={history.error} retry={() => void history.refetch()} label="重试历史" />}{history.isError && history.error instanceof CApiError && history.error.code === "ACTIVITY_HISTORY_NOT_FOUND" && <p className="text-sm text-slate-500">还没有保存的处理记录。</p>}{savedHistory && <>{savedHistory.decisions.map((decision) => <div key={decision.id} className="border-b border-slate-100 py-3 last:border-0"><p className="text-sm">{actionLabels[decision.action]} · {decision.reason}</p><p className="text-xs text-slate-500">{formatDate(decision.created_at)} · 当时来源：{snapshotText(decision.source_snapshot, "title") || "未提供标题"} · {snapshotText(decision.source_snapshot, "author_name") || "未提供作者名称"}</p></div>)}{!savedHistory.decisions.length && <p className="text-sm text-slate-500">还没有保存的处理记录。</p>}</>}</div></Section>
            {command && command.sourceId === selectedId && access.permissions.can_manage_activity && <Section title={actionLabels[command.action]} surface>
              {(command.action === "associate" || command.action === "adopt") && <><label htmlFor="activity-task">目标任务</label><select id="activity-task" className={`${apiInput} mb-3 mt-1 block w-full`} value={command.taskId} disabled={busy} onChange={(event) => setCommand({ ...command, taskId: event.target.value, criteria: [] })}><option value="">{command.action === "associate" ? "取消任务关联" : "请选择任务"}</option>{access.tasks.filter((task) => command.action === "adopt" ? task.can_capture_evidence : task.can_associate).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></>}
              {command.action === "adopt" && <fieldset className="mb-3"><legend>对应验收标准（至少一条）</legend>{targetTask?.criteria.map((criterion) => <label key={criterion.id} className="my-2 flex items-center gap-2"><input type="checkbox" disabled={busy} checked={command.criteria.includes(criterion.id)} onChange={(event) => setCommand({ ...command, criteria: event.target.checked ? [...command.criteria, criterion.id] : command.criteria.filter((id) => id !== criterion.id) })} />{criterion.text}</label>)}{!targetTask?.criteria.length && <p className="text-sm">所选任务暂无可用验收标准。</p>}</fieldset>}
              <label htmlFor="activity-reason">本次操作原因</label><textarea id="activity-reason" className={`${apiInput} mt-1 block w-full`} maxLength={2000} value={command.reason} disabled={busy} onChange={(event) => setCommand({ ...command, reason: event.target.value })} /><div className="mt-3 flex flex-wrap gap-2"><button className={apiButton} disabled={busy || !canChange} onClick={() => void submit()}>{busy ? "保存中…" : "确认操作"}</button><button className={apiButton} disabled={busy} onClick={() => setCommand(null)}>取消</button>{versionFailure(operationError) && <button className={apiButton} disabled={busy} onClick={() => void reviewLatest()}>刷新并核对状态</button>}</div>
            </Section>}
          </div>}
        </DetailDrawer>
      </>}
    </>}
  </>;
}
