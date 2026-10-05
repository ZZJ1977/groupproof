"use client";

import { useState } from "react";
import { Activity, AlertTriangle, BookOpen, CheckCircle2, Clock3, Database, FileLock2, Plus, Shield, ShieldCheck, UserCheck, Users } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import type { Role, User } from "@/types/domain";
import { auditRecord, Badge, Box, Empty, formatDate, formatDateTime, Header, Metric, newId, Notice, Progress, roleLabel, SearchField, statusTone, Table } from "./primitives";
import styles from "./governance.module.css";

function useAdminData() {
  return useWorkspace();
}

export function AdminUsers() {
  const { data, role, update, add } = useAdminData();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [collegeFilter, setCollegeFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("student");
  const [teacherCourseId, setTeacherCourseId] = useState(data.courses[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const users = data.users.filter((user) => {
    const matchesQuery = `${user.name} ${user.username} ${user.email} ${user.studentId ?? ""}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (roleFilter === "all" || user.role === roleFilter) && (statusFilter === "all" || user.status === statusFilter) && (collegeFilter === "all" || user.college === collegeFilter);
  });
  const pageCount = Math.max(1, Math.ceil(users.length / 10));
  const currentPage = Math.min(page, pageCount);
  const visibleUsers = users.slice((currentPage - 1) * 10, currentPage * 10);
  const selected = data.users.find((user) => user.id === selectedId);
  const canManage = role === "admin";
  const changeStatus = (user: User) => {
    if (!canManage) return;
    if (!reason.trim()) { setFeedback("停用或恢复账户前必须填写原因。"); return; }
    if (user.id === data.currentUserId) { setFeedback("不能停用当前管理员账户。"); return; }
    const status = user.status === "disabled" ? "active" : "disabled";
    update("users", user.id, { status });
    add("logs", auditRecord(data, status === "active" ? "恢复用户" : "停用用户", user.id, `${user.name}；${reason.trim()}`));
    setFeedback(`${user.name} 的账户已${status === "active" ? "恢复" : "停用"}。`); setReason("");
  };
  const createUser = () => {
    if (!canManage) return;
    if (!newName.trim() || !/^\S+@\S+\.\S+$/.test(newEmail.trim()) || !reason.trim() || (newRole === "teacher" && !teacherCourseId)) { setFeedback("请填写姓名、有效邮箱、申请课程与添加原因。"); return; }
    if (newRole === "teacher" && !/^[^@]+@must\.edu\.mo$/i.test(newEmail.trim())) { setFeedback("教师申请人必须使用 @must.edu.mo 学校邮箱。"); return; }
    if (newRole === "student" && !/^[^@]+@student\.must\.edu\.mo$/i.test(newEmail.trim())) { setFeedback("学生必须使用学校学生邮箱。"); return; }
    if (data.users.some((user) => user.email.toLowerCase() === newEmail.trim().toLowerCase())) { setFeedback("该邮箱已存在。"); return; }
    const id = newId("user");
    add("users", { id, name: newName.trim(), username: newEmail.split("@")[0], email: newEmail.trim(), college: "待确认", role: "student", verified: false, status: "pending", teacherStatus: newRole === "teacher" ? "pending" : undefined, avatarColor: "#e4eaf5" });
    if (newRole === "teacher") add("teacherRequests", { id: newId("teacher-request"), userId: id, courseId: teacherCourseId, status: "pending", submittedAt: new Date().toISOString(), reason: reason.trim() });
    add("logs", auditRecord(data, "添加用户", id, `${newEmail.trim()}；${reason.trim()}`));
    setFeedback("用户已添加，账户需完成学校邮箱验证。"); setShowAdd(false); setNewName(""); setNewEmail(""); setReason("");
  };
  return <div className={styles.page}>
    <Header title="用户管理" description="管理平台用户的身份、账号状态与基础元数据。" action={canManage ? <button type="button" className={styles.primaryButton} onClick={() => { setShowAdd(!showAdd); setFeedback(""); }}><Plus size={16} />添加用户</button> : null} />
    <div className={styles.metrics}><Metric label="总用户" value={data.users.length} icon={Users} /><Metric label="学生" value={data.users.filter((user) => user.role === "student" || user.role === "leader").length} icon={Users} /><Metric label="教师" value={data.users.filter((user) => user.role === "teacher" || user.role === "ta").length} icon={UserCheck} /><Metric label="管理员" value={data.users.filter((user) => user.role === "admin").length} icon={Shield} /></div>
    {showAdd ? <Box title="添加用户"><div className={styles.panelBody}><div className={styles.formGrid}><label className={styles.field}>姓名<input className={styles.input} value={newName} onChange={(event) => setNewName(event.target.value)} /></label><label className={styles.field}>学校邮箱<input className={styles.input} type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></label><label className={styles.field}>身份<select className={styles.select} value={newRole} onChange={(event) => setNewRole(event.target.value as Role)}><option value="student">学生</option><option value="teacher">教师申请人</option></select></label>{newRole === "teacher" ? <label className={styles.field}>申请课程<select className={styles.select} value={teacherCourseId} onChange={(event) => setTeacherCourseId(event.target.value)}>{data.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label> : null}<label className={`${styles.field} ${styles.fieldFull}`}>添加原因<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label></div><div className={styles.actions} style={{ marginTop: 12 }}><button type="button" className={styles.primaryButton} onClick={createUser}>添加账户</button><button type="button" className={styles.button} onClick={() => setShowAdd(false)}>取消</button></div></div></Box> : null}
    <div className={styles.filters}><SearchField value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder="搜索用户名、学号或邮箱" /><select className={styles.select} value={roleFilter} onChange={(event) => { setRoleFilter(event.target.value); setPage(1); }} aria-label="角色筛选"><option value="all">全部角色</option><option value="student">学生</option><option value="leader">组长</option><option value="teacher">教师</option><option value="admin">管理员</option></select><select className={styles.select} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} aria-label="状态筛选"><option value="all">全部状态</option><option value="active">正常</option><option value="pending">待审核</option><option value="disabled">已停用</option></select><select className={styles.select} value={collegeFilter} onChange={(event) => { setCollegeFilter(event.target.value); setPage(1); }} aria-label="学院筛选"><option value="all">全部学院</option>{Array.from(new Set(data.users.map((user) => user.college))).map((college) => <option key={college} value={college}>{college}</option>)}</select><button type="button" className={styles.button} onClick={() => { setQuery(""); setRoleFilter("all"); setStatusFilter("all"); setCollegeFilter("all"); setPage(1); }}>重置</button></div>
    <Box><Table><thead><tr><th>用户</th><th>身份</th><th>学校邮箱</th><th>学院</th><th>项目数</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleUsers.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><div className={styles.rowMeta}>{user.studentId ?? user.username}</div></td><td><Badge tone={statusTone(user.role)}>{roleLabel(user.role)}</Badge></td><td>{user.email}</td><td>{user.college}</td><td>{data.projects.filter((project) => project.memberIds.includes(user.id)).length}</td><td><Badge tone={statusTone(user.status)}>{user.status === "active" ? "正常" : user.status === "disabled" ? "已停用" : "待审核"}</Badge></td><td><div className={styles.actions}><button type="button" className={styles.textButton} onClick={() => setSelectedId(user.id)}>查看</button>{canManage ? <button type="button" className={user.status === "disabled" ? styles.button : styles.dangerButton} onClick={() => { setSelectedId(user.id); setFeedback("请在下方填写原因后确认账户状态变更。"); }}>{user.status === "disabled" ? "恢复" : "停用"}</button> : null}</div></td></tr>)}</tbody></Table>{users.length === 0 ? <Empty /> : null}<div className={styles.tableFooter}><span>共 {users.length} 条记录 · 第 {currentPage} / {pageCount} 页</span><div className={styles.actions}><button type="button" className={styles.button} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button type="button" className={styles.button} disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div></Box>
    {selected ? <Box title={`${selected.name} · 账户资料`} action={<button type="button" className={styles.ghostButton} onClick={() => setSelectedId("")}>关闭</button>}><div className={styles.panelBody}><div className={styles.formGrid}><div><span className={styles.muted}>学校邮箱</span><p>{selected.email}</p></div><div><span className={styles.muted}>学校验证</span><p>{selected.verified ? "已验证" : "未验证"}</p></div><div><span className={styles.muted}>身份</span><p>{roleLabel(selected.role)}</p></div><div><span className={styles.muted}>状态</span><p>{selected.status}</p></div></div>{canManage ? <div className={styles.stack}><label className={styles.field}>账户状态变更原因<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="说明停用或恢复原因" /></label><button type="button" className={selected.status === "disabled" ? styles.primaryButton : styles.dangerButton} onClick={() => changeStatus(selected)}>{selected.status === "disabled" ? "确认恢复" : "确认停用"}</button></div> : null}</div></Box> : null}
    {feedback ? <div className={feedback.includes("已") ? styles.successMessage : styles.errorMessage}>{feedback}</div> : null}
    <Notice>管理员默认仅查看用户元数据。项目正文、任务和正式证据需通过受控访问审批流程查看。</Notice>
  </div>;
}

export function AdminTeacherVerification() {
  const { data, role, update, add } = useAdminData();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [query, setQuery] = useState("");
  const [college, setCollege] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const canDecide = role === "admin";
  const selected = data.teacherRequests.find((item) => item.id === selectedId);
  const requests = data.teacherRequests.filter((request) => {
    const user = data.users.find((item) => item.id === request.userId);
    return request.status === tab && `${user?.name ?? ""} ${user?.email ?? ""} ${data.courses.find((item) => item.id === request.courseId)?.name ?? ""}`.toLowerCase().includes(query.toLowerCase()) && (college === "all" || user?.college === college);
  });
  const decide = (requestId: string, approved: boolean) => {
    const request = data.teacherRequests.find((item) => item.id === requestId);
    const user = data.users.find((item) => item.id === request?.userId);
    if (!request || !user || !canDecide) return;
    if (!reason.trim()) { setSelectedId(requestId); setFeedback("请填写审核意见后再处理教师身份申请。"); return; }
    if (approved && !user.verified) { setFeedback("学校邮箱尚未验证，不能通过教师申请。"); return; }
    update("teacherRequests", request.id, { status: approved ? "approved" : "rejected", reason: `${request.reason} 审核意见：${reason.trim()}` });
    update("users", user.id, { role: approved ? "teacher" : user.role, teacherStatus: approved ? "approved" : "rejected", status: approved ? "active" : user.status });
    add("logs", auditRecord(data, approved ? "教师身份通过" : "教师身份拒绝", user.id, `${user.email}；${reason.trim()}`));
    setFeedback(`${user.name} 的申请已${approved ? "通过" : "拒绝"}。`); setReason(""); setSelectedId("");
  };
  return <div className={styles.page}>
    <Header title="教师审核" description="确认学校邮箱和课程任职信息，审批教师身份申请。" />
    <div className={styles.tabs}>{([["pending", "待审核"], ["approved", "已通过"], ["rejected", "已拒绝"]] as const).map(([value, label]) => <button key={value} type="button" className={`${styles.tab} ${tab === value ? styles.tabActive : ""}`} onClick={() => { setTab(value); setSelectedId(""); }}>{label} ({data.teacherRequests.filter((item) => item.status === value).length})</button>)}</div>
    <div className={styles.filters}><SearchField value={query} onChange={setQuery} placeholder="搜索申请人、邮箱或课程" /><select className={styles.select} value={college} onChange={(event) => setCollege(event.target.value)} aria-label="学院筛选"><option value="all">全部学院</option>{Array.from(new Set(data.users.map((item) => item.college))).map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
    <Box><Table><thead><tr><th>申请人</th><th>学校邮箱</th><th>所属学院</th><th>申请课程</th><th>申请时间</th><th>邮箱验证</th><th>状态</th><th>操作</th></tr></thead><tbody>{requests.map((request) => {
      const user = data.users.find((item) => item.id === request.userId);
      return <tr key={request.id}><td><strong>{user?.name ?? "—"}</strong></td><td>{user?.email ?? "—"}</td><td>{user?.college ?? "—"}</td><td>{data.courses.find((item) => item.id === request.courseId)?.name ?? "—"}</td><td>{formatDateTime(request.submittedAt)}</td><td><Badge tone={user?.verified ? "green" : "red"}>{user?.verified ? "已验证" : "未验证"}</Badge></td><td><Badge tone={statusTone(request.status)}>{request.status === "pending" ? "待审核" : request.status === "approved" ? "已通过" : "已拒绝"}</Badge></td><td><button type="button" className={styles.button} onClick={() => setSelectedId(request.id)}>查看资料</button></td></tr>;
    })}</tbody></Table>{requests.length === 0 ? <Empty>该状态下没有申请</Empty> : null}<div className={styles.tableFooter}>共 {requests.length} 条</div></Box>
    {selected ? <Box title="审核资料" action={<button type="button" className={styles.ghostButton} onClick={() => setSelectedId("")}>关闭</button>}><div className={styles.panelBody}><div className={styles.formGrid}><div><span className={styles.muted}>申请人</span><p>{data.users.find((item) => item.id === selected.userId)?.name}</p></div><div><span className={styles.muted}>课程</span><p>{data.courses.find((item) => item.id === selected.courseId)?.name}</p></div><div className={styles.fieldFull}><span className={styles.muted}>申请说明</span><p>{selected.reason}</p></div></div>{selected.status === "pending" && canDecide ? <div className={styles.stack}><label className={styles.field}>审核意见<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="说明通过或拒绝的依据" /></label><div className={styles.actions}><button type="button" className={styles.primaryButton} onClick={() => decide(selected.id, true)} disabled={!data.users.find((item) => item.id === selected.userId)?.verified}>通过</button><button type="button" className={styles.dangerButton} onClick={() => decide(selected.id, false)}>拒绝</button></div></div> : null}</div></Box> : null}
    {feedback ? <div className={feedback.includes("申请已") ? styles.successMessage : styles.errorMessage}>{feedback}</div> : null}
    <Notice>教师申请必须使用已验证的 @must.edu.mo 邮箱。审核仅更改教师身份，不修改项目正文；所有操作写入审计日志。</Notice>
  </div>;
}

export function AdminCourses() {
  const { data, role, add } = useAdminData();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [semester, setSemester] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [teacherId, setTeacherId] = useState(data.users.find((user) => user.role === "teacher" && user.teacherStatus === "approved")?.id ?? "");
  const [feedback, setFeedback] = useState("");
  const canManage = role === "admin";
  const filtered = data.courses.filter((course) => `${course.name} ${course.code}`.toLowerCase().includes(query.toLowerCase()) && (status === "all" || course.status === status) && (semester === "all" || course.semester === semester));
  const selected = data.courses.find((course) => course.id === selectedId);
  const create = () => {
    if (!canManage) return;
    if (!name.trim() || !code.trim() || !teacherId) { setFeedback("请填写课程名称、代码与授课教师。"); return; }
    if (data.courses.some((course) => course.code.toLowerCase() === code.trim().toLowerCase())) { setFeedback("课程代码已存在。"); return; }
    const id = newId("course");
    add("courses", { id, name: name.trim(), code: code.trim(), college: data.users.find((user) => user.id === teacherId)?.college ?? "未指定", semester: "2026 秋季学期", teacherId, status: "draft", projectDeadline: "2026-12-20", formationDeadline: "2026-10-20", groupingMode: "free", minGroupSize: 3, maxGroupSize: 5, memberIds: [], version: 1, rules: [], requiredFiles: [] });
    add("logs", auditRecord(data, "创建课程元数据", id, `${name.trim()} (${code.trim()})`));
    setFeedback("课程草稿已创建。"); setShowCreate(false); setName(""); setCode("");
  };
  return <div className={styles.page}>
    <Header title="课程管理" description="查看课程状态与基础信息，管理平台课程元数据。" action={canManage ? <button type="button" className={styles.primaryButton} onClick={() => setShowCreate(!showCreate)}><Plus size={16} />新建课程</button> : null} />
    {showCreate ? <Box title="新建课程"><div className={styles.panelBody}><div className={styles.formGrid}><label className={styles.field}>课程名称<input className={styles.input} value={name} onChange={(event) => setName(event.target.value)} /></label><label className={styles.field}>课程代码<input className={styles.input} value={code} onChange={(event) => setCode(event.target.value)} /></label><label className={styles.field}>授课教师<select className={styles.select} value={teacherId} onChange={(event) => setTeacherId(event.target.value)}>{data.users.filter((user) => user.role === "teacher" && user.teacherStatus === "approved").map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label></div><div className={styles.actions} style={{ marginTop: 14 }}><button type="button" className={styles.primaryButton} onClick={create}>创建草稿</button><button type="button" className={styles.button} onClick={() => setShowCreate(false)}>取消</button></div></div></Box> : null}
    <div className={styles.filters}><SearchField value={query} onChange={setQuery} placeholder="搜索课程名称或课程代码" /><select className={styles.select} value={semester} onChange={(event) => setSemester(event.target.value)} aria-label="学期筛选"><option value="all">全部学期</option>{Array.from(new Set(data.courses.map((course) => course.semester))).map((item) => <option key={item} value={item}>{item}</option>)}</select><select className={styles.select} value={status} onChange={(event) => setStatus(event.target.value)} aria-label="状态筛选"><option value="all">全部状态</option><option value="active">进行中</option><option value="ended">已结束</option><option value="draft">草稿</option></select></div>
    <Box><Table><thead><tr><th>课程名称</th><th>课程代码</th><th>学院</th><th>教师</th><th>学期</th><th>小组数</th><th>学生数</th><th>状态</th><th>操作</th></tr></thead><tbody>{filtered.map((course) => <tr key={course.id}><td><strong>{course.name}</strong></td><td>{course.code}</td><td>{course.college}</td><td>{data.users.find((user) => user.id === course.teacherId)?.name ?? "—"}</td><td>{course.semester}</td><td>{data.groups.filter((group) => group.courseId === course.id).length}</td><td>{course.memberIds.length}</td><td><Badge tone={statusTone(course.status)}>{course.status === "active" ? "进行中" : course.status === "ended" ? "已结束" : "草稿"}</Badge></td><td><button type="button" className={styles.button} onClick={() => setSelectedId(course.id)}>查看</button></td></tr>)}</tbody></Table>{filtered.length === 0 ? <Empty /> : null}<div className={styles.tableFooter}>共 {filtered.length} 条课程记录</div></Box>
    {selected ? <Box title={`${selected.name} · 基础资料`} action={<button type="button" className={styles.ghostButton} onClick={() => setSelectedId("")}>关闭</button>}><div className={styles.panelBody}><div className={styles.formGrid}><div><span className={styles.muted}>课程代码</span><p>{selected.code}</p></div><div><span className={styles.muted}>授课教师</span><p>{data.users.find((user) => user.id === selected.teacherId)?.name ?? "—"}</p></div><div><span className={styles.muted}>学期</span><p>{selected.semester}</p></div><div><span className={styles.muted}>所属学院</span><p>{selected.college}</p></div><div><span className={styles.muted}>规则版本</span><p>v{selected.version}</p></div><div><span className={styles.muted}>项目截止</span><p>{formatDate(selected.projectDeadline)}</p></div></div></div></Box> : null}
    <div className={styles.metrics}><Metric label="全部课程" value={data.courses.length} icon={BookOpen} /><Metric label="进行中" value={data.courses.filter((course) => course.status === "active").length} icon={Activity} tone="green" /><Metric label="已结束" value={data.courses.filter((course) => course.status === "ended").length} icon={CheckCircle2} /><Metric label="总学生数" value={new Set(data.courses.flatMap((course) => course.memberIds)).size} icon={Users} /></div>
    {feedback ? <div className={feedback.includes("已创建") ? styles.successMessage : styles.errorMessage}>{feedback}</div> : null}
  </div>;
}

export function AdminLogs() {
  const { data } = useAdminData();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState("all");
  const [actorRole, setActorRole] = useState("all");
  const [action, setAction] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const selected = data.logs.find((item) => item.id === selectedId);
  const filtered = [...data.logs].filter((log) => {
    const actor = data.users.find((user) => user.id === log.actorId);
    const text = `${actor?.name ?? ""} ${log.action} ${log.target} ${log.detail} ${log.ip}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (result === "all" || log.result === result) && (actorRole === "all" || actor?.role === actorRole) && (action === "all" || log.action === action);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <div className={styles.page}>
    <Header title="系统日志" description="记录平台关键操作与系统事件，用于审计和问题追踪。" />
    <div className={styles.filters}><select className={styles.select} value={action} onChange={(event) => setAction(event.target.value)} aria-label="事件类型"><option value="all">全部类型</option>{Array.from(new Set(data.logs.map((item) => item.action))).map((item) => <option key={item} value={item}>{item}</option>)}</select><select className={styles.select} value={actorRole} onChange={(event) => setActorRole(event.target.value)} aria-label="操作角色"><option value="all">全部角色</option><option value="student">学生</option><option value="leader">组长</option><option value="teacher">教师</option><option value="admin">管理员</option></select><select className={styles.select} value={result} onChange={(event) => setResult(event.target.value)} aria-label="结果状态"><option value="all">全部状态</option><option value="success">成功</option><option value="failure">失败</option></select><SearchField value={query} onChange={setQuery} placeholder="搜索操作、对象或 IP 地址" /></div>
    <Box><Table><thead><tr><th>时间</th><th>操作者</th><th>操作类型</th><th>操作内容</th><th>对象</th><th>结果</th><th>IP 地址</th><th>详情</th></tr></thead><tbody>{filtered.map((log) => <tr key={log.id}><td>{formatDateTime(log.createdAt)}</td><td>{data.users.find((user) => user.id === log.actorId)?.name ?? "系统"}</td><td>{log.action}</td><td>{log.detail}</td><td>{log.target}</td><td><Badge tone={log.result === "success" ? "green" : "red"}>{log.result === "success" ? "成功" : "失败"}</Badge></td><td>{log.ip}</td><td><button type="button" className={styles.textButton} onClick={() => setSelectedId(log.id)}>查看</button></td></tr>)}</tbody></Table>{filtered.length === 0 ? <Empty /> : null}<div className={styles.tableFooter}>共 {filtered.length} 条审计记录</div></Box>
    {selected ? <Box title="日志详情" action={<button type="button" className={styles.ghostButton} onClick={() => setSelectedId("")}>关闭</button>}><div className={styles.panelBody}><div className={styles.formGrid}><div><span className={styles.muted}>时间</span><p>{formatDateTime(selected.createdAt)}</p></div><div><span className={styles.muted}>操作者</span><p>{data.users.find((user) => user.id === selected.actorId)?.name ?? selected.actorId}</p></div><div><span className={styles.muted}>对象</span><p>{selected.target}</p></div><div><span className={styles.muted}>来源 IP</span><p>{selected.ip}</p></div><div className={styles.fieldFull}><span className={styles.muted}>操作详情</span><p>{selected.detail}</p></div></div></div></Box> : null}
    <Notice>高权限操作采用追加式审计，保留操作者、原因、时间与对象；系统日志不能覆盖历史。</Notice>
  </div>;
}

export function AdminAiUsage() {
  const { data } = useAdminData();
  const [period, setPeriod] = useState<7 | 30 | 90>(7);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const usage = selectedWorkflow ? data.aiUsage.filter((item) => item.workflow === selectedWorkflow) : data.aiUsage;
  const periodRatio = period / 90;
  const calls = Math.round(usage.reduce((sum, item) => sum + item.calls, 0) * periodRatio);
  const failures = Math.round(usage.reduce((sum, item) => sum + item.failures, 0) * periodRatio);
  const avgLatency = calls ? Math.round(usage.reduce((sum, item) => sum + item.avgLatencyMs * item.calls, 0) / calls) : 0;
  const successRate = calls ? Math.round(((calls - failures) / calls) * 1000) / 10 : 0;
  const maxCalls = Math.max(1, ...data.aiUsage.map((item) => item.calls));
  const trend = Array.from({ length: 7 }, (_, index) => Math.round(calls * [0.12, 0.16, 0.15, 0.11, 0.14, 0.13, 0.19][index]));
  const maxTrend = Math.max(1, ...trend);
  return <div className={styles.page}>
    <Header title="AI 使用情况" description="查看平台 AI 调用量、失败情况与基础性能表现。" action={<div className={styles.actions}>{([7, 30, 90] as const).map((days) => <button key={days} type="button" className={period === days ? styles.primaryButton : styles.button} onClick={() => setPeriod(days)}>近 {days} 天</button>)}</div>} />
    <div className={styles.metrics}><Metric label="调用量" value={calls} icon={Database} /><Metric label="成功率" value={`${successRate}%`} icon={ShieldCheck} tone="green" /><Metric label="失败次数" value={failures} icon={AlertTriangle} tone="red" /><Metric label="平均延迟" value={`${(avgLatency / 1000).toFixed(1)} s`} icon={Clock3} /></div>
    <div className={styles.twoColumns}><div className={styles.sideStack}>
      <Box title="按流程" action={selectedWorkflow ? <button type="button" className={styles.textButton} onClick={() => setSelectedWorkflow(null)}>查看全部</button> : null}><div className={styles.panelBody}>{data.aiUsage.map((item) => <button key={item.id} type="button" className={styles.row} style={{ width: "100%", borderLeft: 0, borderRight: 0, borderTop: 0, background: selectedWorkflow === item.workflow ? "#f1f6ff" : "transparent", textAlign: "left", cursor: "pointer" }} onClick={() => setSelectedWorkflow(selectedWorkflow === item.workflow ? null : item.workflow)}><span className={styles.rowMain}>{item.workflow}</span><strong>{Math.round(item.calls * periodRatio)}</strong><div style={{ width: "48%" }}><Progress value={item.calls / maxCalls * 100} label={false} /></div><span className={styles.muted}>{Math.round(item.calls / data.aiUsage.reduce((sum, row) => sum + row.calls, 0) * 100)}%</span></button>)}</div></Box>
      <Box title="调用趋势" action={<span className={styles.muted}>当前视图：近 {period} 天</span>}><div className={styles.panelBody}><div className={styles.chart}>{trend.map((value, index) => <div className={styles.chartBar} key={index} style={{ height: `${Math.max(8, value / maxTrend * 100)}%` }} title={`${value} 次`}><span>{index + 1}</span></div>)}</div><div className={styles.rowMeta} style={{ marginTop: 25 }}>按当前流程汇总的示例趋势。选择流程可查看其用量构成。</div></div></Box>
    </div><div className={styles.sideStack}>
      <Box title="模型服务状态"><div className={styles.panelBody}><Badge tone="green">运行正常</Badge><p className={styles.muted}>最近汇总成功率 {successRate}%。</p>{Array.from(new Set(data.aiUsage.map((item) => item.model))).map((model) => <div className={styles.row} key={model}><span className={styles.rowMain}>{model}</span><Badge tone="green">可用</Badge></div>)}</div></Box>
      <Box title="成本与缓存"><div className={styles.panelBody}><div className={styles.row}><span className={styles.rowMain}>模拟成本合计</span><strong>${(usage.reduce((sum, item) => sum + item.cost, 0) * periodRatio).toFixed(2)}</strong></div><p className={styles.rowMeta}>相同输入版本复用已有结果，旧分析标记为过期。费用只用于内部观测，不对用户计费。</p></div></Box>
    </div></div>
    <Box title="最近失败记录"><Table><thead><tr><th>流程</th><th>模型</th><th>调用次数</th><th>失败次数</th><th>失败率</th><th>平均延迟</th></tr></thead><tbody>{data.aiUsage.filter((item) => item.failures > 0).map((item) => <tr key={item.id}><td>{item.workflow}</td><td>{item.model}</td><td>{item.calls}</td><td><Badge tone="red">{item.failures}</Badge></td><td>{Math.round(item.failures / Math.max(1, item.calls) * 100)}%</td><td>{(item.avgLatencyMs / 1000).toFixed(1)} s</td></tr>)}</tbody></Table></Box>
  </div>;
}

export function AdminAccessRequests() {
  const { data, role, update, add } = useAdminData();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [risk, setRisk] = useState("all");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("rejected");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const canDecide = role === "admin";
  const selected = data.accessRequests.find((item) => item.id === selectedId);
  const filtered = data.accessRequests.filter((request) => {
    const applicant = data.users.find((user) => user.id === request.applicantId);
    return `${request.type} ${request.reason} ${request.target} ${applicant?.name ?? ""}`.toLowerCase().includes(query.toLowerCase()) && (type === "all" || request.type === type) && (risk === "all" || request.risk === risk) && (status === "all" || request.status === status);
  });
  const submit = () => {
    if (!selected || !canDecide || selected.status !== "pending") return;
    if (!reason.trim()) { setFeedback("请填写访问范围、时效及审批依据。"); return; }
    update("accessRequests", selected.id, { status: decision, decisionReason: reason.trim() });
    add("logs", auditRecord(data, decision === "approved" ? "异常访问批准" : "异常访问拒绝", selected.target, `${selected.type}；申请人 ${selected.applicantId}；${reason.trim()}`));
    setFeedback(decision === "approved" ? "申请已批准，访问决定已写入审计日志。" : "申请已拒绝，处理原因已保留。"); setReason("");
  };
  return <div className={styles.page}>
    <Header title="异常 / 访问审批" description="处理异常访问申请、受控内容访问与系统高风险操作。" />
    <div className={styles.metrics}><Metric label="待处理" value={data.accessRequests.filter((item) => item.status === "pending").length} icon={FileLock2} /><Metric label="今日新增" value={data.accessRequests.filter((item) => formatDate(item.submittedAt) === formatDate(new Date().toISOString())).length} icon={Plus} /><Metric label="高风险" value={data.accessRequests.filter((item) => item.risk === "high" && item.status === "pending").length} icon={AlertTriangle} tone="red" /><Metric label="已处理" value={data.accessRequests.filter((item) => item.status !== "pending").length} icon={CheckCircle2} tone="green" /></div>
    <div className={styles.twoColumns}><div className={styles.stack}>
      <div className={styles.filters}><SearchField value={query} onChange={setQuery} placeholder="搜索申请人、原因或对象" /><select className={styles.select} value={type} onChange={(event) => setType(event.target.value)} aria-label="类型筛选"><option value="all">全部类型</option>{Array.from(new Set(data.accessRequests.map((item) => item.type))).map((item) => <option key={item} value={item}>{item}</option>)}</select><select className={styles.select} value={risk} onChange={(event) => setRisk(event.target.value)} aria-label="风险筛选"><option value="all">全部风险</option><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option></select><select className={styles.select} value={status} onChange={(event) => setStatus(event.target.value)} aria-label="状态筛选"><option value="all">全部状态</option><option value="pending">待处理</option><option value="approved">已批准</option><option value="rejected">已拒绝</option></select></div>
      <Box><Table><thead><tr><th>类型</th><th>申请人</th><th>申请原因</th><th>目标对象</th><th>时间</th><th>风险</th><th>状态</th><th>操作</th></tr></thead><tbody>{filtered.map((request) => <tr key={request.id}><td>{request.type}</td><td>{data.users.find((user) => user.id === request.applicantId)?.name ?? "—"}</td><td>{request.reason}</td><td>{request.target}</td><td>{formatDateTime(request.submittedAt)}</td><td><Badge tone={statusTone(request.risk)}>{request.risk === "high" ? "高风险" : request.risk === "medium" ? "中风险" : "低风险"}</Badge></td><td><Badge tone={statusTone(request.status)}>{request.status === "pending" ? "待处理" : request.status === "approved" ? "已批准" : "已拒绝"}</Badge></td><td><button type="button" className={styles.button} onClick={() => { setSelectedId(request.id); setFeedback(""); }}>{request.status === "pending" ? "处理" : "查看"}</button></td></tr>)}</tbody></Table>{filtered.length === 0 ? <Empty /> : null}<div className={styles.tableFooter}>共 {filtered.length} 条</div></Box>
      {selected ? <Box title="访问申请处理" action={<button type="button" className={styles.ghostButton} onClick={() => setSelectedId("")}>关闭</button>}><div className={styles.panelBody}><p><strong>{selected.type}</strong> · {selected.target}</p><p className={styles.muted}>申请原因：{selected.reason}</p>{selected.status === "pending" && canDecide ? <div className={styles.stack}><div className={styles.equalColumns}><label className={styles.option}><input type="radio" name="access-decision" checked={decision === "rejected"} onChange={() => setDecision("rejected")} /><div><strong>拒绝</strong><span>不开放受控内容</span></div></label><label className={styles.option}><input type="radio" name="access-decision" checked={decision === "approved"} onChange={() => setDecision("approved")} /><div><strong>批准</strong><span>按限定范围授予访问</span></div></label></div><label className={styles.field}>处理原因、范围与时效<textarea className={styles.textarea} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="写明必要范围、有效时间与审批依据" maxLength={500} /></label><button type="button" className={styles.primaryButton} onClick={submit}>保存决定</button></div> : <p className={styles.rowMeta}>审批意见：{selected.decisionReason ?? "无"}</p>}{feedback ? <div className={feedback.startsWith("申请已") ? styles.successMessage : styles.errorMessage}>{feedback}</div> : null}</div></Box> : null}
    </div><div className={styles.sideStack}><Box title="审批原则"><div className={styles.panelBody}><div className={styles.stack}><p>1. 最小权限：仅授予完成任务所需的最小访问范围。</p><p>2. 限定范围与时效：访问必须对应具体对象，并明确有效时间。</p><p>3. 必须填写理由：申请与处理均保留说明。</p><p>4. 全过程审计：所有审批操作可查询、可追溯。</p></div></div></Box><Box title="最近高风险操作"><div className={styles.panelBody}>{data.accessRequests.filter((item) => item.risk === "high").slice(0, 4).map((item) => <div className={styles.row} key={item.id}><AlertTriangle size={16} color="#d43b38" /><div className={styles.rowMain}><strong>{item.type}</strong><div className={styles.rowMeta}>{item.target}</div></div><Badge tone="red">高风险</Badge></div>)}</div></Box></div></div>
  </div>;
}
