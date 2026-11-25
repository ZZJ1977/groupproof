"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, Lock, PenLine, Snowflake, Sparkles } from "lucide-react";
import { Avatar, EmptyState, Feedback, StatusBadge } from "@/shared/components/common";
import { BApiError } from "@/student/api/b-client";
import { bProjectsApi } from "@/student/api/b-projects";
import { bRequirementsApi, type BConflict, type BPriority, type BRequirement, type BRequirementsBoard } from "@/student/api/b-requirements";
import { useWorkspace } from "@/shared/lib/workspace";
import { useBErrorMessage } from "@/student/projects/use-b-error";
import { button, input, label, queryPolicy, secondary } from "@/shared/lib/b-ui";
import { useUiText } from "@/shared/i18n/use-ui-text";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;
const priorityLabel: Record<BPriority, string> = { high: "高", medium: "中", low: "低" };
const cardClass = "rounded-2xl border border-slate-200/85 bg-white shadow-xs";
const compactBtn = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--gp-action)] px-3 text-xs font-semibold text-white shadow-xs transition hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const compactSecondary = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

function useBoard(projectId: string) {
  const { userId } = useWorkspace();
  const cache = useQueryClient();
  const key = ["b-requirements", userId, projectId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => bRequirementsApi.board(projectId),
    ...queryPolicy,
    // Poll only while an analysis is running.
    refetchInterval: (state) => (state.state.data?.latest_run?.status === "processing" ? 2000 : false),
  });
  const refresh = () => {
    for (const name of ["b-requirements", "b-req-list", "b-checklist", "b-baseline", "b-project-setup", "b-project-overview", "b-plan", "b-tasks", "b-milestones", "b-suggestions"]) {
      void cache.invalidateQueries({ queryKey: [name, userId, projectId] });
    }
  };
  return { query, refresh };
}

export function RunStatus({ board, compact = false }: { board: BRequirementsBoard; compact?: boolean }) {
  const tr = useUiText();
  const run = board.latest_run;
  if (!run) {
    return <span className="text-xs text-slate-500">{tr("还没有分析过。分析会读取已就绪的资料正文，生成需求草案供大家修改。")}</span>;
  }
  if (run.status === "processing") {
    return compact
      ? <span role="status" className="text-xs font-medium text-sky-700">{tr("正在分析资料，处理中…")}</span>
      : <div role="status"><Feedback tone="info">{tr("正在分析资料，处理中…")}</Feedback></div>;
  }
  if (run.status === "unavailable") {
    return compact
      ? <span className="text-xs font-medium text-amber-700">{tr("AI 暂不可用，请在下面手动录入模块和需求，流程可以照常走完。")}</span>
      : <Feedback tone="warning">{tr("AI 暂不可用，请在下面手动录入模块和需求，流程可以照常走完。")}</Feedback>;
  }
  if (run.status === "failed") {
    const msg = run.error_message ?? tr("分析失败，请重试或手动录入需求。");
    return compact ? <span className="text-xs font-medium text-rose-700">{msg}</span> : <Feedback tone="error">{msg}</Feedback>;
  }
  const s = (run.summary ?? {}) as Record<string, number | undefined>;
  const placeholder = run.is_placeholder ? tr("（当前是示例结果，接入真实 AI 后会替换）") : "";
  const text = (s.tasks_added ?? 0) > 0 || (s.milestones_added ?? 0) > 0
    ? tr("AI 全流程分析完成：已解析项目资料，生成 {0} 个模块、{1} 条需求、{2} 个里程碑与 {3} 项任务草案。{4}", { 0: s.modules_added ?? 0, 1: s.requirements_added ?? 0, 2: s.milestones_added ?? 0, 3: s.tasks_added ?? 0, 4: placeholder })
    : tr("分析完成：新增 {0} 条需求、{1} 个冲突；保留人工新增或修改的 {2} 条。{3}", { 0: s.requirements_added ?? 0, 1: s.conflicts_added ?? 0, 2: s.requirements_kept ?? 0, 3: placeholder });
  return compact ? <span className="text-xs text-emerald-700">{text}</span> : <Feedback tone="success">{text}</Feedback>;
}

function RequirementRow({ projectId, row, board, onSaved }: { projectId: string; row: BRequirement; board: BRequirementsBoard; onSaved: () => void }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({ title: row.title, description: row.description ?? "", priority: row.priority, module_id: row.module_id });
  const [notice, setNotice] = useState<Notice>();
  const save = useMutation({
    mutationFn: () => bRequirementsApi.updateRequirement(projectId, row, { ...form, title: form.title.trim(), description: form.description.trim() || undefined }),
    onSuccess: () => { setEditing(false); setNotice(undefined); onSaved(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); if (error instanceof BApiError && error.code === "VERSION_CONFLICT") onSaved(); },
  });

  if (editing) {
    return <li className="space-y-2 bg-slate-50/70 px-4 py-3">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      <div><label className={label} htmlFor={`req-title-${row.id}`}>{tr("需求标题")}</label><input id={`req-title-${row.id}`} className={input} maxLength={240} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div><label className={label} htmlFor={`req-desc-${row.id}`}>{tr("说明")}</label><textarea id={`req-desc-${row.id}`} className={input} rows={2} maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div><label className={label} htmlFor={`req-module-${row.id}`}>{tr("模块")}</label><select id={`req-module-${row.id}`} className={input} value={form.module_id} onChange={(e) => setForm({ ...form, module_id: e.target.value })}>{board.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
        <div><label className={label} htmlFor={`req-priority-${row.id}`}>{tr("优先级")}</label><select id={`req-priority-${row.id}`} className={input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as BPriority })}>{(["high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{tr(priorityLabel[v])}</option>)}</select></div>
      </div>
      <div className="flex justify-end gap-2"><button type="button" className={compactSecondary} onClick={() => setEditing(false)}>{tr("取消")}</button><button type="button" className={compactBtn} disabled={save.isPending || !form.title.trim()} onClick={() => save.mutate()}>{tr("保存")}</button></div>
    </li>;
  }

  const longDesc = Boolean(row.description && row.description.length > 140);
  return <li className={`px-4 py-2 text-xs transition-colors hover:bg-slate-50/60 ${row.excluded ? "opacity-50" : ""}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <span className={`text-sm font-medium text-slate-900 ${row.excluded ? "line-through" : ""}`}>{row.title}</span>
      </div>
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusBadge tone={row.priority === "high" ? "amber" : "gray"} label={tr("优先级 {0}", { 0: tr(priorityLabel[row.priority]) })} />
        {row.origin === "ai" ? <StatusBadge tone="blue" label={row.edited_by_human ? tr("AI · 已人工修改") : tr("AI 草案")} /> : <StatusBadge tone="green" label={tr("手工录入")} />}
        {row.excluded && <StatusBadge tone="amber" label={tr("冲突处理后未采用")} />}
        {board.editable && !row.excluded && (
          <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 hover:bg-slate-50" aria-label={tr("编辑需求 {0}", { 0: row.title })} onClick={() => setEditing(true)}>
            <PenLine size={12} />{tr("编辑")}
          </button>
        )}
      </span>
    </div>
    {row.description && (
      <div className="mt-1 text-xs text-slate-600">
        <p className={`whitespace-pre-wrap ${!expanded && longDesc ? "line-clamp-2" : ""}`}>{row.description}</p>
        {longDesc && (
          <button type="button" className="mt-0.5 text-[11px] font-medium text-sky-700 hover:underline" onClick={() => setExpanded((v) => !v)}>
            {expanded ? tr("收起") : tr("展开说明")}
          </button>
        )}
      </div>
    )}
    {row.sources.length > 0 && (
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {row.sources.map((s, i) => (
          <li key={i} className="rounded-md bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">
            {tr("出处：{0} · 第 {1} 段 —— “{2}”", { 0: s.material_title ?? tr("资料"), 1: s.segment_id?.replace(/^p/, "") ?? "?", 2: s.quote })}
          </li>
        ))}
      </ul>
    )}
  </li>;
}

/** Requirements workspace: AI analysis is optional and manual entry is always available. */
export function RequirementsStep({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { query, refresh } = useBoard(projectId);
  const [notice, setNotice] = useState<Notice>();
  const [moduleName, setModuleName] = useState("");
  const [draft, setDraft] = useState({ module_id: "", title: "", description: "", priority: "medium" as BPriority });
  const [collapsedModules, setCollapsedModules] = useState<Record<string, boolean>>({});
  const analyse = useMutation({ mutationFn: () => bRequirementsApi.analyse(projectId), onSuccess: () => { setNotice(undefined); refresh(); }, onError: (error) => setNotice({ tone: "error", text: errorText(error) }) });
  const blueprint = useMutation({
    mutationFn: () => bRequirementsApi.generateBlueprint(projectId),
    onSuccess: (res) => {
      setNotice({ tone: "success", text: tr("AI 已解析项目资料：生成 {0} 个模块、{1} 条需求、{2} 个里程碑与 {3} 项任务草案，请核对后在“基线确认”和“任务 → 分工与规划”冻结。", { 0: res.modules_added, 1: res.requirements_added, 2: res.milestones_added, 3: res.tasks_added }) });
      refresh();
    },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const addModule = useMutation({ mutationFn: () => bRequirementsApi.createModule(projectId, { name: moduleName.trim() }), onSuccess: (row) => { setModuleName(""); setDraft((d) => ({ ...d, module_id: d.module_id || row.id })); refresh(); }, onError: (error) => setNotice({ tone: "error", text: errorText(error) }) });
  const addRequirement = useMutation({
    mutationFn: () => bRequirementsApi.createRequirement(projectId, { module_id: draft.module_id || query.data!.modules[0].id, title: draft.title.trim(), description: draft.description.trim() || undefined, priority: draft.priority }),
    onSuccess: () => { setDraft((d) => ({ ...d, title: "", description: "" })); setNotice({ tone: "success", text: tr("已添加需求") }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });

  if (query.isPending) return <div role="status" className="gp-empty">{tr("正在加载需求…")}</div>;
  if (query.isError) return <div role="alert"><Feedback tone="error">{errorText(query.error)}</Feedback></div>;
  const board = query.data;
  const running = board.latest_run?.status === "processing";

  return <div className="space-y-3.5">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}

    <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="gp-eyebrow">AI 辅助分析</span>
          <h2 className="text-sm font-semibold text-slate-900">{tr("需求分析")}</h2>
        </div>
        <RunStatus board={board} />
      </div>
      {board.editable && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={compactBtn} disabled={running || analyse.isPending || blueprint.isPending} onClick={() => blueprint.mutate()}>
            <Sparkles size={13} />
            {blueprint.isPending ? tr("AI 正在生成全流程规划…") : tr("AI 一键生成需求·任务·里程碑")}
          </button>
          <button type="button" className={compactSecondary} disabled={running || analyse.isPending || blueprint.isPending} onClick={() => analyse.mutate()}>
            <Bot size={13} />
            {board.latest_run ? tr("重新分析") : tr("开始分析")}
          </button>
        </div>
      )}
    </div>

    {board.modules.length === 0 ? (
      <div className={`${cardClass} p-4`}>
        <EmptyState title={tr("还没有模块和需求")} description={board.editable ? tr("可以先分析资料，也可以直接手动添加。") : undefined} />
      </div>
    ) : (
      <div className="space-y-2.5">
        {board.modules.map((module) => {
          const isCollapsed = Boolean(collapsedModules[module.id]);
          const moduleReqs = board.requirements.filter((r) => r.module_id === module.id);
          return (
            <div key={module.id} className={`${cardClass} overflow-hidden`}>
              <button
                type="button"
                className="flex w-full items-center justify-between border-b border-slate-100 bg-slate-50/70 px-4 py-2 text-left transition hover:bg-slate-100/70"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsedModules((prev) => ({ ...prev, [module.id]: !prev[module.id] }))}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  {isCollapsed ? <ChevronRight size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                  {tr("{0}（{1} 条）", { 0: module.name, 1: module.requirement_count })}
                </span>
                {module.owner?.name && <span className="text-[11px] text-slate-500">{tr("负责人")}：{module.owner.name}</span>}
              </button>
              {!isCollapsed && (
                <>
                  <ul className="divide-y divide-slate-100">
                    {moduleReqs.map((row) => <RequirementRow key={`${row.id}:${row.lock_version}`} projectId={projectId} row={row} board={board} onSaved={refresh} />)}
                  </ul>
                  {module.requirement_count === 0 && <p className="px-4 py-2 text-xs text-slate-500">{tr("这个模块还没有需求。")}</p>}
                </>
              )}
            </div>
          );
        })}
      </div>
    )}

    {board.editable && (
      <div className={`${cardClass} space-y-3 p-3.5`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">{tr("手动添加")}</h3>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); addModule.mutate(); }}>
          <div className="min-w-[200px] max-w-sm flex-1">
            <label className={label} htmlFor="b-new-module">{tr("新模块名称")}</label>
            <input id="b-new-module" className={input} maxLength={200} placeholder={tr("例如：用户认证、任务看板")} value={moduleName} onChange={(e) => setModuleName(e.target.value)} />
          </div>
          <button type="submit" className={secondary} disabled={addModule.isPending || !moduleName.trim()}>{tr("添加模块")}</button>
        </form>
        {board.modules.length > 0 && (
          <form className="space-y-2.5 border-t border-slate-100 pt-3" onSubmit={(e) => { e.preventDefault(); addRequirement.mutate(); }}>
            <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_170px_110px]">
              <div><label className={label} htmlFor="b-new-req-title">{tr("需求标题")}</label><input id="b-new-req-title" className={input} maxLength={240} placeholder={tr("输入简明的功能需求标题")} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
              <div><label className={label} htmlFor="b-new-req-module">{tr("所属模块")}</label><select id="b-new-req-module" className={input} value={draft.module_id || board.modules[0].id} onChange={(e) => setDraft({ ...draft, module_id: e.target.value })}>{board.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
              <div><label className={label} htmlFor="b-new-req-priority">{tr("优先级")}</label><select id="b-new-req-priority" className={input} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as BPriority })}>{(["high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{tr(priorityLabel[v])}</option>)}</select></div>
            </div>
            <div className="flex flex-wrap items-end gap-2.5">
              <div className="min-w-[220px] flex-1">
                <label className={label} htmlFor="b-new-req-desc">{tr("说明（可选）")}</label>
                <textarea id="b-new-req-desc" className={input} rows={1} maxLength={5000} placeholder={tr("补充场景、输入输出或边界约束")} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </div>
              <button type="submit" className={button} disabled={addRequirement.isPending || !draft.title.trim()}>{tr("添加需求")}</button>
            </div>
          </form>
        )}
      </div>
    )}
  </div>;
}

function ConflictCard({ projectId, conflict, editable, onSaved }: { projectId: string; conflict: BConflict; editable: boolean; onSaved: () => void }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const [decision, setDecision] = useState<"keep_left" | "keep_right" | "merge">("keep_left");
  const [reason, setReason] = useState("");
  const [mergedTitle, setMergedTitle] = useState(conflict.left.title);
  const [notice, setNotice] = useState<Notice>();
  const resolve = useMutation({
    mutationFn: () => bRequirementsApi.resolve(projectId, conflict.id, { decision, reason: reason.trim(), merged_title: decision === "merge" ? mergedTitle.trim() : undefined }),
    onSuccess: () => onSaved(),
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const side = (title: string, row: BRequirement) => (
    <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3 text-xs">
      <p className="font-semibold text-slate-500">{title}</p>
      <p className="mt-1 text-sm font-medium text-slate-900">{row.title}</p>
      {row.description && <p className="mt-1 text-slate-600">{row.description}</p>}
    </div>
  );
  return <section className={`${cardClass} p-4`}>
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-slate-900">{conflict.status === "open" ? tr("待处理的冲突") : tr("已处理的冲突")}</h3>
      <StatusBadge tone={conflict.status === "open" ? "amber" : "green"} label={conflict.status === "open" ? tr("待处理") : tr("已处理")} />
    </div>
    {conflict.description && <p className="mb-2.5 text-xs text-slate-600">{conflict.description}</p>}
    <div className="grid gap-2.5 md:grid-cols-2">{side(tr("需求 A"), conflict.left)}{side(tr("需求 B"), conflict.right)}</div>
    {conflict.resolution ? (
      <p className="mt-3 text-xs text-slate-600">
        <CheckCircle2 size={13} className="mr-1 inline text-emerald-600" />
        {tr("{0} · 理由：{1}（{2}）", { 0: ({ keep_left: tr("保留 A"), keep_right: tr("保留 B"), merge: tr("合并为一条") } as const)[conflict.resolution.decision], 1: conflict.resolution.reason, 2: conflict.resolution.resolved_by?.name ?? tr("组员") })}
      </p>
    ) : editable && (
      <form className="mt-3 space-y-2.5 border-t border-slate-100 pt-3" onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
        {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
        <fieldset className="flex flex-wrap items-center gap-3 text-xs">
          <legend className={label}>{tr("怎么处理")}</legend>
          {([["keep_left", tr("保留 A")], ["keep_right", tr("保留 B")], ["merge", tr("合并为一条")]] as const).map(([value, text]) => (
            <label key={value} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition ${decision === value ? "border-sky-400 bg-sky-50/70 font-medium text-sky-800" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
              <input type="radio" name={`decision-${conflict.id}`} value={value} checked={decision === value} onChange={() => setDecision(value)} />
              {text}
            </label>
          ))}
        </fieldset>
        {decision === "merge" && <div><label className={label} htmlFor={`merged-${conflict.id}`}>{tr("合并后的需求标题")}</label><input id={`merged-${conflict.id}`} className={input} maxLength={240} value={mergedTitle} onChange={(e) => setMergedTitle(e.target.value)} /></div>}
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="min-w-[240px] flex-1">
            <label className={label} htmlFor={`reason-${conflict.id}`}>{tr("理由（必填）")}</label>
            <textarea id={`reason-${conflict.id}`} className={input} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button type="submit" className={button} disabled={resolve.isPending || !reason.trim() || (decision === "merge" && !mergedTitle.trim())}>{tr("确认处理")}</button>
        </div>
      </form>
    )}
  </section>;
}

/** Conflict workspace: rendered only when the requirements workspace has open conflicts. */
export function ConflictsStep({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { query, refresh } = useBoard(projectId);
  if (query.isPending) return <div role="status" className="gp-empty">{tr("正在加载冲突…")}</div>;
  if (query.isError) return <div role="alert"><Feedback tone="error">{errorText(query.error)}</Feedback></div>;
  const board = query.data;
  return <div className="space-y-3">
    {board.conflicts.length === 0 ? <div className={`${cardClass} p-4`}><EmptyState title={tr("没有发现冲突")} description={tr("可以直接进入基线确认。")} /></div>
      : board.conflicts.map((conflict) => <ConflictCard key={conflict.id} projectId={projectId} conflict={conflict} editable={board.editable} onSaved={refresh} />)}
    {board.open_conflicts > 0 && <p className="text-right text-xs text-amber-700">{tr("还有 {0} 个冲突没有处理，处理完才能继续。", { 0: board.open_conflicts })}</p>}
  </div>;
}

/** Step 5 (B3-07/B3-08): scope, module owners, checklist, then everyone confirms. */
export function BaselineStep({ projectId }: { projectId: string }) {
  const tr = useUiText();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const { query: boardQuery, refresh } = useBoard(projectId);
  const overview = useQuery({ queryKey: ["b-project-overview", userId, projectId], queryFn: () => bProjectsApi.overview(projectId), ...queryPolicy });
  const review = useQuery({ queryKey: ["b-checklist", userId, projectId], queryFn: () => bRequirementsApi.checklist(projectId), ...queryPolicy });
  const baseline = useQuery({ queryKey: ["b-baseline", userId, projectId], queryFn: () => bRequirementsApi.current(projectId), ...queryPolicy });
  const [scope, setScope] = useState<{ in_scope: string; out_of_scope: string } | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const [comment, setComment] = useState("");
  const [forceReason, setForceReason] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  const onError = (error: unknown) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); };
  const saveScope = useMutation({ mutationFn: () => bRequirementsApi.saveScope(projectId, scope!, review.data!.scope_version), onSuccess: () => { setScope(null); setNotice({ tone: "success", text: tr("范围已保存") }); refresh(); }, onError });
  const tick = useMutation({ mutationFn: ({ key, checked }: { key: string; checked: boolean }) => bRequirementsApi.check(projectId, key, checked), onSuccess: refresh, onError });
  const setOwner = useMutation({ mutationFn: ({ moduleId, ownerId }: { moduleId: string; ownerId: string }) => bRequirementsApi.updateModule(projectId, boardQuery.data!.modules.find((m) => m.id === moduleId)!, { owner_id: ownerId || null }), onSuccess: refresh, onError });
  const submit = useMutation({ mutationFn: () => bRequirementsApi.submit(projectId), onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "frozen" ? tr("基线已冻结") : tr("已提交，等待组员确认") }); refresh(); }, onError });
  const confirm = useMutation({ mutationFn: ({ decision }: { decision: "confirm" | "reject" }) => bRequirementsApi.confirm(projectId, baseline.data!.id, userId, decision, comment.trim() || undefined), onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "frozen" ? tr("全部确认，基线已冻结") : row.status === "archived" ? tr("已退回，组长可以修改后重新提交") : tr("已确认，等待其他组员") }); refresh(); }, onError });
  const force = useMutation({ mutationFn: () => bRequirementsApi.forceFreeze(projectId, baseline.data!.id, forceReason.trim()), onSuccess: () => { setNotice({ tone: "success", text: tr("已强制冻结，未确认的组员会收到通知") }); refresh(); }, onError });

  if (boardQuery.isPending || overview.isPending || review.isPending || baseline.isPending) return <div role="status" className="gp-empty">{tr("正在加载基线…")}</div>;
  const failed = [boardQuery, overview, review, baseline].find((q) => q.isError);
  if (failed) return <div role="alert"><Feedback tone="error">{errorText(failed.error)}</Feedback></div>;

  const board = boardQuery.data!;
  const project = overview.data!;
  const checklist = review.data!;
  const current = baseline.data;

  if (current?.status === "frozen") {
    const reqCount = current.snapshot.requirements?.length ?? 0;
    const modCount = current.snapshot.modules?.length ?? 0;
    const confirmedCount = current.confirmations.filter((c) => c.status === "confirmed").length;
    return <div className="space-y-3.5">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,1fr)]">
        <section className={`${cardClass} space-y-3.5 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><Snowflake size={16} /></span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">{tr("需求基线 v{0} 已冻结", { 0: current.version_no })}</h2>
                <p className="text-xs text-slate-500">{tr("冻结于 {0}，共 {1} 条需求、{2} 个模块。之后修改需求要走变更流程。", { 0: current.frozen_at?.slice(0, 10), 1: reqCount, 2: modCount })}</p>
              </div>
            </div>
            <StatusBadge tone="green" label={tr("基线已冻结")} />
          </div>

          <div className="grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/70 py-2.5 text-center">
            <div><p className="text-[11px] text-slate-500">{tr("冻结需求")}</p><p className="mt-0.5 text-base font-bold tabular-nums text-slate-900">{reqCount}</p></div>
            <div><p className="text-[11px] text-slate-500">{tr("功能模块")}</p><p className="mt-0.5 text-base font-bold tabular-nums text-slate-900">{modCount}</p></div>
            <div><p className="text-[11px] text-slate-500">{tr("已确认成员")}</p><p className="mt-0.5 text-base font-bold tabular-nums text-emerald-700">{confirmedCount}/{current.confirmations.length}</p></div>
          </div>

          {current.snapshot.scope?.in_scope && (
            <div className="rounded-xl border border-slate-100 bg-white p-3 text-xs">
              <p className="font-semibold text-slate-700">{tr("项目范围")}</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-600">{current.snapshot.scope.in_scope}</p>
              {current.snapshot.scope.out_of_scope && <p className="mt-1 text-slate-400">{tr("不做范围")}：{current.snapshot.scope.out_of_scope}</p>}
            </div>
          )}

          {current.snapshot.modules && current.snapshot.modules.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {current.snapshot.modules.map((mod) => (
                <span key={mod.id} className="rounded-lg border border-slate-200/80 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700">{mod.name}</span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Link className={compactBtn} href={`/projects/${projectId}/tasks?view=plan`}>{tr("前往任务规划 →")}</Link>
            <Link className={compactSecondary} href={`/projects/${projectId}`}>{tr("返回项目总览")}</Link>
          </div>
        </section>

        <section className={`${cardClass} p-4`}>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">{tr("团队确认记录")}</h3>
            <span className="text-xs text-slate-400">{confirmedCount}/{current.confirmations.length}</span>
          </div>
          <ul className="space-y-2">
            {current.confirmations.map((c) => {
              const name = c.user.name ?? tr("组员");
              return (
                <li key={c.user.id} className="flex items-center justify-between gap-2.5 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={name} size={26} />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">{name}</p>
                      {c.confirmed_at && <p className="text-[11px] text-slate-400">{c.confirmed_at.slice(0, 16).replace("T", " ")}</p>}
                    </div>
                  </div>
                  <StatusBadge tone={c.status === "confirmed" ? "green" : "gray"} label={c.status === "confirmed" ? tr("已确认") : tr("未确认")} />
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>;
  }

  if (current?.status === "draft") {
    const mine = current.confirmations.find((c) => c.user.id === userId);
    const confirmedCount = current.confirmations.filter((c) => c.status === "confirmed").length;
    return <div className="space-y-3.5">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
        <section className={`${cardClass} space-y-3.5 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{tr("需求基线 v{0} 等待确认", { 0: current.version_no })}</h2>
              <p className="mt-0.5 text-xs text-slate-500">{tr("还需确认：{0}", { 0: current.waiting_for.map((p) => p.name ?? tr("组员")).join("、") || tr("无") })}</p>
            </div>
            <StatusBadge tone="amber" label={`${confirmedCount}/${current.confirmations.length}`} />
          </div>

          <ul className="grid gap-2 sm:grid-cols-2">
            {current.confirmations.map((c) => {
              const name = c.user.name ?? tr("组员");
              return (
                <li key={c.user.id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={name} size={24} />
                    <span className="truncate font-medium text-slate-800">{name}</span>
                  </div>
                  <StatusBadge tone={c.status === "confirmed" ? "green" : c.status === "rejected" ? "red" : "amber"} label={c.status === "confirmed" ? tr("已确认") : c.status === "rejected" ? tr("已退回") : tr("待确认")} />
                </li>
              );
            })}
          </ul>

          {mine?.status === "pending" && (
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <label className={label} htmlFor="b-baseline-comment">{tr("意见（退回时必填）")}</label>
              <textarea id="b-baseline-comment" className={input} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="flex justify-end gap-2">
                <button type="button" className={secondary} disabled={confirm.isPending || !comment.trim()} onClick={() => confirm.mutate({ decision: "reject" })}>{tr("退回")}</button>
                <button type="button" className={button} disabled={confirm.isPending} onClick={() => confirm.mutate({ decision: "confirm" })}>{tr("确认基线")}</button>
              </div>
            </div>
          )}
        </section>

        <div className="space-y-3.5">
          <section className={`${cardClass} p-4`}>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">{tr("本次基线快照")}</h3>
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-2.5"><p className="text-slate-500">{tr("需求条目")}</p><p className="mt-0.5 text-base font-bold text-slate-900">{current.snapshot.requirements?.length ?? 0}</p></div>
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-2.5"><p className="text-slate-500">{tr("功能模块")}</p><p className="mt-0.5 text-base font-bold text-slate-900">{current.snapshot.modules?.length ?? 0}</p></div>
            </div>
          </section>

          {project.is_leader && current.waiting_for.length > 0 && (
            <section className={`${cardClass} space-y-2.5 p-4`}>
              <h3 className="text-sm font-semibold text-slate-900">{tr("组长强制冻结")}</h3>
              <p className="text-xs text-slate-500">{tr("只在确实等不到确认时使用；未确认的组员会收到通知，原因会记入操作记录。")}</p>
              <div>
                <label className={label} htmlFor="b-force-reason">{tr("原因（必填）")}</label>
                <textarea id="b-force-reason" className={input} rows={2} maxLength={2000} value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
              </div>
              <div className="flex justify-end">
                <button type="button" className={secondary} disabled={force.isPending || !forceReason.trim()} onClick={() => force.mutate()}>
                  <Lock size={14} />{tr("强制冻结")}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>;
  }

  const scopeForm = scope ?? { in_scope: checklist.in_scope, out_of_scope: checklist.out_of_scope };
  const unassignedModules = board.modules.filter((m) => !m.owner?.id);
  const uncheckedManual = checklist.items.filter((item) => item.kind === "manual" && !item.passed);

  const handleQuickPrepare = async () => {
    if (quickBusy) return;
    setQuickBusy(true);
    setNotice(undefined);
    try {
      if (!checklist.in_scope.trim()) {
        const modNames = board.modules.map((m) => m.name).filter(Boolean).slice(0, 6).join("、");
        const autoScope = modNames
          ? tr("覆盖 {0} 等功能模块的核心需求实现与验收交付。", { 0: modNames })
          : tr("覆盖当前已整理的全部功能需求实现与验收交付。");
        await bRequirementsApi.saveScope(projectId, { in_scope: autoScope, out_of_scope: checklist.out_of_scope }, checklist.scope_version);
      }
      const fallbackOwner = project.members.find((m) => m.id === userId)?.id ?? project.members[0]?.id ?? null;
      if (fallbackOwner) {
        for (const mod of unassignedModules) {
          await bRequirementsApi.updateModule(projectId, mod, { owner_id: fallbackOwner });
        }
      }
      for (const item of uncheckedManual) {
        await bRequirementsApi.check(projectId, item.key, true);
      }
      setNotice({ tone: "success", text: tr("已一键补全前置核对项，现在可以点击「请大家确认」提交基线。") });
      refresh();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
      refresh();
    } finally {
      setQuickBusy(false);
    }
  };

  return <div className="space-y-3.5">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    {current?.status === "archived" && <Feedback tone="warning">{tr("上一版基线 v{0} 被退回：{1}", { 0: current.version_no, 1: current.confirmations.find((c) => c.status === "rejected")?.comment ?? "" })}</Feedback>}
    <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,1fr)]">
      <div className="space-y-3.5">
        <section className={`${cardClass} p-4`}>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">{tr("项目范围")}</h2>
            {board.editable && <button type="button" className={compactSecondary} disabled={!scope || saveScope.isPending} onClick={() => saveScope.mutate()}>{tr("保存范围")}</button>}
          </div>
          <fieldset disabled={!board.editable} className="space-y-2.5">
            <div><label className={label} htmlFor="b-scope-in">{tr("本项目要做什么（必填）")}</label><textarea id="b-scope-in" className={input} rows={2} maxLength={5000} value={scopeForm.in_scope} onChange={(e) => setScope({ ...scopeForm, in_scope: e.target.value })} /></div>
            <div><label className={label} htmlFor="b-scope-out">{tr("明确不做什么（可选）")}</label><textarea id="b-scope-out" className={input} rows={2} maxLength={5000} value={scopeForm.out_of_scope} onChange={(e) => setScope({ ...scopeForm, out_of_scope: e.target.value })} /></div>
          </fieldset>
        </section>

        <section className={`${cardClass} p-4`}>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">{tr("模块负责人")}</h2>
            <span className="text-xs text-slate-400">{board.modules.length - unassignedModules.length}/{board.modules.length}</span>
          </div>
          {board.modules.length === 0 ? (
            <p className="text-xs text-slate-500">{tr("还没有模块，请回到需求分析添加。")}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {board.modules.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2 text-xs">
                  <span className="truncate font-medium text-slate-800">{m.name}</span>
                  <span>
                    <label className="sr-only" htmlFor={`owner-${m.id}`}>{tr("{0} 负责人", { 0: m.name })}</label>
                    <select id={`owner-${m.id}`} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs" disabled={!board.editable || setOwner.isPending} value={m.owner?.id ?? ""} onChange={(e) => setOwner.mutate({ moduleId: m.id, ownerId: e.target.value })}>
                      <option value="">{tr("未指定")}</option>
                      {project.members.map((p) => <option key={p.id} value={p.id}>{p.name ?? tr("组员")}</option>)}
                    </select>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={`${cardClass} flex flex-col justify-between p-4`}>
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">{tr("审核清单")}</h2>
            {board.editable && !checklist.ready && (
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                disabled={quickBusy}
                onClick={() => void handleQuickPrepare()}
              >
                <CheckCheck size={12} />
                {quickBusy ? tr("处理中…") : tr("一键补全清单")}
              </button>
            )}
          </div>
          <ul className="space-y-2 text-xs">
            {checklist.items.map((item) => (
              <li key={item.key} className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/40 px-2.5 py-2">
                {item.kind === "manual"
                  ? <input id={`check-${item.key}`} type="checkbox" className="mt-0.5" disabled={!board.editable || tick.isPending} checked={item.passed} onChange={(e) => tick.mutate({ key: item.key, checked: e.target.checked })} />
                  : <span aria-hidden className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${item.passed ? "bg-emerald-500" : "bg-slate-300"}`} />}
                <label htmlFor={item.kind === "manual" ? `check-${item.key}` : undefined} className={item.passed ? "text-slate-700" : "text-slate-500"}>
                  {item.label}{item.passed ? "" : item.kind === "rule" ? tr("（未满足）") : ""}{item.detail ? `：${item.detail}` : ""}
                </label>
              </li>
            ))}
          </ul>
        </div>
        {board.editable && (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
            {!project.is_leader && <span className="text-xs text-slate-500">{tr("由组长提交给大家确认")}</span>}
            <button type="button" className={button} disabled={!checklist.ready || !project.is_leader || submit.isPending} title={!checklist.ready ? tr("审核清单还有未满足的项") : undefined} onClick={() => submit.mutate()}>
              {tr("请大家确认")}
            </button>
          </div>
        )}
      </section>
    </div>
  </div>;
}
