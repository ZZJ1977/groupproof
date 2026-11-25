"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArrowLeft, History, Plug, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { Feedback, StateBlock, StatusBadge } from "@/components/common";
import { button, dangerButton, secondary } from "@/features/b/ui";
import { FeishuChatBinding } from "@/features/feishu-binding/FeishuChatBinding";
import { GithubRepoBinding } from "@/features/github-binding/GithubRepoBinding";
import { projectRequest } from "@/features/github-binding/integration-request";
import { ApiFailure, projectApi, queryPolicy } from "@/features/c/c-project-api";
import { useWorkspace } from "@/lib/workspace";

type Settings = {
  name: string;
  project_type: string | null;
  language: string | null;
  visibility: "members" | "course";
  lifecycle: string;
};
type Reopen = {
  new_project_id: string;
  version_label: string;
  copy_scope: string;
  reason: string;
  created_at: string;
};

const lifecycleLabels: Record<string, string> = {
  active: "进行中",
  archived: "已归档",
};

const cardClass = "overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs";
const cardHeaderClass = "flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5";
const fieldLabelClass = "mb-1 block text-xs font-semibold text-slate-600";
const fieldInputClass =
  "h-9 w-full rounded-lg border border-slate-200/90 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 read-only:bg-slate-50/80 read-only:text-slate-600 disabled:bg-slate-50 disabled:text-slate-500";
const fieldTextareaClass =
  "w-full rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:bg-slate-50 disabled:text-slate-500";

export function ProjectSettingsApiPage({ projectId, reopenView }: { projectId: string; reopenView: boolean }) {
  const base = `/api/v1/projects/${projectId}`;
  const { userId } = useWorkspace();
  const context = useQuery({
    queryKey: ["c-project-context", userId, projectId],
    queryFn: () => projectApi.projectContext(projectId),
    ...queryPolicy,
  });
  const access = context.isSuccess ? context.data : null;
  const member = Boolean(access?.actor.is_member);
  const leader = member && Boolean(access?.actor.is_leader);
  const writable =
    leader && access?.project.lifecycle === "active" && access.permissions.can_manage_files && !context.isFetching;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<Reopen[]>([]);
  const [form, setForm] = useState({
    name: "",
    project_type: "",
    language: "",
    visibility: "members" as "members" | "course",
  });
  const [version, setVersion] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"full" | "baseline">("full");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [next, versions] = await Promise.all([
      projectRequest<Settings>(`${base}/settings`),
      projectRequest<Reopen[]>(`${base}/reopens`),
    ]);
    setSettings(next);
    setHistory(versions);
    setForm({
      name: next.name,
      project_type: next.project_type ?? "",
      language: next.language ?? "",
      visibility: next.visibility,
    });
  }, [base]);

  useEffect(() => {
    if (member) void refresh().catch((failure) => setError(failure.message));
  }, [member, refresh]);

  async function save(path: string, method: "POST" | "PUT", body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await projectRequest(path, { method, body });
      await Promise.all([refresh(), context.refetch()]);
      setNotice("已保存");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (context.isError) return <ApiFailure error={context.error} retry={() => void context.refetch()} />;
  if (!access) return <StateBlock tone="loading" title="正在读取项目权限…" />;
  if (!member) return <Feedback tone="warning">项目设置和绑定仅对本项目成员开放。</Feedback>;

  const showReopenCard = leader && (reopenView || settings?.lifecycle === "archived");

  const reopenCard = showReopenCard ? (
    <section aria-labelledby="project-reopen-title" className={cardClass}>
      <div className={cardHeaderClass}>
        <h2 id="project-reopen-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <RotateCcw size={14} className="text-sky-600" aria-hidden="true" />
          重新开启
        </h2>
        <span className="text-xs text-slate-500">基于当前归档快照创建新迭代</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={fieldLabelClass} htmlFor="reopen-ver">
              新版本号
            </label>
            <input
              id="reopen-ver"
              aria-label="新版本号"
              placeholder="例如 v2.0"
              className={fieldInputClass}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            />
          </div>
          <div>
            <label className={fieldLabelClass} htmlFor="reopen-scope">
              复制范围
            </label>
            <select
              id="reopen-scope"
              aria-label="复制范围"
              className={fieldInputClass}
              value={scope}
              onChange={(event) => setScope(event.target.value as "full" | "baseline")}
            >
              <option value="full">复制项目结构</option>
              <option value="baseline">仅复制基线</option>
            </select>
          </div>
        </div>
        <div>
          <label className={fieldLabelClass} htmlFor="reopen-reason">
            重新开启原因
          </label>
          <textarea
            id="reopen-reason"
            aria-label="重新开启原因"
            rows={2}
            placeholder="说明迭代目标或变更原因"
            className={fieldTextareaClass}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/40 px-4 py-2.5">
        <span className="text-xs text-slate-500">原归档版本快照保持只读不变。</span>
        <button
          type="button"
          className={`${button} h-9 px-3.5 text-xs`}
          disabled={busy || settings?.lifecycle !== "archived" || !version.trim() || !reason.trim()}
          onClick={() => void save(`${base}/reopen`, "POST", { version_label: version, reason, copy_scope: scope })}
        >
          <RotateCcw size={14} aria-hidden="true" />
          创建新项目版本
        </button>
      </div>
    </section>
  ) : null;

  const reopenHistoryCard =
    history.length > 0 ? (
      <section aria-labelledby="project-reopen-history-title" className={cardClass}>
        <div className={cardHeaderClass}>
          <h2 id="project-reopen-history-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <History size={14} className="text-slate-500" aria-hidden="true" />
            重新开启历史
          </h2>
          <span className="inline-flex items-center rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] font-medium text-slate-600">
            {history.length} 条
          </span>
        </div>
        <div className="divide-y divide-slate-100 px-4 py-1 text-xs">
          {history.map((row) => (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2.5" key={row.new_project_id}>
              <span className="min-w-0 text-slate-600">
                <strong className="font-semibold text-slate-900">{row.version_label}</strong>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">{row.copy_scope}</span>
                <span className="mx-1.5 text-slate-300">·</span>
                <span>{row.reason}</span>
              </span>
              <Link className="gp-link shrink-0 font-medium" href={`/projects/${row.new_project_id}`}>
                查看新项目 →
              </Link>
            </div>
          ))}
        </div>
      </section>
    ) : null;

  return (
    <div className="space-y-3.5">
      <header className="mb-3.5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/75 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight text-slate-900">
              {reopenView ? "重新开启项目" : "项目设置"}
            </h1>
            {settings && (
              <StatusBadge status={settings.lifecycle} label={lifecycleLabels[settings.lifecycle] ?? settings.lifecycle} />
            )}
            {!writable && settings?.lifecycle === "active" && (
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                只读视图
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {reopenView
              ? "基于归档快照创建新的迭代版本，原项目记录保持只读。"
              : "管理项目基础信息、外部仓库与飞书群集成，以及归档与版本重开。"}
          </p>
        </div>
        <Link className={`${secondary} h-9 px-3 text-xs`} href={`/projects/${projectId}`}>
          <ArrowLeft size={14} aria-hidden="true" />
          返回项目总览
        </Link>
      </header>

      {error && (
        <div role="alert">
          <Feedback tone="error">{error}</Feedback>
        </div>
      )}
      {notice && <Feedback tone="success">{notice}</Feedback>}

      {!reopenView ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3.5">
            <section id="project-details" aria-labelledby="project-details-title" className={`${cardClass} scroll-mt-20`}>
              <div className={cardHeaderClass}>
                <h2 id="project-details-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <SlidersHorizontal size={14} className="text-slate-500" aria-hidden="true" />
                  基本设置
                </h2>
                <span className="text-xs text-slate-500">
                  {writable ? "组长可调整项目信息与可见范围" : "当前为只读视图"}
                </span>
              </div>
              <div className="p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={fieldLabelClass} htmlFor="proj-set-name">
                      项目名称
                    </label>
                    <input
                      id="proj-set-name"
                      aria-label="项目名称"
                      className={fieldInputClass}
                      value={form.name}
                      readOnly={!writable}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </div>
                  <div>
                    <label className={fieldLabelClass} htmlFor="proj-set-vis">
                      可见范围
                    </label>
                    <select
                      id="proj-set-vis"
                      aria-label="可见范围"
                      className={fieldInputClass}
                      value={form.visibility}
                      disabled={!writable}
                      onChange={(event) => setForm({ ...form, visibility: event.target.value as "members" | "course" })}
                    >
                      <option value="members">仅项目成员</option>
                      <option value="course">课程成员</option>
                    </select>
                  </div>
                  <div>
                    <label className={fieldLabelClass} htmlFor="proj-set-type">
                      项目类型
                    </label>
                    <input
                      id="proj-set-type"
                      aria-label="项目类型"
                      className={fieldInputClass}
                      placeholder="例如：Web 应用、移动应用"
                      value={form.project_type}
                      readOnly={!writable}
                      onChange={(event) => setForm({ ...form, project_type: event.target.value })}
                    />
                  </div>
                  <div>
                    <label className={fieldLabelClass} htmlFor="proj-set-lang">
                      项目语言
                    </label>
                    <input
                      id="proj-set-lang"
                      aria-label="项目语言"
                      maxLength={16}
                      className={fieldInputClass}
                      placeholder="例如：中文、English"
                      value={form.language}
                      readOnly={!writable}
                      onChange={(event) => setForm({ ...form, language: event.target.value })}
                    />
                  </div>
                </div>
              </div>
              {leader && (
                <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/40 px-4 py-2.5">
                  <span className="text-xs text-slate-500">
                    {settings?.lifecycle === "archived" ? "项目已归档，基础信息不可修改。" : "保存后即时同步至项目成员。"}
                  </span>
                  <button
                    type="button"
                    className={`${button} h-9 px-3.5 text-xs`}
                    disabled={!writable || busy || settings?.lifecycle !== "active" || !form.name.trim()}
                    onClick={() => void save(`${base}/settings`, "PUT", form)}
                  >
                    <Save size={14} aria-hidden="true" />
                    保存设置
                  </button>
                </div>
              )}
            </section>

            {leader && (
              <section aria-labelledby="project-archive-title" className={cardClass}>
                <div className={cardHeaderClass}>
                  <h2 id="project-archive-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Archive size={14} className="text-rose-600" aria-hidden="true" />
                    项目归档
                  </h2>
                  <span className="text-xs text-slate-500">
                    {settings?.lifecycle === "archived" ? "只读快照" : "结项封存"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-600">
                    {settings?.lifecycle === "archived"
                      ? "当前项目已完成归档，所有内容已封存为只读快照。"
                      : "任务验收、贡献冻结及结项报告定稿后可归档封存，归档后转为只读快照。"}
                  </p>
                  <button
                    type="button"
                    className={`${dangerButton} h-9 px-3 text-xs`}
                    disabled={!writable || busy || settings?.lifecycle !== "active"}
                    onClick={() => {
                      if (window.confirm("确认归档？报告、任务和贡献必须已定稿。")) void save(`${base}/archive`, "POST");
                    }}
                  >
                    <Archive size={14} aria-hidden="true" />
                    确认归档项目
                  </button>
                </div>
              </section>
            )}

            {reopenCard}
            {reopenHistoryCard}
          </div>

          <section
            id="project-integrations"
            aria-labelledby="project-integrations-title"
            className="min-w-0 scroll-mt-20 space-y-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              <h2 id="project-integrations-title" className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                <Plug size={14} className="text-slate-500" aria-hidden="true" />
                项目集成
              </h2>
              <span className="text-xs text-slate-500">
                {writable ? "同步代码提交、PR、CI 与群聊协作" : "仅组长在活跃期可绑定或同步"}
              </span>
            </div>
            <div id="github-integration" className="min-w-0 scroll-mt-20">
              <GithubRepoBinding projectId={projectId} userId={userId} canManage={writable} />
            </div>
            <div id="feishu-integration" className="min-w-0 scroll-mt-20">
              <FeishuChatBinding projectId={projectId} userId={userId} canManage={writable} />
            </div>
          </section>
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3.5">{reopenCard}</div>
          <div className="min-w-0 space-y-3.5">{reopenHistoryCard}</div>
        </div>
      )}
    </div>
  );
}
