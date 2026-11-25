import { apiErrorText } from "@/shared/i18n/api-error-text";

/** Shared class names for B/D student workspace pages (modern rounded controls, soft borders). */
export const button = "inline-flex shrink-0 whitespace-nowrap min-h-9 items-center justify-center gap-2 rounded-lg border border-transparent bg-[var(--gp-action)] px-4 py-2 text-sm font-semibold text-white shadow-xs transition-all hover:bg-[var(--gp-action-hover)] hover:shadow-sm active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50";
export const secondary = "inline-flex shrink-0 whitespace-nowrap min-h-9 items-center justify-center gap-2 rounded-lg border border-slate-200/90 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-2xs transition-all hover:border-slate-300 hover:bg-slate-50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50";
export const dangerButton = "inline-flex shrink-0 whitespace-nowrap min-h-9 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm font-semibold text-rose-700 transition-all hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50";
export const input = "w-full rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:bg-slate-50 disabled:text-slate-500";
export const label = "mb-1.5 block text-xs font-semibold text-slate-600";
export const queryPolicy = { retry: false, refetchOnWindowFocus: false } as const;
export const card = "rounded-2xl border border-slate-200/75 bg-white/95 p-5 shadow-xs";
export const dateOnly = (value: string | null | undefined, fallback = "未设置") => (value ? value.slice(0, 10) : fallback);
export const dateTime = (value: string | null | undefined, fallback = "未设置") =>
  value ? value.slice(0, 16).replace("T", " ") : fallback;
export const errorText = (error: unknown): string => apiErrorText(error);
