import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 当前界面语言（AppProviders 渲染时设置；服务端/客户端同一 locale，避免 hydration 闪烁） */
let formatLocale = "zh-Hans";

export function setFormatLocale(locale: string) {
  formatLocale = locale;
}

export function formatDate(value: string, options?: Intl.DateTimeFormatOptions, locale?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale ?? formatLocale, options ?? { month: "numeric", day: "numeric" }).format(date);
}
