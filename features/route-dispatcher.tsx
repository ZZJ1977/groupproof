"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Button } from "@/components/ui/button";
import { CoreView } from "@/features/core/CoreView";
import ProjectCoreView from "@/features/project-core/ProjectCoreView";
import { ProjectSupportView } from "@/features/project-support/ProjectSupportView";
import { CourseView } from "@/features/course/CourseView";
import { GovernanceView } from "@/features/governance/GovernanceView";
import { resolveRoute } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

function AccessDenied({ kind }: { kind: "student" | "teacher" | "admin" }) {
  const { setRole } = useWorkspace();
  return <div className="mx-auto mt-20 max-w-[530px] text-center"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]"><LockKeyhole size={25} /></span><h1 className="mt-5 text-[22px] font-semibold">当前角色无权访问</h1><p className="mt-2 text-[13px] text-[#75849a]">此页面需要{kind === "admin" ? "管理员" : kind === "teacher" ? "教师或助教" : "学生或组长"}身份。可以切换演示角色查看对应界面。</p><Button className="mt-5" onClick={() => setRole(kind === "admin" ? "admin" : kind === "teacher" ? "teacher" : "leader")}>切换演示角色</Button></div>;
}

export function RouteDispatcher() {
  const pathname = usePathname();
  const search = useSearchParams();
  const { role } = useWorkspace();
  const route = resolveRoute(pathname, search.get("view"));
  if (!route) return <WorkspaceShell kind={role === "admin" ? "admin" : role === "teacher" || role === "ta" ? "teacher" : "student"}><div className="py-24 text-center"><h1 className="text-[24px] font-semibold">页面不存在</h1><Link href="/home" className="gp-link mt-4 inline-block">返回首页</Link></div></WorkspaceShell>;
  const { screen, projectId, taskId, milestoneId, memberId, courseId, groupId } = route;
  if (screen === 1) return <CoreView screen={screen} />;
  if (screen === 2 || screen === 3) return <WorkspaceShell kind={role === "admin" ? "admin" : role === "teacher" || role === "ta" ? "teacher" : "student"}><CoreView screen={screen} /></WorkspaceShell>;

  const kind = screen >= 51 ? "admin" : screen >= 41 ? "teacher" : "student";
  const allowed = kind === "admin" ? role === "admin" : kind === "teacher" ? role === "teacher" || role === "ta" : role === "student" || role === "leader";
  if (!allowed) return <WorkspaceShell kind={role === "admin" ? "admin" : role === "teacher" || role === "ta" ? "teacher" : "student"}><AccessDenied kind={kind} /></WorkspaceShell>;

  let content;
  if ([4, 5, 6, 30].includes(screen)) content = <CoreView screen={screen} />;
  else if (screen >= 7 && screen <= 20) content = <ProjectCoreView screen={screen} projectId={projectId ?? "project-1"} taskId={taskId} milestoneId={milestoneId} />;
  else if (screen >= 21 && screen <= 29) content = <ProjectSupportView screen={screen} projectId={projectId ?? "project-1"} memberId={memberId} />;
  else if (screen >= 31 && screen <= 40) content = <CourseView screen={screen} courseId={courseId} groupId={groupId} />;
  else if (screen >= 41) content = <GovernanceView screen={screen} courseId={courseId} groupId={groupId} />;
  else content = <div className="gp-empty">页面正在加载...</div>;

  return <WorkspaceShell kind={kind}>{content}</WorkspaceShell>;
}
