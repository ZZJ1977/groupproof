import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client.ts";
import { CApiError, createCClient } from "../lib/api/c-client.ts";

// HTTP contract fixtures only; this does not claim a production SourcePort is connected.
const requests = [];
let status = 200;
let body = { data: { source_changed: false, lock_version: 2 }, meta: { request_id: "source-check" } };
const client = createCClient(createApiClient({ baseUrl: "http://127.0.0.1:8001", fetch: async (request) => {
  if (new URL(request.url).pathname === "/api/v1/auth/session") return Response.json({ data: { authenticated: true, csrfToken: "source-contract-token" } });
  requests.push(request.clone());
  return Response.json(body, { status });
} }));
const project = "00000000-0000-0000-0000-000000000901";
const evidence = "00000000-0000-0000-0000-000000000902";
const source = "00000000-0000-0000-0000-000000000903";
const input = { source_id: source, expected_version: 2, reason: "核对外部来源修改" };
assert.deepEqual(await client.checkSource(project, evidence, input, "stable-source-key"), body.data);
assert.equal(new URL(requests[0].url).pathname, `/api/v1/projects/${project}/evidence/${evidence}/check-source`);
assert.equal(requests[0].method, "POST");
assert.equal(requests[0].credentials, "include");
assert.equal(requests[0].headers.get("X-Demo-User-Id"), null);
assert.equal(requests[0].headers.get("Idempotency-Key"), "stable-source-key");
assert.deepEqual(await requests[0].json(), input);
for (const [nextStatus, code] of [[503, "EXTERNAL_SOURCE_UNAVAILABLE"], [403, "EVIDENCE_DECISION_DENIED"], [409, "VERSION_CONFLICT"]]) {
  status = nextStatus;
  body = { error: { code, message: "Explicit upstream failure" }, meta: { request_id: "source-failure" } };
  await assert.rejects(client.checkSource(project, evidence, input, "stable-source-key"), (error) => error instanceof CApiError && error.status === nextStatus && error.code === code && error.requestId === "source-failure");
  assert.equal(requests.at(-1).headers.get("Idempotency-Key"), "stable-source-key");
  assert.deepEqual(await requests.at(-1).json(), input);
}
status = 200;
body = { data: { source_changed: true, effective: false }, meta: { request_id: "source-success" } };
assert.deepEqual(await client.checkSource(project, evidence, input, "stable-source-key"), body.data);
await client.replies(project, evidence, 3, 10, source);
assert.equal(new URL(requests.at(-1).url).searchParams.get("focus_reply_id"), source);
assert.equal(new URL(requests.at(-1).url).searchParams.get("page"), "3");
await client.replies(project, evidence);
assert.equal(new URL(requests.at(-1).url).searchParams.has("focus_reply_id"), false);
await client.progressHistory(project, evidence, 2, 10, source);
assert.equal(new URL(requests.at(-1).url).searchParams.get("focus_event_id"), source);
assert.equal(new URL(requests.at(-1).url).searchParams.get("page"), "2");
await client.progressHistory(project, evidence);
assert.equal(new URL(requests.at(-1).url).searchParams.has("focus_event_id"), false);
console.log("C evidence source client: 23 contract assertions passed.");
