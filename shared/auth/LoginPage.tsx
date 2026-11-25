"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Activity, Check, Mail, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/shared/components/ui/dialog";
import { Feedback, ProgressBar } from "@/shared/components/common";
import { LanguageSwitcher } from "@/shared/components/language-switcher";
import { authClient, ApiError, type CapabilitiesDTO, type RegistrationTxDTO, type SessionDTO } from "@/shared/auth/auth-client";
import { sanitizeReturnTo } from "@/shared/auth/return-to";
import { ParticleWordmark } from "@/shared/auth/lux/ParticleWordmark";
import { FloatingField } from "@/shared/components/lux/FloatingField";
import { useUiText } from "@/shared/i18n/use-ui-text";

const FEATURES = [
  { icon: Mail, titleKey: "feature1Title", subKey: "feature1Sub" },
  { icon: Users, titleKey: "feature2Title", subKey: "feature2Sub" },
  { icon: Activity, titleKey: "feature3Title", subKey: "feature3Sub" },
  { icon: ShieldCheck, titleKey: "feature4Title", subKey: "feature4Sub" },
] as const;

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** 统一错误呈现：字段错误/稳定错误码 + 可复制请求编号 + 限流倒计时（由服务端时间推导） */
function useErrorText() {
  const t = useTranslations("auth.passwordLogin");
  return (error: unknown): { message: string; requestId: string | null; retryAfter: number | null } => {
    if (error instanceof ApiError) {
      const firstField = Object.values(error.fieldErrors)[0];
      const key = firstField ? `errors.${firstField}` : `errors.${error.code}`;
      const message = t(t.has(key) ? key : "errors.SERVICE_UNAVAILABLE");
      return { message, requestId: error.requestId, retryAfter: error.retryAfterSeconds };
    }
    return { message: t("errors.SERVICE_UNAVAILABLE"), requestId: null, retryAfter: null };
  };
}

function ErrorNote({ message, requestId, retryAfter }: { message: string; requestId: string | null; retryAfter: number | null }) {
  const t = useTranslations("common");
  return (
    <div role="alert">
      <p className="text-[12px] text-[#e54955]">{message}</p>
      {retryAfter !== null && <p className="mt-1 text-[11px] text-[#c3313f]">{t("retryAfter", { seconds: retryAfter })}</p>}
      {requestId && (
        <p className="mt-1 text-[11px] text-[#8d9aad]">
          {t("requestId")}：<code>{requestId}</code>
        </p>
      )}
    </div>
  );
}

function LoginCard() {
  const t = useTranslations("auth");
  const tp = useTranslations("auth.passwordLogin");
  const tr = useUiText();
  const search = useSearchParams();
  const router = useRouter();
  const locale = useLocale();
  const errorText = useErrorText();
  const [redirecting, setRedirecting] = useState(false);
  const startedRef = useRef(false);
  const error = search.get("error");
  const returnTo = sanitizeReturnTo(search.get("returnTo") ?? "");

  const [caps, setCaps] = useState<CapabilitiesDTO | null>(null);
  const [capsFailed, setCapsFailed] = useState(false);
  useEffect(() => {
    let active = true;
    authClient
      .capabilities()
      .then((value) => active && setCaps(value))
      .catch(() => active && setCapsFailed(true));
    return () => {
      active = false;
    };
  }, []);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loginState, setLoginState] = useState<"idle" | "pending">("idle");
  const [loginError, setLoginError] = useState<{ message: string; requestId: string | null; retryAfter: number | null; code?: string } | null>(null);
  const [loginRetryAt, setLoginRetryAt] = useState<number | null>(null);
  const [loginRetrySeconds, setLoginRetrySeconds] = useState(0);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  useEffect(() => {
    if (loginRetryAt === null) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((loginRetryAt - Date.now()) / 1000));
      setLoginRetrySeconds(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        setLoginRetryAt(null);
        setLoginError((current) => current?.code === "RATE_LIMITED" ? null : current);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loginRetryAt]);

  const goAfterAuth = (session: SessionDTO) => {
    const next = session.accountState === "active" ? (returnTo ?? session.nextAction?.href ?? "/home") : (session.nextAction?.href ?? "/account/profile");
    router.push(next);
    router.refresh();
  };

  const goToRegistrationProfile = (txId: string) => {
    const query = new URLSearchParams({ tx: txId });
    if (returnTo) query.set("returnTo", returnTo);
    router.push(`/register/profile?${query}`);
  };

  // 从 Google 页面按“返回”时浏览器会从 bfcache 恢复本页，按钮必须复位
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        startedRef.current = false;
        setRedirecting(false);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // 开始任何登录动作时清掉 URL 上遗留的 Google 错误，避免红色提示一直挂着
  const [dismissedError, setDismissedError] = useState(false);
  const clearUrlError = () => {
    if (!error) return;
    setDismissedError(true);
    router.replace(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login");
  };

  const startGoogleLogin = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    clearUrlError();
    setRedirecting(true);
    window.location.href = authClient.googleStartUrl(returnTo ?? undefined);
  };

  const submitPasswordLogin = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (loginState === "pending" || (loginRetryAt !== null && Date.now() < loginRetryAt)) return;
    setLoginState("pending");
    setLoginError(null);
    clearUrlError();
    try {
      goAfterAuth(await authClient.passwordLogin(identifier.trim(), password));
    } catch (err) {
      const feedback = errorText(err);
      setLoginError({ ...feedback, code: err instanceof ApiError ? err.code : undefined });
      if (err instanceof ApiError && err.code === "RATE_LIMITED" && feedback.retryAfter !== null && Number.isFinite(feedback.retryAfter) && feedback.retryAfter > 0) {
        setLoginRetryAt(Date.now() + feedback.retryAfter * 1_000);
        setLoginRetrySeconds(Math.ceil(feedback.retryAfter));
      }
      setLoginState("idle");
    }
  };

  const googleLoading = !caps && !capsFailed;
  const showGoogle = !capsFailed && Boolean(caps?.google.available);
  const showSignup = !capsFailed && (!caps || caps.emailSignup.enabled);
  const showForgot = !capsFailed && (!caps || caps.passwordReset.enabled);

  return (
    <section className="gp-rainbow-ring gp-slide-in relative self-start overflow-hidden rounded-[24px] bg-white/90 p-6 shadow-[0_30px_80px_-20px_rgba(36,107,250,0.28),0_8px_24px_-8px_rgba(20,33,59,0.08)] backdrop-blur-xl sm:p-8 lg:mt-2 lg:p-8">
      <h2 className="text-[26px] font-extrabold tracking-tight text-[#14213b]">{t("loginTitle")}</h2>
      <p className="mt-1.5 text-[14px] text-[#718097]">{t("loginSubtitle")}</p>

      {error && !dismissedError && (
        <p className="mt-4 rounded-[7px] bg-[#fdecec] p-3 text-[12px] text-[#c3313f]" role="alert">
          {error === "cancelled" ? t("error.cancelled") : error === "account_exists" ? t("error.accountExists") : error === "unavailable" ? t("error.unavailable") : t("error.failed")}
        </p>
      )}

      {/* 账号密码登录窗口：用户名/邮箱 + 密码 */}
      <h3 className="sr-only">{tp("title")}</h3>
      <form className="mt-5 space-y-3.5 [&_button[type=submit]]:h-12 [&_button[type=submit]]:rounded-[14px] [&_button[type=submit]]:border-0 [&_button[type=submit]]:bg-gradient-to-r [&_button[type=submit]]:from-[#246bfa] [&_button[type=submit]]:to-[#6a4cff] [&_button[type=submit]]:font-semibold [&_button[type=submit]]:shadow-[0_10px_24px_-8px_rgba(36,107,250,0.65)] [&_button[type=submit]]:transition hover:[&_button[type=submit]]:-translate-y-px hover:[&_button[type=submit]]:shadow-[0_14px_28px_-8px_rgba(36,107,250,0.75)]" onSubmit={submitPasswordLogin}>
        <FloatingField
          label={tp("identifier")}
          value={identifier}
          validation="identifier"
          invalidHint={tr("请检查邮箱格式，例如 name@must.edu.mo")}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
              placeholder={tp("identifierPlaceholder")}
              aria-label={tp("identifier")}
            />
          )}
        </FloatingField>
        <FloatingField label={tp("password")} value={password}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              aria-label={tp("password")}
            />
          )}
        </FloatingField>
        {loginError && <ErrorNote {...loginError} retryAfter={loginError.code === "RATE_LIMITED" && loginRetryAt !== null ? loginRetrySeconds : loginError.retryAfter} />}
        <Button type="submit" className="w-full" loading={loginState === "pending"} disabled={loginRetrySeconds > 0}>{tp("submit")}</Button>
      </form>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[12px] text-[#8794a7]">
        {showForgot && (
          <button type="button" className="gp-link whitespace-nowrap" onClick={() => setForgotOpen(true)}>
            {tp("forgotLink")}
          </button>
        )}
        {showForgot && showSignup && <span aria-hidden>·</span>}
        {showSignup && (
          <span className="whitespace-nowrap">
            {tp("noAccount")}
            <button type="button" className="gp-link ml-1" onClick={() => setRegisterOpen(true)}>
              {tp("registerLink")}
            </button>
          </span>
        )}
      </div>
      {capsFailed && (
        <p className="mt-3 text-center text-[11px] text-[#c3313f]" role="status">
          {tp("errors.NETWORK_ERROR")}
        </p>
      )}

      {(googleLoading || showGoogle) && (
        <>
          <div className="my-4 flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[#d5deec]" />
            <span className="h-1.5 w-1.5 rounded-full bg-[#b9c7dd]" />
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[#d5deec]" />
          </div>
          {googleLoading && <div className="h-12 w-full animate-pulse rounded-[14px] bg-[#eef2f8]" aria-hidden="true" />}
          {showGoogle && (
            <Button
              variant="outline"
              className="h-12 w-full rounded-[14px] border-[#dadce0] bg-white text-[14px] font-medium text-[#3c4043] shadow-sm transition hover:-translate-y-px hover:bg-[#f8f9fa] hover:shadow-md"
              onClick={startGoogleLogin}
              loading={redirecting}
              aria-busy={redirecting}
            >
              {!redirecting && <GoogleMark />}
              {redirecting ? t("redirecting") : t("googleLogin")}
            </Button>
          )}
        </>
      )}

      <p className="mt-5 text-center text-[12px] text-[#8794a7]">{t("firstUse")}</p>
      <div className="group mt-5 rounded-[16px] bg-gradient-to-br from-[#eef4ff] to-[#f4f0ff] p-3.5 ring-1 ring-[#e3eafb] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-16px_rgba(36,107,250,0.35)] hover:ring-[#cfe0fc]">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#246bfa] shadow-sm transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3">
            <Mail size={18} />
          </span>
          <div>
            <div className="font-semibold">{t("emailRuleTitle")}</div>
            <p className="mt-1.5 text-[12px] leading-6 text-[#6b7a92]">
              {t("emailRuleStudent")}
              <br />
              {t("emailRuleTeacher")}
            </p>
          </div>
        </div>
      </div>
      <div className="group mt-3.5 flex gap-3 rounded-[16px] bg-gradient-to-br from-[#eef4ff] to-[#f4f0ff] p-3.5 ring-1 ring-[#e3eafb] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-16px_rgba(36,107,250,0.35)] hover:ring-[#cfe0fc]">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#246bfa] shadow-sm transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3">
          <ShieldCheck size={18} />
        </span>
        <div>
          <div className="font-semibold">{t("privacyTitle")}</div>
          <p className="mt-1.5 text-[12px] leading-6 text-[#7b899c]">{t("privacyBody")}</p>
        </div>
      </div>

      <RegisterDialog open={registerOpen} onOpenChange={setRegisterOpen} onTestEntry={goAfterAuth} onVerified={goToRegistrationProfile} locale={locale} />
      <ForgotDialog open={forgotOpen} onOpenChange={setForgotOpen} locale={locale} />
    </section>
  );
}

function RegisterDialog({ open, onOpenChange, onTestEntry, onVerified, locale }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTestEntry: (session: SessionDTO) => void;
  onVerified: (txId: string) => void;
  locale: string;
}) {
  const tr = useTranslations("auth.register");
  const errorText = useErrorText();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [tx, setTx] = useState<RegistrationTxDTO | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null; retryAfter: number | null } | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resendAt) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  useEffect(() => {
    if (open) (tx ? codeInput : emailInput).current?.focus();
  }, [open, tx]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const updateCountdown = (next: number | null) => {
    setResendAt(next);
    setSeconds(next ? Math.max(0, Math.ceil((next - Date.now()) / 1000)) : 0);
  };

  const resetVerification = () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setPending(false);
    setTx(null);
    setCode("");
    updateCountdown(null);
    setError(null);
  };

  const changeOpen = (next: boolean) => {
    if (!next) {
      resetVerification();
      setEmail("");
    }
    onOpenChange(next);
  };

  const runRequest = async <T,>(send: (signal: AbortSignal) => Promise<T>, receive: (data: T) => void, isResend = false) => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setError(null);
    try {
      const data = await send(controller.signal);
      if (!controller.signal.aborted) receive(data);
    } catch (err) {
      if (!controller.signal.aborted) {
        const feedback = errorText(err);
        if (isResend && feedback.retryAfter) updateCountdown(Date.now() + feedback.retryAfter * 1000);
        setError(feedback);
      }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setPending(false);
      }
    }
  };

  const receiveTransaction = (next: RegistrationTxDTO) => {
    setTx(next);
    setCode("");
    updateCountdown(next.resendAvailableAt ? Date.parse(next.resendAvailableAt) : null);
  };

  const sendCode = () => runRequest(
    (signal) => authClient.startEmailRegistration(email.trim(), locale, signal),
    (result) => {
      if ("testEntry" in result) {
        changeOpen(false);
        onTestEntry(result);
        return;
      }
      receiveTransaction(result);
    },
  );

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("title")} · {tr("stepOf", { step: tx ? 2 : 1, total: 2 })}</DialogTitle>
          <DialogDescription>{tr(tx ? "step2Desc" : "step1Desc")}</DialogDescription>
        </DialogHeader>

        {!tx && (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (email.trim()) void sendCode(); }}>
            <label className="gp-field">
              {tr("email")}
              <Input ref={emailInput} value={email} onChange={(event) => { setEmail(event.target.value); setError(null); }} inputMode="email" autoComplete="email" placeholder={tr("emailPlaceholder")} readOnly={pending} />
            </label>
            {error && <ErrorNote {...error} />}
            <Button type="submit" className="w-full" loading={pending} disabled={!email.trim()}>
              {tr("sendCode")}
            </Button>
          </form>
        )}

        {tx && (
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            if (code.length !== 6) return;
            void runRequest(
              (signal) => authClient.verifyEmailRegistration(tx.id, code, signal),
              (result) => {
                if (!result.verified) throw new ApiError(400, { code: "CHALLENGE_INVALID" });
                changeOpen(false);
                onVerified(tx.id);
              },
            );
          }}>
            {tx.status === "captured" ?
              <Feedback tone="warning">{tr("captured")}</Feedback> :
              <p className="text-[12px] text-[#52627b]" role="status">{tr("sentTo", { email: tx.email })}</p>}
            <label className="gp-field">
              <span className="sr-only">{tr("code")}</span>
              <Input
                ref={codeInput}
                className="h-12 text-center text-[22px] tracking-[0.35em]"
                value={code}
                onChange={(event) => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                readOnly={pending}
                placeholder="000000"
              />
            </label>
            {error && <ErrorNote {...error} />}
            <Button type="submit" className="w-full" loading={pending} disabled={code.length !== 6}>
              {tr("verifyCode")}
            </Button>
            <div className="flex items-center justify-between text-[12px]">
              <button type="button" className="gp-link" onClick={resetVerification}>
                {tr("changeEmail")}
              </button>
              <button type="button" className="gp-link disabled:text-[#98a4b5]" disabled={seconds > 0 || pending} onClick={() => void runRequest(
                (signal) => authClient.resendEmailRegistration(tx.id, locale, signal),
                receiveTransaction,
                true,
              )}>
                {seconds > 0 ? tr("resendWait", { seconds }) : tr("resend")}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 忘记密码窗口：输入登录邮箱 → 统一安全反馈（不泄露账户是否存在） */
function ForgotDialog({ open, onOpenChange, locale }: { open: boolean; onOpenChange: (open: boolean) => void; locale: string }) {
  const tf = useTranslations("auth.forgot");
  const errorText = useErrorText();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null; retryAfter: number | null } | null>(null);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await authClient.forgotPassword(email.trim(), locale);
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tf("title")}</DialogTitle>
          <DialogDescription>{tf("description")}</DialogDescription>
        </DialogHeader>
        {sent ? (
          <Feedback tone="success">{tf("sentNote")}</Feedback>
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <label className="gp-field">
              {tf("email")}
              <Input value={email} onChange={(event) => { setEmail(event.target.value); setError(null); }} inputMode="email" autoComplete="email" aria-label={tf("email")} />
            </label>
            {error && <ErrorNote {...error} />}
            <Button type="submit" className="w-full" loading={pending} disabled={!email.trim()}>
              {tf("submit")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 登录页（公开）：Google（可选）+ 账号密码；注册为邮箱验证三步；语言选择 */
export function LoginPage() {
  const t = useTranslations("auth");
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#f4f7fe]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 h-[560px] w-[560px] rounded-full bg-[#7aa7ff]/35 blur-[110px]" />
        <div className="absolute -right-32 top-10 h-[520px] w-[520px] rounded-full bg-[#b79bff]/35 blur-[120px]" />
        <div className="absolute bottom-[-220px] left-1/3 h-[520px] w-[520px] rounded-full bg-[#5fe0d0]/25 blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(#14213b14_1px,transparent_1px)] [background-size:26px_26px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
      </div>
      <header className="relative z-10 flex h-[68px] items-center justify-between gap-2 px-4 sm:px-[max(24px,4vw)]">
        <div className="flex shrink-0 items-center gap-2.5 text-[19px] font-extrabold tracking-tight text-[#14213b] sm:text-[22px]">
          <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-gradient-to-br from-[#246bfa] to-[#7c5cff] text-white shadow-[0_8px_18px_-6px_rgba(36,107,250,0.7)]">
            <ShieldCheck size={19} />
          </span>
          GroupProof
        </div>
        <div className="flex items-center gap-3 text-[12px] text-[#66748b] sm:gap-5">
          <span className="hidden whitespace-nowrap sm:inline">{t("helpCenter")}</span>
          <span className="hidden whitespace-nowrap sm:inline">{t("about")}</span>
          <LanguageSwitcher compact />
        </div>
      </header>
      <main className="relative z-10 mx-auto grid max-w-[1380px] grid-cols-1 gap-10 px-4 py-6 sm:px-[max(24px,4vw)] sm:py-8 lg:grid-cols-[1.16fr_.84fr] lg:gap-16">
        <section className="min-w-0 pt-2 lg:pt-3">
          <ParticleWordmark className="gp-fade-in mb-5" />
          <p className="gp-fade-in mb-4 inline-flex items-center gap-2 rounded-full bg-white/80 px-3.5 py-1.5 text-[13px] font-medium text-[#4b5d7a] shadow-sm ring-1 ring-[#e3eafb] backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-[#246bfa] to-[#7c5cff]" />
            {t("tagline")}
          </p>
          <h1 className="gp-slide-in max-w-[620px] text-[clamp(34px,4vw,54px)] font-extrabold leading-[1.15] tracking-tight text-[#101d35]">
            <span className="bg-gradient-to-r from-[#246bfa] via-[#6a4cff] to-[#1fb6c1] bg-clip-text text-transparent">{t("heroTitle1")}</span>
            <br />
            {t("heroTitle2")}
          </h1>
          <p className="gp-slide-in mt-5 max-w-[560px] text-[16px] leading-[1.8] text-[#62728d]">{t("heroDescription")}</p>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-5">
            {FEATURES.map((feature) => (
              <div key={feature.titleKey} className="group gp-slide-in rounded-[18px] bg-white/75 p-4 shadow-[0_10px_30px_-14px_rgba(36,70,150,0.22)] ring-1 ring-white/85 backdrop-blur transition duration-200 hover:-translate-y-1 hover:shadow-[0_16px_36px_-14px_rgba(36,107,250,0.34)]">
                <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-[12px] bg-gradient-to-br from-[#e6efff] to-[#efe9ff] text-[#246bfa] transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3">
                  <feature.icon size={20} />
                </span>
                <div className="font-semibold text-[#17243c]">{t(feature.titleKey)}</div>
                <p className="mt-1 text-[11px] leading-5 text-[#8290a4]">{t(feature.subKey)}</p>
              </div>
            ))}
          </div>
          <div className="group gp-slide-in mt-10 max-w-[620px] rounded-[20px] border border-white/80 bg-white/85 p-5 shadow-[0_30px_70px_-24px_rgba(36,70,150,0.35)] backdrop-blur transition duration-200 hover:-translate-y-1 hover:shadow-[0_34px_75px_-22px_rgba(36,107,250,0.40)] lg:-rotate-1 lg:hover:rotate-0">
            <div className="flex items-center gap-2 border-b border-[#e6edf5] pb-3 text-[12px] font-semibold">
              <span className="h-2 w-2 rounded-full bg-[#12a66a] transition-transform duration-200 group-hover:scale-125" /> {t("sampleCourse")}
              <span className="ml-auto text-[#246bfa]">{t("sampleOverviewTag")}</span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[110px_1fr]">
              <div className="flex flex-wrap gap-1.5 border-b border-[#e8edf4] pb-3 text-[11px] text-[#7890ac] sm:block sm:space-y-2 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
                <div className="rounded bg-[#eaf2ff] px-2 py-1 text-[#246bfa]">{t("sampleNavOverview")}</div>
                <div className="px-2 py-1 sm:py-0">{t("sampleNavTasks")}</div>
                <div className="px-2 py-1 sm:py-0">{t("sampleNavEvidence")}</div>
                <div className="px-2 py-1 sm:py-0">{t("sampleNavContribution")}</div>
              </div>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold">{t("sampleProject")}</div>
                <div className="mt-3 space-y-3">
                  {([
                    [t("sampleItem1"), 100],
                    [t("sampleItem2"), 80],
                    [t("sampleItem3"), 68],
                  ] as [string, number][]).map(([label, value]) => (
                    <div key={label} className="flex items-center gap-2.5 text-[11px] text-[#68778e] sm:gap-3">
                      <Check size={14} className="shrink-0 text-[#15ac70] transition-transform duration-200 group-hover:scale-110" />
                      <span className="w-24 shrink-0 truncate sm:w-32">{label}</span>
                      <ProgressBar value={value} className="min-w-[48px] flex-1" />
                      <span className="shrink-0 tabular-nums">{value}%</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[10px] text-[#96a3b5]">{t("sampleNote")}</p>
              </div>
            </div>
          </div>
        </section>
        <Suspense fallback={null}>
          <LoginCard />
        </Suspense>
      </main>
    </div>
  );
}

export { ErrorNote };
