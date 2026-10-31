import { createApiClient } from "@/lib/api/client";
import { CApiError } from "@/lib/api/c-client";
import type { components, paths } from "@/packages/domain/api.generated";

type Schema = components["schemas"];
export type NotificationQuery = paths["/api/v1/me/notifications"]["get"]["parameters"]["query"];
export type ActionItemQuery = paths["/api/v1/me/action-items"]["get"]["parameters"]["query"];
const uuid = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

function unwrap<T>(result: { data?: { data: T }; error?: unknown; response: Response }): T {
  const envelope = record(result.response.ok ? result.data : result.error); const meta = record(envelope.meta);
  if (result.response.ok && envelope.data !== null && typeof envelope.data === "object" && !Object.hasOwn(envelope, "error") && typeof meta.request_id === "string") return envelope.data as T;
  const error = record(envelope.error);
  throw new CApiError(result.response.status, !result.response.ok && typeof error.code === "string" ? error.code : "INVALID_API_RESPONSE",
    typeof error.message === "string" ? error.message : "通知服务暂不可用，请重试。", typeof meta.request_id === "string" ? meta.request_id : null);
}

/** Never navigate an arbitrary href returned by a notification source. */
export function inboxTargetHref(value: Schema["InboxTarget"] | null | undefined): string | null {
  if (!value || !uuid(value.id)) return null;
  const { kind, id, project_id: project, course_id: course } = value;
  if (["course", "member_change", "appeal", "rule_change"].includes(kind)) {
    if (!uuid(course) || project != null) return null;
    if (kind === "course") return id === course ? `/courses/${course}/rules` : null;
    if (kind === "member_change") return `/teacher/courses/${course}/member-changes?request=${id}`;
    if (kind === "appeal") return `/teacher/courses/${course}/appeals?appeal=${id}`;
    return `/courses/${course}/rule-changes?change=${id}`;
  }
  if (!uuid(project) || course != null) return null;
  const base = `/projects/${project}`;
  if (["project", "baseline", "plan"].includes(kind) && id !== project) return null;
  return ({ project: base, baseline: `${base}/setup`, plan: `${base}/planning`, task: `${base}/tasks/${id}`,
    verification: `${base}/tasks/${id}/verification`, evidence: `${base}/evidence?evidence=${id}`,
    discussion: `${base}/discussions?discussion=${id}` } as Record<string, string>)[kind] ?? null;
}

/** Exact recipient identity comes from A's session; this client accepts no actor override. */
export function createInboxClient(client = createApiClient()) {
  return {
    async notifications(query: NotificationQuery = {}) { return unwrap(await client.GET("/api/v1/me/notifications", { params: { query } })); },
    async actionItems(query: ActionItemQuery = {}) { return unwrap(await client.GET("/api/v1/me/action-items", { params: { query } })); },
    async markRead(id: string, body: Schema["MarkNotificationRead"], key: string) {
      if (!uuid(id) || !uuid(body.snapshot_id)) throw new CApiError(422, "INVALID_RESOURCE_ID", "通知记录已变化，请刷新。", null);
      return unwrap(await client.POST("/api/v1/me/notifications/{notification_id}/read", { params: { path: { notification_id: id }, header: { "Idempotency-Key": key } }, body }));
    },
    async markAllRead(body: Schema["MarkAllNotificationsRead"], key: string) {
      if (!uuid(body.snapshot_id)) throw new CApiError(422, "INVALID_RESOURCE_ID", "通知列表已变化，请刷新。", null);
      return unwrap(await client.POST("/api/v1/me/notifications/read-all", { params: { header: { "Idempotency-Key": key } }, body }));
    },
  };
}

export const inboxApi = createInboxClient();
