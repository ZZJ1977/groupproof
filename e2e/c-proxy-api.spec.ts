import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Real HTTP requests through Next to the isolated upstream fixture; no page.route interception.
// Business-side authorization/persistence is covered separately by FastAPI tests.
test("C commands retain idempotency, cookies, CSRF, receipt and conflict through Next", async ({ request }) => {
  const headers = { Cookie: "gp_session=transport-fixture", "X-CSRF-Token": "fixture-csrf", "Idempotency-Key": randomUUID() };
  const path = "/api/v1/c-test/proxy-command", data = { reason: "来源变动检查", expected_version: 0 };
  const first = await request.post(path, { headers, data });
  expect(first.status()).toBe(200);
  const receipt = await first.json();
  expect(receipt.data.key).toBe(headers["Idempotency-Key"]);
  expect(JSON.parse(receipt.data.body)).toEqual(data);
  expect(first.headers()["cache-control"]).toBe("private, no-store");
  expect(first.headersArray().filter((header) => header.name.toLowerCase() === "set-cookie")).toHaveLength(2);
  const retry = await request.post(path, { headers, data });
  expect(retry.status()).toBe(200); expect(await retry.json()).toEqual(receipt);
  const conflict = await request.post(path, { headers, data: { ...data, expected_version: 1 } });
  expect(conflict.status()).toBe(409);
});

test("C proxy preserves denied and missing command-header errors", async ({ request }) => {
  const path = "/api/v1/c-test/proxy-command";
  expect((await request.post(path, { data: {}, headers: { "Idempotency-Key": randomUUID() } })).status()).toBe(403);
  expect((await request.post(path, { data: {}, headers: { Cookie: "gp_session=transport-fixture", "X-CSRF-Token": "fixture-csrf" } })).status()).toBe(422);
});
