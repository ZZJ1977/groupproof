"use client";

import Link from "next/link";
import { PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Shown for a B page when `bworkspace=real` but that page's API has not landed yet.
 * Real mode must never fall back to demo data, so this is an explicit empty state.
 */
export function BNotConnectedPage({ screen }: { screen: number }) {
  const t = useTranslations("b.notConnected");
  return (
    <div role="status" data-testid="b-not-connected" data-screen={screen} className="mx-auto mt-20 max-w-[530px] text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#eaf2ff] text-[#246bfa]"><PlugZap size={25} aria-hidden /></span>
      <h1 className="mt-5 text-[22px] font-semibold">{t("title")}</h1>
      <p className="mt-2 text-[13px] text-[#75849a]">{t("description")}</p>
      <Link href="/home" className="gp-link mt-4 inline-block">{t("back")}</Link>
    </div>
  );
}
