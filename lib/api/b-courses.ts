import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";

export type BPerson = { id: string; name: string | null };
export type BRef = { id: string; name: string };
export type BMyCourse = {
  id: string; code: string; name: string; semester: string; college: string;
  status: "draft" | "active" | "ended"; role: string; joined_at: string;
  teacher: BPerson | null; formation_deadline: string | null; project_deadline: string | null;
  group: BRef | null; project: BRef | null; pending_count: number;
};
export type BMyCoursePage = {
  items: BMyCourse[]; total: number; page: number; page_size: number;
  counts: { all: number; active: number; ended: number };
  pending_joins: { request_id: string; course_id: string; course_name: string; created_at: string }[];
};
export type BCoursePreview = {
  course_id: string; code: string; name: string; semester: string; college: string;
  teacher: BPerson | null; grouping_mode: "free" | "approval"; min_group_size: number; max_group_size: number;
  formation_deadline: string | null; project_deadline: string | null;
  join_mode: "direct" | "approval"; already_member: boolean; pending_request_id: string | null;
};
export type BJoinResult = { status: "joined" | "pending"; course_id: string; request_id: string | null };
export type BJoinRequest = {
  id: string; course_id: string; student: BPerson; student_email: string | null; student_number: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled"; message: string | null; created_at: string;
  decided_by: string | null; decided_at: string | null; decision_reason: string | null; lock_version: number;
};
export type BJoinRequestPage = { items: BJoinRequest[]; total: number; page: number; page_size: number };
export type BJoinPolicy = { course_id: string; mode: "direct" | "approval"; lock_version: number };

export const bCoursesApi = {
  myCourses: (query: { tab: string; q: string; page: number; page_size?: number }) =>
    bRequest<BMyCoursePage>({ path: "/api/v1/me/courses", query }),
  preview: (inviteCode: string) =>
    bRequest<BCoursePreview>({ method: "POST", path: "/api/v1/course-joins/preview", body: { invite_code: inviteCode } }),
  /** The key is created once per confirmation so a double click replays the same join. */
  join: (inviteCode: string, idempotencyKey: string = newIdempotencyKey()) =>
    bRequest<BJoinResult>({ method: "POST", path: "/api/v1/course-joins", body: { invite_code: inviteCode }, idempotencyKey }),
  joinRequests: (courseId: string, status = "pending") =>
    bRequest<BJoinRequestPage>({ path: `/api/v1/courses/${encodeURIComponent(courseId)}/join-requests`, query: { status } }),
  decide: (requestId: string, body: { decision: "approve" | "reject"; reason?: string; expected_version: number }) =>
    bRequest<BJoinRequest>({ method: "POST", path: `/api/v1/course-joins/${encodeURIComponent(requestId)}/decision`, body }),
  joinPolicy: (courseId: string) =>
    bRequest<BJoinPolicy>({ path: `/api/v1/courses/${encodeURIComponent(courseId)}/join-policy` }),
  setJoinPolicy: (courseId: string, body: { mode: "direct" | "approval"; expected_version: number }) =>
    bRequest<BJoinPolicy>({ method: "PUT", path: `/api/v1/courses/${encodeURIComponent(courseId)}/join-policy`, body }),
};
