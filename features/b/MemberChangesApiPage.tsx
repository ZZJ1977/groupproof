"use client";

import { PageHeader } from "@/components/common";
import { JoinRequestsApiPanel } from "@/features/b/CoursesApiPages";

/**
 * Page 48 in real mode. B-1 adds course join approvals; group membership changes
 * (B2-07: removals, leaving, task handover) join this page in stage B-8.
 */
export function MemberChangesApiPage({ courseId }: { courseId: string }) {
  return <div>
    <PageHeader title="成员变动审批" description="处理学生加入课程的申请。小组成员移出、退出的审批将在后续阶段接入。" />
    <div className="mt-5"><JoinRequestsApiPanel courseId={courseId} /></div>
  </div>;
}
