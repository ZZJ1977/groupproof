"use client";

import { PageHeader } from "@/components/common";
import { JoinRequestsApiPanel } from "@/features/b/CoursesApiPages";
import { GroupInvitationsApiPanel } from "@/features/b/GroupsApiPages";
import { MembershipChangesApiPanel } from "@/features/b/MembershipApiPages";

/**
 * Page 48 in real mode: course join approvals (B1-03), invitations after the
 * formation deadline (B2-03) and group removals / leaving with task handover (B2-07).
 */
export function MemberChangesApiPage({ courseId }: { courseId: string }) {
  return <div>
    <PageHeader title="成员变动审批" description="处理学生加入课程的申请、组队截止后的邀请，以及小组成员的移出和退出。" />
    <div className="mt-5 space-y-4"><JoinRequestsApiPanel courseId={courseId} /><GroupInvitationsApiPanel courseId={courseId} /><MembershipChangesApiPanel courseId={courseId} /></div>
  </div>;
}
