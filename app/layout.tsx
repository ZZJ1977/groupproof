import type { Metadata } from "next";
import { getLocale, getMessages, getTimeZone } from "next-intl/server";
import { AppProviders } from "@/components/app-providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "GroupProof",
  description: "以证据为核心的小组项目协作平台",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 请求级 locale（Cookie > 账户偏好 > Accept-Language > zh-Hans），服务端与客户端一致，避免闪烁
  const locale = await getLocale();
  const messages = await getMessages();
  const timeZone = await getTimeZone();
  return (
    <html lang={locale}>
      <body>
        <AppProviders locale={locale} messages={messages} timeZone={timeZone ?? "Asia/Macau"}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
