"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Info, Plus, RefreshCcw, Save } from "lucide-react";
import type { Priority } from "@/types/domain";
import type { ProjectCore } from "./core-model";
import { makeId, personName, priorityLabel, projectPath, requirementCode, taskCode, taskPath, taskTitle } from "./core-model";
import { Empty, Header, Panel, Status, Tabs, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";

const priorityOptions: { value: Priority; label: string }[] = [{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }];

export function ProjectRequirements({ core }: { core: ProjectCore }) {
  const [tab, setTab] = useState("list");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(core.requirements[0]?.id ?? "");
  const selected = core.requirements.find((item) => item.id === selectedId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(selected?.title ?? "");
  const [description, setDescription] = useState(selected?.description ?? "");
  const [priority, setPriority] = useState<Priority>(selected?.priority ?? "medium");
  const [moduleId, setModuleId] = useState(selected?.moduleId ?? "");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const frozen = core.project.setupStatus === "frozen";
  const formalBaseline = core.project.baselineVersion > 0 && core.project.setupStatus !== "draft";
  const defaultModuleId = core.modules[0]?.id ?? "";

  useEffect(() => {
    setTitle(selected?.title ?? "");
    setDescription(selected?.description ?? "");
    setPriority(selected?.priority ?? "medium");
    setModuleId(selected?.moduleId ?? defaultModuleId);
    setReason("");
  }, [selectedId, selected?.version, selected?.title, selected?.description, selected?.priority, selected?.moduleId, defaultModuleId]);

  const save = () => {
    if (!title.trim() || !description.trim() || !moduleId) return setFeedback("请填写需求名称、描述并选择所属模块。");
    if (formalBaseline && !reason.trim()) return setFeedback("正式基线的变更需要填写原因。");
    if (selected) {
      core.update("requirements", selected.id, { title: title.trim(), description: description.trim(), priority, moduleId, status: formalBaseline ? "draft" : selected.status, version: selected.version + 1 });
      if (formalBaseline) {
        core.update("projects", core.project.id, { setupStatus: "pending_confirmation", setupStep: 6, baselineVersion: core.project.baselineVersion + (frozen ? 1 : 0), confirmedBy: [] });
        for (const task of core.tasks.filter((item) => item.requirementIds.includes(selected.id))) {
          for (const verification of core.verifications.filter((item) => item.taskId === task.id && item.status === "current")) core.update("verifications", verification.id, { status: "outdated" });
        }
        core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "需求基线变更申请", target: selected.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `v${selected.version} → v${selected.version + 1}；原内容：${selected.title} / ${selected.description}；变更为：${title.trim()} / ${description.trim()}；原因：${reason.trim()}` });
      }
      setFeedback(formalBaseline ? "变更已保存为待团队确认的新基线版本；相关验收结果已标记过期。" : "需求已保存。");
    } else {
      const id = `req-${Math.max(0, ...core.data.requirements.map((item) => Number(item.id.match(/\d+$/)?.[0]) || 0)) + 1}`;
      core.add("requirements", { id, projectId: core.project.id, title: title.trim(), description: description.trim(), priority, status: "draft", moduleId, version: 1, source: "手动创建" });
      if (formalBaseline) {
        core.update("projects", core.project.id, { setupStatus: "pending_confirmation", setupStep: 6, baselineVersion: core.project.baselineVersion + (frozen ? 1 : 0), confirmedBy: [] });
        core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "新增基线需求申请", target: id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `v1；${title.trim()} / ${description.trim()}；原因：${reason.trim()}` });
      }
      setSelectedId(id);
      setFeedback(formalBaseline ? "新需求已加入待团队确认的基线版本。" : "需求已添加到草案。");
    }
    setEditing(false);
  };

  const startCreate = () => {
    setSelectedId("");
    setTitle("");
    setDescription("");
    setPriority("medium");
    setModuleId(defaultModuleId);
    setReason("");
    setEditing(true);
  };

  const requirements = core.requirements.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const connectedTasks = selected ? core.tasks.filter((task) => task.requirementIds.includes(selected.id)) : [];
  const connectedCriteria = core.criteria.filter((criterion) => connectedTasks.some((task) => task.id === criterion.taskId));
  const connectedEvidence = core.evidence.filter((item) => item.criterionIds.some((id) => connectedCriteria.some((criterion) => criterion.id === id)));

  return <div className={s.page}>
    <Header eyebrow={core.project.name} title="需求基线" subtitle="以规格文档方式管理需求，并保留需求、任务、验收标准和证据之间的追溯关系。" actions={<><Status value={core.project.setupStatus} /><span className={s.badge}>v{Math.max(1, core.project.baselineVersion)}</span>{core.canEdit && <button className={s.button} type="button" onClick={startCreate}><Plus size={14} />新增需求</button>}</>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    {core.project.setupStatus === "pending_confirmation" && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={15} />需求变更已形成待确认版本。团队完成确认前，相关验收结果不能作为当前正式结论。<Link className={s.link} href={`${projectPath(core.project.id)}/setup`}>前往确认</Link></div>}
    <div className={s.grid}>
      <Panel title="需求管理">
        <Tabs value={tab} onChange={setTab} items={[{ value: "list", label: "需求列表" }, { value: "versions", label: "版本历史" }, { value: "baseline", label: "基线说明" }, { value: "files", label: "相关文档" }]} />
        {tab === "list" && <><div className={s.toolbar}><input className={s.field} style={{ maxWidth: 320 }} aria-label="搜索需求" placeholder="搜索需求名称或描述" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className={s.tableWrap}><table className={s.table}><thead><tr><th>编号</th><th>需求名称</th><th>优先级</th><th>状态</th><th>所属模块</th><th>操作</th></tr></thead><tbody>{requirements.map((item) => <tr key={item.id}><td>{requirementCode(item)}</td><td><strong>{item.title}</strong><span className={s.cellSub}>{item.description}</span></td><td>{priorityLabel(item.priority)}</td><td><Status value={item.status} /></td><td>{core.modules.find((module) => module.id === item.moduleId)?.name ?? "—"}</td><td><button className={s.buttonSoft} type="button" onClick={() => { setSelectedId(item.id); setEditing(false); }}>查看证据链</button></td></tr>)}</tbody></table></div>{!requirements.length && <Empty>没有匹配的需求</Empty>}</>}
        {tab === "versions" && <div className={s.list}><div className={s.listRow}><div><strong>需求基线 v{Math.max(1, core.project.baselineVersion)}</strong><div className={s.muted}>当前版本 · {core.project.setupStatus === "frozen" ? "已冻结" : "待团队确认"}</div></div><Status value={core.project.setupStatus} /></div>{core.requirements.map((item) => <div className={s.listRow} key={item.id}><span>{requirementCode(item)} · {item.title}</span><span className={s.muted}>v{item.version}</span></div>)}{core.data.logs.filter((item) => core.requirements.some((requirement) => requirement.id === item.target) && item.action.includes("需求")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.action}</strong><div className={s.muted}>{item.detail}</div></div><span className={s.muted}>{item.createdAt.slice(0, 10)}</span></div>)}</div>}
        {tab === "baseline" && <div><p className={s.small}>基线明确项目范围与官方要求。每条需求连接功能模块、任务、验收标准和证据，形成可审计的完整链路。</p><div className={s.notice}><Info size={15} />已冻结基线的正式修改会形成新版本，并触发受影响任务的重新确认和验收。</div></div>}
        {tab === "files" && <div className={s.list}>{core.data.files.filter((file) => file.projectId === core.project.id).map((file) => <div className={s.listRow} key={file.id}><strong>{file.name}</strong><span className={s.muted}>v{file.version} · {file.source}</span></div>)}</div>}
      </Panel>
      <div>
        {(selected || editing) && <Panel title={editing ? selected ? "编辑需求" : "新增需求" : selected?.title} action={selected && !editing && core.canEdit && <button className={s.buttonSoft} type="button" onClick={() => setEditing(true)}>编辑</button>}>
          {editing ? <div className={s.checks}><label><span className={s.fieldLabel}>需求名称</span><input className={s.field} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span className={s.fieldLabel}>描述</span><textarea className={s.textarea} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label><span className={s.fieldLabel}>优先级</span><select className={s.select} value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span className={s.fieldLabel}>所属模块</span><select className={s.select} value={moduleId} onChange={(event) => setModuleId(event.target.value)}>{core.modules.map((module) => <option value={module.id} key={module.id}>{module.name}</option>)}</select></label>{formalBaseline && <label><span className={s.fieldLabel}>变更原因 *</span><textarea className={s.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明变更内容及对任务、验收和里程碑的影响" /></label>}<div className={s.actions}><button className={s.buttonGhost} type="button" onClick={() => setEditing(false)}>取消</button><button className={s.button} type="button" onClick={save}><Save size={14} />{formalBaseline ? "提交变更" : "保存需求"}</button></div></div> : selected && <><div className={s.detailPair}><span>编号 / 版本</span><span>{requirementCode(selected)} / v{selected.version}</span></div><div className={s.detailPair}><span>优先级</span><span>{priorityLabel(selected.priority)}</span></div><div className={s.detailPair}><span>来源</span><span>{selected.source}</span></div><p className={s.small}>{selected.description}</p></>}
        </Panel>}
        {selected && !editing && <Panel title="追溯关系"><div className={s.listRow}><span>功能模块</span><strong>{core.modules.find((item) => item.id === selected.moduleId)?.name ?? "待关联"}</strong></div><div className={s.listRow}><span>关联任务</span><strong>{connectedTasks.length} 项</strong></div>{connectedTasks.slice(0, 3).map((task) => <div className={s.listRow} key={task.id}><TaskLink core={core} task={task} /><Status value={task.status} /></div>)}<div className={s.listRow}><span>验收标准</span><strong>{connectedCriteria.length} 条</strong></div><div className={s.listRow}><span>引用证据</span><strong>{connectedEvidence.length} 条</strong></div><div className={s.listRow}><span>当前验证</span><strong>{core.verifications.filter((item) => connectedTasks.some((task) => task.id === item.taskId) && item.status === "current").length} 次</strong></div></Panel>}
      </div>
    </div>
  </div>;
}

export function ProjectPlanning({ core }: { core: ProjectCore }) {
  const [selectedId, setSelectedId] = useState(core.tasks[0]?.id ?? "");
  const selected = core.tasks.find((task) => task.id === selectedId);
  const selectedTitle = selected ? taskTitle(selected) : "";
  const [title, setTitle] = useState(selectedTitle);
  const [description, setDescription] = useState(selected?.description ?? "");
  const [responsibleIds, setResponsibleIds] = useState<string[]>(selected?.responsibleIds ?? []);
  const [priority, setPriority] = useState<Priority>(selected?.priority ?? "medium");
  const [weight, setWeight] = useState(selected?.weight ?? 10);
  const [assignmentConfirmed, setAssignmentConfirmed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [editingUnlocked, setEditingUnlocked] = useState(!core.project.planConfirmed);
  const canPlan = core.canEdit && core.project.setupStatus === "frozen" && editingUnlocked;
  const rootTasks = core.tasks.filter((task) => !task.parentTaskId);
  const rootWeight = rootTasks.reduce((sum, task) => sum + task.weight, 0);
  const unassigned = core.tasks.filter((task) => !task.responsibleIds.length).length;
  const invalidChildren = core.tasks.filter((task) => core.tasks.some((child) => child.parentTaskId === task.id) && core.tasks.filter((child) => child.parentTaskId === task.id).reduce((sum, child) => sum + child.weight, 0) !== task.weight);

  useEffect(() => {
    if (newTask) return;
    setTitle(selectedTitle);
    setDescription(selected?.description ?? "");
    setResponsibleIds(selected?.responsibleIds ?? []);
    setPriority(selected?.priority ?? "medium");
    setWeight(selected?.weight ?? 10);
  }, [newTask, selectedId, selected?.version, selectedTitle, selected?.description, selected?.responsibleIds, selected?.priority, selected?.weight]);

  const save = () => {
    if (!canPlan) return;
    if (!title.trim()) return setFeedback("请填写任务名称。");
    if (weight < 0 || weight > 100) return setFeedback("任务权重需在 0–100% 之间。");
    if (newTask) {
      const id = makeId("task");
      const criterionId = makeId("criterion");
      const nextCode = `T-${String(Math.max(0, ...core.tasks.map((item) => Number(taskCode(item).slice(2)) || 0)) + 1).padStart(2, "0")}`;
      core.add("tasks", { id, projectId: core.project.id, moduleId: core.modules[0]?.id ?? "", requirementIds: core.requirements[0] ? [core.requirements[0].id] : [], title: `${nextCode} ${title.trim()}`, description: description.trim(), responsibleIds, priority, weight, status: "not_started", progress: 0, milestoneIds: core.milestones[0] ? [core.milestones[0].id] : [], criterionIds: [criterionId], dependencyIds: [], version: 1, updatedAt: new Date().toISOString() });
      core.add("criteria", { id: criterionId, taskId: id, text: `${title.trim()} 的交付结果可被验证`, version: 1, humanConfirmedBy: [] });
      setSelectedId(id);
      setNewTask(false);
    } else if (selected) {
      core.update("tasks", selected.id, { title: `${taskCode(selected)} ${title.trim()}`, description: description.trim(), responsibleIds, priority, weight, version: selected.version + 1, updatedAt: new Date().toISOString() });
      for (const verification of core.verifications.filter((item) => item.taskId === selected.id && item.status === "current")) core.update("verifications", verification.id, { status: "outdated" });
    }
    core.update("projects", core.project.id, { planVersion: core.project.planVersion + 1, planConfirmed: false });
    setAssignmentConfirmed(false);
    setFeedback("任务草案已更新。请重新确认责任分配与整体计划。");
  };

  const confirmPlan = () => {
    if (!assignmentConfirmed) return setFeedback("请先确认自己的任务分配。");
    if (rootWeight !== 100 || invalidChildren.length) return setFeedback("请将顶层权重及各父任务的子任务权重调整一致后再确认。");
    if (unassigned) return setFeedback("仍有未分配任务，请完成负责人分配。");
    core.update("projects", core.project.id, { planConfirmed: true });
    setFeedback("任务计划已确认，可以进入执行视图。");
    setEditingUnlocked(false);
  };

  const unlock = () => {
    if (core.role !== "leader" || !core.canEdit) return;
    core.update("projects", core.project.id, { planConfirmed: false, planVersion: core.project.planVersion + 1 });
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "解锁任务规划", target: core.project.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `任务规划 v${core.project.planVersion} 进入重新确认` });
    setEditingUnlocked(true);
    setAssignmentConfirmed(false);
    setFeedback("任务草案已解锁。正式修改后需要重新确认责任分配与整体计划。");
  };

  const regenerateSuggestions = () => {
    const missing = core.requirements.filter((requirement) => !core.tasks.some((task) => task.requirementIds.includes(requirement.id)));
    if (!missing.length) return setFeedback("当前需求均已有对应任务，暂无新增建议。");
    const highestCode = Math.max(0, ...core.tasks.map((item) => Number(taskCode(item).slice(2)) || 0));
    for (const [index, requirement] of missing.entries()) {
      const id = makeId("task");
      const criterionId = makeId("criterion");
      core.add("tasks", { id, projectId: core.project.id, moduleId: requirement.moduleId, requirementIds: [requirement.id], title: `T-${String(highestCode + index + 1).padStart(2, "0")} ${requirement.title}`, description: requirement.description, responsibleIds: [], priority: requirement.priority, weight: 0, status: "not_started", progress: 0, milestoneIds: [], criterionIds: [criterionId], dependencyIds: [], version: 1, updatedAt: new Date().toISOString() });
      core.add("criteria", { id: criterionId, taskId: id, text: `${requirement.title} 的实现结果符合项目需求`, version: 1, humanConfirmedBy: [] });
    }
    core.update("projects", core.project.id, { planVersion: core.project.planVersion + 1, planConfirmed: false });
    setAssignmentConfirmed(false);
    setFeedback(`已为 ${missing.length} 条未拆解需求生成任务建议。请分配负责人和权重。`);
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={projectPath(core.project.id)}>返回项目</Link>} title="任务规划" subtitle="共享任务草稿先由团队编辑，再确认责任分配与整体计划。" actions={<><span className={s.badge}>v{core.project.planVersion} · {core.project.planConfirmed ? "已确认" : "草稿"}</span>{core.project.planConfirmed && core.role === "leader" && <button className={s.buttonGhost} type="button" onClick={unlock}>解锁修改</button>}<button className={s.buttonSoft} type="button" disabled={!canPlan} onClick={regenerateSuggestions}><RefreshCcw size={14} />重新生成建议</button></>} />
    {core.project.setupStatus !== "frozen" && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={15} />请先完成需求基线的团队确认，才能修改或确认正式任务计划。<Link href={`${projectPath(core.project.id)}/setup`} className={s.link}>前往初始化</Link></div>}
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.stats}><div className={s.stat}><div className={s.statLabel}>任务</div><div className={s.statValue}>{rootTasks.length}</div><div className={s.statNote}>顶层任务</div></div><div className={s.stat}><div className={s.statLabel}>子任务</div><div className={s.statValue}>{core.tasks.length - rootTasks.length}</div><div className={s.statNote}>递归层级结构</div></div><div className={s.stat}><div className={s.statLabel}>待分配</div><div className={`${s.statValue} ${unassigned ? s.orange : s.green}`}>{unassigned}</div><div className={s.statNote}>需要成员自领或组长分配</div></div><div className={s.stat}><div className={s.statLabel}>顶层权重合计</div><div className={`${s.statValue} ${rootWeight === 100 ? s.green : s.red}`}>{rootWeight}%</div><div className={s.statNote}>确认前应为 100%</div></div></div>
    <div className={s.grid}>
      <Panel title="共享任务草稿" action={canPlan && <button className={s.buttonSoft} type="button" onClick={() => { setNewTask(true); setSelectedId(""); setTitle(""); setDescription(""); setResponsibleIds([]); setPriority("medium"); setWeight(0); }}><Plus size={14} />新建任务</button>}>
        <div className={s.tableWrap}><table className={s.table}><thead><tr><th>任务</th><th>负责人</th><th>优先级</th><th>权重</th><th>状态</th></tr></thead><tbody>{core.tasks.map((task) => <tr key={task.id}><td style={{ paddingLeft: task.parentTaskId ? 30 : 13 }}><button type="button" className={s.link} style={{ border: 0, background: "none", padding: 0, textAlign: "left" }} onClick={() => { setSelectedId(task.id); setNewTask(false); }}>{taskCode(task)} · {taskTitle(task)}</button></td><td>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</td><td>{priorityLabel(task.priority)}</td><td>{task.weight}%</td><td><Status value={task.status} /></td></tr>)}</tbody></table></div>
      </Panel>
      <div>
        {(selected || newTask) && <Panel title={newTask ? "新建任务" : "任务草案"} action={selected && <Link className={s.link} href={taskPath(core.project.id, selected.id)}>任务详情 <ArrowRight size={13} /></Link>}><div className={s.checks}><label><span className={s.fieldLabel}>任务名称</span><input className={s.field} value={title} disabled={!canPlan} onChange={(event) => setTitle(event.target.value)} /></label><label><span className={s.fieldLabel}>任务描述</span><textarea className={s.textarea} value={description} disabled={!canPlan} onChange={(event) => setDescription(event.target.value)} /></label><label><span className={s.fieldLabel}>负责人（可多选）</span><select className={s.select} multiple size={Math.min(5, Math.max(2, core.project.memberIds.length))} value={responsibleIds} disabled={!canPlan} onChange={(event) => setResponsibleIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{core.project.memberIds.map((id) => <option value={id} key={id}>{personName(core, id)}</option>)}</select></label><div className={s.formGrid}><label><span className={s.fieldLabel}>优先级</span><select className={s.select} value={priority} disabled={!canPlan} onChange={(event) => setPriority(event.target.value as Priority)}>{priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span className={s.fieldLabel}>权重 %</span><input className={s.field} type="number" min="0" max="100" value={weight} disabled={!canPlan} onChange={(event) => setWeight(Number(event.target.value))} /></label></div><button className={s.button} type="button" disabled={!canPlan} onClick={save}><Save size={14} />保存任务</button></div></Panel>}
        <Panel title="确认进度"><div className={s.detailPair}><span>个人责任确认</span><span>{assignmentConfirmed ? "已确认" : "待确认"}</span></div><div className={s.detailPair}><span>整体计划确认</span><span>{core.project.planConfirmed ? "已确认" : "待确认"}</span></div>{invalidChildren.length > 0 && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={14} />{invalidChildren.length} 个父任务的子任务权重合计不等于父任务权重。</div>}<div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 15 }}><button type="button" className={s.buttonGhost} disabled={!canPlan || assignmentConfirmed} onClick={() => setAssignmentConfirmed(true)}><Check size={14} />确认我的分配</button><button type="button" className={s.button} disabled={!canPlan || core.project.planConfirmed} onClick={confirmPlan}><Check size={14} />确认整体计划</button></div>{core.project.planConfirmed && <Link className={s.link} href={`${projectPath(core.project.id)}/tasks?view=tree`} style={{ display: "inline-block", marginTop: 14 }}>进入任务树 <ArrowRight size={13} /></Link>}</Panel>
      </div>
    </div>
  </div>;
}
