import { BApiError, bRequest, newIdempotencyKey } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";

export type BProjectDraft = {
  group_id: string; payload: { name?: string; project_type?: string; description?: string }; step: number;
  lock_version: number; updated_at: string | null; project_id: string | null;
};
export type BProjectOverview = {
  id: string; name: string; description: string | null; course_id: string | null; group_id: string | null;
  setup_status: "not_initialized" | "draft" | "pending_confirmation" | "frozen"; setup_step: number;
  lifecycle: "active" | "finalized" | "archived"; entry: "setup" | "baseline" | "readonly";
  can_edit: boolean; is_leader: boolean; final_deadline: string | null;
  stats: { task_count: number; completed_count: number; progress: number | null; progress_status: "available" | "no_weighted_tasks" | "invalid_task_tree"; member_count: number; milestone_count: number };
  next_milestone: { id: string; title: string; deadline: string | null; status: string } | null;
  members: BPerson[]; lock_version: number;
};
export type BMaterial = {
  id: string; kind: "text" | "file"; title: string; extract_status: "ready" | "pending" | "failed" | "unavailable";
  extract_reason: string | null; text_length: number; text: string | null; created_by: BPerson | null; created_at: string;
};
export type BProjectSetup = {
  project_id: string; name: string; project_type: string | null; description: string | null;
  start_date: string | null; end_date: string | null; course_deadline: string | null;
  setup_status: BProjectOverview["setup_status"]; setup_step: number; can_edit: boolean; materials: BMaterial[]; lock_version: number;
};
export type BBasicInfo = { name: string; project_type?: string; description?: string; start_date: string; end_date: string };

type UploadTicket = { receipt_id: string; upload_url: string; method: string; expires_at: string };

const id = encodeURIComponent;
export const bProjectsApi = {
  draft: (groupId: string) => bRequest<BProjectDraft>({ path: `/api/v1/groups/${id(groupId)}/project-draft` }),
  saveDraft: (groupId: string, draft: Pick<BProjectDraft, "payload" | "step" | "lock_version">) =>
    bRequest<BProjectDraft>({ method: "PUT", path: `/api/v1/groups/${id(groupId)}/project-draft`, body: { payload: draft.payload, step: draft.step, expected_version: draft.lock_version } }),
  create: (groupId: string, body: { name: string; project_type?: string; description?: string }, idempotencyKey?: string) =>
    bRequest<{ project_id: string; href: string }>({ method: "POST", path: `/api/v1/groups/${id(groupId)}/projects`, body, idempotencyKey }),
  overview: (projectId: string) => bRequest<BProjectOverview>({ path: `/api/v1/projects/${id(projectId)}/overview` }),
  setup: (projectId: string) => bRequest<BProjectSetup>({ path: `/api/v1/projects/${id(projectId)}/setup` }),
  saveBasic: (projectId: string, body: BBasicInfo, expectedVersion: number) =>
    bRequest<BProjectSetup>({ method: "PATCH", path: `/api/v1/projects/${id(projectId)}/setup/basic`, body: { ...body, expected_version: expectedVersion } }),
  addText: (projectId: string, body: { title?: string; text: string }) =>
    bRequest<BMaterial>({ method: "POST", path: `/api/v1/projects/${id(projectId)}/materials`, body: { kind: "text", ...body } }),
  material: (projectId: string, materialId: string) => bRequest<BMaterial>({ path: `/api/v1/projects/${id(projectId)}/materials/${id(materialId)}` }),
  /** A4-04 upload (ticket → bytes → complete), then register the receipt as a material. */
  addFile: async (projectId: string, file: File) => {
    const ticket = await bRequest<UploadTicket>({
      method: "POST", path: "/api/v1/storage/uploads",
      body: { scope: "project", scope_id: projectId, filename: file.name, mime_type: file.type || "application/octet-stream", size_bytes: file.size },
    });
    let put: Response;
    try {
      put = await fetch(ticket.upload_url, { method: ticket.method || "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
    } catch {
      throw new BApiError(0, "UPLOAD_FAILED", "文件上传失败，请重试。", null);
    }
    if (!put.ok) throw new BApiError(put.status, "UPLOAD_FAILED", "文件上传失败，请重试。", null);
    await bRequest({ method: "POST", path: `/api/v1/storage/uploads/${id(ticket.receipt_id)}/complete` });
    return bRequest<BMaterial>({ method: "POST", path: `/api/v1/projects/${id(projectId)}/materials`, body: { kind: "file", receipt_id: ticket.receipt_id }, idempotencyKey: newIdempotencyKey() });
  },
};
