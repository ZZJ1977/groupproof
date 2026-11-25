export type MockActor = "teacher" | "ta" | "student" | "outsider" | "anonymous";

export interface StaffPermissions {
  approve_joins: boolean;
  manage_groups: boolean;
  manage_files: boolean;
  approve_changes: boolean;
  export_reports: boolean;
  post_announcements: boolean;
}

export interface ActorIdentity {
  actor: MockActor;
  authenticated: boolean;
  id: string;
  name: string;
  username: string;
  email: string;
  studentId: string | null;
  college: string;
  requestedIdentity: "teacher" | "student";
  roles: string[];
  preferredLocale: string;
  csrfToken: string;
  nextActionHref: string;
}

export interface RosterStudentRecord {
  id: string;
  name: string | null;
  student_number: string | null;
  email: string | null;
  initial: string;
  joined_at: string;
  status: "grouped" | "ungrouped" | "left";
  group_id: string | null;
  is_leader: boolean;
  in_project_group: boolean;
}

export interface GroupRecord {
  id: string;
  course_id: string;
  name: string;
  direction: string | null;
  leader_id: string | null;
  member_ids: string[];
  max_group_size: number;
  roster_frozen: boolean;
  project_id: string | null;
  lock_version: number;
  locked_reason: string | null;
}

export interface JoinRequestRecord {
  id: string;
  course_id: string;
  student: { id: string; name: string | null };
  student_email: string | null;
  student_number: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  message: string | null;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  lock_version: number;
}

export interface GroupInvitationRecord {
  id: string;
  group_id: string;
  group_name: string;
  course_id: string;
  inviter: { id: string; name: string | null } | null;
  invitee: { id: string; name: string | null } | null;
  status: "pending" | "awaiting_teacher" | "accepted" | "declined" | "approved" | "rejected" | "cancelled";
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  lock_version: number;
}

export interface MembershipChangeRecord {
  id: string;
  course_id: string;
  group_id: string;
  group_name: string;
  project_id: string | null;
  change_type: "remove" | "leave";
  member: { id: string; name: string | null } | null;
  requested_by: { id: string; name: string | null } | null;
  status: "pending" | "needs_info" | "approved" | "rejected" | "applied";
  reason: string;
  teacher_comment: string | null;
  decided_by: { id: string; name: string | null } | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
  lock_version: number;
  can_edit: boolean;
  handovers: {
    task_id: string;
    code: string | null;
    title: string;
    status: string;
    from_user: { id: string; name: string | null } | null;
    to_user: { id: string; name: string | null } | null;
    applied_at: string | null;
  }[];
}

export interface ActionDef {
  key: string;
  label: string;
  requires_reason: boolean;
  confirm_text: string | null;
  style: "primary" | "danger" | "secondary";
}

export interface TeacherActionRecord {
  id: string;
  source_id: string;
  type:
    | "join_request"
    | "post_deadline_invite"
    | "member_leave"
    | "member_remove"
    | "rule_change_review"
    | "milestone_overdue"
    | "risk_alert"
    | "appeal"
    | "notification";
  priority: "urgent" | "normal" | "low";
  status: "pending" | "handled" | "expired" | "auto_resolved";
  title: string;
  description: string;
  course_id: string;
  group_id: string | null;
  project_id: string | null;
  subject_user_id: string | null;
  href: string;
  available_actions: ActionDef[];
  created_at: string;
  handled_at: string | null;
  handled_by: string | null;
  decision: string | null;
  decision_reason: string | null;
}

export interface AppealRecord {
  id: string;
  course_id: string;
  project_id: string;
  project_name: string;
  group_name: string | null;
  appellant_id: string;
  appellant_name: string;
  student_number: string | null;
  appeal_type: "contribution" | "task" | "score" | "other";
  title: string;
  content: string;
  supplement_text: string | null;
  evidence: string[];
  status: "pending" | "need_supplement" | "accepted" | "rejected";
  resolved_by: string | null;
  resolver_name: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  decisions: {
    id: string;
    actor_id: string;
    actor_name: string;
    action: string;
    reason: string;
    snapshot_id: string | null;
    adjustments: Record<string, unknown>[] | null;
    created_at: string;
  }[];
}

export interface RuleMilestoneItem {
  title: string;
  description: string;
  deadline?: string | null;
  deadline_offset_days?: number | null;
  weight?: number | null;
}

export interface CourseRulesData {
  grouping_mode: "free" | "approval";
  min_group_size: number;
  max_group_size: number;
  formation_deadline?: string | null;
  post_deadline_policy: "teacher_approval" | "forbidden" | "free";
  allow_cross_group_transfer: boolean;
  project_deadline?: string | null;
  milestone_template: RuleMilestoneItem[];
  require_baseline_review: boolean;
  require_plan_review: boolean;
  auto_contribution: boolean;
  contribution_weights: { task_weight: number; verification_weight: number; collaboration_weight: number };
  appeal_window_days: number;
  required_deliverables: string[];
  final_presentation: boolean;
}

export interface RuleVersionRecord {
  version_no: number;
  status: "draft" | "published" | "archived";
  change_summary: string;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
  rules: CourseRulesData;
}

export interface CourseFolderRecord {
  id: string;
  course_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface MaterialVersionRecord {
  id: string;
  version_no: number;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  change_note: string | null;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
  has_content: boolean;
  content_text: string;
}

export interface CourseMaterialRecord {
  id: string;
  course_id: string;
  folder_id: string | null;
  name: string;
  visibility: "all" | "grouped" | "staff";
  status: "draft" | "published";
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
  updated_at: string;
  versions: MaterialVersionRecord[];
}

export interface AnnouncementRecord {
  id: string;
  course_id: string;
  title: string;
  content: string;
  priority: "normal" | "important" | "urgent";
  is_pinned: boolean;
  status: "draft" | "published";
  published_by: string;
  publisher_name: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  read_by: Record<string, string>;
}

export interface StaffMemberRecord {
  user_id: string;
  name: string;
  email: string | null;
  role: "teacher" | "ta";
  permissions: StaffPermissions;
  joined_at: string;
  is_owner: boolean;
}

export interface CourseRecord {
  id: string;
  owner_id: string;
  code: string;
  name: string;
  semester: string;
  college: string;
  description: string | null;
  status: "active" | "ended" | "archived";
  archived_at: string | null;
  invite_code: string | null;
  join_mode: "direct" | "approval";
  project_deadline: string | null;
  formation_deadline: string | null;
  min_group_size: number;
  max_group_size: number;
  lock_version: number;
  roster: RosterStudentRecord[];
  groups: GroupRecord[];
  joinRequests: JoinRequestRecord[];
  groupInvitations: GroupInvitationRecord[];
  membershipChanges: MembershipChangeRecord[];
  actions: TeacherActionRecord[];
  appeals: AppealRecord[];
  publishedRuleVersion: RuleVersionRecord | null;
  draftRuleVersion: RuleVersionRecord | null;
  ruleVersions: RuleVersionRecord[];
  folders: CourseFolderRecord[];
  materials: CourseMaterialRecord[];
  announcements: AnnouncementRecord[];
  staff: StaffMemberRecord[];
}

export interface ContributionMemberRecord {
  user_id: string;
  name: string;
  student_number: string | null;
  share: number;
  task_credit: number;
  collaboration_credit: number;
  acceptance_rate: number;
  status: string;
  note: string | null;
}

export interface ProjectRecord {
  id: string;
  course_id: string;
  group_id: string;
  name: string;
  project_type: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  setup_status: "not_initialized" | "draft" | "pending_confirmation" | "frozen";
  setup_step: number;
  lifecycle: "active" | "finalized" | "archived";
  lock_version: number;
  risk_level: "high" | "medium" | "low" | null;
  last_activity_at: string | null;
  milestones: {
    id: string;
    title: string;
    description?: string | null;
    status: string;
    overdue: boolean;
    progress_percent: number;
    deadline: string | null;
    completed_task_count: number;
    task_count: number;
  }[];
  tasks: {
    id: string;
    code: string | null;
    title: string;
    status: string;
    progress_percent: number;
    weight: number;
    assignee_ids: string[];
    milestone_id: string | null;
    lock_version: number;
  }[];
  materials: {
    id: string;
    kind: "text" | "file";
    title: string;
    extract_status: "ready" | "pending" | "failed" | "unavailable";
    extract_reason: string | null;
    text_length: number;
    text: string | null;
    created_by: { id: string; name: string | null } | null;
    created_at: string;
  }[];
  logicalFiles: {
    id: string;
    filename: string;
    category: string;
    version: number;
    status: string;
    size_bytes?: number;
    mime_type?: string;
    content_hash?: string;
    uploaded_by?: string;
    reason?: string;
    created_at: string;
  }[];
  githubRepos: {
    owner: string;
    repo: string;
    default_branch: string;
    linked_at: string;
    last_synced_at: string | null;
  }[];
  feishuChats: {
    chat_id: string;
    linked_at: string;
  }[];
  contributionSnapshot: {
    snapshot_id: string;
    version_no: number;
    status: string;
    frozen_at: string | null;
    items: ContributionMemberRecord[];
  };
}

export interface StorageUploadReceipt {
  receipt_id: string;
  scope: "project" | "course";
  scope_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: "pending" | "completed" | "rejected";
  content_hash: string | null;
  rejection_reason: string | null;
  upload_url: string;
  uploaded_bytes: number;
  completed: boolean;
  expires_at: string;
}

export interface InboxTargetRecord {
  kind:
    | "project"
    | "task"
    | "verification"
    | "evidence"
    | "discussion"
    | "course"
    | "member_change"
    | "appeal"
    | "baseline"
    | "plan"
    | "rule_change";
  id: string;
  project_id: string | null;
  course_id: string | null;
}

export interface NotificationRecord {
  id: string;
  recipient_id: string;
  category: "course" | "project" | "system";
  title: string;
  description: string;
  created_at: string;
  read_at: string | null;
  lock_version: number;
  target: InboxTargetRecord | null;
  href: string | null;
}

export interface ActionItemRecord {
  id: string;
  recipient_id: string;
  category: "task" | "verification" | "evidence" | "rule" | "appeal" | "member" | "course";
  title: string;
  description: string;
  status: "pending" | "completed" | "rejected";
  priority: "low" | "medium" | "high";
  created_at: string;
  due_at: string | null;
  target: InboxTargetRecord;
  href: string;
}

export interface TeacherWorkbenchStore {
  actors: Record<MockActor, ActorIdentity>;
  courses: Map<string, CourseRecord>;
  projects: Map<string, ProjectRecord>;
  storageUploads: Map<string, StorageUploadReceipt>;
  notifications: NotificationRecord[];
  actionItems: ActionItemRecord[];
  inboxVersion: number;
  inboxSnapshotId: string;
  idempotency: Map<string, { payloadHash: string; status: number; body: unknown }>;
  counter: number;
  nextUuid: (prefix?: string) => string;
}

export const TW_TEACHER_ID = "00000000-0000-0000-0000-000000000101";
export const TW_TA_ID = "00000000-0000-0000-0000-000000000102";
export const TW_STUDENT_1_ID = "00000000-0000-0000-0000-000000000201";
export const TW_STUDENT_2_ID = "00000000-0000-0000-0000-000000000202";
export const TW_STUDENT_3_ID = "00000000-0000-0000-0000-000000000203";
export const TW_OUTSIDER_ID = "00000000-0000-0000-0000-000000000299";
export const TW_COURSE_1_ID = "10000000-0000-0000-0000-000000000001";
export const TW_COURSE_2_ID = "10000000-0000-0000-0000-000000000002";
export const TW_GROUP_1_ID = "20000000-0000-0000-0000-000000000001";
export const TW_GROUP_2_ID = "20000000-0000-0000-0000-000000000002";
export const TW_PROJECT_1_ID = "30000000-0000-0000-0000-000000000001";
export const TW_APPEAL_1_ID = "40000000-0000-0000-0000-000000000001";
export const TW_ANNOUNCEMENT_1_ID = "50000000-0000-0000-0000-000000000001";
export const TW_FOLDER_1_ID = "60000000-0000-0000-0000-000000000001";
export const TW_MATERIAL_1_ID = "61000000-0000-0000-0000-000000000001";
export const TW_JOIN_REQ_1_ID = "70000000-0000-0000-0000-000000000001";
export const TW_INVITE_1_ID = "71000000-0000-0000-0000-000000000001";
export const TW_MEMBER_CHANGE_1_ID = "72000000-0000-0000-0000-000000000001";

export function fullStaffPermissions(): StaffPermissions {
  return {
    approve_joins: true,
    manage_groups: true,
    manage_files: true,
    approve_changes: true,
    export_reports: true,
    post_announcements: true,
  };
}

export function defaultTaPermissions(): StaffPermissions {
  return {
    approve_joins: true,
    manage_groups: true,
    manage_files: false,
    approve_changes: false,
    export_reports: true,
    post_announcements: false,
  };
}

function defaultRules(): CourseRulesData {
  return {
    grouping_mode: "free",
    min_group_size: 1,
    max_group_size: 5,
    formation_deadline: "2026-12-01T23:59:00Z",
    post_deadline_policy: "teacher_approval",
    allow_cross_group_transfer: true,
    project_deadline: "2027-01-15T23:59:00Z",
    milestone_template: [
      { title: "需求基线与立项", description: "完成需求文档与模块划分", deadline: "2026-12-10T23:59:00Z", deadline_offset_days: 14, weight: 30 },
      { title: "核心功能实现", description: "提交可运行原型与测试报告", deadline: "2027-01-05T23:59:00Z", deadline_offset_days: 40, weight: 70 },
    ],
    require_baseline_review: true,
    require_plan_review: false,
    auto_contribution: true,
    contribution_weights: { task_weight: 50, verification_weight: 30, collaboration_weight: 20 },
    appeal_window_days: 7,
    required_deliverables: ["源码仓库", "验收报告"],
    final_presentation: true,
  };
}

export function createTeacherWorkbenchStore(): TeacherWorkbenchStore {
  const now = "2026-11-22T10:00:00Z";
  const actors: Record<MockActor, ActorIdentity> = {
    teacher: {
      actor: "teacher",
      authenticated: true,
      id: TW_TEACHER_ID,
      name: "张老师",
      username: "tw_teacher",
      email: "teacher@must.edu.mo",
      studentId: null,
      college: "计算机科学与工程学院",
      requestedIdentity: "teacher",
      roles: ["teacher"],
      preferredLocale: "zh-Hans",
      csrfToken: "tw-csrf-teacher",
      nextActionHref: "/teacher/dashboard",
    },
    ta: {
      actor: "ta",
      authenticated: true,
      id: TW_TA_ID,
      name: "陈助教",
      username: "tw_ta",
      email: "ta@must.edu.mo",
      studentId: null,
      college: "计算机科学与工程学院",
      requestedIdentity: "teacher",
      roles: ["ta"],
      preferredLocale: "zh-Hans",
      csrfToken: "tw-csrf-ta",
      nextActionHref: "/teacher/dashboard",
    },
    student: {
      actor: "student",
      authenticated: true,
      id: TW_STUDENT_1_ID,
      name: "李同学",
      username: "tw_student1",
      email: "student1@student.must.edu.mo",
      studentId: "20260001",
      college: "计算机科学与工程学院",
      requestedIdentity: "student",
      roles: ["student"],
      preferredLocale: "zh-Hans",
      csrfToken: "tw-csrf-student",
      nextActionHref: "/home",
    },
    outsider: {
      actor: "outsider",
      authenticated: true,
      id: TW_OUTSIDER_ID,
      name: "王旁听",
      username: "tw_outsider",
      email: "outsider@student.must.edu.mo",
      studentId: "20260099",
      college: "计算机科学与工程学院",
      requestedIdentity: "student",
      roles: ["outsider"],
      preferredLocale: "zh-Hans",
      csrfToken: "tw-csrf-outsider",
      nextActionHref: "/home",
    },
    anonymous: {
      actor: "anonymous",
      authenticated: false,
      id: "",
      name: "",
      username: "",
      email: "",
      studentId: null,
      college: "",
      requestedIdentity: "student",
      roles: [],
      preferredLocale: "zh-Hans",
      csrfToken: "",
      nextActionHref: "/login",
    },
  };

  const rulesV1: RuleVersionRecord = {
    version_no: 1,
    status: "published",
    change_summary: "初始课程规则",
    published_by: TW_TEACHER_ID,
    published_at: now,
    created_at: now,
    rules: defaultRules(),
  };

  const project1: ProjectRecord = {
    id: TW_PROJECT_1_ID,
    course_id: TW_COURSE_1_ID,
    group_id: TW_GROUP_1_ID,
    name: "智能协作教学平台",
    project_type: "Web Engineering",
    description: "基于飞书交互体验的小组项目协作与贡献度评估平台。",
    start_date: "2026-11-01",
    end_date: "2027-01-15",
    setup_status: "frozen",
    setup_step: 4,
    lifecycle: "active",
    lock_version: 2,
    risk_level: "medium",
    last_activity_at: now,
    milestones: [
      {
        id: "31000000-0000-0000-0000-000000000001",
        title: "需求基线与立项",
        description: "完成需求规格确认与团队分工",
        status: "completed",
        overdue: false,
        progress_percent: 100,
        deadline: "2026-12-10T23:59:00Z",
        completed_task_count: 2,
        task_count: 2,
      },
      {
        id: "31000000-0000-0000-0000-000000000002",
        title: "核心功能实现",
        description: "完成核心接口与前端工作台联调",
        status: "in_progress",
        overdue: true,
        progress_percent: 50,
        deadline: "2026-11-20T23:59:00Z",
        completed_task_count: 1,
        task_count: 2,
      },
    ],
    tasks: [
      {
        id: "32000000-0000-0000-0000-000000000001",
        code: "TASK-01",
        title: "完成 API 接口契约设计",
        status: "done",
        progress_percent: 100,
        weight: 40,
        assignee_ids: [TW_STUDENT_1_ID],
        milestone_id: "31000000-0000-0000-0000-000000000001",
        lock_version: 1,
      },
      {
        id: "32000000-0000-0000-0000-000000000002",
        code: "TASK-02",
        title: "实现前端工作台视图",
        status: "in_progress",
        progress_percent: 50,
        weight: 60,
        assignee_ids: [TW_STUDENT_2_ID],
        milestone_id: "31000000-0000-0000-0000-000000000002",
        lock_version: 1,
      },
    ],
    materials: [
      {
        id: "33000000-0000-0000-0000-000000000001",
        kind: "text",
        title: "项目立项说明",
        extract_status: "ready",
        extract_reason: null,
        text_length: 24,
        text: "智能协作教学平台立项需求说明。",
        created_by: { id: TW_STUDENT_1_ID, name: "李同学" },
        created_at: now,
      },
    ],
    logicalFiles: [
      {
        id: "34000000-0000-0000-0000-000000000001",
        filename: "architecture-v1.pdf",
        category: "documents",
        version: 1,
        status: "current",
        size_bytes: 24576,
        mime_type: "application/pdf",
        created_at: now,
      },
    ],
    githubRepos: [
      {
        owner: "groupproof",
        repo: "collab-platform",
        default_branch: "main",
        linked_at: now,
        last_synced_at: now,
      },
    ],
    feishuChats: [
      {
        chat_id: "oc_tw_group_1",
        linked_at: now,
      },
    ],
    contributionSnapshot: {
      snapshot_id: "35000000-0000-0000-0000-000000000001",
      version_no: 1,
      status: "active",
      frozen_at: null,
      items: [
        {
          user_id: TW_STUDENT_1_ID,
          name: "李同学",
          student_number: "20260001",
          share: 55,
          task_credit: 58,
          collaboration_credit: 52,
          acceptance_rate: 95,
          status: "normal",
          note: null,
        },
        {
          user_id: TW_STUDENT_2_ID,
          name: "赵同学",
          student_number: "20260002",
          share: 45,
          task_credit: 42,
          collaboration_credit: 48,
          acceptance_rate: 90,
          status: "normal",
          note: null,
        },
      ],
    },
  };

  const course1: CourseRecord = {
    id: TW_COURSE_1_ID,
    owner_id: TW_TEACHER_ID,
    code: "SE-2026-01",
    name: "软件工程实践",
    semester: "2026-Autumn",
    college: "计算机科学与工程学院",
    description: "面向大型团队协作与敏捷工程实践的核心课程。",
    status: "active",
    archived_at: null,
    invite_code: "TW-SE01",
    join_mode: "direct",
    project_deadline: "2027-01-15T23:59:00Z",
    formation_deadline: "2026-12-01T23:59:00Z",
    min_group_size: 1,
    max_group_size: 5,
    lock_version: 1,
    roster: [
      {
        id: TW_STUDENT_1_ID,
        name: "李同学",
        student_number: "20260001",
        email: "student1@student.must.edu.mo",
        initial: "李",
        joined_at: now,
        status: "grouped",
        group_id: TW_GROUP_1_ID,
        is_leader: true,
        in_project_group: true,
      },
      {
        id: TW_STUDENT_2_ID,
        name: "赵同学",
        student_number: "20260002",
        email: "student2@student.must.edu.mo",
        initial: "赵",
        joined_at: now,
        status: "grouped",
        group_id: TW_GROUP_1_ID,
        is_leader: false,
        in_project_group: true,
      },
      {
        id: TW_STUDENT_3_ID,
        name: "王同学",
        student_number: "20260003",
        email: "student3@student.must.edu.mo",
        initial: "王",
        joined_at: now,
        status: "ungrouped",
        group_id: null,
        is_leader: false,
        in_project_group: false,
      },
    ],
    groups: [
      {
        id: TW_GROUP_1_ID,
        course_id: TW_COURSE_1_ID,
        name: "第一组 · 飞书协同",
        direction: "协作工作台",
        leader_id: TW_STUDENT_1_ID,
        member_ids: [TW_STUDENT_1_ID, TW_STUDENT_2_ID],
        max_group_size: 5,
        roster_frozen: false,
        project_id: TW_PROJECT_1_ID,
        lock_version: 1,
        locked_reason: null,
      },
      {
        id: TW_GROUP_2_ID,
        course_id: TW_COURSE_1_ID,
        name: "第二组 · 智能评测",
        direction: "自动化测试",
        leader_id: null,
        member_ids: [],
        max_group_size: 5,
        roster_frozen: false,
        project_id: null,
        lock_version: 1,
        locked_reason: null,
      },
    ],
    joinRequests: [
      {
        id: TW_JOIN_REQ_1_ID,
        course_id: TW_COURSE_1_ID,
        student: { id: TW_OUTSIDER_ID, name: "王旁听" },
        student_email: "outsider@student.must.edu.mo",
        student_number: "20260099",
        status: "pending",
        message: "申请旁听并加入软件工程实践课程",
        created_at: now,
        decided_by: null,
        decided_at: null,
        decision_reason: null,
        lock_version: 1,
      },
    ],
    groupInvitations: [
      {
        id: TW_INVITE_1_ID,
        group_id: TW_GROUP_1_ID,
        group_name: "第一组 · 飞书协同",
        course_id: TW_COURSE_1_ID,
        inviter: { id: TW_STUDENT_1_ID, name: "李同学" },
        invitee: { id: TW_STUDENT_3_ID, name: "王同学" },
        status: "awaiting_teacher",
        created_at: now,
        decided_at: null,
        decision_reason: null,
        lock_version: 1,
      },
    ],
    membershipChanges: [
      {
        id: TW_MEMBER_CHANGE_1_ID,
        course_id: TW_COURSE_1_ID,
        group_id: TW_GROUP_1_ID,
        group_name: "第一组 · 飞书协同",
        project_id: TW_PROJECT_1_ID,
        change_type: "leave",
        member: { id: TW_STUDENT_2_ID, name: "赵同学" },
        requested_by: { id: TW_STUDENT_2_ID, name: "赵同学" },
        status: "pending",
        reason: "申请转组到第二组 · 智能评测",
        teacher_comment: null,
        decided_by: null,
        decided_at: null,
        applied_at: null,
        created_at: now,
        lock_version: 1,
        can_edit: false,
        handovers: [
          {
            task_id: "32000000-0000-0000-0000-000000000002",
            code: "TASK-02",
            title: "实现前端工作台视图",
            status: "pending",
            from_user: { id: TW_STUDENT_2_ID, name: "赵同学" },
            to_user: { id: TW_STUDENT_1_ID, name: "李同学" },
            applied_at: null,
          },
        ],
      },
    ],
    actions: [
      {
        id: `join:${TW_JOIN_REQ_1_ID}`,
        source_id: TW_JOIN_REQ_1_ID,
        type: "join_request",
        priority: "urgent",
        status: "pending",
        title: "王旁听申请加入软件工程实践",
        description: "学号 20260099 请求加入班级",
        course_id: TW_COURSE_1_ID,
        group_id: null,
        project_id: null,
        subject_user_id: TW_OUTSIDER_ID,
        href: `/teacher/courses/${TW_COURSE_1_ID}/actions`,
        available_actions: [
          { key: "approve", label: "同意加入", requires_reason: false, confirm_text: null, style: "primary" },
          { key: "reject", label: "拒绝", requires_reason: true, confirm_text: null, style: "danger" },
        ],
        created_at: now,
        handled_at: null,
        handled_by: null,
        decision: null,
        decision_reason: null,
      },
      {
        id: `invite:${TW_INVITE_1_ID}`,
        source_id: TW_INVITE_1_ID,
        type: "post_deadline_invite",
        priority: "normal",
        status: "pending",
        title: "第一组邀请王同学（需教师审批）",
        description: "李同学邀请王同学加入第一组 · 飞书协同",
        course_id: TW_COURSE_1_ID,
        group_id: TW_GROUP_1_ID,
        project_id: TW_PROJECT_1_ID,
        subject_user_id: TW_STUDENT_3_ID,
        href: `/teacher/courses/${TW_COURSE_1_ID}/member-changes`,
        available_actions: [
          { key: "approve", label: "批准入组", requires_reason: false, confirm_text: null, style: "primary" },
          { key: "reject", label: "驳回", requires_reason: true, confirm_text: null, style: "danger" },
        ],
        created_at: now,
        handled_at: null,
        handled_by: null,
        decision: null,
        decision_reason: null,
      },
      {
        id: `member_change:${TW_MEMBER_CHANGE_1_ID}`,
        source_id: TW_MEMBER_CHANGE_1_ID,
        type: "member_leave",
        priority: "normal",
        status: "pending",
        title: "赵同学申请退出第一组",
        description: "含 1 项任务交接待审批",
        course_id: TW_COURSE_1_ID,
        group_id: TW_GROUP_1_ID,
        project_id: TW_PROJECT_1_ID,
        subject_user_id: TW_STUDENT_2_ID,
        href: `/teacher/courses/${TW_COURSE_1_ID}/member-changes`,
        available_actions: [
          { key: "approve", label: "批准变更", requires_reason: false, confirm_text: null, style: "primary" },
          { key: "reject", label: "驳回", requires_reason: true, confirm_text: null, style: "danger" },
        ],
        created_at: now,
        handled_at: null,
        handled_by: null,
        decision: null,
        decision_reason: null,
      },
    ],
    appeals: [
      {
        id: TW_APPEAL_1_ID,
        course_id: TW_COURSE_1_ID,
        project_id: TW_PROJECT_1_ID,
        project_name: "智能协作教学平台",
        group_name: "第一组 · 飞书协同",
        appellant_id: TW_STUDENT_2_ID,
        appellant_name: "赵同学",
        student_number: "20260002",
        appeal_type: "contribution",
        title: "前端重构任务权重核对申诉",
        content: "我在核心前端模块承担了较多联调工作，请求复核贡献度占比。",
        supplement_text: null,
        evidence: ["commit-abc123", "PR-42"],
        status: "pending",
        resolved_by: null,
        resolver_name: null,
        resolved_at: null,
        created_at: now,
        updated_at: now,
        decisions: [],
      },
    ],
    publishedRuleVersion: rulesV1,
    draftRuleVersion: null,
    ruleVersions: [rulesV1],
    folders: [
      {
        id: TW_FOLDER_1_ID,
        course_id: TW_COURSE_1_ID,
        name: "课程大纲与模板",
        parent_id: null,
        sort_order: 1,
        created_at: now,
      },
    ],
    materials: [
      {
        id: TW_MATERIAL_1_ID,
        course_id: TW_COURSE_1_ID,
        folder_id: TW_FOLDER_1_ID,
        name: "实验指导书.pdf",
        visibility: "all",
        status: "published",
        uploaded_by: TW_TEACHER_ID,
        uploader_name: "张老师",
        created_at: now,
        updated_at: now,
        versions: [
          {
            id: "62000000-0000-0000-0000-000000000001",
            version_no: 1,
            original_name: "实验指导书.pdf",
            mime_type: "application/pdf",
            size_bytes: 2048,
            checksum: "mock-sha256-guide",
            change_note: "初始版本",
            uploaded_by: TW_TEACHER_ID,
            uploader_name: "张老师",
            created_at: now,
            has_content: true,
            content_text: "%PDF-1.4 GroupProof Lab Guide",
          },
        ],
      },
    ],
    announcements: [
      {
        id: TW_ANNOUNCEMENT_1_ID,
        course_id: TW_COURSE_1_ID,
        title: "欢迎来到软件工程实践",
        content: "请各位同学在本周五前完成组队并提交项目立项信息。",
        priority: "important",
        is_pinned: true,
        status: "published",
        published_by: TW_TEACHER_ID,
        publisher_name: "张老师",
        published_at: now,
        created_at: now,
        updated_at: now,
        read_by: { [TW_STUDENT_2_ID]: now },
      },
    ],
    staff: [
      {
        user_id: TW_TEACHER_ID,
        name: "张老师",
        email: "teacher@must.edu.mo",
        role: "teacher",
        permissions: fullStaffPermissions(),
        joined_at: now,
        is_owner: true,
      },
      {
        user_id: TW_TA_ID,
        name: "陈助教",
        email: "ta@must.edu.mo",
        role: "ta",
        permissions: defaultTaPermissions(),
        joined_at: now,
        is_owner: false,
      },
    ],
  };

  const course2: CourseRecord = {
    id: TW_COURSE_2_ID,
    owner_id: TW_TEACHER_ID,
    code: "AI-2026-02",
    name: "人工智能导论",
    semester: "2026-Spring",
    college: "计算机科学与工程学院",
    description: "人工智能基础理论与工程项目结课班级。",
    status: "ended",
    archived_at: null,
    invite_code: "TW-AI02",
    join_mode: "approval",
    project_deadline: "2026-06-30T23:59:00Z",
    formation_deadline: "2026-03-15T23:59:00Z",
    min_group_size: 2,
    max_group_size: 4,
    lock_version: 1,
    roster: [],
    groups: [],
    joinRequests: [],
    groupInvitations: [],
    membershipChanges: [],
    actions: [],
    appeals: [],
    publishedRuleVersion: { ...rulesV1 },
    draftRuleVersion: null,
    ruleVersions: [{ ...rulesV1 }],
    folders: [],
    materials: [],
    announcements: [],
    staff: [
      {
        user_id: TW_TEACHER_ID,
        name: "张老师",
        email: "teacher@must.edu.mo",
        role: "teacher",
        permissions: fullStaffPermissions(),
        joined_at: now,
        is_owner: true,
      },
    ],
  };

  const store: TeacherWorkbenchStore = {
    actors,
    courses: new Map([
      [course1.id, course1],
      [course2.id, course2],
    ]),
    projects: new Map([[project1.id, project1]]),
    storageUploads: new Map(),
    notifications: [
      {
        id: "80000000-0000-0000-0000-000000000001",
        recipient_id: TW_TEACHER_ID,
        category: "course",
        title: "课程公告：欢迎来到软件工程实践",
        description: "请各位同学在本周五前完成组队。",
        created_at: now,
        read_at: null,
        lock_version: 0,
        target: {
          kind: "course",
          id: TW_COURSE_1_ID,
          project_id: null,
          course_id: TW_COURSE_1_ID,
        },
        href: `/teacher/courses/${TW_COURSE_1_ID}/announcements`,
      },
    ],
    actionItems: [
      {
        id: "81000000-0000-0000-0000-000000000001",
        recipient_id: TW_TEACHER_ID,
        category: "course",
        title: "确认项目基线计划",
        description: "请确认课程项目基线与里程碑安排。",
        status: "pending",
        priority: "medium",
        created_at: now,
        due_at: null,
        target: {
          kind: "course",
          id: TW_COURSE_1_ID,
          project_id: null,
          course_id: TW_COURSE_1_ID,
        },
        href: `/courses/${TW_COURSE_1_ID}`,
      },
    ],
    inboxVersion: 1,
    inboxSnapshotId: "90000000-0000-0000-0000-000000000001",
    idempotency: new Map(),
    counter: 100,
    nextUuid(prefix = "a0000000"): string {
      store.counter += 1;
      const tail = String(store.counter).padStart(12, "0");
      return `${prefix.slice(0, 8)}-0000-4000-8000-${tail}`;
    },
  };

  return store;
}
