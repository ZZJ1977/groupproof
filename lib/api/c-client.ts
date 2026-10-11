import { createApiClient } from "@/lib/api/client";
import type { components, paths } from "@/packages/domain/api.generated";

type Schema = components["schemas"];
type EvidenceQuery = paths["/api/v1/projects/{project_id}/evidence"]["get"]["parameters"]["query"];

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
  };
}
