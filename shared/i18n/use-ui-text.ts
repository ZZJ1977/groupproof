"use client";

import { useLocale } from "next-intl";
import { tr } from "./tr";

type Value = string | number | boolean | null | undefined;

/** Localize the restored course/project UI using the unified catalog and argument translation. */
export function useUiText() {
  useLocale();
  return (source: string, values?: Record<string | number, Value>): string => tr(source, values);
}
