import type { Metadata } from "next";
import { RegistrationProfilePage } from "@/features/auth/RegistrationProfilePage";
import { sanitizeReturnTo } from "@/lib/auth/return-to";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({ searchParams }: {
  searchParams: Promise<{ tx?: string | string[]; returnTo?: string | string[] }>;
}) {
  const { tx, returnTo } = await searchParams;
  const txId = typeof tx === "string" && /^[A-Za-z0-9_-]{32}$/.test(tx) ? tx : null;
  return <RegistrationProfilePage txId={txId} returnTo={typeof returnTo === "string" ? sanitizeReturnTo(returnTo) : null} />;
}
