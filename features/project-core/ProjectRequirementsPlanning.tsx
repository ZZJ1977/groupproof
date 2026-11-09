"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Info, Plus, RefreshCcw, Save } from "lucide-react";
import type { Priority } from "@/types/domain";
import type { ProjectCore } from "./core-model";
import { activeBaseline, activePlan, confirmMember, confirmedUserIds, draftBaseline, draftPlan, confirmationsComplete } from "@/lib/versioning";
import { compareBaselines, getBaselineHistory } from "@/lib/commands/baseline";
import { useCommands } from "@/lib/commands/use-commands";
import { makeId, personName, priorityLabel, projectPath, requirementCode, taskCode, taskPath, taskTitle } from "./core-model";
import { Empty, Header, Panel, Status, Tabs, TaskLink } from "./CoreUI";
import s from "./project-core.module.css";
import { tr } from "@/lib/i18n/tr";

const priorityOptions: { value: Priority; label: string }[] = [{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }];

export function ProjectRequirements({ core }: { core: ProjectCore }) {
  const commands = useCommands();
  const activeRev = activeBaseline(core.data, core.project.id);
  const draftRev = draftBaseline(core.data, core.project.id);
  const revisions = getBaselineHistory(core.data, core.project.id);
  // 编辑入口指向草稿；正式详情与历史保留在版本列表
  const viewRequirements = draftRev ? draftRev.payload.requirements : core.requirements;
  const viewModules = draftRev ? draftRev.payload.modules : core.modules;
  const [tab, setTab] = useState("list");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(viewRequirements[0]?.id ?? "");
  const selected = viewRequirements.find((item) => item.id === selectedId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(selected?.title ?? "");
  const [description, setDescription] = useState(selected?.description ?? "");
  const [priority, setPriority] = useState<Priority>(selected?.priority ?? "medium");
  const [moduleId, setModuleId] = useState(selected?.moduleId ?? "");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [forceReason, setForceReason] = useState("");
  const frozen = core.project.setupStatus === "frozen";
  const formalBaseline = core.project.baselineVersion > 0 && core.project.setupStatus !== "draft";
  const defaultModuleId = viewModules[0]?.id ?? "";

  useEffect(() => {
    setTitle(selected?.title ?? "");
    setDescription(selected?.description ?? "");
    setPriority(selected?.priority ?? "medium");
    setModuleId(selected?.moduleId ?? defaultModuleId);
    setReason("");
  }, [selectedId, selected?.version, selected?.title, selected?.description, selected?.priority, selected?.moduleId, defaultModuleId]);

  const save = async () => {
    if (!title.trim() || !description.trim() || !moduleId) return setFeedback("请填写需求名称、描述并选择所属模块。");
    if (formalBaseline && !reason.trim()) return setFeedback("正式基线的变更需要填写原因。");
    let revision = draftRev;
    if (!revision) {
      const created = await commands.createBaselineDraft({ projectId: core.project.id, expectedVersion: core.project.version });
      if (!created.ok) return setFeedback(tr("创建变更草稿失败：{0}", { 0: created.error.message }));
      revision = created.result;
    }
    const base = revision.payload;
    if (selected) {
      const payload = { ...base, requirements: base.requirements.map((item) => item.id === selected.id ? { ...item, title: title.trim(), description: description.trim(), priority, moduleId, version: item.version + 1, status: formalBaseline ? "draft" as const : item.status } : item) };
      const outcome = await commands.saveBaselineDraft({ projectId: core.project.id, revisionId: revision.id, payload, reason: reason.trim() || "编辑需求草稿", expectedVersion: core.project.version });
      if (!outcome.ok) return setFeedback(tr("保存失败：{0}", { 0: outcome.error.message }));
      setFeedback(tr("需求已保存到变更草稿（内容 v{0}）；正式版本保持不变，发布后生效。", { 0: outcome.result.contentVersion }));
    } else {
      const id = `req-${Math.max(0, ...core.data.requirements.map((item) => Number(item.id.match(/\d+$/)?.[0]) || 0)) + 1}`;
      const payload = { ...base, requirements: [...base.requirements, { id, projectId: core.project.id, title: title.trim(), description: description.trim(), priority, status: "draft" as const, moduleId, version: 1, source: "手动创建" }] };
      const outcome = await commands.saveBaselineDraft({ projectId: core.project.id, revisionId: revision.id, payload, reason: reason.trim() || "新增需求草稿", expectedVersion: core.project.version });
      if (!outcome.ok) return setFeedback(tr("保存失败：{0}", { 0: outcome.error.message }));
      setSelectedId(id);
      setFeedback(tr("新需求已加入变更草稿（内容 v{0}）；发布后生效。", { 0: outcome.result.contentVersion }));
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

  const requirements = viewRequirements.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const connectedTasks = selected ? core.tasks.filter((task) => task.requirementIds.includes(selected.id)) : [];
  const connectedCriteria = core.criteria.filter((criterion) => connectedTasks.some((task) => task.id === criterion.taskId));
  const connectedEvidence = core.evidence.filter((item) => item.criterionIds.some((id) => connectedCriteria.some((criterion) => criterion.id === id)));

  return <div className={s.page}>
    <Header eyebrow={core.project.name} title="需求基线" subtitle="以规格文档方式管理需求，并保留需求、任务、验收标准和证据之间的追溯关系。" actions={<><Status value={core.project.setupStatus} /><span className={s.badge}>v{Math.max(1, core.project.baselineVersion)}</span>{core.canEdit && !draftRev && activeRev && <button className={s.buttonSoft} type="button" onClick={() => { void commands.createBaselineDraft({ projectId: core.project.id, expectedVersion: core.project.version }).then((outcome) => setFeedback(outcome.ok ? tr("变更草稿 v{0} 已创建，可开始编辑。", { 0: outcome.result.number }) : outcome.error.message)); }}><Plus size={14} />创建变更草稿</button>}{core.canEdit && <button className={s.button} type="button" onClick={startCreate}><Plus size={14} />新增需求</button>}</>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    {core.project.setupStatus === "pending_confirmation" && <div className={`${s.notice} ${s.noticeWarn}`}><Info size={15} />需求变更已形成待确认版本。团队完成确认前，相关验收结果不能作为当前正式结论。<Link className={s.link} href={`${projectPath(core.project.id)}/setup`}>前往确认</Link></div>}
    <div className={s.grid}>
      <Panel title="需求管理">
        <Tabs value={tab} onChange={setTab} items={[{ value: "list", label: "需求列表" }, { value: "versions", label: "版本历史" }, { value: "baseline", label: "基线说明" }, { value: "files", label: "相关文档" }]} />
        {tab === "list" && <><div className={s.toolbar}><input className={s.field} style={{ maxWidth: 320 }} aria-label="搜索需求" placeholder="搜索需求名称或描述" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className={s.tableWrap}><table className={s.table}><thead><tr><th>编号</th><th>需求名称</th><th>优先级</th><th>状态</th><th>所属模块</th><th>操作</th></tr></thead><tbody>{requirements.map((item) => <tr key={item.id}><td>{requirementCode(item)}</td><td><strong>{item.title}</strong><span className={s.cellSub}>{item.description}</span></td><td>{priorityLabel(item.priority)}</td><td><Status value={item.status} /></td><td>{viewModules.find((entry) => entry.id === item.moduleId)?.name ?? "—"}</td><td><button className={s.buttonSoft} type="button" onClick={() => { setSelectedId(item.id); setEditing(false); }}>查看证据链</button></td></tr>)}</tbody></table></div>{!requirements.length && <Empty>没有匹配的需求</Empty>}</>}
        {tab === "versions" && <div className={s.list}><div className={s.listRow}><div><strong>{tr("当前正式版本{0}", { 0: activeRev ? tr(" · 修订 {0}", { 0: activeRev.number }) : "" })}</strong><div className={s.muted}>{activeRev ? tr("内容版本 v{0} · 已确认 {1}/{2}{3}", { 0: activeRev.contentVersion, 1: confirmedUserIds(activeRev).length, 2: activeRev.memberRoster.length, 3: activeRev.legacy ? " · 历史迁移" : "" }) : "尚未生成正式快照"}</div></div><Status value={activeRev ? "frozen" : "draft"} /></div>{draftRev && <><div className={s.listRow}><div><strong>{tr("待确认草稿 · 修订 {0}", { 0: draftRev.number })}</strong><div className={s.muted}>{tr("内容版本 v{0} · 已确认 {1}/{2}{3}", { 0: draftRev.contentVersion, 1: confirmedUserIds(draftRev).length, 2: draftRev.memberRoster.length, 3: draftRev.reason ? ` · ${draftRev.reason}` : "" })}</div></div><Status value="pending_confirmation" /></div>{(core.canEdit || core.canLead) && <div className={s.mt}><div className={s.actions} style={{ justifyContent: "flex-start" }}>{core.canEdit && <button className={s.buttonSoft} type="button" onClick={() => { void commands.submitBaselineForConfirmation({ projectId: core.project.id, revisionId: draftRev.id, expectedVersion: core.project.version }).then((outcome) => setFeedback(outcome.ok ? "已提交团队确认。" : outcome.error.message)); }}>提交确认</button>}{core.canEdit && <button className={s.buttonSoft} type="button" onClick={() => { void commands.confirmBaselineSelf({ projectId: core.project.id, revisionId: draftRev.id, contentVersion: draftRev.contentVersion, expectedVersion: core.project.version }).then((outcome) => setFeedback(outcome.ok ? "已记录你的确认。" : outcome.error.message)); }}>确认本人</button>}{core.canLead && <button className={s.button} type="button" disabled={!confirmationsComplete(draftRev)} onClick={() => { void commands.publishBaseline({ projectId: core.project.id, revisionId: draftRev.id, expectedVersion: core.project.version }).then((outcome) => setFeedback(outcome.ok ? tr("基线修订 {0} 已发布；受影响验收已标记待复核。", { 0: outcome.result.number }) : outcome.error.message)); }}>正常发布</button>}</div>{core.canLead && <div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 8 }}><input className={s.field} style={{ maxWidth: 320 }} aria-label="例外推进原因" placeholder="例外推进原因（含未确认成员）" value={forceReason} onChange={(event) => setForceReason(event.target.value)} /><button className={s.buttonGhost} type="button" disabled={!forceReason.trim() || confirmationsComplete(draftRev)} onClick={() => { void commands.forcePublishBaseline({ projectId: core.project.id, revisionId: draftRev.id, reason: forceReason.trim(), expectedVersion: core.project.version }).then((outcome) => { setForceReason(""); setFeedback(outcome.ok ? `例外推进完成；未确认成员已记入审计。` : outcome.error.message); }); }}>例外推进</button></div>}</div>}</>}{revisions.map((revision) => { const diff = revision.basedOnRevisionId ? compareBaselines(core.data, revision.basedOnRevisionId, revision.id) : null; return <div className={s.listRow} key={revision.id}><div><strong>{tr("修订 {0} · {1}", { 0: revision.number, 1: revision.status === "published" ? "已发布" : revision.status === "confirming" ? "待确认" : "草稿" })}</strong><div className={s.muted}>{tr("内容 v{0}{1}{2}{3}", { 0: revision.contentVersion, 1: revision.legacy ? " · 历史迁移（未记录时间）" : "", 2: diff ? tr(" · 差异：新增 {0} · 修改 {1} · 删除 {2}", { 0: diff.addedRequirementIds.length, 1: diff.changedRequirements.length, 2: diff.removedRequirementIds.length }) : "", 3: revision.reason ? ` · ${revision.reason}` : "" })}</div></div><Status value={revision.status === "published" ? "frozen" : "pending_confirmation"} /></div>; })}<div className={s.listRow}><div><strong>{tr("需求基线 v{0}", { 0: Math.max(1, core.project.baselineVersion) })}</strong><div className={s.muted}>{tr("当前版本 · {0}", { 0: core.project.setupStatus === "frozen" ? "已冻结" : "待团队确认" })}</div></div><Status value={core.project.setupStatus} /></div>{core.requirements.map((item) => <div className={s.listRow} key={item.id}><span>{requirementCode(item)} · {item.title}</span><span className={s.muted}>v{item.version}</span></div>)}{core.data.logs.filter((item) => core.requirements.some((requirement) => requirement.id === item.target) && item.action.includes("需求")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => <div className={s.listRow} key={item.id}><div><strong>{item.action}</strong><div className={s.muted}>{item.detail}</div></div><span className={s.muted}>{item.createdAt.slice(0, 10)}</span></div>)}</div>}
        {tab === "baseline" && <div><p className={s.small}>基线明确项目范围与官方要求。每条需求连接功能模块、任务、验收标准和证据，形成可审计的完整链路。</p><div className={s.notice}><Info size={15} />已冻结基线的正式修改会形成新版本，并触发受影响任务的重新确认和验收。</div></div>}
        {tab === "files" && <div className={s.list}>{core.data.files.filter((file) => file.projectId === core.project.id).map((file) => <div className={s.listRow} key={file.id}><strong>{file.name}</strong><span className={s.muted}>v{file.version} · {file.source}</span></div>)}</div>}
      </Panel>
      <div>
        {(selected || editing) && <Panel title={editing ? selected ? "编辑需求" : "新增需求" : selected?.title} action={selected && !editing && core.canEdit && <button className={s.buttonSoft} type="button" onClick={() => setEditing(true)}>编辑</button>}>
          {editing ? <div className={s.checks}><label><span className={s.fieldLabel}>需求名称</span><input className={s.field} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span className={s.fieldLabel}>描述</span><textarea className={s.textarea} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label><span className={s.fieldLabel}>优先级</span><select className={s.select} value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span className={s.fieldLabel}>所属模块</span><select className={s.select} value={moduleId} onChange={(event) => setModuleId(event.target.value)}>{viewModules.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label>{formalBaseline && <label><span className={s.fieldLabel}>变更原因 *</span><textarea className={s.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明变更内容及对任务、验收和里程碑的影响" /></label>}<div className={s.actions}><button className={s.buttonGhost} type="button" onClick={() => setEditing(false)}>取消</button><button className={s.button} type="button" onClick={save}><Save size={14} />{formalBaseline ? "提交变更" : "保存需求"}</button></div></div> : selected && <><div className={s.detailPair}><span>编号 / 版本</span><span>{requirementCode(selected)} / v{selected.version}</span></div><div className={s.detailPair}><span>优先级</span><span>{priorityLabel(selected.priority)}</span></div><div className={s.detailPair}><span>来源</span><span>{selected.source}</span></div><p className={s.small}>{selected.description}</p></>}
        </Panel>}
        {selected && !editing && <Panel title="追溯关系"><div className={s.listRow}><span>功能模块</span><strong>{core.modules.find((item) => item.id === selected.moduleId)?.name ?? "待关联"}</strong></div><div className={s.listRow}><span>关联任务</span><strong>{tr("{0} 项", { 0: connectedTasks.length })}</strong></div>{connectedTasks.slice(0, 3).map((task) => <div className={s.listRow} key={task.id}><TaskLink core={core} task={task} /><Status value={task.status} /></div>)}<div className={s.listRow}><span>验收标准</span><strong>{tr("{0} 条", { 0: connectedCriteria.length })}</strong></div><div className={s.listRow}><span>引用证据</span><strong>{tr("{0} 条", { 0: connectedEvidence.length })}</strong></div><div className={s.listRow}><span>当前验证</span><strong>{tr("{0} 次", { 0: core.verifications.filter((item) => connectedTasks.some((task) => task.id === item.taskId) && item.status === "current").length })}</strong></div></Panel>}
      </div>
    </div>
  </div>;
}

