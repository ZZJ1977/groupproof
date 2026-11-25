"use client";

import { useTranslations } from "next-intl";
import { BApiError } from "@/student/api/b-client";
import { apiErrorText } from "@/shared/i18n/api-error-text";

/** Translate a B API error code; unknown codes fall back to apiErrorText. */
export function useBErrorMessage() {
  const t = useTranslations("b.errors");
  return (error: unknown): string => {
    const code = error instanceof BApiError ? error.code : "DEFAULT";
    return t.has(code) ? t(code) : apiErrorText(error);
  };
}
