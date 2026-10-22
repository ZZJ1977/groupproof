"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Info, Plus, RefreshCcw, Save } from "lucide-react";
import type { Priority } from "@/types/domain";
import type { ProjectCore } from "./core-model";
import { personName, priorityLabel, projectPath, taskCode, taskPath, taskTitle } from "./core-model";
import { activeBaseline, activePlan, confirmationsComplete, confirmedUserIds, draftPlan } from "@/lib/versioning";
import { validatePlan } from "@/lib/commands/plan";
import { useCommands } from "@/lib/commands/use-commands";
import { SaveState } from "@/components/common";
import { Empty, Header, Panel, Status, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";

const priorityOptions: { value: Priority; label: string }[] = [{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }];

/**
 * 任务规划（阶段 08）：编辑目标是 PlanRevision.payload 草稿；
 * 确认进度来自版本记录；发布生成正式计划快照与 Task/标准投影。
 */
export function ProjectPlanning({ core }: { core: ProjectCore }) {
  const commands = useCommands();
  const { project } = core;
  const planRev = draftPlan(core.data, project.id) ?? activePlan(core.data, project.id);
  const baseline = activeBaseline(core.data, project.id);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [requirementIds, setRequirementIds] = useState<string[]>([]);
  const [milestoneIds, setMilestoneIds] = useState<string[]>([]);
  const [dependencyIds, setDependencyIds] = useState<string[]>([]);
  const [responsibleIds, setResponsibleIds] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority>("medium");
  const [weight, setWeight] = useState(10);
  const [criteriaText, setCriteriaText] = useState("");
  const [forceReason, setForceReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const busy = commands.pending !== null;

  const tasks = planRev ? planRev.payload.tasks : core.tasks;
  const criteria = planRev ? planRev.payload.criteria : core.criteria;
  const selected = tasks.find((item) => item.id === selectedId);
  const issues = planRev ? validatePlan(planRev.payload, baseline?.payload, project.memberIds) : [];
  const allConfirmed = planRev ? confirmationsComplete(planRev) : false;
  const confirmed = planRev ? confirmedUserIds(planRev) : [];

  const resetForm = () => {
    setSelectedId(""); setTitle(""); setDescription(""); setModuleId(core.modules[0]?.id ?? "");
    setRequirementIds([]); setMilestoneIds([]); setDependencyIds([]); setResponsibleIds([]);
    setPriority("medium"); setWeight(10); setCriteriaText("");
  };

  const startCreate = () => { resetForm(); setEditing(true); };

  const openTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    setSelectedId(taskId); setEditing(false);
    setTitle(taskTitle(task)); setDescription(task.description); setModuleId(task.moduleId);
    setRequirementIds([...task.requirementIds]); setMilestoneIds([...task.milestoneIds]); setDependencyIds([...task.dependencyIds]);
    setResponsibleIds([...task.responsibleIds]); setPriority(task.priority); setWeight(task.weight);
    setCriteriaText(criteria.filter((item) => item.taskId === task.id).map((item) => item.text).join("\n"));
  };

  const ensureDraft = async (): Promise<typeof planRev> => {
    if (planRev && planRev.status !== "published") return planRev;
    if (!baseline) { setFeedback("请先发布需求基线，再创建任务计划草稿。"); return undefined; }
    const outcome = await commands.createPlanDraft({ projectId: project.id, baselineRevisionId: baseline.id, expectedVersion: project.version });
    if (!outcome.ok) { setFeedback(outcome.error.message); return undefined; }
    setFeedback(`计划草稿 v${outcome.result.number} 已创建（基线 ${baseline.id}）。`);
    return outcome.result;
  };

  const saveTask = async () => {
    if (!core.canEdit) return setFeedback("只有项目成员可以编辑任务草稿。");
    if (!title.trim()) return setFeedback("请填写任务名称。");
    const draft = await ensureDraft();
    if (!draft) return;
    const existing = draft.payload.tasks.find((item) => item.id === selectedId);
    const taskId = existing?.id ?? `task-${Date.now().toString(36)}`;
    const lines = criteriaText.split("\n").map((item) => item.trim()).filter(Boolean);
    const keptCriteria = draft.payload.criteria.filter((item) => item.taskId !== taskId);
    const nextCriteria = lines.map((text, index) => ({
      id: existing ? `${taskId}-ac-${draft.contentVersion}-${index + 1}` : `${taskId}-ac-${index + 1}`,
      taskId,
      text,
      version: 1,
      humanConfirmedBy: [],
    }));
    const task = {
      id: taskId,
      projectId: project.id,
      moduleId,
      parentTaskId: existing?.parentTaskId,
      requirementIds,
      title: title.trim(),
      description: description.trim(),
      responsibleIds,
      priority,
      weight,
      status: existing?.status ?? "not_started" as const,
      progress: existing?.progress ?? 0,
      milestoneIds,
      criterionIds: nextCriteria.map((item) => item.id),
      dependencyIds,
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const nextTasks = existing ? draft.payload.tasks.map((item) => (item.id === taskId ? task : item)) : [...draft.payload.tasks, task];
    const milestoneLinks = draft.payload.milestoneLinks.filter((item) => item.taskId !== taskId).concat({ taskId, milestoneIds: [...milestoneIds] });
    const outcome = await commands.savePlanDraft({
      projectId: project.id,
      revisionId: draft.id,
      payload: { tasks: nextTasks, criteria: [...keptCriteria, ...nextCriteria], milestoneLinks },
      expectedVersion: project.version,
    });
    if (!outcome.ok) return setFeedback(outcome.error.message);
    setSelectedId(taskId); setEditing(false);
    setFeedback(`任务草稿已保存（内容 v${outcome.result.contentVersion}）；旧责任确认已失效。`);
  };

  const regenerateSuggestions = async () => {
    const draft = await ensureDraft();
    if (!draft) return;
    const linked = new Set(draft.payload.tasks.flatMap((item) => item.requirementIds));
    const missing = core.requirements.filter((item) => !linked.has(item.id));
    if (!missing.length) return setFeedback("当前需求均已有对应任务，暂无新增建议。");
    const additions = missing.map((requirement, index) => {
      const id = `task-sugg-${requirement.id}`;
      return {
        id,
        projectId: project.id,
        moduleId: requirement.moduleId,
        requirementIds: [requirement.id],
        title: `T-${String(tasks.length + index + 1).padStart(2, "0")} ${requirement.title}`,
        description: requirement.description,
        responsibleIds: [],
        priority: requirement.priority,
        weight: 0,
        status: "not_started" as const,
        progress: 0,
        milestoneIds: [],
        criterionIds: [`${id}-ac-1`],
        dependencyIds: [],
        version: 1,
        updatedAt: new Date().toISOString(),
      };
    });
    const outcome = await commands.savePlanDraft({
      projectId: project.id,
      revisionId: draft.id,
      payload: {
        tasks: [...draft.payload.tasks, ...additions],
        criteria: [...draft.payload.criteria, ...additions.map((item) => ({ id: item.criterionIds[0], taskId: item.id, text: `${item.title} 的实现结果符合项目需求`, version: 1, humanConfirmedBy: [] }))],
        milestoneLinks: [...draft.payload.milestoneLinks, ...additions.map((item) => ({ taskId: item.id, milestoneIds: [] }))],
      },
      expectedVersion: project.version,
    });
    if (!outcome.ok) return setFeedback(outcome.error.message);
    setFeedback(`已为 ${missing.length} 条未拆解需求生成任务建议（待人工编辑）。`);
  };

  const confirmSelf = async () => {
    if (!planRev || planRev.status === "published") return;
    const outcome = await commands.confirmAssignmentSelf({ projectId: project.id, revisionId: planRev.id, contentVersion: planRev.contentVersion, expectedVersion: project.version });
    setFeedback(outcome.ok ? "已记录你的任务分配确认。" : outcome.error.message);
  };

  const publish = async (override: boolean) => {
    if (!planRev || planRev.status === "published") return;
    const outcome = override
      ? await commands.forcePublishPlan({ projectId: project.id, revisionId: planRev.id, reason: forceReason.trim(), expectedVersion: project.version })
      : await commands.publishPlan({ projectId: project.id, revisionId: planRev.id, expectedVersion: project.version });
    if (!outcome.ok) return setFeedback(outcome.error.message);
    setForceReason("");
    setFeedback(override ? "例外发布完成；未确认成员已记入审计。" : "任务计划已发布；任务三视图将读取同一正式计划。");
  };

  const unlock = async () => {
    const outcome = await commands.unlockPlan({ projectId: project.id, expectedVersion: project.version });
    setFeedback(outcome.ok ? `已解锁规划并创建草稿 v${outcome.result.number}；旧历史保留。` : outcome.error.message);
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={projectPath(project.id)}>返回项目</Link>} title="任务规划" subtitle="共享任务草稿先由团队编辑，再确认责任分配与整体计划。" actions={<><span className={s.badge}>{planRev ? `修订 ${planRev.number} · ${planRev.status === "published" ? "已发布" : "草稿"}` : "未建立计划"}</span>{core.canLead && <button className={s.buttonGhost} type="button" disabled={busy} onClick={() => void unlock()}>解锁修改</button>}{core.canEdit && <button className={s.buttonSoft} type="button" disabled={busy} onClick={() => void regenerateSuggestions()}><RefreshCcw size={14} />重新生成建议</button>}</>} />
    {project.setupStatus !== "frozen" && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={15} />请先完成需求基线的团队确认，才能修改或确认正式任务计划。<Link href={`${projectPath(project.id)}/setup`} className={s.link}>前往初始化</Link></div>}
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    {issues.length > 0 && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={15} />计划校验发现 {issues.length} 个问题：{issues.slice(0, 3).map((item) => item.message).join("；")}{issues.length > 3 ? "…" : ""}</div>}
    <div className={s.stats}><div className={s.stat}><div className={s.statLabel}>任务</div><div className={s.statValue}>{tasks.filter((item) => !item.parentTaskId).length}</div><div className={s.statNote}>顶层任务</div></div><div className={s.stat}><div className={s.statLabel}>子任务</div><div className={s.statValue}>{tasks.length - tasks.filter((item) => !item.parentTaskId).length}</div><div className={s.statNote}>递归层级结构</div></div><div className={s.stat}><div className={s.statLabel}>待分配</div><div className={`${s.statValue} ${tasks.some((item) => !item.responsibleIds.length) ? s.orange : s.green}`}>{tasks.filter((item) => !item.responsibleIds.length).length}</div><div className={s.statNote}>需要成员自领或组长分配</div></div><div className={s.stat}><div className={s.statLabel}>顶层权重合计</div><div className={`${s.statValue} ${tasks.filter((item) => !item.parentTaskId).reduce((sum, item) => sum + item.weight, 0) === 100 ? s.green : s.red}`}>{tasks.filter((item) => !item.parentTaskId).reduce((sum, item) => sum + item.weight, 0)}%</div><div className={s.statNote}>发布前应为 100%</div></div></div>
    <div className={s.grid}>
      <Panel title="共享任务草稿" action={core.canEdit && <button className={s.buttonSoft} type="button" onClick={startCreate}><Plus size={14} />新建任务</button>}>
        <div className={s.tableWrap}><table className={s.table}><thead><tr><th>任务</th><th>负责人</th><th>优先级</th><th>权重</th><th>状态</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td style={{ paddingLeft: task.parentTaskId ? 30 : 13 }}><button type="button" className={s.link} style={{ border: 0, background: "none", padding: 0, textAlign: "left" }} onClick={() => openTask(task.id)}>{taskCode(task)} · {taskTitle(task)}</button></td><td>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</td><td>{priorityLabel(task.priority)}</td><td>{task.weight}%</td><td><Status value={task.status} /></td></tr>)}</tbody></table></div>
      </Panel>
      <div>
        {(selected || editing) && <Panel title={editing ? "编辑任务草稿" : "任务详情"} action={selected && !editing && core.canEdit && <button className={s.buttonSoft} type="button" onClick={() => { openTask(selected.id); setEditing(true); }}>编辑</button>}>
          <div className={s.checks}>
            <label><span className={s.fieldLabel}>任务名称</span><input className={s.field} value={title} disabled={!core.canEdit || !editing} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span className={s.fieldLabel}>任务描述</span><textarea className={s.textarea} value={description} disabled={!core.canEdit || !editing} onChange={(event) => setDescription(event.target.value)} /></label>
            <label><span className={s.fieldLabel}>所属模块</span><select className={s.select} value={moduleId} disabled={!core.canEdit || !editing} onChange={(event) => setModuleId(event.target.value)}><option value="">未关联</option>{core.modules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label><span className={s.fieldLabel}>关联需求（可多选）</span><select className={s.select} multiple size={3} value={requirementIds} disabled={!core.canEdit || !editing} onChange={(event) => setRequirementIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{core.requirements.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label><span className={s.fieldLabel}>负责人（可多选）</span><select className={s.select} multiple size={Math.min(5, Math.max(2, project.memberIds.length))} value={responsibleIds} disabled={!core.canEdit || !editing} onChange={(event) => setResponsibleIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{project.memberIds.map((id) => <option value={id} key={id}>{personName(core, id)}</option>)}</select></label>
            <label><span className={s.fieldLabel}>关联里程碑（可多选）</span><select className={s.select} multiple size={3} value={milestoneIds} disabled={!core.canEdit || !editing} onChange={(event) => setMilestoneIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{core.milestones.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label><span className={s.fieldLabel}>依赖任务（可多选）</span><select className={s.select} multiple size={3} value={dependencyIds} disabled={!core.canEdit || !editing} onChange={(event) => setDependencyIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{tasks.filter((item) => item.id !== selectedId).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <div className={s.formGrid}><label><span className={s.fieldLabel}>优先级</span><select className={s.select} value={priority} disabled={!core.canEdit || !editing} onChange={(event) => setPriority(event.target.value as Priority)}>{priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span className={s.fieldLabel}>权重 %</span><input className={s.field} type="number" min="0" max="100" value={weight} disabled={!core.canEdit || !editing} onChange={(event) => setWeight(Number(event.target.value))} /></label></div>
            <label><span className={s.fieldLabel}>验收标准（每行一条）</span><textarea className={s.textarea} value={criteriaText} disabled={!core.canEdit || !editing} onChange={(event) => setCriteriaText(event.target.value)} placeholder="交付结果可被验证&#10;操作记录可追溯" /></label>
            {core.canEdit && editing && <div className="flex items-center gap-3"><button className={s.button} type="button" disabled={busy} onClick={() => void saveTask()}><Save size={14} />保存任务草稿</button><SaveState state={commands.pending === "project.draft.edit" ? "saving" : "clean"} /></div>}
          </div>
        </Panel>}
        <Panel title="确认进度">
          <div className={s.detailPair}><span>计划修订</span><span>{planRev ? `修订 ${planRev.number} · 内容 v${planRev.contentVersion}` : "未建立快照"}</span></div>
          <div className={s.detailPair}><span>整体计划确认</span><span>{project.planConfirmed ? "已确认" : "待确认"}</span></div>
          <div className={s.detailPair}><span>责任确认</span><span>{planRev ? `${confirmed.length}/${planRev.memberRoster.length}` : "—"}</span></div>
          {planRev && <div className={s.mt}>{planRev.memberRoster.map((id) => { const record = planRev.confirmations.find((item) => item.userId === id && item.contentVersion === planRev.contentVersion); return <div className={s.listRow} key={id}><span>{personName(core, id)}</span><span className={s.muted}>{record ? `已确认 · ${new Date(record.confirmedAt).toLocaleString("zh-CN")}` : planRev.legacy?.confirmedUserIds.includes(id) ? "历史确认（未记录时间）" : "待确认"}</span></div>; })}</div>}
          <div className={s.mt}><span className={s.fieldLabel}>发布条件</span><div className={s.checks}>
            <span className={s.check}>{allConfirmed ? "已满足" : "未满足"}：全员责任确认</span>
            <span className={s.check}>{issues.length === 0 ? "已满足" : "未满足"}：结构校验无问题</span>
            <span className={s.check}>{baseline && planRev ? (planRev.baselineRevisionId === baseline.id ? "已满足" : "未满足") : "未满足"}：计划基于生效基线</span>
          </div></div>
          <div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 15 }}>
            {core.canEdit && <button className={s.buttonGhost} type="button" disabled={busy || !planRev || planRev.status === "published" || confirmed.includes(core.data.currentUserId)} onClick={() => void confirmSelf()}><Check size={14} />确认我的分配</button>}
            {core.canLead && <button className={s.button} type="button" disabled={!planRev || planRev.status !== "draft" && planRev.status !== "confirming" || !confirmationsComplete(planRev) || issues.length > 0 || busy} onClick={() => void publish(false)}><Check size={14} />发布整体计划</button>}
          </div>
          {core.canLead && planRev && planRev.status !== "published" && <div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 8 }}><input className={s.field} style={{ maxWidth: 320 }} aria-label="例外发布原因" placeholder="例外发布原因（含未确认成员）" value={forceReason} onChange={(event) => setForceReason(event.target.value)} /><button className={s.buttonGhost} type="button" disabled={busy || !forceReason.trim() || issues.length > 0} onClick={() => void publish(true)}>例外发布</button></div>}
          {project.planConfirmed && <Link className={s.link} href={`${projectPath(project.id)}/tasks?view=tree`} style={{ display: "inline-block", marginTop: 14 }}>进入任务树 <ArrowRight size={13} /></Link>}
        </Panel>
      </div>
    </div>
  </div>;
}
