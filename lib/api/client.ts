import createClient from "openapi-fetch";
import type { paths } from "@/packages/domain/api.generated";
import { apiConfig } from "@/lib/api/config";

/**
 * Wrap a transport so every write carries the current session's CSRF token.
 * Fetch the session for each write: OAuth, verification and login can rotate
 * its token. Never cache credentials across users or retry a write.
 */
export function createSessionFetch(transport: typeof fetch = (input, init) => fetch(input, init)) {
  return async (input: Request): Promise<Response> => {
    const request = new Request(input);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !request.headers.has("X-CSRF-Token")) {
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
  };
}

export function createApiClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? apiConfig.baseUrl,
    credentials: "include",
    fetch: createSessionFetch(options.fetch),
  });
}

export const apiClient = createApiClient();
