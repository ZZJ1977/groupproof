"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarDays, Check, Info, Plus } from "lucide-react";
import type { Evidence, Milestone } from "@/types/domain";
import { evidenceSources, evidenceStatuses, filterEvidence, readEvidenceFilters, readEvidenceView, safeEvidenceSourceUrl } from "@/features/c/url-filters";
import { useUrlQuery } from "@/features/c/use-url-query";
import { canManageEvidence, decideEvidence, evidenceDecisionBlockReason, evidenceSourceChanged, type EvidenceDecisionAction, type EvidenceWithCDecisions } from "@/features/c/evidence-decisions";
import { apiMode } from "@/lib/api/config";
import { workspaceService } from "@/lib/api/workspace-service";
import { createCommandRunner } from "@/lib/commands/core";
import { scopedWorkspaceKey, useWorkspace } from "@/lib/workspace";
import type { ProjectCore } from "./core-model";
import { displayDate, makeId, milestoneCode, personName, projectPath, sourceLabel, statusLabel, taskCode, taskPath } from "./core-model";
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
  const queryClient = useQueryClient();
  const { userId } = useWorkspace();
  const workspaceKey = useMemo(() => scopedWorkspaceKey(userId), [userId]);
  const runner = useMemo(() => createCommandRunner({
    repository: {
      read: async () => queryClient.getQueryData<ProjectCore["data"]>(workspaceKey) ?? await workspaceService.getWorkspace(),
      save: workspaceService.saveWorkspace,
    },
    currentActorId: () => queryClient.getQueryData<ProjectCore["data"]>(workspaceKey)?.currentUserId ?? "",
    onSaved: (next) => queryClient.setQueryData(workspaceKey, next),
  }), [queryClient, workspaceKey]);
  const { query: urlQuery, updateQuery } = useUrlQuery();
  const tab = readEvidenceView(urlQuery);
  const filters = readEvidenceFilters(urlQuery);
  const setFilter = (key: keyof typeof filters, value: string) => updateQuery({ [key]: value === "all" && key !== "q" ? null : value });
  const [selection, setSelection] = useState<{ id: string; action: EvidenceDecisionAction; expectedVersion: number; idempotencyKey: string } | null>(null);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const localWorkspace = apiMode("workspace") === "mock";
  const taskById = new Map(core.tasks.map((task) => [task.id, task]));
  const evidence = filterEvidence(core.evidence, filters, {
    task: (id) => { const task = taskById.get(id); return task ? `${taskCode(task)} ${task.title}` : ""; },
    author: (id) => personName(core, id),
  });
  const authorIds = Array.from(new Set([...core.project.memberIds, ...core.evidence.map((item) => item.authorId)]));
  const selected = core.evidence.find((item) => item.id === selection?.id);
  const blocked = selected && selection ? evidenceDecisionBlockReason(core.data, core.data.currentUserId, selected, selection.action) : null;
  const taskGroups = core.tasks.filter((task) => evidence.some((item) => item.taskId === task.id));
  const sourceGroups = Array.from(new Set(evidence.map((item) => item.source)));

  const openDecision = (item: Evidence, action: EvidenceDecisionAction) => {
    if (busy.current || (selection?.id === item.id && selection.action === action)) return;
    if (reason.trim() && !window.confirm("放弃尚未保存的证据决策原因？")) return;
    setSelection({ id: item.id, action, expectedVersion: item.version, idempotencyKey: makeId("evidence-decision") });
    setReason(""); setFeedback("");
  };
  const saveDecision = async () => {
    if (!selected || !selection || !localWorkspace || busy.current) return;
    if (!reason.trim()) { setFeedback("请填写决策原因。"); return; }
    busy.current = true; setSaving(true);
    try {
      const outcome = await runner(decideEvidence, {
        projectId: core.project.id, evidenceId: selected.id, action: selection.action,
        reason, expectedVersion: selection.expectedVersion, idempotencyKey: selection.idempotencyKey,
      });
      if (!outcome.ok) { setFeedback(outcome.error.message); return; }
      setFeedback(selection.action === "adopt"
        ? "证据已采纳为本地正式证据，原因已保留；真实验收与通知尚未联动。"
        : "证据已在本地撤回，原记录、来源快照和原因已保留；真实验收与通知尚未联动。");
      setSelection(null); setReason("");
    } catch {
      setFeedback("保存失败，原因已保留，请重试。");
    } finally {
      busy.current = false; setSaving(false);
    }
  };

  const evidenceRows = (items: Evidence[]) => <div className={s.tableWrap}><table className={s.table}>
    <thead><tr><th>证据名称</th><th>来源</th><th>提交人</th><th>时间</th><th>关联任务 / 标准</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>{items.map((item) => {
      const sourceUrl = safeEvidenceSourceUrl(item.sourceUrl);
      const canDecide = localWorkspace && canManageEvidence(core.data, core.data.currentUserId, item);
      const action = item.status === "formal" ? "withdraw" : "adopt";
      const decisionBlocked = evidenceDecisionBlockReason(core.data, core.data.currentUserId, item, action);
      const history = (item as EvidenceWithCDecisions).cDecisionHistory ?? [];
      return <tr key={item.id}>
        <td><strong>{item.title}</strong><span className={s.cellSub}>{item.description}</span>{history.length > 0 && <details className={s.cellSub}><summary>决策历史（{history.length}）</summary>{history.map((decision) => <div key={decision.idempotencyKey}>{decision.action === "adopt" ? "采纳" : "撤回"} · {personName(core, decision.actorId)} · {displayDate(decision.decidedAt)}：{decision.reason}</div>)}</details>}</td>
        <td>{sourceLabel(item.source)}{sourceUrl ? <a className={s.cellSub} href={sourceUrl} target="_blank" rel="noopener noreferrer">打开原始来源 ↗</a> : item.sourceUrl ? <span className={s.cellSub}>来源链接无效</span> : <span className={s.cellSub}>未提供来源链接</span>}</td>
        <td>{personName(core, item.authorId)}</td><td>{displayDate(item.createdAt)}</td>
        <td><Link className={s.link} href={`${taskPath(core.project.id, item.taskId)}?tab=evidence`}>{taskById.get(item.taskId)?.title ?? "任务"}</Link><span className={s.cellSub}>{item.criterionIds.map((id) => core.criteria.find((criterion) => criterion.id === id)?.text ?? id).join("；") || "未关联验收标准"}</span></td>
        <td><Status value={item.status} />{evidenceSourceChanged(item) && <span className={`${s.badge} ${s.badgeOrange}`}>来源已变化</span>}</td>
        <td>{canDecide && ["candidate", "pending_confirmation", "formal"].includes(item.status) && <><button className={action === "adopt" ? s.buttonSoft : s.buttonGhost} type="button" disabled={saving || Boolean(decisionBlocked)} onClick={() => openDecision(item, action)}>{action === "adopt" ? "采纳" : "撤回"}</button>{decisionBlocked && <span className={s.cellSub}>{decisionBlocked}</span>}</>}</td>
      </tr>;
    })}</tbody>
  </table></div>;

  return <div className={s.page}>
    <Header eyebrow={core.project.name} title="证据中心" subtitle="按任务、时间线和来源组织证据，保留完整追溯关系。" actions={<Link className={s.buttonSoft} href={`${projectPath(core.project.id)}/tasks?view=list`}><Plus size={14} />选择任务添加证据</Link>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.grid}>
      <div><Panel>
        <Tabs value={tab} onChange={(view) => updateQuery({ view })} items={[{ value: "task", label: "按任务" }, { value: "timeline", label: "时间线" }, { value: "source", label: "来源" }]} />
        <div className={s.toolbar}>
          <input className={s.field} style={{ maxWidth: 320 }} value={filters.q} onChange={(event) => setFilter("q", event.target.value)} placeholder="搜索证据名称、任务或提交人" aria-label="搜索证据" />
          <select className={s.select} style={{ width: 160 }} value={filters.task} onChange={(event) => setFilter("task", event.target.value)} aria-label="筛选任务">
            <option value="all">全部任务</option>{filters.task !== "all" && !taskById.has(filters.task) && <option value={filters.task}>不可用的任务</option>}{core.tasks.map((task) => <option key={task.id} value={task.id}>{taskCode(task)} · {task.title}</option>)}
          </select>
          <select className={s.select} style={{ width: 130 }} value={filters.source} onChange={(event) => setFilter("source", event.target.value)} aria-label="筛选来源">
            <option value="all">全部来源</option>{evidenceSources.map((item) => <option key={item} value={item}>{sourceLabel(item)}</option>)}
          </select>
          <select className={s.select} style={{ width: 130 }} value={filters.author} onChange={(event) => setFilter("author", event.target.value)} aria-label="筛选提交人">
            <option value="all">全部提交人</option>{filters.author !== "all" && !authorIds.includes(filters.author) && <option value={filters.author}>不可用的提交人</option>}{authorIds.map((id) => <option key={id} value={id}>{personName(core, id)}</option>)}
          </select>
          <select className={s.select} style={{ width: 180 }} value={filters.criterion} onChange={(event) => setFilter("criterion", event.target.value)} aria-label="筛选验收标准">
            <option value="all">全部验收标准</option>{filters.criterion !== "all" && !core.criteria.some((item) => item.id === filters.criterion) && <option value={filters.criterion}>不可用的验收标准</option>}{core.criteria.map((criterion) => <option key={criterion.id} value={criterion.id}>{taskById.get(criterion.taskId)?.title ?? "任务"} · {criterion.text}</option>)}
          </select>
          <select className={s.select} style={{ width: 130 }} value={filters.status} onChange={(event) => setFilter("status", event.target.value)} aria-label="筛选证据状态">
            <option value="all">全部状态</option>{evidenceStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </select>
          <button className={s.buttonGhost} type="button" onClick={() => updateQuery({ task: null, source: null, author: null, criterion: null, status: null, q: null })}>清除筛选</button>
        </div>
        <p className={s.muted} role="status">匹配 {evidence.length} / {core.evidence.length} 条证据</p>
        {!evidence.length && <Empty>没有匹配的证据，可调整或清除筛选条件。</Empty>}
        {tab === "task" && taskGroups.map((task) => <div key={task.id} style={{ marginBottom: 18 }}><div className={s.space} style={{ marginBottom: 8 }}><TaskLink core={core} task={task} /><span className={s.muted}>{evidence.filter((item) => item.taskId === task.id).length} 条证据</span></div>{evidenceRows(evidence.filter((item) => item.taskId === task.id))}</div>)}
        {tab === "timeline" && evidenceRows([...evidence].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))}
        {tab === "source" && sourceGroups.map((kind) => <div key={kind} style={{ marginBottom: 18 }}><h3 className={s.panelTitle} style={{ marginBottom: 9 }}>{sourceLabel(kind)}</h3>{evidenceRows(evidence.filter((item) => item.source === kind))}</div>)}
      </Panel></div>
      <div><Panel title="证据原则"><div className={s.listRow}><div><strong>可验证来源</strong><div className={s.muted}>优先引用代码仓库、系统日志和原始文档。</div></div></div><div className={s.listRow}><div><strong>关联验收标准</strong><div className={s.muted}>每条证据应指向具体任务或验收标准。</div></div></div><div className={s.listRow}><div><strong>团队共同确认</strong><div className={s.muted}>低置信度或冲突证据先人工确认。</div></div></div></Panel><Panel title="来源说明"><div className={s.listRow}><span>GitHub PR / Commit</span><span className={s.muted}>原始代码活动</span></div><div className={s.listRow}><span>项目文件</span><span className={s.muted}>设计与测试资料</span></div><div className={s.listRow}><span>截图 / 飞书</span><span className={s.muted}>界面与协作记录</span></div></Panel>{selected && selection && <Panel title={selection.action === "adopt" ? "采纳候选证据" : "撤回正式证据"}>
        <p className={s.small}>{selected.title}</p>
        <p className={s.muted}>{selection.action === "adopt" ? "采纳后保留来源快照和本次决策原因。" : "撤回后保留原记录与来源快照。"} 本地演示操作不会执行真实验收或发送通知。</p>
        {blocked && <p className={s.muted}>{blocked}</p>}
        <label className={s.fieldLabel} htmlFor="c-evidence-decision-reason">{selection.action === "adopt" ? "采纳原因" : "撤回原因"} *</label>
        <textarea id="c-evidence-decision-reason" className={s.textarea} value={reason} disabled={saving} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder={selection.action === "adopt" ? "说明此证据支持哪些验收标准" : "说明为何这份证据不再代表当前有效结果"} />
        {selected.version !== selection.expectedVersion && <button type="button" className={s.buttonSoft} disabled={saving} onClick={() => setSelection({ ...selection, expectedVersion: selected.version, idempotencyKey: makeId("evidence-decision") })}>已核对当前版本，保留原因</button>}
        <div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 10 }}>
          <button type="button" className={s.buttonGhost} disabled={saving} onClick={() => { if (!reason.trim() || window.confirm("放弃尚未保存的证据决策原因？")) { setSelection(null); setReason(""); } }}>取消</button>
          <button type="button" className={selection.action === "adopt" ? s.buttonSoft : s.buttonDanger} onClick={saveDecision} disabled={saving || !reason.trim() || Boolean(blocked) || !localWorkspace || selected.version !== selection.expectedVersion}>{saving ? "保存中…" : selection.action === "adopt" ? "确认采纳" : "确认撤回"}</button>
        </div>
      </Panel>}</div>
    </div>
  </div>;
}
