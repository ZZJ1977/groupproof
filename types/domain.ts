export type Role = "student" | "leader" | "teacher" | "ta" | "admin";
export type TaskStatus = "not_started" | "in_progress" | "pending_submission" | "pending_verification" | "completed";
export type EvidenceStatus = "candidate" | "pending_confirmation" | "formal" | "withdrawn" | "void";
export type VerificationResult = "passed" | "partially_passed" | "failed" | "uncertain";
export type ActionStatus = "pending" | "completed" | "rejected" | "expired";
export type ProjectLifecycle = "active" | "finalized" | "archived";
export type Priority = "high" | "medium" | "low";

export interface User {
  id: string;
  name: string;
  username: string;
  email: string;
  studentId?: string;
  college: string;
  role: Role;
  verified: boolean;
  status: "active" | "disabled" | "pending";
  teacherStatus?: "pending" | "approved" | "rejected";
  avatarColor: string;
}

export type DelegatedPermission =
  | "course.settings.update"
  | "course.rules.edit"
  | "course.rules.publish";

export interface AssistantGrant {
  userId: string;
  permissions: DelegatedPermission[];
}

export interface Course {
  id: string;
  name: string;
  code: string;
  college: string;
  semester: string;
  teacherId: string;
  status: "active" | "ended" | "draft";
  projectDeadline: string;
  formationDeadline: string;
  groupingMode: "free" | "approval";
  minGroupSize: number;
  maxGroupSize: number;
  memberIds: string[];
  assistantGrants?: AssistantGrant[];
  version: number;
  rules: string[];
  requiredFiles: string[];
  milestoneTemplate?: { id: string; title: string; description: string; deadline: string }[];
}

export interface Group {
  id: string;
  courseId: string;
  name: string;
  direction: string;
  leaderId: string;
  memberIds: string[];
  projectId?: string;
  rosterFrozen: boolean;
  createdAt: string;
  version: number;
}

export interface Project {
  id: string;
  courseId?: string;
  groupId?: string;
  /** 无小组项目的负责人；未确定时不自动按成员数组首项赋权 */
  ownerId?: string;
  name: string;
  description: string;
  type: string;
  language?: "zh" | "en";
  visibility?: "members" | "course";
  githubEnabled?: boolean;
  feishuEnabled?: boolean;
  finalDeadline: string;
  setupStep: number;
  setupStatus: "not_initialized" | "draft" | "pending_confirmation" | "frozen";
  baselineVersion: number;
  planVersion: number;
  planConfirmed: boolean;
  confirmedBy: string[];
  lifecycle: ProjectLifecycle;
  progress: number;
  coreProgress: number;
  memberIds: string[];
  version: number;
  activeBaselineRevisionId?: string;
  activePlanRevisionId?: string;
  appliedCourseRuleRevisionId?: string;
  /** 重新开启/修订版本的来源项目 */
  sourceProjectId?: string;
}

/** 课程内可见项目的公开总览 DTO：仅包含这些字段，不含任务、资料与确认记录 */
export type ProjectSummary =
  Pick<Project, "id" | "name" | "description" | "progress" | "lifecycle">;

/** 个人确认绑定具体修订、内容版本与确认名单 */
export interface MemberConfirmation {
  userId: string;
  revisionId: string;
  contentVersion: number;
  confirmedAt: string;
}

export interface Revision<T> {
  id: string;
  projectId: string;
  number: number;
  /** 实体并发版本，与内容版本分别递增 */
  version: number;
  contentVersion: number;
  status: "draft" | "confirming" | "published";
  payload: T;
  memberRoster: string[];
  confirmations: MemberConfirmation[];
  basedOnRevisionId?: string;
  /** 最近一次草稿修改的变更原因 */
  reason?: string;
  /** 旧数据迁移来源；不为历史确认伪造时间 */
  legacy?: { confirmedUserIds: string[]; timestampUnknown: true };
}

export interface BaselinePayload {
  requirements: Requirement[];
  modules: FunctionalModule[];
  sourceFileIds: string[];
}

export interface PlanPayload {
  tasks: Task[];
  criteria: AcceptanceCriterion[];
  milestoneLinks: { taskId: string; milestoneIds: string[] }[];
}

export type BaselineRevision = Revision<BaselinePayload>;
export type PlanRevision = Revision<PlanPayload> & {
  baselineRevisionId: string;
};

/** 课程约束与模板的结构化快照；旧 rules 文本仍保留用于展示 */
export interface CourseRuleSnapshot {
  projectDeadline: string;
  formationDeadline: string;
  groupingMode: "free" | "approval";
  minGroupSize: number;
  maxGroupSize: number;
  requiredFiles: string[];
  gradingNotes?: string;
  githubRequired: boolean;
  aiAllowed: boolean;
  milestoneTemplate?: { id: string; title: string; description: string; deadline: string }[];
}

/** 教师规则/模板编辑的结构化载荷；旧 rules 文本保留用于展示 */
export interface CourseRulePayload {
  projectDeadline: string;
  formationDeadline: string;
  groupingMode: Course["groupingMode"];
  minGroupSize: number;
  maxGroupSize: number;
  requiredFiles: string[];
  gradingNotes: string;
  githubRequired: boolean;
  aiAllowed: boolean;
  rulesText: string[];
  milestoneTemplate: NonNullable<Course["milestoneTemplate"]>;
}

export interface CourseRuleRevision {
  id: string;
  courseId: string;
  number: number;
  version: number;
  status: "draft" | "published";
  snapshot: CourseRuleSnapshot;
  rulesText: string[];
  publishedBy?: string;
  publishedAt?: string;
  reason?: string;
  basedOnRevisionId?: string;
  legacy?: { timestampUnknown: true };
}

/** 课程规则变更对项目的影响与确认 */
export interface RuleChangeReview {
  id: string;
  projectId: string;
  courseRuleRevisionId: string;
  previousCourseRuleRevisionId?: string;
  impact: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

/** 六步初始化向导草稿；刷新后可恢复字段、来源、冲突选择和步骤位置 */
export interface SetupDraft {
  projectId: string;
  step: 1 | 2 | 3 | 4 | 5 | 6;
  form: { name: string; description: string; type: string; finalDeadline: string };
  selectedFileIds: string[];
  pastedSources: { id: string; title: string; text: string }[];
  analysis: { status: "idle" | "running" | "succeeded" | "failed"; jobId?: string };
  conflicts: { id: string; field: string; choices: string[]; selected?: string }[];
  baselineDraftId?: string;
  version: number;
}

export interface Requirement {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  status: "draft" | "confirmed" | "in_progress" | "implemented" | "verified";
  moduleId: string;
  version: number;
  source: string;
}

export interface FunctionalModule {
  id: string;
  projectId: string;
  name: string;
  description: string;
  requirementIds: string[];
  ownerId: string;
  progress: number;
  core: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  moduleId: string;
  parentTaskId?: string;
  requirementIds: string[];
  title: string;
  description: string;
  responsibleIds: string[];
  priority: Priority;
  weight: number;
  status: TaskStatus;
  progress: number;
  milestoneIds: string[];
  criterionIds: string[];
  dependencyIds: string[];
  version: number;
  updatedAt: string;
}

export interface AcceptanceCriterion {
  id: string;
  taskId: string;
  text: string;
  version: number;
  result?: VerificationResult;
  humanConfirmedBy: string[];
}

export interface Evidence {
  id: string;
  projectId: string;
  taskId: string;
  criterionIds: string[];
  authorId: string;
  title: string;
  description: string;
  source: "github" | "file" | "screenshot" | "feishu" | "discussion" | "manual";
  sourceUrl?: string;
  status: EvidenceStatus;
  createdAt: string;
  version: number;
}

export interface Verification {
  id: string;
  taskId: string;
  projectId: string;
  result: VerificationResult;
  criterionResults: { criterionId: string; result: VerificationResult; evidenceIds: string[]; confidence: number; reason: string; remediation: string }[];
  confidence: number;
  status: "current" | "outdated";
  createdAt: string;
  humanConfirmedBy: string[];
  version: number;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  deadline: string;
  status: "not_started" | "in_progress" | "completed" | "at_risk";
  progress: number;
  taskIds: string[];
  deliverables: string[];
}

export interface GithubActivity {
  id: string;
  projectId: string;
  repository: string;
  type: "commit" | "pr" | "ci" | "sync";
  title: string;
  authorId: string;
  taskId?: string;
  status: string;
  timestamp: string;
  url: string;
}

export interface FeishuRecord {
  id: string;
  projectId: string;
  groupName: string;
  type: "decision" | "task" | "discussion";
  summary: string;
  authorId: string;
  timestamp: string;
  status: "candidate" | "adopted" | "ignored";
  taskId?: string;
}

export interface FileRecord {
  id: string;
  projectId?: string;
  courseId?: string;
  name: string;
  type: string;
  source: string;
  uploaderId: string;
  version: number;
  status: "current" | "superseded" | "draft";
  updatedAt: string;
  size: string;
  /** 原始字节数与 MIME（阶段 10）；旧记录缺失时以 size 文本展示 */
  sizeBytes?: number;
  mimeType?: string;
}

export interface Discussion {
  id: string;
  projectId: string;
  title: string;
  body: string;
  authorId: string;
  taskId?: string;
  replies: { id: string; authorId: string; text: string; at: string }[];
  updatedAt: string;
}

export interface Contribution {
  id: string;
  projectId: string;
  memberId: string;
  taskCredit: number;
  collaborationCredit: number;
  share: number;
  acceptanceRate: number;
  status: "provisional" | "formal" | "disputed";
  taskIds: string[];
  taskRatios?: Record<string, number>;
  evidenceIds: string[];
  note: string;
}

export interface Report {
  id: string;
  projectId: string;
  version: number;
  status: "draft" | "generated" | "finalized";
  createdAt: string;
  format?: "pdf" | "word";
  includesAppendix?: boolean;
  sections: { id: string; title: string; body: string }[];
}

export interface Notification {
  id: string;
  userId: string;
  type: "course" | "project" | "system";
  title: string;
  description: string;
  read: boolean;
  createdAt: string;
  href: string;
}

export interface ActionItem {
  id: string;
  assigneeId: string;
  courseId?: string;
  projectId?: string;
  groupId?: string;
  subjectUserId?: string;
  changeKind?: "join" | "leave" | "remove";
  handoffAssignments?: Record<string, string>;
  type: string;
  title: string;
  description: string;
  status: ActionStatus;
  dueAt: string;
  href: string;
  priority: Priority;
}

export interface TeacherRequest {
  id: string;
  userId: string;
  courseId: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  reason: string;
}

export interface AccessRequest {
  id: string;
  applicantId: string;
  type: string;
  reason: string;
  target: string;
  risk: Priority;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  decisionReason?: string;
}

export interface SystemLog {
  id: string;
  actorId: string;
  action: string;
  target: string;
  result: "success" | "failure";
  ip: string;
  createdAt: string;
  detail: string;
}

export interface AiUsage {
  id: string;
  workflow: string;
  model: string;
  calls: number;
  failures: number;
  avgLatencyMs: number;
  cost: number;
}

export interface MockData {
  schemaVersion: number;
  currentUserId: string;
  currentRole: Role;
  users: User[];
  courses: Course[];
  groups: Group[];
  projects: Project[];
  requirements: Requirement[];
  modules: FunctionalModule[];
  tasks: Task[];
  criteria: AcceptanceCriterion[];
  evidence: Evidence[];
  verifications: Verification[];
  milestones: Milestone[];
  github: GithubActivity[];
  feishu: FeishuRecord[];
  files: FileRecord[];
  discussions: Discussion[];
  contributions: Contribution[];
  reports: Report[];
  baselineRevisions: BaselineRevision[];
  planRevisions: PlanRevision[];
  courseRuleRevisions: CourseRuleRevision[];
  ruleChangeReviews: RuleChangeReview[];
  setupDrafts: SetupDraft[];
  notifications: Notification[];
  actionItems: ActionItem[];
  teacherRequests: TeacherRequest[];
  accessRequests: AccessRequest[];
  logs: SystemLog[];
  aiUsage: AiUsage[];
}

export type CollectionKey = {
  [K in keyof MockData]: MockData[K] extends { id: string }[] ? K : never;
}[keyof MockData];

export type CollectionEntity<K extends CollectionKey> = MockData[K] extends (infer T)[] ? T : never;
