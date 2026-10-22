import { createApiClient } from "@/lib/api/client";
import { CApiError } from "@/lib/api/c-client";
import type { components, paths } from "@/packages/domain/api.generated";

type Schema = components["schemas"];
export type CourseQuery = paths["/api/v1/admin/courses"]["get"]["parameters"]["query"];
export type AccessQuery = paths["/api/v1/admin/access-requests"]["get"]["parameters"]["query"];
export type AuditQuery = paths["/api/v1/admin/audit-logs"]["get"]["parameters"]["query"];
export type AuthAuditQuery = paths["/api/v1/admin/auth-audit-logs"]["get"]["parameters"]["query"];
export type UsageQuery = paths["/api/v1/admin/ai-usage"]["get"]["parameters"]["query"];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function unwrap<T>(result: { data?: { data: T }; error?: unknown; response: Response }): T {
  const envelope = record(result.response.ok ? result.data : result.error);
  const meta = record(envelope.meta);
  if (result.response.ok && Object.hasOwn(envelope, "data") && envelope.data !== undefined
    && !Object.hasOwn(envelope, "error") && typeof meta.request_id === "string") return envelope.data as T;
  const error = record(envelope.error);
  throw new CApiError(result.response.status,
    !result.response.ok && typeof error.code === "string" ? error.code : "INVALID_API_RESPONSE",
    typeof error.message === "string" ? error.message : "服务暂不可用，请重试。",
    typeof meta.request_id === "string" ? meta.request_id : result.response.headers.get("X-Request-Id"));
}

/** Real authenticated transport only. Missing A providers stay 503; no demo fallback. */
export function createGovernanceClient(client = createApiClient()) {
  return {
    async courses(query: CourseQuery = {}) {
      return unwrap(await client.GET("/api/v1/admin/courses", { params: { query } }));
    },
    async course(id: string) {
      return unwrap(await client.GET("/api/v1/admin/courses/{course_id}", { params: { path: { course_id: id } } }));
    },
    async createCourse(body: Schema["CreateCourse"], key: string) {
      return unwrap(await client.POST("/api/v1/admin/courses", { params: { header: { "Idempotency-Key": key } }, body }));
    },
    async transitionCourse(id: string, body: Schema["TransitionCourse"], key: string) {
      return unwrap(await client.POST("/api/v1/admin/courses/{course_id}/transitions", { params: { path: { course_id: id }, header: { "Idempotency-Key": key } }, body }));
    },
    async accessRequests(query: AccessQuery = {}) {
      return unwrap(await client.GET("/api/v1/admin/access-requests", { params: { query } }));
    },
    async accessRequest(id: string) {
      return unwrap(await client.GET("/api/v1/admin/access-requests/{request_id}", { params: { path: { request_id: id } } }));
    },
    async decideAccess(id: string, body: Schema["DecideAccessRequest"], key: string) {
      return unwrap(await client.POST("/api/v1/admin/access-requests/{request_id}/decisions", { params: { path: { request_id: id }, header: { "Idempotency-Key": key } }, body }));
    },
    async auditLogs(query: AuditQuery = {}) {
      return unwrap(await client.GET("/api/v1/admin/audit-logs", { params: { query } }));
    },
    async auditLog(id: string) {
      return unwrap(await client.GET("/api/v1/admin/audit-logs/{record_id}", { params: { path: { record_id: id } } }));
    },
    async authAuditLogs(query: AuthAuditQuery = {}) {
      return unwrap(await client.GET("/api/v1/admin/auth-audit-logs", { params: { query } }));
    },
    async authAuditLog(id: string) {
      return unwrap(await client.GET("/api/v1/admin/auth-audit-logs/{record_id}", { params: { path: { record_id: id } } }));
    },
    async usage(query: UsageQuery = {}) {
      return unwrap(await client.GET("/api/v1/admin/ai-usage", { params: { query } }));
    },
  };
}
