import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";
import type { BMilestone } from "@/lib/api/b-milestones";

export type ProjectOverviewCard = {
  group_id: string;
  group_name: string;
  member_count: number;
  leader_name: string | null;
  has_project: boolean;
  project_id: string | null;
  project_name: string | null;
  project_href: string | null;
  plaza_href: string;
  progress_percent: number | null;
  completed_tasks: number;
  total_tasks: number;
  milestones_completed: number;
  milestones_total: number;
  overdue_milestones: number;
  risk_level: "high" | "medium" | "low" | null;
  last_activity_at: string | null;
};

export type TeacherProjectsListData = {
  course_id: string;
  can_remind: boolean;
  counts: Record<string, number>;
  items: ProjectOverviewCard[];
};

export type TeacherProjectDetailData = {
  card: ProjectOverviewCard;
  members: string[];
  milestones: BMilestone[];
  recent_events: string[];
};

const enc = encodeURIComponent;

export const teacherProjectsKeys = {
  list: (userId: string, courseId: string) => ["b-teacher-projects", userId, courseId] as const,
  detail: (userId: string, courseId: string, groupId: string) =>
    ["b-teacher-project-detail", userId, courseId, groupId] as const,
};

export const teacherProjectsApi = {
  list: (courseId: string) =>
    bRequest<TeacherProjectsListData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/projects`,
    }),
  detail: (courseId: string, groupId: string) =>
    bRequest<TeacherProjectDetailData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/projects/${enc(groupId)}`,
    }),
  remind: (courseId: string, groupId: string, message?: string) =>
    bRequest<{ group_id: string; notified_count: number }>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/projects/${enc(groupId)}/remind`,
      body: { message: message ?? null },
      idempotencyKey: newIdempotencyKey(),
    }),
};
