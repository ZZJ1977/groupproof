import { bRequest, newIdempotencyKey } from "@/student/api/b-client";
import type { BMilestone, BRiskLevel } from "@/student/api/b-milestones";

export type TeacherClassTab = "active" | "ended" | "all";
export type RosterFilter = "all" | "grouped" | "ungrouped";
export type JoinMode = "direct" | "approval";
export type ProgressState = "no_project" | "no_milestones" | "tracking";

export type GroupRef = { id: string; name: string };
export type ProjectRef = { id: string; name: string; href: string };

export type TeacherClassSummary = {
  id: string;
  code: string;
  name: string;
  semester: string;
  college: string;
  status: string;
  student_count: number;
  group_count: number;
  ungrouped_count: number;
  pending_join_count: number;
  href: string;
};

export type TeacherClassPage = {
  items: TeacherClassSummary[];
  counts: Record<string, number>;
};

export type TeacherClassDetail = TeacherClassSummary & {
  invite_code: string | null;
  join_url: string | null;
  join_mode: JoinMode;
  project_deadline: string | null;
  formation_deadline: string | null;
  min_group_size: number;
  max_group_size: number;
  lock_version: number;
  can_manage: boolean;
};

export type RosterStudent = {
  id: string;
  name: string | null;
  student_number: string | null;
  email: string | null;
  initial: string;
  joined_at: string;
  status: "grouped" | "ungrouped" | "left";
  group: GroupRef | null;
  is_leader: boolean;
  in_project_group: boolean;
};

export type RosterData = {
  items: RosterStudent[];
  counts: Record<string, number>;
  pending_join_count: number;
};

export type MilestoneRef = {
  id: string;
  title: string;
  deadline: string | null;
  href: string;
};

export type GroupProgress = {
  state: ProgressState;
  milestones_total: number;
  milestones_completed: number;
  overall_percent: number | null;
  next_milestone: MilestoneRef | null;
  overdue_count: number;
  risk_level: BRiskLevel | null;
};

export type PlazaMember = {
  id: string;
  name: string | null;
  student_number: string | null;
  initial: string;
  is_leader: boolean;
};

export type PlazaGroup = {
  id: string;
  name: string;
  direction: string | null;
  leader_id: string | null;
  members: PlazaMember[];
  member_count: number;
  max_group_size: number;
  roster_frozen: boolean;
  has_project: boolean;
  project: ProjectRef | null;
  lock_version: number;
  accepts_drop: boolean;
  locked_reason: string | null;
  members_locked: boolean;
  progress: GroupProgress;
  href: string;
};

export type PlazaData = {
  course_id: string;
  groups: PlazaGroup[];
  ungrouped: PlazaMember[];
  formation_deadline: string | null;
  formation_open: boolean;
  can_manage: boolean;
};

export type AssignResult = {
  student_id: string;
  from_group: PlazaGroup | null;
  to_group: PlazaGroup | null;
};

export type TeacherGroupMember = {
  id: string;
  name: string | null;
  student_number: string | null;
  email: string | null;
  role: "leader" | "member";
  joined_at: string;
  open_task_count: number;
};

export type TeacherGroupDetail = {
  group: PlazaGroup;
  members: TeacherGroupMember[];
  milestones: BMilestone[];
  member_changes_href: string;
};

export type CreateClassInput = {
  name: string;
  semester: string;
  college: string;
  code?: string | null;
  project_deadline: string;
  formation_deadline?: string | null;
  min_group_size: number;
  max_group_size: number;
  join_mode: JoinMode;
};

export type AssignInput = {
  student_id: string;
  to_group_id: string | null;
  from_group_version?: number | null;
  to_group_version?: number | null;
  reason?: string | null;
};

export type ClassSettings = TeacherClassDetail & {
  description: string | null;
  archived_at: string | null;
  can_delete: boolean;
  is_owner: boolean;
};

export type UpdateSettingsInput = {
  name?: string | null;
  semester?: string | null;
  college?: string | null;
  description?: string | null;
  formation_deadline?: string | null;
  project_deadline?: string | null;
  min_group_size?: number | null;
  max_group_size?: number | null;
  join_mode?: JoinMode | null;
  expected_version: number;
};

const id = encodeURIComponent;

export const teacherKeys = {
  classes: (userId: string, tab: TeacherClassTab, q: string) => ["b-teacher-classes", userId, tab, q] as const,
  classDetail: (userId: string, courseId: string) => ["b-teacher-class", userId, courseId] as const,
  settings: (userId: string, courseId: string) => ["b-teacher-settings", userId, courseId] as const,
  roster: (userId: string, courseId: string, status: RosterFilter, q: string) => ["b-teacher-roster", userId, courseId, status, q] as const,
  plaza: (userId: string, courseId: string) => ["b-teacher-plaza", userId, courseId] as const,
  group: (userId: string, courseId: string, groupId: string) => ["b-teacher-group", userId, courseId, groupId] as const,
};

export const teacherClassesApi = {
  list: (tab: TeacherClassTab = "all", q = "") =>
    bRequest<TeacherClassPage>({ path: "/api/v1/teacher/classes", query: { tab, q } }),
  create: (body: CreateClassInput, idempotencyKey?: string) =>
    bRequest<TeacherClassDetail>({ method: "POST", path: "/api/v1/teacher/classes", body, idempotencyKey }),
  detail: (courseId: string) =>
    bRequest<TeacherClassDetail>({ path: `/api/v1/teacher/classes/${id(courseId)}` }),
  rotateInvite: (courseId: string, expectedVersion: number, idempotencyKey?: string) =>
    bRequest<TeacherClassDetail>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/invite-code/rotate`,
      body: { expected_version: expectedVersion },
      idempotencyKey,
    }),
  roster: (courseId: string, status: RosterFilter = "all", q = "") =>
    bRequest<RosterData>({ path: `/api/v1/teacher/classes/${id(courseId)}/roster`, query: { status, q } }),
  removeStudent: (courseId: string, studentId: string, reason: string, idempotencyKey?: string) =>
    bRequest<RosterStudent>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/students/${id(studentId)}/remove`,
      body: { reason },
      idempotencyKey,
    }),
  plaza: (courseId: string) =>
    bRequest<PlazaData>({ path: `/api/v1/teacher/classes/${id(courseId)}/plaza` }),
  createGroup: (courseId: string, body: { name: string; direction?: string }, idempotencyKey?: string) =>
    bRequest<PlazaGroup>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/groups`,
      body,
      idempotencyKey,
    }),
  assign: (courseId: string, body: AssignInput, idempotencyKey?: string) =>
    bRequest<AssignResult>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/assignments`,
      body,
      idempotencyKey,
    }),
  setLeader: (courseId: string, groupId: string, body: { user_id: string; expected_version: number }, idempotencyKey?: string) =>
    bRequest<PlazaGroup>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/groups/${id(groupId)}/leader`,
      body,
      idempotencyKey,
    }),
  groupDetail: (courseId: string, groupId: string) =>
    bRequest<TeacherGroupDetail>({ path: `/api/v1/teacher/classes/${id(courseId)}/groups/${id(groupId)}` }),
  settings: (courseId: string) =>
    bRequest<ClassSettings>({ path: `/api/v1/teacher/classes/${id(courseId)}/settings` }),
  updateSettings: (courseId: string, body: UpdateSettingsInput, idempotencyKey?: string) =>
    bRequest<ClassSettings>({
      method: "PATCH",
      path: `/api/v1/teacher/classes/${id(courseId)}/settings`,
      body,
      idempotencyKey,
    }),
  endClass: (courseId: string, body: { reason: string; expected_version: number }, idempotencyKey?: string) =>
    bRequest<ClassSettings>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/end`,
      body,
      idempotencyKey,
    }),
  archiveClass: (courseId: string, expectedVersion: number, idempotencyKey?: string) =>
    bRequest<ClassSettings>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/archive`,
      body: { expected_version: expectedVersion },
      idempotencyKey,
    }),
  reopenClass: (courseId: string, body: { reason: string; expected_version: number }, idempotencyKey?: string) =>
    bRequest<ClassSettings>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/reopen`,
      body,
      idempotencyKey,
    }),
  deleteClass: (courseId: string, idempotencyKey?: string) =>
    bRequest<{ deleted: boolean; course_id: string }>({
      method: "DELETE",
      path: `/api/v1/teacher/classes/${id(courseId)}`,
      idempotencyKey,
    }),
};

export { newIdempotencyKey };
