"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FileText, Lock, Upload } from "lucide-react";
import { EmptyState, Feedback, PageHeader, Panel, ProgressBar, Stat, StatusBadge } from "@/components/common";
import { BApiError, newIdempotencyKey } from "@/lib/api/b-client";
import { bGroupsApi } from "@/lib/api/b-groups";
import { bProjectsApi, type BMaterial, type BProjectDraft, type BProjectSetup } from "@/lib/api/b-projects";
import { useWorkspace } from "@/lib/workspace";
import { useBErrorMessage } from "@/features/b/use-b-error";
import { BaselineStep, ConflictsStep, MaterialsContinue, RequirementsStep } from "@/features/b/RequirementsSteps";
import { button, dateOnly, input, label, queryPolicy, secondary } from "@/features/b/ui";

type Notice = { tone: "success" | "error" | "warning" | "info"; text: string } | undefined;

function Loading({ text = "正在加载…" }: { text?: string }) { return <div role="status" className="gp-empty">{text}</div>; }
function LoadError({ error }: { error: unknown }) { const errorText = useBErrorMessage(); return <div role="alert"><Feedback tone="error">{errorText(error)}</Feedback></div>; }
function fieldOf(error: unknown): string | undefined { return error instanceof BApiError && typeof error.details.field === "string" ? error.details.field : undefined; }

const wizardSteps = ["项目名称和类型", "项目简介", "确认创建"];

/** Page 35 (B3-01): the group's create-project wizard; every step is saved on the server. */
export function NewProjectApiPage({ courseId }: { courseId: string }) {
  const router = useRouter();
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [notice, setNotice] = useState<Notice>();
  const groups = useQuery({ queryKey: ["b-groups", userId, courseId], queryFn: () => bGroupsApi.list(courseId), ...queryPolicy });
  const groupId = groups.data?.my_group_id ?? null;
  const group = useQuery({ queryKey: ["b-group", userId, groupId], queryFn: () => bGroupsApi.detail(groupId!), enabled: Boolean(groupId), ...queryPolicy });
  const draft = useQuery({ queryKey: ["b-project-draft", userId, groupId], queryFn: () => bProjectsApi.draft(groupId!), enabled: Boolean(groupId), ...queryPolicy });
  const [form, setForm] = useState<BProjectDraft["payload"]>({});
  const [step, setStep] = useState(0);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [createKey, setCreateKey] = useState(newIdempotencyKey);
  useEffect(() => {
    if (!draft.data || loaded) return;
    setForm(draft.data.payload); setStep(Math.min(draft.data.step, wizardSteps.length - 1)); setVersion(draft.data.lock_version); setLoaded(true);
  }, [draft.data, loaded]);
  const save = useMutation({
    mutationFn: (next: number) => bProjectsApi.saveDraft(groupId!, { payload: form, step: next, lock_version: version }),
    onSuccess: (row) => { setVersion(row.lock_version); setStep(row.step); setNotice(undefined); },
    onError: (error) => {
      setNotice({ tone: "error", text: error instanceof BApiError && error.code === "VERSION_CONFLICT" ? "组员刚刚也修改了草稿，已载入最新内容，请确认后继续。" : errorText(error) });
      setLoaded(false); void cache.invalidateQueries({ queryKey: ["b-project-draft", userId, groupId] });
    },
  });
  const create = useMutation({
    mutationFn: () => bProjectsApi.create(groupId!, { name: (form.name ?? "").trim(), project_type: form.project_type?.trim() || undefined, description: form.description?.trim() || undefined }, createKey),
    onSuccess: (row) => { void cache.invalidateQueries({ queryKey: ["b-group", userId] }); router.push(row.href); },
    onError: (error) => { setNotice({ tone: "error", text: errorText(error) }); setCreateKey(newIdempotencyKey()); void cache.invalidateQueries({ queryKey: ["b-project-draft", userId, groupId] }); },
  });

  if (groups.isPending || (groupId && (group.isPending || draft.isPending))) return <Loading />;
  if (groups.isError) return <LoadError error={groups.error} />;
  if (!groupId) return <div><PageHeader title="创建项目" description="项目以小组为单位创建。" /><Panel className="mt-5"><EmptyState title="你还没有加入小组" description="先创建或加入一个小组，再由组长创建项目。" action={<Link className={button} href={`/courses/${courseId}/groups`}>去组队</Link>} /></Panel></div>;
  if (group.isError) return <LoadError error={group.error} />;
  if (draft.isError) return <LoadError error={draft.error} />;
  const existing = draft.data?.project_id ?? group.data?.project_id;
  if (existing) return <div><PageHeader title="创建项目" /><Panel className="mt-5"><EmptyState title="本组已经创建了项目" description="每个小组只有一个项目。" action={<Link className={button} href={`/projects/${existing}`}>进入项目 <ArrowRight size={15} /></Link>} /></Panel></div>;
  const isLeader = group.data?.leader?.id === userId;
  const set = (key: keyof BProjectDraft["payload"]) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return <div>
    <PageHeader title="创建项目" description={`${group.data?.name ?? ""} · 草稿自动保存，组员都能看到`} actions={<Link href={`/courses/${courseId}/groups/${groupId}`} className={secondary}>返回小组</Link>} />
    <div className="mx-auto mt-5 max-w-[760px] space-y-4">
      <ol className="flex gap-2 text-xs" aria-label="创建步骤">{wizardSteps.map((title, index) => <li key={title} aria-current={index === step ? "step" : undefined} className={`flex-1 rounded border px-3 py-2 ${index === step ? "border-blue-500 bg-blue-50 font-semibold text-blue-700" : index < step ? "border-green-200 text-green-700" : "border-slate-200 text-slate-500"}`}>{index + 1}. {title}</li>)}</ol>
      {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
      <Panel title={wizardSteps[step]}>
        {step === 0 && <div className="space-y-3">
          <div><label className={label} htmlFor="b-project-name">项目名称</label><input id="b-project-name" className={input} maxLength={200} value={form.name ?? ""} onChange={set("name")} /></div>
          <div><label className={label} htmlFor="b-project-type">项目类型（可选）</label><input id="b-project-type" className={input} maxLength={80} placeholder="如：软件开发、调研报告" value={form.project_type ?? ""} onChange={set("project_type")} /></div>
        </div>}
        {step === 1 && <div><label className={label} htmlFor="b-project-description">项目简介（可选）</label><textarea id="b-project-description" className={input} rows={6} maxLength={5000} value={form.description ?? ""} onChange={set("description")} /></div>}
        {step === 2 && <dl className="space-y-2 text-sm">
          <div className="flex gap-3"><dt className="w-20 text-slate-500">名称</dt><dd>{form.name || "—"}</dd></div>
          <div className="flex gap-3"><dt className="w-20 text-slate-500">类型</dt><dd>{form.project_type || "未填写"}</dd></div>
          <div className="flex gap-3"><dt className="w-20 text-slate-500">简介</dt><dd className="whitespace-pre-wrap">{form.description || "未填写"}</dd></div>
          <p className="pt-2 text-xs text-slate-500">创建后会自动带上本组全部成员、课程截止日期和课程里程碑模板。</p>
          {!isLeader && <p className="text-xs text-amber-700">只有组长可以创建项目，你可以先把草稿填好。</p>}
        </dl>}
        <div className="mt-4 flex justify-between gap-2">
          <button type="button" className={secondary} disabled={step === 0 || save.isPending} onClick={() => save.mutate(step - 1)}>上一步</button>
          {step < wizardSteps.length - 1
            ? <button type="button" className={button} disabled={save.isPending || (step === 0 && !form.name?.trim())} onClick={() => save.mutate(step + 1)}>{save.isPending ? "正在保存…" : "保存并下一步"}</button>
            : <button type="button" className={button} disabled={!isLeader || create.isPending || !form.name?.trim()} onClick={() => create.mutate()}>{create.isPending ? "正在创建…" : "创建项目"}</button>}
        </div>
      </Panel>
    </div>
  </div>;
}

const entryAction = { setup: { label: "去初始化", path: "setup" }, baseline: { label: "查看基线", path: "setup" }, readonly: { label: "查看项目", path: "setup" } } as const;
const setupLabel: Record<string, string> = { not_initialized: "未初始化", draft: "初始化中", pending_confirmation: "等待组员确认", frozen: "基线已冻结" };

/** Page 07 (B3-02): entry by project state plus live server-side stats. */
export function ProjectOverviewApiPage({ projectId }: { projectId: string }) {
  const { userId } = useWorkspace();
  const overview = useQuery({ queryKey: ["b-project-overview", userId, projectId], queryFn: () => bProjectsApi.overview(projectId), ...queryPolicy });
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <LoadError error={overview.error} />;
  const project = overview.data;
  const action = entryAction[project.entry];
  const stats = project.stats;
  const progressText = stats.progress_status === "available" ? `${stats.progress}%` : stats.progress_status === "no_weighted_tasks" ? "暂无任务" : "任务结构异常";
  return <div>
    <PageHeader title={project.name} description={project.description ?? "未填写简介"}
      actions={<div className="flex items-center gap-2">
        {project.entry === "readonly" && <StatusBadge tone="gray" label={project.lifecycle === "archived" ? "已归档 · 只读" : "已定稿 · 只读"} />}
        <Link className={project.entry === "readonly" ? secondary : button} href={`/projects/${projectId}/${action.path}`}>{action.label} <ArrowRight size={15} /></Link>
      </div>} />
    <div className="mt-5 grid gap-3 md:grid-cols-4">
      <Stat label="任务" value={stats.task_count} sub={`已完成 ${stats.completed_count}`} />
      <Stat label="总进度" value={progressText} />
      <Stat label="成员" value={stats.member_count} />
      <Stat label="里程碑" value={stats.milestone_count} sub={project.next_milestone ? `下一个：${project.next_milestone.title}` : undefined} />
    </div>
    {stats.progress_status === "available" && <ProgressBar className="mt-3" value={stats.progress ?? 0} />}
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel title="项目状态"><dl className="space-y-2 text-sm">
        <div className="flex gap-3"><dt className="w-24 text-slate-500">初始化</dt><dd>{setupLabel[project.setup_status] ?? project.setup_status}（第 {project.setup_step} 步）</dd></div>
        <div className="flex gap-3"><dt className="w-24 text-slate-500">截止日期</dt><dd>{dateOnly(project.final_deadline)}</dd></div>
        {project.next_milestone && <div className="flex gap-3"><dt className="w-24 text-slate-500">下一个里程碑</dt><dd>{project.next_milestone.title} · {dateOnly(project.next_milestone.deadline)}</dd></div>}
        {!project.can_edit && <p className="flex items-center gap-1 pt-2 text-xs text-slate-500"><Lock size={13} />你可以查看，但不能修改这个项目。</p>}
      </dl></Panel>
      <Panel title="成员"><ul className="divide-y divide-slate-100 text-sm">{project.members.map((member) => <li key={member.id} className="py-2">{member.name ?? "未命名"}</li>)}</ul></Panel>
    </div>
  </div>;
}

const setupSteps = ["基本信息", "资料", "需求分析", "冲突处理", "基线确认"];
const extractLabel: Record<BMaterial["extract_status"], { tone: "green" | "amber" | "red" | "gray"; text: string }> = {
  ready: { tone: "green", text: "正文已就绪" }, pending: { tone: "amber", text: "正文提取中" }, failed: { tone: "red", text: "正文提取失败" }, unavailable: { tone: "gray", text: "正文暂不可用" },
};

/** Page 08 (B3-03 ~ B3-08): basic info, materials, requirements, conflicts, baseline. */
export function ProjectSetupApiPage({ projectId }: { projectId: string }) {
  const { userId } = useWorkspace();
  const cache = useQueryClient();
  const setup = useQuery({ queryKey: ["b-project-setup", userId, projectId], queryFn: () => bProjectsApi.setup(projectId), ...queryPolicy });
  const [step, setStep] = useState<number | null>(null);
  if (setup.isPending) return <Loading />;
  if (setup.isError) return <LoadError error={setup.error} />;
  const data = setup.data;
  // Reopening the page continues where the group left off; a frozen project opens on its baseline.
  const reached = data.setup_status === "frozen" || data.setup_status === "pending_confirmation" ? 5 : Math.min(Math.max(data.setup_step, 1), 5);
  const current = step ?? reached - 1;
  const next = (index: number) => () => { void cache.invalidateQueries({ queryKey: ["b-project-setup", userId, projectId] }); setStep(index); };
  return <div>
    <PageHeader title="项目初始化" description={`${data.name} · ${setupLabel[data.setup_status] ?? data.setup_status}`} actions={<Link href={`/projects/${projectId}`} className={secondary}>项目总览</Link>} />
    <div className="mx-auto mt-5 max-w-[860px] space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="初始化步骤">{setupSteps.map((title, index) => <li key={title} className="flex-1">
        <button type="button" disabled={index >= reached} onClick={() => setStep(index)} aria-current={index === current ? "step" : undefined} title={index >= reached ? "请先完成前面的步骤" : undefined}
          className={`w-full rounded border px-3 py-2 text-left ${index === current ? "border-blue-500 bg-blue-50 font-semibold text-blue-700" : index >= reached ? "cursor-not-allowed border-slate-100 text-slate-300" : "border-slate-200 text-slate-600"}`}>{index + 1}. {title}</button>
      </li>)}</ol>
      {!data.can_edit && current < 2 && <Feedback tone="info">{data.setup_status === "frozen" ? "需求基线已冻结，初始化信息只能查看。" : data.setup_status === "pending_confirmation" ? "基线正在等待组员确认，暂时不能修改。" : "你可以查看初始化信息，但不能修改。"}</Feedback>}
      {current === 0 && <BasicInfoStep projectId={projectId} data={data} onSaved={() => setStep(1)} />}
      {current === 1 && <><MaterialsStep projectId={projectId} data={data} />{data.can_edit && <MaterialsContinue projectId={projectId} onDone={next(2)} />}</>}
      {current === 2 && <RequirementsStep projectId={projectId} onDone={next(3)} />}
      {current === 3 && <ConflictsStep projectId={projectId} onDone={next(4)} />}
      {current === 4 && <BaselineStep projectId={projectId} />}
    </div>
  </div>;
}

function BasicInfoStep({ projectId, data, onSaved }: { projectId: string; data: BProjectSetup; onSaved: () => void }) {
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ name: data.name, project_type: data.project_type ?? "", description: data.description ?? "", start_date: data.start_date ?? today, end_date: data.end_date ?? data.course_deadline ?? today });
  const [notice, setNotice] = useState<Notice>();
  const [field, setField] = useState<string>();
  const save = useMutation({
    mutationFn: () => bProjectsApi.saveBasic(projectId, { name: form.name.trim(), project_type: form.project_type.trim() || undefined, description: form.description.trim() || undefined, start_date: form.start_date, end_date: form.end_date }, data.lock_version),
    onSuccess: (row) => { cache.setQueryData(["b-project-setup", userId, projectId], row); void cache.invalidateQueries({ queryKey: ["b-project-overview", userId, projectId] }); onSaved(); },
    onError: (error) => { setField(fieldOf(error)); setNotice({ tone: "error", text: errorText(error) }); if (error instanceof BApiError && error.code === "VERSION_CONFLICT") void cache.invalidateQueries({ queryKey: ["b-project-setup", userId, projectId] }); },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => { setForm({ ...form, [key]: event.target.value }); if (field === key) setField(undefined); };
  const invalid = (key: string) => (field === key ? "border-red-400 ring-2 ring-red-100" : "");
  return <Panel title="基本信息"><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <fieldset disabled={!data.can_edit} className="space-y-3">
      <div><label className={label} htmlFor="b-setup-name">项目名称</label><input id="b-setup-name" aria-invalid={field === "name"} className={`${input} ${invalid("name")}`} maxLength={200} value={form.name} onChange={set("name")} required /></div>
      <div><label className={label} htmlFor="b-setup-type">项目类型</label><input id="b-setup-type" className={input} maxLength={80} value={form.project_type} onChange={set("project_type")} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className={label} htmlFor="b-setup-start">开始日期</label><input id="b-setup-start" type="date" aria-invalid={field === "start_date"} className={`${input} ${invalid("start_date")}`} value={form.start_date} onChange={set("start_date")} required /></div>
        <div><label className={label} htmlFor="b-setup-end">结束日期</label><input id="b-setup-end" type="date" aria-invalid={field === "end_date"} aria-describedby="b-setup-end-hint" className={`${input} ${invalid("end_date")}`} value={form.end_date} onChange={set("end_date")} required />
          <p id="b-setup-end-hint" className="mt-1 text-xs text-slate-500">不晚于课程截止日期 {dateOnly(data.course_deadline)}</p></div>
      </div>
      <div><label className={label} htmlFor="b-setup-description">项目简介</label><textarea id="b-setup-description" className={input} rows={4} maxLength={5000} value={form.description} onChange={set("description")} /></div>
    </fieldset>
    {data.can_edit && <div className="flex justify-end"><button type="submit" className={button} disabled={save.isPending || !form.name.trim()}>{save.isPending ? "正在保存…" : "保存并下一步"}</button></div>}
  </form></Panel>;
}

function MaterialsStep({ projectId, data }: { projectId: string; data: BProjectSetup }) {
  const cache = useQueryClient();
  const errorText = useBErrorMessage();
  const { userId } = useWorkspace();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => void cache.invalidateQueries({ queryKey: ["b-project-setup", userId, projectId] });
  const addText = useMutation({
    mutationFn: () => bProjectsApi.addText(projectId, { title: title.trim() || undefined, text }),
    onSuccess: () => { setTitle(""); setText(""); setNotice({ tone: "success", text: "已添加文本资料" }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const addFile = useMutation({
    mutationFn: (file: File) => bProjectsApi.addFile(projectId, file),
    onSuccess: (row) => { setNotice({ tone: row.extract_status === "ready" ? "success" : "warning", text: row.extract_status === "ready" ? `已添加「${row.title}」` : `已添加「${row.title}」，${extractLabel[row.extract_status].text}${row.extract_reason ? `：${row.extract_reason}` : ""}` }); refresh(); },
    onError: (error) => setNotice({ tone: "error", text: errorText(error) }),
  });
  const detail = useQuery({ queryKey: ["b-material", userId, projectId, openId], queryFn: () => bProjectsApi.material(projectId, openId!), enabled: Boolean(openId), ...queryPolicy });
  return <div className="space-y-4">
    {notice && <Feedback tone={notice.tone}>{notice.text}</Feedback>}
    <Panel title={`已添加的资料（${data.materials.length}）`}>
      {data.materials.length === 0 ? <EmptyState title="还没有资料" description="粘贴课程要求、需求说明等文本，或上传文件。" /> : <ul className="divide-y divide-slate-100">{data.materials.map((row) => <li key={row.id} className="py-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">{row.kind === "file" ? <Upload size={14} /> : <FileText size={14} />}<strong>{row.title}</strong><span className="text-xs text-slate-400">{row.created_by?.name ?? ""} · {dateOnly(row.created_at)}</span></span>
          <span className="flex items-center gap-2"><StatusBadge tone={extractLabel[row.extract_status].tone} label={extractLabel[row.extract_status].text} />
            {row.extract_status === "ready" && <button type="button" className={secondary} onClick={() => setOpenId(openId === row.id ? null : row.id)}>{openId === row.id ? "收起正文" : `查看正文（${row.text_length} 字）`}</button>}</span>
        </div>
        {row.extract_status !== "ready" && row.extract_reason && <p className="mt-1 text-xs text-slate-500">{row.extract_reason}</p>}
        {openId === row.id && <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700" data-testid="b-material-text">{detail.isPending ? "正在加载正文…" : detail.isError ? errorText(detail.error) : detail.data?.text}</div>}
      </li>)}</ul>}
    </Panel>
    {data.can_edit && <>
      <Panel title="添加文本资料"><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); addText.mutate(); }}>
        <div><label className={label} htmlFor="b-material-title">标题（可选，默认取第一行）</label><input id="b-material-title" className={input} maxLength={255} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        <div><label className={label} htmlFor="b-material-text">正文</label><textarea id="b-material-text" className={input} rows={6} maxLength={200000} value={text} onChange={(event) => setText(event.target.value)} /></div>
        <div className="flex justify-end"><button type="submit" className={button} disabled={addText.isPending || !text.trim()}>{addText.isPending ? "正在添加…" : "添加文本资料"}</button></div>
      </form></Panel>
      <Panel title="上传文件">
        <label className={label} htmlFor="b-material-file">选择文件</label>
        <input id="b-material-file" type="file" className="text-sm" disabled={addFile.isPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) addFile.mutate(file); event.target.value = ""; }} />
        <p className="mt-2 text-xs text-slate-500">{addFile.isPending ? "正在上传…" : "文件正文由平台提取；提取服务未接通时会显示“正文暂不可用”，不会用假正文代替。"}</p>
      </Panel>
    </>}
  </div>;
}
