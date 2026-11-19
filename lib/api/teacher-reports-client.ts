import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";

export type ProgressTone = "green" | "yellow" | "red" | "gray";
export type ExportFormat = "csv" | "markdown" | "json";

export type ReportsOverview = {
  course_id: string;
  course_name: string;
  student_count: number;
  group_count: number;
  project_count: number;
  ungrouped_count: number;
  overall_progress: number | null;
  high_risk_groups: number;
  medium_risk_groups: number;
  overdue_milestones: number;
  can_export: boolean;
};

export type GroupProgressItem = {
  group_id: string;
  group_name: string;
  has_project: boolean;
  project_id: string | null;
  project_name: string | null;
  progress_percent: number | null;
  completed_tasks: number;
  total_tasks: number;
  overdue_milestones: number;
  milestones_completed: number;
  milestones_total: number;
  tone: ProgressTone;
};

export type MilestoneCell = {
  milestone_id: string;
  title: string;
  status: string;
  overdue: boolean;
  progress_percent: number | null;
  deadline: string | null;
  completed_task_count: number;
  task_count: number;
};

export type GroupMilestoneRow = {
  group_id: string;
  group_name: string;
  project_id: string | null;
  project_name: string | null;
  milestones: MilestoneCell[];
};

export type RiskEntry = {
  id: string;
  title: string;
  level: string;
  status: string;
  due_at: string | null;
};

export type GroupRiskAlert = {
  group_id: string;
  group_name: string;
  project_id: string | null;
  project_name: string | null;
  risk_level: "high" | "medium";
  overdue_milestones: number;
  progress_percent: number | null;
  open_risk_count: number;
  reasons: string[];
  risks: RiskEntry[];
};

export type StudentActivityRank = {
  user_id: string;
  name: string;
  student_number: string | null;
  group_name: string | null;
  github_events: number;
  progress_events: number;
  completed_tasks: number;
  total_score: number;
  low_activity: boolean;
};

export type ReportsActivityData = {
  course_id: string;
  feishu_message_count: number;
  total_github_events: number;
  total_progress_events: number;
  items: StudentActivityRank[];
};

export type ContributionMember = {
  user_id: string;
  name: string;
  student_number: string | null;
  share: number;
  task_credit: number;
  collaboration_credit: number;
  acceptance_rate: number;
  status: string;
  note: string | null;
};

export type ProjectContribution = {
  project_id: string;
  project_name: string;
  group_id: string | null;
  group_name: string | null;
  snapshot_id: string | null;
  version_no: number | null;
  status: string | null;
  frozen_at: string | null;
  items: ContributionMember[];
};

export type ReportExportData = {
  format: ExportFormat;
  filename: string;
  mime_type: string;
  content: string;
  download_href: string;
};

const enc = encodeURIComponent;

export const teacherReportsKeys = {
  overview: (userId: string, courseId: string) =>
    ["b-teacher-reports-overview", userId, courseId] as const,
  progress: (userId: string, courseId: string) =>
    ["b-teacher-reports-progress", userId, courseId] as const,
  milestones: (userId: string, courseId: string) =>
    ["b-teacher-reports-milestones", userId, courseId] as const,
  risks: (userId: string, courseId: string) =>
    ["b-teacher-reports-risks", userId, courseId] as const,
  activity: (userId: string, courseId: string) =>
    ["b-teacher-reports-activity", userId, courseId] as const,
  contribution: (userId: string, courseId: string) =>
    ["b-teacher-reports-contribution", userId, courseId] as const,
};

export const teacherReportsApi = {
  overview: (courseId: string) =>
    bRequest<ReportsOverview>({ path: `/api/v1/teacher/classes/${enc(courseId)}/reports/overview` }),
  progress: (courseId: string) =>
    bRequest<{ course_id: string; items: GroupProgressItem[] }>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/reports/progress`,
    }),
  milestones: (courseId: string) =>
    bRequest<{ course_id: string; rows: GroupMilestoneRow[] }>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/reports/milestones`,
    }),
  risks: (courseId: string) =>
    bRequest<{ course_id: string; items: GroupRiskAlert[] }>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/reports/risks`,
    }),
  activity: (courseId: string) =>
    bRequest<ReportsActivityData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/reports/activity`,
    }),
  contribution: (courseId: string) =>
    bRequest<{ course_id: string; projects: ProjectContribution[] }>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/reports/contribution`,
    }),
  exportReport: (courseId: string, format: ExportFormat) =>
    bRequest<ReportExportData>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/reports/export`,
      body: { format },
      idempotencyKey: newIdempotencyKey(),
    }),
};
