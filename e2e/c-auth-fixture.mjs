import http from "node:http";

// Isolated test process; never imported by either production API or the web app.
// No credentials or real user data. Bind only to loopback on a dedicated port.
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/healthz") return response.end('{"status":"ok"}');
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
