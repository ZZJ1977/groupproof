"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronLeft, ChevronRight, FileText, Info, Sparkles, Upload } from "lucide-react";
import type { ProjectCore } from "./core-model";
import { displayDate, makeId, milestoneCode, personName, priorityLabel, projectPath, taskCode } from "./core-model";
import { Empty, Header, Panel, Progress, Stat, Status, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";

export function ProjectOverview({ core }: { core: ProjectCore }) {
  const { project, tasks, modules, milestones, evidence } = core;
  const mine = tasks.filter((task) => task.responsibleIds.includes(core.data.currentUserId) && task.status !== "completed").slice(0, 5);
  const issues = tasks.filter((task) => task.status === "pending_submission" || task.status === "pending_verification" || (task.priority === "high" && task.progress < 40));
  const currentMilestone = milestones.find((item) => item.status === "in_progress") ?? milestones.find((item) => item.status !== "completed");
  const recent = [...core.data.github.filter((item) => item.projectId === project.id).map((item) => ({ id: item.id, title: item.title, at: item.timestamp, kind: "GitHub" })), ...evidence.map((item) => ({ id: item.id, title: `提交了 ${item.title}`, at: item.createdAt, kind: "证据" }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  const frozen = project.setupStatus === "frozen";

  return <div className={s.page}>
    <Header eyebrow={project.name} title="项目总览" subtitle="查看当前进度、我的任务、项目模块和需要处理的问题。" actions={<Link className={s.buttonSoft} href={`${projectPath(project.id)}/setup`}>{frozen ? "查看需求基线" : "完成项目初始化"}<ArrowRight size={14} /></Link>} />
    {!frozen && <div className={s.notice}><Info size={16} />项目尚未完成需求基线确认。可以整理资料与成员信息；正式任务、贡献和 AI 验收将在基线冻结后启用。</div>}
    <div className={s.stats}>
      <Stat label="总进度" value={`${project.progress}%`} note={<Progress value={project.progress} />} tone="blue" />
      <Stat label="核心需求" value={`${project.coreProgress}%`} note="按核心模块完成度汇总" tone="green" />
      <Stat label="当前里程碑" value={currentMilestone ? milestoneCode(currentMilestone) : "—"} note={currentMilestone?.title ?? "暂无里程碑"} />
      <Stat label="阶段截止" value={currentMilestone ? displayDate(currentMilestone.deadline) : displayDate(project.finalDeadline)} note={currentMilestone ? "当前里程碑目标日期" : "项目最终截止日期"} tone="orange" />
    </div>
    <div className={s.grid}>
      <div>
        <Panel title="我的任务" action={<Link className={s.link} href={`${projectPath(project.id)}/tasks?view=list`}>查看全部 <ArrowRight size={13} /></Link>}>
          {mine.length ? <div className={s.tableWrap}><table className={s.table}><thead><tr><th>编号</th><th>任务名称</th><th>负责人</th><th>权重</th><th>状态</th><th>进度</th></tr></thead><tbody>{mine.map((task) => <tr key={task.id}><td>{taskCode(task)}</td><td><TaskLink core={core} task={task} /></td><td>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</td><td>{task.weight}%</td><td><Status value={task.status} /></td><td style={{ minWidth: 80 }}><Progress value={task.progress} /><span className={s.cellSub}>{task.progress}%</span></td></tr>)}</tbody></table></div> : <Empty>暂无分配给你的进行中任务</Empty>}
        </Panel>
        <Panel title="项目模块" action={<Link className={s.link} href={`${projectPath(project.id)}/requirements`}>查看需求 <ArrowRight size={13} /></Link>}>
          {modules.length ? <div className={s.tableWrap}><table className={s.table}><thead><tr><th>模块名称</th><th>进度</th><th>核心需求</th><th>负责人</th></tr></thead><tbody>{modules.map((module) => <tr key={module.id}><td><strong>{module.name}</strong></td><td style={{ minWidth: 150 }}><Progress value={module.progress} /><span className={s.cellSub}>{module.progress}%</span></td><td>{module.core ? <span className={`${s.badge} ${s.badgeBlue}`}>核心</span> : "一般"}</td><td>{personName(core, module.ownerId)}</td></tr>)}</tbody></table></div> : <Empty>初始化后将在这里显示项目模块</Empty>}
        </Panel>
      </div>
      <div>
        <Panel title="需要处理" action={<Link className={s.link} href={`${projectPath(project.id)}/tasks?view=list`}>查看全部 <ArrowRight size={13} /></Link>}>
          {issues.length ? <div className={s.list}>{issues.slice(0, 4).map((task) => <div className={s.listRow} key={task.id}><div><TaskLink core={core} task={task} /><div className={s.muted}>{priorityLabel(task.priority)}优先级 · {task.status === "pending_verification" ? "等待验收确认" : task.status === "pending_submission" ? "需要补充交付证据" : "进度需要关注"}</div></div><Status value={task.status} /></div>)}</div> : <Empty>当前没有阻塞事项</Empty>}
        </Panel>
        <Panel title="最近动态" action={<Link className={s.link} href={`${projectPath(project.id)}/evidence`}>证据中心 <ArrowRight size={13} /></Link>}>
          {recent.length ? <div className={s.list}>{recent.map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{item.kind}</div></div><span className={s.muted}>{displayDate(item.at)}</span></div>)}</div> : <Empty>尚无项目动态</Empty>}
        </Panel>
      </div>
    </div>
  </div>;
}

const setupSteps = ["项目信息", "导入资料", "AI 分析", "解决冲突", "审核基线", "团队确认"];

export function ProjectSetup({ core }: { core: ProjectCore }) {
  const { project } = core;
  const step = project.setupStatus === "frozen" ? 6 : Math.max(1, Math.min(6, project.setupStep || 1));
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [deadline, setDeadline] = useState(project.finalDeadline.slice(0, 10));
  const [projectType, setProjectType] = useState(project.type);
  const [paste, setPaste] = useState("");
  const [analysisReady, setAnalysisReady] = useState(core.requirements.length > 0 && core.modules.length > 0);
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [forceReason, setForceReason] = useState("");
  const [message, setMessage] = useState("");
  const projectFiles = core.data.files.filter((file) => file.projectId === project.id);
  const confirmed = project.confirmedBy.includes(core.data.currentUserId);
  const missing = project.memberIds.filter((id) => !project.confirmedBy.includes(id));

  const advance = () => {
    setMessage("");
    if (step === 1) {
      if (!name.trim() || !description.trim()) return setMessage("请填写项目名称与简介。");
      core.update("projects", project.id, { name: name.trim(), description: description.trim(), finalDeadline: deadline, type: projectType, setupStatus: "draft", setupStep: 2 });
    } else if (step === 2) {
      if (!projectFiles.length) return setMessage("请先导入至少一份课程或项目资料。");
      core.update("projects", project.id, { setupStep: 3 });
    } else if (step === 3) {
      if (!analysisReady) return setMessage("请先完成需求分析。");
      core.update("projects", project.id, { setupStep: 4 });
    } else if (step === 4) {
      if (!conflicts.deadline || !conflicts.format) return setMessage("请逐项确定冲突的官方内容。");
      core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "解决需求来源冲突", target: project.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `截止日期：${conflicts.deadline}；提交格式：${conflicts.format}` });
      core.update("projects", project.id, { setupStep: 5 });
    } else if (step === 5) {
      if (!core.requirements.length) return setMessage("请至少保留一条需求。");
      core.update("projects", project.id, { setupStep: 6, setupStatus: "pending_confirmation", confirmedBy: [] });
    }
  };

  const importFile = (file: File) => {
    if (file.size > 50 * 1024 * 1024) return setMessage(`${file.name} 超过单文件 50MB 限制。`);
    core.add("files", { id: makeId("file"), projectId: project.id, name: file.name, type: file.type || file.name.split(".").pop() || "文件", source: "手动上传", uploaderId: core.data.currentUserId, version: 1, status: "current", updatedAt: new Date().toISOString(), size: `${Math.max(1, Math.round(file.size / 1024))} KB` });
    setMessage(`${file.name} 已加入资料列表。`);
  };

  const runAnalysis = () => {
    if (!core.modules.length) {
      const moduleId = makeId("module");
      const requirementId = makeId("requirement");
      core.add("modules", { id: moduleId, projectId: project.id, name: "核心业务流程", description: "由项目目标和导入资料提取的核心模块", requirementIds: [requirementId], ownerId: core.data.currentUserId, progress: 0, core: true });
      core.add("requirements", { id: requirementId, projectId: project.id, title: "完成核心业务流程", description: project.description, priority: "high", status: "draft", moduleId, version: 1, source: projectFiles[0]?.name ?? "项目简介" });
    } else if (!core.requirements.length) {
      core.add("requirements", { id: makeId("requirement"), projectId: project.id, title: "完成核心业务流程", description: project.description, priority: "high", status: "draft", moduleId: core.modules[0].id, version: 1, source: projectFiles[0]?.name ?? "项目简介" });
    }
    setAnalysisReady(true);
    setMessage("需求和模块草案已生成，请核对来源与冲突。 ");
  };

  const confirmSelf = () => {
    if (confirmed) return;
      const next = [...project.confirmedBy, core.data.currentUserId];
    core.update("projects", project.id, { confirmedBy: next, setupStatus: next.length >= project.memberIds.length ? "frozen" : "pending_confirmation", baselineVersion: next.length >= project.memberIds.length ? Math.max(1, project.baselineVersion) : project.baselineVersion });
  };

  const forceProceed = () => {
    if (core.role !== "leader" || !forceReason.trim()) return setMessage("组长推进需要填写缺席成员和原因。");
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "强制冻结需求基线", target: project.name, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `未确认成员：${missing.map((id) => personName(core, id)).join("、")}；原因：${forceReason.trim()}` });
    core.update("projects", project.id, { setupStatus: "frozen", baselineVersion: Math.max(1, project.baselineVersion) });
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={projectPath(project.id)}>返回项目</Link>} title="项目初始化" subtitle="先完成项目基线初始化，再启用任务与贡献功能。" actions={<Status value={project.setupStatus} />} />
    <div className={s.steps}>{setupSteps.map((label, index) => <div key={label} className={`${s.step} ${step === index + 1 ? s.stepActive : ""} ${step > index + 1 ? s.stepDone : ""}`}><span className={s.stepNum}>{step > index + 1 ? <Check size={13} /> : index + 1}</span>{label}</div>)}</div>
    {message && <div className={s.notice} role="status"><Info size={16} />{message}</div>}
    {step === 1 && <div className={s.grid}><Panel title="基本信息"><div className={s.formGrid}><label><span className={s.fieldLabel}>项目名称 *</span><input className={s.field} value={name} onChange={(event) => setName(event.target.value)} /></label><label><span className={s.fieldLabel}>项目类型</span><select className={s.select} value={projectType} onChange={(event) => setProjectType(event.target.value)}><option>课程项目</option><option>课程报告</option><option>独立项目</option></select></label><label><span className={s.fieldLabel}>最终截止日期</span><input className={s.field} type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><label className={s.full}><span className={s.fieldLabel}>项目简介 *</span><textarea className={s.textarea} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} /><span className={s.muted}>{description.length}/500</span></label></div></Panel><Panel title="初始化说明"><p className={s.small}>填写项目信息并导入课程资料。系统将在审核资料后形成需求与模块草案，团队确认后冻结基线。</p><div className={s.notice}><Info size={15} />正式任务与贡献功能会在基线冻结后启用。</div></Panel></div>}
    {step === 2 && <div className={s.grid}><Panel title="导入资料" action={<span className={s.muted}>已导入 {projectFiles.length} 份</span>}><div className={s.dropzone}><Upload size={20} /><div>选择课程文件、Proposal 或项目资料</div><input aria-label="上传项目资料" type="file" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.txt,.md,.zip,.png,.jpg" onChange={(event) => Array.from(event.target.files ?? []).forEach(importFile)} /></div><div className={s.mt}><label className={s.fieldLabel}>粘贴课程要求</label><textarea className={s.textarea} value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="粘贴课程要求或项目说明" /></div><button type="button" className={s.buttonSoft} style={{ marginTop: 10 }} disabled={!paste.trim()} onClick={() => { core.add("files", { id: makeId("file"), projectId: project.id, name: `粘贴的课程要求 ${projectFiles.length + 1}`, type: "text", source: "粘贴文本", uploaderId: core.data.currentUserId, version: 1, status: "current", updatedAt: new Date().toISOString(), size: `${paste.length} 字` }); setPaste(""); }}>添加文本资料</button></Panel><Panel title="已导入资料">{projectFiles.length ? <div className={s.list}>{projectFiles.map((file) => <div className={s.listRow} key={file.id}><div><FileText size={14} /> <strong>{file.name}</strong><div className={s.muted}>{file.size} · {file.source}</div></div><Status value={file.status} /></div>)}</div> : <Empty>暂无资料</Empty>}</Panel></div>}
    {step === 3 && <div className={s.grid}><Panel title="AI 需求分析"><p className={s.small}>从导入资料中整理项目目标、需求和功能模块。请在下一步核对冲突，再审核基线。</p><div className={s.stats} style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}><Stat label="需求草案" value={core.requirements.length} /><Stat label="功能模块" value={core.modules.length} /></div><button className={s.button} type="button" onClick={runAnalysis}><Sparkles size={15} />{analysisReady ? "重新分析" : "开始分析"}</button></Panel><Panel title="来源资料">{projectFiles.map((file) => <div className={s.listRow} key={file.id}><span>{file.name}</span><span className={s.muted}>{file.type}</span></div>)}</Panel></div>}
    {step === 4 && <div className={s.grid}><Panel title="冲突处理"><p className={s.small}>选择用于正式基线的内容。未处理的冲突会阻止冻结。</p><div className={s.listRow}><div><strong>最终截止日期不一致</strong><div className={s.muted}>课程规则与 Proposal 中的日期不同</div></div><select className={s.select} style={{ width: 190 }} value={conflicts.deadline ?? ""} onChange={(event) => setConflicts({ ...conflicts, deadline: event.target.value })}><option value="">选择官方内容</option><option value="course">采用课程规则</option><option value="proposal">采用 Proposal</option></select></div><div className={s.listRow}><div><strong>提交格式描述不同</strong><div className={s.muted}>课程文件与项目草案对报告格式的要求不同</div></div><select className={s.select} style={{ width: 190 }} value={conflicts.format ?? ""} onChange={(event) => setConflicts({ ...conflicts, format: event.target.value })}><option value="">选择官方内容</option><option value="course">采用课程文件</option><option value="proposal">采用项目草案</option></select></div></Panel><Panel title="处理原则"><div className={s.notice}><Info size={15} />课程项目优先参考课程规则与教师发布的文件。每次决定均会进入基线版本记录。</div></Panel></div>}
    {step === 5 && <div className={s.grid}><Panel title="审核需求基线" action={<Link className={s.link} href={`${projectPath(project.id)}/requirements`}>打开需求管理 <ArrowRight size={13} /></Link>}><div className={s.tableWrap}><table className={s.table}><thead><tr><th>需求</th><th>优先级</th><th>模块</th><th>来源</th></tr></thead><tbody>{core.requirements.map((requirement) => <tr key={requirement.id}><td><strong>{requirement.title}</strong><span className={s.cellSub}>{requirement.description}</span></td><td>{priorityLabel(requirement.priority)}</td><td>{core.modules.find((item) => item.id === requirement.moduleId)?.name ?? "—"}</td><td>{requirement.source}</td></tr>)}</tbody></table></div></Panel><Panel title="审核重点"><div className={s.checks}><span className={s.check}><Check size={14} />需求范围与课程要求一致</span><span className={s.check}><Check size={14} />各需求有可识别的模块归属</span><span className={s.check}><Check size={14} />团队成员同意进入基线确认</span></div></Panel></div>}
    {step === 6 && <div className={s.grid}><Panel title="团队确认"><p className={s.small}>全员确认后冻结需求基线。后续修改需要提交变更，并形成新版本。</p>{project.memberIds.map((id) => <div className={s.listRow} key={id}><strong>{personName(core, id)}</strong><Status value={project.confirmedBy.includes(id) ? "confirmed" : "pending_confirmation"} /></div>)}<div className={s.mt}><button type="button" className={s.button} disabled={confirmed || !core.canEdit || project.setupStatus === "frozen"} onClick={confirmSelf}><Check size={15} />{confirmed ? "你已确认" : "确认基线"}</button></div></Panel><Panel title="基线状态"><Stat label="已确认成员" value={`${project.confirmedBy.length}/${project.memberIds.length}`} note={`当前版本 v${Math.max(1, project.baselineVersion)}`} /><div className={s.mt}><Status value={project.setupStatus} /></div>{core.role === "leader" && missing.length > 0 && project.setupStatus !== "frozen" && <div className={s.mt}><label className={s.fieldLabel}>缺席成员推进原因</label><textarea className={s.textarea} value={forceReason} onChange={(event) => setForceReason(event.target.value)} placeholder="说明未确认成员、沟通情况和推进原因" /><button className={s.buttonGhost} type="button" onClick={forceProceed}>组长按规则推进</button></div>}{project.setupStatus === "frozen" && <Link className={s.buttonSoft} href={`${projectPath(project.id)}/planning`} style={{ marginTop: 16 }}>进入任务规划 <ArrowRight size={14} /></Link>}</Panel></div>}
    <div className={s.actions} style={{ justifyContent: "space-between", marginTop: 12 }}><button type="button" className={s.buttonGhost} disabled={step <= 1 || project.setupStatus === "frozen"} onClick={() => core.update("projects", project.id, { setupStep: step - 1 })}><ChevronLeft size={14} />上一步</button>{step < 6 && <button type="button" className={s.button} disabled={!core.canEdit} onClick={advance}>保存并继续 <ChevronRight size={14} /></button>}</div>
  </div>;
}
