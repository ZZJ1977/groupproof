"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, BarChart3, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Clock3, FileText, FolderOpen, Info, Plus, ShieldCheck, UploadCloud, Users } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import type { Course, FileRecord, Group, Project } from "@/types/domain";
import { auditRecord, Badge, Box, Empty, formatDate, formatDateTime, Header, Metric, newId, Notice, Progress, SearchField, Table } from "./primitives";
import styles from "./governance.module.css";

const teacherBase = (courseId: string) => `/teacher/courses/${courseId}`;
const groupHref = (courseId: string, groupId: string) => `${teacherBase(courseId)}/groups/${groupId}`;

function useCourseData(courseId?: string) {
  const workspace = useWorkspace();
  const { data } = workspace;
  const course = data.courses.find((item) => item.id === courseId) ?? data.courses[0];
  const groups = data.groups.filter((item) => item.courseId === course?.id);
  const projects = data.projects.filter((item) => item.courseId === course?.id);
  const actions = data.actionItems.filter((item) => item.courseId === course?.id && item.assigneeId === course?.teacherId);
  return { ...workspace, course, groups, projects, actions };
}

function groupProject(group: Group, projects: Project[]) {
  return projects.find((item) => item.groupId === group.id || item.id === group.projectId);
}

function riskFor(project?: Project) {
  if (!project) return { label: "未开始", tone: "gray" as const };
  if (project.progress < 55) return { label: "高风险", tone: "red" as const };
  if (project.progress < 75) return { label: "中风险", tone: "amber" as const };
  return { label: "低风险", tone: "green" as const };
}

function groupName(group: Group, index: number) {
  return group.name.startsWith("第 ") ? group.name : `第 ${index + 1} 组`;
}

function CourseMissing() {
  return <div className={styles.page}><Header title="课程不存在" description="请从我的课程中选择一门课程。" /></div>;
}

export function TeacherOverview({ courseId }: { courseId?: string }) {
  const { data, course, groups, projects, actions } = useCourseData(courseId);
  if (!course) return <CourseMissing />;
  const progress = projects.length ? Math.round(projects.reduce((sum, item) => sum + item.progress, 0) / projects.length) : 0;
  const highRisk = projects.filter((project) => riskFor(project).tone === "red").length;
  const complete = projects.filter((project) => project.lifecycle === "finalized" || project.progress === 100).length;
  const pending = actions.filter((item) => item.status === "pending");
  const moduleGroups = new Map<string, { count: number; sum: number }>();
  data.modules.filter((module) => projects.some((project) => project.id === module.projectId)).forEach((module) => {
    const current = moduleGroups.get(module.name) ?? { count: 0, sum: 0 };
    moduleGroups.set(module.name, { count: current.count + 1, sum: current.sum + module.progress });
  });
  return (
    <div className={styles.page}>
      <Header title="课程总览" description="查看各小组的整体进度、核心完成情况与需要关注的风险。" breadcrumb={`${course.name} / 课程总览`} action={<Badge tone="gray">{course.semester}</Badge>} />
      <div className={styles.metrics}>
        <Metric label="小组数" value={groups.length} icon={Users} hint="课程内已建立的小组" />
        <Metric label="平均进度" value={`${progress}%`} icon={BarChart3} hint="按小组项目进度汇总" />
        <Metric label="高风险小组" value={highRisk} icon={AlertTriangle} tone="red" hint="需要优先关注" />
        <Metric label="已完成" value={`${complete} 组`} icon={CheckCircle2} tone="green" hint="已完成项目" />
      </div>
      <div className={styles.twoColumns}>
        <Box title="小组进度概览" action={<Link className={styles.link} href={`${teacherBase(course.id)}/groups`}>查看全部</Link>}>
          <Table><thead><tr><th>小组</th><th>整体进度</th><th>已验证模块</th><th>风险</th><th>最近活动</th><th>操作</th></tr></thead><tbody>
            {groups.map((group, index) => {
              const project = groupProject(group, projects);
              const modules = data.modules.filter((item) => item.projectId === project?.id);
              const risk = riskFor(project);
              return <tr key={group.id}><td><strong>{groupName(group, index)}</strong><div className={styles.subtle}>{group.name}</div></td><td><Progress value={project?.progress ?? 0} /></td><td>{modules.filter((item) => item.progress === 100).length} / {modules.length || "—"}</td><td><Badge tone={risk.tone}>{risk.label}</Badge></td><td>{project ? "近期有更新" : "暂无项目"}</td><td><Link className={styles.link} href={groupHref(course.id, group.id)}>查看小组 →</Link></td></tr>;
            })}
          </tbody></Table>
          {groups.length === 0 ? <Empty>课程尚无小组</Empty> : null}
        </Box>
        <div className={styles.sideStack}>
          <Box title={`提醒 (${pending.length})`} action={<Link className={styles.link} href={`${teacherBase(course.id)}/actions`}>查看全部</Link>}>
            <div className={styles.panelBody}>{pending.length ? pending.slice(0, 4).map((item) => <div className={styles.row} key={item.id}><AlertTriangle size={16} color={item.priority === "high" ? "#d43b38" : "#c88104"} /><div className={styles.rowMain}><div className={styles.rowTitle}>{item.title}</div><div className={styles.rowMeta}>{item.description}</div></div><span className={styles.subtle}>{formatDate(item.dueAt)}</span></div>) : <Empty>暂无待处理提醒</Empty>}</div>
          </Box>
          <Box title="模块整体进度" action={<Link className={styles.link} href={`${teacherBase(course.id)}/groups`}>查看小组</Link>}>
            <div className={styles.panelBody}>{Array.from(moduleGroups).map(([name, value]) => <div className={styles.row} key={name}><div className={styles.rowMain}><div className={styles.rowTitle}>{name}</div><div className={styles.rowMeta}>{value.count} 个小组</div></div><Progress value={value.sum / value.count} /></div>)}{moduleGroups.size === 0 ? <Empty>尚无功能模块</Empty> : null}</div>
          </Box>
          <Box title="近期动态"><div className={styles.panelBody}>{data.logs.filter((log) => log.target === course.id || groups.some((group) => log.target === group.id)).slice(0, 3).map((log) => <div className={styles.row} key={log.id}><Clock3 size={15} /><div className={styles.rowMain}><div className={styles.rowTitle}>{log.action}</div><div className={styles.rowMeta}>{log.detail}</div></div></div>)}{data.logs.filter((log) => log.target === course.id).length === 0 ? <Empty>暂无课程动态</Empty> : null}</div></Box>
        </div>
      </div>
    </div>
  );
}

export function TeacherGroups({ courseId }: { courseId?: string }) {
  const { data, course, groups, projects } = useCourseData(courseId);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "progress" | "risk">("name");
  if (!course) return <CourseMissing />;
  const filtered = groups.filter((group) => `${group.name} ${group.direction} ${group.memberIds.map((id) => data.users.find((user) => user.id === id)?.name).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
    const delta = (groupProject(a, projects)?.progress ?? 0) - (groupProject(b, projects)?.progress ?? 0);
    return sort === "progress" ? delta : -delta;
  });
  return <div className={styles.page}>
    <Header title="小组" description="按小组查看进度、核心模块完成情况与风险状态。" breadcrumb={`${course.name} / 小组`} />
    <Box><div className={styles.panelHeading}><strong>共 {filtered.length} 个小组</strong><div className={styles.filters}><SearchField value={query} onChange={setQuery} placeholder="搜索小组或成员" /><select className={styles.select} value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="小组排序"><option value="name">按名称</option><option value="progress">按进度</option><option value="risk">按风险</option></select></div></div>
      <Table><thead><tr><th>小组</th><th>组长</th><th>成员数</th><th>总进度</th><th>核心模块</th><th>风险</th><th>待处理</th><th>操作</th></tr></thead><tbody>{filtered.map((group) => {
        const project = groupProject(group, projects);
        const modules = data.modules.filter((item) => item.projectId === project?.id && item.core);
        const pending = data.actionItems.filter((item) => item.projectId === project?.id && item.status === "pending").length;
        const risk = riskFor(project);
        return <tr key={group.id}><td><Link className={styles.link} href={groupHref(course.id, group.id)}>{group.name}</Link><div className={styles.rowMeta}>{group.direction}</div></td><td>{data.users.find((user) => user.id === group.leaderId)?.name ?? "—"}</td><td>{group.memberIds.length}</td><td><Progress value={project?.progress ?? 0} /></td><td>{modules.length ? modules.map((module) => <Badge key={module.id} tone={module.progress === 100 ? "green" : module.progress > 50 ? "blue" : "gray"}>{module.name}</Badge>) : "—"}</td><td><Badge tone={risk.tone}>{risk.label}</Badge></td><td>{pending}</td><td><Link className={styles.link} href={groupHref(course.id, group.id)}>查看 →</Link></td></tr>;
      })}</tbody></Table>{filtered.length === 0 ? <Empty /> : null}<div className={styles.tableFooter}>教师默认查看摘要；必要时可展开正式任务与证据。</div>
    </Box>
  </div>;
}

export function TeacherGroupDetail({ courseId, groupId }: { courseId?: string; groupId?: string }) {
  const { data, course, groups, projects } = useCourseData(courseId);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!course) return <CourseMissing />;
  const group = groups.find((item) => item.id === groupId) ?? groups[0];
  if (!group) return <div className={styles.page}><Header title="小组不存在" description="请返回小组列表。" /></div>;
  const project = groupProject(group, projects);
  const modules = data.modules.filter((item) => item.projectId === project?.id);
  const verified = modules.filter((item) => item.progress === 100).length;
  const pendingActions = data.actionItems.filter((item) => item.projectId === project?.id && item.status === "pending");
  const risk = riskFor(project);
  return <div className={styles.page}>
    <Header title={group.name} description="优先查看功能模块完成情况；任务与证据仅在需要时展开。" breadcrumb={`${course.name} / 小组 / ${group.name}`} />
    <div className={styles.metrics}>
      <Metric label="总进度" value={`${project?.progress ?? 0}%`} icon={BarChart3} />
      <Metric label="核心流程" value={`${project?.coreProgress ?? 0}%`} icon={ShieldCheck} />
      <Metric label="已验证模块" value={`${verified} / ${modules.length}`} icon={CheckCircle2} tone="green" />
      <Metric label="风险" value={risk.label} icon={AlertTriangle} tone={risk.tone === "red" ? "red" : "amber"} />
    </div>
    <div className={styles.twoColumns}>
      <Box title="功能模块" action={<span className={styles.muted}>按模块查看项目交付</span>}>
        {modules.length ? modules.map((module) => <div key={module.id}>
          <button type="button" className={styles.row} style={{ width: "100%", borderTop: 0, borderLeft: 0, borderRight: 0, background: "none", textAlign: "left", cursor: "pointer", padding: "17px 18px" }} onClick={() => setExpanded(expanded === module.id ? null : module.id)} aria-expanded={expanded === module.id}>
            <BookOpen size={20} color="#2273e8" /><div className={styles.rowMain}><div className={styles.rowTitle}>{module.name}</div><div className={styles.rowMeta}>{module.description}</div></div><div style={{ minWidth: 125 }}><Progress value={module.progress} /></div><Badge tone={module.progress === 100 ? "green" : module.progress < 50 ? "amber" : "blue"}>{module.progress === 100 ? "已验证" : module.progress < 50 ? "待复核" : "进行中"}</Badge>{expanded === module.id ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </button>
          {expanded === module.id ? <div className={styles.panelBody} style={{ background: "#f8fbff" }}><strong>关联任务与正式证据</strong>{data.tasks.filter((task) => task.moduleId === module.id).map((task) => <div className={styles.row} key={task.id}><div className={styles.rowMain}><div className={styles.rowTitle}>{task.title}</div><div className={styles.rowMeta}>状态：{task.status} · 正式证据 {data.evidence.filter((item) => item.taskId === task.id && item.status === "formal").length} 项</div></div><Badge tone={task.status === "completed" ? "green" : "blue"}>{task.status === "completed" ? "已完成" : "进行中"}</Badge></div>)}</div> : null}
        </div>) : <Empty>该项目尚无功能模块</Empty>}
      </Box>
      <div className={styles.sideStack}>
        {risk.tone === "red" || pendingActions.length ? <Notice danger>{risk.tone === "red" ? "该小组进度落后，需要关注核心任务和证据是否可按时交付。" : `该小组有 ${pendingActions.length} 项待处理事项。`}</Notice> : null}
        <Box title="小组信息"><div className={styles.panelBody}><div className={styles.row}><span className={styles.muted}>小组编号</span><strong>{group.name}</strong></div><div className={styles.row}><span className={styles.muted}>所属课程</span><strong>{course.name}</strong></div><div className={styles.row}><span className={styles.muted}>成员人数</span><strong>{group.memberIds.length} 人</strong></div><div className={styles.row}><span className={styles.muted}>组长</span><strong>{data.users.find((user) => user.id === group.leaderId)?.name ?? "—"}</strong></div><div className={styles.row}><span className={styles.muted}>创建时间</span><strong>{formatDate(group.createdAt)}</strong></div></div></Box>
        <Box title="可选操作"><div className={styles.panelBody}><div className={styles.stack}><Link className={styles.button} href={`${teacherBase(course.id)}/appeals`}>查看申诉 <ChevronRight size={15} /></Link><Link className={styles.button} href={`${teacherBase(course.id)}/reports`}>查看报告预览 <ChevronRight size={15} /></Link>{project ? <Link className={styles.button} href={`/projects/${project.id}/tasks?view=list`}>展开任务 <ChevronRight size={15} /></Link> : null}</div></div></Box>
      </div>
    </div>
  </div>;
}

export function TeacherActions({ courseId }: { courseId?: string }) {
  const { course, actions } = useCourseData(courseId);
  const [sort, setSort] = useState<"due" | "priority">("due");
  if (!course) return <CourseMissing />;
  const pending = actions.filter((item) => item.status === "pending").sort((a, b) => sort === "due" ? a.dueAt.localeCompare(b.dueAt) : (a.priority === "high" ? -1 : 1) - (b.priority === "high" ? -1 : 1));
  const appeals = pending.filter((item) => item.type === "appeal").length;
  const members = pending.filter((item) => item.type === "member_change").length;
  return <div className={styles.page}>
    <Header title="待处理" description="仅显示需要教师介入的审批、申诉与规则确认。" breadcrumb={`${course.name} / 待处理`} />
    <div className={styles.metrics}><Metric label="待处理" value={pending.length} icon={AlertTriangle} tone="red" /><Metric label="申诉" value={appeals} icon={FileText} /><Metric label="名单审批" value={members} icon={Users} /><Metric label="近期到期" value={pending.filter((item) => new Date(item.dueAt).getTime() - Date.now() < 3 * 86400000).length} icon={Clock3} tone="amber" /></div>
    <div className={styles.twoColumns}>
      <div className={styles.stack}><div className={styles.sectionHeading}><h2>待处理事项 ({pending.length})</h2><select className={styles.select} value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="排序方式"><option value="due">按截止时间</option><option value="priority">按优先级</option></select></div>{pending.length ? pending.map((item) => <Box key={item.id}><div className={styles.panelBody}><div className={styles.row}><div className={styles.metricIcon}>{item.type === "appeal" ? <FileText size={18} /> : item.type === "member_change" ? <Users size={18} /> : <Info size={18} />}</div><div className={styles.rowMain}><div className={styles.rowTitle}>{item.title}</div><div className={styles.rowMeta}>{item.description}</div></div><Badge tone={item.priority === "high" ? "red" : "amber"}>{item.priority === "high" ? "优先" : "待处理"}</Badge><Link className={styles.primaryButton} href={item.type === "appeal" ? `${teacherBase(course.id)}/appeals` : item.type === "member_change" ? `${teacherBase(course.id)}/member-changes` : `${teacherBase(course.id)}/settings`}>查看</Link></div><div className={styles.rowMeta}>截止 {formatDate(item.dueAt)}</div></div></Box>) : <Box><Empty>暂无需要教师处理的事项</Empty></Box>}</div>
      <Box title="处理原则"><div className={styles.panelBody}><div className={styles.stack}><p>只处理需要教师介入的事项，例如申诉、冻结后名单变更和课程规则确认。</p><p>处理时保留完整记录，包括结果、时间和原因说明。</p><p>学生项目正文与日常任务由小组负责；教师默认从模块和风险摘要进入。</p></div></div></Box>
    </div>
  </div>;
}

export function TeacherReports({ courseId }: { courseId?: string }) {
  const { data, course, groups, projects } = useCourseData(courseId);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  if (!course) return <CourseMissing />;
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const selectedProject = selectedGroup ? groupProject(selectedGroup, projects) : undefined;
  const report = data.reports.find((item) => item.projectId === selectedProject?.id);
  return <div className={styles.page}>
    <Header title="报告" description="查看各组报告状态、完成度与正式贡献结果。" breadcrumb={`${course.name} / 报告`} />
    <Box><Table><thead><tr><th>小组</th><th>报告状态</th><th>完成度</th><th>贡献状态</th><th>申诉</th><th>操作</th></tr></thead><tbody>{groups.map((group) => {
      const project = groupProject(group, projects);
      const report = data.reports.find((item) => item.projectId === project?.id);
      const contributions = data.contributions.filter((item) => item.projectId === project?.id);
      const disputed = contributions.some((item) => item.status === "disputed");
      return <tr key={group.id}><td><Link className={styles.link} href={groupHref(course.id, group.id)}>{group.name}</Link></td><td><Badge tone={report?.status === "finalized" ? "green" : report?.status === "generated" ? "blue" : "gray"}>{report?.status === "finalized" ? "已定稿" : report?.status === "generated" ? "评审中" : "草稿"}</Badge></td><td><Progress value={project?.progress ?? 0} /></td><td><Badge tone={disputed ? "red" : contributions.length ? "green" : "amber"}>{disputed ? "申诉中" : contributions.length ? "已确认" : "未确认"}</Badge></td><td>{disputed ? "1" : "无"}</td><td><button type="button" className={styles.textButton} onClick={() => setSelectedGroupId(group.id)}>{report ? "预览" : "查看"} →</button></td></tr>;
    })}</tbody></Table></Box>
    {selectedGroup ? <Box title={`${selectedGroup.name} · 报告与贡献`} action={<button type="button" className={styles.ghostButton} onClick={() => setSelectedGroupId(null)}>收起</button>}><div className={styles.panelBody}>{report ? <div className={styles.stack}>{report.sections.map((section) => <div key={section.id}><h3 style={{ fontSize: 14, margin: "4px 0" }}>{section.title}</h3><p className={styles.muted} style={{ margin: "4px 0" }}>{section.body}</p></div>)}</div> : <Empty>小组尚未生成报告</Empty>}{selectedProject ? <div className={styles.divider} /> : null}{selectedProject ? <div><strong>正式贡献</strong><div className={styles.row}>{data.contributions.filter((item) => item.projectId === selectedProject.id).map((item) => <span key={item.id}>{data.users.find((user) => user.id === item.memberId)?.name} {item.share}%　</span>)}</div><p className={styles.rowMeta}>相关正式证据 {data.evidence.filter((item) => item.projectId === selectedProject.id && item.status === "formal").length} 项；查看与处理申诉请前往待处理中心。</p></div> : null}</div></Box> : null}
    <Notice>系统报告用于辅助课程评估，不直接替代教师评分；调整贡献时必须保留原始结果、调整结果与原因。</Notice>
  </div>;
}

export function TeacherSettings({ courseId }: { courseId?: string }) {
  const { data, role, update, add, course } = useCourseData(courseId);
  const [tab, setTab] = useState("通用");
  const [name, setName] = useState(course?.name ?? "");
  const [deadline, setDeadline] = useState(course?.projectDeadline ?? "");
  const [formationDeadline, setFormationDeadline] = useState(course?.formationDeadline ?? "");
  const [mode, setMode] = useState<Course["groupingMode"]>(course?.groupingMode ?? "free");
  const [minSize, setMinSize] = useState(course?.minGroupSize ?? 3);
  const [maxSize, setMaxSize] = useState(course?.maxGroupSize ?? 5);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  if (!course) return <CourseMissing />;
  const canEdit = role === "admin" || (role === "teacher" && data.currentUserId === course.teacherId);
  const save = () => {
    if (!canEdit) return;
    if (!name.trim() || minSize < 1 || maxSize < minSize || !deadline || !formationDeadline) { setFeedback("请填写有效的课程名称、日期与组队人数范围。"); return; }
    if (!reason.trim()) { setFeedback("请填写变更原因，以便保留课程规则审计记录。"); return; }
    const changed = name !== course.name || deadline !== course.projectDeadline || formationDeadline !== course.formationDeadline || mode !== course.groupingMode || minSize !== course.minGroupSize || maxSize !== course.maxGroupSize;
    if (!changed) { setFeedback("当前设置没有变更。"); return; }
    update("courses", course.id, { name: name.trim(), projectDeadline: deadline, formationDeadline, groupingMode: mode, minGroupSize: minSize, maxGroupSize: maxSize, version: course.version + 1 });
    add("logs", auditRecord(data, "课程规则变更", course.id, `v${course.version} → v${course.version + 1}；${reason.trim()}；截止日期 ${course.projectDeadline} → ${deadline}；组队方式 ${course.groupingMode} → ${mode}`));
    data.groups.filter((group) => group.courseId === course.id).forEach((group) => add("actionItems", { id: newId("action"), assigneeId: group.leaderId, courseId: course.id, projectId: group.projectId, groupId: group.id, type: "rule", title: `确认 ${course.name} 课程规则 v${course.version + 1}`, description: `教师更新了课程规则，请检查对小组项目的影响。原因：${reason.trim()}`, status: "pending", dueAt: formationDeadline, href: `/courses/${course.id}/rule-changes`, priority: "medium" }));
    setReason(""); setFeedback("课程设置已保存，并通知各小组复核影响。");
  };
  return <div className={styles.page}>
    <Header title="课程设置" description="管理课程规则、截止日期、分组方式和课程文件。" breadcrumb={`${course.name} / 课程设置`} />
    <div className={styles.tabs}>{["通用", "分组规则", "要求文件", "教学团队", "高级"].map((item) => <button key={item} type="button" className={`${styles.tab} ${tab === item ? styles.tabActive : ""}`} onClick={() => setTab(item)}>{item}</button>)}</div>
    <Box><div className={styles.panelBody}>
      {tab === "通用" ? <div className={styles.stack}><h2>基本信息</h2><div className={styles.formGrid}><label className={styles.field}>课程名称<input className={styles.input} value={name} onChange={(event) => setName(event.target.value)} disabled={!canEdit} /></label><label className={styles.field}>项目最终截止日期<input className={styles.input} type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} disabled={!canEdit} /></label></div><Notice>课程规则更新后，各小组会收到影响复核提醒；已冻结的项目基线不会自动覆盖。</Notice></div> : null}
      {tab === "分组规则" ? <div className={styles.stack}><h2>分组设置</h2><div className={styles.equalColumns}><label className={styles.option}><input type="radio" name="group-mode" checked={mode === "free"} onChange={() => setMode("free")} disabled={!canEdit} /><div><strong>自由组队</strong><span>学生按课程规则组建小组</span></div></label><label className={styles.option}><input type="radio" name="group-mode" checked={mode === "approval"} onChange={() => setMode("approval")} disabled={!canEdit} /><div><strong>教师审批</strong><span>新小组需经过教师确认</span></div></label></div><div className={styles.formGrid}><label className={styles.field}>最少人数<input className={styles.input} type="number" min={1} value={minSize} onChange={(event) => setMinSize(Number(event.target.value))} disabled={!canEdit} /></label><label className={styles.field}>最多人数<input className={styles.input} type="number" min={1} value={maxSize} onChange={(event) => setMaxSize(Number(event.target.value))} disabled={!canEdit} /></label><label className={styles.field}>组队截止日期<input className={styles.input} type="date" value={formationDeadline} onChange={(event) => setFormationDeadline(event.target.value)} disabled={!canEdit} /></label></div><Notice>名单冻结后，退出或移除成员须提交申请并经教师审批。</Notice></div> : null}
      {tab === "要求文件" ? <div className={styles.stack}><h2>课程要求文件</h2>{data.files.filter((file) => file.courseId === course.id && file.status === "current").map((file) => <div className={styles.row} key={file.id}><FileText size={17} color="#1767e7" /><div className={styles.rowMain}><strong>{file.name}</strong><div className={styles.rowMeta}>v{file.version} · {file.size} · {formatDate(file.updatedAt)}</div></div></div>)}<Link className={styles.button} href={`${teacherBase(course.id)}/files`}>管理课程文件 <ChevronRight size={15} /></Link></div> : null}
      {tab === "教学团队" ? <div className={styles.stack}><h2>教学团队</h2><div className={styles.row}><Users size={17} /><div className={styles.rowMain}><strong>{data.users.find((user) => user.id === course.teacherId)?.name ?? "课程负责人"}</strong><div className={styles.rowMeta}>课程负责人</div></div><Badge tone="blue">Owner</Badge></div><p className={styles.muted}>助教与其他教师的授权应由课程负责人管理，所有身份变化保留审计记录。</p></div> : null}
      {tab === "高级" ? <div className={styles.stack}><h2>课程状态</h2><div className={styles.row}><span className={styles.rowMain}>当前状态</span><Badge tone={course.status === "active" ? "green" : "gray"}>{course.status === "active" ? "进行中" : course.status === "ended" ? "已结束" : "草稿"}</Badge></div><div className={styles.row}><span className={styles.rowMain}>规则版本</span><strong>v{course.version}</strong></div><Notice>高权限修改会写入审计记录。已归档项目的正式证据与贡献历史仍可查看。</Notice></div> : null}
    </div></Box>
    {(tab === "通用" || tab === "分组规则") && canEdit ? <Box title="保存变更"><div className={styles.panelBody}><label className={styles.field}>变更原因<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明本次课程规则或设置调整的原因" maxLength={500} /></label><div className={styles.actions} style={{ marginTop: 12 }}><button type="button" className={styles.primaryButton} onClick={save}>保存设置</button>{feedback ? <span className={feedback.startsWith("课程设置") ? styles.successMessage : styles.errorMessage}>{feedback}</span> : null}</div></div></Box> : null}
  </div>;
}

export function TeacherRules({ courseId }: { courseId?: string }) {
  const { data, course, groups, role, update, add } = useCourseData(courseId);
  const [rules, setRules] = useState(course?.rules.join("\n") ?? "");
  const [phases, setPhases] = useState<NonNullable<Course["milestoneTemplate"]>>(course?.milestoneTemplate ?? []);
  const [files, setFiles] = useState(course?.requiredFiles ?? []);
  const [newFile, setNewFile] = useState("");
  const [githubRequired, setGithubRequired] = useState(course?.rules.some((rule) => rule.includes("GitHub")) ?? false);
  const [aiAllowed, setAiAllowed] = useState(!course?.rules.some((rule) => rule.includes("不允许") && rule.includes("AI")));
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [preview, setPreview] = useState(false);
  if (!course) return <CourseMissing />;
  const canEdit = role === "admin" || (role === "teacher" && data.currentUserId === course.teacherId);
  const save = () => {
    if (!canEdit) return;
    if (!reason.trim()) { setFeedback("请填写规则变更原因。"); return; }
    if (phases.some((phase) => !phase.title.trim() || !phase.deadline)) { setFeedback("请填写每个阶段的名称与截止日期。"); return; }
    const nextRules = rules.split("\n").map((item) => item.trim()).filter(Boolean).filter((item) => !item.includes("GitHub") && !item.includes("AI 使用"));
    if (githubRequired) nextRules.push("项目需绑定 GitHub 仓库");
    nextRules.push(aiAllowed ? "允许 AI 使用，须在报告中说明范围与贡献" : "不允许项目使用生成式 AI");
    update("courses", course.id, { rules: nextRules, requiredFiles: files, milestoneTemplate: phases, version: course.version + 1 });
    add("logs", auditRecord(data, "课程规则模板变更", course.id, `v${course.version} → v${course.version + 1}；${reason.trim()}`));
    groups.forEach((group) => add("actionItems", { id: newId("action"), assigneeId: group.leaderId, courseId: course.id, projectId: group.projectId, groupId: group.id, type: "rule", title: `复核课程规则模板 v${course.version + 1}`, description: `规则模板更新，原因：${reason.trim()}。请检查现有项目基线的影响。`, status: "pending", dueAt: course.projectDeadline, href: `/courses/${course.id}/rule-changes`, priority: "medium" }));
    setFeedback("规则模板已保存，新项目将使用此版本；现有项目已收到复核提醒。"); setReason("");
  };
  return <div className={styles.page}>
    <Header title="课程规则模板配置" description="定义统一的项目规则、阶段要求与提交标准。" breadcrumb={`${course.name} / 课程设置 / 规则模板`} action={<div className={styles.actions}><button type="button" className={styles.button} onClick={() => setPreview(!preview)}>{preview ? "关闭预览" : "预览效果"}</button>{canEdit ? <button type="button" className={styles.primaryButton} onClick={save}>保存配置</button> : null}</div>} />
    <div className={styles.twoColumns}><div className={styles.stack}>
      <Box title="基本信息"><div className={styles.panelBody}><div className={styles.formGrid}><label className={styles.field}>模板名称<input className={styles.input} value={`${course.name} 项目规则`} readOnly /></label><label className={styles.field}>适用学期<input className={styles.input} value={course.semester} readOnly /></label><label className={`${styles.field} ${styles.fieldFull}`}>项目规则<textarea className={styles.textarea} value={rules} onChange={(event) => setRules(event.target.value)} disabled={!canEdit} maxLength={2000} /><span className={styles.fieldHint}>每行一条规则；保存后生成新的课程规则版本。</span></label></div></div></Box>
      <Box title="阶段 / Milestone" action={canEdit ? <button type="button" className={styles.button} onClick={() => setPhases([...phases, { id: newId("template-phase"), title: "", description: "", deadline: course.projectDeadline }])}><Plus size={15} />添加阶段</button> : null}><div className={styles.panelBody}>{phases.length ? phases.map((phase, index) => <div className={styles.row} key={phase.id} style={{ alignItems: "flex-start" }}><Badge tone="blue">M{index + 1}</Badge><div className={styles.rowMain}><div className={styles.formGrid}><label className={styles.field}>阶段名称<input className={styles.input} value={phase.title} onChange={(event) => setPhases(phases.map((item) => item.id === phase.id ? { ...item, title: event.target.value } : item))} disabled={!canEdit} /></label><label className={styles.field}>截止日期<input className={styles.input} type="date" value={phase.deadline} onChange={(event) => setPhases(phases.map((item) => item.id === phase.id ? { ...item, deadline: event.target.value } : item))} disabled={!canEdit} /></label><label className={`${styles.field} ${styles.fieldFull}`}>主要要求<input className={styles.input} value={phase.description} onChange={(event) => setPhases(phases.map((item) => item.id === phase.id ? { ...item, description: event.target.value } : item))} disabled={!canEdit} /></label></div></div>{canEdit ? <button type="button" className={styles.textButton} onClick={() => setPhases(phases.filter((item) => item.id !== phase.id))}>删除</button> : null}</div>) : <Empty>尚未配置阶段模板</Empty>}<div className={styles.rowMeta}>模板用于新项目。已有项目的里程碑需单独复核，不自动覆盖。</div></div></Box>
      <Box title="必交材料"><div className={styles.panelBody}>{files.map((file, index) => <div className={styles.row} key={`${file}-${index}`}><FileText size={16} color="#1767e7" /><div className={styles.rowMain}>{file}</div><Badge tone="green">必交</Badge>{canEdit ? <button type="button" className={styles.textButton} onClick={() => setFiles(files.filter((_, itemIndex) => itemIndex !== index))}>移除</button> : null}</div>)}{canEdit ? <div className={styles.actions} style={{ marginTop: 14 }}><input className={styles.input} value={newFile} onChange={(event) => setNewFile(event.target.value)} placeholder="添加材料名称" aria-label="添加材料名称" /><button type="button" className={styles.button} onClick={() => { if (newFile.trim()) { setFiles([...files, newFile.trim()]); setNewFile(""); } }}><Plus size={15} />添加</button></div> : null}</div></Box>
    </div><div className={styles.sideStack}>
      <Notice>模板将应用到本课程的新项目。现有项目收到影响复核提醒，冻结基线不自动覆盖。</Notice>
      <Box title="GitHub 要求"><div className={styles.panelBody}><label className={styles.option}><input type="checkbox" checked={githubRequired} onChange={(event) => setGithubRequired(event.target.checked)} disabled={!canEdit} /><div><strong>必须绑定仓库</strong><span>项目需提供可访问的 GitHub 仓库链接。</span></div></label></div></Box>
      <Box title="AI 使用规则"><div className={styles.panelBody}><label className={styles.option}><input type="checkbox" checked={aiAllowed} onChange={(event) => setAiAllowed(event.target.checked)} disabled={!canEdit} /><div><strong>允许使用 AI</strong><span>报告中需说明 AI 的用途、范围与人工复核。</span></div></label></div></Box>
      <Box title="最终报告格式"><div className={styles.panelBody}>固定模板：执行摘要、目标与需求、阶段交付、问题与变更、团队贡献、证据时间线。<div className={styles.rowMeta}>导出 PDF 与 Word。</div></div></Box>
      {canEdit ? <Box title="变更记录"><div className={styles.panelBody}><label className={styles.field}>变更原因<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明本次模板调整原因" maxLength={500} /></label>{feedback ? <div className={feedback.startsWith("规则模板") ? styles.successMessage : styles.errorMessage} style={{ marginTop: 10 }}>{feedback}</div> : null}</div></Box> : null}
    </div></div>
    {preview ? <Box title="学生端规则预览"><div className={styles.panelBody}><strong>{course.name} · {course.semester}</strong><div className={styles.divider} /><p>项目截止：{formatDate(course.projectDeadline)} · 小组人数：{course.minGroupSize}–{course.maxGroupSize} 人</p>{rules.split("\n").filter(Boolean).map((rule, index) => <div className={styles.row} key={`${rule}-${index}`}>{rule}</div>)}<p>必交材料：{files.join("、") || "无"}</p></div></Box> : null}
  </div>;
}

export function TeacherMemberChanges({ courseId }: { courseId?: string }) {
  const { data, course, groups, role, update, add } = useCourseData(courseId);
  const requests = data.actionItems.filter((item) => item.courseId === course?.id && item.type === "member_change");
  const [selectedId, setSelectedId] = useState(requests.find((item) => item.status === "pending")?.id ?? requests[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [handoffs, setHandoffs] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  if (!course) return <CourseMissing />;
  const canDecide = role === "admin" || role === "teacher";
  const request = requests.find((item) => item.id === selectedId);
  const group = groups.find((item) => item.id === request?.groupId);
  const project = data.projects.find((item) => item.groupId === group?.id || item.id === group?.projectId);
  const subject = data.users.find((item) => item.id === request?.subjectUserId);
  const unfinished = data.tasks.filter((task) => task.projectId === project?.id && task.responsibleIds.includes(subject?.id ?? "") && task.status !== "completed");
  const alternatives = group?.memberIds.filter((id) => id !== subject?.id) ?? [];
  const handoffFor = (taskId: string) => handoffs[taskId] ?? request?.handoffAssignments?.[taskId] ?? "";
  const decide = (decision: "approve" | "reject" | "more") => {
    if (!request || !canDecide) return;
    if (request.status !== "pending") { setFeedback("该申请已处理。"); return; }
    if (!reason.trim()) { setFeedback("请先填写审批意见。"); return; }
    if (decision === "approve" && (!group || !subject)) { setFeedback("申请缺少小组或成员关联，无法批准。"); return; }
    if (decision === "approve" && request.changeKind === "join" && group && subject) {
      if (data.groups.some((item) => item.courseId === course.id && item.id !== group.id && item.memberIds.includes(subject.id))) { setFeedback("该学生已加入本课程其他小组，无法重复批准。"); return; }
      if (!group.memberIds.includes(subject.id) && group.memberIds.length >= course.maxGroupSize) { setFeedback("小组已达到课程人数上限。"); return; }
    }
    if (decision === "approve" && group?.leaderId === subject?.id && request.changeKind !== "join") { setFeedback("请先完成全员确认的组长变更，再处理组长退出。"); return; }
    if (decision === "approve" && request.changeKind !== "join" && unfinished.some((task) => !alternatives.includes(handoffFor(task.id)))) { setFeedback("请先为每项未完成任务指定小组内接手成员。"); return; }
    if (decision === "approve" && group && subject) {
      const removeMember = request.changeKind === "leave" || request.changeKind === "remove";
      const nextMembers = removeMember ? group.memberIds.filter((id) => id !== subject.id) : Array.from(new Set([...group.memberIds, subject.id]));
      update("groups", group.id, { memberIds: nextMembers, version: group.version + 1 });
      if (project) update("projects", project.id, { memberIds: removeMember ? project.memberIds.filter((id) => id !== subject.id) : Array.from(new Set([...project.memberIds, subject.id])), version: project.version + 1 });
      if (removeMember) unfinished.forEach((task) => update("tasks", task.id, { responsibleIds: Array.from(new Set([...task.responsibleIds.filter((id) => id !== subject.id), handoffFor(task.id)])), version: task.version + 1, updatedAt: new Date().toISOString() }));
    }
    if (decision !== "more") update("actionItems", request.id, { status: decision === "approve" ? "completed" : "rejected", description: `${request.description} 处理意见：${reason.trim()}` });
    else update("actionItems", request.id, { description: `${request.description} 补充信息要求：${reason.trim()}` });
    add("logs", auditRecord(data, decision === "approve" ? "成员变更批准" : decision === "reject" ? "成员变更驳回" : "成员变更补充信息", group?.id ?? request.id, `${subject?.name ?? "申请人"}；${reason.trim()}；任务交接：${unfinished.map((task) => `${task.id}→${handoffFor(task.id)}`).join("，") || "无"}`));
    setFeedback(decision === "approve" ? "申请已批准，成员名单和未完成任务责任人已更新。" : decision === "reject" ? "申请已驳回并留下完整记录。" : "补充信息要求已记录，申请保持待处理。");
    setReason("");
  };
  return <div className={styles.page}>
    <Header title="成员变更审批" description="冻结后的成员变更需要教师审批，并保留任务交接与处理记录。" breadcrumb={`${course.name} / 待处理 / 成员变更`} />
    <div className={styles.twoColumns}><div className={styles.stack}>
      <div className={styles.filters}><select className={styles.select} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setHandoffs({}); setFeedback(""); }} aria-label="选择成员变更申请">{requests.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status === "pending" ? "待审批" : item.status === "completed" ? "已批准" : "已驳回"}</option>)}</select></div>
      {request ? <Box title={`${group?.name ?? "小组"} · ${request.changeKind === "join" ? "成员加入" : request.changeKind === "remove" ? "成员移除" : "成员退出"}`} action={<Badge tone={request.status === "pending" ? "amber" : request.status === "completed" ? "green" : "red"}>{request.status === "pending" ? "待审批" : request.status === "completed" ? "已批准" : "已驳回"}</Badge>}><div className={styles.panelBody}>
        <div className={styles.row}><span className={styles.muted}>申请人</span><strong>{subject?.name ?? "未关联成员"}</strong><span className={styles.rowMeta}>{subject?.studentId}</span></div><div className={styles.row}><span className={styles.muted}>当前小组</span><strong>{group?.name ?? "—"}</strong></div><div className={styles.row}><span className={styles.muted}>申请原因</span><strong>{request.description}</strong></div><div className={styles.row}><span className={styles.muted}>截止时间</span><strong>{formatDate(request.dueAt)}</strong></div>
        <div className={styles.divider} /><h2>未完成任务交接</h2>{unfinished.length ? <Table><thead><tr><th>任务名称</th><th>状态</th><th>当前进度</th><th>接手人</th></tr></thead><tbody>{unfinished.map((task) => <tr key={task.id}><td>{task.title}</td><td>{task.status}</td><td><Progress value={task.progress} /></td><td>{request.status === "pending" && request.changeKind !== "join" ? <select className={styles.select} value={handoffFor(task.id)} onChange={(event) => { const next = { ...request.handoffAssignments, ...handoffs, [task.id]: event.target.value }; setHandoffs(next); update("actionItems", request.id, { handoffAssignments: next }); }} aria-label={`${task.title} 接手人`}><option value="">请选择成员</option>{alternatives.map((id) => <option key={id} value={id}>{data.users.find((user) => user.id === id)?.name ?? id}</option>)}</select> : data.users.find((user) => user.id === task.responsibleIds.find((id) => id !== subject?.id))?.name ?? "—"}</td></tr>)}</tbody></Table> : <Empty>该成员没有未完成任务</Empty>}
        <div className={styles.divider} /><h2>历史已完成工作</h2><div className={styles.rowMeta}>已完成任务与正式证据保留，不因名单变更删除。</div>{data.tasks.filter((task) => task.projectId === project?.id && task.responsibleIds.includes(subject?.id ?? "") && task.status === "completed").map((task) => <div className={styles.row} key={task.id}>{task.title}<Badge tone="green">已完成</Badge></div>)}
      </div></Box> : <Box><Empty>暂无成员变更申请</Empty></Box>}
    </div>
    <div className={styles.sideStack}><Box title="审批操作"><div className={styles.panelBody}><Notice>请根据申请人的实际情况、任务完成状态及小组意见作出处理。所有操作保留操作者、原因和时间记录。</Notice><label className={styles.field} style={{ marginTop: 16 }}>审批意见<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写审批依据与任务交接说明" maxLength={500} disabled={!canDecide || request?.status !== "pending"} /></label>{request?.status === "pending" && canDecide ? <div className={styles.stack} style={{ marginTop: 14 }}><button type="button" className={styles.primaryButton} onClick={() => decide("approve")}>批准</button><button type="button" className={styles.dangerButton} onClick={() => decide("reject")}>驳回</button><button type="button" className={styles.button} onClick={() => decide("more")}>要求补充信息</button></div> : null}{feedback ? <div className={feedback.startsWith("申请已") || feedback.startsWith("补充") ? styles.successMessage : styles.errorMessage} style={{ marginTop: 12 }}>{feedback}</div> : null}</div></Box>
      <Box title="操作记录说明"><div className={styles.panelBody}><p className={styles.muted}>审批会更新小组名单、项目成员及未完成任务责任人，并写入系统日志。</p></div></Box>
    </div></div>
  </div>;
}

export function TeacherAppeals({ courseId }: { courseId?: string }) {
  const { data, course, projects, role, update, add } = useCourseData(courseId);
  const appeals = data.actionItems.filter((item) => item.courseId === course?.id && item.type === "appeal");
  const [selectedId, setSelectedId] = useState(appeals.find((item) => item.status === "pending")?.id ?? appeals[0]?.id ?? "");
  const [decision, setDecision] = useState<"maintain" | "adjust" | "evidence">("maintain");
  const [adjustedShare, setAdjustedShare] = useState("");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [evidenceTab, setEvidenceTab] = useState<"github" | "screenshot" | "other">("github");
  if (!course) return <CourseMissing />;
  const canDecide = role === "teacher" || role === "admin";
  const appeal = appeals.find((item) => item.id === selectedId);
  const project = projects.find((item) => item.id === appeal?.projectId) ?? projects.find((item) => data.contributions.some((contribution) => contribution.projectId === item.id && contribution.status === "disputed"));
  const contribution = data.contributions.find((item) => item.projectId === project?.id && item.memberId === appeal?.subjectUserId) ?? data.contributions.find((item) => item.projectId === project?.id && item.status === "disputed");
  const member = data.users.find((item) => item.id === contribution?.memberId);
  const task = data.tasks.find((item) => item.id === contribution?.taskIds[0]);
  const relatedEvidence = data.evidence.filter((item) => item.projectId === project?.id && (contribution?.evidenceIds.includes(item.id) || item.taskId === task?.id));
  const filteredEvidence = relatedEvidence.filter((item) => evidenceTab === "github" ? item.source === "github" : evidenceTab === "screenshot" ? item.source === "screenshot" : item.source !== "github" && item.source !== "screenshot");
  const decide = () => {
    if (!appeal || !contribution || !canDecide || appeal.status !== "pending") return;
    if (!reason.trim()) { setFeedback("请填写最终决定说明。"); return; }
    if (decision === "adjust") {
      const share = Number(adjustedShare);
      if (!Number.isFinite(share) || share < 0 || share > 100 || adjustedShare.trim() === "") { setFeedback("请输入 0–100 之间的调整后贡献百分比。"); return; }
      const others = data.contributions.filter((item) => item.projectId === contribution.projectId && item.id !== contribution.id);
      const originalOthers = others.reduce((sum, item) => sum + item.share, 0);
      let allocated = 0;
      others.forEach((item, index) => {
        const nextShare = index === others.length - 1 ? Math.max(0, 100 - share - allocated) : Math.round(((100 - share) * item.share / Math.max(1, originalOthers)) * 100) / 100;
        allocated += nextShare;
        update("contributions", item.id, { share: nextShare });
      });
      update("contributions", contribution.id, { share, status: "formal", note: `${contribution.note} 教师调整：${contribution.share}% → ${share}%；原因：${reason.trim()}` });
      add("logs", auditRecord(data, "贡献申诉调整", contribution.id, `原结果 ${contribution.share}%；调整结果 ${share}%；${reason.trim()}`));
      update("actionItems", appeal.id, { status: "completed", description: `${appeal.description} 决定：调整贡献；${reason.trim()}` });
      setFeedback("申诉已处理，正式贡献与审计记录已更新。");
    } else if (decision === "maintain") {
      update("contributions", contribution.id, { status: "formal", note: `${contribution.note} 教师复核维持原结果；${reason.trim()}` });
      update("actionItems", appeal.id, { status: "completed", description: `${appeal.description} 决定：维持原结果；${reason.trim()}` });
      add("logs", auditRecord(data, "贡献申诉维持", contribution.id, `维持 ${contribution.share}%；${reason.trim()}`));
      setFeedback("申诉已处理，原结果和决定说明已保留。");
    } else {
      update("actionItems", appeal.id, { description: `${appeal.description} 补充证据要求：${reason.trim()}` });
      add("logs", auditRecord(data, "贡献申诉要求补证", appeal.id, reason.trim()));
      setFeedback("补证要求已记录，申诉仍待处理。");
    }
    setReason("");
  };
  return <div className={styles.page}>
    <Header title="申诉处理" description="查看争议说明、关联证据与系统计算结果，并作出最终决定。" breadcrumb={`${course.name} / 待处理 / 申诉处理`} />
    <div className={styles.twoColumns}><div className={styles.stack}>
      <select className={styles.select} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setFeedback(""); }} aria-label="选择申诉">{appeals.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status === "pending" ? "待处理" : "已处理"}</option>)}</select>
      {appeal ? <Box title={`${project?.name ?? "项目"} · 贡献申诉`} action={<Badge tone={appeal.status === "pending" ? "amber" : "green"}>{appeal.status === "pending" ? "待处理" : "已处理"}</Badge>}><div className={styles.panelBody}>
        <div className={styles.row}><span className={styles.muted}>申请人</span><strong>{member?.name ?? "—"}</strong><span className={styles.rowMeta}>{member?.studentId}</span></div><div className={styles.row}><span className={styles.muted}>争议任务</span><strong>{task?.title ?? "贡献分配"}</strong></div><div className={styles.row}><span className={styles.muted}>当前贡献</span><strong>{contribution?.share ?? 0}%</strong></div><div className={styles.row}><span className={styles.muted}>申诉说明</span><strong>{appeal.description}</strong></div>
        <div className={styles.divider} /><h2>关联证据</h2><div className={styles.tabs}>{([["github", "GitHub"], ["screenshot", "截图"], ["other", "其他"]] as const).map(([value, label]) => <button type="button" key={value} className={`${styles.tab} ${evidenceTab === value ? styles.tabActive : ""}`} onClick={() => setEvidenceTab(value)}>{label} ({relatedEvidence.filter((item) => value === "github" ? item.source === "github" : value === "screenshot" ? item.source === "screenshot" : item.source !== "github" && item.source !== "screenshot").length})</button>)}</div>{filteredEvidence.length ? filteredEvidence.map((item) => <div className={styles.row} key={item.id}><FolderOpen size={16} /><div className={styles.rowMain}><div className={styles.rowTitle}>{item.title}</div><div className={styles.rowMeta}>{item.description}</div></div><Badge tone={item.status === "formal" ? "green" : "amber"}>{item.status === "formal" ? "正式" : "待确认"}</Badge></div>) : <Empty>此类证据暂无记录</Empty>}
        <div className={styles.divider} /><h2>系统计算摘要</h2><div className={styles.equalColumns}><div>任务贡献：<strong>{contribution?.taskCredit ?? 0}</strong></div><div>协作贡献：<strong>{contribution?.collaborationCredit ?? 0}</strong></div><div>验收通过率：<strong>{contribution?.acceptanceRate ?? 0}%</strong></div><div>正式份额：<strong>{contribution?.share ?? 0}%</strong></div></div>
      </div></Box> : <Box><Empty>暂无申诉记录</Empty></Box>}
    </div><Box title="处理决定"><div className={styles.panelBody}><div className={styles.stack}>{([["maintain", "维持原结果", "复核后维持系统计算的贡献结果。"], ["adjust", "调整贡献", "根据正式证据调整该成员贡献。"], ["evidence", "退回补充证据", "当前证据不足，要求学生补充材料。"]] as const).map(([value, label, hint]) => <label className={styles.option} key={value}><input type="radio" name="appeal-decision" checked={decision === value} onChange={() => setDecision(value)} disabled={!canDecide || appeal?.status !== "pending"} /><div><strong>{label}</strong><span>{hint}</span></div></label>)}{decision === "adjust" ? <label className={styles.field}>调整后贡献<input className={styles.input} type="number" min={0} max={100} value={adjustedShare} onChange={(event) => setAdjustedShare(event.target.value)} placeholder="0–100%" disabled={!canDecide || appeal?.status !== "pending"} /></label> : null}<label className={styles.field}>最终决定说明<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写处理依据、关键证据与最终决定" maxLength={500} disabled={!canDecide || appeal?.status !== "pending"} /></label>{appeal?.status === "pending" && canDecide ? <button type="button" className={styles.primaryButton} onClick={decide}>完成处理</button> : null}{feedback ? <div className={feedback.startsWith("申诉已") || feedback.startsWith("补证") ? styles.successMessage : styles.errorMessage}>{feedback}</div> : null}</div></div></Box></div>
  </div>;
}

export function TeacherFiles({ courseId }: { courseId?: string }) {
  const { data, course, groups, role, update, add } = useCourseData(courseId);
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  if (!course) return <CourseMissing />;
  const canEdit = role === "admin" || (role === "teacher" && data.currentUserId === course.teacherId);
  const files = data.files.filter((item) => item.courseId === course.id);
  const current = files.filter((item) => item.status !== "superseded" && `${item.name} ${item.type}`.toLowerCase().includes(query.toLowerCase()));
  const selected = selectedName || current[0]?.name;
  const history = files.filter((item) => item.name === selected).sort((a, b) => b.version - a.version);
  const upload = (file: File, replace?: FileRecord) => {
    if (!canEdit) return;
    const extension = file.name.split(".").pop()?.toUpperCase() ?? "";
    if (!["PDF", "DOC", "DOCX", "PPT", "PPTX", "XLS", "XLSX", "MD", "TXT"].includes(extension)) { setFeedback("不支持此文件格式。"); return; }
    if (file.size > 50 * 1024 * 1024) { setFeedback("单个文件不得超过 50MB。"); return; }
    const name = replace?.name ?? file.name;
    const version = Math.max(0, ...files.filter((item) => item.name === name).map((item) => item.version)) + 1;
    add("files", { id: newId("course-file"), courseId: course.id, name, type: extension, source: "课程文件", uploaderId: data.currentUserId, version, status: "draft", updatedAt: new Date().toISOString(), size: file.size >= 1024 * 1024 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB` });
    setSelectedName(name); setFeedback(`已添加 ${name} v${version} 草稿，请填写发布原因后发布。`);
  };
  const publish = (file: FileRecord) => {
    if (!canEdit) return;
    if (!reason.trim()) { setFeedback("发布新版本前请填写变更原因。"); return; }
    files.filter((item) => item.name === file.name && item.status === "current").forEach((item) => update("files", item.id, { status: "superseded" }));
    update("files", file.id, { status: "current", updatedAt: new Date().toISOString() });
    add("logs", auditRecord(data, "课程文件发布", file.id, `${file.name} v${file.version}；${reason.trim()}`));
    groups.forEach((group) => add("actionItems", { id: newId("action"), assigneeId: group.leaderId, courseId: course.id, projectId: group.projectId, groupId: group.id, type: "course_file", title: `复核课程文件 ${file.name} v${file.version}`, description: `课程文件已更新：${reason.trim()}。请检查对现有需求基线的影响。`, status: "pending", dueAt: course.projectDeadline, href: `/courses/${course.id}/rule-changes`, priority: "medium" }));
    setFeedback("新版本已发布，各小组将收到影响复核提醒。"); setReason("");
  };
  return <div className={styles.page}>
    <Header title="课程文件管理" description="上传、替换与发布课程要求文件，并追踪版本历史。" breadcrumb={`${course.name} / 课程文件`} />
    {canEdit ? <label className={styles.dropzone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]); }}><input type="file" hidden accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.md,.txt" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(file); event.target.value = ""; }} /><UploadCloud size={28} /><strong>拖拽文件到此处，或点击上传</strong><span>PDF、DOCX、PPTX、XLSX、MD 等格式，单文件不超过 50MB</span></label> : null}
    <Notice>发布新版本后，系统会提示受影响的小组复核；已冻结的项目基线不会自动覆盖。</Notice>
    {feedback ? <div className={feedback.startsWith("已添加") || feedback.startsWith("新版本") ? styles.successMessage : styles.errorMessage}>{feedback}</div> : null}
    <div className={styles.twoColumns}><Box title="课程文件列表" action={<div style={{ width: 190 }}><SearchField value={query} onChange={setQuery} placeholder="搜索文件名" /></div>}><Table><thead><tr><th>文件名</th><th>类型</th><th>当前版本</th><th>最近更新</th><th>范围</th><th>操作</th></tr></thead><tbody>{current.map((file) => <tr key={file.id}><td><strong>{file.name}</strong></td><td>{file.type}</td><td><Badge tone={file.status === "current" ? "blue" : "amber"}>v{file.version}{file.status === "draft" ? " 草稿" : ""}</Badge></td><td>{formatDateTime(file.updatedAt)}</td><td>全部小组</td><td><div className={styles.actions}><button type="button" className={styles.textButton} onClick={() => setSelectedName(file.name)}>查看</button>{canEdit && file.status === "draft" ? <button type="button" className={styles.textButton} onClick={() => publish(file)}>发布</button> : null}{canEdit ? <label className={styles.textButton} style={{ cursor: "pointer" }}>替换<input type="file" hidden accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.md,.txt" onChange={(event) => { const selectedFile = event.target.files?.[0]; if (selectedFile) upload(selectedFile, file); event.target.value = ""; }} /></label> : null}</div></td></tr>)}</tbody></Table>{current.length === 0 ? <Empty>暂无课程文件</Empty> : null}</Box>
      <div className={styles.sideStack}><Box title="版本历史"><div className={styles.panelBody}><strong>{selected || "请选择文件"}</strong>{history.map((file) => <div className={styles.row} key={file.id}><div className={styles.rowMain}><Badge tone={file.status === "current" ? "blue" : file.status === "draft" ? "amber" : "gray"}>v{file.version}</Badge><div className={styles.rowMeta}>{formatDateTime(file.updatedAt)} · {data.users.find((user) => user.id === file.uploaderId)?.name ?? "—"}</div></div><span className={styles.muted}>{file.status === "current" ? "已发布" : file.status === "draft" ? "草稿" : "历史"}</span></div>)}{history.length === 0 ? <Empty>暂无版本记录</Empty> : null}</div></Box>{canEdit ? <Box title="发布说明"><div className={styles.panelBody}><label className={styles.field}>本次文件更新原因<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="说明内容变化及可能影响的小组" /></label></div></Box> : null}</div>
    </div>
  </div>;
}
