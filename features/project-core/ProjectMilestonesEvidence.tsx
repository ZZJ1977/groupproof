"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarDays, Check, Info, Plus } from "lucide-react";
import type { Evidence, Milestone } from "@/types/domain";
import type { ProjectCore } from "./core-model";
import { displayDate, makeId, milestoneCode, personName, projectPath, sourceLabel, taskCode, taskPath } from "./core-model";
import { Empty, Header, Panel, Progress, Stat, Status, Tabs, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";

export function ProjectMilestones({ core }: { core: ProjectCore }) {
  const current = core.milestones.find((item) => item.status === "in_progress") ?? core.milestones[0];
  const atRisk = core.milestones.filter((item) => item.status === "at_risk");
  return <div className={s.page}>
    <Header eyebrow={core.project.name} title="里程碑" subtitle="查看项目阶段、关键节点与当前完成情况。" />
    <div className={s.timeline}>{core.milestones.map((item) => <Link key={item.id} href={`${projectPath(core.project.id)}/milestones/${item.id}`} className={s.timelineItem} style={{ textDecoration: "none", color: "inherit" }}><div className={s.space}><span className={s.muted}>{milestoneCode(item)}</span><Status value={item.status} /></div><div className={s.timelineName}>{item.title}</div><div className={s.timelineMeta}><CalendarDays size={12} style={{ verticalAlign: "middle" }} /> 截止 {displayDate(item.deadline)}</div><div style={{ marginTop: 13 }}><Progress value={item.progress} /></div></Link>)}</div>
    <div className={s.grid}>
      <Panel title="里程碑列表"><div className={s.tableWrap}><table className={s.table}><thead><tr><th>里程碑</th><th>目标日期</th><th>完成率</th><th>关键任务</th><th>状态</th><th>操作</th></tr></thead><tbody>{core.milestones.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><span className={s.cellSub}>{item.description}</span></td><td>{displayDate(item.deadline)}</td><td style={{ minWidth: 95 }}><Progress value={item.progress} /><span className={s.cellSub}>{item.progress}%</span></td><td>{item.taskIds.length} 项</td><td><Status value={item.status} /></td><td><Link className={s.link} href={`${projectPath(core.project.id)}/milestones/${item.id}`}>查看详情</Link></td></tr>)}</tbody></table></div></Panel>
      <div>
        {current && <Panel title="当前里程碑聚焦" action={<Link className={s.link} href={`${projectPath(core.project.id)}/milestones/${current.id}`}>查看详情 <ArrowRight size={13} /></Link>}><div className={s.space}><div><strong>{current.title}</strong><div className={s.muted}>截止 {displayDate(current.deadline)}</div></div><Status value={current.status} /></div><div className={s.mt}><Progress value={current.progress} /><span className={s.cellSub}>{current.progress}% · {current.taskIds.filter((id) => core.tasks.find((task) => task.id === id)?.status === "completed").length}/{current.taskIds.length} 项任务完成</span></div><div className={s.divider} />{current.taskIds.slice(0, 4).map((id) => { const task = core.tasks.find((item) => item.id === id); return task ? <div className={s.listRow} key={id}><TaskLink core={core} task={task} /><Status value={task.status} /></div> : null; })}</Panel>}
        <Panel title="风险与问题">{atRisk.length ? atRisk.map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>阶段进度 {item.progress}% · 截止 {displayDate(item.deadline)}</div></div><Status value={item.status} /></div>) : <Empty>当前无高风险里程碑</Empty>}</Panel>
      </div>
    </div>
  </div>;
}

export function ProjectMilestoneDetail({ core, milestone }: { core: ProjectCore; milestone: Milestone }) {
  const [deliverables, setDeliverables] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  const tasks = core.tasks.filter((task) => milestone.taskIds.includes(task.id));
  const completed = tasks.filter((task) => task.status === "completed").length;
  const relatedEvidence = core.evidence.filter((item) => tasks.some((task) => task.id === item.taskId));
  const allReady = tasks.length > 0 && completed === tasks.length && milestone.deliverables.every((item) => deliverables.includes(item));

  const complete = () => {
    if (!allReady || !core.canEdit || !core.canLead) return setFeedback("请先完成关联任务并由组长核对阶段交付物。");
    core.update("milestones", milestone.id, { status: "completed", progress: 100 });
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "确认里程碑交付", target: milestone.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: `确认 ${milestone.title} 的关联任务与独立交付物` });
    setFeedback("里程碑已确认完成，验收历史已保留。");
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={`${projectPath(core.project.id)}/milestones`}>返回里程碑</Link>} title="里程碑详情" subtitle="查看阶段目标、关联任务、交付物与当前风险。" actions={<Status value={milestone.status} />} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.grid}>
      <div><Panel title={milestone.title}><p className={s.small}>{milestone.description}</p><div className={s.detailPair}><span>阶段进度</span><span>{milestone.progress}%</span></div><Progress value={milestone.progress} /><div className={s.detailPair}><span>已完成任务</span><span>{completed}/{tasks.length}</span></div><div className={s.detailPair}><span>目标日期</span><span>{displayDate(milestone.deadline)}</span></div><div className={s.notice} style={{ marginTop: 14 }}><Info size={15} />任务全部完成后仍需核对阶段交付物，里程碑不会自动通过。</div></Panel><Panel title="关键任务" action={<Link className={s.link} href={`${projectPath(core.project.id)}/tasks?view=list`}>查看全部 <ArrowRight size={13} /></Link>}><div className={s.tableWrap}><table className={s.table}><thead><tr><th>任务</th><th>负责人</th><th>状态</th><th>进度</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><TaskLink core={core} task={task} /></td><td>{task.responsibleIds.map((id) => personName(core, id)).join("、") || "未分配"}</td><td><Status value={task.status} /></td><td style={{ minWidth: 110 }}><Progress value={task.progress} /><span className={s.cellSub}>{task.progress}%</span></td></tr>)}</tbody></table></div></Panel><Panel title="关联证据">{relatedEvidence.length ? relatedEvidence.slice(0, 5).map((item) => { const linkedTask = tasks.find((task) => task.id === item.taskId); return <div className={s.listRow} key={item.id}><div><strong>{item.title}</strong><div className={s.muted}>{sourceLabel(item.source)} · {linkedTask ? taskCode(linkedTask) : "任务"}</div></div><Status value={item.status} /></div>; }) : <Empty>暂无关联证据</Empty>}</Panel></div>
      <div><Panel title="里程碑信息"><div className={s.detailPair}><span>阶段编号</span><span>{milestoneCode(milestone)}</span></div><div className={s.detailPair}><span>目标日期</span><span>{displayDate(milestone.deadline)}</span></div><div className={s.detailPair}><span>当前状态</span><span><Status value={milestone.status} /></span></div><div className={s.detailPair}><span>关联模块</span><span>{Array.from(new Set(tasks.map((task) => core.modules.find((module) => module.id === task.moduleId)?.name ?? ""))).filter(Boolean).join("、") || "—"}</span></div></Panel><Panel title="阶段交付物"><div className={s.checks}>{milestone.deliverables.map((item) => <label className={s.check} key={item}><input type="checkbox" checked={deliverables.includes(item) || milestone.status === "completed"} disabled={!core.canEdit || !core.canLead || milestone.status === "completed"} onChange={(event) => setDeliverables((old) => event.target.checked ? [...old, item] : old.filter((entry) => entry !== item))} /><span>{item}</span></label>)}</div><button className={s.button} style={{ marginTop: 16 }} type="button" disabled={!core.canEdit || !core.canLead || milestone.status === "completed" || !allReady} onClick={complete}><Check size={14} />确认阶段交付</button></Panel><Panel title="风险提示">{milestone.status === "at_risk" || completed < tasks.length ? <div className={`${s.notice} ${s.noticeWarn}`}><Info size={15} />仍有 {tasks.length - completed} 项任务未完成，请检查证据与验收进度。</div> : <div className={s.notice}><Check size={15} />关联任务已完成，可核对阶段交付物。</div>}</Panel></div>
    </div>
  </div>;
}

export function ProjectEvidenceCenter({ core }: { core: ProjectCore }) {
  const [tab, setTab] = useState("task");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const evidence = core.evidence.filter((item) => `${item.title} ${item.description} ${personName(core, item.authorId)} ${core.tasks.find((task) => task.id === item.taskId)?.title ?? ""}`.toLowerCase().includes(query.toLowerCase()) && (source === "all" || item.source === source));
  const selected = core.evidence.find((item) => item.id === selectedId);
  const taskGroups = core.tasks.filter((task) => evidence.some((item) => item.taskId === task.id));
  const sourceGroups = Array.from(new Set(evidence.map((item) => item.source)));

  const withdraw = () => {
    if (!selected || !reason.trim() || !core.canEdit || (!core.canLead && selected.authorId !== core.data.currentUserId)) return setFeedback("证据作者或组长撤回正式证据时需要填写原因。");
    core.update("evidence", selected.id, { status: "withdrawn" });
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "撤回正式证据", target: selected.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: reason.trim() });
    setSelectedId(""); setReason(""); setFeedback("证据已撤回，原记录和理由保留；相关验收将标记过期。");
  };

  const confirmCandidate = (item: Evidence) => {
    core.update("evidence", item.id, { status: "formal" });
    setFeedback("证据已纳入正式证据链，相关验收需重新运行。");
  };

  const evidenceRows = (items: Evidence[]) => <div className={s.tableWrap}><table className={s.table}><thead><tr><th>证据名称</th><th>来源</th><th>提交人</th><th>时间</th><th>关联任务</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><span className={s.cellSub}>{item.description}</span></td><td>{sourceLabel(item.source)}</td><td>{personName(core, item.authorId)}</td><td>{displayDate(item.createdAt)}</td><td><Link className={s.link} href={taskPath(core.project.id, item.taskId)}>{core.tasks.find((task) => task.id === item.taskId)?.title ?? "任务"}</Link></td><td><Status value={item.status} /></td><td>{core.canEdit && (item.status === "candidate" || item.status === "pending_confirmation") && <button className={s.buttonSoft} type="button" onClick={() => confirmCandidate(item)}>确认采纳</button>}{core.canEdit && item.status === "formal" && (core.canLead || item.authorId === core.data.currentUserId) && <button className={s.buttonGhost} type="button" onClick={() => setSelectedId(item.id)}>撤回</button>}</td></tr>)}</tbody></table></div>;

  return <div className={s.page}>
    <Header eyebrow={core.project.name} title="证据中心" subtitle="按任务、时间线和来源组织证据，保留完整追溯关系。" actions={<Link className={s.buttonSoft} href={`${projectPath(core.project.id)}/tasks?view=list`}><Plus size={14} />选择任务添加证据</Link>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.grid}>
      <div><Panel><Tabs value={tab} onChange={setTab} items={[{ value: "task", label: "按任务" }, { value: "timeline", label: "时间线" }, { value: "source", label: "来源" }]} /><div className={s.toolbar}><input className={s.field} style={{ maxWidth: 320 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索证据名称、任务或提交人" aria-label="搜索证据" /><select className={s.select} style={{ width: 130 }} value={source} onChange={(event) => setSource(event.target.value)} aria-label="筛选来源"><option value="all">全部来源</option>{["github", "file", "screenshot", "feishu", "discussion", "manual"].map((item) => <option key={item} value={item}>{sourceLabel(item)}</option>)}</select></div>{!evidence.length && <Empty>没有匹配的证据</Empty>}{tab === "task" && taskGroups.map((task) => <div key={task.id} style={{ marginBottom: 18 }}><div className={s.space} style={{ marginBottom: 8 }}><TaskLink core={core} task={task} /><span className={s.muted}>{evidence.filter((item) => item.taskId === task.id).length} 条证据</span></div>{evidenceRows(evidence.filter((item) => item.taskId === task.id))}</div>)}{tab === "timeline" && evidenceRows([...evidence].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))}{tab === "source" && sourceGroups.map((kind) => <div key={kind} style={{ marginBottom: 18 }}><h3 className={s.panelTitle} style={{ marginBottom: 9 }}>{sourceLabel(kind)}</h3>{evidenceRows(evidence.filter((item) => item.source === kind))}</div>)}</Panel></div>
      <div><Panel title="证据原则"><div className={s.listRow}><div><strong>可验证来源</strong><div className={s.muted}>优先引用代码仓库、系统日志和原始文档。</div></div></div><div className={s.listRow}><div><strong>关联验收标准</strong><div className={s.muted}>每条证据应指向具体任务或验收标准。</div></div></div><div className={s.listRow}><div><strong>团队共同确认</strong><div className={s.muted}>低置信度或冲突证据先人工确认。</div></div></div></Panel><Panel title="来源说明"><div className={s.listRow}><span>GitHub PR / Commit</span><span className={s.muted}>原始代码活动</span></div><div className={s.listRow}><span>项目文件</span><span className={s.muted}>设计与测试资料</span></div><div className={s.listRow}><span>截图 / 飞书</span><span className={s.muted}>界面与协作记录</span></div></Panel>{selected && <Panel title="撤回正式证据"><p className={s.small}>{selected.title}</p><label className={s.fieldLabel}>撤回原因 *</label><textarea className={s.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为何这份证据不再代表当前有效结果" /><div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 10 }}><button type="button" className={s.buttonGhost} onClick={() => { setSelectedId(""); setReason(""); }}>取消</button><button type="button" className={s.buttonDanger} onClick={withdraw} disabled={!reason.trim()}>确认撤回</button></div></Panel>}</div>
    </div>
  </div>;
}
