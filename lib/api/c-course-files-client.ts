import { createApiClient } from "@/lib/api/client";
import { CApiError } from "@/lib/api/c-client";
import type { components, paths } from "@/packages/domain/api.generated";

type Schema = components["schemas"];
export type CourseFileQuery = paths["/api/v1/courses/{course_id}/files"]["get"]["parameters"]["query"];

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new CApiError(422, "INVALID_RESOURCE_ID", "课程或资料地址无效，请从已授权入口重新打开。", null);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function unwrap<T>(result: { data?: { data: T }; error?: unknown; response: Response }): T {
  const envelope = record(result.response.ok ? result.data : result.error);
  const meta = record(envelope.meta);
  if (result.response.ok && Object.hasOwn(envelope, "data") && envelope.data !== null && typeof envelope.data === "object"
    && !Object.hasOwn(envelope, "error") && typeof meta.request_id === "string") return envelope.data as T;
  const error = record(envelope.error);
  throw new CApiError(result.response.status,
    !result.response.ok && typeof error.code === "string" ? error.code : "INVALID_API_RESPONSE",
    typeof error.message === "string" ? error.message : "课程资料暂不可用，请重试。",
    typeof meta.request_id === "string" ? meta.request_id : result.response.headers.get("X-Request-Id"));
}

/** Course-specific contracts; no mock identifiers, actor override, or project receipt substitution. */
export function createCourseFilesClient(client = createApiClient()) {
  return {
    async files(courseId: string, query: CourseFileQuery = {}) {
      return unwrap(await client.GET("/api/v1/courses/{course_id}/files", {
        params: { path: { course_id: uuid(courseId) }, query },
      }));
    },
    async file(courseId: string, fileId: string) {
      return unwrap(await client.GET("/api/v1/courses/{course_id}/files/{file_id}", {
        params: { path: { course_id: uuid(courseId), file_id: uuid(fileId) } },
      }));
    },
    async registerFile(courseId: string, input: Schema["RegisterCourseFile"], key: string) {
      uuid(input.receipt_id);
      return unwrap(await client.POST("/api/v1/courses/{course_id}/files", {
        params: { path: { course_id: uuid(courseId) }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async appendVersion(courseId: string, fileId: string, input: Schema["AppendCourseFileVersion"], key: string) {
      uuid(input.receipt_id);
      return unwrap(await client.POST("/api/v1/courses/{course_id}/files/{file_id}/versions", {
        params: { path: { course_id: uuid(courseId), file_id: uuid(fileId) }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async publishVersion(courseId: string, fileId: string, input: Schema["PublishCourseFileVersion"], key: string) {
      uuid(input.version_id);
      return unwrap(await client.POST("/api/v1/courses/{course_id}/files/{file_id}/publish", {
        params: { path: { course_id: uuid(courseId), file_id: uuid(fileId) }, header: { "Idempotency-Key": key } }, body: input,
      }));
    },
    async fileLink(courseId: string, fileId: string, versionId: string, purpose: "preview" | "download") {
      return unwrap(await client.GET("/api/v1/courses/{course_id}/files/{file_id}/versions/{version_id}/link", {
        params: { path: { course_id: uuid(courseId), file_id: uuid(fileId), version_id: uuid(versionId) }, query: { purpose } },
      }));
    },
  };
}

export const courseFilesApi = createCourseFilesClient();
