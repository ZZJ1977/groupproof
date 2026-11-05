/** Shared class names for B real pages (same tokens as the existing course views). */
export const button = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-[var(--gp-action)] bg-[var(--gp-action)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--gp-action-hover)] disabled:cursor-not-allowed disabled:opacity-50";
export const secondary = "inline-flex min-h-9 items-center justify-center gap-2 rounded border border-[var(--gp-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--gp-ink-soft)] transition-colors hover:bg-[var(--gp-canvas)] disabled:cursor-not-allowed disabled:opacity-50";
export const input = "w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
export const label = "mb-1.5 block text-xs font-semibold text-slate-600";
export const queryPolicy = { retry: false, refetchOnWindowFocus: false } as const;
export const dateOnly = (value: string | null | undefined) => (value ? value.slice(0, 10) : "未设置");
