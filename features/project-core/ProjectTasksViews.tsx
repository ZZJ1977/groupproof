"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronRight, Info, Plus, Search, Send } from "lucide-react";
import type { Task } from "@/types/domain";
import type { ProjectCore } from "./core-model";
import { displayDate, latestVerification, makeId, personName, priorityLabel, projectPath, recordTaskProgress, sourceLabel, taskCode, taskPath, taskStatuses, taskTitle } from "./core-model";
import { Empty, Header, Panel, Progress, Status, Tabs, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";

type TaskView = "tree" | "board" | "list";

function TaskAction({ core, task }: { core: ProjectCore; task: Task }) {
  if (!core.canEdit || core.project.setupStatus !== "frozen" || !core.project.planConfirmed) return null;
  if (core.role !== "leader" && !task.responsibleIds.includes(core.data.currentUserId)) return null;
  if (task.status === "not_started") return <button className={s.buttonSoft} type="button" onClick={() => core.update("tasks", task.id, { status: "in_progress", updatedAt: new Date().toISOString() })}>开始任务</button>;
  if (task.status === "in_progress") return <button className={s.buttonSoft} type="button" onClick={() => core.update("tasks", task.id, { status: "pending_submission", updatedAt: new Date().toISOString() })}>准备提交</button>;
  if (task.status === "pending_submission") return <Link className={s.buttonSoft} href={`${taskPath(core.project.id, task.id)}/submit`}>提交证据</Link>;
  if (task.status === "pending_verification") return <Link className={s.buttonSoft} href={`${taskPath(core.project.id, task.id)}/verification`}>查看验收</Link>;
  return null;
}

export function ProjectTasks({ core, view }: { core: ProjectCore; view: TaskView }) {
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("all");
  const [owner, setOwner] = useState("all");
  const [sort, setSort] = useState("updated");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const tasks = core.tasks.filter((task) => {
    const matchedQuery = `${task.title} ${task.description} ${taskCode(task)}`.toLowerCase().includes(query.toLowerCase());
    return matchedQuery && (priority === "all" || task.priority === priority) && (owner === "all" || task.responsibleIds.includes(owner));
  }).sort((a, b) => sort === "weight" ? b.weight - a.weight : sort === "priority" ? ({ high: 3, medium: 2, low: 1 }[b.priority] - { high: 3, medium: 2, low: 1 }[a.priority]) : b.updatedAt.localeCompare(a.updatedAt));
  const roots = tasks.filter((task) => !task.parentTaskId || !tasks.some((other) => other.id === task.parentTaskId));

  const renderTree = (task: Task, depth: number, visited: Set<string>): React.ReactNode => {
    if (visited.has(task.id)) return null;
    const nextVisited = new Set(visited).add(task.id);
    const children = tasks.filter((item) => item.parentTaskId === task.id);
    return <div key={task.id}>
      <div className={s.listRow} style={{ paddingLeft: depth * 23, display: "grid", gridTemplateColumns: "minmax(220px, 2fr) minmax(100px, 1fr) 70px 70px 95px minmax(100px, 1fr)", gap: 10 }}>
        <div className={s.space} style={{ justifyContent: "flex-start" }}>{children.length ? <button className={s.iconButton} style={{ width: 24, height: 24 }} type="button" aria-label={collapsed.includes(task.id) ? "展开子任务" : "收起子任务"} onClick={() => setCollapsed((old) => old.includes(task.id) ? old.filter((id) => id !== task.id) : [...old, task.id])}>{collapsed.includes(task.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span style={{ width: 24 }} />}<TaskLink core={core} task={task} /></div>
        <span>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</span><span>{priorityLabel(task.priority)}</span><span>{task.weight}%</span><Status value={task.status} /><div><Progress value={task.progress} /><span className={s.cellSub}>{task.progress}%</span></div>
      </div>
      {!collapsed.includes(task.id) && children.map((child) => renderTree(child, depth + 1, nextVisited))}
    </div>;
  };

  return <div className={s.page}>
    <Header eyebrow={core.project.name} title={view === "tree" ? "任务树" : view === "board" ? "任务看板" : "任务列表"} subtitle={view === "tree" ? "用层级结构查看任务、负责人、权重与进度。" : view === "board" ? "按执行阶段组织任务，聚焦当前推进。" : "快速筛选、排序与复核全部任务。"} actions={<Link className={s.buttonSoft} href={`${projectPath(core.project.id)}/planning`}><Plus size={14} />任务规划</Link>} />
    <div className={s.toolbar}>
      <div className={s.tabs} style={{ marginBottom: 0, marginRight: "auto" }}>{([{ value: "tree", label: "任务树" }, { value: "board", label: "看板" }, { value: "list", label: "列表" }] as const).map((item) => <Link key={item.value} className={`${s.tab} ${view === item.value ? s.tabActive : ""}`} href={`${projectPath(core.project.id)}/tasks?view=${item.value}`}>{item.label}</Link>)}</div>
      <label style={{ position: "relative", minWidth: 220 }}><Search size={14} style={{ position: "absolute", top: 10, left: 10, color: "#8b9aaf" }} /><input className={s.field} style={{ paddingLeft: 31 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称、编号或负责人" aria-label="搜索任务" /></label>
      <select className={s.select} style={{ width: 120 }} value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="筛选优先级"><option value="all">全部优先级</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select>
      <select className={s.select} style={{ width: 120 }} value={owner} onChange={(event) => setOwner(event.target.value)} aria-label="筛选负责人"><option value="all">全部负责人</option>{core.project.memberIds.map((id) => <option value={id} key={id}>{personName(core, id)}</option>)}</select>
      {view === "list" && <select className={s.select} style={{ width: 110 }} value={sort} onChange={(event) => setSort(event.target.value)} aria-label="任务排序"><option value="updated">最近更新</option><option value="weight">权重</option><option value="priority">优先级</option></select>}
    </div>
    {view === "tree" && <Panel><div className={s.tableWrap}><div style={{ minWidth: 780 }}><div className={s.listRow} style={{ display: "grid", gridTemplateColumns: "minmax(220px, 2fr) minmax(100px, 1fr) 70px 70px 95px minmax(100px, 1fr)", gap: 10, background: "#f7f9fc", color: "#718096", fontSize: 12, padding: "10px 12px" }}><span>任务</span><span>负责人</span><span>优先级</span><span>权重</span><span>状态</span><span>进度</span></div>{roots.map((task) => renderTree(task, 0, new Set()))}</div></div>{!tasks.length && <Empty>没有匹配的任务</Empty>}</Panel>}
    {view === "board" && <div className={s.board}>{taskStatuses.map((status) => <section key={status.value} className={s.boardLane}><div className={s.boardHead}><span>{status.label}</span><span>{tasks.filter((task) => task.status === status.value).length}</span></div>{tasks.filter((task) => task.status === status.value).map((task) => <div className={s.boardCard} key={task.id}><span className={s.muted}>{taskCode(task)}</span><Link className={s.boardCardTitle} href={taskPath(core.project.id, task.id)}>{taskTitle(task)}</Link><div className={s.space}><span className={s.muted}>{personName(core, task.responsibleIds[0] ?? "")}</span><span className={`${s.badge} ${task.priority === "high" ? s.badgeRed : task.priority === "medium" ? s.badgeOrange : ""}`}>{priorityLabel(task.priority)}</span></div><div className={s.mt}><Progress value={task.progress} /><div className={s.space} style={{ marginTop: 7 }}><span className={s.muted}>权重 {task.weight}%</span><span className={s.muted}>{task.progress}%</span></div></div><div style={{ marginTop: 11 }}><TaskAction core={core} task={task} /></div></div>)}</section>)}</div>}
    {view === "list" && <Panel><div className={s.tableWrap}><table className={s.table}><thead><tr><th>编号</th><th>任务名称</th><th>负责人</th><th>所属模块</th><th>优先级</th><th>权重</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td>{taskCode(task)}</td><td><TaskLink core={core} task={task} /></td><td>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</td><td>{core.modules.find((module) => module.id === task.moduleId)?.name ?? "—"}</td><td>{priorityLabel(task.priority)}</td><td>{task.weight}%</td><td><Status value={task.status} /></td><td style={{ minWidth: 95 }}><Progress value={task.progress} /><span className={s.cellSub}>{task.progress}%</span></td><td><TaskAction core={core} task={task} /></td></tr>)}</tbody></table></div>{!tasks.length && <Empty>没有匹配的任务</Empty>}</Panel>}
  </div>;
}

export function ProjectTaskDetail({ core, task }: { core: ProjectCore; task: Task }) {
  const [tab, setTab] = useState("overview");
  const [progress, setProgress] = useState(task.progress);
  const [progressReason, setProgressReason] = useState("");
  const [reply, setReply] = useState("");
  const [feedback, setFeedback] = useState("");
  const taskCriteria = core.criteria.filter((criterion) => criterion.taskId === task.id);
  const taskEvidence = core.evidence.filter((item) => item.taskId === task.id);
  const verification = latestVerification(core, task.id);
  const discussions = core.data.discussions.filter((item) => item.taskId === task.id);
  const discussion = discussions[0];
  const history = core.data.logs.filter((item) => item.target === task.id || item.target.includes(task.title)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const linkedRequirements = core.requirements.filter((item) => task.requirementIds.includes(item.id));
  const linkedMilestones = core.milestones.filter((item) => task.milestoneIds.includes(item.id));

  const saveProgress = () => {
    if (!progressReason.trim()) return setFeedback("人工修正进度需要填写原因。");
    if (progress < 0 || progress > 100) return setFeedback("进度需在 0–100% 之间。");
    if (!core.canEdit || (core.role !== "leader" && !task.responsibleIds.includes(core.data.currentUserId))) return setFeedback("只有任务负责人或组长可以修正进度。");
    if (task.status === "completed") return setFeedback("已完成任务需要先重新开启后才能修改进度。");
    recordTaskProgress(core, task, progress);
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "人工修正任务进度", target: task.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `${task.progress}% → ${progress}%；原因：${progressReason.trim()}` });
    setProgressReason("");
    setFeedback(progress === 100 ? "进度已保存。100% 进度仍需正式提交任务并完成验收。" : "进度已保存。");
  };

  const sendReply = () => {
    if (!reply.trim()) return;
    const at = new Date().toISOString();
    if (discussion) core.update("discussions", discussion.id, { replies: [...discussion.replies, { id: makeId("reply"), authorId: core.data.currentUserId, text: reply.trim(), at }], updatedAt: at });
    else core.add("discussions", { id: makeId("discussion"), projectId: core.project.id, title: `${taskCode(task)} 任务讨论`, body: task.description, authorId: core.data.currentUserId, taskId: task.id, replies: [{ id: makeId("reply"), authorId: core.data.currentUserId, text: reply.trim(), at }], updatedAt: at });
    setReply("");
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={`${projectPath(core.project.id)}/tasks?view=list`}>返回任务列表</Link>} title={`${taskCode(task)} · ${taskTitle(task)}`} subtitle={task.description} actions={<><Status value={task.status} /><TaskAction core={core} task={task} /></>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.grid}>
      <div>
        <Panel>
          <Tabs value={tab} onChange={setTab} items={[{ value: "overview", label: "概览" }, { value: "evidence", label: `证据 ${taskEvidence.length}` }, { value: "verification", label: "验收" }, { value: "discussion", label: "讨论" }, { value: "history", label: "历史" }]} />
          {tab === "overview" && <><h3 className={s.panelTitle}>任务说明</h3><p className={s.small}>{task.description}</p><div className={s.divider} /><div className={s.space}><h3 className={s.panelTitle}>验收标准</h3><Link className={s.link} href={`${taskPath(core.project.id, task.id)}/verification`}>查看验收 <ArrowRight size={13} /></Link></div>{taskCriteria.length ? taskCriteria.map((criterion, index) => <div className={s.criteriaRow} key={criterion.id}><span className={s.criteriaCode}>AC-{index + 1}</span><div style={{ flex: 1 }}>{criterion.text}</div><Status value={criterion.result ?? "pending_confirmation"} /></div>) : <Empty>暂无验收标准</Empty>}<div className={s.divider} /><div className={s.space}><h3 className={s.panelTitle}>关联开发记录</h3><Link className={s.link} href={`${projectPath(core.project.id)}/github`}>查看更多 <ArrowRight size={13} /></Link></div>{core.data.github.filter((item) => item.taskId === task.id).map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{displayDate(item.timestamp)} · {item.type.toUpperCase()}</div></div><span className={s.badge}>{item.status}</span></div>)}</>}
          {tab === "evidence" && <><div className={s.space}><span className={s.muted}>证据关联到本任务及验收标准。</span><Link className={s.buttonSoft} href={`${taskPath(core.project.id, task.id)}/submit`}><Plus size={14} />添加证据</Link></div>{taskEvidence.length ? <div className={s.list}>{taskEvidence.map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{sourceLabel(item.source)} · {personName(core, item.authorId)} · {displayDate(item.createdAt)}</div></div><Status value={item.status} /></div>)}</div> : <Empty>尚未关联证据</Empty>}</>}
          {tab === "verification" && <>{verification ? <><div className={s.space}><div><strong>最新逐项验收结果</strong><div className={s.muted}>{displayDate(verification.createdAt)} · 置信度 {Math.round(verification.confidence * 100)}%</div></div><Status value={verification.result} /></div><div className={s.divider} />{verification.criterionResults.map((result, index) => <div className={s.criteriaRow} key={result.criterionId}><span className={s.criteriaCode}>AC-{index + 1}</span><div style={{ flex: 1 }}><strong>{taskCriteria.find((item) => item.id === result.criterionId)?.text}</strong><div className={s.muted}>{result.reason}</div></div><Status value={result.result} /></div>)}</> : <Empty>任务提交后可运行逐项验收</Empty>}<Link className={s.buttonSoft} href={`${taskPath(core.project.id, task.id)}/verification`} style={{ marginTop: 14 }}>打开 AI 验收 <ArrowRight size={13} /></Link></>}
          {tab === "discussion" && <>{discussions.length ? discussions.map((item) => <div key={item.id}><strong>{item.title}</strong><p className={s.small}>{item.body}</p>{item.replies.map((entry) => <div className={s.listRow} key={entry.id}><div><strong>{personName(core, entry.authorId)}</strong><div className={s.small}>{entry.text}</div></div><span className={s.muted}>{displayDate(entry.at)}</span></div>)}</div>) : <Empty>还没有任务讨论</Empty>}{core.canEdit && <div className={s.mt}><label className={s.fieldLabel}>回复讨论</label><textarea className={s.textarea} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="记录讨论结论或需要确认的问题" /><button className={s.button} type="button" onClick={sendReply} disabled={!reply.trim()}><Send size={14} />发送回复</button></div>}</>}
          {tab === "history" && (history.length ? history.map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.action}</strong><div className={s.muted}>{item.detail}</div></div><span className={s.muted}>{displayDate(item.createdAt)}</span></div>) : <Empty>此任务暂无审计记录</Empty>)}
        </Panel>
      </div>
      <div className={s.detailAside}>
        <Panel title="任务信息"><div className={s.detailPair}><span>任务编号</span><span>{taskCode(task)}</span></div><div className={s.detailPair}><span>负责人</span><span>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</span></div><div className={s.detailPair}><span>优先级</span><span>{priorityLabel(task.priority)}</span></div><div className={s.detailPair}><span>权重</span><span>{task.weight}%</span></div><div className={s.detailPair}><span>状态</span><span><Status value={task.status} /></span></div><div className={s.detailPair}><span>所属模块</span><span>{core.modules.find((item) => item.id === task.moduleId)?.name ?? "—"}</span></div><div className={s.detailPair}><span>关联需求</span><span>{linkedRequirements.map((item) => item.title).join("、") || "—"}</span></div><div className={s.detailPair}><span>里程碑</span><span>{linkedMilestones.map((item) => item.title).join("、") || "—"}</span></div><div className={s.detailPair}><span>依赖任务</span><span>{task.dependencyIds.map((id) => taskCode(core.tasks.find((item) => item.id === id) ?? task)).join("、") || "无"}</span></div></Panel>
        <Panel title="任务进度"><div className={s.space}><strong className={s.blue}>{task.progress}%</strong><span className={s.muted}>人工修正需说明原因</span></div><Progress value={task.progress} />{core.canEdit && (core.role === "leader" || task.responsibleIds.includes(core.data.currentUserId)) && <div className={s.mt}><label className={s.fieldLabel}>进度 %</label><input className={s.field} type="number" min="0" max="100" value={progress} onChange={(event) => setProgress(Number(event.target.value))} /><label className={s.fieldLabel} style={{ marginTop: 9 }}>修正原因</label><input className={s.field} value={progressReason} onChange={(event) => setProgressReason(event.target.value)} placeholder="说明完成情况与估算差异" /><button className={s.buttonGhost} style={{ marginTop: 9 }} type="button" onClick={saveProgress}>保存进度</button></div>}</Panel>
      </div>
    </div>
  </div>;
}
