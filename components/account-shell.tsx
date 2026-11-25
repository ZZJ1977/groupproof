"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, CheckCircle2, LogOut, Mail, RotateCw, ShieldCheck, UserRound } from "lucide-react";
import { Avatar } from "@/components/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { AccountSessionProvider, useAccountSession } from "@/components/account-session";
import { authClient, ApiError, type SessionDTO } from "@/lib/api/auth-client";
import { useMe } from "@/features/account/use-me";
import { deriveProgress, ProgressStatusChip } from "@/features/account/registration-progress";
import { returnTargetFromSearch } from "@/lib/auth/return-to";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "profile", icon: UserRound, href: "/account/profile", labelKey: "profile", shortKey: "profile", screen: 101, optional: false },
  { id: "email", icon: Mail, href: "/account/email", labelKey: "email", shortKey: "email", screen: 102, optional: false },
  { id: "identity", icon: CheckCircle2, href: "/account/status", labelKey: "review", shortKey: "reviewShort", screen: 103, optional: false },
  { id: "security", icon: ShieldCheck, href: "/account/security", labelKey: "security", shortKey: "security", screen: 104, optional: true },
] as const;
const pageWidth = "mx-auto w-full max-w-[1160px] px-4 sm:px-6";

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
        <div className={`${pageWidth} flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5`}>
          <Link href="/home" className="text-lg font-bold tracking-tight text-[var(--gp-ink)] hover:text-primary">
            GroupProof
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <LanguageSwitcher compact />
            <span className="hidden items-center gap-2 px-2 text-xs text-[#53637d] sm:inline-flex">
              <Avatar name={displayName} size={26} />
              {displayName}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void logout()} loading={loggingOut}>
              <LogOut size={14} />{t("logout")}
            </Button>
          </div>
        </div>
      </header>
      <main className={`${pageWidth} pb-8 pt-4 sm:pt-5`}>
        <RegistrationNavigation screen={screen} />
        <div className="mt-4 min-w-0">{children}</div>
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

  const isActiveWorkspace = session.accountState === "active" && session.sessionScope === "full";

  if (isActiveWorkspace) {
    return (
      <section aria-label={t("menuAccount")} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border bg-white px-3.5 py-2 shadow-2xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("menuAccount")}</h2>
            <ProgressStatusChip statusKey={progress.statusKey} statusTone={progress.statusTone} />
          </div>
          <nav aria-label={t("menuAccount")} className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100/90 p-1">
            {STEPS.map((step) => {
              const selected = step.screen === screen;
              return (
                <Link
                  key={step.href}
                  href={step.href}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    selected
                      ? "bg-white font-semibold text-[var(--gp-action)] shadow-2xs"
                      : "text-[var(--gp-ink-soft)] hover:text-[var(--gp-ink)]",
                  )}
                >
                  {t(`steps.${step.shortKey}`)}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2">
            {progress.loadFailed && (
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                <RotateCw size={13} />{t("progress.retry")}
              </Button>
            )}
            <Link href="/home" className={buttonVariants({ size: "sm" })}>
              <ArrowLeft size={14} aria-hidden="true" />
              {t("backToHome")}
            </Link>
          </div>
        </div>
        {progress.loginEmailPending && (
          <p className="text-xs leading-5 text-[var(--gp-warning)]">
            {t("progress.loginEmailHint")}{" "}
            <Link href="/account/security" className="gp-link">{t("steps.security")}</Link>
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-label={t("steps.title")}>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="text-sm font-medium text-[var(--gp-ink-soft)]">{t("steps.title")}</h2>
        <ProgressStatusChip statusKey={progress.statusKey} statusTone={progress.statusTone} />
      </div>
      <nav aria-label={t("menuAccount")}>
      <ol className="grid grid-cols-2 gap-2 sm:gap-2.5 lg:grid-cols-4">
        {STEPS.map((step) => {
          const stage = progress.stages.find((item) => item.id === step.id);
          const selected = step.screen === screen;
          const Icon = stage?.complete ? CheckCircle2 : step.icon;
          return (
            <li key={step.href}>
              <Link
                href={step.href}
                aria-current={selected ? "page" : undefined}
                className={cn("gp-stage-row flex h-full min-h-14 items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  selected ? "border-primary bg-[var(--gp-action-soft)]" : "border-border bg-white hover:bg-slate-50")}
                data-tone={stage?.tone ?? "unknown"}
              >
                <span className={cn("hidden size-8 shrink-0 place-items-center rounded-full sm:grid", stage?.complete ? "bg-teal-50 text-[var(--gp-success)]" : "bg-slate-100 text-[var(--gp-ink-soft)]")} aria-hidden="true"><Icon size={16} /></span>
                <span className="min-w-0 text-xs">
                  <span className="block font-semibold text-[var(--gp-ink)]">{t(`steps.${step.labelKey}`)}</span>
                  <span className={cn("gp-stage-state mt-0.5 block text-[11px]", stage?.complete ? "text-[var(--gp-success)]" : "text-[var(--gp-ink-soft)]")}>
                    {step.optional ? t("progress.optionalTag") : stage?.stateKey ? t(`progress.${stage.stateKey}`) : ""}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      </nav>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2.5 text-sm text-[var(--gp-ink-soft)]">
        {progress.loadFailed && (
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RotateCw size={13} />{t("progress.retry")}
          </Button>
        )}
        {progress.canEnter && <Button
          className="gp-enter-button ml-auto"
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
