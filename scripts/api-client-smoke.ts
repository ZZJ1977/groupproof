import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client";

const requests: Request[] = [];
const client = createApiClient({
  baseUrl: "https://api.example.test",
  fetch: async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ service: "api", status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  },
});

const result = await client.GET("/healthz");
assert.equal(result.data?.status, "ok");
assert.equal(requests[0]?.url, "https://api.example.test/healthz");
assert.equal(requests[0]?.credentials, "include");

console.log("Generated API client request passed");
