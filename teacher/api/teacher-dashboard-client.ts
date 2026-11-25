import { bRequest } from "@/student/api/b-client";
import type { TeacherActionItem } from "@/teacher/api/teacher-actions-client";
import type { GroupRiskAlert } from "@/teacher/api/teacher-reports-client";

export type DashboardClassItem = {
  course_id: string;
  name: string;
  semester: string;
  status: string;
  student_count: number;
  group_count: number;
  project_count: number;
  overall_progress: number | null;
  pending_actions: number;
  risk_count: number;
  href: string;
};

export type DashboardActivityItem = {
  id: string;
  course_id: string;
  course_name: string;
  kind: string;
  title: string;
  actor_name: string | null;
  occurred_at: string;
  href: string;
};

export type TeacherDashboardData = {
  total_pending_actions: number;
  total_classes: number;
  total_students: number;
  total_groups: number;
  total_projects: number;
  high_risk_groups: number;
  medium_risk_groups: number;
  classes: DashboardClassItem[];
  recent_activity: DashboardActivityItem[];
};

export const teacherDashboardKeys = {
  overview: (userId: string) => ["b-teacher-dashboard", userId] as const,
  actions: (userId: string) => ["b-teacher-dashboard-actions", userId] as const,
  risks: (userId: string) => ["b-teacher-dashboard-risks", userId] as const,
};

export const teacherDashboardApi = {
  overview: () => bRequest<TeacherDashboardData>({ path: "/api/v1/teacher/dashboard" }),
  actions: () =>
    bRequest<{ total: number; items: TeacherActionItem[] }>({
      path: "/api/v1/teacher/dashboard/actions",
    }),
  risks: () =>
    bRequest<{ total: number; items: GroupRiskAlert[] }>({
      path: "/api/v1/teacher/dashboard/risks",
    }),
};
