import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";

export type BGroupSummary = {
  id: string; course_id: string; name: string; direction: string | null; leader: BPerson | null;
  member_count: number; max_group_size: number; is_mine: boolean; full: boolean; lock_version: number;
};
export type BGroupPage = { items: BGroupSummary[]; my_group_id: string | null; formation_open: boolean; formation_deadline: string | null };
export type BInvitation = {
  id: string; group_id: string; group_name: string; course_id: string; inviter: BPerson | null; invitee: BPerson | null;
  status: "pending" | "awaiting_teacher" | "accepted" | "declined" | "approved" | "rejected" | "cancelled";
  created_at: string; decided_at: string | null; decision_reason: string | null; lock_version: number;
};
export type BLeaderChange = {
  id: string; group_id: string; requested_by: BPerson | null; previous_leader: BPerson | null; candidate: BPerson | null;
  reason: string; status: "pending" | "approved" | "rejected" | "cancelled"; created_at: string; completed_at: string | null;
  confirmations: Record<string, "confirm" | "reject">; waiting_for: BPerson[];
};
export type BGroupDetail = BGroupSummary & {
  members: (BPerson & { role: "leader" | "member"; joined_at: string })[];
  invitations: BInvitation[]; leader_change: BLeaderChange | null; formation_open: boolean; project_id: string | null;
};
export type BCandidate = BPerson & { student_number: string | null };

const id = encodeURIComponent;
export const bGroupsApi = {
  list: (courseId: string) => bRequest<BGroupPage>({ path: `/api/v1/courses/${id(courseId)}/groups` }),
  create: (courseId: string, body: { name: string; direction?: string }, idempotencyKey?: string) =>
    bRequest<BGroupDetail>({ method: "POST", path: `/api/v1/courses/${id(courseId)}/groups`, body, idempotencyKey }),
  detail: (groupId: string) => bRequest<BGroupDetail>({ path: `/api/v1/groups/${id(groupId)}` }),
  join: (groupId: string) => bRequest<BGroupDetail>({ method: "POST", path: `/api/v1/groups/${id(groupId)}/join` }),
  candidates: (courseId: string, q: string) => bRequest<BCandidate[]>({ path: `/api/v1/courses/${id(courseId)}/ungrouped-students`, query: { q } }),
  invite: (groupId: string, inviteeId: string) =>
    bRequest<BInvitation>({ method: "POST", path: `/api/v1/groups/${id(groupId)}/invitations`, body: { invitee_id: inviteeId } }),
  myInvitations: () => bRequest<BInvitation[]>({ path: "/api/v1/me/group-invitations" }),
  respond: (invitation: BInvitation, accept: boolean) =>
    bRequest<BInvitation>({ method: "POST", path: `/api/v1/group-invitations/${id(invitation.id)}/response`, body: { accept, expected_version: invitation.lock_version } }),
  awaitingTeacher: (courseId: string) => bRequest<BInvitation[]>({ path: `/api/v1/courses/${id(courseId)}/group-invitations` }),
  decideInvitation: (invitation: BInvitation, decision: "approve" | "reject", reason?: string) =>
    bRequest<BInvitation>({ method: "POST", path: `/api/v1/group-invitations/${id(invitation.id)}/decision`, body: { decision, reason, expected_version: invitation.lock_version } }),
  startLeaderChange: (groupId: string, body: { candidate_id: string; reason: string }) =>
    bRequest<BLeaderChange>({ method: "POST", path: `/api/v1/groups/${id(groupId)}/leader-changes`, body }),
  confirmLeaderChange: (requestId: string, decision: "confirm" | "reject") =>
    bRequest<BLeaderChange>({ method: "POST", path: `/api/v1/leader-changes/${id(requestId)}/confirmations`, body: { decision } }),
};
