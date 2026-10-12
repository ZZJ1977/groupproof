"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
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
import { apiMode } from "@/lib/api/config";

const ActivityApiPage = dynamic(() => import("@/features/c/ActivityApiPages").then((module) => module.ActivityApiPage));
const ProjectFilesApiPage = dynamic(() => import("@/features/c/ProjectFilesApiPage").then((module) => module.ProjectFilesApiPage));
const CourseFilesApiPage = dynamic(() => import("@/features/c/CourseFilesApiPage").then((module) => module.CourseFilesApiPage));
const ExecutionApiPage = dynamic(() => import("@/features/c/ExecutionApiPage").then((module) => module.ExecutionApiPage));
const EvidenceApiPage = dynamic(() => import("@/features/c/EvidenceApiPage").then((module) => module.EvidenceApiPage));
const DiscussionsApiPage = dynamic(() => import("@/features/c/DiscussionsApiPage").then((module) => module.DiscussionsApiPage));
const IdentityAdminApiPage = dynamic(() => import("@/features/c/IdentityAdminApiPages").then((module) => module.IdentityAdminApiPage));
const GovernanceApiPage = dynamic(() => import("@/features/c/GovernanceApiPages").then((module) => module.GovernanceApiPage));
const NotificationsApiPage = dynamic(() => import("@/features/c/InboxApiPages").then((module) => module.NotificationsApiPage));
const ActionItemsApiPage = dynamic(() => import("@/features/c/InboxApiPages").then((module) => module.ActionItemsApiPage));

function AccessDenied({ message }: { message?: string }) {
  const t = useTranslations("errors");
  return <div className="mx-auto mt-20 max-w-[530px] text-center"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]"><LockKeyhole size={25} /></span><h1 className="mt-5 text-[22px] font-semibold">{t("FORBIDDEN")}</h1><p className="mt-2 text-[13px] text-[#75849a]">{message ?? t("NOT_FOUND")}</p></div>;
}

/** 业务页分发：仅在服务端确认 active + full 会话后挂载；无任何切换演示角色的恢复入口。 */
export function RouteDispatcher() {
  const pathname = usePathname();
  const search = useSearchParams();
  const tc = useTranslations("common");
  const { role, userId } = useWorkspace();
  const route = resolveRoute(pathname, search.get("view"));
  if (!route) return <WorkspaceShell kind={role === "admin" ? "admin" : role === "teacher" || role === "ta" ? "teacher" : "student"}><div className="py-24 text-center"><h1 className="text-[24px] font-semibold">{tc("notFound.title")}</h1><Link href="/home" className="gp-link mt-4 inline-block">{tc("notFound.home")}</Link></div></WorkspaceShell>;
  const { screen, projectId, taskId, milestoneId, memberId, courseId, groupId } = route;

  // 布局按路由选择；访问资格单独判断（阶段 01），最终授权由 FastAPI 在数据接口执行
  const kind = screen >= 51 ? "admin" : screen >= 41 ? "teacher" : "student";
  // These pages use the authenticated API's authorization, not demo role state.
  // Mount by the actual route ID; never translate seed IDs into canonical IDs.
  let realContent;
  if (screen === 5 && apiMode("inbox") === "real") realContent = <NotificationsApiPage />;
  if (screen === 6 && apiMode("inbox") === "real") realContent = <ActionItemsApiPage />;
  if (apiMode("cworkspace") === "real") {
    if ([14, 15].includes(screen) && projectId && taskId) realContent = <ExecutionApiPage projectId={projectId} taskId={taskId} submission={screen === 15} />;
    else if (screen === 20 && projectId) realContent = <EvidenceApiPage projectId={projectId} />;
    else if ([21, 22].includes(screen) && projectId) realContent = <ActivityApiPage projectId={projectId} sourceType={screen === 21 ? "github" : "feishu"} />;
    else if (screen === 23 && projectId) realContent = <ProjectFilesApiPage projectId={projectId} />;
    else if (screen === 24 && projectId) realContent = <DiscussionsApiPage projectId={projectId} />;
    else if ([16, 17].includes(screen)) realContent = <div role="status" className="gp-empty">验收服务暂未接入，请返回任务页面查看已保存的提交。</div>;
  }
  if (screen === 50 && courseId && apiMode("coursefiles") === "real") realContent = <CourseFilesApiPage courseId={courseId} />;
  if ([51, 52].includes(screen) && apiMode("cidentity") === "real") realContent = <IdentityAdminApiPage teachers={screen === 52} />;
  if (screen >= 53 && apiMode("governance") === "real") {
    const section = ({ 53: "courses", 54: "logs", 55: "ai-usage", 56: "access-requests" } as const)[screen as 53 | 54 | 55 | 56];
    if (section) realContent = <GovernanceApiPage screen={section} />;
  }
  if (realContent) return <WorkspaceShell kind={kind}><div key={`${userId}:${screen}:${projectId ?? courseId ?? ""}:${taskId ?? ""}`}>{realContent}</div></WorkspaceShell>;
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
