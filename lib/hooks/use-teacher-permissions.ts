"use client";

import { useQuery } from "@tanstack/react-query";
import { teacherStaffApi, teacherStaffKeys } from "@/lib/api/teacher-staff-client";
import { useWorkspace } from "@/lib/workspace";

export interface TeacherPermissionsState {
  role: "teacher" | "ta" | null;
  isTeacher: boolean;
  isOwner: boolean;
  canManage: boolean;
  approveJoins: boolean;
  manageGroups: boolean;
  manageFiles: boolean;
  approveChanges: boolean;
  exportReports: boolean;
  postAnnouncements: boolean;
  loading: boolean;
}

export function useTeacherPermissions(courseId: string): TeacherPermissionsState {
  const { role, userId } = useWorkspace();
  const isStaffRole = role === "teacher" || role === "ta";
  const query = useQuery({
    queryKey: teacherStaffKeys.myPermissions(userId, courseId),
    queryFn: () => teacherStaffApi.myPermissions(courseId),
    enabled: Boolean(courseId) && isStaffRole,
    staleTime: 60_000,
    retry: false,
  });

  const data = query.data;
  const fallbackTeacher = role === "teacher";
  if (!data) {
    return {
      role: fallbackTeacher ? "teacher" : role === "ta" ? "ta" : null,
      isTeacher: fallbackTeacher,
      isOwner: fallbackTeacher,
      canManage: fallbackTeacher,
      approveJoins: fallbackTeacher,
      manageGroups: fallbackTeacher,
      manageFiles: fallbackTeacher,
      approveChanges: fallbackTeacher,
      exportReports: fallbackTeacher,
      postAnnouncements: fallbackTeacher,
      loading: query.isLoading,
    };
  }

  return {
    role: data.role,
    isTeacher: data.role === "teacher",
    isOwner: data.is_owner,
    canManage: data.can_manage,
    approveJoins: data.permissions.approve_joins,
    manageGroups: data.permissions.manage_groups,
    manageFiles: data.permissions.manage_files,
    approveChanges: data.permissions.approve_changes,
    exportReports: data.permissions.export_reports,
    postAnnouncements: data.permissions.post_announcements,
    loading: false,
  };
}
