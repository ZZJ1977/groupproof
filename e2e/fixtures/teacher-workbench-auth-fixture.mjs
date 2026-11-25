import http from "node:http";

const port = Number(process.env.TW_AUTH_PORT || 18009);

const ACTORS = {
  teacher: {
    authenticated: true,
    csrfToken: "tw-csrf-teacher",
    sessionScope: "full",
    authMethod: "password",
    accountState: "active",
    loginEmailVerified: true,
    identityConfirmed: true,
    securityComplete: true,
    requiredCompletedCount: 3,
    canEnterWorkspace: true,
    nextAction: { type: "workspace", href: "/teacher/dashboard" },
    user: {
      id: "00000000-0000-0000-0000-000000000101",
      name: "张老师",
      preferredLocale: "zh-Hans",
    },
  },
  ta: {
    authenticated: true,
    csrfToken: "tw-csrf-ta",
    sessionScope: "full",
    authMethod: "password",
    accountState: "active",
    loginEmailVerified: true,
    identityConfirmed: true,
    securityComplete: true,
    requiredCompletedCount: 3,
    canEnterWorkspace: true,
    nextAction: { type: "workspace", href: "/teacher/dashboard" },
    user: {
      id: "00000000-0000-0000-0000-000000000102",
      name: "陈助教",
      preferredLocale: "zh-Hans",
    },
  },
  student: {
    authenticated: true,
    csrfToken: "tw-csrf-student",
    sessionScope: "full",
    authMethod: "password",
    accountState: "active",
    loginEmailVerified: true,
    identityConfirmed: true,
    securityComplete: true,
    requiredCompletedCount: 3,
    canEnterWorkspace: true,
    nextAction: { type: "workspace", href: "/home" },
    user: {
      id: "00000000-0000-0000-0000-000000000201",
      name: "李同学",
      preferredLocale: "zh-Hans",
    },
  },
  outsider: {
    authenticated: true,
    csrfToken: "tw-csrf-outsider",
    sessionScope: "full",
    authMethod: "password",
    accountState: "active",
    loginEmailVerified: true,
    identityConfirmed: true,
    securityComplete: true,
    requiredCompletedCount: 3,
    canEnterWorkspace: true,
    nextAction: { type: "workspace", href: "/home" },
    user: {
      id: "00000000-0000-0000-0000-000000000299",
      name: "王旁听",
      preferredLocale: "zh-Hans",
    },
  },
  anonymous: {
    authenticated: false,
  },
};

function parseCookies(cookieHeader) {
  const result = Object.create(null);
  if (!cookieHeader) return result;
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

// Isolated loopback auth fixture for TW_E2E_MODE=mock. Never used in production.
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/healthz") {
    response.statusCode = 200;
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname === "/api/v1/auth/session") {
    const cookies = parseCookies(request.headers.cookie);
    const actor = cookies.gp_tw_actor;
    const payload =
      actor && Object.hasOwn(ACTORS, actor) ? ACTORS[actor] : ACTORS.teacher;
    response.statusCode = 200;
    response.end(JSON.stringify(payload));
    return;
  }

  response.statusCode = 404;
  response.end(
    JSON.stringify({
      error: {
        code: "NOT_FOUND",
        message: `Unhandled path in auth fixture: ${url.pathname}`,
        details: null,
      },
      meta: { request_id: "tw-auth-fixture" },
    }),
  );
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
