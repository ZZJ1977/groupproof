"use client";

import { useLocale } from "next-intl";
import en from "./catalog/en.json";
import zhHant from "./catalog/zh-Hant.json";

type Value = string | number | boolean | null | undefined;
const catalogs: Record<string, Record<string, string>> = { en, "zh-Hant": zhHant };

/** Localize the restored course/project UI without changing the global JSX runtime. */
export function useUiText() {
  const locale = useLocale();
  const catalog = catalogs[locale];
  const translate = (source: string) => catalog?.[source] ?? source;
  return (source: string, values?: Record<string | number, Value>): string => {
    const template = translate(source);
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!(key in values)) return match;
      const value = values[key];
      return value === null || value === undefined || value === false ? "" : String(value);
    });
  };
}
