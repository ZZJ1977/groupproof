import type { MockData, Task, AcceptanceCriterion } from "@/types/domain";

const now = "2026-10-05T09:00:00.000Z";

const users: MockData["users"] = [
  { id: "member-1", name: "张同学", username: "zhang", email: "220001@student.must.edu.mo", studentId: "220001", college: "计算机科学与工程学院", role: "leader", verified: true, status: "active", avatarColor: "#dce9ff" },
  { id: "member-2", name: "李四", username: "lisi", email: "220002@student.must.edu.mo", studentId: "220002", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#ede3fa" },
  { id: "member-3", name: "王五", username: "wangwu", email: "220003@student.must.edu.mo", studentId: "220003", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#dcf4eb" },
  { id: "member-4", name: "陈六", username: "chenliu", email: "220004@student.must.edu.mo", studentId: "220004", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#ffe8db" },
  { id: "member-5", name: "赵七", username: "zhaoqi", email: "220005@student.must.edu.mo", studentId: "220005", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#dcecf2" },
  { id: "member-21", name: "新同学", username: "newstudent", email: "220021@student.must.edu.mo", studentId: "220021", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#e7eefb" },
  { id: "member-22", name: "周同学", username: "zhou", email: "210022@student.must.edu.mo", studentId: "210022", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#e7f3ee" },
  { id: "member-23", name: "吴同学", username: "wu", email: "210023@student.must.edu.mo", studentId: "210023", college: "计算机科学与工程学院", role: "student", verified: true, status: "active", avatarColor: "#f7e9e2" },
  { id: "teacher-1", name: "李老师", username: "teacherli", email: "li@must.edu.mo", college: "计算机科学与工程学院", role: "teacher", verified: true, status: "active", teacherStatus: "approved", avatarColor: "#dde7fc" },
  { id: "teacher-2", name: "王老师", username: "teacherwang", email: "wang@must.edu.mo", college: "商学院", role: "teacher", verified: true, status: "active", teacherStatus: "approved", avatarColor: "#e8e0fb" },
  { id: "teacher-3", name: "刘老师", username: "teacherliu", email: "liu@must.edu.mo", college: "计算机科学与工程学院", role: "teacher", verified: true, status: "pending", teacherStatus: "pending", avatarColor: "#e0f1e8" },
  { id: "admin-1", name: "系统管理员", username: "admin", email: "admin@must.edu.mo", college: "信息技术处", role: "admin", verified: true, status: "active", avatarColor: "#dbe6f7" },
  ...Array.from({ length: 15 }, (_, index) => {
    const number = index + 6;
    return { id: `member-${number}`, name: `成员 ${number}`, username: `student${number}`, email: `2200${String(number).padStart(2, "0")}@student.must.edu.mo`, studentId: `2200${String(number).padStart(2, "0")}`, college: "计算机科学与工程学院", role: "student" as const, verified: true, status: "active" as const, avatarColor: ["#dce9ff", "#dcf4eb", "#ffe8db", "#ede3fa"][index % 4] };
  }),
];

const courses: MockData["courses"] = [
  { id: "course-1", name: "软件工程 · 2026", code: "SE2026", college: "计算机科学与工程学院", semester: "2026 秋季学期", teacherId: "teacher-1", status: "active", projectDeadline: "2026-12-20", formationDeadline: "2026-10-15", groupingMode: "free", minGroupSize: 3, maxGroupSize: 4, memberIds: Array.from({ length: 21 }, (_, index) => `member-${index + 1}`), version: 2, rules: ["自由组队，每组 3-4 人", "项目需绑定 GitHub 仓库", "正式证据需关联任务与验收标准", "最终提交 PDF 与 Word 报告"], requiredFiles: ["项目方案", "需求规格说明", "设计文档", "项目报告", "演示视频"], milestoneTemplate: [{ id: "template-m1", title: "M1 需求与基线确认", description: "完成组队与需求确认", deadline: "2026-10-15" }, { id: "template-m2", title: "M2 核心流程实现", description: "完成核心功能", deadline: "2026-10-25" }, { id: "template-m3", title: "M3 证据与贡献体系", description: "完成证据验收", deadline: "2026-11-20" }, { id: "template-m4", title: "M4 最终验收与报告", description: "完成正式报告", deadline: "2026-12-20" }] },
  { id: "course-2", name: "数据结构与算法 · 2026", code: "DSA2026", college: "计算机科学与工程学院", semester: "2026 秋季学期", teacherId: "teacher-1", status: "active", projectDeadline: "2026-12-10", formationDeadline: "2026-10-18", groupingMode: "free", minGroupSize: 3, maxGroupSize: 4, memberIds: ["member-1", "member-5"], version: 1, rules: ["课程项目需覆盖核心算法分析", "小组人数 3-4 人"], requiredFiles: ["项目报告", "代码仓库"] },
  { id: "course-3", name: "人工智能基础 · 2025", code: "AI2025", college: "计算机科学与工程学院", semester: "2025 秋季学期", teacherId: "teacher-2", status: "ended", projectDeadline: "2025-12-18", formationDeadline: "2025-10-15", groupingMode: "approval", minGroupSize: 3, maxGroupSize: 5, memberIds: ["member-1", "member-22", "member-23"], version: 1, rules: ["课程项目已归档"], requiredFiles: ["最终报告"] },
];

const groups: MockData["groups"] = [
  { id: "group-1", courseId: "course-1", name: "GroupProof Team 4", direction: "证据驱动的项目协作", leaderId: "member-1", memberIds: ["member-1", "member-2", "member-3", "member-4"], projectId: "project-1", rosterFrozen: false, createdAt: "2026-09-12", version: 1 },
  { id: "group-2", courseId: "course-1", name: "第 1 组", direction: "智能交通", leaderId: "member-5", memberIds: ["member-5", "member-6", "member-7"], projectId: "project-3", rosterFrozen: false, createdAt: "2026-09-10", version: 1 },
  { id: "group-3", courseId: "course-1", name: "第 2 组", direction: "校园服务", leaderId: "member-8", memberIds: ["member-8", "member-9", "member-10", "member-11"], rosterFrozen: false, createdAt: "2026-09-11", version: 1 },
  { id: "group-4", courseId: "course-1", name: "第 3 组", direction: "学习辅助", leaderId: "member-12", memberIds: ["member-12", "member-13", "member-14"], rosterFrozen: false, createdAt: "2026-09-12", version: 1 },
  { id: "group-5", courseId: "course-1", name: "第 5 组", direction: "数据分析", leaderId: "member-15", memberIds: ["member-15", "member-16", "member-17"], rosterFrozen: false, createdAt: "2026-09-15", version: 1 },
  { id: "group-6", courseId: "course-1", name: "第 6 组", direction: "AI 工具", leaderId: "member-18", memberIds: ["member-18", "member-19", "member-20"], rosterFrozen: false, createdAt: "2026-09-16", version: 1 },
  { id: "group-7", courseId: "course-3", name: "AI2025 第 1 组", direction: "校园数据分析", leaderId: "member-1", memberIds: ["member-1", "member-22", "member-23"], projectId: "project-4", rosterFrozen: true, createdAt: "2025-09-18", version: 1 },
];

const projects: MockData["projects"] = [
  { id: "project-1", courseId: "course-1", groupId: "group-1", name: "GroupProof", description: "基于证据的高校小组项目协作平台", type: "课程项目", finalDeadline: "2026-12-20", setupStep: 2, setupStatus: "frozen", baselineVersion: 1, planVersion: 3, planConfirmed: true, confirmedBy: ["member-1", "member-2", "member-3", "member-4"], lifecycle: "active", progress: 72, coreProgress: 74, memberIds: ["member-1", "member-2", "member-3", "member-4"], version: 3 },
  { id: "project-2", courseId: "course-2", name: "校园服务导航", description: "为学生提供校园服务统一入口", type: "课程项目", finalDeadline: "2026-12-10", setupStep: 1, setupStatus: "not_initialized", baselineVersion: 0, planVersion: 0, planConfirmed: false, confirmedBy: [], lifecycle: "active", progress: 0, coreProgress: 0, memberIds: ["member-1", "member-5"], version: 1 },
  { id: "project-3", courseId: "course-1", groupId: "group-2", name: "智能交通分析", description: "基于数据的城市交通现状分析与优化建议", type: "课程报告", finalDeadline: "2026-12-20", setupStep: 6, setupStatus: "frozen", baselineVersion: 1, planVersion: 1, planConfirmed: true, confirmedBy: ["member-5", "member-6", "member-7"], lifecycle: "active", progress: 92, coreProgress: 88, memberIds: ["member-5", "member-6", "member-7"], version: 2 },
  { id: "project-4", courseId: "course-3", groupId: "group-7", name: "校园数据分析", description: "课程历史项目，正式版本已归档。", type: "课程项目", finalDeadline: "2025-12-18", setupStep: 6, setupStatus: "frozen", baselineVersion: 1, planVersion: 1, planConfirmed: true, confirmedBy: ["member-1", "member-22", "member-23"], lifecycle: "archived", progress: 100, coreProgress: 100, memberIds: ["member-1", "member-22", "member-23"], version: 1 },
];

const modules: MockData["modules"] = [
  { id: "module-1", projectId: "project-1", name: "身份与课程", description: "账户验证与课程身份关联", requirementIds: ["req-1"], ownerId: "member-1", progress: 90, core: true },
  { id: "module-2", projectId: "project-1", name: "项目初始化", description: "资料导入、需求分析与基线冻结", requirementIds: ["req-2"], ownerId: "member-2", progress: 60, core: true },
  { id: "module-3", projectId: "project-1", name: "任务与里程碑", description: "任务拆解、责任与进度", requirementIds: ["req-3"], ownerId: "member-3", progress: 55, core: true },
  { id: "module-4", projectId: "project-1", name: "证据与验收", description: "证据链与逐项验收", requirementIds: ["req-4"], ownerId: "member-4", progress: 65, core: true },
  { id: "module-5", projectId: "project-1", name: "贡献与报告", description: "成员贡献与最终报告", requirementIds: ["req-5"], ownerId: "member-1", progress: 40, core: false },
];

const requirements: MockData["requirements"] = [
  { id: "req-1", projectId: "project-1", title: "登录与身份", description: "支持高校师生使用学校统一身份完成验证与权限识别。", priority: "high", status: "verified", moduleId: "module-1", version: 1, source: "课程说明.pdf" },
  { id: "req-2", projectId: "project-1", title: "基线冻结", description: "将需求集合冻结为基线，记录版本信息，仅通过变更申请修改。", priority: "high", status: "implemented", moduleId: "module-2", version: 1, source: "Proposal.docx" },
  { id: "req-3", projectId: "project-1", title: "任务规划与追踪", description: "将需求拆解为任务与子任务，保留责任、权重、状态和验收标准。", priority: "high", status: "in_progress", moduleId: "module-3", version: 1, source: "需求规格说明书.md" },
  { id: "req-4", projectId: "project-1", title: "证据追溯", description: "为每项验收标准关联可追溯证据并记录验收结果。", priority: "high", status: "in_progress", moduleId: "module-4", version: 1, source: "课程说明.pdf" },
  { id: "req-5", projectId: "project-1", title: "贡献计算", description: "基于任务权重、正式证据与验收结果汇总成员贡献。", priority: "medium", status: "confirmed", moduleId: "module-5", version: 1, source: "Proposal.docx" },
];

const taskSpecs = [
  ["task-1", "T-03", "GitHub 集成", "module-4", "req-4", "in_progress", 80, 20, "high", "member-1", "milestone-2"],
  ["task-2", "T-01", "账号与学校身份验证", "module-1", "req-1", "completed", 100, 15, "high", "member-1", "milestone-1"],
  ["task-3", "T-18", "证据完整性界面", "module-4", "req-4", "pending_submission", 75, 10, "high", "member-2", "milestone-3"],
  ["task-4", "T-22", "报告导出", "module-5", "req-5", "not_started", 20, 10, "medium", "member-3", "milestone-4"],
  ["task-5", "T-02", "项目初始化向导", "module-2", "req-2", "completed", 100, 15, "high", "member-2", "milestone-1"],
  ["task-6", "T-19", "身份与课程关联", "module-1", "req-1", "pending_verification", 95, 8, "medium", "member-3", "milestone-2"],
  ["task-7", "T-14", "飞书协作记录同步", "module-4", "req-4", "in_progress", 55, 8, "medium", "member-4", "milestone-3"],
  ["task-8", "T-09", "课程规则导入", "module-2", "req-2", "not_started", 0, 5, "low", "member-3", "milestone-2"],
  ["task-9", "T-21", "课程数据清洗", "module-3", "req-3", "pending_submission", 90, 5, "medium", "member-4", "milestone-3"],
  ["task-10", "T-20", "M2 验收材料准备", "module-4", "req-4", "pending_verification", 100, 4, "medium", "member-1", "milestone-2"],
] as const;

const tasks: Task[] = taskSpecs.map(([id, code, title, moduleId, requirementId, status, progress, weight, priority, responsibleId, milestoneId]) => ({
  id,
  projectId: "project-1",
  moduleId,
  requirementIds: [requirementId],
  title: `${code} ${title}`,
  description: `${title}，保留与需求、验收标准和项目证据的关联。`,
  responsibleIds: [responsibleId],
  priority,
  weight,
  status,
  progress,
  milestoneIds: [milestoneId],
  criterionIds: [`${id}-ac-1`, `${id}-ac-2`],
  dependencyIds: [],
  version: 1,
  updatedAt: now,
}));

tasks.push(
  { ...tasks[0], id: "task-1a", parentTaskId: "task-1", title: "T-03.1 Webhook 与定时同步", description: "处理 GitHub 事件并提供定时同步兜底。", responsibleIds: ["member-1"], status: "completed", progress: 100, weight: 10, criterionIds: ["task-1a-ac-1", "task-1a-ac-2"] },
  { ...tasks[0], id: "task-1b", parentTaskId: "task-1", title: "T-03.2 开发活动映射", description: "将 PR、Commit 和 CI 记录映射至任务。", responsibleIds: ["member-4"], status: "in_progress", progress: 60, weight: 10, criterionIds: ["task-1b-ac-1", "task-1b-ac-2"] },
);

const criteria: AcceptanceCriterion[] = tasks.flatMap((task) => [
  { id: `${task.id}-ac-1`, taskId: task.id, text: `${task.title.slice(5)}的核心流程可以正常完成。`, version: 1, result: task.status === "completed" ? "passed" : undefined, humanConfirmedBy: task.status === "completed" ? task.responsibleIds : [] },
  { id: `${task.id}-ac-2`, taskId: task.id, text: `相关结果和操作记录可以关联为可追溯证据。`, version: 1, result: task.status === "completed" ? "passed" : undefined, humanConfirmedBy: task.status === "completed" ? task.responsibleIds : [] },
]);

const evidence: MockData["evidence"] = [
  { id: "evidence-1", projectId: "project-1", taskId: "task-1", criterionIds: ["task-1-ac-1"], authorId: "member-1", title: "PR #128 集成 GitHub Webhook", description: "实现仓库事件同步与任务映射", source: "github", sourceUrl: "https://github.com/example/groupproof/pull/128", status: "formal", createdAt: "2026-10-04T14:03:00Z", version: 1 },
  { id: "evidence-2", projectId: "project-1", taskId: "task-1", criterionIds: ["task-1-ac-2"], authorId: "member-1", title: "Commit a41f2c 配置 Webhook", description: "联调活动同步", source: "github", sourceUrl: "https://github.com/example/groupproof/commit/a41f2c", status: "formal", createdAt: "2026-10-03T19:45:00Z", version: 1 },
  { id: "evidence-3", projectId: "project-1", taskId: "task-2", criterionIds: ["task-2-ac-1", "task-2-ac-2"], authorId: "member-1", title: "学校邮箱验证测试报告", description: "覆盖验证码与身份识别", source: "file", status: "formal", createdAt: "2026-10-02T10:15:00Z", version: 1 },
  { id: "evidence-4", projectId: "project-1", taskId: "task-3", criterionIds: ["task-3-ac-1"], authorId: "member-2", title: "证据检查页面截图", description: "显示覆盖率和缺失标准", source: "screenshot", status: "candidate", createdAt: "2026-10-05T08:30:00Z", version: 1 },
  { id: "evidence-5", projectId: "project-1", taskId: "task-6", criterionIds: ["task-6-ac-1", "task-6-ac-2"], authorId: "member-3", title: "课程身份映射 PR #132", description: "关联学校身份与课程成员", source: "github", status: "formal", createdAt: "2026-10-04T11:20:00Z", version: 1 },
  { id: "evidence-6", projectId: "project-1", taskId: "task-7", criterionIds: ["task-7-ac-1"], authorId: "member-4", title: "飞书决议摘录", description: "确认协作记录只读导入范围", source: "feishu", status: "pending_confirmation", createdAt: "2026-10-04T16:20:00Z", version: 1 },
];

const verifications: MockData["verifications"] = [
  { id: "verification-1", taskId: "task-3", projectId: "project-1", result: "partially_passed", criterionResults: [{ criterionId: "task-3-ac-1", result: "passed", evidenceIds: ["evidence-4"], confidence: 0.88, reason: "页面显示覆盖率与缺失信息。", remediation: "" }, { criterionId: "task-3-ac-2", result: "uncertain", evidenceIds: [], confidence: 0.54, reason: "缺少可追溯的操作记录。", remediation: "补充界面测试记录。" }], confidence: 0.71, status: "current", createdAt: "2026-10-05T08:45:00Z", humanConfirmedBy: [], version: 1 },
  { id: "verification-2", taskId: "task-6", projectId: "project-1", result: "passed", criterionResults: [{ criterionId: "task-6-ac-1", result: "passed", evidenceIds: ["evidence-5"], confidence: 0.93, reason: "代码与测试记录覆盖核心流程。", remediation: "" }, { criterionId: "task-6-ac-2", result: "passed", evidenceIds: ["evidence-5"], confidence: 0.88, reason: "提交记录可追溯。", remediation: "" }], confidence: 0.91, status: "current", createdAt: "2026-10-04T12:00:00Z", humanConfirmedBy: [], version: 1 },
];

const milestones: MockData["milestones"] = [
  { id: "milestone-1", projectId: "project-1", title: "M1 需求与基线确认", description: "完成项目组队、资料导入和需求确认。", deadline: "2026-10-15", status: "completed", progress: 100, taskIds: ["task-2", "task-5"], deliverables: ["需求规格说明", "基线 v1"] },
  { id: "milestone-2", projectId: "project-1", title: "M2 核心流程实现", description: "完成任务与核心集成流程。", deadline: "2026-10-25", status: "in_progress", progress: 72, taskIds: ["task-1", "task-6", "task-8", "task-10"], deliverables: ["核心流程演示", "GitHub 集成记录"] },
  { id: "milestone-3", projectId: "project-1", title: "M3 证据与贡献体系", description: "完成证据收集、逐项验收与贡献追溯。", deadline: "2026-11-20", status: "at_risk", progress: 54, taskIds: ["task-3", "task-7", "task-9"], deliverables: ["证据链", "AI 验收记录"] },
  { id: "milestone-4", projectId: "project-1", title: "M4 最终验收与报告", description: "完成贡献确认和正式报告。", deadline: "2026-12-20", status: "not_started", progress: 20, taskIds: ["task-4"], deliverables: ["项目报告 PDF + Word", "演示视频"] },
];

export const seedData: MockData = {
  currentUserId: "member-1",
  currentRole: "leader",
  users,
  courses,
  groups,
  projects,
  requirements,
  modules,
  tasks,
  criteria,
  evidence,
  verifications,
  milestones,
  github: [
    { id: "gh-1", projectId: "project-1", repository: "groupproof/web", type: "pr", title: "PR #128 集成 GitHub Webhook 同步活动", authorId: "member-1", taskId: "task-1", status: "已合并", timestamp: "2026-10-04T14:03:00Z", url: "https://github.com/example/groupproof/pull/128" },
    { id: "gh-2", projectId: "project-1", repository: "groupproof/web", type: "commit", title: "Commit a41f2c add github integration", authorId: "member-1", taskId: "task-1", status: "已推送", timestamp: "2026-10-03T19:45:00Z", url: "https://github.com/example/groupproof/commit/a41f2c" },
    { id: "gh-3", projectId: "project-1", repository: "groupproof/api", type: "ci", title: "CI #214 单元测试与构建", authorId: "member-3", taskId: "task-6", status: "通过", timestamp: "2026-10-04T12:30:00Z", url: "https://github.com/example/groupproof/actions" },
    { id: "gh-4", projectId: "project-1", repository: "groupproof/web", type: "sync", title: "仓库活动同步", authorId: "member-2", status: "已同步", timestamp: "2026-10-05T08:00:00Z", url: "https://github.com/example/groupproof" },
  ],
  feishu: [
    { id: "feishu-1", projectId: "project-1", groupName: "GroupProof 项目组", type: "decision", summary: "确认将验收结果按标准逐项展示。", authorId: "member-1", timestamp: "2026-10-04T18:20:00Z", status: "adopted", taskId: "task-3" },
    { id: "feishu-2", projectId: "project-1", groupName: "GroupProof 项目组", type: "task", summary: "李四补充证据完整性测试截图。", authorId: "member-2", timestamp: "2026-10-04T16:30:00Z", status: "candidate", taskId: "task-3" },
    { id: "feishu-3", projectId: "project-1", groupName: "课程讨论群", type: "discussion", summary: "讨论课程规则更新对里程碑的影响。", authorId: "teacher-1", timestamp: "2026-10-03T11:20:00Z", status: "candidate" },
  ],
  files: [
    { id: "file-1", projectId: "project-1", name: "课程说明.pdf", type: "PDF", source: "课程资料", uploaderId: "teacher-1", version: 2, status: "current", updatedAt: "2026-10-01", size: "2.4 MB" },
    { id: "file-2", projectId: "project-1", name: "Proposal.docx", type: "DOCX", source: "项目资料", uploaderId: "member-1", version: 1, status: "current", updatedAt: "2026-10-02", size: "1.2 MB" },
    { id: "file-3", projectId: "project-1", name: "需求规格说明.md", type: "MD", source: "项目资料", uploaderId: "member-2", version: 2, status: "current", updatedAt: "2026-10-04", size: "58 KB" },
    { id: "file-4", courseId: "course-1", name: "课程项目模板.docx", type: "DOCX", source: "课程文件", uploaderId: "teacher-1", version: 3, status: "current", updatedAt: "2026-09-28", size: "980 KB" },
  ],
  discussions: [
    { id: "discussion-1", projectId: "project-1", title: "M2 验收清单确认", body: "请确认核心流程是否需要增加演示视频。", authorId: "member-1", taskId: "task-10", replies: [{ id: "reply-1", authorId: "member-2", text: "建议保留视频，方便课程验收。", at: "2026-10-04T14:30:00Z" }], updatedAt: "2026-10-04T14:30:00Z" },
    { id: "discussion-2", projectId: "project-1", title: "证据引用格式", body: "统一按任务和验收标准标识证据。", authorId: "member-4", taskId: "task-3", replies: [], updatedAt: "2026-10-03T10:20:00Z" },
  ],
  contributions: [
    { id: "contribution-1", projectId: "project-1", memberId: "member-1", taskCredit: 42, collaborationCredit: 8, share: 38, acceptanceRate: 100, status: "formal", taskIds: ["task-1", "task-2", "task-10"], taskRatios: { "task-1": 75, "task-2": 100, "task-10": 50 }, evidenceIds: ["evidence-1", "evidence-2", "evidence-3"], note: "负责核心集成与身份验证，所有正式得分均可追溯。" },
    { id: "contribution-2", projectId: "project-1", memberId: "member-2", taskCredit: 28, collaborationCredit: 6, share: 28, acceptanceRate: 88, status: "formal", taskIds: ["task-3", "task-5"], taskRatios: { "task-3": 100, "task-5": 80 }, evidenceIds: ["evidence-4"], note: "负责初始化向导与证据检查。" },
    { id: "contribution-3", projectId: "project-1", memberId: "member-3", taskCredit: 20, collaborationCredit: 5, share: 21, acceptanceRate: 83, status: "formal", taskIds: ["task-4", "task-6", "task-8"], taskRatios: { "task-4": 100, "task-6": 80, "task-8": 50 }, evidenceIds: ["evidence-5"], note: "负责课程关联和报告模块。" },
    { id: "contribution-4", projectId: "project-1", memberId: "member-4", taskCredit: 14, collaborationCredit: 5, share: 13, acceptanceRate: 67, status: "disputed", taskIds: ["task-7", "task-9"], taskRatios: { "task-7": 100, "task-9": 90 }, evidenceIds: ["evidence-6"], note: "有一项协作证据待确认。" },
  ],
  reports: [
    { id: "report-1", projectId: "project-1", version: 1, status: "generated", createdAt: "2026-10-05T09:00:00Z", sections: [
      { id: "summary", title: "执行摘要", body: "本项目围绕高校小组项目的任务、证据与贡献记录构建协作流程。" },
      { id: "goals", title: "项目目标与需求", body: "建立从需求基线到功能模块、任务、验收标准的完整追溯路径。" },
      { id: "progress", title: "里程碑与功能完成情况", body: "M1 已完成；M2 处于核心流程实现阶段。" },
      { id: "collaboration", title: "团队协作与贡献", body: "成员按照任务权重与正式证据分工，贡献结果保留计算依据。" },
      { id: "evidence", title: "证据与验收", body: "GitHub 开发记录、文件与确认记录关联至具体任务和验收标准。" },
      { id: "conclusion", title: "结论与后续工作", body: "继续补齐证据完整性检查、人工验收与最终报告。" },
    ] },
  ],
  notifications: [
    { id: "notification-1", userId: "member-1", type: "project", title: "T-18 需要补充证据", description: "证据完整性检查缺少可追溯测试记录。", read: false, createdAt: "2026-10-05T08:45:00Z", href: "/projects/project-1/tasks/task-3/evidence-check" },
    { id: "notification-2", userId: "member-1", type: "course", title: "课程规则 v2 已发布", description: "请确认本次规则变更对项目的影响。", read: false, createdAt: "2026-10-04T17:00:00Z", href: "/courses/course-1/rule-changes" },
    { id: "notification-3", userId: "member-1", type: "system", title: "学校邮箱验证成功", description: "账户可使用课程和项目协作功能。", read: true, createdAt: "2026-10-01T10:00:00Z", href: "/onboarding/profile" },
  ],
  actionItems: [
    { id: "action-1", assigneeId: "member-1", projectId: "project-1", type: "verification", title: "确认 T-19 AI 验收结果", description: "验收结果已通过，仍需负责人确认。", status: "pending", dueAt: "2026-10-07", href: "/projects/project-1/tasks/task-6/verification", priority: "high" },
    { id: "action-2", assigneeId: "member-1", courseId: "course-1", type: "rule", title: "确认课程规则 v2", description: "检查截止日期和交付物调整。", status: "pending", dueAt: "2026-10-08", href: "/courses/course-1/rule-changes", priority: "medium" },
    { id: "action-3", assigneeId: "member-2", projectId: "project-1", type: "evidence", title: "补充 T-18 证据", description: "请补充操作记录与界面测试报告。", status: "pending", dueAt: "2026-10-06", href: "/projects/project-1/tasks/task-3/submit", priority: "high" },
    { id: "action-4", assigneeId: "teacher-1", courseId: "course-1", groupId: "group-1", subjectUserId: "member-4", changeKind: "leave", type: "member_change", title: "审核 GroupProof Team 4 成员变更", description: "退出申请需要确认未完成任务交接。", status: "pending", dueAt: "2026-10-07", href: "/teacher/courses/course-1/member-changes", priority: "high" },
    { id: "action-5", assigneeId: "teacher-1", courseId: "course-1", projectId: "project-1", subjectUserId: "member-4", type: "appeal", title: "处理第 4 组贡献申诉", description: "请核对证据与系统计算。", status: "pending", dueAt: "2026-10-09", href: "/teacher/courses/course-1/appeals", priority: "medium" },
  ],
  teacherRequests: [
    { id: "teacher-request-1", userId: "teacher-3", courseId: "course-1", status: "pending", submittedAt: "2026-10-04T11:00:00Z", reason: "申请担任软件工程课程教师。" },
    { id: "teacher-request-2", userId: "teacher-2", courseId: "course-3", status: "approved", submittedAt: "2025-09-01T11:00:00Z", reason: "课程负责人。" },
  ],
  accessRequests: [
    { id: "access-request-1", applicantId: "member-3", type: "证据访问申请", reason: "申诉需要查看原始证据", target: "项目 GroupProof / T-18", risk: "high", status: "pending", submittedAt: "2026-10-04T14:32:00Z" },
    { id: "access-request-2", applicantId: "teacher-1", type: "异常内容访问", reason: "处理贡献申诉需查看完整证据链", target: "第 4 组 / 软件工程", risk: "high", status: "pending", submittedAt: "2026-10-04T14:00:00Z" },
    { id: "access-request-3", applicantId: "admin-1", type: "系统日志导出", reason: "课程审计", target: "软件工程 2026", risk: "medium", status: "approved", submittedAt: "2026-10-03T20:15:00Z", decisionReason: "限时审计访问" },
  ],
  logs: [
    { id: "log-1", actorId: "admin-1", action: "教师身份审批", target: "teacher-2", result: "success", ip: "10.0.12.8", createdAt: "2026-10-05T08:15:00Z", detail: "教师角色审核通过" },
    { id: "log-2", actorId: "member-1", action: "任务证据提交", target: "task-1", result: "success", ip: "10.0.10.24", createdAt: "2026-10-04T14:03:00Z", detail: "关联 PR #128" },
    { id: "log-3", actorId: "teacher-1", action: "课程规则变更", target: "course-1", result: "success", ip: "10.0.13.2", createdAt: "2026-10-03T16:20:00Z", detail: "发布规则 v2" },
  ],
  aiUsage: [
    { id: "ai-usage-1", workflow: "需求分析", model: "GPT-4o", calls: 84, failures: 2, avgLatencyMs: 1840, cost: 12.4 },
    { id: "ai-usage-2", workflow: "任务生成", model: "GPT-4o", calls: 56, failures: 1, avgLatencyMs: 2190, cost: 9.7 },
    { id: "ai-usage-3", workflow: "证据验收", model: "Qwen", calls: 142, failures: 3, avgLatencyMs: 1650, cost: 13.8 },
    { id: "ai-usage-4", workflow: "报告生成", model: "Claude 3.5", calls: 31, failures: 1, avgLatencyMs: 2870, cost: 11.2 },
  ],
};
