/**
 * 仅服务端可用的会话读取与页面门禁。
 * 页面守卫在业务 Provider 挂载前执行；FastAPI 仍对每个业务请求独立鉴权。
 */
import { cookies } from "next/headers";
import type { SessionDTO } from "@/shared/auth/auth-client";
import { adminApiBase, ADMIN_ENVIRONMENT_COOKIE, normalizeAdminEnvironment } from "@/admin/lib/admin-environment";

export { sanitizeReturnTo } from "@/shared/auth/return-to";

export type AuthLookup = { ok: true; session: SessionDTO } | { ok: false };

export async function getAuthSession(): Promise<AuthLookup> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const environment = normalizeAdminEnvironment(cookieStore.get(ADMIN_ENVIRONMENT_COOKIE)?.value);
  const base = adminApiBase(environment);
  try {
    const response = await fetch(`${base}/api/v1/auth/session`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!response.ok) return { ok: false };
    try {
      const body = (await response.json()) as { data?: SessionDTO } | SessionDTO | null;
      // 团队统一成功封装 {data, meta}；兼容未封装响应
      const session =
        body && typeof body === "object" && "data" in body ? (body as { data: SessionDTO }).data : (body as SessionDTO);
      if (!session) return { ok: false };
      return { ok: true, session };
    } catch {
      // 代理/传输截断等异常：不推断放行，页面显示可重试的服务不可用（不得 SSR 崩成空页）
      return { ok: false };
    }
  } catch {
    // 认证服务不可用：不推断放行，页面显示可重试的服务不可用
    return { ok: false };
  }
}
