"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileText,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { EmptyState, PageHeader, Panel, ProgressBar, StatusBadge } from "@/components/common";
import type { ActionItem, Course, Group, Project, User } from "@/types/domain";

type Screen = 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40;

const button = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const secondary = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const input = "w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const label = "mb-1.5 block text-xs font-semibold text-slate-600";
const muted = "text-sm text-slate-500";

function cid(courseId: string, suffix = "") { return `/courses/${courseId}${suffix}`; }
function gid(courseId: string, groupId: string, suffix = "") { return `${cid(courseId, "/groups")}/${groupId}${suffix}`; }
function byId<T extends { id: string }>(rows: T[], id: string) { return rows.find((row) => row.id === id); }
function nextId(prefix: string) { return `${prefix}-${Date.now().toString(36)}`; }
function dateOnly(value: string) { return value.slice(0, 10); }
function isFrozen(course: Course, group?: Group) { return Boolean(group?.rosterFrozen) || dateOnly(course.formationDeadline) < new Date().toISOString().slice(0, 10); }
function courseTitle(course: Course) { return course.name; }
function statusText(status: Course["status"]) { return status === "active" ? "进行中" : status === "ended" ? "已结束" : "未开始"; }

function Header({ title, description, crumbs, action }: { title: string; description?: string; crumbs?: { title: string; href?: string }[]; action?: React.ReactNode }) {
  return <header className="mb-6">
    {crumbs && <nav aria-label="面包屑导航" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">{crumbs.map((item, index) => <span key={`${item.title}-${index}`} className="inline-flex items-center gap-1.5">{index > 0 && <span>/</span>}{item.href ? <Link href={item.href} className="hover:text-blue-600">{item.title}</Link> : item.title}</span>)}</nav>}
    <PageHeader title={title} description={description} actions={action} />
  </header>;
}

function Box({ title, action, children, className = "" }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <Panel title={title} action={action} className={className}>{children}</Panel>;
}

function Badge({ children, tone = "blue" }: { children: React.ReactNode; tone?: "blue" | "green" | "amber" | "gray" | "red" }) {
  return <StatusBadge tone={tone} label={String(children)} />;
}

function Bar({ value }: { value: number }) { return <ProgressBar value={value} />; }

function Tabs({ items, active, onChange }: { items: string[]; active: string; onChange: (item: string) => void }) {
  return <div role="tablist" className="mb-5 flex flex-wrap gap-6 border-b border-slate-200">{items.map((item) => <button key={item} type="button" role="tab" aria-selected={active === item} onClick={() => onChange(item)} className={`border-b-2 pb-3 text-sm font-medium ${active === item ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{item}</button>)}</div>;
}

function Steps({ items, current }: { items: string[]; current: number }) { return <ol className="mx-auto mb-7 flex max-w-xl items-center justify-center gap-3 text-xs">{items.map((item, index) => <li key={item} className="flex flex-1 items-center gap-2"><span className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${index <= current ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 text-slate-400"}`}>{index < current ? <Check size={14} /> : index + 1}</span><span className={index === current ? "font-semibold text-blue-600" : "text-slate-400"}>{item}</span>{index < items.length - 1 && <span className="ml-2 h-px flex-1 bg-slate-200" />}</li>)}</ol>; }

function Notice({ children, tone = "blue" }: { children: React.ReactNode; tone?: "blue" | "amber" | "green" }) { return <div role="status" className={`rounded border px-4 py-3 text-sm ${tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-800" : tone === "green" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-blue-200 bg-blue-50 text-slate-600"}`}>{children}</div>; }

function Empty({ text }: { text: string }) { return <EmptyState title={text} />; }

export function CourseView({ screen, courseId = "course-1", groupId = "group-1" }: { screen: Screen | number; courseId?: string; groupId?: string }) {
  const workspace = useWorkspace();
  const { data } = workspace;
  const course = byId(data.courses, courseId) ?? data.courses[0];
  const routeGroup = byId(data.groups, groupId);
  const group = (routeGroup?.courseId === course?.id ? routeGroup : undefined) ?? data.groups.find((item) => item.courseId === course?.id && item.memberIds.includes(data.currentUserId));
  const user = byId(data.users, data.currentUserId);
  if (!course && screen !== 31 && screen !== 32) return <Empty text="暂无课程" />;
  switch (screen) {
    case 31: return <MyCourses {...workspace} />;
    case 32: return <JoinCourse {...workspace} />;
    case 33: return <Groups {...workspace} course={course} user={user} />;
    case 34: return <Members {...workspace} course={course} group={group} user={user} />;
    case 35: return <NewCourseProject {...workspace} course={course} group={group} />;
    case 36: return <ChangeLeader {...workspace} course={course} group={group} user={user} />;
    case 37: return <LeaveGroup {...workspace} course={course} group={group} user={user} />;
    case 38: return <RuleChanges {...workspace} course={course} />;
    case 39: return <ReopenProject {...workspace} course={course} group={group} />;
    case 40: return <CourseRules {...workspace} course={course} />;
    default: return <Empty text="页面不存在" />;
  }
}

type Workspace = ReturnType<typeof useWorkspace>;
type Context = Workspace & { course: Course; group?: Group; user?: User };

function MyCourses({ data }: Workspace) {
  const [tab, setTab] = useState("全部课程");
  const courses = data.courses.filter((course) => course.memberIds.includes(data.currentUserId));
  const visible = courses.filter((course) => tab === "全部课程" || (tab === "进行中" && course.status === "active") || (tab === "已结束" && course.status === "ended"));
  const pending = data.actionItems.filter((item) => item.assigneeId === data.currentUserId && item.courseId && item.status === "pending").slice(0, 3);
  return <div><Header title="我的课程" description="查看你已加入的课程、组队状态和课程项目入口。" crumbs={[{ title: "首页", href: "/home" }, { title: "我的课程" }]} action={<Link href="/courses/join" className={button}><Plus size={15} />加入课程</Link>} />
    <Tabs items={["全部课程", "进行中", "已结束"]} active={tab} onChange={setTab} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]"><div className="space-y-3">{visible.length ? visible.map((course) => {
      const teacher = byId(data.users, course.teacherId);
      const group = data.groups.find((item) => item.courseId === course.id && item.memberIds.includes(data.currentUserId));
      const project = group?.projectId ? byId(data.projects, group.projectId) : undefined;
      return <Box key={course.id}><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-slate-900">{courseTitle(course)}</h2><p className="mt-1 text-xs text-slate-500">授课教师：{teacher?.name ?? "待指定"} · {course.code}</p></div><Badge tone={course.status === "active" ? "green" : "gray"}>{group ? statusText(course.status) : "组队中"}</Badge></div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500"><span>{group ? `当前小组：${group.name}` : "尚未加入小组"}</span><span>{project ? `项目进度 ${project.progress}%` : `组队截止 ${dateOnly(course.formationDeadline)}`}</span>{project && <span>截止 {dateOnly(course.projectDeadline)}</span>}</div>{project && <div className="mt-3"><Bar value={project.progress} /></div>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><Link href={cid(course.id, "/rules")} className="font-medium text-blue-600 hover:underline">{course.status === "ended" ? "查看历史" : "查看课程规则"} <ArrowRight size={14} className="inline" /></Link><Link href={group ? (project ? `/projects/${project.id}` : cid(course.id, "/projects/new")) : cid(course.id, "/groups")} className="font-medium text-blue-600 hover:underline">{group ? "进入课程" : "开始组队"} <ArrowRight size={14} className="inline" /></Link></div>
      </Box>;
    }) : <Box><Empty text="当前筛选下暂无课程" /></Box>}</div>
      <Box title="课程待处理" action={<Link href="/action-items" className="text-xs font-medium text-blue-600">查看全部</Link>}>{pending.length ? <div className="divide-y divide-slate-100">{pending.map((item) => <Link key={item.id} href={item.href} className="flex items-center justify-between gap-3 py-3 text-sm hover:text-blue-600"><span>{item.title}</span><span className="shrink-0 text-xs text-amber-600">{dateOnly(item.dueAt)}</span></Link>)}</div> : <Empty text="暂无课程待处理事项" />}</Box>
    </div></div>;
}

function JoinCourse({ data, update }: Workspace) {
  const [step, setStep] = useState(0);
  const [code, setCode] = useState("");
  const [match, setMatch] = useState<Course>();
  const [error, setError] = useState("");
  const user = byId(data.users, data.currentUserId);
  const findCourse = () => {
    const found = data.courses.find((course) => course.code.toLowerCase() === code.trim().toLowerCase() || `${course.code}-GP`.toLowerCase() === code.trim().toLowerCase());
    if (!code.trim()) { setError("请输入课程邀请码"); return; }
    if (!found) { setError("未找到该课程，请核对邀请码"); return; }
    if (!user?.verified) { setError("请先完成学校邮箱验证"); return; }
    setMatch(found); setError(""); setStep(1);
  };
  const join = () => { if (!match) return; update("courses", match.id, { memberIds: [...new Set([...match.memberIds, data.currentUserId])] }); setStep(2); };
  return <div><Header title="加入课程" description="输入课程邀请码，确认课程信息后加入。" crumbs={[{ title: "我的课程", href: "/courses" }, { title: "加入课程" }]} /><div className="mx-auto max-w-[740px]"><Steps items={["输入邀请码", "确认课程", "加入成功"]} current={step} />
    {step === 0 && <><Box title="课程邀请码"><label className={label} htmlFor="invite-code">输入教师提供的邀请码</label><input id="invite-code" className={input} value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") findCourse(); }} placeholder="例如 SE2026-GP" />{user?.verified ? <div className="mt-4"><Notice>已完成学校身份验证 · {user.email}</Notice></div> : <div className="mt-4"><Notice tone="amber">加入课程前需要验证学校邮箱。<Link className="ml-1 text-blue-600 underline" href="/onboarding/email-verification">前往验证</Link></Notice></div>}{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}<div className="mt-4 flex justify-end"><button type="button" onClick={findCourse} className={button}>下一步 <ArrowRight size={15} /></button></div></Box><div className="mt-4"><Box title="加入说明"><div className="divide-y divide-slate-100 text-sm text-slate-600"><p className="py-2">邀请码仅用于指定课程，加入前会显示课程基本信息。</p><p className="py-2">加入课程后，可按照课程规则创建或加入小组。</p><p className="py-2">课程内容仅对已验证的学生与教师开放。</p></div></Box></div></>}
    {step === 1 && match && <Box title="确认课程"><div className="space-y-4 text-sm"><DataRow name="课程" value={courseTitle(match)} /><DataRow name="课程代码" value={match.code} /><DataRow name="授课教师" value={byId(data.users, match.teacherId)?.name ?? "待指定"} /><DataRow name="组队方式" value={match.groupingMode === "free" ? "自由组队" : "加入需教师审批"} /><DataRow name="组队截止" value={dateOnly(match.formationDeadline)} /></div><div className="mt-6 flex justify-end gap-2"><button className={secondary} onClick={() => setStep(0)}>上一步</button><button className={button} onClick={join}>确认加入</button></div></Box>}
    {step === 2 && match && <Box><div className="py-8 text-center"><CheckCircle2 size={42} className="mx-auto text-emerald-600" /><h2 className="mt-4 text-xl font-semibold">已加入{match.name}</h2><p className="mt-2 text-sm text-slate-500">接下来可以查看规则并加入课程小组。</p><div className="mt-6 flex justify-center gap-2"><Link href={cid(match.id, "/rules")} className={secondary}>查看课程规则</Link><Link href={cid(match.id, "/groups")} className={button}>开始组队 <ArrowRight size={15} /></Link></div></div></Box>}
  </div></div>;
}

function DataRow({ name, value }: { name: string; value: React.ReactNode }) { return <div className="grid gap-2 border-b border-slate-100 py-2 last:border-b-0 sm:grid-cols-[145px_1fr]"><span className="text-slate-400">{name}</span><span className="text-slate-700">{value}</span></div>; }

function Groups({ data, add, update, course, user }: Workspace & { course: Course; user?: User }) {
  const router = useRouter();
  const [tab, setTab] = useState("可加入的小组");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("");
  const [feedback, setFeedback] = useState("");
  const groups = data.groups.filter((group) => group.courseId === course.id);
  const mine = groups.find((group) => group.memberIds.includes(data.currentUserId));
  const frozen = isFrozen(course);
  const enrolled = course.memberIds.includes(data.currentUserId) && Boolean(user?.verified);
  const displayed = tab === "可加入的小组" ? groups : groups.filter((group) => group.leaderId === data.currentUserId);
  const requestJoin = (group: Group) => {
    if (!enrolled) { setFeedback("请先加入课程并完成学校邮箱验证。"); return; }
    if (mine) { setFeedback(`你已加入${mine.name}，同一课程只能加入一个小组。`); return; }
    if (isFrozen(course, group)) { setFeedback("组队已截止，请联系教师处理成员变更。"); return; }
    if (group.memberIds.length >= course.maxGroupSize) { setFeedback("该小组已达到人数上限。"); return; }
    if (course.groupingMode === "approval") {
      const action: ActionItem = { id: nextId("action"), assigneeId: course.teacherId, courseId: course.id, groupId: group.id, subjectUserId: data.currentUserId, changeKind: "join", type: "member_change", title: `${user?.name ?? "学生"}申请加入${group.name}`, description: `小组 ${group.name} 加入申请`, status: "pending", dueAt: course.formationDeadline, href: `/teacher/courses/${course.id}/member-changes`, priority: "medium" };
      add("actionItems", action); setFeedback("加入申请已提交，等待教师审批。"); return;
    }
    update("groups", group.id, { memberIds: [...group.memberIds, data.currentUserId] });
    const project = group.projectId ? byId(data.projects, group.projectId) : undefined;
    if (project) update("projects", project.id, { memberIds: [...new Set([...project.memberIds, data.currentUserId])] });
    router.push(gid(course.id, group.id));
  };
  const createGroup = () => {
    if (!enrolled) { setFeedback("请先加入课程并完成学校邮箱验证。"); return; }
    if (mine) { setFeedback("同一课程只能加入一个小组。"); return; }
    if (frozen) { setFeedback("组队已截止，无法创建小组。"); return; }
    if (!name.trim() || !direction.trim()) { setFeedback("请填写小组名称与项目方向。"); return; }
    const group: Group = { id: nextId("group"), courseId: course.id, name: name.trim(), direction: direction.trim(), leaderId: data.currentUserId, memberIds: [data.currentUserId], rosterFrozen: false, createdAt: new Date().toISOString(), version: 1 };
    add("groups", group); router.push(gid(course.id, group.id));
  };
  return <div><Header title="课程内组队" description="按照课程规则创建或加入小组。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: "组队" }]} />
    {feedback && <div className="mb-4"><Notice tone="amber">{feedback}</Notice></div>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]"><div><Tabs items={[`可加入的小组 (${groups.length})`, `我创建的小组 (${groups.filter((group) => group.leaderId === data.currentUserId).length})`]} active={tab === "可加入的小组" ? `可加入的小组 (${groups.length})` : `我创建的小组 (${groups.filter((group) => group.leaderId === data.currentUserId).length})`} onChange={(item) => setTab(item.startsWith("可加入") ? "可加入的小组" : "我创建的小组")} />
      <Box>{displayed.length ? <div className="divide-y divide-slate-100">{displayed.map((group) => <div key={group.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"><div><h3 className="text-sm font-semibold">{group.name}</h3><p className="mt-1 text-xs text-slate-500">当前成员 {group.memberIds.length}/{course.maxGroupSize} · 项目方向：{group.direction}</p></div><div className="flex items-center gap-3"><span className="text-sm text-emerald-700">{group.memberIds.length}/{course.maxGroupSize}</span>{group.memberIds.includes(data.currentUserId) ? <Link className={secondary} href={gid(course.id, group.id)}>查看小组</Link> : <button className={button} onClick={() => requestJoin(group)} disabled={!enrolled || group.memberIds.length >= course.maxGroupSize || frozen}>{group.memberIds.length >= course.maxGroupSize ? "已满" : "加入"}</button>}</div></div>)}</div> : <Empty text="暂无小组" />}</Box>
    </div><div className="space-y-4"><Box title="组队规则"><div className="text-sm"><DataRow name="组队模式" value={course.groupingMode === "free" ? "自由组队" : "教师审批"} /><DataRow name="人数要求" value={`${course.minGroupSize}–${course.maxGroupSize} 人`} /><DataRow name="组队截止" value={dateOnly(course.formationDeadline)} /><DataRow name="教师审批" value={course.groupingMode === "free" ? "无需审批" : "需要审批"} /></div></Box><Box title="没有合适的小组？"><p className={`${muted} mb-4`}>你可以创建自己的小组并邀请同学加入。</p><button className={button} onClick={() => setCreating((value) => !value)} disabled={!enrolled || Boolean(mine) || frozen}><Plus size={15} />创建新小组</button>{creating && <div className="mt-4 space-y-3"><div><label className={label} htmlFor="group-name">小组名称</label><input id="group-name" className={input} value={name} onChange={(event) => setName(event.target.value)} /></div><div><label className={label} htmlFor="group-direction">项目方向</label><input id="group-direction" className={input} value={direction} onChange={(event) => setDirection(event.target.value)} /></div><button className={button} onClick={createGroup}>确认创建</button></div>}</Box></div></div>
  </div>;
}

function Members({ data, add, update, course, group }: Context) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteId, setInviteId] = useState("");
  const [menuId, setMenuId] = useState("");
  const [feedback, setFeedback] = useState("");
  if (!group) return <Empty text="尚未加入课程小组" />;
  const leader = group.leaderId === data.currentUserId;
  const available = data.users.filter((item) => course.memberIds.includes(item.id) && !group.memberIds.includes(item.id) && !data.groups.some((row) => row.courseId === course.id && row.memberIds.includes(item.id)));
  const invite = () => {
    if (!inviteId) { setFeedback("请选择一位成员。"); return; }
    if (group.memberIds.length >= course.maxGroupSize) { setFeedback("小组已达到人数上限。"); return; }
    if (isFrozen(course, group)) {
      const action: ActionItem = { id: nextId("action"), assigneeId: course.teacherId, courseId: course.id, groupId: group.id, subjectUserId: inviteId, changeKind: "join", projectId: group.projectId, type: "member_change", title: `${group.name}成员加入申请`, description: `拟邀请${byId(data.users, inviteId)?.name ?? "学生"}加入小组`, status: "pending", dueAt: course.projectDeadline, href: `/teacher/courses/${course.id}/member-changes`, priority: "medium" };
      add("actionItems", action); setFeedback("成员加入申请已提交教师审批。"); return;
    }
    update("groups", group.id, { memberIds: [...group.memberIds, inviteId] });
    const project = group.projectId ? byId(data.projects, group.projectId) : undefined;
    if (project) update("projects", project.id, { memberIds: [...new Set([...project.memberIds, inviteId])] });
    setInviteOpen(false); setInviteId(""); setFeedback("成员已加入小组。");
  };
  const removeMember = (memberId: string) => {
    if (isFrozen(course, group)) { setFeedback("成员名单已冻结，请通过成员变更审批处理。"); return; }
    if (data.tasks.some((task) => task.projectId === group.projectId && task.responsibleIds.includes(memberId) && task.status !== "completed")) { setFeedback("该成员仍有未完成任务，请先重新分配任务。"); return; }
    update("groups", group.id, { memberIds: group.memberIds.filter((id) => id !== memberId) });
    const project = group.projectId ? byId(data.projects, group.projectId) : undefined;
    if (project) update("projects", project.id, { memberIds: project.memberIds.filter((id) => id !== memberId) });
    setMenuId(""); setFeedback("成员已移出小组，历史记录仍会保留。");
  };
  return <div><Header title="小组成员管理" description="查看成员身份、账号绑定与成员变更状态。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: group.name, href: cid(course.id, "/groups") }]} />{feedback && <div className="mb-4"><Notice tone="green">{feedback}</Notice></div>}
    <Box title={group.name} action={leader && <button className={button} onClick={() => setInviteOpen((value) => !value)}><Plus size={15} />邀请成员</button>}><p className="-mt-2 mb-4 text-xs text-slate-500">{courseTitle(course)}</p>{inviteOpen && <div className="mb-4 flex flex-wrap gap-2 rounded bg-slate-50 p-3"><select className={`${input} max-w-sm`} aria-label="选择要邀请的课程成员" value={inviteId} onChange={(event) => setInviteId(event.target.value)}><option value="">选择课程成员</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.studentId}</option>)}</select><button className={button} onClick={invite}>确认邀请</button></div>}
      <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="border-b border-slate-100 text-xs text-slate-400"><tr><th className="py-3 font-medium">成员</th><th className="font-medium">学号</th><th className="font-medium">账号绑定</th><th className="font-medium">身份状态</th><th className="font-medium">操作</th></tr></thead><tbody>{group.memberIds.map((id) => { const member = byId(data.users, id); if (!member) return null; return <tr key={id} className="border-b border-slate-100 last:border-0"><td className="py-3 font-medium">{member.name}<div className="text-xs font-normal text-slate-400">{id === group.leaderId ? "组长" : "成员"}</div></td><td>{member.studentId ?? "—"}</td><td> {id === data.currentUserId ? "已绑定 GitHub / 飞书" : "账号已连接"}</td><td><Badge tone={member.verified ? "green" : "amber"}>{member.verified ? "已验证" : "待完善"}</Badge></td><td className="relative"><button className="inline-flex items-center gap-1 text-xs font-medium text-slate-600" onClick={() => setMenuId(menuId === id ? "" : id)}>更多 <MoreHorizontal size={14} /></button>{menuId === id && <div className="absolute right-0 z-10 min-w-32 rounded border border-slate-200 bg-white p-1 shadow-lg"><Link className="block rounded px-3 py-2 text-xs hover:bg-slate-50" href={gid(course.id, group.id, "/change-leader")}>更换组长</Link>{leader && id !== group.leaderId && <button className="block w-full rounded px-3 py-2 text-left text-xs text-red-600 hover:bg-slate-50" onClick={() => removeMember(id)}>移出成员</button>}</div>}</td></tr>; })}</tbody></table></div></Box>
    <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]"><Box title="小组信息"><DataRow name="创建时间" value={dateOnly(group.createdAt)} /><DataRow name="组队截止" value={dateOnly(course.formationDeadline)} /><DataRow name="当前人数" value={`${group.memberIds.length} / ${course.maxGroupSize}`} /><DataRow name="当前项目" value={group.projectId ? <Link className="text-blue-600" href={`/projects/${group.projectId}`}>{byId(data.projects, group.projectId)?.name ?? group.projectId}</Link> : <Link className="text-blue-600" href={cid(course.id, "/projects/new")}>创建课程项目</Link>} /><div className="mt-3 flex gap-4 text-sm"><Link href={gid(course.id, group.id, "/change-leader")} className="text-blue-600">更换组长</Link><Link href={gid(course.id, group.id, "/leave")} className="text-blue-600">退出小组</Link></div></Box><Box title="成员变更"><p className={muted}>组队截止前可自由调整；截止后退出或加入成员需要正式申请并保留变更记录。</p></Box></div>
  </div>;
}

function NewCourseProject({ data, add, update, course, group }: Context) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("GroupProof");
  const [description, setDescription] = useState("面向学生小组项目的证据驱动协作与贡献量化平台。");
  const [template, setTemplate] = useState("course");
  const [error, setError] = useState("");
  const ownGroup = group?.memberIds.includes(data.currentUserId) ? group : data.groups.find((item) => item.courseId === course.id && item.memberIds.includes(data.currentUserId));
  const existing = ownGroup?.projectId ? byId(data.projects, ownGroup.projectId) : undefined;
  const next = () => { if (step === 0 && !name.trim()) { setError("请输入项目名称"); return; } setError(""); setStep((value) => Math.min(2, value + 1)); };
  const create = () => {
    if (!ownGroup) { setError("请先加入课程小组"); return; }
    if (existing) { router.push(`/projects/${existing.id}`); return; }
    const id = nextId("project");
    const project: Project = { id, courseId: course.id, groupId: ownGroup.id, name: name.trim(), description: description.trim(), type: "course", finalDeadline: course.projectDeadline, setupStep: 0, setupStatus: "not_initialized", baselineVersion: 0, planVersion: 0, planConfirmed: false, confirmedBy: [], lifecycle: "active", progress: 0, coreProgress: 0, memberIds: ownGroup.memberIds, version: 1 };
    add("projects", project);
    if (template === "course") course.milestoneTemplate?.forEach((item) => add("milestones", { id: nextId(`milestone-${item.id}`), projectId: id, title: item.title, description: item.description, deadline: item.deadline, status: "not_started", progress: 0, taskIds: [], deliverables: [] }));
    update("groups", ownGroup.id, { projectId: id }); router.push(`/projects/${id}`);
  };
  return <div><Header title="创建课程项目" description="基于课程规则创建小组项目，并自动带入课程要求。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: "创建项目" }]} /><div className="mx-auto max-w-[880px]"><Steps items={["基本信息", "应用课程规则", "确认创建"]} current={step} />
    {!ownGroup && <div className="mb-4"><Notice tone="amber">请先加入课程小组。<Link className="ml-1 text-blue-600 underline" href={cid(course.id, "/groups")}>前往组队</Link></Notice></div>}{existing && <div className="mb-4"><Notice tone="amber">当前小组已有课程项目。<Link className="ml-1 text-blue-600 underline" href={`/projects/${existing.id}`}>进入项目</Link></Notice></div>}
    <Box>{step === 0 ? <div className="space-y-4"><div><label className={label} htmlFor="project-name">项目名称</label><input id="project-name" className={input} value={name} onChange={(event) => setName(event.target.value)} /></div><div><label className={label}>所属课程</label><div className={`${input} bg-slate-50`}>{courseTitle(course)}</div></div><div><label className={label} htmlFor="project-description">项目简介</label><textarea id="project-description" className={`${input} min-h-24`} value={description} onChange={(event) => setDescription(event.target.value)} /></div><div><label className={label} htmlFor="course-template">课程项目模板（可选）</label><select id="course-template" className={input} value={template} onChange={(event) => setTemplate(event.target.value)}><option value="course">{course.name}课程项目模板</option><option value="none">不使用模板</option></select><p className="mt-1 text-xs text-slate-400">自动导入项目阶段、必交材料、课程规则与最终截止日期。</p></div><Notice>将自动带入课程要求<br />课程最终截止：{dateOnly(course.projectDeadline)} · 必交：{course.requiredFiles.join("、") || "项目报告、代码仓库"}</Notice></div> : step === 1 ? <div className="space-y-4 text-sm"><h2 className="font-semibold">课程规则</h2><DataRow name="组队方式" value={course.groupingMode === "free" ? "自由组队" : "教师审批"} /><DataRow name="项目截止" value={dateOnly(course.projectDeadline)} /><DataRow name="GitHub" value={course.rules.find((rule) => rule.includes("GitHub")) ?? "按课程要求绑定仓库"} /><div><h3 className="mb-2 font-medium">必交材料</h3><ul className="list-inside list-disc space-y-1 text-slate-600">{course.requiredFiles.map((file) => <li key={file}>{file}</li>)}</ul></div><Notice>课程规则优先于项目规则；后续变更会显示影响并要求确认。</Notice></div> : <div className="space-y-3 text-sm"><h2 className="font-semibold">确认创建</h2><DataRow name="项目名称" value={name} /><DataRow name="所属课程" value={courseTitle(course)} /><DataRow name="小组" value={ownGroup?.name ?? "未加入"} /><DataRow name="截止日期" value={dateOnly(course.projectDeadline)} /><DataRow name="模板" value={template === "course" ? `${course.name}课程项目模板` : "不使用模板"} /><p className="text-slate-500">创建后将进入项目初始化。</p></div>}{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}<div className="mt-6 flex justify-end gap-2"><button className={secondary} onClick={() => step ? setStep(step - 1) : router.push(cid(course.id, "/groups"))}>{step ? "上一步" : "取消"}</button><button className={button} onClick={step === 2 ? create : next} disabled={!ownGroup || Boolean(existing)}>{step === 2 ? "创建项目" : "下一步"}</button></div></Box>
  </div></div>;
}

function ChangeLeader({ data, add, update, course, group, user }: Context) {
  const [candidate, setCandidate] = useState("");
  const [reason, setReason] = useState("");
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10));
  const [feedback, setFeedback] = useState("");
  if (!group) return <Empty text="尚未加入课程小组" />;
  const prefix = `leader_change:${group.id}:`;
  const pending = data.actionItems.filter((item) => item.type.startsWith(prefix) && item.status === "pending");
  const all = data.actionItems.filter((item) => item.type.startsWith(prefix));
  const requestedLeaderId = (pending[0] ?? all.at(-1))?.type.slice(prefix.length);
  const confirm = () => {
    const mine = pending.find((item) => item.assigneeId === data.currentUserId);
    if (!mine) return;
    update("actionItems", mine.id, { status: "completed" });
    if (pending.length === 1 && requestedLeaderId) { update("groups", group.id, { leaderId: requestedLeaderId }); setFeedback("全部成员已确认，新组长已生效。"); }
    else setFeedback("已确认，等待其他成员确认。");
  };
  const submit = () => {
    if (!candidate || !reason.trim()) { setFeedback("请选择新组长并填写申请原因。"); return; }
    if (all.some((item) => item.status === "pending")) { setFeedback("当前已有待确认的组长变更申请。"); return; }
    group.memberIds.forEach((id) => add("actionItems", { id: nextId(`action-${id}`), assigneeId: id, courseId: course.id, projectId: group.projectId, type: `${prefix}${candidate}`, title: `${group.name}更换组长确认`, description: `候选人：${byId(data.users, candidate)?.name}；原因：${reason.trim()}；预计生效：${effective}`, status: id === data.currentUserId ? "completed" : "pending", dueAt: effective, href: gid(course.id, group.id, "/change-leader"), priority: "medium" }));
    if (group.memberIds.length === 1) update("groups", group.id, { leaderId: candidate });
    setFeedback("申请已提交，等待全体成员确认。");
  };
  return <div><Header title="更换组长" description="发起组长变更申请，并由全部成员确认。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: "小组管理", href: gid(course.id, group.id) }, { title: "更换组长" }]} /><div className="mx-auto max-w-[860px] space-y-4"><Notice tone="amber">更换组长需要全部成员确认；确认后保留完整变更记录。</Notice>{feedback && <Notice tone="green">{feedback}</Notice>}
    <Box><div className="space-y-5"><div><span className={label}>当前组长</span><p className="font-semibold">{byId(data.users, group.leaderId)?.name ?? "未知"}<span className="ml-2 text-xs font-normal text-slate-400">{byId(data.users, group.leaderId)?.studentId}</span></p></div><div><label className={label} htmlFor="new-leader">新组长候选人</label><select id="new-leader" className={input} value={candidate} onChange={(event) => setCandidate(event.target.value)}><option value="">选择小组成员</option>{group.memberIds.filter((id) => id !== group.leaderId).map((id) => <option key={id} value={id}>{byId(data.users, id)?.name}（{byId(data.users, id)?.studentId}）</option>)}</select></div><div><label className={label} htmlFor="leader-reason">申请原因</label><textarea id="leader-reason" className={`${input} min-h-24`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="请填写更换组长的原因" /></div><div><label className={label} htmlFor="leader-date">预计生效时间</label><input id="leader-date" type="date" className={input} value={effective} onChange={(event) => setEffective(event.target.value)} /></div><div className="flex justify-end gap-2"><Link className={secondary} href={gid(course.id, group.id)}>取消</Link><button className={button} onClick={submit} disabled={!user || !group.memberIds.includes(user.id)}>提交申请</button></div></div></Box>
    <Box title="成员确认"><div className="flex flex-wrap gap-2">{group.memberIds.map((id) => { const status = all.filter((item) => item.assigneeId === id).at(-1); return <span key={id} className="rounded border border-slate-200 px-3 py-2 text-xs">{byId(data.users, id)?.name} · {status ? status.status === "completed" ? "已确认" : "待确认" : "待提交"}</span>; })}</div>{pending.some((item) => item.assigneeId === data.currentUserId) && <button className={`${button} mt-4`} onClick={confirm}><Check size={15} />确认变更</button>}</Box>
  </div></div>;
}

function LeaveGroup({ data, add, update, course, group, user }: Context) {
  const router = useRouter();
  const [reason, setReason] = useState("个人原因（时间冲突等）");
  const [detail, setDetail] = useState("");
  const [handoffs, setHandoffs] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  if (!group) return <Empty text="尚未加入课程小组" />;
  const tasks = data.tasks.filter((task) => task.projectId === group.projectId && task.responsibleIds.includes(data.currentUserId) && task.status !== "completed");
  const frozen = isFrozen(course, group);
  const submit = () => {
    if (!detail.trim()) { setFeedback("请补充说明退出原因。"); return; }
    if (tasks.some((task) => !handoffs[task.id])) { setFeedback("请为每个未完成任务指定接手成员。"); return; }
    if (frozen) {
      const action: ActionItem = { id: nextId("action"), assigneeId: course.teacherId, courseId: course.id, groupId: group.id, subjectUserId: data.currentUserId, changeKind: "leave", handoffAssignments: handoffs, projectId: group.projectId, type: "member_change", title: `${group.name}成员退出申请`, description: `${user?.name ?? "成员"}：${reason}。${detail.trim()}。未完成任务 ${tasks.map((task) => `${task.id}→${byId(data.users, handoffs[task.id])?.name}`).join("、")}`, status: "pending", dueAt: course.projectDeadline, href: `/teacher/courses/${course.id}/member-changes`, priority: "medium" };
      add("actionItems", action); setFeedback("退出申请已提交，等待教师审批；当前成员和任务分配暂未改变。"); return;
    }
    tasks.forEach((task) => update("tasks", task.id, { responsibleIds: [...task.responsibleIds.filter((id) => id !== data.currentUserId), handoffs[task.id]] }));
    update("groups", group.id, { memberIds: group.memberIds.filter((id) => id !== data.currentUserId) });
    const project = group.projectId ? byId(data.projects, group.projectId) : undefined;
    if (project) update("projects", project.id, { memberIds: project.memberIds.filter((id) => id !== data.currentUserId) });
    setFeedback("已退出小组，已完成的工作和证据仍保留在项目历史中。"); router.push(cid(course.id, "/groups"));
  };
  return <div><Header title="退出小组申请" description="提交退出申请，并完成未完成任务的交接。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: "小组管理", href: gid(course.id, group.id) }, { title: "退出申请" }]} /><div className="mx-auto max-w-[880px] space-y-4"><Notice tone="amber">退出小组需要说明原因并完成未完成任务交接；若成员名单已冻结，还需要教师审批。</Notice>{feedback && <Notice tone="amber">{feedback}</Notice>}
    <Box><fieldset><legend className={label}>退出原因</legend><div className="space-y-2">{["个人原因（时间冲突等）", "学业或课程调整", "与团队协商后退出", "其他"].map((item) => <label key={item} className="flex cursor-pointer items-center gap-2 text-sm"><input type="radio" name="leave-reason" checked={reason === item} onChange={() => setReason(item)} />{item}</label>)}</div></fieldset><textarea aria-label="补充说明原因" className={`${input} mt-4 min-h-24`} value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="请补充说明原因" />
      <h2 className="mb-2 mt-5 text-xs font-semibold text-slate-600">未完成任务交接</h2><div className="divide-y divide-slate-100 rounded bg-slate-50 px-4">{tasks.length ? tasks.map((task) => <div key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><div><span className="text-slate-500">{task.id} · </span>{task.title} <Badge>{task.status === "in_progress" ? "进行中" : "待处理"}</Badge></div><select aria-label={`${task.title}接手成员`} className={`${input} max-w-44`} value={handoffs[task.id] ?? ""} onChange={(event) => setHandoffs((value) => ({ ...value, [task.id]: event.target.value }))}><option value="">选择接手成员</option>{group.memberIds.filter((id) => id !== data.currentUserId).map((id) => <option key={id} value={id}>{byId(data.users, id)?.name}</option>)}</select></div>) : <p className="py-3 text-sm text-slate-500">没有待交接的任务</p>}</div><div className="mt-4 flex justify-end gap-2"><Link className={secondary} href={gid(course.id, group.id)}>取消</Link><button className={button} onClick={submit} disabled={!user || !group.memberIds.includes(user.id)}>提交申请</button></div></Box>
  </div></div>;
}

function RuleChanges({ data, update, course }: Workspace & { course: Course }) {
  const [done, setDone] = useState(false);
  const action = data.actionItems.find((item) => item.assigneeId === data.currentUserId && item.courseId === course.id && item.type.includes("rule"));
  const acknowledged = done || action?.status === "completed";
  const projects = data.projects.filter((project) => project.courseId === course.id && project.memberIds.includes(data.currentUserId));
  const acknowledge = () => { if (action?.status === "pending") update("actionItems", action.id, { status: "completed" }); projects.forEach((project) => update("projects", project.id, { finalDeadline: course.projectDeadline })); setDone(true); };
  const impacts = ["所有里程碑截止日期自动顺延 10 天", "任务计划无需重新制定", "最终报告需要增加 Word 导出", "项目资料需增加演示视频"];
  return <div>
    <Header title="课程规则变更" description="查看教师发布的新规则及其对当前项目的影响。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: "课程规则变更" }]} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
      <div className="space-y-4">
        <Notice>教师已发布课程规则变更<br />发布时间：2026-10-01 14:30 · 生效时间：2026-10-01</Notice>
        <Box title="变更内容" action={<Badge tone={acknowledged ? "green" : "amber"}>{acknowledged ? "已确认" : "待确认"}</Badge>}>
          <DataRow name="最终截止日期" value={<><span className="text-slate-400">2026-12-10</span> → <strong>{dateOnly(course.projectDeadline)}</strong></>} />
          <DataRow name="报告格式" value={<>PDF → <strong>PDF + Word</strong></>} />
          <DataRow name="GitHub 要求" value="必须绑定且在报告中体现" />
          <DataRow name="演示视频" value="新增 5–10 分钟演示视频" />
        </Box>
        <Box title="对项目的影响"><ul className="space-y-3 text-sm text-slate-600">{impacts.map((item, index) => <li key={item} className="flex items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${index < 2 ? "bg-emerald-600" : "bg-amber-600"}`} />{item}</li>)}</ul></Box>
      </div>
      <Box title="确认说明"><p className={muted}>课程规则更新不会静默覆盖项目基线。系统只更新受影响的课程级约束，并记录本次变更历史。</p><div className="mt-5 flex flex-col items-start gap-2"><Link href={cid(course.id, "/rules")} className={secondary}>查看详细规则</Link><button className={button} onClick={acknowledge} disabled={acknowledged || !course.memberIds.includes(data.currentUserId)}>确认并更新项目</button></div></Box>
    </div>
  </div>;
}

function ReopenProject({ data, add, update, course, group }: Context) {
  const router = useRouter();
  const ownedProjects = data.projects.filter((item) => item.courseId === course.id && item.memberIds.includes(data.currentUserId));
  const project = ownedProjects.find((item) => item.lifecycle !== "active") || (group?.projectId && byId(ownedProjects, group.projectId)) || ownedProjects[0];
  const [version, setVersion] = useState(project ? `v${project.version + 1}.0` : "v1.1");
  const [reason, setReason] = useState("根据教师反馈进行修改");
  const [detail, setDetail] = useState("");
  const [retain, setRetain] = useState(true);
  const [feedback, setFeedback] = useState("");
  if (!project) return <Empty text="暂无课程项目" />;
  const create = () => {
    if (!version.trim() || !detail.trim()) { setFeedback("请填写新版本号和重新开启原因。"); return; }
    if (project.lifecycle === "active") { setFeedback("项目需先定稿或归档，才能重新开启。"); return; }
    const newProjectId = nextId("project");
    const cloneId = (id: string) => `${id}-${newProjectId}`;
    const newProject: Project = {
      ...project,
      id: newProjectId,
      lifecycle: "active",
      version: project.version + 1,
      setupStatus: retain ? "frozen" : "not_initialized",
      setupStep: retain ? project.setupStep : 0,
      planVersion: retain ? project.planVersion : 0,
      planConfirmed: false,
      confirmedBy: [],
      progress: retain ? project.progress : 0,
      coreProgress: retain ? project.coreProgress : 0,
      description: `${project.description}\n修订原因：${reason}。${detail.trim()}`,
    };
    add("projects", newProject);
    data.modules.filter((item) => item.projectId === project.id).forEach((item) => add("modules", { ...item, id: cloneId(item.id), projectId: newProjectId, requirementIds: item.requirementIds.map(cloneId), progress: retain ? item.progress : 0 }));
    data.requirements.filter((item) => item.projectId === project.id).forEach((item) => add("requirements", { ...item, id: cloneId(item.id), projectId: newProjectId, moduleId: cloneId(item.moduleId), status: retain ? item.status : "confirmed" }));
    if (retain) {
      const copiedTasks = data.tasks.filter((item) => item.projectId === project.id);
      copiedTasks.forEach((item) => add("tasks", { ...item, id: cloneId(item.id), projectId: newProjectId, moduleId: cloneId(item.moduleId), requirementIds: item.requirementIds.map(cloneId), parentTaskId: item.parentTaskId ? cloneId(item.parentTaskId) : undefined, criterionIds: item.criterionIds.map(cloneId), milestoneIds: item.milestoneIds.map(cloneId), dependencyIds: item.dependencyIds.map(cloneId), version: 1, updatedAt: new Date().toISOString() }));
      data.criteria.filter((item) => copiedTasks.some((task) => task.id === item.taskId)).forEach((item) => add("criteria", { ...item, id: cloneId(item.id), taskId: cloneId(item.taskId), version: 1 }));
      data.evidence.filter((item) => item.projectId === project.id).forEach((item) => add("evidence", { ...item, id: cloneId(item.id), projectId: newProjectId, taskId: cloneId(item.taskId), criterionIds: item.criterionIds.map(cloneId), version: 1 }));
      data.verifications.filter((item) => item.projectId === project.id).forEach((item) => add("verifications", { ...item, id: cloneId(item.id), projectId: newProjectId, taskId: cloneId(item.taskId), status: "outdated", criterionResults: item.criterionResults.map((result) => ({ ...result, criterionId: cloneId(result.criterionId), evidenceIds: result.evidenceIds.map(cloneId) })), version: 1 }));
      data.milestones.filter((item) => item.projectId === project.id).forEach((item) => add("milestones", { ...item, id: cloneId(item.id), projectId: newProjectId, taskIds: item.taskIds.map(cloneId) }));
    }
    if (project.groupId) update("groups", project.groupId, { projectId: newProjectId });
    add("logs", { id: nextId("log"), actorId: data.currentUserId, action: "项目重新开启", target: newProjectId, result: "success", ip: "mock", createdAt: new Date().toISOString(), detail: `基于 ${project.id} 创建 ${version.trim()}：${reason}。${detail.trim()}` });
    setFeedback(`已创建 ${version.trim()} 修订版本。`); router.push(`/projects/${newProjectId}`);
  };
  return <div><Header title="项目重新开启" description="在保留原正式结果的基础上，创建新的修订版本。" crumbs={[{ title: project.name, href: `/projects/${project.id}` }, { title: "项目生命周期" }, { title: "重新开启" }]} /><div className="mx-auto max-w-[880px] space-y-4"><Notice tone="amber">重新开启会保留当前正式版本的所有数据，并创建一个新的活动修订版本。</Notice>{project.lifecycle === "active" && <Notice tone="amber">当前项目仍在进行中，需要先定稿或归档后才能重新开启。</Notice>}{feedback && <Notice tone="amber">{feedback}</Notice>}
    <Box><div className="space-y-5"><div><span className={label}>当前正式版本</span><p className="font-semibold">v{project.version}.0 · {project.lifecycle === "archived" ? "已归档" : project.lifecycle === "finalized" ? "已定稿" : "进行中"}</p><p className="text-xs text-slate-400">最终报告与贡献已冻结</p></div><div><label className={label} htmlFor="reopen-version">新版本信息</label><input id="reopen-version" className={input} value={version} onChange={(event) => setVersion(event.target.value)} /></div><div><label className={label} htmlFor="reopen-reason">重新开启原因</label><select id="reopen-reason" className={input} value={reason} onChange={(event) => setReason(event.target.value)}><option>根据教师反馈进行修改</option><option>修复验收问题</option><option>补充项目材料</option><option>其他</option></select><textarea className={`${input} mt-3 min-h-24`} aria-label="详细说明重新开启原因" value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="请详细说明重新开启原因" /></div><fieldset><legend className={label}>是否保留任务和证据</legend><label className="mb-2 flex items-center gap-2 text-sm"><input type="radio" checked={retain} onChange={() => setRetain(true)} />保留全部任务、证据与验收历史（推荐）</label><label className="flex items-center gap-2 text-sm"><input type="radio" checked={!retain} onChange={() => setRetain(false)} />仅复制需求基线与项目设置</label></fieldset><div className="flex justify-end gap-2"><Link className={secondary} href={`/projects/${project.id}`}>取消</Link><button className={button} onClick={create} disabled={project.lifecycle === "active"}>创建新版本</button></div></div></Box>
  </div></div>;
}

function CourseRules({ data, course }: Workspace & { course: Course }) {
  const [tab, setTab] = useState("课程规则");
  const teacher = byId(data.users, course.teacherId);
  const courseFiles = data.files.filter((file) => file.courseId === course.id);
  const milestones = data.milestones.filter((item) => data.projects.some((project) => project.courseId === course.id && project.id === item.projectId)).slice(0, 4);
  return <div><Header title="课程规则 / 模板总览" description="查看课程项目要求、默认模板与必交材料。" crumbs={[{ title: courseTitle(course), href: "/courses" }, { title: "课程规则" }]} action={<Link href={courseFiles[0]?.id ? `#course-files` : "#required-files"} className={secondary}><Download size={15} />下载课程文件</Link>} /><Tabs items={["课程规则", "项目模板", "评分标准", "必交材料"]} active={tab} onChange={setTab} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]"><div className="space-y-4">{tab === "课程规则" && <><Box title={courseTitle(course)} action={<Badge tone={course.status === "active" ? "green" : "gray"}>{statusText(course.status)}</Badge>}><DataRow name="课程教师" value={teacher?.name ?? "待指定"} /><DataRow name="组队方式" value={`${course.groupingMode === "free" ? "自由组队" : "教师审批"}（${course.minGroupSize}–${course.maxGroupSize} 人）`} /><DataRow name="组队截止" value={dateOnly(course.formationDeadline)} /><DataRow name="项目截止" value={dateOnly(course.projectDeadline)} /><DataRow name="GitHub" value="必须绑定项目仓库" /><DataRow name="AI 辅助" value="允许，但最终提交需说明使用范围" /></Box><Box title="课程规则说明"><ul className="list-inside list-disc space-y-2 text-sm text-slate-600">{course.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul></Box></>}
      {tab === "项目模板" && <Box title="项目模板包含内容"><ol className="list-inside list-decimal divide-y divide-slate-100 text-sm text-slate-600">{["项目方案（Proposal）", "需求规格说明（SRS）", "设计文档（Design Document）", "GitHub 代码仓库", "项目报告（PDF + Word）", "演示视频（5–10 分钟）"].map((item) => <li key={item} className="py-3">{item}</li>)}</ol></Box>}
      {tab === "评分标准" && <Box title="评分标准"><div className="space-y-3 text-sm text-slate-600"><DataRow name="功能完成" value="核心需求与验收结果" /><DataRow name="协作贡献" value="任务、证据与协作记录" /><DataRow name="成果报告" value="报告完整性与演示效果" /><Notice>具体分值以教师发布的课程文件为准。</Notice></div></Box>}
      {tab === "必交材料" && <Box title="必交材料" className="space-y-3"><ul className="divide-y divide-slate-100 text-sm text-slate-600">{course.requiredFiles.map((file) => <li key={file} className="flex items-center justify-between py-3"><span><FileText size={16} className="mr-2 inline text-blue-600" />{file}</span><Badge tone="green">必交</Badge></li>)}</ul></Box>}
      <Box title="课程文件" className="scroll-mt-6" ><div id="course-files" className="divide-y divide-slate-100">{courseFiles.length ? courseFiles.map((file) => <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span>{file.name} <Badge>v{file.version}</Badge></span><button className="text-blue-600" onClick={() => { const blob = new Blob([`${file.name}\n${courseTitle(course)}\n此文件为 Mock 演示记录。`], { type: "text/plain" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = file.name.endsWith(".txt") ? file.name : `${file.name}.txt`; link.click(); URL.revokeObjectURL(url); }}>下载</button></div>) : <p className={muted}>暂无课程文件</p>}</div></Box>
    </div><div className="space-y-4"><Box title="默认里程碑"><div className="divide-y divide-slate-100 text-sm text-slate-600">{(milestones.length ? milestones.map((item) => item.title) : ["M1 · 需求与基线确认", "M2 · 核心流程实现", "M3 · 证据与贡献体系", "M4 · 最终验收与报告"]).map((item) => <div key={item} className="py-3">{item}</div>)}</div></Box><Box title="必交材料"><div id="required-files" className="divide-y divide-slate-100 text-sm text-slate-600">{course.requiredFiles.map((item) => <div key={item} className="py-3">{item}</div>)}</div></Box></div></div>
  </div>;
}
