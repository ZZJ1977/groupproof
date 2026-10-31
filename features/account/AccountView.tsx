"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, Info, Mail, RotateCw, ShieldCheck, UserRound } from "lucide-react";
import { Feedback, PageHeader, Panel, SaveState, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountSession } from "@/components/account-session";
import { authClient, ApiError, type MeDTO, type SessionDTO } from "@/lib/api/auth-client";
import { useMe, useAcceptanceTest } from "@/features/account/use-me";
import { deriveProgress, ProgressStatusChip } from "@/features/account/registration-progress";

type FieldErrors = Record<string, string>;

function fieldError(errors: FieldErrors, field: string, t: (key: string) => string) {
  const code = errors[field];
  return code ? t(code) : null;
}

/** 个人中心：受限注册模式与已激活模式共用同一套资料/邮箱组件，按服务端状态呈现 */
export function AccountView({ screen }: { screen: number }) {
  const { session } = useAccountSession();
  const t = useTranslations("account");
  const { data: me, isLoading, isError, refetch } = useMe(session.user?.id);
  if (isError) {
    return <Panel><Feedback tone="error">{t("progress.loadFailed")}</Feedback><Button className="mt-3" variant="outline" onClick={() => void refetch()}>{t("progress.retry")}</Button></Panel>;
  }
  if (isLoading || !me) {
    return <div className="gp-empty">…</div>;
  }
  // 停用账户 /me 有意只返回最少状态；不得继续读取角色、学校邮箱等完整 DTO 字段。
  if (me.registration.accountState === "disabled") {
    return <Panel><ProgressStatusChip statusKey="statusDisabled" statusTone="danger" /><p className="mt-3 text-[13px] leading-6 text-[#52627b]" role="status">{t("status.stateDesc.disabled")}</p></Panel>;
  }
  if (screen === 102) return <EmailPanel session={session} me={me} refetch={refetch} />;
  if (screen === 103) return <StatusPanel session={session} me={me} refetch={refetch} />;
  if (screen === 104) return <SecurityPanel session={session} me={me} refetch={refetch} />;
  return <ProfilePanel session={session} me={me} refetch={refetch} />;
}

/* ---------------- 基本资料 ---------------- */

function ProfilePanel({ session, me, refetch }: { session: SessionDTO; me: MeDTO; refetch: () => unknown }) {
  const { refreshSession } = useAccountSession();
  const t = useTranslations("account.profile");
  const tc = useTranslations("common");
  const router = useRouter();
  const [form, setForm] = useState({
    name: me.user.name ?? "",
    username: me.user.username ?? "",
    studentId: me.user.studentId ?? "",
    college: me.user.college ?? "",
    requestedIdentity: me.user.requestedIdentity ?? "student",
    schoolEmail: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [info, setInfo] = useState<string | null>(null);
  const identityLocked = Boolean(me.user.requestedIdentity && me.user.roles.some((role) => role === "student" || role === "teacher"));
  const isStudent = form.requestedIdentity === "student";

  const set = (field: keyof typeof form) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setSaveState("dirty");
    setErrors((current) => ({ ...current, [field]: "" }));
    setInfo(null);
  };

  const submit = async (exitAfter: boolean) => {
    setSaveState("saving");
    setInfo(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        username: form.username,
        college: form.college,
        expectedVersion: me.user.version,
      };
      if (!identityLocked) body.requestedIdentity = form.requestedIdentity;
      if (isStudent || me.user.studentId) body.studentId = form.studentId;
      if (!me.schoolEmail.verified && form.schoolEmail.trim()) body.schoolEmail = form.schoolEmail.trim();
      const updated = await authClient.updateProfile(session.csrfToken ?? "", body);
      await refreshSession();
      setErrors({});
      setSaveState("saved");
      void refetch();
      if (exitAfter) {
        setInfo(t("saveAndExitDone"));
        return;
      }
      setInfo(t("savedNext"));
      const next = updated.registration?.nextAction?.href;
      window.setTimeout(() => router.push(next && next.startsWith("/account") ? next : "/account/email"), 400);
    } catch (error) {
      setSaveState("error");
      if (error instanceof ApiError) {
        if (error.code === "VERSION_CONFLICT") setErrors({ version: "version_conflict" });
        else setErrors(error.fieldErrors);
      }
    }
  };

  return (
    <div>
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} icon={UserRound} />
      <div className="gp-grid-2">
        <Panel title={t("title")}>
          <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(false); }}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="gp-field">
                {t("name")}
                <Input value={form.name} onChange={set("name")} autoComplete="name" />
                {fieldError(errors, "name", t) && <span className="text-[#e54955]" role="alert">{fieldError(errors, "name", t)}</span>}
              </label>
              <label className="gp-field">
                {t("username")}
                <Input value={form.username} onChange={set("username")} autoComplete="username" />
                {fieldError(errors, "username", t) && <span className="text-[#e54955]" role="alert">{fieldError(errors, "username", t)}</span>}
              </label>
              <label className="gp-field">
                {t("identity")}
                <select className="gp-input" value={form.requestedIdentity} onChange={set("requestedIdentity")} disabled={identityLocked}>
                  <option value="student">{t("identityStudent")}</option>
                  <option value="teacher">{t("identityTeacher")}</option>
                </select>
                {fieldError(errors, "requestedIdentity", t) && <span className="text-[#e54955]" role="alert">{fieldError(errors, "requestedIdentity", t)}</span>}
              </label>
              {isStudent && (
                <label className="gp-field">
                  {t("studentId")}
                  <Input value={form.studentId} onChange={set("studentId")} placeholder={t("studentIdPlaceholder")} />
                  {fieldError(errors, "studentId", t) && <span className="text-[#e54955]" role="alert">{fieldError(errors, "studentId", t)}</span>}
                </label>
              )}
            </div>
            <label className="gp-field">
              {t("college")}
              <Input value={form.college} onChange={set("college")} />
            </label>
            <label className="gp-field">
              {t("schoolEmail")}
              <Input
                value={me.schoolEmail.verified ? me.schoolEmail.verifiedEmail ?? "" : form.schoolEmail}
                onChange={set("schoolEmail")}
                inputMode="email"
                readOnly={me.schoolEmail.verified}
                placeholder={me.schoolEmail.verified ? undefined : t("errors.email_required")}
              />
              {fieldError(errors, "schoolEmail", t) && <span className="text-[#e54955]" role="alert">{fieldError(errors, "schoolEmail", t)}</span>}
            </label>
            {errors.version && <Feedback tone="error">{t("errors.version_conflict")}</Feedback>}
            <div className="flex items-center justify-end gap-3 border-t border-[#e7edf5] pt-4">
              <SaveState state={saveState} />
              <Button variant="outline" type="button" onClick={() => void submit(true)}>{tc("saveAndExit")}</Button>
              <Button type="submit">{tc("saveAndContinue")}</Button>
            </div>
            {info && <Feedback tone="success">{info}</Feedback>}
          </form>
        </Panel>
        <div className="gp-stack">
          {/* 注意事项提示（2026-10-10：基本资料页移除修改密码，安全设置集中在“账号安全”页） */}
          <Panel title={t("noticesTitle")}>
            <ul className="space-y-2 text-[12px] leading-6 text-[#6f7f95]">
              <li className="flex gap-2">
                <Info size={14} className="mt-1 shrink-0 text-[#246bfa]" aria-hidden="true" />
                {t("declarativeNotice")}
              </li>
              <li className="flex gap-2">
                <Info size={14} className="mt-1 shrink-0 text-[#246bfa]" aria-hidden="true" />
                {t("notices.schoolEmail")}
              </li>
              <li className="flex gap-2">
                <Info size={14} className="mt-1 shrink-0 text-[#246bfa]" aria-hidden="true" />
                {t("notices.teacher")}
              </li>
              <li className="flex gap-2">
                <Info size={14} className="mt-1 shrink-0 text-[#246bfa]" aria-hidden="true" />
                {t("notices.password")}
              </li>
            </ul>
          </Panel>
          {me.user.googleEmailBound && <Panel title={t("googleBound")}>
            <div className="gp-row text-[12px]">
              <span className="flex items-center gap-2">
                <span className="font-bold text-[#4285f4]">G</span>
                {t("googleBound")}
              </span>
              <StatusBadge status="confirmed" label={t("bound")} />
            </div>
          </Panel>}
          <Panel title={t("identity")}>
            <p className="text-[12px] leading-6 text-[#6f7f95]">{t("identityNotice")}</p>
          </Panel>
        </div>
      </div>
    </div>
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
    return <Panel title={t("passwordTitle")}><p className="text-[12px] text-[#6f7f95]">{t("passwordNotSet")}</p></Panel>;
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
    <Panel title={t("passwordTitle")}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="gp-field">
          {t("currentPassword")}
          <Input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" aria-label={t("currentPassword")} />
        </label>
        <label className="gp-field">
          {t("newPassword")}
          <Input type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" aria-label={t("newPassword")} />
        </label>
        {error && <p className="text-[12px] text-[#e54955]" role="alert">{error}</p>}
        {done && <Feedback tone="success">{t("passwordChanged")}</Feedback>}
        <Button type="submit" variant="outline" loading={pending} disabled={!current || !next}>
          {t("changePasswordSubmit")}
        </Button>
      </form>
    </Panel>
  );
}


/* ---------------- 账户安全（登录邮箱补验 + 修改密码） ---------------- */

function SecurityPanel({ session, me, refetch }: { session: SessionDTO; me: MeDTO; refetch: () => unknown }) {
  const { refreshSession } = useAccountSession();
  const t = useTranslations("account.security");
  const tp = useTranslations("account.progress");
  const tc = useTranslations("common");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const verified = me.registration.loginEmailVerified !== false;
  const acceptance = useAcceptanceTest();

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
    <div>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        icon={ShieldCheck}
        actions={<StatusBadge status="gray" label={tp("optionalTag")} />}
      />
      <div className="gp-stack">
        <Panel title={t("loginEmailTitle")}>
          {verified ? (
            <p className="flex items-center gap-2 text-[12px] text-[#52627b]">
              <StatusBadge status="verified" label={t("loginEmailVerified")} />
              {t("verifiedNote")}
            </p>
          ) : (
            <div>
              <p className="text-[12px] leading-6 text-[#6f7f95]">{t("unverifiedNote")}</p>
              {error && <p className="mt-2 text-[12px] text-[#e54955]" role="alert">{error}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={() => void send()} loading={pending}>
                  {t("sendCode")}
                </Button>
                {(challengeId || acceptance) && (
                  <>
                    <Input
                      className="h-9 w-[140px] text-center tracking-[0.25em]"
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      inputMode="numeric"
                      maxLength={6}
                      autoComplete="one-time-code"
                      aria-label={t("code")}
                      placeholder="000000"
                    />
                    <Button onClick={() => void verify()} loading={pending} disabled={code.length !== 6}>
                      {t("verify")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </Panel>
        <PasswordPanel session={session} me={me} />
        <p className="text-[11px] text-[#8d9aad]">{tc("appName")}</p>
      </div>
    </div>
  );
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
      setInfo(t("sent"));
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
      const nextHref = (updated as unknown as { registration?: { nextAction?: { href?: string } } })?.registration?.nextAction?.href;
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
    <div className="mx-auto max-w-[680px]">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} icon={Mail} />
      <Panel>
        <div className="mx-auto max-w-[430px] py-5 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]">
            <Mail size={25} />
          </span>
          <h2 className="mt-5 text-[18px] font-semibold">{t("verifyTitle")}</h2>
          <p className="mt-2 text-[12px] text-[#7d8ca0]">{displayEmail ? t("sentTo", { email: displayEmail }) : t("noPending")}</p>
          <label className="gp-field mt-7 text-left">
            <span className="sr-only">{t("codeLabel")}</span>
            <Input
              className="h-12 text-center text-[22px] tracking-[0.35em]"
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
          {error && <p className="mt-2 text-[12px] text-[#e54955]" role="alert">{error}</p>}
          {info && <Feedback tone="success" className="mt-3">{info}</Feedback>}
          <Button className="mt-5 w-full" onClick={() => void verify()} loading={pending} disabled={(!challengeId && !acceptance) || code.length !== 6}>
            {t("verify")}
          </Button>
          {!challengeId ? (
            <Button variant="secondary" className="mt-4 w-full" onClick={() => void send()} loading={pending}>
              {t("resend")}
            </Button>
          ) : (
            <button className="mt-5 text-[12px] text-[#246bfa] disabled:text-[#98a4b5]" disabled={seconds > 0 || pending} onClick={() => void send()}>
              {seconds > 0 ? t("resendWait", { seconds }) : t("resend")}
            </button>
          )}
          <p className="mt-4 text-[11px] text-[#8d9aad]">{t("verifyCodeHint")}</p>
        </div>
      </Panel>
      {me.schoolEmail.verified && (
        <Panel title={t("changeTitle")} className="mt-5">
          <p className="text-[12px] leading-6 text-[#6f7f95]">{t("changeNote")}</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="gp-field min-w-[240px] flex-1">
              {t("changeTitle")}
              <Input value={changeTarget} onChange={(event) => setChangeTarget(event.target.value)} inputMode="email" />
            </label>
            <Button variant="outline" onClick={() => void requestChange()} loading={pending} disabled={!changeTarget.trim()}>
              {t("changeSubmit")}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ---------------- 注册与审核状态 ---------------- */

const STATE_KEYS = ["disabled", "profile_required", "email_required", "review_required", "review_pending", "review_rejected", "active"] as const;

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
    <div>
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} icon={ShieldCheck} />
      <div className="gp-stack">
        <Panel>
          <div className="flex flex-wrap items-center gap-3">
            <ProgressStatusChip statusKey={progress.statusKey} statusTone={progress.statusTone} />
            <p className="text-[13px] text-[#52627b]">{t(`stateDesc.${state}`)}</p>
          </div>
        </Panel>
        <Panel title={t("basisTitle")}>
          <ul className="space-y-2 text-[12px] text-[#52627b]">
            {me.registration.verificationBasis.map((item) => (
              <li key={item.kind} className="flex items-center gap-2">
                <ShieldCheck size={15} className="text-[#15ac70]" />
                {t(`basis.${item.kind}`)}
              </li>
            ))}
          </ul>
          <div className="gp-divider" />
          <div className="flex items-center gap-2 text-[12px] text-[#52627b]">
            <AlertCircle size={15} className="text-[#c78a1c]" />
            {t("academicTitle")}：<span>{t(`academic.${me.registration.academicIdentityStatus}`)}</span>
          </div>
        </Panel>
        {me.user.requestedIdentity === "teacher" && (
          <Panel title={t("applicationTitle")}>
            <p className="text-[12px] leading-6 text-[#6f7f95]">{t("applicationNote")}</p>
            {me.teacherApplication?.status === "rejected" && me.teacherApplication.reason && (
              <Feedback tone="warning" className="mt-3">
                {t("applicationReason")}：{me.teacherApplication.reason}
              </Feedback>
            )}
            {error && <Feedback tone="error" className="mt-3">{error}</Feedback>}
            {(me.registration.teacherReviewStatus === "review_required" || me.registration.teacherReviewStatus === "review_rejected") && (
              <Button className="mt-4" onClick={() => void submitApplication()} loading={pending}>
                {me.registration.teacherReviewStatus === "review_rejected" ? t("resubmit") : t("submitApplication")}
              </Button>
            )}
            {me.registration.teacherReviewStatus === "review_pending" && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <StatusBadge status="pending_verification" />
                {/* 审核等待期提供刷新入口；窗口重获焦点时 useMe 也会自动重读 */}
                <Button variant="outline" size="sm" onClick={() => void refetch()}>
                  <RotateCw size={13} />{t("applicationRefresh")}
                </Button>
              </div>
            )}
            <Button variant="outline" className="mt-4 ml-2" onClick={() => router.push("/account/profile")}>
              {tc("back")}
            </Button>
          </Panel>
        )}
      </div>
    </div>
  );
}
