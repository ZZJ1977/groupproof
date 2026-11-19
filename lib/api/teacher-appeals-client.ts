import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";

export type AppealType = "contribution" | "task" | "score" | "other";
export type AppealStatus = "pending" | "need_supplement" | "accepted" | "rejected";
export type AppealHandleAction = "reject" | "request_supplement" | "accept";

export type AppealSummary = {
  id: string;
  course_id: string;
  project_id: string;
  project_name: string;
  group_name: string | null;
  appellant_id: string;
  appellant_name: string;
  student_number: string | null;
  appeal_type: AppealType;
  title: string;
  content: string;
  supplement_text: string | null;
  evidence: string[];
  status: AppealStatus;
  resolved_by: string | null;
  resolver_name: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AppealListData = {
  course_id: string;
  can_handle: boolean;
  counts: Record<string, number>;
  items: AppealSummary[];
};

export type AppealDecision = {
  id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  reason: string;
  snapshot_id: string | null;
  adjustments: Record<string, unknown>[] | null;
  created_at: string;
};

export type AppealTaskRef = {
  id: string;
  title: string;
  status: string;
  progress_percent: number;
};

export type AppealContributionMember = {
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

export type AppealDetailData = {
  appeal: AppealSummary;
  can_handle: boolean;
  decisions: AppealDecision[];
  appellant_tasks: AppealTaskRef[];
  github_commit_count: number;
  snapshot: {
    snapshot_id: string | null;
    version_no: number | null;
    status: string | null;
    frozen_at: string | null;
    items: AppealContributionMember[];
  };
};

const enc = encodeURIComponent;

export const teacherAppealsKeys = {
  list: (userId: string, courseId: string, status: string) =>
    ["b-teacher-appeals", userId, courseId, status] as const,
  detail: (userId: string, courseId: string, appealId: string) =>
    ["b-teacher-appeal-detail", userId, courseId, appealId] as const,
};

export const teacherAppealsApi = {
  list: (courseId: string, status = "all") =>
    bRequest<AppealListData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/appeals`,
      query: { status },
    }),

  detail: (courseId: string, appealId: string) =>
    bRequest<AppealDetailData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/appeals/${enc(appealId)}`,
    }),

  handle: (
    courseId: string,
    appealId: string,
    body: {
      action: AppealHandleAction;
      reason: string;
      contribution_adjustments?: { user_id: string; share: number; note?: string }[];
    },
  ) =>
    bRequest<AppealDetailData>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/appeals/${enc(appealId)}/handle`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),
};
