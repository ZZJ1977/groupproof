"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, FileUp, Info, RefreshCcw, ShieldCheck, Sparkles } from "lucide-react";
import type { Evidence, Task, VerificationResult } from "@/types/domain";
import type { ProjectCore } from "./core-model";
import { displayDate, latestVerification, makeId, personName, projectPath, recordTaskProgress, sourceLabel, taskCode, taskPath, taskTitle } from "./core-model";
import { Empty, Header, Panel, Progress, Stat, Status } from "./CoreUI";
import s from "./project-core.module.css";

const sourceOptions: { value: Evidence["source"]; label: string }[] = [
  { value: "github", label: "GitHub Commit / PR" },
  { value: "file", label: "项目文件" },
  { value: "screenshot", label: "运行截图" },
  { value: "feishu", label: "飞书协作记录" },
  { value: "manual", label: "其他来源" },
];

export function ProjectTaskSubmit({ core, task }: { core: ProjectCore; task: Task }) {
  const router = useRouter();
  const savedNote = core.evidence.find((item) => item.taskId === task.id && item.source === "manual" && item.title === "任务实现说明" && item.authorId === core.data.currentUserId && item.status === "formal");
  const [implementationNote, setImplementationNote] = useState(savedNote?.description ?? "");
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<Evidence["source"]>("github");
  const [sourceUrl, setSourceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selectedCriteria, setSelectedCriteria] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  const criteria = core.criteria.filter((item) => item.taskId === task.id);
  const evidence = core.evidence.filter((item) => item.taskId === task.id);
  const canSubmit = core.canEdit && core.project.setupStatus === "frozen" && task.status !== "completed";

  const saveNote = () => {
    if (!implementationNote.trim()) return setFeedback("请填写实现说明。");
    if (savedNote) core.update("evidence", savedNote.id, { description: implementationNote.trim() });
    else core.add("evidence", { id: makeId("evidence"), projectId: core.project.id, taskId: task.id, criterionIds: [], authorId: core.data.currentUserId, title: "任务实现说明", description: implementationNote.trim(), source: "manual", status: "formal", createdAt: new Date().toISOString(), version: 1 });
    setFeedback("实现说明已保存到任务记录。");
  };

  const addEvidence = () => {
    const evidenceTitle = title.trim() || file?.name || "";
    if (!evidenceTitle || !evidenceDescription.trim()) return setFeedback("请填写证据名称和说明。");
    if (!selectedCriteria.length) return setFeedback("请至少关联一条验收标准。");
    if ((source === "file" || source === "screenshot") && !file) return setFeedback("请选择要上传的文件。");
    if (file && file.size > 50 * 1024 * 1024) return setFeedback("单个文件不能超过 50MB。");
    if ((source === "github" || source === "feishu") && !sourceUrl.trim()) return setFeedback("请填写原始来源链接。");
    core.add("evidence", { id: makeId("evidence"), projectId: core.project.id, taskId: task.id, criterionIds: selectedCriteria, authorId: core.data.currentUserId, title: evidenceTitle, description: evidenceDescription.trim(), source, sourceUrl: sourceUrl.trim() || undefined, status: "formal", createdAt: new Date().toISOString(), version: 1 });
    if (task.status === "in_progress" || task.status === "not_started") core.update("tasks", task.id, { status: "pending_submission", updatedAt: new Date().toISOString() });
    setTitle(""); setEvidenceDescription(""); setSourceUrl(""); setFile(null); setSelectedCriteria([]);
    setFeedback("证据已关联到本任务。可以继续补充或运行完整性检查。");
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={taskPath(core.project.id, task.id)}>返回任务</Link>} title="提交任务" subtitle={`${taskCode(task)} · ${taskTitle(task)}：提交实现说明并附上可追溯证据。`} actions={<Link className={s.buttonSoft} href={`${taskPath(core.project.id, task.id)}/evidence-check`}>完整性检查 <ArrowRight size={14} /></Link>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.grid}>
      <div>
        <Panel title="1. 提交说明">
          <label className={s.fieldLabel}>实现说明</label>
          <textarea className={s.textarea} style={{ minHeight: 110 }} value={implementationNote} onChange={(event) => setImplementationNote(event.target.value)} maxLength={1000} placeholder="描述完成内容、实现方式和关键结果" disabled={!canSubmit} />
          <div className={s.space}><span className={s.muted}>支持 Markdown 语法</span><span className={s.muted}>{implementationNote.length}/1000</span></div>
          <button className={s.buttonGhost} type="button" style={{ marginTop: 10 }} disabled={!canSubmit || !implementationNote.trim()} onClick={saveNote}>保存实现说明</button>
        </Panel>
        <Panel title="2. 关联证据">
          <div className={s.formGrid}>
            <label><span className={s.fieldLabel}>来源类型</span><select className={s.select} value={source} onChange={(event) => { setSource(event.target.value as Evidence["source"]); setFile(null); setSourceUrl(""); }} disabled={!canSubmit}>{sourceOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            <label><span className={s.fieldLabel}>证据名称 *</span><input className={s.field} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 PR #128 核心功能实现" disabled={!canSubmit} /></label>
            {source === "github" && <label className={s.full}><span className={s.fieldLabel}>从已同步的 GitHub 活动选择</span><select className={s.select} value="" onChange={(event) => { const item = core.data.github.find((entry) => entry.id === event.target.value); if (item) { setTitle(item.title); setSourceUrl(item.url); setEvidenceDescription(`${item.type.toUpperCase()} · ${item.status}`); } }} disabled={!canSubmit}><option value="">选择开发活动</option>{core.data.github.filter((item) => item.projectId === core.project.id).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}
            {source === "feishu" && <label className={s.full}><span className={s.fieldLabel}>从已同步的飞书记录选择</span><select className={s.select} value="" onChange={(event) => { const item = core.data.feishu.find((entry) => entry.id === event.target.value); if (item) { setTitle(item.summary); setSourceUrl(`${projectPath(core.project.id)}/collaboration#${item.id}`); setEvidenceDescription(`${item.groupName} · ${item.type}`); } }} disabled={!canSubmit}><option value="">选择协作记录</option>{core.data.feishu.filter((item) => item.projectId === core.project.id).map((item) => <option value={item.id} key={item.id}>{item.summary}</option>)}</select></label>}
            {(source === "github" || source === "feishu" || source === "manual") && <label className={s.full}><span className={s.fieldLabel}>原始来源链接 {source === "manual" ? "（可选）" : "*"}</span><input className={s.field} value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://" disabled={!canSubmit} /></label>}
            <label className={s.full}><span className={s.fieldLabel}>证据说明 *</span><textarea className={s.textarea} value={evidenceDescription} onChange={(event) => setEvidenceDescription(event.target.value)} placeholder="说明这条记录如何支持对应的验收标准" disabled={!canSubmit} /></label>
          </div>
          {(source === "file" || source === "screenshot") && <div className={`${s.dropzone} ${s.mt}`}><FileUp size={20} /><div>{file?.name ?? "选择文件或截图"}</div><input type="file" aria-label="选择证据文件" accept={source === "screenshot" ? "image/png,image/jpeg" : ".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.txt,.md,.zip"} disabled={!canSubmit} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span className={s.muted}>单文件不超过 50MB</span></div>}
          <div className={s.mt}><span className={s.fieldLabel}>关联验收标准 *</span><div className={s.checks}>{criteria.map((criterion, index) => <label className={s.check} key={criterion.id}><input type="checkbox" checked={selectedCriteria.includes(criterion.id)} disabled={!canSubmit} onChange={(event) => setSelectedCriteria((old) => event.target.checked ? [...old, criterion.id] : old.filter((id) => id !== criterion.id))} /><span>AC-{index + 1} · {criterion.text}</span></label>)}</div></div>
          <div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 17 }}><button type="button" className={s.button} disabled={!canSubmit} onClick={addEvidence}><Check size={14} />添加证据</button><button type="button" className={s.buttonSoft} disabled={!canSubmit || !evidence.length} onClick={() => router.push(`${taskPath(core.project.id, task.id)}/evidence-check`)}>检查完整性 <ArrowRight size={14} /></button></div>
        </Panel>
        <Panel title="已关联证据">{evidence.length ? <div className={s.tableWrap}><table className={s.table}><thead><tr><th>证据</th><th>来源</th><th>验收标准</th><th>状态</th></tr></thead><tbody>{evidence.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><span className={s.cellSub}>{item.description}</span></td><td>{sourceLabel(item.source)}</td><td>{item.criterionIds.map((id) => `AC-${criteria.findIndex((criterion) => criterion.id === id) + 1}`).join("、")}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div> : <Empty>尚未添加证据</Empty>}</Panel>
      </div>
      <div><Panel title="提交要求"><div className={s.checks}><span className={s.check}><Check size={14} />说明完成内容和可复现方式</span><span className={s.check}><Check size={14} />关联原始 GitHub 记录或项目文件</span><span className={s.check}><Check size={14} />将证据对应到具体验收标准</span><span className={s.check}><Check size={14} />在正式验收前运行完整性检查</span></div></Panel><Panel title="当前提交"><div className={s.detailPair}><span>任务状态</span><span><Status value={task.status} /></span></div><div className={s.detailPair}><span>已关联证据</span><span>{evidence.length} 条</span></div><div className={s.detailPair}><span>验收标准</span><span>{criteria.length} 项</span></div><div className={s.notice} style={{ marginTop: 14 }}><Info size={15} />已提交的正式证据会保留历史。需要撤回时，前往证据中心填写原因。</div></Panel></div>
    </div>
  </div>;
}

export function ProjectEvidenceCheck({ core, task }: { core: ProjectCore; task: Task }) {
  const router = useRouter();
  const [checkedAt, setCheckedAt] = useState(new Date().toISOString());
  const criteria = core.criteria.filter((item) => item.taskId === task.id);
  const evidence = core.evidence.filter((item) => item.taskId === task.id && item.status !== "withdrawn" && item.status !== "void");
  const formalEvidence = evidence.filter((item) => item.status === "formal");
  const hasImplementationNote = formalEvidence.some((item) => item.title === "任务实现说明" && item.source === "manual" && Boolean(item.description.trim()));
  const covered = criteria.filter((criterion) => formalEvidence.some((item) => item.criterionIds.includes(criterion.id)));
  const missing = criteria.filter((criterion) => !covered.includes(criterion));
  const pending = evidence.filter((item) => item.status === "pending_confirmation");
  const coverage = criteria.length ? Math.round(covered.length / criteria.length * 100) : 0;
  const ready = hasImplementationNote && criteria.length > 0 && missing.length === 0 && pending.length === 0 && task.status !== "completed";

  const continueVerification = () => {
    if (!ready || !core.canEdit) return;
    core.update("tasks", task.id, { status: "pending_verification", updatedAt: new Date().toISOString() });
    router.push(`${taskPath(core.project.id, task.id)}/verification`);
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={taskPath(core.project.id, task.id)}>返回任务</Link>} title="证据完整性检查" subtitle="提交前检查验收标准覆盖率、缺失项与待人工确认的证据。" actions={<button className={s.buttonSoft} type="button" onClick={() => setCheckedAt(new Date().toISOString())}><RefreshCcw size={14} />重新检查</button>} />
    <div className={s.stats}><Stat label="验收标准覆盖率" value={`${coverage}%`} note={<Progress value={coverage} />} tone={coverage === 100 ? "green" : "orange"} /><Stat label="缺失项" value={missing.length} note="没有正式证据支持的标准" tone={missing.length ? "red" : "green"} /><Stat label="待确认来源" value={pending.length} note="需解决后进入正式验收" tone={pending.length ? "orange" : "green"} /><Stat label="最近检查" value={displayDate(checkedAt)} note="根据当前证据重新计算" /></div>
    <div className={s.grid}>
      <Panel title={`${taskCode(task)} 验收标准检查清单`} action={<span className={s.muted}>{covered.length}/{criteria.length} 项已覆盖</span>}><div className={s.tableWrap}><table className={s.table}><thead><tr><th>验收标准</th><th>覆盖状态</th><th>已关联证据</th><th>提示</th></tr></thead><tbody>{criteria.map((criterion, index) => { const linked = evidence.filter((item) => item.criterionIds.includes(criterion.id)); const formal = linked.filter((item) => item.status === "formal"); return <tr key={criterion.id}><td><strong>AC-{index + 1}</strong><span className={s.cellSub}>{criterion.text}</span></td><td><Status value={formal.length ? "passed" : "failed"} /></td><td>{linked.map((item) => <div key={item.id}>{item.title} <span className={s.muted}>({sourceLabel(item.source)})</span></div>)}</td><td>{formal.length ? "可进入逐项验收" : linked.length ? "仅有待确认来源" : "请补充证据"}</td></tr>; })}</tbody></table></div></Panel>
      <div><Panel title="检查结果汇总"><div className={`${s.notice} ${ready ? "" : s.noticeWarn}`}><ShieldCheck size={16} />{ready ? "实现说明已保存，全部验收标准均有正式证据。" : "请补全实现说明、验收标准证据和待确认来源后再进入 AI 验收。"}</div>{!hasImplementationNote && <div className={s.listRow}>缺少已保存的任务实现说明</div>}{missing.length > 0 && <div><strong className={s.small}>需要补充</strong>{missing.map((criterion) => <div className={s.listRow} key={criterion.id}>{criterion.text}</div>)}</div>}{pending.length > 0 && <div className={s.mt}><strong className={s.small}>待确认来源</strong>{pending.map((item) => <div className={s.listRow} key={item.id}>{item.title}</div>)}</div>}<div className={s.actions} style={{ justifyContent: "flex-start", marginTop: 18 }}><Link className={s.buttonGhost} href={`${taskPath(core.project.id, task.id)}/submit`}>补充证据</Link><button className={s.button} type="button" disabled={!ready || !core.canEdit} onClick={continueVerification}>进入 AI 验收 <ArrowRight size={14} /></button></div></Panel><Panel title="检查规则"><p className={s.small}>覆盖率表示有多少验收标准引用了正式证据。来源可信度和实际内容仍需在逐项验收时判断。</p></Panel></div>
    </div>
  </div>;
}

export function ProjectVerification({ core, task }: { core: ProjectCore; task: Task }) {
  const [feedback, setFeedback] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [showManual, setShowManual] = useState(false);
  const verification = latestVerification(core, task.id);
  const criteria = core.criteria.filter((item) => item.taskId === task.id);
  const evidence = core.evidence.filter((item) => item.taskId === task.id && item.status === "formal");
  const readyForAi = evidence.some((item) => item.title === "任务实现说明" && item.source === "manual" && Boolean(item.description.trim())) && criteria.length > 0 && criteria.every((criterion) => evidence.some((item) => item.criterionIds.includes(criterion.id))) && !core.evidence.some((item) => item.taskId === task.id && item.status === "pending_confirmation");
  const isResponsible = task.responsibleIds.includes(core.data.currentUserId);
  const canConfirm = core.canEdit && isResponsible && task.status === "pending_verification" && verification && ["passed", "uncertain"].includes(verification.result) && !verification.humanConfirmedBy.includes(core.data.currentUserId);

  const runVerification = () => {
    if (!core.canEdit || !readyForAi || task.status !== "pending_verification") return setFeedback("请先提交任务并通过证据完整性检查。");
    const criterionResults = criteria.map((criterion) => {
      const linked = evidence.filter((item) => item.criterionIds.includes(criterion.id));
      const result: VerificationResult = linked.length ? "passed" : "failed";
      return { criterionId: criterion.id, result, evidenceIds: linked.map((item) => item.id), confidence: linked.length ? 0.86 : 0.42, reason: linked.length ? `发现 ${linked.length} 条正式证据支持此标准。` : "未找到正式证据支持此标准。", remediation: linked.length ? "" : "补充与此验收标准直接关联的文件、代码或测试记录。" };
    });
    const passed = criterionResults.filter((item) => item.result === "passed").length;
    const result: VerificationResult = passed === criteria.length && criteria.length > 0 ? "passed" : passed > 0 ? "partially_passed" : "failed";
    for (const row of criterionResults) core.update("criteria", row.criterionId, { result: row.result, humanConfirmedBy: [] });
    for (const old of core.verifications.filter((item) => item.taskId === task.id && item.status === "current")) core.update("verifications", old.id, { status: "outdated" });
    core.add("verifications", { id: makeId("verification"), taskId: task.id, projectId: core.project.id, result, criterionResults, confidence: criterionResults.length ? criterionResults.reduce((sum, item) => sum + item.confidence, 0) / criterionResults.length : 0, status: "current", createdAt: new Date().toISOString(), humanConfirmedBy: [], version: 1 });
    core.update("tasks", task.id, { status: "pending_verification", updatedAt: new Date().toISOString() });
    setFeedback(result === "passed" ? "逐项验收已通过，仍需负责人完成独立确认。" : "已记录逐项结果，请补充未通过标准的证据后重新运行。");
  };

  const confirm = () => {
    if (!verification || !canConfirm) return;
    if (verification.result === "uncertain" && !manualReason.trim()) return setFeedback("人工确认不确定结果需要说明依据。");
    const confirmedBy = [...verification.humanConfirmedBy, core.data.currentUserId];
    core.update("verifications", verification.id, { humanConfirmedBy: confirmedBy });
    if (task.responsibleIds.every((id) => confirmedBy.includes(id))) { recordTaskProgress(core, task, 100); core.update("tasks", task.id, { status: "completed", updatedAt: new Date().toISOString() }); }
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "人工确认逐项验收", target: task.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: manualReason.trim() || `确认 ${verification.id} 的已通过结果` });
    setFeedback(task.responsibleIds.every((id) => confirmedBy.includes(id)) ? "所有负责人已确认，任务完成。" : "你的确认已记录，等待其他负责人确认。");
    setManualReason("");
  };

  const manualConfirmWithoutAi = () => {
    if (!manualReason.trim() || !isResponsible || task.status !== "pending_verification" || verification) return setFeedback("仅待验证任务的负责人可在 AI 不可用时填写人工验收依据。");
    if (!readyForAi) return setFeedback("人工验收仍需为每条验收标准提供正式证据。");
    const rows = criteria.map((criterion) => ({ criterionId: criterion.id, result: "uncertain" as const, evidenceIds: evidence.filter((item) => item.criterionIds.includes(criterion.id)).map((item) => item.id), confidence: 0, reason: `人工复核：${manualReason.trim()}`, remediation: "" }));
    for (const criterion of criteria) core.update("criteria", criterion.id, { result: "uncertain", humanConfirmedBy: [...criterion.humanConfirmedBy, core.data.currentUserId] });
    for (const old of core.verifications.filter((item) => item.taskId === task.id && item.status === "current")) core.update("verifications", old.id, { status: "outdated" });
    core.add("verifications", { id: makeId("verification"), taskId: task.id, projectId: core.project.id, result: "uncertain", criterionResults: rows, confidence: 0, status: "current", createdAt: new Date().toISOString(), humanConfirmedBy: [core.data.currentUserId], version: 1 });
    if (task.responsibleIds.length === 1) { recordTaskProgress(core, task, 100); core.update("tasks", task.id, { status: "completed", updatedAt: new Date().toISOString() }); }
    core.add("logs", { id: makeId("log"), actorId: core.data.currentUserId, action: "AI 不可用时人工验收", target: task.id, result: "success", ip: "Mock", createdAt: new Date().toISOString(), detail: manualReason.trim() });
    setFeedback("已记录无当前 AI 结果的人工确认；历史记录保留。");
    setManualReason(""); setShowManual(false);
  };

  return <div className={s.page}>
    <Header eyebrow={<Link className={s.link} href={taskPath(core.project.id, task.id)}>返回任务</Link>} title="AI 验收" subtitle="按验收标准逐项判断，并明确引用对应证据。" actions={<button className={s.button} type="button" disabled={!core.canEdit || task.status === "completed" || !readyForAi || task.status !== "pending_verification"} onClick={runVerification}><Sparkles size={14} />{verification ? "重新验收" : "运行 AI 验收"}</button>} />
    {feedback && <div className={s.notice} role="status"><Info size={15} />{feedback}</div>}
    <div className={s.stats}><Stat label="验收结果" value={verification ? <Status value={verification.result} /> : "待运行"} note={verification ? `${verification.criterionResults.filter((item) => item.result === "passed").length}/${criteria.length} 项通过` : "逐项评估验收标准"} /><Stat label="置信度" value={verification ? `${Math.round(verification.confidence * 100)}%` : "—"} note="仅供人工参考" /><Stat label="引用证据数" value={verification ? new Set(verification.criterionResults.flatMap((item) => item.evidenceIds)).size : 0} note="可追溯原始来源" /><Stat label="评估时间" value={verification ? displayDate(verification.createdAt) : "—"} note={verification?.status === "outdated" ? "已过期" : "当前版本"} /></div>
    <div className={s.grid}>
      <Panel title="验收标准详情"><div className={s.tableWrap}><table className={s.table}><thead><tr><th>标准</th><th>引用证据</th><th>判断</th><th>置信度</th><th>理由与补救</th></tr></thead><tbody>{criteria.map((criterion, index) => { const row = verification?.criterionResults.find((item) => item.criterionId === criterion.id); return <tr key={criterion.id}><td><strong>AC-{index + 1}</strong><span className={s.cellSub}>{criterion.text}</span></td><td>{row?.evidenceIds.map((id) => <div key={id}>{core.evidence.find((item) => item.id === id)?.title ?? id}</div>) ?? "—"}</td><td>{row ? <Status value={row.result} /> : "—"}</td><td>{row ? `${Math.round(row.confidence * 100)}%` : "—"}</td><td>{row?.reason ?? "等待逐项验收"}{row?.remediation && <span className={s.cellSub}>建议：{row.remediation}</span>}</td></tr>; })}</tbody></table></div>{!criteria.length && <Empty>当前任务没有验收标准</Empty>}</Panel>
      <div><Panel title="人工确认"><div className={s.detailPair}><span>当前状态</span><span><Status value={task.status} /></span></div><div className={s.detailPair}><span>负责人确认</span><span>{verification?.humanConfirmedBy.length ?? 0}/{task.responsibleIds.length}</span></div>{task.responsibleIds.map((id) => <div className={s.listRow} key={id}><span>{personName(core, id)}</span><Status value={verification?.humanConfirmedBy.includes(id) ? "confirmed" : "pending_confirmation"} /></div>)}{verification?.result === "uncertain" && <label className={s.mt} style={{ display: "block" }}><span className={s.fieldLabel}>人工复核依据 *</span><textarea className={s.textarea} value={manualReason} onChange={(event) => setManualReason(event.target.value)} placeholder="说明引用证据与人工判断" /></label>}{verification?.result === "passed" && <div className={s.notice} style={{ marginTop: 15 }}><Info size={15} />AI 通过仍需全部负责人确认，任务才会完成。</div>}{verification && ["partially_passed", "failed"].includes(verification.result) && <Link className={s.buttonSoft} href={`${taskPath(core.project.id, task.id)}/submit`} style={{ marginTop: 15 }}>补充证据 <ArrowRight size={14} /></Link>}<button className={s.button} type="button" style={{ marginTop: 15 }} disabled={!canConfirm} onClick={confirm}><Check size={14} />{verification?.humanConfirmedBy.includes(core.data.currentUserId) ? "已确认" : "确认验收结果"}</button></Panel><Panel title="AI 服务降级"><p className={s.small}>服务不可用时，负责人可按证据逐项人工确认。后续重新运行不会覆盖这次人工记录。</p><button className={s.buttonGhost} type="button" disabled={!isResponsible || !core.canEdit || task.status !== "pending_verification" || Boolean(verification)} onClick={() => setShowManual(!showManual)}>人工确认</button>{showManual && <div className={s.mt}><label className={s.fieldLabel}>人工判断依据 *</label><textarea className={s.textarea} value={manualReason} onChange={(event) => setManualReason(event.target.value)} /><button className={s.buttonSoft} type="button" onClick={manualConfirmWithoutAi} style={{ marginTop: 9 }}>记录人工验收</button></div>}</Panel></div>
    </div>
  </div>;
}
