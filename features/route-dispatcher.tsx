"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { CoreView } from "@/features/core/CoreView";
import ProjectCoreView from "@/features/project-core/ProjectCoreView";
import { ProjectSupportView } from "@/features/project-support/ProjectSupportView";
import { CourseView } from "@/features/course/CourseView";
import { GovernanceView } from "@/features/governance/GovernanceView";
import { resolveRoute } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { useTranslations } from "next-intl";

function AccessDenied({ message }: { message?: string }) {
  const t = useTranslations("errors");
  return <div className="mx-auto mt-20 max-w-[530px] text-center"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]"><LockKeyhole size={25} /></span><h1 className="mt-5 text-[22px] font-semibold">{t("FORBIDDEN")}</h1><p className="mt-2 text-[13px] text-[#75849a]">{message ?? t("NOT_FOUND")}</p></div>;
}

/** 业务页分发：仅在服务端确认 active + full 会话后挂载；无任何切换演示角色的恢复入口。 */
export function RouteDispatcher() {
  const pathname = usePathname();
  const search = useSearchParams();
  const tc = useTranslations("common");
  const { role } = useWorkspace();
  const route = resolveRoute(pathname, search.get("view"));
  if (!route) return <WorkspaceShell kind={role === "admin" ? "admin" : role === "teacher" || role === "ta" ? "teacher" : "student"}><div className="py-24 text-center"><h1 className="text-[24px] font-semibold">{tc("notFound.title")}</h1><Link href="/home" className="gp-link mt-4 inline-block">{tc("notFound.home")}</Link></div></WorkspaceShell>;
  const { screen, projectId, taskId, milestoneId, memberId, courseId, groupId } = route;

  // 布局按路由选择；访问资格单独判断（阶段 01），最终授权由 FastAPI 在数据接口执行
  const kind = screen >= 51 ? "admin" : screen >= 41 ? "teacher" : "student";
  const allowed = kind === "admin" ? role === "admin"
    : kind === "teacher" ? role === "teacher" || role === "ta"
    : screen >= 7 && screen <= 40 ? role !== "admin"
    : role === "student" || role === "leader";
  if (!allowed) {
    const shell = role === "admin" ? "admin" : role === "teacher" || role === "ta" ? "teacher" : "student";
    return <WorkspaceShell kind={shell}><AccessDenied /></WorkspaceShell>;
  }

  let content;
  if ([4, 5, 6, 30].includes(screen)) content = <CoreView screen={screen} />;
  else if (screen >= 7 && screen <= 20) content = <ProjectCoreView screen={screen} projectId={projectId ?? "project-1"} taskId={taskId} milestoneId={milestoneId} />;
  else if (screen >= 21 && screen <= 29) content = <ProjectSupportView screen={screen} projectId={projectId ?? "project-1"} memberId={memberId} />;
  else if (screen >= 31 && screen <= 40) content = <CourseView screen={screen} courseId={courseId} groupId={groupId} />;
  else if (screen >= 41) content = <GovernanceView screen={screen} courseId={courseId} groupId={groupId} />;
  else content = <div className="gp-empty">{tc("loading")}</div>;

  return <WorkspaceShell kind={kind}>{content}</WorkspaceShell>;
}
