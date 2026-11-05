"use client";

import { useTranslations } from "next-intl";
import { BApiError } from "@/lib/api/b-client";

/** Translate a B API error code; unknown codes fall back to a generic message. */
export function useBErrorMessage() {
  const t = useTranslations("b.errors");
  return (error: unknown): string => {
    const code = error instanceof BApiError ? error.code : "DEFAULT";
    return t.has(code) ? t(code) : t("DEFAULT");
  };
}
