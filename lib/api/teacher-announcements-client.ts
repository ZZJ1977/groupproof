import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";

export type AnnouncementPriority = "normal" | "important" | "urgent";
export type AnnouncementStatus = "draft" | "published";

export type AnnouncementItem = {
  id: string;
  course_id: string;
  course_name: string;
  title: string;
  content: string;
  priority: AnnouncementPriority;
  is_pinned: boolean;
  status: AnnouncementStatus;
  published_by: string;
  publisher_name: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  read_count: number;
  total_students: number;
  unread_count: number;
};

export type AnnouncementListData = {
  course_id: string;
  can_post: boolean;
  total_students: number;
  items: AnnouncementItem[];
};

export type AnnouncementReader = {
  user_id: string;
  name: string;
  student_number: string | null;
  read_at: string | null;
};

export type AnnouncementReadsData = {
  announcement_id: string;
  title: string;
  total_students: number;
  read_count: number;
  unread_count: number;
  read_users: AnnouncementReader[];
  unread_users: AnnouncementReader[];
};

export type UnreadAnnouncementsData = {
  total: number;
  items: AnnouncementItem[];
};

const enc = encodeURIComponent;

export const teacherAnnouncementsKeys = {
  list: (userId: string, courseId: string) =>
    ["b-teacher-announcements", userId, courseId] as const,
  reads: (userId: string, courseId: string, annId: string) =>
    ["b-teacher-announcement-reads", userId, courseId, annId] as const,
  studentUnread: (userId: string) => ["b-student-unread-announcements", userId] as const,
};

export const teacherAnnouncementsApi = {
  list: (courseId: string) =>
    bRequest<AnnouncementListData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/announcements`,
    }),

  create: (
    courseId: string,
    body: {
      title: string;
      content: string;
      priority: AnnouncementPriority;
      is_pinned: boolean;
      status: AnnouncementStatus;
    },
  ) =>
    bRequest<AnnouncementItem>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/announcements`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  update: (
    courseId: string,
    announcementId: string,
    body: {
      title?: string;
      content?: string;
      priority?: AnnouncementPriority;
      is_pinned?: boolean;
      status?: AnnouncementStatus;
    },
  ) =>
    bRequest<AnnouncementItem>({
      method: "PATCH",
      path: `/api/v1/teacher/classes/${enc(courseId)}/announcements/${enc(announcementId)}`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  remove: (courseId: string, announcementId: string) =>
    bRequest<{ deleted: boolean; id: string }>({
      method: "DELETE",
      path: `/api/v1/teacher/classes/${enc(courseId)}/announcements/${enc(announcementId)}`,
      idempotencyKey: newIdempotencyKey(),
    }),

  reads: (courseId: string, announcementId: string) =>
    bRequest<AnnouncementReadsData>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/announcements/${enc(announcementId)}/reads`,
    }),

  remind: (courseId: string, announcementId: string) =>
    bRequest<{ announcement_id: string; notified_count: number }>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/announcements/${enc(announcementId)}/remind`,
      body: {},
      idempotencyKey: newIdempotencyKey(),
    }),

  myUnread: () =>
    bRequest<UnreadAnnouncementsData>({
      path: "/api/v1/me/announcements/unread",
    }),

  markRead: (courseId: string, announcementId: string) =>
    bRequest<{ announcement_id: string; read: boolean; read_at: string }>({
      method: "POST",
      path: `/api/v1/courses/${enc(courseId)}/announcements/${enc(announcementId)}/read`,
      body: {},
      idempotencyKey: newIdempotencyKey(),
    }),
};
