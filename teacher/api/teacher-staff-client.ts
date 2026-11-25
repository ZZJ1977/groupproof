import { bRequest, newIdempotencyKey } from "@/student/api/b-client";

export type StaffPermissions = {
  approve_joins: boolean;
  manage_groups: boolean;
  manage_files: boolean;
  approve_changes: boolean;
  export_reports: boolean;
  post_announcements: boolean;
};

export type StaffMember = {
  user_id: string;
  name: string;
  email: string | null;
  role: "teacher" | "ta";
  permissions: StaffPermissions;
  joined_at: string;
  is_owner: boolean;
};

export type StaffListData = {
  items: StaffMember[];
  total: number;
  can_manage_staff: boolean;
};

export type MyPermissionsData = {
  role: "teacher" | "ta";
  is_owner: boolean;
  can_manage: boolean;
  permissions: StaffPermissions;
};

const id = encodeURIComponent;

export const teacherStaffKeys = {
  staff: (userId: string, courseId: string) => ["b-teacher-staff", userId, courseId] as const,
  myPermissions: (userId: string, courseId: string) =>
    ["b-teacher-my-permissions", userId, courseId] as const,
};

export const teacherStaffApi = {
  list: (courseId: string) =>
    bRequest<StaffListData>({ path: `/api/v1/teacher/classes/${id(courseId)}/staff` }),
  myPermissions: (courseId: string) =>
    bRequest<MyPermissionsData>({ path: `/api/v1/teacher/classes/${id(courseId)}/my-permissions` }),
  invite: (courseId: string, body: { email: string; role: "ta" | "teacher" }, idempotencyKey?: string) =>
    bRequest<StaffMember>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/staff/invite`,
      body,
      idempotencyKey,
    }),
  updatePermissions: (
    courseId: string,
    staffUserId: string,
    body: Partial<StaffPermissions>,
    idempotencyKey?: string,
  ) =>
    bRequest<StaffMember>({
      method: "PATCH",
      path: `/api/v1/teacher/classes/${id(courseId)}/staff/${id(staffUserId)}/permissions`,
      body,
      idempotencyKey,
    }),
  remove: (courseId: string, staffUserId: string, reason: string, idempotencyKey?: string) =>
    bRequest<{ removed: boolean; user_id: string }>({
      method: "POST",
      path: `/api/v1/teacher/classes/${id(courseId)}/staff/${id(staffUserId)}/remove`,
      body: { reason },
      idempotencyKey,
    }),
};

export { newIdempotencyKey };
