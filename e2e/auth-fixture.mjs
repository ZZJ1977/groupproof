import http from "node:http";

// Test-only anonymous authentication contract. Never imported by runtime services.
const server = http.createServer((request, response) => {
  const path = request.url?.split("?")[0];
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (path === "/healthz") return response.end(JSON.stringify({ status: "ok" }));
  if (path === "/api/v1/auth/session") return response.end(JSON.stringify({ authenticated: false }));
  if (path === "/api/v1/auth/capabilities") return response.end(JSON.stringify({
    google: { enabled: false, available: false },
    password: { enabled: true, available: true },
    emailSignup: { enabled: true, available: true },
    passwordReset: { enabled: true, available: true },
    schoolEmailVerification: { enabled: true, available: true },
    acceptanceTest: { enabled: false },
  }));
  response.statusCode = 401;
  response.end(JSON.stringify({ code: "UNAUTHENTICATED" }));
});
server.listen(18005, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
