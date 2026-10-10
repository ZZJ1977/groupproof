/**
 * 站内 returnTo 校验（纯函数，客户端/服务端共用）。
 * 只允许站内业务路径；排除认证、个人中心与 API 前缀，防止开放跳转与回环。
 */
export function sanitizeReturnTo(pathnameWithQuery: string): string | null {
  if (!pathnameWithQuery.startsWith("/") || pathnameWithQuery.startsWith("//") || pathnameWithQuery.includes("\\")) return null;
  const path = pathnameWithQuery.split("?")[0];
  for (const prefix of ["/api", "/login", "/account", "/onboarding"]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return null;
  }
  return pathnameWithQuery;
}

/** 从当前地址查询参数解析安全回跳目标；无效或缺失返回 null（回退业务首页）。 */
export function returnTargetFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("returnTo");
  return value ? sanitizeReturnTo(value) : null;
}
