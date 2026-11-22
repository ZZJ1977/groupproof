/**
 * 站内 returnTo 校验（纯函数，客户端/服务端共用）。
 * 只允许站内业务路径；排除认证、个人中心与 API 前缀，防止开放跳转与回环。
 */
export function sanitizeReturnTo(pathnameWithQuery: string): string | null {
  const candidate = pathnameWithQuery.trim();
  const origin = "https://groupproof.invalid";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\\\s]/.test(candidate)) return null;
  let path: string;
  try {
    const url = new URL(candidate, origin);
    if (url.origin !== origin) return null;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.startsWith("//") || /[\\\s]/.test(decoded)) return null;
    path = new URL(decoded, origin).pathname;
  } catch {
    return null;
  }
  for (const prefix of ["/api", "/login", "/account", "/onboarding", "/register", "/reset-password"]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return null;
  }
  return candidate;
}

/** 从当前地址查询参数解析安全回跳目标；无效或缺失返回 null（回退业务首页）。 */
export function returnTargetFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("returnTo");
  return value ? sanitizeReturnTo(value) : null;
}
