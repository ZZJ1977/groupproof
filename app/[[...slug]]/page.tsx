import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RouteDispatcher } from "@/features/route-dispatcher";
import { WorkspaceProvider } from "@/lib/workspace";
import { LoginPage } from "@/features/auth/LoginPage";
import { ResetPasswordPage } from "@/features/auth/ResetPasswordPage";
import { AccountShell } from "@/components/account-shell";
import { AccountView } from "@/features/account/AccountView";
import { ServiceUnavailable } from "@/components/common";
import { classifyPath } from "@/lib/routes";
import { getAuthSession, sanitizeReturnTo } from "@/lib/auth/server";
import type { SessionDTO } from "@/lib/api/auth-client";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: "GroupProof", description: t("appName") };
}

/** 受保护页面：守卫先于业务 Provider；未完成注册/待审/停用一律不挂载业务工作区。 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const pathname = slug && slug.length ? `/${slug.join("/")}` : "/";
  const view = typeof query.view === "string" ? query.view : null;
  const entry = classifyPath(pathname, view);

  // 公开页（登录/密码重置）：不加载工作区、不获取任何业务数据
  if (entry.category === "public") {
    return entry.screen === 99 ? <ResetPasswordPage /> : <LoginPage />;
  }

  // 旧 onboarding 链接兼容：统一进入个人中心，由相同门禁控制
  if (entry.category === "alias" && entry.aliasOf) {
    redirect(entry.aliasOf);
  }

  // 未知路由：404，不加载工作区，不用演示账号兜底
  if (entry.category === "unknown") {
    notFound();
  }

  const lookup = await getAuthSession();
  if (!lookup.ok) {
    return <ServiceUnavailable />;
  }
  const session: SessionDTO = lookup.session;
  const returnTarget = sanitizeReturnTo(`${pathname}${flattenQuery(query)}`);

  if (!session.authenticated) {
    redirect(returnTarget ? `/login?returnTo=${encodeURIComponent(returnTarget)}` : "/login");
  }

  if (entry.category === "account") {
    const state = session.accountState ?? "profile_required";
    // /account 入口：跳本人当前步骤；已激活默认到资料页
    if (entry.screen === 100) {
      redirect(state === "active" ? "/account/profile" : (session.nextAction?.href ?? "/account/status"));
    }
    return (
      <AccountShell session={session} screen={entry.screen ?? 101}>
        <AccountView screen={entry.screen ?? 101} />
      </AccountShell>
    );
  }

  // 业务区：仅 active + full 范围会话进入；其他状态按服务端 nextAction 引导
  const state = session.accountState ?? "profile_required";
  if (state !== "active" || session.sessionScope !== "full") {
    const next = session.nextAction?.href ?? "/account/status";
    redirect(next.startsWith("/account") ? next : "/account/status");
  }

  return (
    <WorkspaceProvider user={session.user ?? { id: "unknown", name: null, preferredLocale: "zh-Hans" }}>
      <RouteDispatcher />
    </WorkspaceProvider>
  );
}

function flattenQuery(query: Record<string, string | string[] | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    else if (Array.isArray(value)) for (const item of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
