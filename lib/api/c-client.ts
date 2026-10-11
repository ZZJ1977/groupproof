import { createApiClient } from "@/lib/api/client";
import type { components, paths } from "@/packages/domain/api.generated";

type Schema = components["schemas"];
type EvidenceQuery = paths["/api/v1/projects/{project_id}/evidence"]["get"]["parameters"]["query"];
type DiscussionQuery = paths["/api/v1/projects/{project_id}/discussions"]["get"]["parameters"]["query"];
export type AdminUserQuery = paths["/api/v1/admin/users"]["get"]["parameters"]["query"];
export type DailyActivityQuery = paths["/api/v1/me/activity"]["get"]["parameters"]["query"];
export type ActivitySourceType = "github" | "feishu";
export type ActivityQuery = paths["/api/v1/projects/{project_id}/activities/{source_type}"]["get"]["parameters"]["query"];
export type ProjectFileQuery = paths["/api/v1/projects/{project_id}/files"]["get"]["parameters"]["query"];

export class CApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "CApiError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function unwrap<T>(result: { data?: { data: T }; error?: unknown; response: Response }): T {
  const envelope = record(result.response.ok ? result.data : result.error);
  const meta = record(envelope.meta);
  if (result.response.ok && Object.hasOwn(envelope, "data") && envelope.data !== undefined
    && !Object.hasOwn(envelope, "error") && typeof meta.request_id === "string") {
    return envelope.data as T;
  }
  const error = record(envelope.error);
  throw new CApiError(
    result.response.status,
    !result.response.ok && typeof error.code === "string" ? error.code : "INVALID_API_RESPONSE",
    typeof error.message === "string" ? error.message : "服务暂不可用，请重试。",
    typeof meta.request_id === "string" ? meta.request_id : result.response.headers.get("X-Request-Id"),
  );
}

/**
 * Canonical C API contract. No mock ID translation, actor override or demo header.
 * A must connect the real session transport before enabling these calls in pages.
 * Keep the same idempotency key when retrying a failed write with the same input.
 */
export function createCClient(client = createApiClient()) {
  return {
    async homeSummary() {
      return unwrap<Schema["DailyHomeDTO"]>(await client.GET("/api/v1/home/summary"));
    },
    async personalActivity(query: DailyActivityQuery = {}) {
      return unwrap(await client.GET("/api/v1/me/activity", { params: { query } }));
    },
    async activities(projectId: string, sourceType: ActivitySourceType, query: ActivityQuery = {}) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/activities/{source_type}", {
        params: { path: { project_id: projectId, source_type: sourceType }, query },
      }));
    },
    async activity(projectId: string, sourceType: ActivitySourceType, sourceId: string) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/activities/{source_type}/{source_id}", {
        params: { path: { project_id: projectId, source_type: sourceType, source_id: sourceId } },
      }));
    },
    async activityHistory(projectId: string, sourceType: ActivitySourceType, sourceId: string) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/activities/{source_type}/{source_id}/history", {
        params: { path: { project_id: projectId, source_type: sourceType, source_id: sourceId } },
      }));
    },
    async associateActivity(projectId: string, sourceType: ActivitySourceType, sourceId: string, input: Schema["AssociateActivity"], key: string) {
      return unwrap(await client.PUT("/api/v1/projects/{project_id}/activities/{source_type}/{source_id}/association", {
        params: { path: { project_id: projectId, source_type: sourceType, source_id: sourceId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async decideActivity(projectId: string, sourceType: ActivitySourceType, sourceId: string, input: Schema["DecideActivity"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/activities/{source_type}/{source_id}/decisions", {
        params: { path: { project_id: projectId, source_type: sourceType, source_id: sourceId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async files(projectId: string, query: ProjectFileQuery = {}) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/files", { params: { path: { project_id: projectId }, query } }));
    },
    async file(projectId: string, fileId: string) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/files/{file_id}", { params: { path: { project_id: projectId, file_id: fileId } } }));
    },
    async registerFile(projectId: string, input: Schema["RegisterFile"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/files", {
        params: { path: { project_id: projectId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async appendFileVersion(projectId: string, fileId: string, input: Schema["AppendFileVersion"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/files/{file_id}/versions", {
        params: { path: { project_id: projectId, file_id: fileId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async designateFileVersion(projectId: string, fileId: string, input: Schema["DesignateFileVersion"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/files/{file_id}/designate", {
        params: { path: { project_id: projectId, file_id: fileId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async fileLink(projectId: string, fileId: string, versionId: string, purpose: "preview" | "download" = "download") {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/files/{file_id}/versions/{version_id}/link", {
        params: { path: { project_id: projectId, file_id: fileId, version_id: versionId }, query: { purpose } },
      }));
    },
    async adminUsers(query: AdminUserQuery = {}) {
      return unwrap(await client.GET("/api/v1/admin/users", { params: { query } }));
    },
    async adminUser(userId: string) {
      return unwrap(await client.GET("/api/v1/admin/users/{user_id}", { params: { path: { user_id: userId } } }));
    },
    async execution(taskId: string) {
      return unwrap(await client.GET("/api/v1/tasks/{task_id}/execution", {
        params: { path: { task_id: taskId } },
      }));
    },
    async start(taskId: string, expectedVersion: number) {
      return unwrap(await client.POST("/api/v1/tasks/{task_id}/start", {
        params: { path: { task_id: taskId } }, body: { expected_version: expectedVersion },
      }));
    },
    async progress(taskId: string, input: Schema["UpdateProgressRequest"]) {
      return unwrap(await client.PATCH("/api/v1/tasks/{task_id}/progress", {
        params: { path: { task_id: taskId } }, body: input,
      }));
    },
    async prepareSubmission(taskId: string, input: Schema["PrepareSubmissionRequest"], key: string) {
      return unwrap(await client.POST("/api/v1/tasks/{task_id}/prepare-submission", {
        params: { path: { task_id: taskId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async evidence(projectId: string, query: EvidenceQuery = {}) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/evidence", {
        params: { path: { project_id: projectId }, query },
      }));
    },
    async effectiveEvidence(projectId: string, taskId: string, page = 1, pageSize = 50) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/evidence/effective", {
        params: { path: { project_id: projectId }, query: { task_id: taskId, page, page_size: pageSize } },
      }));
    },
    async evidenceDetail(projectId: string, evidenceId: string) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/evidence/{evidence_id}", {
        params: { path: { project_id: projectId, evidence_id: evidenceId } },
      }));
    },
    async addEvidence(projectId: string, input: Schema["CreateEvidence"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/evidence", {
        params: { path: { project_id: projectId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async adopt(projectId: string, evidenceId: string, input: Schema["DecideEvidence"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/evidence/{evidence_id}/adopt", {
        params: { path: { project_id: projectId, evidence_id: evidenceId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async withdraw(projectId: string, evidenceId: string, input: Schema["DecideEvidence"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/evidence/{evidence_id}/withdraw", {
        params: { path: { project_id: projectId, evidence_id: evidenceId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async checkSource(projectId: string, evidenceId: string, input: Schema["CheckEvidenceSource"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/evidence/{evidence_id}/check-source", {
        params: { path: { project_id: projectId, evidence_id: evidenceId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async note(projectId: string, taskId: string, history = false) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/tasks/{task_id}/note", {
        params: { path: { project_id: projectId, task_id: taskId }, query: { history } },
      }));
    },
    async saveNote(projectId: string, taskId: string, input: Schema["SaveTaskNote"], key: string) {
      return unwrap(await client.PUT("/api/v1/projects/{project_id}/tasks/{task_id}/note", {
        params: { path: { project_id: projectId, task_id: taskId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async discussions(projectId: string, query: DiscussionQuery = {}) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/discussions", {
        params: { path: { project_id: projectId }, query },
      }));
    },
    async discussion(projectId: string, discussionId: string) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/discussions/{discussion_id}", {
        params: { path: { project_id: projectId, discussion_id: discussionId } },
      }));
    },
    async createDiscussion(projectId: string, input: Schema["CreateDiscussion"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/discussions", {
        params: { path: { project_id: projectId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async replies(projectId: string, discussionId: string, page = 1, pageSize = 50) {
      return unwrap(await client.GET("/api/v1/projects/{project_id}/discussions/{discussion_id}/replies", {
        params: { path: { project_id: projectId, discussion_id: discussionId }, query: { page, page_size: pageSize } },
      }));
    },
    async reply(projectId: string, discussionId: string, input: Schema["ReplyDiscussion"], key: string) {
      return unwrap(await client.POST("/api/v1/projects/{project_id}/discussions/{discussion_id}/replies", {
        params: { path: { project_id: projectId, discussion_id: discussionId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async markImportant(projectId: string, discussionId: string, input: Schema["MarkDiscussionImportant"], key: string) {
      return unwrap(await client.PUT("/api/v1/projects/{project_id}/discussions/{discussion_id}/important", {
        params: { path: { project_id: projectId, discussion_id: discussionId }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
  };
}
