import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client.ts";
import { CApiError, createCClient } from "../lib/api/c-client.ts";

const requests = [];
let token = "session-one";
let sessionResponse = () => Response.json({ data: { authenticated: true, csrfToken: token } });
const client = createCClient(createApiClient({ baseUrl: "http://127.0.0.1:8001", fetch: async (request) => {
  requests.push(request.clone());
  return new URL(request.url).pathname === "/api/v1/auth/session"
    ? sessionResponse()
    : Response.json({ data: { id: "saved" }, meta: { request_id: "session-contract" } });
} }));
const id = "00000000-0000-0000-0000-000000000001";

await client.execution(id);
assert.equal(requests.length, 1, "reads must not fetch another session");
assert.equal(requests[0].headers.has("X-CSRF-Token"), false);
for (const next of ["session-one", "session-after-rotation"]) {
  token = next;
  await client.prepareSubmission(id, { expected_version: 0 }, "same-command-key");
  const [lookup, write] = requests.slice(-2);
  assert.equal(new URL(lookup.url).pathname, "/api/v1/auth/session");
  assert.equal(lookup.cache, "no-store");
  assert.equal(lookup.credentials, "include");
  assert.equal(write.headers.get("X-CSRF-Token"), next);
  assert.equal(write.headers.get("Idempotency-Key"), "same-command-key");
  assert.equal(write.credentials, "include");
  assert.deepEqual(await write.json(), { expected_version: 0 });
}

for (const [response, expectedStatus, expectedCode] of [
  [() => Response.json({ data: { authenticated: false } }), 401, "UNAUTHENTICATED"],
  [() => Response.json({ data: { authenticated: true } }), 401, "UNAUTHENTICATED"],
  [() => Response.json({ data: { authenticated: true, csrfToken: "" } }), 401, "UNAUTHENTICATED"],
  [() => Response.json({ data: null }), 503, "AUTH_SESSION_UNAVAILABLE"],
  [() => new Response("bad gateway"), 503, "AUTH_SESSION_UNAVAILABLE"],
  [() => Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }), 401, "UNAUTHENTICATED"],
  [() => Response.json({ error: { code: "AUTH_DOWN" } }, { status: 503 }), 503, "AUTH_DOWN"],
]) {
  sessionResponse = response;
  const count = requests.length;
  await assert.rejects(client.start(id, 0), (error) => error instanceof CApiError && error.status === expectedStatus && error.code === expectedCode);
  assert.equal(requests.length, count + 1, "a failed session lookup must never send a write");
}
sessionResponse = () => { throw new TypeError("network unavailable"); };
const beforeNetworkFailure = requests.length;
await assert.rejects(client.start(id, 0), /network unavailable/);
assert.equal(requests.length, beforeNetworkFailure + 1);
console.log("C session transport: rotation, command preservation and closed failures passed.");
