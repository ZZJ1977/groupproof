import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // 开发与生产构建使用独立输出目录，避免切换时 vendor-chunks 冲突（可重复启动，无需清理缓存）
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    // 同源代理：浏览器统一访问 /api/v1/*，转发到 FastAPI（含 Cookie）；不提供“信任任意 X-User-Id”捷径
    const apiInternal = process.env.API_INTERNAL_URL ?? "http://localhost:8000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiInternal.replace(/\/$/, "")}/api/v1/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
