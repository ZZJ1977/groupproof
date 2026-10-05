"use client";

import { AdminAccessRequests, AdminAiUsage, AdminCourses, AdminLogs, AdminTeacherVerification, AdminUsers } from "./AdminViews";
import { TeacherActions, TeacherAppeals, TeacherFiles, TeacherGroupDetail, TeacherGroups, TeacherMemberChanges, TeacherOverview, TeacherReports, TeacherRules, TeacherSettings } from "./TeacherViews";
import { Header } from "./primitives";
import styles from "./governance.module.css";

export function GovernanceView({ screen, courseId, groupId }: { screen: number | string; courseId?: string; groupId?: string }) {
  switch (Number(screen)) {
    case 41: return <TeacherOverview courseId={courseId} />;
    case 42: return <TeacherGroups courseId={courseId} />;
    case 43: return <TeacherGroupDetail courseId={courseId} groupId={groupId} />;
    case 44: return <TeacherActions courseId={courseId} />;
    case 45: return <TeacherReports courseId={courseId} />;
    case 46: return <TeacherSettings courseId={courseId} />;
    case 47: return <TeacherRules courseId={courseId} />;
    case 48: return <TeacherMemberChanges courseId={courseId} />;
    case 49: return <TeacherAppeals courseId={courseId} />;
    case 50: return <TeacherFiles courseId={courseId} />;
    case 51: return <AdminUsers />;
    case 52: return <AdminTeacherVerification />;
    case 53: return <AdminCourses />;
    case 54: return <AdminLogs />;
    case 55: return <AdminAiUsage />;
    case 56: return <AdminAccessRequests />;
    default: return <div className={styles.page}><Header title="页面不存在" description="请从导航中选择教师或管理员页面。" /></div>;
  }
}

export default GovernanceView;
