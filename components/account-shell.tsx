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
const pageWidth = "mx-auto w-full max-w-[1160px] px-4 sm:px-8";

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
    <div className="min-h-screen bg-[var(--gp-canvas)]">
      <header className="border-b border-border bg-white">
        <div className={`${pageWidth} flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2`}>
        <Link href="/account" className="text-xl font-bold tracking-tight">GroupProof</Link>
        <div className="flex items-center gap-1 sm:gap-2">
          <LanguageSwitcher compact />
          <span className="hidden items-center gap-2 px-2 text-[12px] text-[#53637d] sm:inline-flex"><Avatar name={displayName} size={28} />{displayName}</span>
          <Button variant="ghost" size="sm" onClick={() => void logout()} loading={loggingOut}>
            <LogOut size={15} />{t("logout")}
          </Button>
        </div>
        </div>
      </header>
      <main className={`${pageWidth} pb-12 pt-6 sm:pt-8`}>
        <RegistrationNavigation screen={screen} />
        <div className="mt-8 min-w-0 sm:mt-10">{children}</div>
      </main>
    </div>
  );
}

/** 紧凑进度导航：与新版注册共用内容宽度，完成状态仍由服务端事实派生。 */
function RegistrationNavigation({ screen }: { screen: number }) {
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
    <section aria-label={t("steps.title")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-[var(--gp-ink-soft)]">{session.accountState === "active" ? t("menuAccount") : t("steps.title")}</h2>
        <ProgressStatusChip statusKey={progress.statusKey} statusTone={progress.statusTone} />
      </div>
      <nav aria-label={t("menuAccount")}>
      <ol className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {STEPS.map((step) => {
          const stage = progress.stages.find((item) => item.id === step.id);
          const selected = step.screen === screen;
          const Icon = stage?.complete ? CheckCircle2 : step.icon;
          return (
            <li key={step.href}>
              <Link
                href={step.href}
                aria-current={selected ? "page" : undefined}
                className={cn("flex h-full min-h-20 items-center gap-3 rounded-xl border p-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:p-4",
                  selected ? "border-primary bg-[var(--gp-action-soft)]" : "border-border bg-white hover:bg-slate-50")}
                data-tone={stage?.tone ?? "unknown"}
              >
                <span className={cn("hidden size-9 shrink-0 place-items-center rounded-full sm:grid", stage?.complete ? "bg-teal-50 text-[var(--gp-success)]" : "bg-slate-100 text-[var(--gp-ink-soft)]")} aria-hidden="true"><Icon size={18} /></span>
                <span className="min-w-0 text-sm">
                  <span className="block font-medium text-[var(--gp-ink)]">{t(`steps.${step.labelKey}`)}</span>
                  <span className={cn("mt-1 block text-xs", stage?.complete ? "text-[var(--gp-success)]" : "text-[var(--gp-ink-soft)]")}>
                    {step.optional ? t("progress.optionalTag") : stage?.stateKey ? t(`progress.${stage.stateKey}`) : ""}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      </nav>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--gp-ink-soft)]">
        {progress.loadFailed && (
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RotateCw size={13} />{t("progress.retry")}
          </Button>
        )}
        {progress.canEnter && <Button
          className="ml-auto"
          size="sm"
          disabled={!progress.canEnter || entering}
          aria-busy={entering || undefined}
          onClick={() => void enter()}
        >
          {entering ? t("progress.entering") : t("progress.enter")}
        </Button>}
        {!progress.canEnter && !progress.loading && !progress.loadFailed && (
          <p className="text-xs leading-5">
            {t("progress.missingPrefix")}{missingLabels.join(t("progress.listSeparator"))}
          </p>
        )}
        {progress.loginEmailPending && (
          <p className="text-xs leading-5 text-[var(--gp-warning)]">
            {t("progress.loginEmailHint")}{" "}
            <Link href="/account/security" className="gp-link">{t("steps.security")}</Link>
          </p>
        )}
        {enterError && <p className="basis-full text-sm leading-5 text-[var(--gp-danger)]" role="alert">{enterError}</p>}
      </div>
    </section>
  );
}
