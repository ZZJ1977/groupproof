"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, BadgeCheck, LockKeyhole, Mail, UserRound } from "lucide-react";
import { Feedback } from "@/components/common";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, authClient, type RegistrationProfileDTO } from "@/lib/api/auth-client";

function expired(error: unknown) {
  return error instanceof ApiError && [400, 401, 403, 404, 409, 410].includes(error.status);
}

const pageWidth = "mx-auto w-full max-w-[1160px] px-4 sm:px-8";
const sectionPadding = "px-5 py-6 sm:px-8 sm:py-8 lg:px-9 lg:py-9";
const field = "flex min-w-0 flex-col gap-2 text-sm font-medium text-[var(--gp-ink-soft)]";
const control = "h-12 w-full rounded-lg px-3.5 text-sm";
const identities = ["student", "teacher"] as const;

export function RegistrationProfilePage({ txId, returnTo }: { txId: string | null; returnTo: string | null }) {
  const t = useTranslations("registrationProfile");
  const loginHref = returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login";
  const profile = useQuery({
    queryKey: ["verified-registration", txId],
    queryFn: ({ signal }) => authClient.registrationProfile(txId!, signal),
    enabled: txId !== null,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="min-h-screen bg-[var(--gp-canvas)]">
      <header className="border-b border-border bg-white">
        <div className={`${pageWidth} flex min-h-16 items-center justify-between gap-3`}>
          <Link href={loginHref} className="text-xl font-bold tracking-tight">GroupProof</Link>
          <LanguageSwitcher compact />
        </div>
      </header>
      <main className={`${pageWidth} pb-12 pt-8 sm:pt-12`}>
        <div className="mb-7 sm:mb-9">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
          <p className="mt-3 max-w-prose text-sm leading-6 text-[var(--gp-ink-soft)] sm:text-base">{t("description")}</p>
        </div>
        {txId && profile.data && !profile.isError ? (
          <RegistrationProfileForm key={txId} txId={txId} profile={profile.data} loginHref={loginHref} returnTo={returnTo} />
        ) : (
          <div className="rounded-xl border border-border bg-white p-5 sm:p-7">
            {txId && profile.isPending ? (
              <p role="status" className="text-[var(--gp-ink-soft)]">{t("loading")}</p>
            ) : !txId || expired(profile.error) ? (
              <><Feedback tone="warning">{t("expired")}</Feedback><Link className="gp-link mt-4 inline-block" href={loginHref}>{t("backToLogin")}</Link></>
            ) : (
              <><Feedback tone="error">{t("unavailable")}</Feedback><Button className="mt-4" variant="outline" onClick={() => void profile.refetch()}>{t("retry")}</Button></>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function RegistrationProfileForm({ txId, profile, loginHref, returnTo }: {
  txId: string;
  profile: RegistrationProfileDTO;
  loginHref: string;
  returnTo: string | null;
}) {
  const t = useTranslations("registrationProfile");
  const profileText = useTranslations("account.profile");
  const [identity, setIdentity] = useState(profile.allowedIdentities[0]);
  const identityMatchesEmail = profile.allowedIdentities.includes(identity);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const focusField = useRef<string | null>(null);

  useEffect(() => {
    if (pending || !focusField.current) return;
    const input = formRef.current?.elements.namedItem(focusField.current);
    focusField.current = null;
    if (input instanceof HTMLElement) input.focus();
  }, [pending, errors]);

  const clearField = (field: string) => {
    setErrors((current) => ({ ...current, [field]: "", ...(field === "password" ? { confirmPassword: "" } : {}) }));
    setNotice(null);
  };

  const errorFor = (field: string) => {
    const code = errors[field];
    if (!code) return null;
    const message = t.has(code) ? t(code) : profileText.has(`errors.${code}`) ? profileText(`errors.${code}`) : t("invalidField");
    return <span id={`${field}-error`} className="text-sm font-normal text-[var(--gp-danger)]">{message}</span>;
  };

  const invalidProps = (field: string, hint?: string) => ({
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": [hint, errors[field] ? `${field}-error` : null].filter(Boolean).join(" ") || undefined,
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || blocked || !identity || !identityMatchesEmail) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const value = (name: string) => String(fields.get(name) ?? "");
    const password = value("password");
    const confirmPassword = value("confirmPassword");
    setNotice(null);
    setErrors({});
    if (password !== confirmPassword) {
      setErrors({ confirmPassword: "password_mismatch" });
      form.querySelector<HTMLInputElement>("#signup-confirm-password")?.focus();
      return;
    }
    setPending(true);
    try {
      const session = await authClient.completeEmailRegistration(txId, {
        name: value("name"), requestedIdentity: identity,
        studentId: identity === "student" ? value("studentId") : undefined,
        college: value("college"), password, confirmPassword,
      });
      if ("status" in session) {
        setNotice(t("alreadyCompleted"));
        setBlocked(true);
        return;
      }
      const next = session.accountState === "active" && session.sessionScope === "full"
        ? returnTo ?? "/home" : "/account/status";
      window.location.replace(next);
    } catch (error) {
      if (error instanceof ApiError && error.code === "EMAIL_CONFLICT") {
        setNotice(t("emailTaken"));
        setBlocked(true);
      } else if (error instanceof ApiError && Object.keys(error.fieldErrors).length) {
        setErrors(error.fieldErrors);
        setNotice(t("checkFields"));
        focusField.current = Object.keys(error.fieldErrors)[0];
      } else if (expired(error)) {
        setNotice(t("expired"));
        setBlocked(true);
      } else {
        setNotice(t("unavailable"));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-slate-50 px-5 py-4 sm:px-8 sm:py-5 lg:px-9">
        <span className="hidden size-10 shrink-0 place-items-center rounded-lg bg-[var(--gp-action-soft)] text-primary sm:grid"><Mail size={20} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 basis-52">
          <label htmlFor="signup-school-email" className="mb-1 block text-sm font-medium text-[var(--gp-ink-soft)]">{t("schoolEmail")}</label>
          <input id="signup-school-email" type="email" readOnly autoComplete="username" value={profile.email}
            className="w-full rounded-sm text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary" />
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-teal-50 px-2.5 py-1 text-xs font-medium text-[var(--gp-success)]"><BadgeCheck size={15} aria-hidden="true" />{t("verified")}</span>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className={`${sectionPadding} min-w-0 border-b border-border lg:border-r lg:border-b-0`}>
          <fieldset className="min-w-0" disabled={pending || blocked}>
            <legend className="mb-5 flex items-center gap-2.5 text-lg font-semibold sm:mb-6"><UserRound size={20} className="text-primary" aria-hidden="true" />{t("identitySection")}</legend>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 sm:gap-y-6">
              <label className={field}>
                <span id="signup-name-label">{t("name")}</span>
                <Input name="name" aria-labelledby="signup-name-label" autoComplete="name" maxLength={80} required className={control} onChange={() => clearField("name")} {...invalidProps("name")} />
                {errorFor("name")}
              </label>
              <label className={field}>
                <span id="signup-identity-label">{t("identity")}</span>
                <select name="requestedIdentity" aria-labelledby="signup-identity-label" className={`${control} border border-[#dbe3ee] bg-white text-[var(--gp-ink)] focus-visible:border-[#80aafc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e9f1ff] disabled:bg-slate-50`} value={identity ?? ""}
                  onChange={(event) => { setIdentity(event.currentTarget.value === "teacher" ? "teacher" : "student"); clearField("requestedIdentity"); clearField("schoolEmail"); }}
                  {...invalidProps("requestedIdentity", [identity === "teacher" ? "signup-teacher-note" : "", !identityMatchesEmail ? "signup-identity-email-note" : ""].filter(Boolean).join(" "))}
                  aria-invalid={!identityMatchesEmail || Boolean(errors.requestedIdentity) || undefined}>
                  {identities.map((role) => <option key={role} value={role}>{t(role)}</option>)}
                </select>
                {!identityMatchesEmail && <span id="signup-identity-email-note" role="status" className="text-sm font-normal leading-6 text-[var(--gp-danger)]">
                  {t("identityEmailMismatch", { identity: t(identity) })}{" "}
                  <Link href={loginHref} className="gp-link underline">{t("changeSchoolEmail")}</Link>
                </span>}
                {errorFor("requestedIdentity")}
              </label>
              {identity === "student" && <label className={field}>
                <span id="signup-student-id-label">{t("studentId")}</span>
                <Input name="studentId" aria-labelledby="signup-student-id-label" required className={control} onChange={() => clearField("studentId")} {...invalidProps("studentId")} />
                {errorFor("studentId")}
              </label>}
              <label className={field}>
                <span id="signup-college-label">{t("college")}</span>
                <Input name="college" aria-labelledby="signup-college-label" maxLength={160} className={control} onChange={() => clearField("college")} {...invalidProps("college")} />
                {errorFor("college")}
              </label>
            </div>
            {identity === "teacher" && <p id="signup-teacher-note" className="mt-3 text-sm leading-6 text-[var(--gp-ink-soft)]">{t("teacherNotice")}</p>}
            {errorFor("schoolEmail")}
          </fieldset>
        </div>

        <div className={`${sectionPadding} min-w-0`}>
          <fieldset className="min-w-0" disabled={pending || blocked}>
            <legend className="mb-5 flex items-center gap-2.5 text-lg font-semibold sm:mb-6"><LockKeyhole size={20} className="text-primary" aria-hidden="true" />{t("passwordSection")}</legend>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 sm:gap-y-6 lg:grid-cols-1">
              <label className={field}>
                <span id="signup-password-label">{t("password")}</span>
                <Input name="password" aria-labelledby="signup-password-label" type={showPassword ? "text" : "password"} autoComplete="new-password" required className={control} onChange={() => clearField("password")} {...invalidProps("password", "signup-password-hint")} />
                {errorFor("password")}
              </label>
              <label className={field}>
                <span id="signup-confirm-password-label">{t("confirmPassword")}</span>
                <Input id="signup-confirm-password" name="confirmPassword" aria-labelledby="signup-confirm-password-label" type={showPassword ? "text" : "password"} autoComplete="new-password" required className={control} onChange={() => clearField("confirmPassword")} {...invalidProps("confirmPassword")} />
                {errorFor("confirmPassword")}
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-[var(--gp-ink-soft)]">
              <p id="signup-password-hint">{t("password_policy")}</p>
              <label className="inline-flex min-h-8 items-center gap-2"><input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} className="size-4 accent-[var(--gp-action)]" />{t("showPassword")}</label>
            </div>
          </fieldset>
        </div>
      </div>
      {notice && <div className="px-5 pb-5 sm:px-8 lg:px-9"><Feedback tone="error">{notice}</Feedback></div>}

      <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t border-border bg-slate-50/60 px-5 py-4 sm:flex-row sm:items-center sm:px-8 sm:py-5 lg:px-9">
        <Link href={loginHref} className="gp-link py-2 text-center text-sm">{t("backToLogin")}</Link>
        <Button size="lg" className="min-h-12 px-6 text-sm" type="submit" disabled={blocked || pending || !identity || !identityMatchesEmail} aria-busy={pending || undefined}>
          {pending ? t("submitting") : t("submit")}<ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}
