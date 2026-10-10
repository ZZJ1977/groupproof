"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CheckCircle2, LogOut, Mail, RotateCw, ShieldCheck, UserRound } from "lucide-react";
import { Avatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { AccountSessionProvider, useAccountSession } from "@/components/account-session";
import { authClient, ApiError, type SessionDTO } from "@/lib/api/auth-client";
import { useMe } from "@/features/account/use-me";
import { deriveProgress, ProgressStatusChip } from "@/features/account/registration-progress";
import { returnTargetFromSearch } from "@/lib/auth/return-to";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "profile", icon: UserRound, href: "/account/profile", labelKey: "profile", screen: 101, optional: false },
  { id: "email", icon: Mail, href: "/account/email", labelKey: "email", screen: 102, optional: false },
  { id: "identity", icon: CheckCircle2, href: "/account/status", labelKey: "review", screen: 103, optional: false },
  { id: "security", icon: ShieldCheck, href: "/account/security", labelKey: "security", screen: 104, optional: true },
] as const;

/** 注册受限布局：只有本人资料、语言与退出；不挂载工作区导航、搜索、通知 */
export function AccountShell({ session, screen, children }: { session: SessionDTO; screen: number; children: ReactNode }) {
  // 会话可能在「登入」/改密/验证码验证后轮换：客户端持有最新 CSRF，避免用已失效旧值写操作
  const [liveSession, setLiveSession] = useState(session);
  // router.refresh() 保留客户端状态，须接纳服务端下发的新会话和 CSRF。
  useEffect(() => setLiveSession(session), [session]);
  return (
    <AccountSessionProvider session={liveSession} setSession={setLiveSession}>
      <AccountChrome screen={screen}>{children}</AccountChrome>
    </AccountSessionProvider>
  );
}

function AccountChrome({ screen, children }: { screen: number; children: ReactNode }) {
  const t = useTranslations("account");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useAccountSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const displayName = session.user?.name ?? "—";

  const logout = async () => {
    setLoggingOut(true);
    try {
      await authClient.logout(session.csrfToken);
    } finally {
      // 退出/切换账号后清理缓存，不得沿用上一用户的注册进度
      queryClient.clear();
      window.localStorage.removeItem("groupproof-v1-workspace");
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen bg-[#f6f9fd]">
      <header className="flex h-[65px] items-center justify-between border-b border-[#e7edf5] bg-white px-[max(24px,4vw)]">
        <Link href="/account" className="text-[18px] font-bold text-[#14213b]">GroupProof</Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher compact />
          <span className="hidden items-center gap-2 px-2 text-[12px] text-[#53637d] sm:inline-flex"><Avatar name={displayName} size={28} />{displayName}</span>
          <Button variant="ghost" size="sm" onClick={() => void logout()} loading={loggingOut}>
            <LogOut size={15} />{t("logout")}
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-[1100px] grid-cols-1 gap-8 px-[max(24px,4vw)] py-10 lg:grid-cols-[240px_1fr]">
        <RegistrationSidebar screen={screen} />
        <div className="min-w-0">{children}</div>
      </main>
    </div>
  );
}

/** 注册进度侧栏：阶段底色/图标/文字三通道；状态提示与「登入」按钮共用同一份后端事实 */
function RegistrationSidebar({ screen }: { screen: number }) {
  const t = useTranslations("account");
  const router = useRouter();
  const { session, setSession } = useAccountSession();
  const { data: me, isError, refetch } = useMe(session.user?.id);
  const progress = useMemo(
    () => deriveProgress(me, { isError, authMethod: session.authMethod ?? null }),
    [me, isError, session.authMethod],
  );
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);

  const enter = async () => {
    if (entering || !progress.canEnter) return;
    setEntering(true);
    setEnterError(null);
    try {
      // 服务端重新核验资格，必要时升级/轮换会话并写回新 Cookie + 新 CSRF
      const refreshed = await authClient.refresh(session.csrfToken ?? "");
      setSession(refreshed);
      void refetch();
      if (refreshed.accountState === "active" && refreshed.sessionScope === "full") {
        router.push(returnTargetFromSearch(window.location.search) ?? "/home");
        router.refresh();
        return;
      }
      setEnterError(t("progress.enterBlocked"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.push("/login"); // 会话已失效：引导重新认证
        return;
      }
      const requestId = error instanceof ApiError && error.requestId ? ` (${error.requestId})` : "";
      setEnterError(`${t("progress.enterFailed")}${requestId}`);
    } finally {
      setEntering(false);
    }
  };

  const missingLabels = progress.missingStageIds.map((id) => {
    const step = STEPS.find((item) => item.id === id);
    return step ? t(`steps.${step.labelKey}`) : "";
  });

  return (
    <aside className="self-start rounded-[8px] border border-[#e0e7f0] bg-white p-5">
      <h2 className="text-[13px] font-semibold text-[#14213b]">{t("steps.title")}</h2>
      <ol className="mt-4 space-y-2">
        {STEPS.map((step) => {
          const stage = progress.stages.find((item) => item.id === step.id);
          const selected = step.screen === screen;
          const Icon = stage?.complete ? CheckCircle2 : step.icon;
          return (
            <li key={step.href}>
              <Link
                href={step.href}
                aria-current={selected ? "page" : undefined}
                className={cn("gp-stage-row", selected && "is-current")}
                data-tone={stage?.tone ?? "unknown"}
              >
                <span className="gp-stage-icon" data-tone={stage?.tone ?? "unknown"} aria-hidden="true"><Icon size={14} /></span>
                <span className="gp-stage-label">
                  {t(`steps.${step.labelKey}`)}
                  {step.optional && <span className="gp-stage-tag">{t("progress.optionalTag")}</span>}
                </span>
                <span className="gp-stage-state" data-tone={stage?.tone ?? "unknown"}>
                  {stage?.stateKey ? t(`progress.${stage.stateKey}`) : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <div className="mt-6 space-y-3 border-t border-[#e7edf5] pt-4">
        <ProgressStatusChip statusKey={progress.statusKey} statusTone={progress.statusTone} />
        {progress.loadFailed && (
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RotateCw size={13} />{t("progress.retry")}
          </Button>
        )}
        <Button
          className="gp-enter-button w-full"
          disabled={!progress.canEnter || entering}
          aria-busy={entering || undefined}
          onClick={() => void enter()}
        >
          {entering ? t("progress.entering") : t("progress.enter")}
        </Button>
        {!progress.canEnter && !progress.loading && !progress.loadFailed && (
          <p className="text-[11px] leading-5 text-[#65748b]">
            {t("progress.missingPrefix")}{missingLabels.join(t("progress.listSeparator"))}
          </p>
        )}
        {progress.loginEmailPending && (
          <p className="text-[11px] leading-5 text-[#b45309]">
            {t("progress.loginEmailHint")}{" "}
            <Link href="/account/security" className="gp-link">{t("steps.security")}</Link>
          </p>
        )}
        {enterError && <p className="text-[11px] leading-5 text-[#b91c1c]" role="alert">{enterError}</p>}
      </div>
      {/* 语言选择仅保留页面右上角一处（2026-10-10 验收调整） */}
      <div className="mt-4 text-[11px] text-[#8190a4]">
        <span>{t("menuAccount")}</span>
      </div>
    </aside>
  );
}
