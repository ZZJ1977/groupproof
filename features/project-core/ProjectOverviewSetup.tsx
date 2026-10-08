"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronLeft, ChevronRight, FileText, Info, Sparkles, Upload } from "lucide-react";
import type { ProjectCore } from "./core-model";
import { displayDate, makeId, milestoneCode, personName, priorityLabel, projectPath, taskCode } from "./core-model";
import { activeBaseline, confirmationsComplete, confirmedUserIds, draftBaseline, legacyConfirmedUserIds } from "@/lib/versioning";
import { useCommands } from "@/lib/commands/use-commands";
import { currentTasks, getProjectOverview } from "@/lib/overview";
import type { SetupDraft } from "@/types/domain";
import { Empty, Header, Panel, Progress, Stat, Status, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";

export function ProjectOverview({ core }: { core: ProjectCore }) {
  const { project } = core;
  const model = getProjectOverview(core.data, core.data.currentUserId, project.id);
  const tasks = currentTasks(core.data, project.id);
  const issues = tasks.filter((task) => task.status === "pending_submission" || task.status === "pending_verification" || (task.priority === "high" && task.progress < 40));
  const currentMilestone = model.milestones.find((item) => item.status === "in_progress") ?? model.milestones.find((item) => item.status !== "completed");
  const frozen = project.setupStatus === "frozen";
  const planLabel = model.planState === "confirmed" ? "正式计划已发布" : model.planState === "review" ? "计划复核中" : model.planState === "draft" ? "计划草稿" : "暂无计划";
  return <div className={s.page}>
    <Header eyebrow={project.name} title="项目总览" subtitle="查看当前进度、我的任务、项目模块和需要处理的问题。" actions={<><Status value={project.lifecycle} /><Status value={project.setupStatus} /><Link className={s.buttonSoft} href={`${projectPath(project.id)}/setup`}>{frozen ? "查看需求基线" : "完成项目初始化"}<ArrowRight size={14} /></Link></>} />
    {!frozen && <div className={s.notice}><Info size={16} />项目尚未完成需求基线确认。可以整理资料与成员信息；正式任务、贡献和 AI 验收将在基线冻结后启用。</div>}
    {model.sourceProjectId && <div className={s.notice}><Info size={16} />本项目为修订版本（来源 {model.sourceProjectId}）；复制的验收标记为待复核，新计划发布前不作为可执行结论。</div>}
    <div className={s.stats}>
      <Stat label="总进度" value={model.progress.overall === null ? "暂无计划" : `${model.progress.overall}%`} note={model.progress.overall === null ? "顶层任务权重合计为 0" : <Progress value={model.progress.overall} />} tone="blue" />
      <Stat label="核心需求" value={model.progress.core === null ? "暂无计划" : `${model.progress.core}%`} note="按核心模块根任务权重归一" tone="green" />
      <Stat label="当前里程碑" value={currentMilestone ? milestoneCode(currentMilestone) : "—"} note={currentMilestone?.title ?? "暂无里程碑"} />
      <Stat label="阶段截止" value={currentMilestone ? displayDate(currentMilestone.deadline) : displayDate(project.finalDeadline)} note={currentMilestone ? "当前里程碑目标日期" : "项目最终截止日期"} tone="orange" />
    </div>
    <div className={s.grid}>
      <div>
        {!model.isStaff && <Panel title="我的任务" action={<Link className={s.link} href={`${projectPath(project.id)}/tasks?view=list`}>查看全部 <ArrowRight size={13} /></Link>}>
          {model.myTasks.length ? <div className={s.tableWrap}><table className={s.table}><thead><tr><th>编号</th><th>任务名称</th><th>负责人</th><th>权重</th><th>状态</th><th>进度</th></tr></thead><tbody>{model.myTasks.map((task) => <tr key={task.id}><td>{taskCode(task)}</td><td><TaskLink core={core} task={task} /></td><td>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</td><td>{task.weight}%</td><td><Status value={task.status} /></td><td style={{ minWidth: 80 }}><Progress value={task.progress} /><span className={s.cellSub}>{task.progress}%</span></td></tr>)}</tbody></table></div> : <Empty>暂无分配给你的进行中任务</Empty>}
        </Panel>}
        <Panel title="项目模块" action={<Link className={s.link} href={`${projectPath(project.id)}/requirements`}>查看需求 <ArrowRight size={13} /></Link>}>
          {core.modules.length ? <div className={s.tableWrap}><table className={s.table}><thead><tr><th>模块名称</th><th>进度</th><th>核心需求</th><th>负责人</th></tr></thead><tbody>{core.modules.map((module) => <tr key={module.id}><td><strong>{module.name}</strong></td><td style={{ minWidth: 150 }}><Progress value={module.progress} /><span className={s.cellSub}>{module.progress}%</span></td><td>{module.core ? <span className={`${s.badge} ${s.badgeBlue}`}>核心</span> : "一般"}</td><td>{personName(core, module.ownerId)}</td></tr>)}</tbody></table></div> : <Empty>初始化后将在这里显示项目模块</Empty>}
        </Panel>
      </div>
      <div>
        <Panel title="版本与计划" >
          <div className={s.listRow}><span>需求基线</span><strong>{model.baselineRevision ? `修订 ${model.baselineRevision.number}（${model.baselineRevision.id}）` : "未建立"}</strong></div>
          <div className={s.listRow}><span>任务计划</span><strong>{model.planRevision ? `修订 ${model.planRevision.number} · ${planLabel}` : planLabel}</strong></div>
          <div className={s.listRow}><span>课程规则</span><strong>{model.appliedCourseRuleRevisionId ?? "未记录"}</strong></div>
          {model.preview && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={14} />当前为草稿统计口径（预览），正式执行统计以已发布计划为准。</div>}
        </Panel>
        <Panel title="需要处理" action={<Link className={s.link} href={`${projectPath(project.id)}/tasks?view=list`}>查看全部 <ArrowRight size={13} /></Link>}>
          {(issues.length || model.actionItems.length) ? <div className={s.list}>
            {issues.slice(0, 3).map((task) => <div className={s.listRow} key={task.id}><div><TaskLink core={core} task={task} /><div className={s.muted}>{priorityLabel(task.priority)}优先级 · {task.status === "pending_verification" ? "等待验收确认" : task.status === "pending_submission" ? "需要补充交付证据" : "进度需要关注"}</div></div><Status value={task.status} /></div>)}
            {model.actionItems.slice(0, 3).map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{item.description}</div><Link className={s.link} href={item.href}>去处理 <ArrowRight size={12} style={{ display: "inline" }} /></Link></div><span className={s.muted}>{displayDate(item.dueAt)}</span></div>)}
          </div> : <Empty>当前没有阻塞事项</Empty>}
        </Panel>
        <Panel title="最近动态" action={<Link className={s.link} href={`${projectPath(project.id)}/evidence`}>证据中心 <ArrowRight size={13} /></Link>}>
          {model.activity.length ? <div className={s.list}>{model.activity.map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{item.kind}</div></div><span className={s.muted}>{displayDate(item.at)}</span></div>)}</div> : <Empty>尚无项目动态</Empty>}
        </Panel>
      </div>
    </div>
  </div>;
}

const setupSteps = ["项目信息", "导入资料", "AI 分析", "解决冲突", "审核基线", "团队确认"];

export function ProjectSetup({ core }: { core: ProjectCore }) {
  const commands = useCommands();
  const { project } = core;
  const draft = core.data.setupDrafts.find((item) => item.projectId === project.id);
  const [name, setName] = useState(draft?.form.name ?? project.name);
  const [description, setDescription] = useState(draft?.form.description ?? project.description);
  const [projectType, setProjectType] = useState(draft?.form.type ?? project.type);
  const [deadline, setDeadline] = useState((draft?.form.finalDeadline ?? project.finalDeadline).slice(0, 10));
  const [paste, setPaste] = useState("");
  const [forceReason, setForceReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const versionRef = useRef(project.version);
  versionRef.current = project.version;
  const step = (draft?.step ?? (project.setupStatus === "frozen" ? 6 : Math.max(1, Math.min(6, project.setupStep || 1)))) as SetupDraft["step"];
  const projectFiles = core.data.files.filter((file) => file.projectId === project.id);
  const selectedFileIds = draft?.selectedFileIds ?? [];
  const baselineRevision = (draft?.baselineDraftId ? core.data.baselineRevisions.find((item) => item.id === draft.baselineDraftId) : undefined)
    ?? draftBaseline(core.data, project.id)
    ?? activeBaseline(core.data, project.id);
  const confirmed = baselineRevision ? confirmedUserIds(baselineRevision) : [];
  const legacyConfirmed = baselineRevision ? legacyConfirmedUserIds(baselineRevision) : [];
  const frozen = project.setupStatus === "frozen" && Boolean(project.activeBaselineRevisionId);
  const editable = core.canEdit && !frozen;

  const persist = async (
    nextStep: SetupDraft["step"],
    patch?: Partial<Pick<SetupDraft, "selectedFileIds" | "pastedSources" | "conflicts" | "baselineDraftId">>,
  ): Promise<boolean> => {
    const outcome = await commands.saveSetupDraft({
      projectId: project.id,
      step: nextStep,
      form: { name: name.trim(), description: description.trim(), type: projectType, finalDeadline: deadline },
      selectedFileIds: patch?.selectedFileIds ?? selectedFileIds,
      pastedSources: patch?.pastedSources ?? draft?.pastedSources ?? [],
      conflicts: patch?.conflicts ?? draft?.conflicts ?? [],
      baselineDraftId: patch?.baselineDraftId ?? draft?.baselineDraftId,
      expectedVersion: versionRef.current,
    });
    if (!outcome.ok) { setMessage(outcome.error.message); return false; }
    return true;
  };

  const goNext = async () => {
    if (step === 1 && (!name.trim() || !description.trim())) return setMessage("请填写项目名称与简介。");
    setBusy(true);
    try {
      if (!(await persist(step))) return;
      const outcome = await commands.advanceSetupStep({ projectId: project.id, toStep: Math.min(6, step + 1) as SetupDraft["step"], expectedVersion: project.version });
      if (!outcome.ok) { setMessage(outcome.error.message); return; }
      setMessage("");
    } finally { setBusy(false); }
  };

  const goPrev = async () => {
    if (step <= 1) return;
    setBusy(true);
    try {
      if (!(await persist(step))) return;
      const outcome = await commands.advanceSetupStep({ projectId: project.id, toStep: (step - 1) as SetupDraft["step"], expectedVersion: project.version });
      if (!outcome.ok) { setMessage(outcome.error.message); return; }
      setMessage("");
    } finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    const outcome = await commands.uploadProjectFile({ projectId: project.id, name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, expectedVersion: versionRef.current });
    if (!outcome.ok) { setMessage(`${file.name}：${outcome.error.message}`); return; }
    versionRef.current += 1;
    if (await persist(2, { selectedFileIds: [...selectedFileIds, outcome.result.id] })) setMessage(`${file.name} 已保存为资料记录 v${outcome.result.version}（模拟上传，仅元数据）。`);
  };

  const addPasted = async () => {
    if (!paste.trim()) return;
    const entry = { id: makeId("source"), title: `粘贴来源 ${(draft?.pastedSources.length ?? 0) + 1}`, text: paste.trim() };
    core.add("files", { id: entry.id, projectId: project.id, name: entry.title, type: "text", source: "粘贴文本", uploaderId: core.data.currentUserId, version: 1, status: "current", updatedAt: new Date().toISOString(), size: `${paste.length} 字` });
    setPaste("");
    if (await persist(2, { pastedSources: [...(draft?.pastedSources ?? []), entry] })) setMessage("文本来源已保存为可追溯资料。");
  };

  const runAnalysis = async () => {
    setBusy(true);
    try {
      if (!(await persist(3))) return;
      const outcome = await commands.runMockRequirementAnalysis({ projectId: project.id, expectedVersion: project.version });
      if (!outcome.ok) { setMessage(outcome.error.message); return; }
      setMessage(outcome.result.analysis.status === "succeeded"
        ? "演示分析完成：需求与模块草稿已写入基线草稿，请核对来源与冲突。"
        : "模拟分析未提取到有效内容；资料已保留，请补充后重试。");
    } finally { setBusy(false); }
  };

  const selectConflict = async (conflictId: string, selected: string) => {
    const conflicts = (draft?.conflicts ?? []).map((item) => (item.id === conflictId ? { ...item, selected } : item));
    if (await persist(4, { conflicts })) setMessage("");
  };

  const confirmSelf = async () => {
    if (!baselineRevision || baselineRevision.status === "published") return;
    setBusy(true);
    try {
      const outcome = await commands.confirmBaselineSelf({ projectId: project.id, revisionId: baselineRevision.id, contentVersion: baselineRevision.contentVersion, expectedVersion: project.version });
      setMessage(outcome.ok ? "已记录你的确认。" : outcome.error.message);
    } finally { setBusy(false); }
  };

  const publish = async (override: boolean) => {
    if (!baselineRevision || baselineRevision.status === "published") return;
    setBusy(true);
    try {
      const outcome = override
        ? await commands.forcePublishBaseline({ projectId: project.id, revisionId: baselineRevision.id, reason: forceReason.trim(), expectedVersion: project.version })
        : await commands.publishBaseline({ projectId: project.id, revisionId: baselineRevision.id, expectedVersion: project.version });
      if (!outcome.ok) { setMessage(outcome.error.message); return; }
      setForceReason("");
      setMessage(override ? "例外推进完成；未确认成员已记入审计，基线已冻结。" : "全员确认完成，基线已冻结；可进入任务规划。");
    } finally { setBusy(false); }
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={projectPath(project.id)}>返回项目</Link>} title="项目初始化" subtitle="先完成项目基线初始化，再启用任务与贡献功能。" actions={<Status value={project.setupStatus} />} />
    <div className={s.steps}>{setupSteps.map((label, index) => <div key={label} className={`${s.step} ${step === index + 1 ? s.stepActive : ""} ${step > index + 1 ? s.stepDone : ""}`}><span className={s.stepNum}>{step > index + 1 ? <Check size={13} /> : index + 1}</span>{label}</div>)}</div>
    {message && <div className={s.notice} role="status"><Info size={16} />{message}</div>}
    {!core.canEdit && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={16} />教学人员为只读视图，无编辑或确认自身入口。</div>}
    {step === 1 && <div className={s.grid}><Panel title="基本信息"><div className={s.formGrid}><label><span className={s.fieldLabel}>项目名称 *</span><input className={s.field} value={name} disabled={!editable} onChange={(event) => setName(event.target.value)} /></label><label><span className={s.fieldLabel}>项目类型</span><select className={s.select} value={projectType} disabled={!editable} onChange={(event) => setProjectType(event.target.value)}><option>课程项目</option><option>课程报告</option><option>独立项目</option></select></label><label><span className={s.fieldLabel}>最终截止日期</span><input className={s.field} type="date" value={deadline} disabled={!editable} onChange={(event) => setDeadline(event.target.value)} /></label><label className={s.full}><span className={s.fieldLabel}>项目简介 *</span><textarea className={s.textarea} value={description} disabled={!editable} onChange={(event) => setDescription(event.target.value)} maxLength={500} /><span className={s.muted}>{description.length}/500</span></label></div></Panel><Panel title="初始化说明"><p className={s.small}>填写项目信息并导入课程资料。系统将在审核资料后形成需求与模块草案，团队确认后冻结基线。</p><div className={s.notice}><Info size={15} />课程硬约束（如项目截止日期）来自所采用的课程规则版本，不能通过本表单绕过。</div></Panel></div>}
    {step === 2 && <div className={s.grid}><Panel title="导入资料" action={<span className={s.muted}>已选择 {selectedFileIds.length} 份</span>}><div className={s.dropzone}><Upload size={20} /><div>选择课程文件、Proposal 或项目资料</div><input aria-label="上传项目资料" type="file" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.txt,.md,.zip,.png,.jpg" disabled={!editable} onChange={(event) => { void Array.from(event.target.files ?? []).reduce((chain, file) => chain.then(() => importFile(file)), Promise.resolve()); event.target.value = ""; }} /></div><div className={s.mt}><label className={s.fieldLabel}>粘贴课程要求（作为可追溯来源保存）</label><textarea className={s.textarea} value={paste} disabled={!editable} onChange={(event) => setPaste(event.target.value)} placeholder="粘贴课程要求或项目说明" /></div><button type="button" className={s.buttonSoft} style={{ marginTop: 10 }} disabled={!paste.trim() || !editable} onClick={() => void addPasted()}>添加文本资料</button></Panel><Panel title="已保存资料">{projectFiles.length ? <div className={s.list}>{projectFiles.map((file) => <div className={s.listRow} key={file.id}><div><FileText size={14} /> <strong>{file.name}</strong><div className={s.muted}>{file.size} · {file.source}{selectedFileIds.includes(file.id) ? " · 已选择" : ""}</div></div><Status value={file.status} /></div>)}</div> : <Empty>暂无资料</Empty>}{draft?.pastedSources.length ? <div className={s.mt}>{draft.pastedSources.map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{item.text.slice(0, 60)}…</div></div><span className={s.muted}>来源</span></div>)}</div> : null}</Panel></div>}
    {step === 3 && <div className={s.grid}><Panel title="AI 需求分析（演示）"><p className={s.small}>从已保存的资料来源中整理项目目标、需求和功能模块。当前为可重复的模拟分析，不解析未保存的真实文件字节。</p><div className={s.stats} style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}><Stat label="分析状态" value={draft?.analysis.status === "succeeded" ? "已完成" : draft?.analysis.status === "failed" ? "失败" : draft?.analysis.status === "running" ? "运行中" : "未运行"} /><Stat label="冲突项" value={draft?.conflicts.length ?? 0} /></div><button className={s.button} type="button" disabled={!editable || busy} onClick={() => void runAnalysis()}><Sparkles size={15} />{draft?.analysis.status === "failed" ? "重试分析" : draft?.analysis.status === "succeeded" ? "重新分析" : "开始分析"}</button></Panel><Panel title="来源资料">{projectFiles.map((file) => <div className={s.listRow} key={file.id}><span>{file.name}</span><span className={s.muted}>{file.type}</span></div>)}</Panel></div>}
    {step === 4 && <div className={s.grid}><Panel title="冲突处理"><p className={s.small}>冲突项来自实际分析结果。未处理的冲突会阻止进入审核。</p>{(draft?.conflicts ?? []).length ? (draft?.conflicts ?? []).map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.field === "finalDeadline" ? "最终截止日期不一致" : "提交格式描述不同"}</strong><div className={s.muted}>来源：{item.choices.join(" / ")}</div></div><select className={s.select} style={{ width: 190 }} disabled={!editable} value={item.selected ?? ""} onChange={(event) => void selectConflict(item.id, event.target.value)}><option value="">选择官方内容</option>{item.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></div>) : <Empty>分析未发现真实冲突，可继续下一步</Empty>}</Panel><Panel title="处理原则"><div className={s.notice}><Info size={15} />课程项目优先参考课程规则与教师发布的文件。每次决定均会进入基线版本记录。</div></Panel></div>}
    {step === 5 && <div className={s.grid}><Panel title="审核需求基线" action={<Link className={s.link} href={`${projectPath(project.id)}/requirements`}>打开需求管理 <ArrowRight size={13} /></Link>}><div className={s.tableWrap}><table className={s.table}><thead><tr><th>需求</th><th>优先级</th><th>模块</th><th>来源</th></tr></thead><tbody>{(baselineRevision?.payload.requirements ?? core.requirements).map((requirement) => <tr key={requirement.id}><td><strong>{requirement.title}</strong><span className={s.cellSub}>{requirement.description}</span></td><td>{priorityLabel(requirement.priority)}</td><td>{(baselineRevision?.payload.modules ?? core.modules).find((item) => item.id === requirement.moduleId)?.name ?? "—"}</td><td>{requirement.source}</td></tr>)}</tbody></table></div>{baselineRevision && <div className={s.mt}><span className={s.muted}>基线草稿 {baselineRevision.id} · 内容 v{baselineRevision.contentVersion}{baselineRevision.reason ? ` · ${baselineRevision.reason}` : ""}</span></div>}</Panel><Panel title="审核重点"><div className={s.checks}><span className={s.check}><Check size={14} />需求范围与课程要求一致</span><span className={s.check}><Check size={14} />各需求有可识别的模块归属</span><span className={s.check}><Check size={14} />团队成员同意进入基线确认</span></div></Panel></div>}
    {step === 6 && <div className={s.grid}><Panel title="团队确认"><p className={s.small}>全员确认后冻结需求基线。确认绑定当前内容版本，修改草稿后需重新确认。</p>{project.memberIds.map((id) => { const record = baselineRevision?.confirmations.find((item) => item.userId === id && item.contentVersion === baselineRevision.contentVersion); const isConfirmed = confirmed.includes(id) || legacyConfirmed.includes(id); return <div className={s.listRow} key={id}><strong>{personName(core, id)}</strong><span className={s.muted}>{record ? `已确认 · ${new Date(record.confirmedAt).toLocaleString("zh-CN")}` : legacyConfirmed.includes(id) ? "历史确认（未记录时间）" : "待确认"}</span><Status value={isConfirmed ? "confirmed" : "pending_confirmation"} /></div>; })}<div className={s.mt}><button type="button" className={s.button} disabled={!editable || busy || !baselineRevision || baselineRevision.status === "published" || confirmed.includes(core.data.currentUserId)} onClick={() => void confirmSelf()}><Check size={15} />{confirmed.includes(core.data.currentUserId) ? "你已确认" : "确认基线"}</button></div></Panel><Panel title="基线状态"><Stat label="已确认成员" value={`${confirmed.length}/${project.memberIds.length}`} note={baselineRevision ? `修订 ${baselineRevision.number} · 内容版本 v${baselineRevision.contentVersion}` : "尚未建立版本快照"} /><div className={s.mt}><Status value={project.setupStatus} /></div>{frozen && <div className={s.mt}><div className={s.notice}><Check size={15} />基线已发布并冻结；初始化完成依据生效版本 {project.activeBaselineRevisionId}。</div><Link className={s.buttonSoft} href={`${projectPath(project.id)}/planning`} style={{ marginTop: 12 }}>进入任务规划 <ArrowRight size={14} /></Link></div>}{!frozen && core.canLead && <div className={s.mt}><button type="button" className={s.button} disabled={!baselineRevision || !confirmationsComplete(baselineRevision) || busy} onClick={() => void publish(false)}>组长按规则发布</button><label className={s.fieldLabel} style={{ marginTop: 10 }}>例外推进原因（含未确认成员）</label><textarea className={s.textarea} value={forceReason} disabled={!editable} onChange={(event) => setForceReason(event.target.value)} placeholder="说明未确认成员、沟通情况和推进原因" /><button className={s.buttonGhost} type="button" disabled={!editable || !baselineRevision || !forceReason.trim() || busy || confirmationsComplete(baselineRevision)} onClick={() => void publish(true)}>组长按规则推进</button></div>}</Panel></div>}
    <div className={s.actions} style={{ justifyContent: "space-between", marginTop: 12 }}><button type="button" className={s.buttonGhost} disabled={step <= 1 || busy || !editable} onClick={() => void goPrev()}><ChevronLeft size={14} />上一步</button>{step < 6 && <button type="button" className={s.button} disabled={!editable || busy} onClick={() => void goNext()}>保存并继续 <ChevronRight size={14} /></button>}</div>
  </div>;
}
