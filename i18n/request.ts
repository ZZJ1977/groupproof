import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { defaultLocale, normalizeLocale, pickLocaleFromAcceptLanguage, type Locale } from "./config";

/**
 * 请求级 locale 解析（§8.2 固定优先级）：
 * 显式语言 Cookie（gp_locale） > 账户 preferredLocale（登录同步写入 Cookie） > Accept-Language > zh-Hans
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const explicit = normalizeLocale(cookieStore.get("gp_locale")?.value);
  const locale: Locale = explicit ?? pickLocaleFromAcceptLanguage(headerStore.get("accept-language"));
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: "Asia/Macau",
  };
});
