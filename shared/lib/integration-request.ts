import { apiErrorCodeText, apiErrorText } from "@/shared/i18n/api-error-text";
import { fetchWithSession } from "@/shared/lib/api-client";

export class ProjectRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly installUrl?: string,
  ) {
    super(message);
  }
}

type Envelope<T> = {
  data?: T;
  error?: { code?: string; message?: string; details?: { install_url?: string } };
};

function githubInstallLink(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    if (url.origin === "https://github.com" && !url.username && !url.password && /^\/apps\/[\w-]+\/installations\/new$/.test(url.pathname)) {
      return url.href;
    }
  } catch {
    return undefined;
  }
}

export async function projectRequest<T>(path: string, options: {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const { method = "GET", body, signal } = options;
  const response = await fetchWithSession(new Request(new URL(path, window.location.origin), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
  }));
  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || !payload || payload.data === undefined) {
    throw new ProjectRequestError(
      response.status,
      payload?.error?.message ?? apiErrorCodeText("INTEGRATION_READ_FAILED"),
      payload?.error?.code,
      githubInstallLink(payload?.error?.details?.install_url),
    );
  }
  return payload.data;
}

export function integrationErrorText(error: unknown, provider: string, action: "read" | "write") {
  if (!(error instanceof ProjectRequestError)) return apiErrorCodeText("INTEGRATION_NETWORK_ERROR");
  if (error.status === 401) return apiErrorCodeText("INTEGRATION_AUTH_REQUIRED");
  if (error.code === "PROJECT_READ_ONLY") return apiErrorCodeText("INTEGRATION_READ_ONLY");
  if (error.status === 403) {
    return apiErrorCodeText(action === "read" ? "INTEGRATION_VIEW_DENIED" : "INTEGRATION_LEADER_REQUIRED");
  }
  if (error.status === 404) return apiErrorCodeText("INTEGRATION_PROJECT_NOT_FOUND");
  if (error.status === 503) {
    const key =
      provider === "GitHub"
        ? "INTEGRATION_GITHUB_UNAVAILABLE"
        : provider === "飞书" || provider === "Feishu"
          ? "INTEGRATION_FEISHU_UNAVAILABLE"
          : "INTEGRATION_PROVIDER_UNAVAILABLE";
    return apiErrorCodeText(key);
  }
  return apiErrorText(error);
}
