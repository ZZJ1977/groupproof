"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { authClient, type SessionDTO } from "@/lib/api/auth-client";

/**
 * 个人中心会话上下文：服务端渲染下发初始会话，客户端在会话轮换（登入/改密/验证）后
 * 同步新 Cookie 对应的新 CSRF/状态，避免继续用已失效的旧 CSRF 写操作。
 */
interface AccountSessionValue {
  session: SessionDTO;
  setSession: (session: SessionDTO) => void;
  refreshSession: () => Promise<SessionDTO>;
}

const AccountSessionContext = createContext<AccountSessionValue | null>(null);

export function AccountSessionProvider({
  session,
  setSession,
  children,
}: {
  session: SessionDTO;
  setSession: (session: SessionDTO) => void;
  children: ReactNode;
}) {
  const refreshSession = useCallback(async () => {
    // GET 使用浏览器当前 HttpOnly Cookie，不依赖可能已经失效的旧 CSRF。
    const current = await authClient.session();
    setSession(current);
    return current;
  }, [setSession]);
  return <AccountSessionContext.Provider value={{ session, setSession, refreshSession }}>{children}</AccountSessionContext.Provider>;
}

export function useAccountSession(): AccountSessionValue {
  const value = useContext(AccountSessionContext);
  if (!value) throw new Error("useAccountSession 必须在 AccountShell 内使用");
  return value;
}
