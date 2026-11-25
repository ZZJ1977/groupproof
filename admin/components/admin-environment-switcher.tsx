"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { authClient } from "@/shared/auth/auth-client";
import { ADMIN_ENVIRONMENT_COOKIE, type AdminEnvironment, normalizeAdminEnvironment } from "@/admin/lib/admin-environment";
import { useApp } from "@/shared/components/app-providers";

function readEnvironment(): AdminEnvironment {
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_ENVIRONMENT_COOKIE}=`))?.split("=")[1];
  return normalizeAdminEnvironment(value);
}

export function AdminEnvironmentSwitcher() {
  const t = useTranslations("shell");
  const { session } = useApp();
  const [environment, setEnvironment] = useState<AdminEnvironment>("develop");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState(false);

  useEffect(() => setEnvironment(readEnvironment()), []);

  async function switchEnvironment(next: AdminEnvironment) {
    if (next === environment || switching) return;
    setSwitching(true);
    setSwitchError(false);
    try {
      await authClient.logout(session?.csrfToken);
    } catch {
      // A stale session can be replaced by the target environment's login.
    }
    try {
      const response = await fetch("/api/admin-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: next }),
      });
      if (response.ok) {
        window.location.assign("/login");
        return;
      }
    } catch {
      // Keep the current environment visible and expose a retry affordance.
    }
    setSwitching(false);
    setSwitchError(true);
  }

  return <div className="gp-admin-environment">
    <label className="flex items-center gap-2 rounded-md border border-[#dfe6ef] bg-white px-2.5 py-1.5 text-[12px] text-[#53637d]" title={t("adminEnvironment.description")}>
      <span className="hidden xl:inline">{t("adminEnvironment.label")}</span>
      <select aria-label={t("adminEnvironment.label")} value={environment} disabled={switching} onChange={(event) => void switchEnvironment(event.target.value as AdminEnvironment)} className="bg-transparent font-medium outline-none">
        <option value="develop">{t("adminEnvironment.develop")}</option>
        <option value="main">{t("adminEnvironment.main")}</option>
      </select>
    </label>
    <span className="gp-admin-environment-current" aria-live="polite">{switchError ? t("adminEnvironment.switchFailed") : t(environment === "main" ? "adminEnvironment.currentMain" : "adminEnvironment.currentDevelop")}</span>
    {switchError && <button type="button" className="gp-admin-environment-retry" onClick={() => void switchEnvironment(environment === "main" ? "develop" : "main")}>{t("adminEnvironment.retry")}</button>}
  </div>;
}
