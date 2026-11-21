import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";

export type BOpenTask = { id: string; project_id: string; code: string | null; title: string; status: string; href: string };
export type BOpenTasks = { member: BPerson; tasks: BOpenTask[]; candidates: BPerson[]; applies_immediately: boolean; is_leader: boolean };
export type BHandover = { task_id: string; to_user_id: string };
export type BMembershipChange = {
  id: string; course_id: string; group_id: string; group_name: string; project_id: string | null; change_type: "remove" | "leave";
  member: BPerson | null; requested_by: BPerson | null; status: "pending" | "needs_info" | "approved" | "rejected" | "applied";
  reason: string; teacher_comment: string | null; decided_by: BPerson | null; decided_at: string | null; applied_at: string | null;
  created_at: string; lock_version: number; can_edit: boolean;
  handovers: { task_id: string; code: string | null; title: string; status: string; from_user: BPerson | null; to_user: BPerson | null; applied_at: string | null }[];
};

const id = encodeURIComponent;
export const bMembershipApi = {
  openTasks: (groupId: string, memberId: string) => bRequest<BOpenTasks>({ path: `/api/v1/groups/${id(groupId)}/members/${id(memberId)}/open-tasks` }),
  groupChanges: (groupId: string) => bRequest<BMembershipChange[]>({ path: `/api/v1/groups/${id(groupId)}/membership-changes` }),
  start: (groupId: string, body: { change_type: "remove" | "leave"; member_id?: string; reason: string; handovers: BHandover[] }) =>
    bRequest<BMembershipChange>({ method: "POST", path: `/api/v1/groups/${id(groupId)}/membership-changes`, body }),
  edit: (row: BMembershipChange, reason: string, handovers: BHandover[]) =>
    bRequest<BMembershipChange>({ method: "PUT", path: `/api/v1/membership-changes/${id(row.id)}`, body: { reason, handovers, expected_version: row.lock_version } }),
  courseChanges: (courseId: string, status?: string) => bRequest<BMembershipChange[]>({ path: `/api/v1/courses/${id(courseId)}/membership-changes`, query: { status } }),
  decide: (row: BMembershipChange, decision: "approve" | "reject" | "needs_info", comment?: string) =>
    bRequest<BMembershipChange>({ method: "POST", path: `/api/v1/membership-changes/${id(row.id)}/decide`, body: { decision, comment, expected_version: row.lock_version } }),
};
