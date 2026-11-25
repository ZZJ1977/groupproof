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
import { isTeacherScreen, resolveRoute } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import { useTranslations } from "next-intl";
import { apiMode } from "@/lib/api/config";
import { resolveCanonicalRouteContext } from "@/lib/ux/navigation";

const ActivityApiPage = dynamic(() => import("@/features/c/ActivityApiPages").then((module) => module.ActivityApiPage));
const ProjectFilesApiPage = dynamic(() => import("@/features/c/ProjectFilesApiPage").then((module) => module.ProjectFilesApiPage));
const CourseFilesApiPage = dynamic(() => import("@/features/c/CourseFilesApiPage").then((module) => module.CourseFilesApiPage));
const ExecutionApiPage = dynamic(() => import("@/features/c/ExecutionApiPage").then((module) => module.ExecutionApiPage));
const RiskApiPage = dynamic(() => import("@/features/d/RiskApiPage").then((module) => module.RiskApiPage));
const ReportApiPage = dynamic(() => import("@/features/d/ReportApiPage").then((module) => module.ReportApiPage));
const TeacherOverviewApiPage = dynamic(() => import("@/features/d/TeacherOverviewApiPage").then((module) => module.TeacherOverviewApiPage));
const DTeacherAppealsApiPage = dynamic(() => import("@/features/d/TeacherAppealsApiPage").then((module) => module.TeacherAppealsApiPage));
const TeacherWorkspaceApiPage = dynamic(() => import("@/features/d/TeacherWorkspaceApiPage").then((module) => module.TeacherWorkspaceApiPage));
const DTeacherReportsApiPage = dynamic(() => import("@/features/d/TeacherReportsApiPage").then((module) => module.TeacherReportsApiPage));
const CourseRulesApiPage = dynamic(() => import("@/features/d/CourseRulesApiPage").then((module) => module.CourseRulesApiPage));
const ProjectSettingsApiPage = dynamic(() => import("@/features/d/ProjectSettingsApiPage").then((module) => module.ProjectSettingsApiPage));
const CourseReopenApiPage = dynamic(() => import("@/features/d/CourseReopenApiPage").then((module) => module.CourseReopenApiPage));
const AcceptanceApiPage = dynamic(() => import("@/features/d/AcceptanceApiPage").then((module) => module.AcceptanceApiPage));
const ContributionApiPage = dynamic(() => import("@/features/d/ContributionApiPage").then((module) => module.ContributionApiPage));
const EvidenceApiPage = dynamic(() => import("@/features/c/EvidenceApiPage").then((module) => module.EvidenceApiPage));
const ProjectDiscussionPreviewPage = dynamic(() => import("@/features/c/ProjectDiscussionPreviewPage").then((module) => module.ProjectDiscussionPreviewPage));
const IdentityAdminApiPage = dynamic(() => import("@/features/c/IdentityAdminApiPages").then((module) => module.IdentityAdminApiPage));
const AdminDashboardPage = dynamic(() => import("@/features/c/AdminDashboardPage").then((module) => module.AdminDashboardPage));
const GovernanceApiPage = dynamic(() => import("@/features/c/GovernanceApiPages").then((module) => module.GovernanceApiPage));
const NotificationsApiPage = dynamic(() => import("@/features/c/InboxApiPages").then((module) => module.NotificationsApiPage));
const ActionItemsApiPage = dynamic(() => import("@/features/c/InboxApiPages").then((module) => module.ActionItemsApiPage));
const HomeApiPage = dynamic(() => import("@/features/c/DailyApiPages").then((module) => module.HomeApiPage));
const PersonalActivityApiPage = dynamic(() => import("@/features/c/DailyApiPages").then((module) => module.ActivityApiPage));
const BNotConnectedPage = dynamic(() => import("@/features/b/BNotConnectedPage").then((module) => module.BNotConnectedPage));
const MyCoursesApiPage = dynamic(() => import("@/features/b/CoursesApiPages").then((module) => module.MyCoursesApiPage));
const JoinCourseApiPage = dynamic(() => import("@/features/b/CoursesApiPages").then((module) => module.JoinCourseApiPage));
const GroupsApiPage = dynamic(() => import("@/features/b/GroupsApiPages").then((module) => module.GroupsApiPage));
const GroupDetailApiPage = dynamic(() => import("@/features/b/GroupsApiPages").then((module) => module.GroupDetailApiPage));
const ChangeLeaderApiPage = dynamic(() => import("@/features/b/GroupsApiPages").then((module) => module.ChangeLeaderApiPage));
const IndependentProjectPage = dynamic(() => import("@/features/b/IndependentProjectPage").then((module) => module.IndependentProjectPage));
const NewProjectApiPage = dynamic(() => import("@/features/b/ProjectsApiPages").then((module) => module.NewProjectApiPage));
const ProjectOverviewApiPage = dynamic(() => import("@/features/b/ProjectsApiPages").then((module) => module.ProjectOverviewApiPage));
const ProjectSetupApiPage = dynamic(() => import("@/features/b/ProjectsApiPages").then((module) => module.ProjectSetupApiPage));
const RequirementsApiPage = dynamic(() => import("@/features/b/RequirementsApiPage").then((module) => module.RequirementsApiPage));
const PlanningApiPage = dynamic(() => import("@/features/b/PlanningApiPage").then((module) => module.PlanningApiPage));
const TasksApiPage = dynamic(() => import("@/features/b/TasksApiPage").then((module) => module.TasksApiPage));
const MilestonesApiPage = dynamic(() => import("@/features/b/MilestonesApiPage").then((module) => module.MilestonesApiPage));
const MilestoneDetailApiPage = dynamic(() => import("@/features/b/MilestonesApiPage").then((module) => module.MilestoneDetailApiPage));
const LeaveGroupApiPage = dynamic(() => import("@/features/b/MembershipApiPages").then((module) => module.LeaveGroupApiPage));
const MemberChangesApiPage = dynamic(() => import("@/features/b/MemberChangesApiPage").then((module) => module.MemberChangesApiPage));
const TeacherClassLayout = dynamic(() => import("@/features/teacher/TeacherClassLayout").then((module) => module.TeacherClassLayout));
const TeacherClassesApiPage = dynamic(() => import("@/features/teacher/TeacherClassesApiPage").then((module) => module.TeacherClassesApiPage));
const TeacherClassHomeApiPage = dynamic(() => import("@/features/teacher/TeacherClassHomeApiPage").then((module) => module.TeacherClassHomeApiPage));
const TeamPlazaApiPage = dynamic(() => import("@/features/teacher/TeamPlazaApiPage").then((module) => module.TeamPlazaApiPage));
const TeacherGroupDetailApiPage = dynamic(() => import("@/features/teacher/TeacherGroupDetailApiPage").then((module) => module.TeacherGroupDetailApiPage));
const TeacherStaffApiPage = dynamic(() => import("@/features/teacher/TeacherStaffApiPage").then((module) => module.TeacherStaffApiPage));
const TeacherSettingsApiPage = dynamic(() => import("@/features/teacher/TeacherSettingsApiPage").then((module) => module.TeacherSettingsApiPage));
const TeacherRulesApiPage = dynamic(() => import("@/features/teacher/TeacherRulesApiPage").then((module) => module.TeacherRulesApiPage));
const TeacherActionsApiPage = dynamic(() => import("@/features/teacher/TeacherActionsApiPage").then((module) => module.TeacherActionsApiPage));
const TeacherFilesApiPage = dynamic(() => import("@/features/teacher/TeacherFilesApiPage").then((module) => module.TeacherFilesApiPage));
const StudentCourseFilesApiPage = dynamic(() => import("@/features/b/StudentCourseFilesApiPage").then((module) => module.StudentCourseFilesApiPage));
const TeacherAnnouncementsApiPage = dynamic(() => import("@/features/teacher/TeacherAnnouncementsApiPage").then((module) => module.TeacherAnnouncementsApiPage));
const TeacherReportsApiPage = dynamic(() => import("@/features/teacher/TeacherReportsApiPage").then((module) => module.TeacherReportsApiPage));
const TeacherAppealsApiPage = dynamic(() => import("@/features/teacher/TeacherAppealsApiPage").then((module) => module.TeacherAppealsApiPage));
const TeacherProjectsApiPage = dynamic(() => import("@/features/teacher/TeacherProjectsApiPage").then((module) => module.TeacherProjectsApiPage));
const TeacherDashboardApiPage = dynamic(() => import("@/features/teacher/TeacherDashboardApiPage").then((module) => module.TeacherDashboardApiPage));

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
  const canonicalProject = resolveCanonicalRouteContext(pathname).projectId;

  // 布局按路由选择；访问资格单独判断（阶段 01），最终授权由 FastAPI 在数据接口执行
  const kind = screen === 50 && pathname.startsWith("/courses/")
    ? "student"
    : isTeacherScreen(screen)
      ? "teacher"
      : screen >= 51
        ? "admin"
        : "student";
  // These pages use the authenticated API's authorization, not demo role state.
  // Mount by the actual route ID; never translate seed IDs into canonical IDs.
  // Version links address C's publication history even when B provides the course files index.
  if (screen === 50 && courseId && search.has("version") && apiMode("coursefiles") === "real") {
    return (
      <WorkspaceShell kind={kind}>
        <CourseFilesApiPage key={`${userId}:${courseId}`} courseId={courseId} />
      </WorkspaceShell>
    );
  }
  const bReal = apiMode("bworkspace") === "real";
  let realContent;
  if (screen === 4 && apiMode("daily") === "real") realContent = <HomeApiPage />;
  if (bReal || apiMode("courses") === "real") {
    if (screen === 31) realContent = <MyCoursesApiPage />;
    if (screen === 32) realContent = <JoinCourseApiPage />;
  }
  if (bReal || apiMode("groups") === "real") {
    if (screen === 33 && courseId) realContent = <GroupsApiPage courseId={courseId} />;
    if (screen === 34 && courseId && groupId) realContent = <GroupDetailApiPage courseId={courseId} groupId={groupId} />;
    if (screen === 36 && courseId && groupId) realContent = <ChangeLeaderApiPage courseId={courseId} groupId={groupId} />;
    if (screen === 37 && courseId && groupId) realContent = <LeaveGroupApiPage courseId={courseId} groupId={groupId} />;
    if (screen === 48 && courseId) realContent = <MemberChangesApiPage courseId={courseId} />;
  }
  if (bReal || apiMode("projects") === "real") {
    if (screen === 35 && !courseId) realContent = <IndependentProjectPage />;
    if (screen === 35 && courseId) realContent = <NewProjectApiPage courseId={courseId} />;
    if (screen === 7 && projectId) realContent = <ProjectOverviewApiPage projectId={projectId} />;
    if (screen === 8 && projectId) realContent = <ProjectSetupApiPage projectId={projectId} />;
    if (screen === 9 && projectId) realContent = <RequirementsApiPage projectId={projectId} />;
    if (screen === 10 && projectId) realContent = <PlanningApiPage projectId={projectId} />;
    if (screen === 19 && projectId && milestoneId) realContent = <MilestoneDetailApiPage projectId={projectId} milestoneId={milestoneId} />;
  }
  if ([11, 12, 13].includes(screen) && projectId && (bReal || apiMode("tasks") === "real")) realContent = <TasksApiPage projectId={projectId} view={screen === 12 ? "board" : screen === 13 ? "list" : "tree"} />;
  if (bReal) {
    if (screen === 57) realContent = <TeacherClassesApiPage />;
    else if (screen === 58) realContent = <TeacherDashboardApiPage />;
    else if (screen === 41 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="home"><TeacherClassHomeApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 42 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="groups"><TeamPlazaApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 43 && courseId && groupId) realContent = <TeacherClassLayout courseId={courseId} activeTab="detail"><TeacherGroupDetailApiPage courseId={courseId} groupId={groupId} /></TeacherClassLayout>;
    else if (screen === 44 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="actions"><TeacherActionsApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 45 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="reports"><TeacherReportsApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 46 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="settings"><TeacherSettingsApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 47 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="rules"><TeacherRulesApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 49 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="appeals"><TeacherAppealsApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 50 && courseId && pathname.startsWith("/teacher/")) realContent = <TeacherClassLayout courseId={courseId} activeTab="files"><TeacherFilesApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 50 && courseId && pathname.startsWith("/courses/")) realContent = <StudentCourseFilesApiPage courseId={courseId} />;
    else if (screen === 59 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="staff"><TeacherStaffApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 60 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="announcements"><TeacherAnnouncementsApiPage courseId={courseId} /></TeacherClassLayout>;
    else if (screen === 61 && courseId) realContent = <TeacherClassLayout courseId={courseId} activeTab="projects"><TeacherProjectsApiPage courseId={courseId} /></TeacherClassLayout>;
  }
  if (screen === 30 && apiMode("daily") === "real") realContent = <PersonalActivityApiPage />;
  if (screen === 5 && apiMode("inbox") === "real") realContent = <NotificationsApiPage />;
  if (screen === 6 && apiMode("inbox") === "real") realContent = <ActionItemsApiPage />;
  if ([27, 28].includes(screen) && projectId && apiMode("reports") === "real") realContent = <ReportApiPage projectId={projectId} exportView={screen === 28} />;
  if (!realContent && screen === 41 && courseId && apiMode("cworkspace") === "real") realContent = <TeacherOverviewApiPage courseId={courseId} />;
  if (!realContent && screen === 49 && courseId && apiMode("cworkspace") === "real") realContent = <DTeacherAppealsApiPage courseId={courseId} />;
  if (!realContent && [42, 43, 44].includes(screen) && courseId && apiMode("cworkspace") === "real") realContent = <TeacherWorkspaceApiPage courseId={courseId} groupId={groupId} screen={screen as 42 | 43 | 44} />;
  if (!realContent && screen === 45 && courseId && apiMode("cworkspace") === "real") realContent = <DTeacherReportsApiPage courseId={courseId} />;
  if (!realContent && [38, 40, 46, 47].includes(screen) && courseId && apiMode("cworkspace") === "real") realContent = <CourseRulesApiPage courseId={courseId} teacher={screen >= 46} settingsView={screen === 46} />;
  if (screen === 29 && canonicalProject) realContent = <ProjectSettingsApiPage projectId={canonicalProject} reopenView={false} />;
  if ([21, 22].includes(screen) && canonicalProject) realContent = <ActivityApiPage projectId={canonicalProject} sourceType={screen === 21 ? "github" : "feishu"} />;
  if (screen === 39 && courseId && apiMode("cworkspace") === "real") realContent = <CourseReopenApiPage courseId={courseId} />;
  // D's acceptance and contribution pages always read persisted API records.
  if ((screen === 16 || screen === 17) && projectId && taskId) realContent = <AcceptanceApiPage projectId={projectId} taskId={taskId} screen={screen} />;
  if ((screen === 25 || screen === 26) && projectId) realContent = <ContributionApiPage projectId={projectId} memberId={screen === 26 ? memberId : undefined} />;
  if (apiMode("cworkspace") === "real") {
    if (screen === 18 && projectId) realContent = <RiskApiPage projectId={projectId} />;
    if ([14, 15].includes(screen) && projectId && taskId) realContent = <ExecutionApiPage projectId={projectId} taskId={taskId} submission={screen === 15} />;
    else if (screen === 20 && projectId) realContent = <EvidenceApiPage projectId={projectId} />;
    else if (screen === 23 && projectId) realContent = <ProjectFilesApiPage projectId={projectId} />;
    else if (screen === 24 && projectId) realContent = <ProjectDiscussionPreviewPage projectId={projectId} />;
  }
  if (screen === 18 && projectId && (bReal || apiMode("projects") === "real")) realContent = <><MilestonesApiPage projectId={projectId} />{apiMode("cworkspace") === "real" && <div className="mt-8"><RiskApiPage projectId={projectId} embedded /></div>}</>;
  if (screen === 50 && courseId && !realContent && apiMode("coursefiles") === "real") realContent = <CourseFilesApiPage courseId={courseId} />;
  if (screen === 62 && apiMode("cidentity") === "real" && apiMode("governance") === "real") realContent = <AdminDashboardPage />;
  if ([51, 52].includes(screen) && apiMode("cidentity") === "real") realContent = <IdentityAdminApiPage teachers={screen === 52} />;
  if (screen >= 53 && screen <= 56 && apiMode("governance") === "real") {
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
  else if (screen === 57 || screen === 58) content = <BNotConnectedPage screen={screen} />;
  else if (screen >= 41) content = <GovernanceView screen={screen} courseId={courseId} groupId={groupId} />;
  else content = <div className="gp-empty">{tc("loading")}</div>;

  return <WorkspaceShell kind={kind}>{content}</WorkspaceShell>;
}
