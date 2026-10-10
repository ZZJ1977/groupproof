/**
 * 仅服务端可用的会话读取与页面门禁。
 * 页面守卫在业务 Provider 挂载前执行；FastAPI 仍对每个业务请求独立鉴权。
 */
import { cookies } from "next/headers";
import type { SessionDTO } from "@/lib/api/auth-client";

export { sanitizeReturnTo } from "@/lib/auth/return-to";

export type AuthLookup = { ok: true; session: SessionDTO } | { ok: false };

export async function getAuthSession(): Promise<AuthLookup> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const base = (process.env.API_INTERNAL_URL ?? "http://localhost:8000").replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/v1/auth/session`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!response.ok) return { ok: false };
    try {
      return { ok: true, session: (await response.json()) as SessionDTO };
    } catch {
      // 代理/传输截断等异常：不推断放行，页面显示可重试的服务不可用（不得 SSR 崩成空页）
      return { ok: false };
    }
  } catch {
    // 认证服务不可用：不推断放行，页面显示可重试的服务不可用
    return { ok: false };
  }
}
