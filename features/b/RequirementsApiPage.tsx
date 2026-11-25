"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCheck, GitCompare, History, Network, PenLine, Search } from "lucide-react";
import { EmptyState, Feedback, PageHeader, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bManageApi, type BRequirementDetail } from "@/lib/api/b-manage";
import { bProjectsApi } from "@/lib/api/b-projects";
import { bRequirementsApi, type BPriority } from "@/lib/api/b-requirements";
import { BaselineStep, ConflictsStep, RequirementsStep, RunStatus } from "@/features/b/RequirementsSteps";
import { useUrlFilters } from "@/lib/use-url-filters";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";
import { useUiText } from "@/lib/i18n/use-ui-text";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;

const statusLabel: Record<string, string> = { draft: "草稿", confirmed: "已确认", in_progress: "进行中", implemented: "已实现", verified: "已验收" };
const priorityLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
const filterSchema = {
  code: { kind: "string" },
  q: { kind: "string" },
  source: { kind: "string" },
  module: { kind: "string" },
  status: { kind: "enum", values: ["", "draft", "confirmed", "in_progress", "implemented", "verified"], default: "" },
  page: { kind: "int", default: 1, min: 1 },
  req: { kind: "string" },
  tab: { kind: "enum", values: ["detail", "versions", "trace"], default: "detail" },
} as const;
const PAGE_SIZE = 20;

const compactInput = "h-9 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";
const compactBtn = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const compactSecondary = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

/** Page 09 (B4-01 ~ B4-03): requirement list with URL filters, change with reason, versions, trace. */
export function RequirementsApiPage({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const cache = useQueryClient();
  const { filters, setFilters, clearFilters } = useUrlFilters(filterSchema);
  const [workspaceSection, setWorkspaceSection] = useState<"work" | "conflicts" | "baseline">("work");
  const [draft, setDraft] = useState({ code: filters.code, q: filters.q });
  const [batchNotice, setBatchNotice] = useState<Notice>();
  const [batchConfirming, setBatchConfirming] = useState(false);

  useEffect(() => setDraft({ code: filters.code, q: filters.q }), [filters.code, filters.q]);

  const query = {
    code: filters.code || undefined,
    q: filters.q || undefined,
    source: filters.source || undefined,
    module: filters.module || undefined,
    status: filters.status || undefined,
    page: filters.page,
    page_size: PAGE_SIZE,
  };
  const list = useQuery({ queryKey: ["b-req-list", userId, projectId, query], queryFn: () => bManageApi.list(projectId, query), ...queryPolicy });
  const board = useQuery({ queryKey: ["b-requirements", userId, projectId], queryFn: () => bRequirementsApi.board(projectId), ...queryPolicy });

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const editableDraft = board.data?.editable !== false;
  const showManageList = board.isError || !editableDraft || !list.isSuccess || list.data.total > 0;
  const aiCount = board.data?.requirements.filter((r) => r.origin === "ai" && !r.excluded).length ?? 0;
  const moduleCount = board.data?.modules.length ?? list.data?.modules.length ?? 0;
  const reqTotal = list.data?.total ?? board.data?.requirements.length ?? 0;
  const draftReqCount = board.data?.requirements.filter((r) => !r.excluded && r.status === "draft").length ?? 0;

  const invalidateAll = () => {
    for (const name of ["b-requirements", "b-req-list", "b-checklist", "b-baseline", "b-project-setup", "b-project-overview", "b-plan", "b-tasks", "b-milestones"]) {
      void cache.invalidateQueries({ queryKey: [name, userId, projectId] });
    }
  };

  const handleBatchConfirmAll = async () => {
    if (!board.data || batchConfirming) return;
    if (board.data.open_conflicts > 0) {
      setWorkspaceSection("conflicts");
      setBatchNotice({ tone: "warning", text: tr("还有 {0} 个未解决的冲突，请先处理冲突再一键确认需求。", { 0: board.data.open_conflicts }) });
      return;
    }
    setBatchConfirming(true);
    setBatchNotice(undefined);
    try {
      const [checklist, overview] = await Promise.all([
        bRequirementsApi.checklist(projectId),
        bProjectsApi.overview(projectId),
      ]);
      if (!checklist.in_scope.trim()) {
        const modNames = board.data.modules.map((m) => m.name).filter(Boolean).slice(0, 6).join("、");
        const autoScope = modNames
          ? tr("覆盖 {0} 等功能模块的核心需求实现与验收交付。", { 0: modNames })
          : tr("覆盖当前已整理的全部功能需求实现与验收交付。");
        await bRequirementsApi.saveScope(projectId, { in_scope: autoScope, out_of_scope: checklist.out_of_scope }, checklist.scope_version);
      }
      const fallbackOwner = overview.members.find((m) => m.id === userId)?.id ?? overview.members[0]?.id ?? null;
      if (fallbackOwner) {
        const unassignedModules = board.data.modules.filter((m) => !m.owner?.id);
        for (const mod of unassignedModules) {
          await bRequirementsApi.updateModule(projectId, mod, { owner_id: fallbackOwner });
        }
      }
      const uncheckedManual = checklist.items.filter((item) => item.kind === "manual" && !item.passed);
      for (const item of uncheckedManual) {
        await bRequirementsApi.check(projectId, item.key, true);
      }
      if (overview.is_leader) {
        const res = await bRequirementsApi.submit(projectId);
        invalidateAll();
        if (res.status === "frozen") {
          setBatchNotice({ tone: "success", text: tr("已一键确认全部需求，需求基线 v{0} 已冻结。", { 0: res.version_no }) });
        } else {
          setWorkspaceSection("baseline");
          setBatchNotice({ tone: "success", text: tr("已完成核对并提交基线 v{0}，等待其余组员确认。", { 0: res.version_no }) });
        }
      } else {
        invalidateAll();
        setWorkspaceSection("baseline");
        setBatchNotice({ tone: "info", text: tr("已完成前置检查项准备，请由组长在「基线确认」提交全员确认。") });
      }
    } catch (error) {
      invalidateAll();
      setBatchNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBatchConfirming(false);
    }
  };

  return <div className="space-y-3.5">
    <PageHeader
      title={tr("需求工作区")}
      description={tr("上传资料由 AI 生成需求基线与分工闭环，团队确认后冻结版本。")}
      actions={<div className="flex flex-wrap items-center gap-2">
        {board.data && editableDraft && draftReqCount > 0 && (
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={batchConfirming}
            onClick={() => void handleBatchConfirmAll()}
          >
            <CheckCheck size={14} />
            {batchConfirming ? tr("正在一键确认…") : tr("一键确认全部需求 ({0})", { 0: draftReqCount })}
          </button>
        )}
        <Link href={`/projects/${projectId}/setup#project-materials`} className={compactSecondary}>{tr("添加资料")}</Link>
        <Link href={`/projects/${projectId}`} className={compactSecondary}>{tr("项目总览")}</Link>
      </div>}
    />

    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <div className="gp-segmented" role="group" aria-label={tr("需求工作区视图")}>
        <button type="button" aria-pressed={workspaceSection === "work"} className="gp-segmented-item" onClick={() => setWorkspaceSection("work")}>{tr("整理需求")}</button>
        {!board.isPending && (board.data?.open_conflicts ?? 0) > 0 && (
          <button type="button" aria-pressed={workspaceSection === "conflicts"} className="gp-segmented-item" onClick={() => setWorkspaceSection("conflicts")}>
            {tr("冲突处理")}
            <StatusBadge tone="amber" label={String(board.data?.open_conflicts ?? 0)} />
          </button>
        )}
        <button type="button" aria-pressed={workspaceSection === "baseline"} className="gp-segmented-item" onClick={() => setWorkspaceSection("baseline")}>{tr("基线确认")}</button>
      </div>
      <div className="flex items-center gap-3">
        {board.data?.setup_status === "pending_confirmation" && workspaceSection !== "baseline" && (
          <button type="button" className="text-xs font-semibold text-amber-700 hover:underline" onClick={() => setWorkspaceSection("baseline")}>
            {tr("基线待确认 →")}
          </button>
        )}
        <Link href={`/projects/${projectId}/tasks?view=plan`} className="gp-link text-xs font-medium">{tr("前往任务规划 →")}</Link>
      </div>
    </div>

    {batchNotice && <Feedback tone={batchNotice.tone}>{batchNotice.text}</Feedback>}
    {board.isError && <div role="alert"><Feedback tone="error">{errorText(board.error)}</Feedback></div>}
    {workspaceSection === "conflicts" && (board.data?.open_conflicts ?? 0) === 0 ? <Feedback tone="info">{tr("当前没有待处理冲突。")}</Feedback> : null}
    {workspaceSection === "conflicts" && (board.data?.open_conflicts ?? 0) > 0 && <ConflictsStep projectId={projectId} />}
    {workspaceSection === "baseline" && <BaselineStep projectId={projectId} />}

    {workspaceSection === "work" && <div className="space-y-3.5">
      {(board.isSuccess || list.isSuccess) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-slate-200/85 bg-white px-4 py-2.5 shadow-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="text-slate-500">{tr("功能模块")}</span>
              <span className="text-sm font-bold tabular-nums text-slate-900">{moduleCount}</span>
            </div>
            <span className="h-3.5 w-px bg-slate-200" aria-hidden />
            <div className="flex items-baseline gap-1.5">
              <span className="text-slate-500">{tr("需求条目")}</span>
              <span className="text-sm font-bold tabular-nums text-slate-900">{reqTotal}</span>
            </div>
            <span className="h-3.5 w-px bg-slate-200" aria-hidden />
            <div className="flex items-center gap-1.5">
              <StatusBadge tone={editableDraft ? "amber" : "green"} label={editableDraft ? tr("草稿编辑中") : tr("基线已冻结")} />
              {aiCount > 0 && <StatusBadge tone="blue" label={tr("AI 解析 {0} 条", { 0: aiCount })} />}
            </div>
          </div>
          {board.data && !editableDraft && (
            <div className="flex flex-wrap items-center gap-2.5 text-xs">
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <Bot size={13} className="shrink-0 text-sky-600" />
                <RunStatus board={board.data} compact />
              </span>
              <Link href={`/projects/${projectId}/tasks?view=plan`} className="gp-link whitespace-nowrap font-medium">{tr("查看任务与分工 →")}</Link>
            </div>
          )}
        </div>
      )}

      {(!board.data || editableDraft) && <RequirementsStep projectId={projectId} />}

      {showManageList && (
        <div className="grid gap-3.5 lg:h-[calc(100vh-230px)] lg:min-h-[480px] lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,1fr)]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
            <div className="shrink-0 border-b border-slate-100 px-3.5 py-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold tracking-tight text-slate-900">{tr("需求清单")}</h2>
                  {list.data && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-slate-600">{list.data.total}</span>}
                </div>
                <p className="text-[11px] text-slate-400">{tr("筛选、编辑并追踪需求的版本变更与证据链。")}</p>
              </div>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setFilters({ code: draft.code.trim() || null, q: draft.q.trim() || null, page: null });
                }}
              >
                <label className="sr-only" htmlFor="req-f-code">{tr("编号")}</label>
                <input id="req-f-code" className={`${compactInput} w-22`} placeholder="R-001" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                <label className="sr-only" htmlFor="req-f-q">{tr("名称或说明")}</label>
                <input id="req-f-q" className={`${compactInput} min-w-[130px] flex-1`} placeholder={tr("关键字检索")} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
                <label className="sr-only" htmlFor="req-f-source">{tr("来源")}</label>
                <select id="req-f-source" className={`${compactInput} w-24`} value={filters.source} onChange={(e) => setFilters({ source: e.target.value || null, page: null })}>
                  <option value="">{tr("全部来源")}</option>
                  <option value="ai">{tr("AI 分析")}</option>
                  <option value="manual">{tr("手工录入")}</option>
                </select>
                <label className="sr-only" htmlFor="req-f-module">{tr("模块")}</label>
                <select id="req-f-module" className={`${compactInput} w-28`} value={filters.module} onChange={(e) => setFilters({ module: e.target.value || null, page: null })}>
                  <option value="">{tr("全部模块")}</option>
                  {list.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <label className="sr-only" htmlFor="req-f-status">{tr("状态")}</label>
                <select id="req-f-status" className={`${compactInput} w-24`} value={filters.status} onChange={(e) => setFilters({ status: e.target.value || null, page: null })}>
                  <option value="">{tr("全部状态")}</option>
                  {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}
                </select>
                <button type="submit" className={compactBtn}><Search size={13} />{tr("查询")}</button>
                <button type="button" className={compactSecondary} onClick={clearFilters}>{tr("清空")}</button>
              </form>
            </div>

            {list.isPending ? (
              <div role="status" className="gp-empty flex-1">{tr("正在加载需求…")}</div>
            ) : list.isError ? (
              <div role="alert" className="p-3.5"><Feedback tone="error">{errorText(list.error)}</Feedback></div>
            ) : list.data.items.length === 0 ? (
              <div className="flex flex-1 items-center justify-center p-4"><EmptyState title={tr("没有符合条件的需求")} /></div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[11px] font-semibold text-slate-500 backdrop-blur-xs">
                      <tr>
                        <th className="whitespace-nowrap px-3.5 py-2">{tr("编号")}</th>
                        <th className="px-3 py-2">{tr("需求")}</th>
                        <th className="whitespace-nowrap px-3 py-2">{tr("模块")}</th>
                        <th className="whitespace-nowrap px-3 py-2">{tr("来源")}</th>
                        <th className="whitespace-nowrap px-3 py-2">{tr("状态")}</th>
                        <th className="whitespace-nowrap px-3 py-2 text-right">{tr("版本")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {list.data.items.map((item) => {
                        const active = filters.req === item.id;
                        return (
                          <tr
                            key={item.id}
                            aria-selected={active}
                            className={`cursor-pointer transition-colors ${active ? "bg-sky-50/85" : "hover:bg-slate-50/80"}`}
                            onClick={() => setFilters({ req: item.id, tab: null })}
                          >
                            <td className="whitespace-nowrap px-3.5 py-2 font-mono text-xs text-slate-500">{item.code ?? "—"}</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                className={`text-left text-xs font-medium hover:underline ${active ? "text-sky-800" : "text-slate-900"}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFilters({ req: item.id, tab: null });
                                }}
                              >
                                {item.title}
                              </button>
                            </td>
                            <td className="max-w-[130px] truncate whitespace-nowrap px-3 py-2 text-slate-600" title={item.module.name}>{item.module.name}</td>
                            <td className="whitespace-nowrap px-3 py-2">
                              <StatusBadge tone={item.origin === "ai" ? "blue" : "gray"} label={item.origin === "ai" ? tr("AI 解析") : tr("手工")} />
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              <StatusBadge tone={item.status === "draft" ? "gray" : item.status === "verified" || item.status === "confirmed" ? "green" : "blue"} label={tr(statusLabel[item.status]) ?? item.status} />
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-500">v{item.version_no}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-white px-3.5 py-2 text-xs text-slate-500">
                  <span>{tr("共 {0} 条 · 第 {1} / {2} 页", { 0: list.data.total, 1: filters.page, 2: pages })}</span>
                  <span className="flex gap-1.5">
                    <button type="button" className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-45" disabled={filters.page <= 1} onClick={() => setFilters({ page: filters.page - 1 })}>{tr("上一页")}</button>
                    <button type="button" className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-45" disabled={filters.page >= pages} onClick={() => setFilters({ page: filters.page + 1 })}>{tr("下一页")}</button>
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs">
            {filters.req ? (
              <RequirementPanel key={filters.req} projectId={projectId} requirementId={filters.req} tab={filters.tab} onTab={(tab) => setFilters({ tab })} />
            ) : (
              <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState title={tr("选择一条需求")} description={tr("查看详情、修改记录和它关联的任务与证据。")} />
              </div>
            )}
          </section>
        </div>
      )}
    </div>}
  </div>;
}

function RequirementPanel({ projectId, requirementId, tab, onTab }: { projectId: string; requirementId: string; tab: string; onTab: (tab: "detail" | "versions" | "trace") => void }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const detail = useQuery({ queryKey: ["b-req-detail", userId, projectId, requirementId], queryFn: () => bManageApi.detail(projectId, requirementId), ...queryPolicy });
  if (detail.isPending) return <div role="status" className="gp-empty flex-1">{tr("正在加载…")}</div>;
  if (detail.isError) return <div role="alert" className="p-4"><Feedback tone="error">{errorText(detail.error)}</Feedback></div>;
  const data = detail.data;
  const tabs = [["detail", tr("详情"), PenLine], ["versions", tr("修改记录"), History], ["trace", tr("证据链"), Network]] as const;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b border-slate-100 px-4 pt-3 pb-0">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug text-slate-900">
          {data.requirement.code && <span className="mr-1.5 font-mono text-xs text-slate-500">{data.requirement.code}</span>}
          {data.requirement.title}
        </h3>
        <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-600">v{data.version_no}</span>
      </div>
      <div role="tablist" className="flex gap-1">
        {tabs.map(([key, text, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`flex items-center gap-1 border-b-2 px-2.5 py-2 text-xs transition-colors ${tab === key ? "border-sky-600 font-semibold text-sky-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
            onClick={() => onTab(key)}
          >
            <Icon size={13} />
            {text}
          </button>
        ))}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {tab === "detail" && <DetailTab projectId={projectId} data={data} />}
      {tab === "versions" && <VersionsTab projectId={projectId} requirementId={requirementId} />}
      {tab === "trace" && <TraceTab projectId={projectId} requirementId={requirementId} />}
    </div>
  </div>;
}

function DetailTab({ projectId, data }: { projectId: string; data: BRequirementDetail }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const row = data.requirement;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: row.title, description: row.description ?? "", priority: row.priority as BPriority, reason: "" });
  const [notice, setNotice] = useState<Notice>();
  const impact = useQuery({ queryKey: ["b-req-impact", userId, projectId, row.id], queryFn: () => bManageApi.impact(projectId, row.id), enabled: editing, ...queryPolicy });
  const save = useMutation({
    mutationFn: () => bManageApi.update(projectId, row, { module_id: row.module_id, title: form.title.trim(), description: form.description.trim() || undefined, priority: form.priority, reason: form.reason.trim() || undefined }),
    onSuccess: () => {
      setEditing(false);
      setNotice({ tone: "success", text: impact.data?.criteria_count ? tr("已保存为新版本，{0} 条验收标准已标记“需要重新检查”", { 0: impact.data.criteria_count }) : tr("已保存为新版本") });
      for (const key of ["b-req-list", "b-req-detail", "b-req-versions", "b-req-trace", "b-req-impact"]) void cache.invalidateQueries({ queryKey: [key, userId, projectId] });
    },
    onError: (error) => {
      setNotice({ tone: "error", text: errorText(error) });
      if (error instanceof BApiError && error.code === "VERSION_CONFLICT") void cache.invalidateQueries({ queryKey: ["b-req-detail", userId, projectId, row.id] });
    },
  });

  if (!editing) {
    return <div className="space-y-3 text-xs">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
        <div><dt className="text-[11px] text-slate-400">{tr("模块")}</dt><dd className="mt-0.5 font-medium text-slate-800">{data.module.name}</dd></div>
        <div><dt className="text-[11px] text-slate-400">{tr("优先级")}</dt><dd className="mt-0.5 font-medium text-slate-800">{tr(priorityLabel[row.priority])}</dd></div>
        <div><dt className="text-[11px] text-slate-400">{tr("状态")}</dt><dd className="mt-0.5 font-medium text-slate-800">{tr(statusLabel[row.status]) ?? row.status}</dd></div>
        <div><dt className="text-[11px] text-slate-400">{tr("版本")}</dt><dd className="mt-0.5 font-mono font-medium text-slate-800">v{data.version_no}</dd></div>
      </dl>
      <div>
        <div className="mb-1 text-[11px] font-semibold text-slate-500">{tr("说明")}</div>
        <p className="whitespace-pre-wrap rounded-xl border border-slate-100 bg-white p-3 leading-relaxed text-slate-700">{row.description || "—"}</p>
      </div>
      {row.sources.length > 0 && (
        <ul className="space-y-1">
          {row.sources.map((s, i) => (
            <li key={i} className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
              {tr("出处：{0} —— “{1}”", { 0: s.material_title ?? tr("资料"), 1: s.quote })}
            </li>
          ))}
        </ul>
      )}
      {data.can_edit && !row.excluded && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <button type="button" className={compactSecondary} onClick={() => setEditing(true)}>
            <PenLine size={13} />
            {data.reason_required ? tr("提出修改") : tr("编辑")}
          </button>
          {data.baseline_frozen && <span className="text-[11px] text-slate-400">{tr("需求基线已冻结，修改需要写明原因，并会生成新版本。")}</span>}
        </div>
      )}
    </div>;
  }

  return <form className="space-y-2.5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <div><label className={label} htmlFor="req-edit-title">{tr("需求标题")}</label><input id="req-edit-title" className={input} maxLength={240} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
    <div><label className={label} htmlFor="req-edit-desc">{tr("说明")}</label><textarea id="req-edit-desc" className={input} rows={3} maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
    <div><label className={label} htmlFor="req-edit-priority">{tr("优先级")}</label><select id="req-edit-priority" className={input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as BPriority })}>{(["high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{tr(priorityLabel[v])}</option>)}</select></div>
    {data.reason_required && <div><label className={label} htmlFor="req-edit-reason">{tr("修改原因（必填）")}</label><textarea id="req-edit-reason" className={input} rows={2} maxLength={2000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>}
    <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-900" data-testid="b-impact">
      <p className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle size={13} />{tr("保存后会影响")}</p>
      {impact.isPending ? tr("正在查找关联的任务…") : impact.isError ? errorText(impact.error) : impact.data.tasks.length === 0 ? tr("没有关联的任务。") : <ul className="list-disc pl-4">{impact.data.tasks.map((t) => <li key={t.id}>{tr("{0}（{1} 条验收标准将标记“需要重新检查”）", { 0: t.title, 1: t.criteria.length })}</li>)}</ul>}
    </div>
    <div className="flex justify-end gap-2">
      <button type="button" className={secondary} onClick={() => setEditing(false)}>{tr("取消")}</button>
      <button type="submit" className={button} disabled={save.isPending || !form.title.trim() || (data.reason_required && !form.reason.trim())}>{tr("保存为新版本")}</button>
    </div>
  </form>;
}

function VersionsTab({ projectId, requirementId }: { projectId: string; requirementId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [picked, setPicked] = useState<number[]>([]);
  const compare = picked.length === 2 ? { from: Math.min(...picked), to: Math.max(...picked) } : undefined;
  const versions = useQuery({ queryKey: ["b-req-versions", userId, projectId, requirementId, compare?.from, compare?.to], queryFn: () => bManageApi.versions(projectId, requirementId, compare), ...queryPolicy });
  if (versions.isPending && !versions.data) return <div role="status" className="gp-empty">{tr("正在加载版本…")}</div>;
  if (versions.isError) return <div role="alert"><Feedback tone="error">{errorText(versions.error)}</Feedback></div>;
  const data = versions.data!;
  const toggle = (no: number) => setPicked((current) => current.includes(no) ? current.filter((v) => v !== no) : [...current.slice(-1), no]);
  return <div className="space-y-3 text-xs">
    <p className="text-slate-500">{tr("勾选两个版本查看差异。")}</p>
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
      {[...data.versions].reverse().map((v) => (
        <li key={v.version_no} className="flex items-start gap-2 px-3 py-2">
          <input id={`ver-${v.version_no}`} type="checkbox" className="mt-0.5" checked={picked.includes(v.version_no)} onChange={() => toggle(v.version_no)} />
          <label htmlFor={`ver-${v.version_no}`} className="min-w-0 flex-1 cursor-pointer">
            <span className="font-mono font-semibold text-slate-800">v{v.version_no}</span> · <span className="font-medium text-slate-900">{v.snapshot.title}</span>{" "}
            <span className="text-slate-400">{v.created_by?.name ?? ""} {dateOnly(v.created_at, tr("未设置"))}</span>
            {v.reason && <span className="mt-0.5 block text-slate-500">{tr("原因：{0}", { 0: v.reason })}</span>}
          </label>
        </li>
      ))}
    </ul>
    {data.compare && <div className="overflow-hidden rounded-xl border border-slate-200" data-testid="b-version-diff">
      <p className="flex items-center gap-1 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700"><GitCompare size={13} />v{data.compare.from} → v{data.compare.to}</p>
      {data.compare.changes.length === 0 ? <p className="px-3 py-2 text-xs text-slate-500">{tr("两个版本内容相同。")}</p>
        : <table className="w-full text-xs"><tbody>{data.compare.changes.map((c) => <tr key={c.field} className="border-b border-slate-50 align-top"><th className="w-16 px-2.5 py-2 text-left font-normal text-slate-500">{c.label}</th><td className="px-2.5 py-2"><del className="rounded bg-red-50 px-1 text-red-700">{display(c.field, c.before)}</del></td><td className="px-2.5 py-2"><ins className="rounded bg-green-50 px-1 text-green-800 no-underline">{display(c.field, c.after)}</ins></td></tr>)}</tbody></table>}
    </div>}
  </div>;
}

function display(field: string, value: string | null) {
  if (value === null || value === "") return "（空）";
  if (field === "priority") return priorityLabel[value] ?? value;
  if (field === "status") return statusLabel[value] ?? value;
  return value;
}

function Unavailable({ text }: { text: string }) { return <span className="text-xs text-slate-400">{text}</span>; }

function TraceTab({ projectId, requirementId }: { projectId: string; requirementId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const trace = useQuery({ queryKey: ["b-req-trace", userId, projectId, requirementId], queryFn: () => bManageApi.trace(projectId, requirementId), ...queryPolicy });
  if (trace.isPending) return <div role="status" className="gp-empty">{tr("正在加载证据链…")}</div>;
  if (trace.isError) return <div role="alert"><Feedback tone="error">{errorText(trace.error)}</Feedback></div>;
  const data = trace.data;
  return <div className="space-y-2.5 text-xs" data-testid="b-trace">
    <p className="rounded-lg bg-slate-50 px-3 py-1.5 text-slate-700">{tr("模块：")}<Link className="gp-link font-medium" href={data.module_href}>{data.module.name}</Link></p>
    {data.tasks.length === 0 ? <p className="text-slate-500">{tr("还没有任务关联这条需求。")}</p> : <ul className="space-y-2.5">{data.tasks.map((task) => <li key={task.id} className="rounded-xl border border-slate-200/85 p-3">
      <p className="font-medium text-slate-900">{tr("任务：")}<Link className="gp-link" href={task.href}>{task.title}</Link></p>
      <ul className="mt-2 space-y-1.5 pl-2.5">{task.criteria.map((c) => <li key={c.id} className="border-l-2 border-slate-200 pl-2.5">
        <p className="text-slate-700">{tr("验收标准 {0}：{1} ", { 0: c.key, 1: c.text })}{c.needs_recheck && <StatusBadge tone="amber" label={tr("需要重新检查")} />}</p>
        <p className="mt-1 text-[11px] text-slate-500">{tr("证据：")}{data.evidence_status === "unavailable" ? <Unavailable text={tr("暂不可用{0}", { 0: data.evidence_reason ? `（${data.evidence_reason}）` : "" })} /> : c.evidence.length === 0 ? <Unavailable text={tr("还没有证据")} /> : c.evidence.map((e) => <Link key={e.id} className="gp-link mr-2" href={e.href}>{e.title}</Link>)}</p>
      </li>)}</ul>
      <p className="mt-2 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">{tr("验收结果：")}{task.verification.status === "unavailable" ? <Unavailable text={tr("暂不可用（验收服务未接入）")} /> : <Link className="gp-link" href={task.verification.href}>{task.verification.state ?? tr("查看")}</Link>}</p>
    </li>)}</ul>}
  </div>;
}
