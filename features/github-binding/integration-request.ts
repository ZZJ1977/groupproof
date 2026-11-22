import { fetchWithSession } from "@/lib/api/client";

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
      payload?.error?.message ?? "暂时无法读取操作结果，请重试。",
      payload?.error?.code,
      githubInstallLink(payload?.error?.details?.install_url),
    );
  }
  return payload.data;
}

export function integrationErrorText(error: unknown, provider: string, action: "read" | "write") {
  if (!(error instanceof ProjectRequestError)) return "网络异常，请稍后重试。";
  if (error.status === 401) return "请重新登录后重试。";
  if (error.code === "PROJECT_READ_ONLY") return "该项目已归档、定稿或所在课程已结束，只能查看绑定。";
  if (error.status === 403) return action === "read" ? "当前没有查看该项目绑定的权限。" : "只有本项目组长可以管理绑定。";
  if (error.status === 404) return "项目不存在或当前没有访问权限。";
  if (error.status === 503) return provider + " 暂时不可用。请检查服务配置后重试。";
  return error.message;
}
