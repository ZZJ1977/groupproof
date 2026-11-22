"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight, BadgeCheck, LockKeyhole, Mail, UserRound } from "lucide-react";
import { Feedback, SaveState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountSession } from "@/components/account-session";
import { ApiError, authClient, type MeDTO, type SessionDTO } from "@/lib/api/auth-client";

const sectionPadding = "px-5 py-6 sm:px-8 sm:py-8 lg:px-9 lg:py-9";
const fieldClass = "flex min-w-0 flex-col gap-2 text-sm font-medium text-[var(--gp-ink-soft)]";
const controlClass = "h-12 w-full rounded-lg px-3.5 text-sm";

export function AccountProfilePanel({ session, me, refetch }: {
  session: SessionDTO;
  me: MeDTO;
  refetch: () => unknown;
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
  const pending = saveState === "saving";
  const identityLocked = Boolean(me.user.requestedIdentity && me.user.roles.some((role) => role === "student" || role === "teacher"));
  const isStudent = form.requestedIdentity === "student";
  const email = me.schoolEmail.verified ? me.schoolEmail.verifiedEmail ?? "" : form.schoolEmail;

  const set = (name: keyof typeof form) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((current) => ({ ...current, [name]: event.target.value }));
    setSaveState("dirty");
    setErrors((current) => ({ ...current, [name]: "", ...(name === "requestedIdentity" ? { schoolEmail: "", studentId: "" } : {}) }));
    setNotice(null);
  };
  const errorText = (name: string) => {
    const code = errors[name];
    return code ? t.has(`errors.${code}`) ? t(`errors.${code}`) : tr("invalidField") : null;
  };
  const errorFor = (name: string) => errorText(name)
    ? <span id={`profile-${name}-error`} className="text-sm font-normal text-[var(--gp-danger)]" role="alert">{errorText(name)}</span> : null;
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
      const body: Record<string, unknown> = { name: form.name, college: form.college, expectedVersion: version.current };
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
    <div>
      <div className="mb-7 sm:mb-9">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
        <p className="mt-3 max-w-prose text-sm leading-6 text-[var(--gp-ink-soft)] sm:text-base">{t("description")}</p>
      </div>
      <form ref={formRef} onSubmit={onSubmit} className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-slate-50 px-5 py-4 sm:px-8 sm:py-5 lg:px-9">
          <span className="hidden size-10 shrink-0 place-items-center rounded-lg bg-[var(--gp-action-soft)] text-primary sm:grid"><Mail size={20} aria-hidden="true" /></span>
          <div className="min-w-0 flex-1 basis-52">
            <p className="mb-1 text-sm font-medium text-[var(--gp-ink-soft)]">{t("schoolEmail")}</p>
            <p className="break-all text-sm font-semibold">{email || t("emailNotProvided")}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${me.schoolEmail.verified ? "bg-teal-50 text-[var(--gp-success)]" : "bg-slate-100 text-[var(--gp-ink-soft)]"}`}>
            {me.schoolEmail.verified && <BadgeCheck size={15} aria-hidden="true" />}{me.schoolEmail.verified ? tr("verified") : t("emailPending")}
          </span>
        </div>
        <fieldset className="grid min-w-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]" disabled={pending}>
          <legend className="sr-only">{t("title")}</legend>
          <div className={`${sectionPadding} min-w-0 border-b border-border lg:border-r lg:border-b-0`}>
            <h2 className="mb-5 flex items-center gap-2.5 text-lg font-semibold sm:mb-6"><UserRound size={20} className="text-primary" aria-hidden="true" />{tr("identitySection")}</h2>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 sm:gap-y-6">
              <label className={fieldClass}>
                <span>{t("name")}</span>
                <Input name="name" value={form.name} onChange={set("name")} autoComplete="name" required maxLength={80} className={controlClass} {...invalidProps("name")} />
                {errorFor("name")}
              </label>
              <label className={fieldClass}>
                <span>{tr("identity")}</span>
                <select name="requestedIdentity" value={form.requestedIdentity} onChange={set("requestedIdentity")} disabled={identityLocked || pending}
                  className={`${controlClass} border border-border bg-white text-[var(--gp-ink)] focus-visible:border-[#80aafc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e9f1ff] disabled:bg-slate-50`}
                  {...invalidProps("requestedIdentity", identityLocked ? "profile-identity-locked" : undefined)}>
                  <option value="student">{tr("student")}</option><option value="teacher">{tr("teacher")}</option>
                </select>
                {errorFor("requestedIdentity")}
              </label>
              {isStudent && <label className={fieldClass}>
                <span>{t("studentId")}</span>
                <Input name="studentId" value={form.studentId} onChange={set("studentId")} required maxLength={80} className={controlClass} {...invalidProps("studentId")} />
                {errorFor("studentId")}
              </label>}
              <label className={fieldClass}>
                <span>{t("college")}</span>
                <Input name="college" value={form.college} onChange={set("college")} maxLength={160} className={controlClass} {...invalidProps("college")} />
                {errorFor("college")}
              </label>
            </div>
            {identityLocked && <p id="profile-identity-locked" className="mt-4 text-sm leading-6 text-[var(--gp-ink-soft)]">{t("identityLockedNote")}</p>}
            {!isStudent && <p className="mt-4 text-sm leading-6 text-[var(--gp-ink-soft)]">{t("notices.teacher")}</p>}
            <p className="mt-5 text-sm leading-6 text-[var(--gp-muted)]">{t("declarativeNotice")}</p>
          </div>
          <div className={`${sectionPadding} min-w-0`}>
            <h2 className="mb-5 flex items-center gap-2.5 text-lg font-semibold sm:mb-6"><Mail size={20} className="text-primary" aria-hidden="true" />{t("emailSection")}</h2>
            <label className={fieldClass}>
              <span>{t("schoolEmail")}</span>
              <Input name="schoolEmail" type="email" value={email} onChange={set("schoolEmail")} autoComplete="email" required readOnly={me.schoolEmail.verified}
                className={controlClass} {...invalidProps("schoolEmail", "profile-email-hint")} />
              {errorFor("schoolEmail")}
            </label>
            <p id="profile-email-hint" className="mt-3 text-sm leading-6 text-[var(--gp-ink-soft)]">{t(me.schoolEmail.verified ? "emailVerifiedNote" : "emailPendingNote")}</p>
            {me.schoolEmail.verified && <Link href="/account/email" className="gp-link mt-2 inline-block text-sm">{t("changeSchoolEmail")}</Link>}
            <div className="mt-7 border-t border-border pt-6">
              <h2 className="flex items-center gap-2.5 text-lg font-semibold"><LockKeyhole size={20} className="text-primary" aria-hidden="true" />{t("securitySection")}</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--gp-ink-soft)]">{t(me.user.passwordLoginEnabled ? "passwordConfigured" : "passwordNotSet")}</p>
              <Link href="/account/security" className="gp-link mt-2 inline-flex items-center gap-1.5 text-sm">{t("manageSecurity")}<ArrowRight size={15} aria-hidden="true" /></Link>
            </div>
          </div>
        </fieldset>
        {errors.version && <div className="px-5 pb-5 sm:px-8 lg:px-9"><Feedback tone="error">{t("errors.version_conflict")}</Feedback><Button type="button" variant="outline" className="mt-3" onClick={() => window.location.reload()}>{t("reloadProfile")}</Button></div>}
        {errors.username && <div className="px-5 pb-5 sm:px-8 lg:px-9"><Feedback tone="error">{t("saveFailed")}</Feedback></div>}
        {notice && <div className="px-5 pb-5 sm:px-8 lg:px-9"><Feedback tone={notice.tone}>{notice.text}</Feedback></div>}
        <div className="flex flex-col items-stretch justify-between gap-4 border-t border-border bg-slate-50/60 px-5 py-4 sm:flex-row sm:items-center sm:px-8 sm:py-5 lg:px-9">
          <SaveState state={saveState} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="button" variant="outline" size="lg" className="min-h-12 px-6 text-sm" disabled={pending} onClick={() => { if (formRef.current?.reportValidity()) void submit(false); }}>{tc("save")}</Button>
            <Button type="submit" size="lg" className="min-h-12 px-6 text-sm" disabled={pending} aria-busy={pending || undefined}>{pending ? t("saving") : tc("saveAndContinue")}<ArrowRight size={16} aria-hidden="true" /></Button>
          </div>
        </div>
      </form>
    </div>
  );
}
