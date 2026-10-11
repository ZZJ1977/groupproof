import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client.ts";
import { CApiError, createCClient } from "../lib/api/c-client.ts";

const requests = [];
let nextResponse = { status: 200, body: { data: { id: "test-evidence" }, meta: { request_id: "req-test" } } };
const client = createCClient(createApiClient({
  baseUrl: "http://127.0.0.1:8001",
  fetch: async (request) => {
    requests.push(request.clone());
    return Response.json(nextResponse.body, { status: nextResponse.status });
  },
}));
const id = "00000000-0000-0000-0000-000000000001";
const command = { task_id: id, title: "Test", description: "Manual source", source_type: "manual", criterion_ids: [id] };
await client.addEvidence(id, command, "retry-key");
await client.addEvidence(id, command, "retry-key");
assert.equal(requests[0].headers.get("Idempotency-Key"), "retry-key");
assert.equal(requests[1].headers.get("Idempotency-Key"), "retry-key");
assert.equal(requests[0].headers.get("X-Demo-User-Id"), null);
assert.equal(requests[0].credentials, "include");
assert.deepEqual(await requests[0].json(), command);
await client.evidence(id, { author_id: id, criterion_id: id, q: "验收", page: 2, page_size: 10 });
const query = new URL(requests[2].url).searchParams;
assert.equal(query.get("q"), "验收");
assert.equal(query.get("page"), "2");
assert.equal(query.get("author_id"), id);
assert.equal(query.get("criterion_id"), id);
nextResponse = { status: 409, body: { error: { code: "VERSION_CONFLICT", message: "已被别人修改，请刷新", details: {} }, meta: { request_id: "conflict-1" } } };
await assert.rejects(client.start(id, 1), (error) => error instanceof CApiError && error.code === "VERSION_CONFLICT" && error.status === 409 && error.requestId === "conflict-1");
nextResponse = { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "请登录" }, meta: {} } };
await assert.rejects(client.execution(id), (error) => error instanceof CApiError && error.code === "UNAUTHENTICATED");
nextResponse = { status: 503, body: { detail: "upstream unavailable" } };
await assert.rejects(client.note(id, id), (error) => error instanceof CApiError && error.code === "INVALID_API_RESPONSE");
for (const body of [null, { status: "ok" }, { error: { code: "FALSE_SUCCESS" } }, { data: {} }, []]) {
  nextResponse = { status: 200, body };
  await assert.rejects(client.execution(id), (error) => error instanceof CApiError && error.code === "INVALID_API_RESPONSE" && error.status === 200);
}
nextResponse = { status: 200, body: { data: null, meta: { request_id: "no-note" } } };
assert.equal(await client.note(id, id), null);
console.log("C generated API client: 18 contract assertions passed");
