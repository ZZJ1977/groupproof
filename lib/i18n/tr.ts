import en from "./catalog/en";
import zhHant from "./catalog/zh-Hant";

/**
 * Source-text catalog: UI text written in Simplified Chinese is the key; en / zh-Hant
 * hold the translations. Used by tr() and by the JSX runtime (./jsx-runtime) that
 * translates whole Chinese strings when they are rendered.
 */
const catalogs: Record<string, Record<string, string>> = { en, "zh-Hant": zhHant };
let active: Record<string, string> | null = null;

/** Called by AppProviders on every render with the request/UI locale. */
export function setUiLocale(locale: string) {
  active = catalogs[locale] ?? null;
}

const HAN = /[㐀-鿿]/;

/** Translate a whole string if it is a known source text; otherwise return it unchanged. */
export function translateText(value: string): string {
  if (!active || !HAN.test(value)) return value;
  const hit = active[value];
  if (hit !== undefined) return hit;
  // Catalog keys are trimmed; keep the caller's surrounding whitespace.
  const trimmed = value.trim();
  if (trimmed !== value) {
    const inner = active[trimmed];
    if (inner !== undefined) {
      const at = value.indexOf(trimmed);
      return value.slice(0, at) + inner + value.slice(at + trimmed.length);
    }
  }
  return value;
}

type Value = string | number | boolean | null | undefined;

/**
 * Translate a source template with {0}/{name} placeholders, then fill them in.
 * String values that are themselves known source texts are translated too.
 */
export function tr(template: string, values?: Record<string | number, Value>): string {
  const text = translateText(template);
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in values)) return match;
    const value = values[name];
    if (value === null || value === undefined || value === false) return "";
    return typeof value === "string" ? translateText(value) : String(value);
  });
}
