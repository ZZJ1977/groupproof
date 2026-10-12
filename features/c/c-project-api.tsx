"use client";

import { useRef } from "react";
import { CApiError, createCClient } from "@/lib/api/c-client";

export const projectApi = createCClient();
export const apiButton = "rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50";
export const apiInput = "rounded-md border border-slate-300 px-3 py-2 text-sm";
export const queryPolicy = { staleTime: 0, gcTime: 0, retry: false } as const;

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const pageNumber = (value: string | null) => {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1;
};
export const accessFailure = (error: unknown): error is CApiError => error instanceof CApiError && [401, 403].includes(error.status);
export const versionFailure = (error: unknown) => error instanceof CApiError && error.status === 409;

export function apiErrorText(error: unknown) {
  if (error instanceof CApiError) {
    if (error.status === 401) return "当前登录身份无法读取此服务，请重新登录或重试。";
    if (error.status === 403) return "当前访问权限已失效，项目数据已隐藏。";
    if (error.status === 404) return "这条记录不存在，或已不在当前项目中。";
    if (error.status === 409) return "记录已变化，请刷新并核对当前状态；输入已保留。";
    if (error.status === 422) return "提交内容不符合当前要求，请检查选择项和操作原因。";
    if (error.status === 503) return "服务暂不可用，暂不能确认结果。请稍后重试。";
  }
  return "请求未成功，输入已保留。请重试。";
}

export function ApiFailure({ error, retry, label = "重试" }: { error: unknown; retry?: () => void; label?: string }) {
  return <div role="alert" className="my-3 rounded-md border border-red-200 p-3"><p>{apiErrorText(error)}</p>{retry && <button className={`${apiButton} mt-2`} type="button" onClick={retry}>{label}</button>}</div>;
}

/** An unchanged payload reuses its key after an uncertain response; no local replay success. */
export function useCommandKey() {
  const previous = useRef<{ fingerprint: string; key: string } | null>(null);
  return (payload: unknown) => {
    const fingerprint = JSON.stringify(payload);
    if (previous.current?.fingerprint !== fingerprint) previous.current = { fingerprint, key: crypto.randomUUID() };
    return previous.current.key;
  };
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
  return <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span>共 {total} 条 · 第 {page} 页</span><div className="flex gap-2"><button className={apiButton} type="button" disabled={page <= 1} onClick={() => change(page - 1)}>上一页</button><button className={apiButton} type="button" disabled={page * pageSize >= total} onClick={() => change(page + 1)}>下一页</button></div></div>;
}
