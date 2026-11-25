export const locales = ["zh-Hans", "zh-Hant", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "zh-Hans";

/** 各语言用自己的名称显示选项（§8.1） */
export const localeNames: Record<Locale, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  en: "English",
};

/** 旧值映射（§8.2）：显式 Hant/Hans 脚本优先于地区 */
export const legacyLocaleMap: Record<string, Locale> = {
  zh: "zh-Hans",
  "zh-CN": "zh-Hans",
  "zh-Hans": "zh-Hans",
  "zh-TW": "zh-Hant",
  "zh-HK": "zh-Hant",
  "zh-MO": "zh-Hant",
  "zh-Hant": "zh-Hant",
  en: "en",
};

export function normalizeLocale(value?: string | null): Locale | null {
  if (!value) return null;
  const key = value.trim();
  if (legacyLocaleMap[key]) return legacyLocaleMap[key];
  const lower = key.toLowerCase();
  if (lower.startsWith("zh-hant")) return "zh-Hant";
  if (lower.startsWith("zh-hans")) return "zh-Hans";
  const base = key.split("-")[0].toLowerCase();
  if (base === "zh") return "zh-Hans";
  if (base === "en") return "en";
  return null;
}

export function pickLocaleFromAcceptLanguage(header?: string | null): Locale {
  if (!header) return defaultLocale;
  const entries = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((item) => item.trim().startsWith("q="));
      return { tag: tag.trim(), q: q ? Number.parseFloat(q.trim().slice(2)) || 0 : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const entry of entries) {
    const resolved = normalizeLocale(entry.tag);
    if (resolved) return resolved;
  }
  return defaultLocale;
}
