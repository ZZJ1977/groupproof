"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { authClient } from "@/lib/api/auth-client";
import { ADMIN_ENVIRONMENT_COOKIE, type AdminEnvironment, normalizeAdminEnvironment } from "@/lib/admin-environment";
import { useApp } from "@/components/app-providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function readEnvironment(): AdminEnvironment {
  if (typeof document === "undefined") return "develop";
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_ENVIRONMENT_COOKIE}=`))?.split("=")[1];
  return normalizeAdminEnvironment(value);
}

export function AdminEnvironmentSwitcher() {
  const t = useTranslations("shell");
  const { session } = useApp();
  const [environment, setEnvironment] = useState<AdminEnvironment>("develop");
  const [pendingTarget, setPendingTarget] = useState<AdminEnvironment | null>(null);
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
    setPendingTarget(null);
    setSwitchError(true);
  }

  const isProd = environment === "main";
  const targetLabel = pendingTarget ? t(pendingTarget === "main" ? "adminEnvironment.main" : "adminEnvironment.develop") : "";

  return (
    <div className="gp-admin-environment">
      <label
        className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
          isProd
            ? "border-amber-300 bg-amber-50 text-amber-900"
            : "border-[#dfe6ef] bg-white text-[#475569]"
        }`}
        title={t("adminEnvironment.description")}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${isProd ? "bg-amber-600" : "bg-blue-600"}`}
          aria-hidden="true"
        />
        <span className="hidden whitespace-nowrap xl:inline">{t("adminEnvironment.label")}</span>
        <select
          aria-label={t("adminEnvironment.label")}
          value={environment}
          disabled={switching}
          onChange={(event) => {
            const next = event.target.value as AdminEnvironment;
            if (next !== environment) setPendingTarget(next);
          }}
          className="cursor-pointer whitespace-nowrap bg-transparent font-semibold outline-none"
        >
          <option value="develop">{t("adminEnvironment.develop")}</option>
          <option value="main">{t("adminEnvironment.main")}</option>
        </select>
      </label>
      {switchError && (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="text-[11px] text-rose-600" role="alert">{t("adminEnvironment.switchFailed")}</span>
          <button
            type="button"
            className="gp-admin-environment-retry"
            onClick={() => void switchEnvironment(environment === "main" ? "develop" : "main")}
          >
            {t("adminEnvironment.retry")}
          </button>
        </div>
      )}
      <Dialog open={Boolean(pendingTarget)} onOpenChange={(open) => { if (!open && !switching) setPendingTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle size={18} className={pendingTarget === "main" ? "text-amber-600" : "text-blue-600"} />
              <span>{t("adminEnvironment.confirmTitle")}</span>
            </DialogTitle>
            <DialogDescription>
              {t("adminEnvironment.confirmBody", { target: targetLabel })}
            </DialogDescription>
          </DialogHeader>
          {pendingTarget === "main" && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <span>{t("adminEnvironment.confirmProdWarning")}</span>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={switching} onClick={() => setPendingTarget(null)}>
              {t("adminEnvironment.cancelAction")}
            </Button>
            <Button
              type="button"
              variant={pendingTarget === "main" ? "destructive" : "default"}
              loading={switching}
              onClick={() => { if (pendingTarget) void switchEnvironment(pendingTarget); }}
            >
              {t("adminEnvironment.confirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AdminProductionBanner() {
  const t = useTranslations("shell");
  const [isProd, setIsProd] = useState(false);

  useEffect(() => {
    setIsProd(readEnvironment() === "main");
  }, []);

  if (!isProd) return null;
  return (
    <div className="gp-admin-prod-banner" role="status">
      <ShieldAlert size={15} className="shrink-0" aria-hidden="true" />
      <span>{t("adminEnvironment.prodBanner")}</span>
    </div>
  );
}
