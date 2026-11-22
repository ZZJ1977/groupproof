"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { CApiError, createCClient } from "@/lib/api/c-client";

export const projectApi = createCClient();
export const apiButton = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-2xs transition-all hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
export const apiPrimaryButton = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--gp-action)] px-3.5 py-2 text-sm font-semibold text-white shadow-xs transition-all hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
export const apiInput = "rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-all focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15";
export const queryPolicy = { staleTime: 0, gcTime: 0, retry: false } as const;
// Both the history view and source picker read this same authorized response.
export const taskNoteQuery = (userId: string, projectId: string, taskId: string) => ({
  queryKey: ["c-task-note", userId, projectId, taskId],
  queryFn: () => projectApi.note(projectId, taskId, true),
  ...queryPolicy,
});

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const pageNumber = (value: string | null) => {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1;
};
export const accessFailure = (error: unknown): error is CApiError => error instanceof CApiError && [401, 403].includes(error.status);
export const versionFailure = (error: unknown) => error instanceof CApiError && error.status === 409;

type PageT = ReturnType<typeof useTranslations>;

export function apiErrorText(error: unknown, t: PageT) {
  if (error instanceof CApiError) {
    if ([401, 403, 404, 409, 422, 503].includes(error.status)) return t(`err${error.status}`);
  }
  return t("errDefault");
}

export function ApiFailure({ error, retry, label }: { error: unknown; retry?: () => void; label?: string }) {
  const t = useTranslations("pages.shared");
  return <div role="alert" className="my-3 rounded-md border border-red-200 p-3"><p>{apiErrorText(error, t)}</p>{retry && <button className={`${apiButton} mt-2`} type="button" onClick={retry}>{label ?? t("retry")}</button>}</div>;
}

/** Keep the key across uncertain failures; reset only after a confirmed write. */
export function useCommandKey() {
  const previous = useRef<{ fingerprint: string; key: string } | null>(null);
  const key = (payload: unknown) => {
    const fingerprint = JSON.stringify(payload);
    if (previous.current?.fingerprint !== fingerprint) previous.current = { fingerprint, key: crypto.randomUUID() };
    return previous.current.key;
  };
  return Object.assign(key, { reset: () => { previous.current = null; } });
}

/** Source URLs are display links only. Never use them as storage or API endpoints. */
export function safeHttps(value: string | null | undefined, github = false): string | null {
  if (!value || value !== value.trim() || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0];
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || authority.includes("@") || (parsed.port && parsed.port !== "443") || (github && parsed.hostname !== "github.com")) return null;
    return value;
  } catch { return null; }
}

export function ApiPager({ page, pageSize, total, change }: { page: number; pageSize: number; total: number; change: (page: number) => void }) {
  const t = useTranslations("pages.shared");
  return <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span>{t("pagerTotal", { total, page })}</span><div className="flex gap-2"><button className={apiButton} type="button" disabled={page <= 1} onClick={() => change(page - 1)}>{t("prev")}</button><button className={apiButton} type="button" disabled={page * pageSize >= total} onClick={() => change(page + 1)}>{t("next")}</button></div></div>;
}
