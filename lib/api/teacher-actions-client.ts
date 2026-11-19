import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";

export type TeacherActionType =
  | "join_request"
  | "post_deadline_invite"
  | "member_leave"
  | "member_remove"
  | "rule_change_review"
  | "milestone_overdue"
  | "risk_alert"
  | "appeal"
  | "notification";

export type ActionPriority = "urgent" | "normal" | "low";
export type ActionStatus = "pending" | "handled" | "expired" | "auto_resolved";

export type ActionDef = {
  key: string;
  label: string;
  requires_reason: boolean;
  confirm_text: string | null;
  style: "primary" | "danger" | "secondary";
};

export type TeacherActionItem = {
  id: string;
  source_id: string;
  type: TeacherActionType;
  priority: ActionPriority;
  status: ActionStatus;
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
};

export type TeacherActionPage = {
  items: TeacherActionItem[];
  total: number;
  pending_count: number;
  urgent_count: number;
  counts_by_type: Record<string, number>;
};

const id = encodeURIComponent;

export const teacherActionsKeys = {
  list: (userId: string, courseId: string, paramsKey: string) =>
    ["b-teacher-actions", userId, courseId, paramsKey] as const,
  badge: (userId: string, courseId: string) =>
    ["b-teacher-actions-badge", userId, courseId] as const,
};

export const teacherActionsApi = {
  list: (
    courseId: string,
    params: {
      type?: string;
      status?: string;
      priority?: string;
      days?: number;
      page?: number;
      page_size?: number;
    } = {},
  ) => bRequest<TeacherActionPage>({ path: `/api/v1/teacher/classes/${id(courseId)}/actions`, query: params }),
  handle: (
    courseId: string,
    actionId: string,
    body: { action_key: string; reason?: string },
    idempotencyKey?: string,
  ) =>
    bRequest<TeacherActionItem>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/actions/${id(actionId)}/handle`,
      body,
      idempotencyKey,
    }),
  batch: (
    courseId: string,
    body: { ids: string[]; action_key: string; reason?: string },
    idempotencyKey?: string,
  ) =>
    bRequest<{ handled: number; failed: number; errors: { id: string; code: string; message: string }[] }>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/actions/batch`,
      body,
      idempotencyKey,
    }),
  remind: (courseId: string, actionId: string, message?: string, idempotencyKey?: string) =>
    bRequest<{ notified_count: number }>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/actions/${id(actionId)}/remind`,
      body: { message },
      idempotencyKey,
    }),
};

export { newIdempotencyKey };
