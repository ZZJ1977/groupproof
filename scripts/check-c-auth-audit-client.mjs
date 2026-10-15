import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client.ts";
import { CApiError } from "../lib/api/c-client.ts";
import { createGovernanceClient } from "../lib/api/c-governance-client.ts";

// Test the real client contract with local responses; no production audit records are fabricated.
const requests = [];
let status = 200, body = { data: { source: "auth_audit_events", scope: "authentication", items: [], total: 0, page: 2, page_size: 10 }, meta: { request_id: "auth-audit-client" } };
const api = createGovernanceClient(createApiClient({ baseUrl: "http://127.0.0.1:8001", fetch: async (request) => { requests.push(request.clone()); return Response.json(body, { status }); } }));
const target = "00000000-0000-0000-0000-000000001002";
const filters = { page: 2, page_size: 10, actor_id: "system", target_user_id: target, action: "auth.password_login", result: "failure", since: "2026-10-01T00:00:00Z", until: "2026-10-15T00:00:00Z" };
assert.deepEqual(await api.authAuditLogs(filters), body.data);
const request = requests.at(-1), url = new URL(request.url);
assert.equal(url.pathname, "/api/v1/admin/auth-audit-logs");
assert.equal(request.method, "GET");
assert.equal(request.credentials, "include");
assert.equal(request.headers.get("X-Demo-User-Id"), null);
for (const [key, value] of Object.entries(filters)) assert.equal(url.searchParams.get(key), String(value));
await api.authAuditLog("opaque_A1-not-a-uuid");
assert.equal(new URL(requests.at(-1).url).pathname, "/api/v1/admin/auth-audit-logs/opaque_A1-not-a-uuid");
for (const responseStatus of [403, 404, 503]) {
  status = responseStatus;
  body = { error: { code: "AUTH_AUDIT_FAILURE", message: "Explicit failure" }, meta: { request_id: "auth-audit-failure" } };
  await assert.rejects(api.authAuditLog("opaque_A1"), (error) => error instanceof CApiError && error.status === responseStatus && error.requestId === "auth-audit-failure");
}
status = 200; body = { data: [], error: { code: "NOT_SUCCESS" }, meta: { request_id: "invalid" } };
await assert.rejects(api.authAuditLogs(), (error) => error instanceof CApiError && error.code === "INVALID_API_RESPONSE");
assert.ok(requests.every((entry) => entry.method === "GET"));
console.log("C authentication audit client: 19 contract assertions passed.");
