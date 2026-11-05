"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, Lock, PenLine, Snowflake } from "lucide-react";
import { EmptyState, Feedback, Panel, StatusBadge } from "@/components/common";
import { BApiError } from "@/lib/api/b-client";
import { bProjectsApi } from "@/lib/api/b-projects";
import { bRequirementsApi, type BConflict, type BPriority, type BRequirement, type BRequirementsBoard } from "@/lib/api/b-requirements";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { button, input, label, queryPolicy, secondary } from "@/features/b/ui";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;
const priorityLabel: Record<BPriority, string> = { high: "高", medium: "中", low: "低" };

function useBoard(projectId: string) {
  const { userId } = useWorkspace();
  const cache = useQueryClient();
  const key = ["b-requirements", userId, projectId];
  const query = useQuery({
    queryKey: key, queryFn: () => bRequirementsApi.board(projectId), ...queryPolicy,
    // Poll only while an analysis is running.
    refetchInterval: (state) => (state.state.data?.latest_run?.status === "processing" ? 2000 : false),
  });
  const refresh = () => {
    for (const name of ["b-requirements", "b-checklist", "b-baseline", "b-project-setup", "b-project-overview"]) void cache.invalidateQueries({ queryKey: [name, userId, projectId] });
  };
  return { query, refresh };
}

function Advance({ projectId, from, onDone, disabled }: { projectId: string; from: 2 | 3 | 4; onDone: () => void; disabled?: boolean }) {
  const errorText = useBErrorMessage();
  const cache = useQueryClient();
  const { userId } = useWorkspace();
  const [notice, setNotice] = useState<Notice>();
  const go = useMutation({
    mutationFn: () => bRequirementsApi.advance(projectId, from),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ["b-project-setup", userId, projectId] }); onDone(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  return <div className="flex flex-col items-end gap-2">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <button type="button" className={button} disabled={disabled || go.isPending} onClick={() => go.mutate()}>{go.isPending ? "正在保存…" : "保存并继续"}</button>
  </div>;
}

/** Materials step footer (step 2 → 3). */
export function MaterialsContinue({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  return <Advance projectId={projectId} from={2} onDone={onDone} />;
}

function RunStatus({ board }: { board: BRequirementsBoard }) {
  const run = board.latest_run;
  if (!run) return <p className="text-sm text-slate-500">还没有分析过。分析会读取已就绪的资料正文，生成需求草案供大家修改。</p>;
  if (run.status === "processing") return <div role="status"><Feedback tone="info">正在分析资料，处理中…</Feedback></div>;
  if (run.status === "unavailable") return <Feedback tone="warning">AI 暂不可用，请在下面手动录入模块和需求，流程可以照常走完。</Feedback>;
  if (run.status === "failed") return <Feedback tone="error">{run.error_message ?? "分析失败，请重试或手动录入需求。"}</Feedback>;
  const s = run.summary ?? {};
  return <Feedback tone="success">分析完成：新增 {s.requirements_added ?? 0} 条需求、{s.conflicts_added ?? 0} 个冲突；保留人工新增或修改的 {s.requirements_kept ?? 0} 条。{run.is_placeholder ? "（当前是示例结果，接入真实 AI 后会替换）" : ""}</Feedback>;
}

function RequirementRow({ projectId, row, board, onSaved }: { projectId: string; row: BRequirement; board: BRequirementsBoard; onSaved: () => void }) {
  const errorText = useBErrorMessage();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: row.title, description: row.description ?? "", priority: row.priority, module_id: row.module_id });
  const [notice, setNotice] = useState<Notice>();
  const save = useMutation({
    mutationFn: () => bRequirementsApi.updateRequirement(projectId, row, { ...form, title: form.title.trim(), description: form.description.trim() || undefined }),
    onSuccess: () => { setEditing(false); setNotice(undefined); onSaved(); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); if (error instanceof BApiError && error.code === "VERSION_CONFLICT") onSaved(); },
  });
  if (editing) return <li className="space-y-2 py-3">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <div><label className={label} htmlFor={`req-title-${row.id}`}>需求标题</label><input id={`req-title-${row.id}`} className={input} maxLength={240} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
    <div><label className={label} htmlFor={`req-desc-${row.id}`}>说明</label><textarea id={`req-desc-${row.id}`} className={input} rows={3} maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
    <div className="grid gap-2 sm:grid-cols-2">
      <div><label className={label} htmlFor={`req-module-${row.id}`}>模块</label><select id={`req-module-${row.id}`} className={input} value={form.module_id} onChange={(e) => setForm({ ...form, module_id: e.target.value })}>{board.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
      <div><label className={label} htmlFor={`req-priority-${row.id}`}>优先级</label><select id={`req-priority-${row.id}`} className={input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as BPriority })}>{(["high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{priorityLabel[v]}</option>)}</select></div>
    </div>
    <div className="flex justify-end gap-2"><button type="button" className={secondary} onClick={() => setEditing(false)}>取消</button><button type="button" className={button} disabled={save.isPending || !form.title.trim()} onClick={() => save.mutate()}>保存</button></div>
  </li>;
  return <li className={`py-3 text-sm ${row.excluded ? "opacity-50" : ""}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><p className={`font-medium text-slate-900 ${row.excluded ? "line-through" : ""}`}>{row.title}</p>{row.description && <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{row.description}</p>}</div>
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusBadge tone="gray" label={`优先级 ${priorityLabel[row.priority]}`} />
        {row.origin === "ai" ? <StatusBadge tone="blue" label={row.edited_by_human ? "AI · 已人工修改" : "AI 草案"} /> : <StatusBadge tone="green" label="手工录入" />}
        {row.excluded && <StatusBadge tone="amber" label="冲突处理后未采用" />}
        {board.editable && !row.excluded && <button type="button" className={secondary} aria-label={`编辑需求 ${row.title}`} onClick={() => setEditing(true)}><PenLine size={13} />编辑</button>}
      </span>
    </div>
    {row.sources.length > 0 && <ul className="mt-1.5 space-y-1">{row.sources.map((s, i) => <li key={i} className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-500">出处：{s.material_title ?? "资料"} · 第 {s.segment_id?.replace(/^p/, "") ?? "?"} 段 —— “{s.quote}”</li>)}</ul>}
  </li>;
}

/** Step 3 (B3-05): run the analysis or enter modules/requirements by hand. */
export function RequirementsStep({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const errorText = useBErrorMessage();
  const { query, refresh } = useBoard(projectId);
  const [notice, setNotice] = useState<Notice>();
  const [moduleName, setModuleName] = useState("");
  const [draft, setDraft] = useState({ module_id: "", title: "", description: "", priority: "medium" as BPriority });
  const analyse = useMutation({ mutationFn: () => bRequirementsApi.analyse(projectId), onSuccess: () => { setNotice(undefined); refresh(); }, onError: (error) => setNotice({ tone: "error", text: errorText(error) }) });
  const addModule = useMutation({ mutationFn: () => bRequirementsApi.createModule(projectId, { name: moduleName.trim() }), onSuccess: (row) => { setModuleName(""); setDraft((d) => ({ ...d, module_id: d.module_id || row.id })); refresh(); }, onError: (error) => setNotice({ tone: "error", text: errorText(error) }) });
  const addRequirement = useMutation({
    mutationFn: () => bRequirementsApi.createRequirement(projectId, { module_id: draft.module_id || query.data!.modules[0].id, title: draft.title.trim(), description: draft.description.trim() || undefined, priority: draft.priority }),
    onSuccess: () => { setDraft((d) => ({ ...d, title: "", description: "" })); setNotice({ tone: "success", text: "已添加需求" }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  if (query.isPending) return <div role="status" className="gp-empty">正在加载需求…</div>;
  if (query.isError) return <div role="alert"><Feedback tone="error">{errorText(query.error)}</Feedback></div>;
  const board = query.data;
  const running = board.latest_run?.status === "processing";
  return <div className="space-y-4">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <Panel title="需求分析" action={board.editable ? <button type="button" className={button} disabled={running || analyse.isPending} onClick={() => analyse.mutate()}><Bot size={15} />{board.latest_run ? "重新分析" : "开始分析"}</button> : undefined}>
      <RunStatus board={board} />
      {board.latest_run && board.editable && <p className="mt-2 text-xs text-slate-500">重新分析只替换没人动过的 AI 草案；人工新增或修改过的需求会原样保留。</p>}
    </Panel>
    {board.modules.length === 0 ? <Panel><EmptyState title="还没有模块和需求" description={board.editable ? "可以先分析资料，也可以直接手动添加。" : undefined} /></Panel>
      : board.modules.map((module) => <Panel key={module.id} title={`${module.name}（${module.requirement_count} 条）`}>
        <ul className="divide-y divide-slate-100">{board.requirements.filter((r) => r.module_id === module.id).map((row) => <RequirementRow key={`${row.id}:${row.lock_version}`} projectId={projectId} row={row} board={board} onSaved={refresh} />)}</ul>
        {module.requirement_count === 0 && <p className="text-xs text-slate-500">这个模块还没有需求。</p>}
      </Panel>)}
    {board.editable && <Panel title="手动添加">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); addModule.mutate(); }}>
        <div className="min-w-[220px] flex-1"><label className={label} htmlFor="b-new-module">新模块名称</label><input id="b-new-module" className={input} maxLength={200} value={moduleName} onChange={(e) => setModuleName(e.target.value)} /></div>
        <button type="submit" className={secondary} disabled={addModule.isPending || !moduleName.trim()}>添加模块</button>
      </form>
      {board.modules.length > 0 && <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); addRequirement.mutate(); }}>
        <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
          <div><label className={label} htmlFor="b-new-req-module">所属模块</label><select id="b-new-req-module" className={input} value={draft.module_id || board.modules[0].id} onChange={(e) => setDraft({ ...draft, module_id: e.target.value })}>{board.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
          <div><label className={label} htmlFor="b-new-req-priority">优先级</label><select id="b-new-req-priority" className={input} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as BPriority })}>{(["high", "medium", "low"] as const).map((v) => <option key={v} value={v}>{priorityLabel[v]}</option>)}</select></div>
        </div>
        <div><label className={label} htmlFor="b-new-req-title">需求标题</label><input id="b-new-req-title" className={input} maxLength={240} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div><label className={label} htmlFor="b-new-req-desc">说明（可选）</label><textarea id="b-new-req-desc" className={input} rows={2} maxLength={5000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
        <div className="flex justify-end"><button type="submit" className={secondary} disabled={addRequirement.isPending || !draft.title.trim()}>添加需求</button></div>
      </form>}
    </Panel>}
    {board.editable && <Advance projectId={projectId} from={3} onDone={onDone} disabled={running} />}
  </div>;
}

function ConflictCard({ projectId, conflict, editable, onSaved }: { projectId: string; conflict: BConflict; editable: boolean; onSaved: () => void }) {
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
  const side = (title: string, row: BRequirement) => <div className="rounded border border-slate-200 p-3 text-sm"><p className="text-xs text-slate-500">{title}</p><p className="mt-1 font-medium">{row.title}</p>{row.description && <p className="mt-1 text-xs text-slate-600">{row.description}</p>}</div>;
  return <Panel title={conflict.status === "open" ? "待处理的冲突" : "已处理的冲突"}>
    {conflict.description && <p className="mb-3 text-sm text-slate-700">{conflict.description}</p>}
    <div className="grid gap-2 md:grid-cols-2">{side("需求 A", conflict.left)}{side("需求 B", conflict.right)}</div>
    {conflict.resolution ? <p className="mt-3 text-sm text-slate-600"><CheckCircle2 size={14} className="mr-1 inline text-green-600" />{({ keep_left: "保留 A", keep_right: "保留 B", merge: "合并为一条" } as const)[conflict.resolution.decision]} · 理由：{conflict.resolution.reason}（{conflict.resolution.resolved_by?.name ?? "组员"}）</p>
      : editable && <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
        {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
        <fieldset className="flex flex-wrap gap-4 text-sm"><legend className={label}>怎么处理</legend>
          {([["keep_left", "保留 A"], ["keep_right", "保留 B"], ["merge", "合并为一条"]] as const).map(([value, text]) => <label key={value} className="flex items-center gap-1.5"><input type="radio" name={`decision-${conflict.id}`} value={value} checked={decision === value} onChange={() => setDecision(value)} />{text}</label>)}
        </fieldset>
        {decision === "merge" && <div><label className={label} htmlFor={`merged-${conflict.id}`}>合并后的需求标题</label><input id={`merged-${conflict.id}`} className={input} maxLength={240} value={mergedTitle} onChange={(e) => setMergedTitle(e.target.value)} /></div>}
        <div><label className={label} htmlFor={`reason-${conflict.id}`}>理由（必填）</label><textarea id={`reason-${conflict.id}`} className={input} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div className="flex justify-end"><button type="submit" className={button} disabled={resolve.isPending || !reason.trim() || (decision === "merge" && !mergedTitle.trim())}>确认处理</button></div>
      </form>}
  </Panel>;
}

/** Step 4 (B3-06): every conflict needs a decision and a reason before continuing. */
export function ConflictsStep({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const errorText = useBErrorMessage();
  const { query, refresh } = useBoard(projectId);
  if (query.isPending) return <div role="status" className="gp-empty">正在加载冲突…</div>;
  if (query.isError) return <div role="alert"><Feedback tone="error">{errorText(query.error)}</Feedback></div>;
  const board = query.data;
  return <div className="space-y-4">
    {board.conflicts.length === 0 ? <Panel><EmptyState title="没有发现冲突" description="可以直接进入基线确认。" /></Panel>
      : board.conflicts.map((conflict) => <ConflictCard key={conflict.id} projectId={projectId} conflict={conflict} editable={board.editable} onSaved={refresh} />)}
    {board.open_conflicts > 0 && <p className="text-right text-xs text-amber-700">还有 {board.open_conflicts} 个冲突没有处理，处理完才能继续。</p>}
    {board.editable && <Advance projectId={projectId} from={4} onDone={onDone} />}
  </div>;
}

/** Step 5 (B3-07/B3-08): scope, module owners, checklist, then everyone confirms. */
export function BaselineStep({ projectId }: { projectId: string }) {
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
  const onError = (error: unknown) => { setNotice({ tone: "error", text: errorText(error) }); refresh(); };
  const saveScope = useMutation({ mutationFn: () => bRequirementsApi.saveScope(projectId, scope!, review.data!.scope_version), onSuccess: () => { setScope(null); setNotice({ tone: "success", text: "范围已保存" }); refresh(); }, onError });
  const tick = useMutation({ mutationFn: ({ key, checked }: { key: string; checked: boolean }) => bRequirementsApi.check(projectId, key, checked), onSuccess: refresh, onError });
  const setOwner = useMutation({ mutationFn: ({ moduleId, ownerId }: { moduleId: string; ownerId: string }) => bRequirementsApi.updateModule(projectId, boardQuery.data!.modules.find((m) => m.id === moduleId)!, { owner_id: ownerId || null }), onSuccess: refresh, onError });
  const submit = useMutation({ mutationFn: () => bRequirementsApi.submit(projectId), onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "frozen" ? "基线已冻结" : "已提交，等待组员确认" }); refresh(); }, onError });
  const confirm = useMutation({ mutationFn: ({ decision }: { decision: "confirm" | "reject" }) => bRequirementsApi.confirm(projectId, baseline.data!.id, userId, decision, comment.trim() || undefined), onSuccess: (row) => { setNotice({ tone: "success", text: row.status === "frozen" ? "全部确认，基线已冻结" : row.status === "archived" ? "已退回，组长可以修改后重新提交" : "已确认，等待其他组员" }); refresh(); }, onError });
  const force = useMutation({ mutationFn: () => bRequirementsApi.forceFreeze(projectId, baseline.data!.id, forceReason.trim()), onSuccess: () => { setNotice({ tone: "success", text: "已强制冻结，未确认的组员会收到通知" }); refresh(); }, onError });

  if (boardQuery.isPending || overview.isPending || review.isPending || baseline.isPending) return <div role="status" className="gp-empty">正在加载基线…</div>;
  const failed = [boardQuery, overview, review, baseline].find((q) => q.isError);
  if (failed) return <div role="alert"><Feedback tone="error">{errorText(failed.error)}</Feedback></div>;
  const board = boardQuery.data!;
  const project = overview.data!;
  const checklist = review.data!;
  const current = baseline.data;

  if (current?.status === "frozen") return <div className="space-y-4">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <Panel title={`需求基线 v${current.version_no} 已冻结`}>
      <p className="flex items-center gap-1.5 text-sm text-slate-600"><Snowflake size={15} />冻结于 {current.frozen_at?.slice(0, 10)}，共 {current.snapshot.requirements?.length ?? 0} 条需求、{current.snapshot.modules?.length ?? 0} 个模块。之后修改需求要走变更流程。</p>
      <ul className="mt-3 divide-y divide-slate-100 text-sm">{current.confirmations.map((c) => <li key={c.user.id} className="flex justify-between py-1.5"><span>{c.user.name ?? "组员"}</span><span className="text-xs text-slate-500">{c.status === "confirmed" ? "已确认" : "未确认"}</span></li>)}</ul>
      <div className="mt-3"><Link className={secondary} href={`/projects/${projectId}`}>返回项目总览</Link></div>
    </Panel>
  </div>;

  if (current?.status === "draft") {
    const mine = current.confirmations.find((c) => c.user.id === userId);
    return <div className="space-y-4">
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      <Panel title={`需求基线 v${current.version_no} 等待确认`}>
        <p className="text-sm text-slate-600">还需确认：{current.waiting_for.map((p) => p.name ?? "组员").join("、") || "无"}</p>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">{current.confirmations.map((c) => <li key={c.user.id} className="flex justify-between py-1.5"><span>{c.user.name ?? "组员"}</span><StatusBadge tone={c.status === "confirmed" ? "green" : c.status === "rejected" ? "red" : "amber"} label={c.status === "confirmed" ? "已确认" : c.status === "rejected" ? "已退回" : "待确认"} /></li>)}</ul>
        {mine?.status === "pending" && <div className="mt-4 space-y-2">
          <label className={label} htmlFor="b-baseline-comment">意见（退回时必填）</label>
          <textarea id="b-baseline-comment" className={input} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="flex justify-end gap-2"><button type="button" className={secondary} disabled={confirm.isPending || !comment.trim()} onClick={() => confirm.mutate({ decision: "reject" })}>退回</button><button type="button" className={button} disabled={confirm.isPending} onClick={() => confirm.mutate({ decision: "confirm" })}>确认基线</button></div>
        </div>}
      </Panel>
      {project.is_leader && current.waiting_for.length > 0 && <Panel title="组长强制冻结">
        <p className="mb-2 text-xs text-slate-500">只在确实等不到确认时使用；未确认的组员会收到通知，原因会记入操作记录。</p>
        <label className={label} htmlFor="b-force-reason">原因（必填）</label>
        <textarea id="b-force-reason" className={input} rows={2} maxLength={2000} value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
        <div className="mt-2 flex justify-end"><button type="button" className={secondary} disabled={force.isPending || !forceReason.trim()} onClick={() => force.mutate()}><Lock size={14} />强制冻结</button></div>
      </Panel>}
    </div>;
  }

  const scopeForm = scope ?? { in_scope: checklist.in_scope, out_of_scope: checklist.out_of_scope };
  return <div className="space-y-4">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    {current?.status === "archived" && <Feedback tone="warning">上一版基线 v{current.version_no} 被退回：{current.confirmations.find((c) => c.status === "rejected")?.comment ?? ""}</Feedback>}
    <Panel title="项目范围">
      <fieldset disabled={!board.editable} className="space-y-2">
        <div><label className={label} htmlFor="b-scope-in">本项目要做什么（必填）</label><textarea id="b-scope-in" className={input} rows={3} maxLength={5000} value={scopeForm.in_scope} onChange={(e) => setScope({ ...scopeForm, in_scope: e.target.value })} /></div>
        <div><label className={label} htmlFor="b-scope-out">明确不做什么（可选）</label><textarea id="b-scope-out" className={input} rows={2} maxLength={5000} value={scopeForm.out_of_scope} onChange={(e) => setScope({ ...scopeForm, out_of_scope: e.target.value })} /></div>
      </fieldset>
      {board.editable && <div className="mt-2 flex justify-end"><button type="button" className={secondary} disabled={!scope || saveScope.isPending} onClick={() => saveScope.mutate()}>保存范围</button></div>}
    </Panel>
    <Panel title="模块负责人">
      {board.modules.length === 0 ? <p className="text-sm text-slate-500">还没有模块，请回到需求分析添加。</p> : <ul className="divide-y divide-slate-100">{board.modules.map((m) => <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
        <span>{m.name}</span>
        <span><label className="sr-only" htmlFor={`owner-${m.id}`}>{m.name} 负责人</label><select id={`owner-${m.id}`} className="rounded border border-slate-200 px-2 py-1.5 text-sm" disabled={!board.editable || setOwner.isPending} value={m.owner?.id ?? ""} onChange={(e) => setOwner.mutate({ moduleId: m.id, ownerId: e.target.value })}><option value="">未指定</option>{project.members.map((p) => <option key={p.id} value={p.id}>{p.name ?? "组员"}</option>)}</select></span>
      </li>)}</ul>}
    </Panel>
    <Panel title="审核清单">
      <ul className="space-y-2 text-sm">{checklist.items.map((item) => <li key={item.key} className="flex items-start gap-2">
        {item.kind === "manual"
          ? <input id={`check-${item.key}`} type="checkbox" className="mt-0.5" disabled={!board.editable || tick.isPending} checked={item.passed} onChange={(e) => tick.mutate({ key: item.key, checked: e.target.checked })} />
          : <span aria-hidden className={`mt-0.5 inline-block h-3.5 w-3.5 rounded-full ${item.passed ? "bg-green-500" : "bg-slate-300"}`} />}
        <label htmlFor={item.kind === "manual" ? `check-${item.key}` : undefined} className={item.passed ? "text-slate-700" : "text-slate-500"}>{item.label}{item.passed ? "" : item.kind === "rule" ? "（未满足）" : ""}{item.detail ? `：${item.detail}` : ""}</label>
      </li>)}</ul>
      {board.editable && <div className="mt-4 flex items-center justify-end gap-3">
        {!project.is_leader && <span className="text-xs text-slate-500">由组长提交给大家确认</span>}
        <button type="button" className={button} disabled={!checklist.ready || !project.is_leader || submit.isPending} title={!checklist.ready ? "审核清单还有未满足的项" : undefined} onClick={() => submit.mutate()}>请大家确认</button>
      </div>}
    </Panel>
  </div>;
}
