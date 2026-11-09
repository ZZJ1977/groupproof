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
import { isBScreen } from "@/features/b/screens";

const ActivityApiPage = dynamic(() => import("@/features/c/ActivityApiPages").then((module) => module.ActivityApiPage));
const ProjectFilesApiPage = dynamic(() => import("@/features/c/ProjectFilesApiPage").then((module) => module.ProjectFilesApiPage));
const CourseFilesApiPage = dynamic(() => import("@/features/c/CourseFilesApiPage").then((module) => module.CourseFilesApiPage));
const ExecutionApiPage = dynamic(() => import("@/features/c/ExecutionApiPage").then((module) => module.ExecutionApiPage));
const RiskApiPage = dynamic(() => import("@/features/d/RiskApiPage").then((module) => module.RiskApiPage));
const EvidenceApiPage = dynamic(() => import("@/features/c/EvidenceApiPage").then((module) => module.EvidenceApiPage));
const DiscussionsApiPage = dynamic(() => import("@/features/c/DiscussionsApiPage").then((module) => module.DiscussionsApiPage));
const IdentityAdminApiPage = dynamic(() => import("@/features/c/IdentityAdminApiPages").then((module) => module.IdentityAdminApiPage));
const GovernanceApiPage = dynamic(() => import("@/features/c/GovernanceApiPages").then((module) => module.GovernanceApiPage));
const NotificationsApiPage = dynamic(() => import("@/features/c/InboxApiPages").then((module) => module.NotificationsApiPage));
const ActionItemsApiPage = dynamic(() => import("@/features/c/InboxApiPages").then((module) => module.ActionItemsApiPage));
const HomeApiPage = dynamic(() => import("@/features/c/DailyApiPages").then((module) => module.HomeApiPage));
const PersonalActivityApiPage = dynamic(() => import("@/features/c/DailyApiPages").then((module) => module.ActivityApiPage));
const MyCoursesApiPage = dynamic(() => import("@/features/b/CoursesApiPages").then((module) => module.MyCoursesApiPage));
const JoinCourseApiPage = dynamic(() => import("@/features/b/CoursesApiPages").then((module) => module.JoinCourseApiPage));
const GroupsApiPage = dynamic(() => import("@/features/b/GroupsApiPages").then((module) => module.GroupsApiPage));
const GroupDetailApiPage = dynamic(() => import("@/features/b/GroupsApiPages").then((module) => module.GroupDetailApiPage));
const ChangeLeaderApiPage = dynamic(() => import("@/features/b/GroupsApiPages").then((module) => module.ChangeLeaderApiPage));
const MemberChangesApiPage = dynamic(() => import("@/features/b/MemberChangesApiPage").then((module) => module.MemberChangesApiPage));
const NewProjectApiPage = dynamic(() => import("@/features/b/ProjectsApiPages").then((module) => module.NewProjectApiPage));
const ProjectOverviewApiPage = dynamic(() => import("@/features/b/ProjectsApiPages").then((module) => module.ProjectOverviewApiPage));
const ProjectSetupApiPage = dynamic(() => import("@/features/b/ProjectsApiPages").then((module) => module.ProjectSetupApiPage));
const RequirementsApiPage = dynamic(() => import("@/features/b/RequirementsApiPage").then((module) => module.RequirementsApiPage));
const TasksApiPage = dynamic(() => import("@/features/b/TasksApiPage").then((module) => module.TasksApiPage));
const PlanningApiPage = dynamic(() => import("@/features/b/PlanningApiPage").then((module) => module.PlanningApiPage));
const MilestonesApiPage = dynamic(() => import("@/features/b/MilestonesApiPage").then((module) => module.MilestonesApiPage));
const MilestoneDetailApiPage = dynamic(() => import("@/features/b/MilestonesApiPage").then((module) => module.MilestoneDetailApiPage));
const LeaveGroupApiPage = dynamic(() => import("@/features/b/MembershipApiPages").then((module) => module.LeaveGroupApiPage));
const BNotConnectedPage = dynamic(() => import("@/features/b/BNotConnectedPage").then((module) => module.BNotConnectedPage));

function AccessDenied({ message }: { message?: string }) {
  const t = useTranslations("errors");
  return <div className="mx-auto mt-20 max-w-[530px] text-center"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]"><LockKeyhole size={25} /></span><h1 className="mt-5 text-[22px] font-semibold">{t("FORBIDDEN")}</h1><p className="mt-2 text-[13px] text-[#75849a]">{message ?? t("NOT_FOUND")}</p></div>;
}

function VerificationNotConnected() {
  return <>{useTranslations("pages.shared")("verificationNotConnected")}</>;
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
  if (screen === 4 && apiMode("daily") === "real") realContent = <HomeApiPage />;
  if (screen === 30 && apiMode("daily") === "real") realContent = <PersonalActivityApiPage />;
  if (screen === 5 && apiMode("inbox") === "real") realContent = <NotificationsApiPage />;
  if (screen === 6 && apiMode("inbox") === "real") realContent = <ActionItemsApiPage />;
  if (apiMode("cworkspace") === "real") {
    if (screen === 18 && projectId) realContent = <RiskApiPage projectId={projectId} />;
    if ([14, 15].includes(screen) && projectId && taskId) realContent = <ExecutionApiPage projectId={projectId} taskId={taskId} submission={screen === 15} />;
    else if (screen === 20 && projectId) realContent = <EvidenceApiPage projectId={projectId} />;
    else if ([21, 22].includes(screen) && projectId) realContent = <ActivityApiPage projectId={projectId} sourceType={screen === 21 ? "github" : "feishu"} />;
    else if (screen === 23 && projectId) realContent = <ProjectFilesApiPage projectId={projectId} />;
    else if (screen === 24 && projectId) realContent = <DiscussionsApiPage projectId={projectId} />;
    else if ([16, 17].includes(screen)) realContent = <div role="status" className="gp-empty"><VerificationNotConnected /></div>;
  }
  // B pages: each stage replaces this placeholder with its real page; real mode never shows demo data.
  if (isBScreen(screen) && apiMode("bworkspace") === "real") {
    if (screen === 31) realContent = <MyCoursesApiPage />;
    else if (screen === 32) realContent = <JoinCourseApiPage />;
    else if (screen === 33 && courseId) realContent = <GroupsApiPage courseId={courseId} />;
    else if (screen === 34 && courseId && groupId) realContent = <GroupDetailApiPage courseId={courseId} groupId={groupId} />;
    else if (screen === 36 && courseId && groupId) realContent = <ChangeLeaderApiPage courseId={courseId} groupId={groupId} />;
    else if (screen === 48 && courseId) realContent = <MemberChangesApiPage courseId={courseId} />;
    else if (screen === 35 && courseId) realContent = <NewProjectApiPage courseId={courseId} />;
    else if (screen === 7 && projectId) realContent = <ProjectOverviewApiPage projectId={projectId} />;
    else if (screen === 8 && projectId) realContent = <ProjectSetupApiPage projectId={projectId} />;
    else if (screen === 9 && projectId) realContent = <RequirementsApiPage projectId={projectId} />;
    else if (screen === 10 && projectId) realContent = <PlanningApiPage projectId={projectId} />;
    else if ([11, 12, 13].includes(screen) && projectId) realContent = <TasksApiPage projectId={projectId} view={screen === 12 ? "board" : screen === 13 ? "list" : "tree"} />;
    // Page 18 is shared: B's milestones first, then D's risk management (create /
    // mitigate / close), whose open risks feed the milestone risk summary above.
    else if (screen === 18 && projectId) realContent = <><MilestonesApiPage projectId={projectId} />{apiMode("cworkspace") === "real" && <div className="mt-6"><RiskApiPage projectId={projectId} /></div>}</>;
    else if (screen === 19 && projectId && milestoneId) realContent = <MilestoneDetailApiPage projectId={projectId} milestoneId={milestoneId} />;
    else if (screen === 37 && courseId && groupId) realContent = <LeaveGroupApiPage courseId={courseId} groupId={groupId} />;
    else realContent = <BNotConnectedPage screen={screen} />;
  }
  if (screen === 50 && courseId && apiMode("coursefiles") === "real") realContent = <CourseFilesApiPage courseId={courseId} />;
  if ([51, 52].includes(screen) && apiMode("cidentity") === "real") realContent = <IdentityAdminApiPage teachers={screen === 52} />;
  if (screen >= 53 && apiMode("governance") === "real") {
    const section = ({ 53: "courses", 54: "logs", 55: "ai-usage", 56: "access-requests" } as const)[screen as 53 | 54 | 55 | 56];
    if (section) realContent = <GovernanceApiPage screen={section} />;
  }
  if (realContent) return <WorkspaceShell kind={kind}><div key={`${userId}:${screen}:${projectId ?? courseId ?? ""}:${taskId ?? milestoneId ?? ""}`}>{realContent}</div></WorkspaceShell>;
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
  // Project pages always carry the project ID in the URL; there is no default project.
  else if (screen >= 7 && screen <= 20 && projectId) content = <ProjectCoreView screen={screen} projectId={projectId} taskId={taskId} milestoneId={milestoneId} />;
  else if (screen >= 21 && screen <= 29 && projectId) content = <ProjectSupportView screen={screen} projectId={projectId} memberId={memberId} />;
  else if (screen >= 31 && screen <= 40) content = <CourseView screen={screen} courseId={courseId} groupId={groupId} />;
  else if (screen >= 41) content = <GovernanceView screen={screen} courseId={courseId} groupId={groupId} />;
  else content = <div className="gp-empty">{tc("loading")}</div>;

  return <WorkspaceShell kind={kind}>{content}</WorkspaceShell>;
}
