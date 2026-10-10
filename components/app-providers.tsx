"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { setFormatLocale } from "@/lib/utils";
import { authClient, type SessionDTO } from "@/lib/api/auth-client";

type AppContextValue = {
  session: SessionDTO | null;
  switchLocale: (locale: Locale) => Promise<void>;
  localeSwitchError: string | null;
};

const AppContext = createContext<AppContextValue | null>(null);

/**
 * 公共 Provider：i18n / Query / 会话上下文；不读取业务工作区。
 * 语言切换：写入 gp_locale Cookie（服务端写入），已登录时同步账户偏好；保留当前 URL、步骤与未保存输入。
 */
export function AppProviders({
  locale,
  messages,
  timeZone,
  session,
  children,
}: {
  locale: string;
  messages: Record<string, unknown>;
  timeZone: string;
  session?: SessionDTO | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [localeSwitchError, setLocaleSwitchError] = useState<string | null>(null);
  setFormatLocale(locale);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false } } }),
  );

  const switchLocale = useCallback(
    async (next: Locale) => {
      setLocaleSwitchError(null);
      // 1) 本浏览器显式选择：服务端写入 gp_locale Cookie（白名单值）
      const response = await fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!response.ok) {
        setLocaleSwitchError("common.language.syncFailed");
        return;
      }
      // 2) RootLayout 不保证传入会话；以当前 Cookie 查询结果决定是否同步账号偏好。
      // 注册验证/改密可能已轮换 Cookie，不能依赖布局初始 CSRF。
      try {
        const current = await authClient.session();
        if (current.authenticated && current.csrfToken) {
          const pref = await fetch("/api/v1/me/preferences", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": current.csrfToken },
            body: JSON.stringify({ preferredLocale: next }),
          });
          if (!pref.ok) setLocaleSwitchError("common.language.syncFailed");
        }
      } catch {
        setLocaleSwitchError("common.language.syncFailed");
      }
      // 3) 刷新服务端文案；保持当前 URL/query/步骤与客户端状态（不重挂载表单）
      router.refresh();
    },
    [router],
  );

  return (
    <AppContext.Provider value={{ session: session ?? null, switchLocale, localeSwitchError }}>
      <NextIntlClientProvider locale={normalizeLocale(locale) ?? "zh-Hans"} timeZone={timeZone} messages={messages}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProviders");
  return context;
}

export function useSession(): SessionDTO | null {
  return useApp().session;
}
