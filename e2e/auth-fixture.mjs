import http from "node:http";

// Test-only authentication contract. Never imported by runtime services.
// Anonymous by default; account-page tests explicitly opt in through a loopback cookie.
const server = http.createServer((request, response) => {
  const path = request.url?.split("?")[0];
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (path === "/healthz") return response.end(JSON.stringify({ status: "ok" }));
  if (path === "/api/v1/auth/session") {
    const accountFixture = request.headers.cookie?.split("; ").includes("gp_account_fixture=onboarding");
    return response.end(JSON.stringify(accountFixture ? {
      authenticated: true,
      csrfToken: "account-fixture-csrf",
      sessionScope: "onboarding",
      accountState: "profile_required",
      canEnterWorkspace: false,
      authMethod: "password",
      user: { id: "account-fixture", name: "原有同学", preferredLocale: "zh-Hans" },
    } : { authenticated: false }));
  }
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
