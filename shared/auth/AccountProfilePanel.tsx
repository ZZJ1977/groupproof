"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight, BadgeCheck, LockKeyhole, Mail, UserRound } from "lucide-react";
import { Feedback, SaveState } from "@/shared/components/common";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { useAccountSession } from "@/shared/components/account-session";
import { ApiError, authClient, type MeDTO, type SessionDTO } from "@/shared/auth/auth-client";
import { CollaborationAccountsCard } from "@/shared/auth/CollaborationAccountsPanel";

const fieldClass = "flex min-w-0 flex-col gap-1.5 text-xs font-medium text-[var(--gp-ink-soft)]";
const controlClass = "h-9 w-full rounded-lg px-3 text-xs";

export function AccountProfilePanel({
  session,
  me,
  refetch,
  rightSlot,
}: {
  session: SessionDTO;
  me: MeDTO;
  refetch: () => unknown;
  rightSlot?: ReactNode;
}) {
  const { refreshSession, setSession } = useAccountSession();
  const t = useTranslations("account.profile");
  const tr = useTranslations("registrationProfile");
  const tc = useTranslations("common");
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const saving = useRef(false);
  const version = useRef(me.user.version);
  const username = useRef(me.user.username);
  const [form, setForm] = useState({
    name: me.user.name ?? "",
    studentId: me.user.studentId ?? "",
    college: me.user.college ?? "",
    requestedIdentity: me.user.requestedIdentity ?? "student",
    schoolEmail: me.schoolEmail.pendingEmail ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    version.current = me.user.version;
    username.current = me.user.username;
  }, [me.user.version, me.user.username]);

  const pending = saveState === "saving";
  const identityLocked = Boolean(
    me.user.requestedIdentity && me.user.roles.some((role) => role === "student" || role === "teacher"),
  );
  const isStudent = form.requestedIdentity === "student";
  const isActive = session.accountState === "active" && session.sessionScope === "full";
  const email = me.schoolEmail.verified ? me.schoolEmail.verifiedEmail ?? "" : form.schoolEmail;

  const set = (name: keyof typeof form) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((current) => ({ ...current, [name]: event.target.value }));
    setSaveState("dirty");
    setErrors((current) => ({
      ...current,
      [name]: "",
      ...(name === "requestedIdentity" ? { schoolEmail: "", studentId: "" } : {}),
    }));
    setNotice(null);
  };
  const errorText = (name: string) => {
    const code = errors[name];
    return code ? (t.has(`errors.${code}`) ? t(`errors.${code}`) : tr("invalidField")) : null;
  };
  const errorFor = (name: string) =>
    errorText(name) ? (
      <span id={`profile-${name}-error`} className="text-xs font-normal text-[var(--gp-danger)]" role="alert">
        {errorText(name)}
      </span>
    ) : null;
  const invalidProps = (name: string, hint?: string) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": [hint, errors[name] ? `profile-${name}-error` : null].filter(Boolean).join(" ") || undefined,
  });

  const submit = async (continueAfter: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setSaveState("saving");
    setNotice(null);
    setErrors({});
    let profileSaved = false;
    let fieldToFocus: string | undefined;
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        college: form.college,
        expectedVersion: version.current,
      };
      // Existing usernames remain valid login credentials. Accounts without one
      // receive the same internal identifier format used by email registration.
      if (!username.current) body.username = `u-${me.user.id.replaceAll("-", "").slice(0, 30)}`;
      if (!identityLocked) body.requestedIdentity = form.requestedIdentity;
      if (isStudent) body.studentId = form.studentId;
      else if (me.user.studentId) body.studentId = null;
      if (!me.schoolEmail.verified) body.schoolEmail = form.schoolEmail.trim();
      const updated = await authClient.updateProfile(session.csrfToken ?? "", body);
      profileSaved = true;
      version.current = updated.user.version;
      username.current = updated.user.username;
      await refetch();
      const currentSession = await refreshSession();
      if (!continueAfter) {
        setSaveState("saved");
        setNotice({ tone: "success", text: t("saveAndExitDone") });
        return;
      }
      setNotice({ tone: "success", text: t("savedNext") });
      if (updated.registration.canEnterWorkspace) {
        // Re-check eligibility and upgrade the session before entering the workspace.
        const refreshed = await authClient.refresh(currentSession.csrfToken ?? "");
        setSession(refreshed);
        setSaveState("saved");
        if (refreshed.accountState === "active" && refreshed.sessionScope === "full") {
          router.push("/home");
          router.refresh();
          return;
        }
        const next = refreshed.nextAction?.href;
        router.push(next && /^\/account\/(profile|email|status|security)$/.test(next) ? next : "/account/status");
        return;
      }
      const next = updated.registration.nextAction?.href;
      setSaveState("saved");
      router.push(next && /^\/account\/(profile|email|status|security)$/.test(next) ? next : "/account/status");
    } catch (error) {
      setSaveState("error");
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        setErrors({ version: "version_conflict" });
      } else if (error instanceof ApiError && Object.keys(error.fieldErrors).length) {
        setErrors(error.fieldErrors);
        fieldToFocus = Object.keys(error.fieldErrors)[0];
        setNotice({ tone: "error", text: tr("checkFields") });
      } else {
        setNotice({ tone: "error", text: t(profileSaved ? "continueFailed" : "saveFailed") });
      }
    } finally {
      saving.current = false;
      if (fieldToFocus) {
        window.requestAnimationFrame(() => {
          const input = formRef.current?.elements.namedItem(fieldToFocus!);
          if (input instanceof HTMLElement) input.focus();
        });
      }
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(true);
  };

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--gp-ink)]">{t("title")}</h1>
        <p className="mt-0.5 text-xs leading-5 text-[var(--gp-ink-soft)]">{t("description")}</p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,1fr)]">
        {/* 左栏：身份资料 + 外部协作账号（GitHub & 飞书） */}
        <div className="min-w-0 space-y-4">
          <form
            id="account-profile-form"
            ref={formRef}
            onSubmit={onSubmit}
            className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--gp-ink)]">
                <UserRound size={15} className="text-primary" aria-hidden="true" />
                {tr("identitySection")}
              </h2>
            </div>

            <fieldset className="p-4" disabled={pending}>
              <legend className="sr-only">{t("title")}</legend>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <label className={fieldClass}>
                  <span>{t("name")}</span>
                  <Input
                    name="name"
                    value={form.name}
                    onChange={set("name")}
                    autoComplete="name"
                    required
                    maxLength={80}
                    className={controlClass}
                    {...invalidProps("name")}
                  />
                  {errorFor("name")}
                </label>
                <label className={fieldClass}>
                  <span>{tr("identity")}</span>
                  <select
                    name="requestedIdentity"
                    value={form.requestedIdentity}
                    onChange={set("requestedIdentity")}
                    disabled={identityLocked || pending}
                    className={`${controlClass} border border-border bg-white text-[var(--gp-ink)] focus-visible:border-[#80aafc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e9f1ff] disabled:bg-slate-50`}
                    {...invalidProps("requestedIdentity", identityLocked ? "profile-identity-locked" : undefined)}
                  >
                    <option value="student">{tr("student")}</option>
                    <option value="teacher">{tr("teacher")}</option>
                  </select>
                  {errorFor("requestedIdentity")}
                </label>
                {isStudent && (
                  <label className={fieldClass}>
                    <span>{t("studentId")}</span>
                    <Input
                      name="studentId"
                      value={form.studentId}
                      onChange={set("studentId")}
                      required
                      maxLength={80}
                      className={controlClass}
                      {...invalidProps("studentId")}
                    />
                    {errorFor("studentId")}
                  </label>
                )}
                <label className={fieldClass}>
                  <span>{t("college")}</span>
                  <Input
                    name="college"
                    value={form.college}
                    onChange={set("college")}
                    maxLength={160}
                    className={controlClass}
                    {...invalidProps("college")}
                  />
                  {errorFor("college")}
                </label>
              </div>

              {identityLocked && (
                <p id="profile-identity-locked" className="mt-2.5 text-[11px] leading-4 text-[var(--gp-ink-soft)]">
                  {t("identityLockedNote")}
                </p>
              )}
              {!isStudent && (
                <p className="mt-2.5 text-[11px] leading-4 text-[var(--gp-ink-soft)]">{t("notices.teacher")}</p>
              )}
              <p className="mt-2 text-[11px] leading-4 text-[var(--gp-muted)]">{t("declarativeNotice")}</p>
            </fieldset>

            {errors.version && (
              <div className="px-4 pb-3">
                <Feedback tone="error">{t("errors.version_conflict")}</Feedback>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.location.reload()}
                >
                  {t("reloadProfile")}
                </Button>
              </div>
            )}
            {errors.username && (
              <div className="px-4 pb-3">
                <Feedback tone="error">{t("saveFailed")}</Feedback>
              </div>
            )}
            {notice && (
              <div className="px-4 pb-3">
                <Feedback tone={notice.tone}>{notice.text}</Feedback>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border bg-slate-50/70 px-4 py-2.5">
              <SaveState state={saveState} />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    if (formRef.current?.reportValidity()) void submit(false);
                  }}
                >
                  {tc("save")}
                </Button>
                <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
                  {pending ? t("saving") : tc("saveAndContinue")}
                  <ArrowRight size={14} aria-hidden="true" />
                </Button>
              </div>
            </div>
          </form>

          {isActive && <CollaborationAccountsCard session={session} me={me} refetch={refetch} />}
        </div>

        {/* 右栏：学校邮箱 + 账号与安全摘要 + 我的访问申请 */}
        <div className="min-w-0 space-y-4">
          <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--gp-ink)]">
                <Mail size={15} className="text-primary" aria-hidden="true" />
                {t("emailSection")}
              </h2>
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                  me.schoolEmail.verified
                    ? "bg-teal-50 text-[var(--gp-success)]"
                    : "bg-slate-100 text-[var(--gp-ink-soft)]"
                }`}
              >
                {me.schoolEmail.verified && <BadgeCheck size={13} aria-hidden="true" />}
                {me.schoolEmail.verified ? tr("verified") : t("emailPending")}
              </span>
            </div>
            <div className="p-4">
              <label className={fieldClass}>
                <span>{t("schoolEmail")}</span>
                <Input
                  form="account-profile-form"
                  name="schoolEmail"
                  type="email"
                  value={email}
                  onChange={set("schoolEmail")}
                  autoComplete="email"
                  required
                  disabled={pending}
                  readOnly={me.schoolEmail.verified}
                  className={controlClass}
                  {...invalidProps("schoolEmail", "profile-email-hint")}
                />
                {errorFor("schoolEmail")}
              </label>
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                <p id="profile-email-hint" className="text-[11px] leading-4 text-[var(--gp-ink-soft)]">
                  {t(me.schoolEmail.verified ? "emailVerifiedNote" : "emailPendingNote")}
                </p>
                {me.schoolEmail.verified && (
                  <Link href="/account/email" className="gp-link shrink-0 text-xs font-semibold">
                    {t("changeSchoolEmail")}
                  </Link>
                )}
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--gp-ink)]">
                <LockKeyhole size={15} className="text-primary" aria-hidden="true" />
                {t("securitySection")}
              </h2>
              <Link href="/account/security" className="gp-link inline-flex items-center gap-1 text-xs font-semibold">
                {t("manageSecurity")}
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </div>
            <div className="space-y-2 p-4">
              <p className="text-xs leading-5 text-[var(--gp-ink-soft)]">
                {t(me.user.passwordLoginEnabled ? "passwordConfigured" : "passwordNotSet")}
              </p>
              {me.user.googleEmailBound && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--gp-ink-soft)]">
                  <span className="inline-flex items-center gap-1 rounded-md bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-[var(--gp-success)]">
                    <BadgeCheck size={13} aria-hidden="true" />
                    {t("googleBound")} · {t("bound")}
                  </span>
                  {me.user.googleEmail && <span className="break-all font-mono text-[11px]">{me.user.googleEmail}</span>}
                </div>
              )}
            </div>
          </section>

          {rightSlot}
        </div>
      </div>
    </div>
  );
}
