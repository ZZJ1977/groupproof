import { bRequest, newIdempotencyKey } from "@/lib/api/b-client";

export type MaterialVisibility = "all" | "grouped" | "staff";
export type MaterialStatus = "draft" | "published";
export type BatchMaterialAction = "move" | "set_visibility" | "delete";

export type FolderRef = {
  id: string;
  name: string;
  parent_id: string | null;
};

export type CourseFolder = FolderRef & {
  course_id: string;
  sort_order: number;
  item_count: number;
  created_at: string;
};

export type MaterialVersion = {
  id: string;
  version_no: number;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  change_note: string | null;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
  has_content: boolean;
};

export type MaterialItem = {
  id: string;
  course_id: string;
  folder_id: string | null;
  name: string;
  visibility: MaterialVisibility;
  status: MaterialStatus;
  latest_version_no: number;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
  updated_at: string;
  download_href: string;
};

export type MaterialDetail = {
  item: MaterialItem;
  versions: MaterialVersion[];
};

export type TeacherFilesTree = {
  course_id: string;
  can_manage: boolean;
  current_folder_id: string | null;
  breadcrumbs: FolderRef[];
  folders: CourseFolder[];
  items: MaterialItem[];
};

export type StudentMaterialsData = {
  course_id: string;
  is_grouped: boolean;
  items: MaterialItem[];
};

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const enc = encodeURIComponent;

export const teacherFilesKeys = {
  tree: (userId: string, courseId: string, key: string) =>
    ["b-teacher-files", userId, courseId, key] as const,
  versions: (userId: string, courseId: string, materialId: string) =>
    ["b-teacher-file-versions", userId, courseId, materialId] as const,
};

export const teacherFilesApi = {
  list: (
    courseId: string,
    params: {
      folder_id?: string | null;
      q?: string;
      visibility?: MaterialVisibility;
      include_all?: boolean;
    } = {},
  ) =>
    bRequest<TeacherFilesTree>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/files`,
      query: {
        folder_id: params.folder_id ?? undefined,
        q: params.q || undefined,
        visibility: params.visibility,
        include_all: params.include_all ? true : undefined,
      },
    }),

  createFolder: (
    courseId: string,
    body: { name: string; parent_id?: string | null; sort_order?: number },
  ) =>
    bRequest<CourseFolder>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/folders`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  updateFolder: (
    courseId: string,
    folderId: string,
    body: { name?: string; parent_id?: string | null; move_to_root?: boolean; sort_order?: number },
  ) =>
    bRequest<CourseFolder>({
      method: "PATCH",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/folders/${enc(folderId)}`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  deleteFolder: (courseId: string, folderId: string) =>
    bRequest<{ deleted: boolean; id: string }>({
      method: "DELETE",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/folders/${enc(folderId)}`,
      idempotencyKey: newIdempotencyKey(),
    }),

  upload: (
    courseId: string,
    body: {
      name: string;
      folder_id?: string | null;
      visibility: MaterialVisibility;
      status: MaterialStatus;
      mime_type?: string;
      size_bytes?: number;
      content_base64?: string;
      change_note?: string;
    },
  ) =>
    bRequest<MaterialDetail>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/upload`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  versions: (courseId: string, materialId: string) =>
    bRequest<MaterialDetail>({
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/${enc(materialId)}/versions`,
    }),

  appendVersion: (
    courseId: string,
    materialId: string,
    body: {
      original_name?: string;
      mime_type?: string;
      size_bytes?: number;
      content_base64?: string;
      change_note?: string;
    },
  ) =>
    bRequest<MaterialDetail>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/${enc(materialId)}/versions`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  updateMaterial: (
    courseId: string,
    materialId: string,
    body: {
      name?: string;
      folder_id?: string | null;
      move_to_root?: boolean;
      visibility?: MaterialVisibility;
      status?: MaterialStatus;
    },
  ) =>
    bRequest<MaterialItem>({
      method: "PATCH",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/${enc(materialId)}`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),

  deleteMaterial: (courseId: string, materialId: string) =>
    bRequest<{ deleted: boolean; id: string }>({
      method: "DELETE",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/${enc(materialId)}`,
      idempotencyKey: newIdempotencyKey(),
    }),

  batch: (
    courseId: string,
    body: {
      ids: string[];
      action: BatchMaterialAction;
      folder_id?: string | null;
      visibility?: MaterialVisibility;
    },
  ) =>
    bRequest<{ affected: number; action: BatchMaterialAction }>({
      method: "POST",
      path: `/api/v1/teacher/classes/${enc(courseId)}/files/batch`,
      body,
      idempotencyKey: newIdempotencyKey(),
    }),
};
