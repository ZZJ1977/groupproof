"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Activity, Check, Mail, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Feedback, ProgressBar } from "@/components/common";
import { LanguageSwitcher } from "@/components/language-switcher";
import { authClient, ApiError, type CapabilitiesDTO, type SessionDTO } from "@/lib/api/auth-client";

const FEATURES = [
  { icon: Mail, titleKey: "feature1Title", subKey: "feature1Sub" },
  { icon: Users, titleKey: "feature2Title", subKey: "feature2Sub" },
  { icon: Activity, titleKey: "feature3Title", subKey: "feature3Sub" },
  { icon: ShieldCheck, titleKey: "feature4Title", subKey: "feature4Sub" },
] as const;

function safeLocalTarget(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

/** 统一错误呈现：字段错误/稳定错误码 + 可复制请求编号 + 限流倒计时（由服务端时间推导） */
function useErrorText() {
  const t = useTranslations("auth.passwordLogin");
  return (error: unknown): { message: string; requestId: string | null; retryAfter: number | null } => {
    if (error instanceof ApiError) {
      const firstField = Object.values(error.fieldErrors)[0];
      const key = firstField ? `errors.${firstField}` : `errors.${error.code}`;
      let message: string;
      try {
        message = t(key);
      } catch {
        message = t("errors.SERVICE_UNAVAILABLE");
      }
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
  const search = useSearchParams();
  const router = useRouter();
  const locale = useLocale();
  const errorText = useErrorText();
  const [redirecting, setRedirecting] = useState(false);
  const startedRef = useRef(false);
  const error = search.get("error");
  const returnTo = safeLocalTarget(search.get("returnTo"));

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
  const [loginError, setLoginError] = useState<{ message: string; requestId: string | null; retryAfter: number | null } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  const goAfterAuth = (session: SessionDTO) => {
    const next = session.accountState === "active" ? (returnTo ?? session.nextAction?.href ?? "/home") : (session.nextAction?.href ?? "/account/profile");
    router.push(next);
    router.refresh();
  };

  const startGoogleLogin = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setRedirecting(true);
    window.location.href = authClient.googleStartUrl(returnTo ?? undefined);
  };

  const submitPasswordLogin = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (loginState === "pending") return;
    setLoginState("pending");
    setLoginError(null);
    try {
      goAfterAuth(await authClient.passwordLogin(identifier.trim(), password));
    } catch (err) {
      setLoginError(errorText(err));
      setLoginState("idle");
    }
  };

  const showGoogle = !caps || caps.google.available;
  const showSignup = !caps || caps.emailSignup.enabled;
  const showForgot = !caps || caps.passwordReset.enabled;

  return (
    <section className="self-start rounded-[8px] border border-[#e0e7f0] bg-white p-8 shadow-[0_16px_45px_#b8c9e425] lg:mt-5 lg:p-11">
      <h2 className="text-[28px] font-bold text-[#14213b]">{t("loginTitle")}</h2>
      <p className="mt-2 text-[#718097]">{t("loginSubtitle")}</p>

      {showGoogle && (
        <Button className="mt-8 h-12 w-full text-[14px]" onClick={startGoogleLogin} loading={redirecting} aria-busy={redirecting}>
          {!redirecting && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white font-bold text-[#4285f4]">G</span>}
          {redirecting ? t("redirecting") : t("googleLogin")}
        </Button>
      )}
      {error && (
        <p className="mt-4 rounded-[7px] bg-[#fdecec] p-3 text-[12px] text-[#c3313f]" role="alert">
          {error === "cancelled" ? t("error.cancelled") : error === "failed" ? t("error.failed") : t("error.unavailable")}
        </p>
      )}

      {/* 已注册账户登录窗口：用户名/邮箱 + 密码 */}
      <div className={showGoogle ? "my-6 border-t border-[#e7edf5]" : "mt-8"} />
      <h3 className="text-[14px] font-semibold text-[#14213b]">{tp("title")}</h3>
      <form className="mt-3 space-y-3" onSubmit={submitPasswordLogin}>
        <label className="gp-field">
          {tp("identifier")}
          <Input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" placeholder={tp("identifierPlaceholder")} aria-label={tp("identifier")} />
        </label>
        <label className="gp-field">
          {tp("password")}
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" aria-label={tp("password")} />
        </label>
        {loginError && <ErrorNote {...loginError} />}
        <Button type="submit" className="w-full" loading={loginState === "pending"}>{tp("submit")}</Button>
      </form>
      <div className="mt-3 flex items-center justify-center gap-3 text-[12px] text-[#8794a7]">
        {showForgot && (
          <button type="button" className="gp-link" onClick={() => setForgotOpen(true)}>
            {tp("forgotLink")}
          </button>
        )}
        {showSignup && (
          <>
            <span aria-hidden>·</span>
            <span>
              {tp("noAccount")}
              <button type="button" className="gp-link ml-1" onClick={() => setRegisterOpen(true)}>
                {tp("registerLink")}
              </button>
            </span>
          </>
        )}
      </div>
      {capsFailed && (
        <p className="mt-3 text-center text-[11px] text-[#c3313f]" role="status">
          {tp("errors.NETWORK_ERROR")}
        </p>
      )}

      <p className="mt-6 text-center text-[12px] text-[#8794a7]">{t("firstUse")}</p>
      <div className="mt-6 border-t border-[#e7edf5]" />
      <div className="mt-6 rounded-[7px] bg-[#f5f8fd] p-4">
        <div className="flex gap-3">
          <Mail size={19} className="mt-0.5 text-[#246bfa]" />
          <div>
            <div className="font-semibold">{t("emailRuleTitle")}</div>
            <p className="mt-2 text-[12px] leading-6 text-[#7b899c]">
              {t("emailRuleStudent")}
              <br />
              {t("emailRuleTeacher")}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-5 flex gap-3 rounded-[7px] bg-[#f5f8fd] p-4">
        <ShieldCheck size={19} className="mt-0.5 shrink-0 text-[#246bfa]" />
        <div>
          <div className="font-semibold">{t("privacyTitle")}</div>
          <p className="mt-2 text-[12px] leading-6 text-[#7b899c]">{t("privacyBody")}</p>
        </div>
      </div>

      <RegisterDialog open={registerOpen} onOpenChange={setRegisterOpen} onDone={goAfterAuth} locale={locale} />
      <ForgotDialog open={forgotOpen} onOpenChange={setForgotOpen} locale={locale} />
    </section>
  );
}

/** 注册窗口：三步（登录邮箱 → 邮箱验证码 → 用户名/密码），验证后一次性建档 */
function RegisterDialog({ open, onOpenChange, onDone, locale }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: (session: SessionDTO) => void; locale: string }) {
  const tr = useTranslations("auth.register");
  const errorText = useErrorText();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [txId, setTxId] = useState<string | null>(null);
  const [masked, setMasked] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null; retryAfter: number | null } | null>(null);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  const setField = (setter: (value: string) => void) => (event: { target: { value: string } }) => {
    setter(event.target.value);
    setError(null);
  };

  const sendCode = async () => {
    setPending(true);
    setError(null);
    try {
      const tx = await authClient.startEmailRegistration(email.trim(), locale);
      if ("testEntry" in tx) {
        // 验收临时密令（仅测试模式）：已开通测试账户，直达信息完善页
        onOpenChange(false);
        onDone(tx);
        return;
      }
      setTxId(tx.id);
      setMasked(tx.email);
      setResendAt(tx.resendAvailableAt ? new Date(tx.resendAvailableAt).getTime() : null);
      setSeconds(tx.resendAvailableAt ? Math.max(1, Math.ceil((new Date(tx.resendAvailableAt).getTime() - Date.now()) / 1000)) : 0);
      setStep(2);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const resend = async () => {
    if (!txId) return;
    setPending(true);
    setError(null);
    try {
      const tx = await authClient.resendEmailRegistration(txId, locale);
      setSeconds(tx.resendAvailableAt ? Math.max(1, Math.ceil((new Date(tx.resendAvailableAt).getTime() - Date.now()) / 1000)) : 0);
      setResendAt(tx.resendAvailableAt ? new Date(tx.resendAvailableAt).getTime() : null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const verifyCode = async () => {
    if (!txId) return;
    setPending(true);
    setError(null);
    try {
      await authClient.verifyEmailRegistration(txId, code.trim());
      setStep(3);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const complete = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!txId) return;
    if (password !== confirm) {
      setError({ message: tr("mismatch"), requestId: null, retryAfter: null });
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.completeEmailRegistration(txId, username.trim(), password);
      onOpenChange(false);
      if ("authenticated" in result) {
        onDone(result);
      } else {
        // 建档成功但响应曾丢失：提示登录继续（不重复创建）
        setError({ message: tr("alreadyCompleted"), requestId: null, retryAfter: null });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const changeEmail = () => {
    // 修改邮箱：回到步骤 1 重新建立验证（旧事务/建档资格不再使用）
    setStep(1);
    setTxId(null);
    setCode("");
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("title")} · {tr("stepOf", { step, total: 3 })}</DialogTitle>
          <DialogDescription>{step === 1 ? tr("step1Desc") : step === 2 ? tr("step2Desc") : tr("step3Desc")}</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void sendCode(); }}>
            <label className="gp-field">
              {tr("email")}
              <Input value={email} onChange={setField(setEmail)} inputMode="email" autoComplete="email" aria-label={tr("email")} placeholder={tr("emailPlaceholder")} />
            </label>
            <p className="text-[11px] leading-5 text-[#8d9aad]">{tr("commonEmailNote")}</p>
            {error && <ErrorNote {...error} />}
            <Button type="submit" className="w-full" loading={pending} disabled={!email.trim()}>
              {tr("sendCode")}
            </Button>
          </form>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-[12px] text-[#52627b]">{tr("sentTo", { email: masked ?? email })}</p>
            <label className="gp-field">
              <span className="sr-only">{tr("code")}</span>
              <Input
                className="h-12 text-center text-[22px] tracking-[0.35em]"
                value={code}
                onChange={(event) => setField(setCode)({ target: { value: event.target.value.replace(/\D/g, "").slice(0, 6) } })}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                aria-label={tr("code")}
                placeholder="000000"
              />
            </label>
            {error && <ErrorNote {...error} />}
            <Button className="w-full" onClick={() => void verifyCode()} loading={pending} disabled={code.length !== 6}>
              {tr("verifyCode")}
            </Button>
            <div className="flex items-center justify-between text-[12px]">
              <button type="button" className="gp-link" onClick={changeEmail}>
                {tr("changeEmail")}
              </button>
              <button type="button" className="gp-link disabled:text-[#98a4b5]" disabled={seconds > 0 || pending} onClick={() => void resend()}>
                {seconds > 0 ? tr("resendWait", { seconds }) : tr("resend")}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <form className="space-y-3" onSubmit={complete}>
            <div className="rounded-[7px] bg-[#f5f8fd] p-3 text-[12px] text-[#52627b]">
              {tr("verifiedEmail")}：<span className="font-semibold">{masked ?? email}</span>
            </div>
            <label className="gp-field">
              {tr("username")}
              <Input value={username} onChange={setField(setUsername)} autoComplete="username" aria-label={tr("username")} />
            </label>
            <label className="gp-field">
              {tr("password")}
              <Input type="password" value={password} onChange={setField(setPassword)} autoComplete="new-password" aria-label={tr("password")} />
            </label>
            <label className="gp-field">
              {tr("confirmPassword")}
              <Input type="password" value={confirm} onChange={setField(setConfirm)} autoComplete="new-password" aria-label={tr("confirmPassword")} />
            </label>
            <p className="text-[11px] leading-5 text-[#8d9aad]">{tr("passwordPolicyNote")}</p>
            {error && <ErrorNote {...error} />}
            <Button type="submit" className="w-full" loading={pending} disabled={!username.trim() || !password || !confirm}>
              {tr("submit")}
            </Button>
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
    <div className="min-h-screen bg-[#f6f9fd]">
      <header className="flex h-[65px] items-center justify-between border-b border-[#e7edf5] bg-white px-[max(24px,4vw)]">
        <div className="text-[22px] font-bold text-[#14213b]">GroupProof</div>
        <div className="flex items-center gap-5 text-[12px] text-[#66748b]">
          <span>{t("helpCenter")}</span>
          <span>{t("about")}</span>
          <LanguageSwitcher compact />
        </div>
      </header>
      <main className="mx-auto grid max-w-[1380px] grid-cols-1 gap-12 px-[max(24px,4vw)] py-14 lg:grid-cols-[1.16fr_.84fr] lg:gap-20">
        <section className="min-w-0 pt-8">
          <p className="mb-4 text-[14px] text-[#6d7b91]">{t("tagline")}</p>
          <h1 className="max-w-[590px] text-[clamp(31px,3.5vw,46px)] font-bold leading-[1.2] text-[#101d35]">
            {t("heroTitle1")}
            <br />
            {t("heroTitle2")}
          </h1>
          <p className="mt-6 max-w-[560px] text-[16px] leading-[1.8] text-[#62728d]">{t("heroDescription")}</p>
          <div className="mt-10 grid grid-cols-2 gap-5 sm:grid-cols-4">
            {FEATURES.map((feature) => (
              <div key={feature.titleKey} className="border-r border-[#e7edf5] pr-3 last:border-0">
                <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]">
                  <feature.icon size={20} />
                </span>
                <div className="font-semibold text-[#17243c]">{t(feature.titleKey)}</div>
                <p className="mt-1 text-[11px] leading-5 text-[#8290a4]">{t(feature.subKey)}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 max-w-[620px] rounded-[8px] border border-[#dce7f7] bg-white p-4 shadow-[0_14px_35px_#cddcf029]">
            <div className="flex items-center gap-2 border-b border-[#e6edf5] pb-3 text-[12px] font-semibold">
              <span className="h-2 w-2 rounded-full bg-[#12a66a]" /> {t("sampleCourse")}
              <span className="ml-auto text-[#246bfa]">{t("sampleOverviewTag")}</span>
            </div>
            <div className="mt-4 grid grid-cols-[110px_1fr] gap-4">
              <div className="space-y-2 border-r border-[#e8edf4] pr-4 text-[11px] text-[#7890ac]">
                <div className="rounded bg-[#eaf2ff] px-2 py-1 text-[#246bfa]">{t("sampleNavOverview")}</div>
                <div className="px-2">{t("sampleNavTasks")}</div>
                <div className="px-2">{t("sampleNavEvidence")}</div>
                <div className="px-2">{t("sampleNavContribution")}</div>
              </div>
              <div>
                <div className="text-[12px] font-semibold">{t("sampleProject")}</div>
                <div className="mt-3 space-y-3">
                  {([
                    [t("sampleItem1"), 100],
                    [t("sampleItem2"), 80],
                    [t("sampleItem3"), 68],
                  ] as [string, number][]).map(([label, value]) => (
                    <div key={label} className="flex items-center gap-3 text-[11px] text-[#68778e]">
                      <Check size={14} className="text-[#15ac70]" />
                      <span className="w-32">{label}</span>
                      <ProgressBar value={value} className="flex-1" />
                      <span>{value}%</span>
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
