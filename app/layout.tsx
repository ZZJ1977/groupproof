import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GroupProof",
  description: "以证据为核心的小组项目协作平台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
