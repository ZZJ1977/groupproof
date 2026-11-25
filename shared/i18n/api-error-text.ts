import enMessages from "./messages/en.json";
import zhHansMessages from "./messages/zh-Hans.json";
import zhHantMessages from "./messages/zh-Hant.json";
import { getUiLocale, translateText } from "./tr";

type ErrorMessagesBundle = {
  apiErrors?: Record<string, string>;
  b?: {
    errors?: Record<string, string>;
  };
};

const messages: Record<string, ErrorMessagesBundle> = {
  "zh-Hans": zhHansMessages as ErrorMessagesBundle,
  "zh-Hant": zhHantMessages as ErrorMessagesBundle,
  en: enMessages as ErrorMessagesBundle,
};

const HAN = /[㐀-鿿]/;

/**
 * Translate an API or runtime error according to the active UI locale.
 * Preserves raw backend messages in zh-Hans, and resolves code / catalog / HTTP status / DEFAULT
 * in en and zh-Hant so untranslated Simplified Chinese never leaks into those locales.
 */
export function apiErrorText(error: unknown): string {
  const record =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; status?: unknown })
      : null;
  const code = typeof record?.code === "string" && record.code ? record.code : undefined;
  const status =
    typeof record?.status === "number" && Number.isFinite(record.status)
      ? record.status
      : undefined;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  const locale = getUiLocale();
  if (locale === "zh-Hans" || !(locale in messages)) {
    return message || "操作失败，请稍后重试。";
  }

  const bundle = messages[locale];

  // a) apiErrors[code]
  if (code) {
    const apiHit = bundle.apiErrors?.[code];
    if (apiHit) return apiHit;

    // b) b.errors[code]
    const bHit = bundle.b?.errors?.[code];
    if (bHit) return bHit;
  }

  // c) translateText(message) only if translated OR message contains no Han characters
  if (message) {
    const translated = translateText(message);
    if (
      (translated !== message || !HAN.test(message)) &&
      (locale !== "en" || !HAN.test(translated))
    ) {
      return translated;
    }
  }

  // d) apiErrors[`STATUS_${status}`]
  if (status !== undefined) {
    const statusHit = bundle.apiErrors?.[`STATUS_${status}`];
    if (statusHit) return statusHit;
  }

  // e) b.errors.DEFAULT
  return (
    bundle.b?.errors?.DEFAULT ??
    (locale === "en" ? "Something went wrong. Please try again later." : "操作失敗，請稍後重試。")
  );
}

/** Look up an error message strictly by error code across all supported locales. */
export function apiErrorCodeText(code: string): string {
  const locale = getUiLocale();
  const bundle = messages[locale] ?? messages["zh-Hans"];
  const hit =
    bundle.apiErrors?.[code] ??
    bundle.b?.errors?.[code] ??
    messages["zh-Hans"].apiErrors?.[code] ??
    messages["zh-Hans"].b?.errors?.[code];
  if (hit) return hit;
  return bundle.b?.errors?.DEFAULT ?? "操作失败，请稍后重试。";
}
