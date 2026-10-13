import http from "node:http";
const receipts = new Map();

// Isolated test process; never imported by either production API or the web app.
// No credentials or real user data. Bind only to loopback on a dedicated port.
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/healthz") return response.end('{"status":"ok"}');
  if (request.url === "/api/v1/c-test/proxy-command") {
    // Transport fixture: the real Next proxy must forward required command/auth headers.
    if (request.headers.cookie !== "gp_session=transport-fixture" || request.headers["x-csrf-token"] !== "fixture-csrf") {
      response.statusCode = 403;
      return response.end(JSON.stringify({ error: { code: "FORBIDDEN" }, meta: { request_id: "proxy-fixture" } }));
    }
    const key = request.headers["idempotency-key"];
    if (!key) { response.statusCode = 422; return response.end('{"error":{"code":"MISSING_KEY"}}'); }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const previous = receipts.get(key);
      if (previous && previous.body !== body) { response.statusCode = 409; return response.end('{"error":{"code":"IDEMPOTENCY_CONFLICT"}}'); }
      const receipt = previous ?? { id: receipts.size + 1, body, key };
      receipts.set(key, receipt);
      response.setHeader("Set-Cookie", ["gp_fixture=one; HttpOnly", "gp_fixture_second=two; HttpOnly"]);
      response.end(JSON.stringify({ data: receipt, meta: { request_id: "proxy-fixture" } }));
    });
    return;
  }
  if (request.url === "/api/v1/auth/session") return response.end(JSON.stringify({
    authenticated: true,
    sessionScope: "full",
    accountState: "active",
    canEnterWorkspace: true,
    user: { id: "c-url-fixture", name: "C test", preferredLocale: "zh-Hans" },
  }));
  response.statusCode = 404;
  response.end('{"code":"NOT_FOUND"}');
});
server.listen(18006, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
