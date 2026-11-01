import createClient from "openapi-fetch";
import type { paths } from "@/packages/domain/api.generated";
import { apiConfig } from "@/lib/api/config";

export function createApiClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const transport: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return createClient<paths>({
    baseUrl: options.baseUrl ?? apiConfig.baseUrl,
    credentials: "include",
    fetch: async (input) => {
      const request = new Request(input);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !request.headers.has("X-CSRF-Token")) {
        // Fetch the current session for each write: OAuth, verification and login
        // can rotate its token. Never cache credentials across users or retry a write.
        const sessionResponse = await transport(new Request(new URL("/api/v1/auth/session", request.url), {
          credentials: "include", cache: "no-store", signal: request.signal,
        }));
        if (!sessionResponse.ok) return sessionResponse;
        const payload = await sessionResponse.json().catch(() => null);
        const session = payload?.data ?? payload;
        if (!session || typeof session.authenticated !== "boolean") {
          return Response.json({ error: { code: "AUTH_SESSION_UNAVAILABLE", message: "暂时无法验证会话，请重试。" } }, { status: 503 });
        }
        if (!session.authenticated || typeof session.csrfToken !== "string" || !session.csrfToken) {
          return Response.json({ error: { code: "UNAUTHENTICATED", message: "请重新登录。" } }, { status: 401 });
        }
        request.headers.set("X-CSRF-Token", session.csrfToken);
      }
      return transport(request);
    },
  });
}

export const apiClient = createApiClient();
