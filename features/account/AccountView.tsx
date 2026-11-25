"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, KeyRound, Link2, Mail, RotateCw, ShieldCheck } from "lucide-react";
import { Feedback, Panel, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountSession } from "@/components/account-session";
import { authClient, ApiError, type MeDTO, type SessionDTO } from "@/lib/api/auth-client";
import { useMe, useAcceptanceTest } from "@/features/account/use-me";
import { GithubIdentityPanel } from "@/features/account/GithubIdentityPanel";
import { FeishuAccountSection } from "@/features/account/CollaborationAccountsPanel";
import { AccountProfilePanel } from "@/features/account/AccountProfilePanel";
import { deriveProgress, ProgressStatusChip } from "@/features/account/registration-progress";
import { MyAccessRequests } from "@/features/c/GovernanceApiPages";

/** 个人中心：受限注册模式与已激活模式共用同一套资料/邮箱组件，按服务端状态呈现 */
export function AccountView({ screen }: { screen: number }) {
  const { session } = useAccountSession();
  const t = useTranslations("account");
  const { data: me, isLoading, isError, refetch } = useMe(session.user?.id);
  if (isError) {
    return (
      <Panel>
        <Feedback tone="error">{t("progress.loadFailed")}</Feedback>
        <Button className="mt-3" variant="outline" onClick={() => void refetch()}>
          {t("progress.retry")}
        </Button>
      </Panel>
    );
  }
  if (isLoading || !me) {
    return <div className="gp-empty">…</div>;
  }
  // 停用账户 /me 有意只返回最少状态；不得继续读取角色、学校邮箱等完整 DTO 字段。
  if (me.registration.accountState === "disabled") {
    return (
      <Panel>
        <ProgressStatusChip statusKey="statusDisabled" statusTone="danger" />
        <p className="mt-3 text-[13px] leading-6 text-[#52627b]" role="status">
          {t("status.stateDesc.disabled")}
        </p>
      </Panel>
    );
  }
  if (screen === 102) return <EmailPanel session={session} me={me} refetch={refetch} />;
  if (screen === 103) return <StatusPanel session={session} me={me} refetch={refetch} />;
  if (screen === 104) return <SecurityPanel session={session} me={me} refetch={refetch} />;
  return (
    <AccountProfilePanel
      session={session}
      me={me}
      refetch={refetch}
      rightSlot={
        session.accountState === "active" && session.sessionScope === "full" ? (
          <MyAccessRequests key={me.user.id} userId={me.user.id} />
        ) : undefined
      }
    />
  );
}

/* ---------------- 修改密码 ---------------- */

function PasswordPanel({ session, me }: { session: SessionDTO; me: MeDTO }) {
  const { refreshSession } = useAccountSession();
  const t = useTranslations("account.profile");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!me.user.passwordLoginEnabled) {
    return (
      <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
        <div className="border-b border-border bg-slate-50/70 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("passwordTitle")}</h2>
        </div>
        <div className="p-4">
          <p className="text-xs text-[#6f7f95]">{t("passwordNotSet")}</p>
        </div>
      </section>
    );
  }

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      await authClient.changePassword(session.csrfToken ?? "", current, next);
      await refreshSession();
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (err) {
      const code = err instanceof ApiError ? (Object.values(err.fieldErrors)[0] ?? err.code) : "SERVICE_UNAVAILABLE";
      setError(t(`passwordErrors.${code}`));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
      <div className="flex items-center gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
        <KeyRound size={15} className="text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("passwordTitle")}</h2>
      </div>
      <form className="space-y-3 p-4" onSubmit={submit}>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--gp-ink-soft)]">
          {t("currentPassword")}
          <Input
            className="h-9 text-xs"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            aria-label={t("currentPassword")}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--gp-ink-soft)]">
          {t("newPassword")}
          <Input
            className="h-9 text-xs"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            aria-label={t("newPassword")}
          />
        </label>
        {error && (
          <p className="text-xs text-[#e54955]" role="alert">
            {error}
          </p>
        )}
        {done && <Feedback tone="success">{t("passwordChanged")}</Feedback>}
        <Button type="submit" variant="outline" size="sm" loading={pending} disabled={!current || !next}>
          {t("changePasswordSubmit")}
        </Button>
      </form>
    </section>
  );
}

/* ---------------- 账户安全（2 栏 Bento：登录邮箱 + 密码 | 第三方与协作账号关联） ---------------- */

function SecurityPanel({ session, me, refetch }: { session: SessionDTO; me: MeDTO; refetch: () => unknown }) {
  const { refreshSession } = useAccountSession();
  const t = useTranslations("account.security");
  const tp = useTranslations("account.progress");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const verified = me.registration.loginEmailVerified !== false;
  const acceptance = useAcceptanceTest();
  const isActive = session.accountState === "active" && session.sessionScope === "full";

  const send = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.loginEmailChallenge(session.csrfToken ?? "");
      if ("challengeId" in result) setChallengeId(result.challengeId);
      void refetch();
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.SERVICE_UNAVAILABLE"));
    } finally {
      setPending(false);
    }
  };

  const verify = async () => {
    if (!challengeId && !acceptance) return;
    setPending(true);
    setError(null);
    try {
      await authClient.loginEmailVerify(session.csrfToken ?? "", challengeId ?? "", code);
      await refreshSession();
      void refetch();
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.SERVICE_UNAVAILABLE"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-[var(--gp-ink)]">
            <ShieldCheck size={19} className="text-primary" aria-hidden="true" />
            {t("title")}
          </h1>
          <p className="mt-0.5 text-xs leading-5 text-[var(--gp-ink-soft)]">{t("description")}</p>
        </div>
        <StatusBadge status="gray" label={tp("optionalTag")} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* 左栏：登录邮箱 + 修改密码 */}
        <div className="min-w-0 space-y-4">
          <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--gp-ink)]">
                <Mail size={15} className="text-primary" aria-hidden="true" />
                {t("loginEmailTitle")}
              </h2>
              {verified && <StatusBadge status="verified" label={t("loginEmailVerified")} />}
            </div>
            <div className="p-4">
              {verified ? (
                <p className="text-xs leading-5 text-[#52627b]">{t("verifiedNote")}</p>
              ) : (
                <div>
                  <p className="text-xs leading-5 text-[#6f7f95]">{t("unverifiedNote")}</p>
                  {error && (
                    <p className="mt-2 text-xs text-[#e54955]" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2.5">
                    <Button variant="outline" size="sm" onClick={() => void send()} loading={pending}>
                      {t("sendCode")}
                    </Button>
                    {(challengeId || acceptance) && (
                      <>
                        <Input
                          className="h-8 w-[130px] text-center text-xs tracking-[0.25em]"
                          value={code}
                          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                          inputMode="numeric"
                          maxLength={6}
                          autoComplete="one-time-code"
                          aria-label={t("code")}
                          placeholder="000000"
                        />
                        <Button size="sm" onClick={() => void verify()} loading={pending} disabled={code.length !== 6}>
                          {t("verify")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          <PasswordPanel session={session} me={me} />
        </div>

        {/* 右栏：统一第三方与协作账号关联卡片（Google + GitHub + 飞书） */}
        <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
          <div className="flex items-center gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
            <Link2 size={15} className="text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("linkedAccountsTitle")}</h2>
          </div>
          <div className="divide-y divide-slate-100">
            <div className="p-4">
              <GooglePanel session={session} me={me} refetch={refetch} embedded />
            </div>
            {isActive && (
              <div className="p-4">
                <GithubIdentityPanel key={me.user.id} userId={me.user.id} csrfToken={session.csrfToken ?? ""} embedded />
              </div>
            )}
            {isActive && (
              <div className="p-4">
                <FeishuAccountSection session={session} me={me} refetch={refetch} compact />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---------------- Google 身份关联 / 解除 ---------------- */

function GooglePanel({
  session,
  me,
  refetch,
  embedded = false,
}: {
  session: SessionDTO;
  me: MeDTO;
  refetch: () => unknown;
  embedded?: boolean;
}) {
  const t = useTranslations("account.security");
  const search = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = Boolean(me.user.googleEmailBound);
  const canUnlink = Boolean(me.user.passwordLoginEnabled);
  const linkedNow = search.get("linked") === "google";
  const linkError = search.get("error");

  const link = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.linkGoogle(session.csrfToken ?? "");
      window.location.href = result.authorizeUrl;
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.SERVICE_UNAVAILABLE"));
      setPending(false);
    }
  };

  const unlink = async () => {
    setPending(true);
    setError(null);
    try {
      await authClient.unlinkGoogle(session.csrfToken ?? "");
      void refetch();
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.SERVICE_UNAVAILABLE"));
    } finally {
      setPending(false);
    }
  };

  const content = (
    <div className="space-y-2">
      {embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--gp-ink)]">{t("googleTitle")}</span>
            {linked && <StatusBadge status="verified" label={t("googleLinked")} />}
          </div>
          {linked && me.user.googleEmail && (
            <span className="break-all font-mono text-[11px] text-[var(--gp-ink-soft)]">{me.user.googleEmail}</span>
          )}
        </div>
      )}
      {linked ? (
        <div className="space-y-2">
          {!embedded && (
            <p className="flex items-center gap-2 text-xs text-[#52627b]">
              <StatusBadge status="verified" label={t("googleLinked")} />
              {me.user.googleEmail ? t("googleBoundEmail", { email: me.user.googleEmail }) : t("googleLinked")}
            </p>
          )}
          {canUnlink ? (
            <Button variant="outline" size="sm" onClick={() => void unlink()} loading={pending}>
              {t("googleUnlink")}
            </Button>
          ) : (
            <p className="text-xs leading-5 text-[#8d9aad]">{t("googleUnlinkDisabled")}</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-[#6f7f95]">{t("googleUnboundNote")}</p>
          <Button size="sm" onClick={() => void link()} loading={pending}>
            {t("googleLink")}
          </Button>
        </div>
      )}
      {linkedNow && (
        <p className="text-xs text-[#2f9e63]" role="status">
          {t("googleLinkSuccess")}
        </p>
      )}
      {linkError === "identity_linked_elsewhere" && (
        <p className="text-xs text-[#e54955]" role="alert">
          {t("googleLinkElsewhere")}
        </p>
      )}
      {linkError === "failed" && (
        <p className="text-xs text-[#e54955]" role="alert">
          {t("googleLinkFailed")}
        </p>
      )}
      {linkError === "cancelled" && (
        <p className="text-xs text-[#6f7f95]" role="status">
          {t("googleLinkCancelled")}
        </p>
      )}
      {linkError === "unavailable" && (
        <p className="text-xs text-[#e54955]" role="alert">
          {t("googleLinkUnavailable")}
        </p>
      )}
      {error && (
        <p className="text-xs text-[#e54955]" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  if (embedded) return content;
  return <Panel title={t("googleTitle")}>{content}</Panel>;
}

/* ---------------- 学校邮箱 ---------------- */

function EmailPanel({ session, me, refetch }: { session: SessionDTO; me: MeDTO; refetch: () => unknown }) {
  const { refreshSession } = useAccountSession();
  const t = useTranslations("account.email");
  const router = useRouter();
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [masked, setMasked] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [changeTarget, setChangeTarget] = useState("");
  const [captured, setCaptured] = useState(false);
  const acceptance = useAcceptanceTest();

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  const send = async () => {
    setPending(true);
    setError(null);
    setInfo(null);
    try {
      const created = await authClient.createChallenge(session.csrfToken ?? "");
      setChallengeId(created.challengeId);
      setMasked(created.email);
      setSeconds(Math.max(1, Math.ceil((new Date(created.resendAvailableAt).getTime() - Date.now()) / 1000)));
      setCaptured(created.sendStatus === "captured");
      setInfo(created.sendStatus === "captured" ? null : t("sent"));
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.AUTH_UNAVAILABLE"));
    } finally {
      setPending(false);
    }
  };

  const verify = async () => {
    if (!challengeId && !acceptance) return;
    setPending(true);
    setError(null);
    try {
      const updated = await authClient.verifyChallenge(session.csrfToken ?? "", challengeId ?? "", code);
      await refreshSession();
      void refetch();
      const nextHref = (updated as unknown as { registration?: { nextAction?: { href?: string } } })?.registration
        ?.nextAction?.href;
      router.push(nextHref && nextHref.startsWith("/account") ? nextHref : "/account/status");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.AUTH_UNAVAILABLE"));
    } finally {
      setPending(false);
    }
  };

  const requestChange = async () => {
    setPending(true);
    setError(null);
    setInfo(null);
    try {
      await authClient.requestEmailChange(session.csrfToken ?? "", changeTarget.trim(), me.user.version);
      setInfo(t("changeNote"));
      setChangeTarget("");
      void refetch();
    } catch (err) {
      setError(err instanceof ApiError ? t(`errors.${err.code}`) : t("errors.AUTH_UNAVAILABLE"));
    } finally {
      setPending(false);
    }
  };

  const displayEmail = masked ?? me.schoolEmail.pendingEmail ?? me.schoolEmail.verifiedEmail;

  return (
    <div className={`mx-auto space-y-3.5 ${me.schoolEmail.verified ? "max-w-[880px]" : "max-w-[540px]"}`}>
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-[var(--gp-ink)]">
          <Mail size={19} className="text-primary" aria-hidden="true" />
          {t("title")}
        </h1>
        <p className="mt-0.5 text-xs leading-5 text-[var(--gp-ink-soft)]">{t("description")}</p>
      </div>

      <div className={`grid items-start gap-4 ${me.schoolEmail.verified ? "lg:grid-cols-2" : ""}`}>
        <section className="overflow-hidden rounded-xl border border-border bg-white p-5 shadow-2xs">
          <div className="mx-auto max-w-[380px] text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-[#eaf2ff] text-[#246bfa]">
              <Mail size={20} aria-hidden="true" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-[var(--gp-ink)]">{t("verifyTitle")}</h2>
            {/* 进入页面时尚未发码：只有本页发送成功后才显示“已发送” */}
            <p className="mt-1 break-all text-xs text-[#7d8ca0]">
              {displayEmail ? t(challengeId ? "sentTo" : "sendTo", { email: displayEmail }) : t("noPending")}
            </p>
            <label className="gp-field mt-4 text-left">
              <span className="sr-only">{t("codeLabel")}</span>
              <Input
                className="h-11 text-center text-lg tracking-[0.35em]"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                  setError(null);
                }}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                aria-label={t("codeLabel")}
                placeholder={t("codePlaceholder")}
              />
            </label>
            {error && (
              <p className="mt-2 text-xs text-[#e54955]" role="alert">
                {error}
              </p>
            )}
            {info && (
              <Feedback tone="success" className="mt-2.5">
                {info}
              </Feedback>
            )}
            {captured && (
              <Feedback tone="warning" className="mt-2.5">
                {t("captured")}
              </Feedback>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <Button
                className="w-full"
                size="sm"
                onClick={() => void verify()}
                loading={pending}
                disabled={(!challengeId && !acceptance) || code.length !== 6}
              >
                {t("verify")}
              </Button>
              {!challengeId ? (
                <Button variant="secondary" size="sm" className="w-full" onClick={() => void send()} loading={pending}>
                  {t("send")}
                </Button>
              ) : (
                <button
                  type="button"
                  className="mt-1 text-xs font-medium text-[#246bfa] disabled:text-[#98a4b5]"
                  disabled={seconds > 0 || pending}
                  onClick={() => void send()}
                >
                  {seconds > 0 ? t("resendWait", { seconds }) : t("resend")}
                </button>
              )}
            </div>
            <p className="mt-3 text-[11px] text-[#8d9aad]">{t("verifyCodeHint")}</p>
          </div>
        </section>

        {me.schoolEmail.verified && (
          <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
            <div className="border-b border-border bg-slate-50/70 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("changeTitle")}</h2>
            </div>
            <div className="space-y-3 p-4">
              <p className="text-xs leading-5 text-[#6f7f95]">{t("changeNote")}</p>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--gp-ink-soft)]">
                {t("changeTitle")}
                <Input
                  className="h-9 text-xs"
                  value={changeTarget}
                  onChange={(event) => setChangeTarget(event.target.value)}
                  inputMode="email"
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void requestChange()}
                loading={pending}
                disabled={!changeTarget.trim()}
              >
                {t("changeSubmit")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/* ---------------- 注册与审核状态 ---------------- */

const STATE_KEYS = [
  "disabled",
  "profile_required",
  "email_required",
  "review_required",
  "review_pending",
  "review_rejected",
  "active",
] as const;

function StatusPanel({ session, me, refetch }: { session: SessionDTO; me: MeDTO; refetch: () => unknown }) {
  const t = useTranslations("account.status");
  const tEmail = useTranslations("account.email");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = (me.registration.accountState ?? "profile_required") as (typeof STATE_KEYS)[number];
  // 与侧栏共用同一份按后端事实推导的状态（含“完成注册”与教师审核细节）
  const progress = deriveProgress(me, { authMethod: session.authMethod ?? null });

  const submitApplication = async () => {
    setPending(true);
    setError(null);
    try {
      await authClient.submitTeacherApplication(session.csrfToken ?? "", me.user.version);
      void refetch();
    } catch (err) {
      setError(err instanceof ApiError ? tEmail(`errors.${err.code}`) : null);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-[var(--gp-ink)]">
          <ShieldCheck size={19} className="text-primary" aria-hidden="true" />
          {t("title")}
        </h1>
        <p className="mt-0.5 text-xs leading-5 text-[var(--gp-ink-soft)]">{t("description")}</p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <section className="rounded-xl border border-border bg-white p-4 shadow-2xs">
            <div className="flex flex-wrap items-center gap-2.5">
              <ProgressStatusChip statusKey={progress.statusKey} statusTone={progress.statusTone} />
              <p className="text-xs leading-5 text-[#52627b]">{t(`stateDesc.${state}`)}</p>
            </div>
          </section>

          {me.user.requestedIdentity === "teacher" && (
            <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
              <div className="border-b border-border bg-slate-50/70 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("applicationTitle")}</h2>
              </div>
              <div className="space-y-3 p-4">
                <p className="text-xs leading-5 text-[#6f7f95]">{t("applicationNote")}</p>
                {me.teacherApplication?.status === "rejected" && me.teacherApplication.reason && (
                  <Feedback tone="warning">
                    {t("applicationReason")}：{me.teacherApplication.reason}
                  </Feedback>
                )}
                {error && <Feedback tone="error">{error}</Feedback>}
                <div className="flex flex-wrap items-center gap-2.5">
                  {(me.registration.teacherReviewStatus === "review_required" ||
                    me.registration.teacherReviewStatus === "review_rejected") && (
                    <Button size="sm" onClick={() => void submitApplication()} loading={pending}>
                      {me.registration.teacherReviewStatus === "review_rejected"
                        ? t("resubmit")
                        : t("submitApplication")}
                    </Button>
                  )}
                  {me.registration.teacherReviewStatus === "review_pending" && (
                    <>
                      <StatusBadge status="pending_verification" />
                      {/* 审核等待期提供刷新入口；窗口重获焦点时 useMe 也会自动重读 */}
                      <Button variant="outline" size="sm" onClick={() => void refetch()}>
                        <RotateCw size={13} />
                        {t("applicationRefresh")}
                      </Button>
                    </>
                  )}
                  <Button variant="outline" size="sm" onClick={() => router.push("/account/profile")}>
                    {tc("back")}
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>

        <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
          <div className="border-b border-border bg-slate-50/70 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-[var(--gp-ink)]">{t("basisTitle")}</h2>
          </div>
          <div className="space-y-3 p-4">
            <ul className="space-y-2 text-xs text-[#52627b]">
              {me.registration.verificationBasis.map((item) => (
                <li key={item.kind} className="flex items-center gap-2">
                  <ShieldCheck size={14} className="shrink-0 text-[#15ac70]" />
                  {t(`basis.${item.kind}`)}
                </li>
              ))}
            </ul>
            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center gap-2 text-xs text-[#52627b]">
                <AlertCircle size={14} className="shrink-0 text-[#c78a1c]" />
                <span>
                  {t("academicTitle")}：{t(`academic.${me.registration.academicIdentityStatus}`)}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
