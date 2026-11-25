"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle, Check, Info, Loader2, X } from "lucide-react";
import { tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

export type TeacherFeedbackTone = "idle" | "loading" | "success" | "error" | "info" | "warning";

export interface TeacherFeedbackPillProps {
  tone: TeacherFeedbackTone;
  message: string | null | undefined;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  autoHideMs?: number;
  placement?: "inline" | "floating";
  className?: string;
}

const toneClasses: Record<Exclude<TeacherFeedbackTone, "idle">, string> = {
  loading: "border-[#c7dafc] bg-[#e8f0fe] text-[#1d4ed8]",
  success: "border-[#a7f3d0] bg-[#ecfdf5] text-[#008a5c]",
  error: "border-[#fecaca] bg-[#fef2f2] text-[#d93025]",
  warning: "border-[#fde68a] bg-[#fffbeb] text-[#b45309]",
  info: "border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] text-[var(--gp-ink-soft,#4e5969)]",
};

export function TeacherFeedbackPill({
  tone,
  message,
  action,
  onDismiss,
  autoHideMs,
  placement = "inline",
  className,
}: TeacherFeedbackPillProps) {
  const onDismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  const hasOnDismiss = Boolean(onDismiss);

  React.useEffect(() => {
    if (!autoHideMs || !hasOnDismiss || !message) return;
    if (tone !== "success" && tone !== "info") return;
    const timer = window.setTimeout(() => {
      onDismissRef.current?.();
    }, autoHideMs);
    return () => window.clearTimeout(timer);
  }, [autoHideMs, hasOnDismiss, message, tone]);

  if (tone === "idle" || !message) return null;

  const Icon =
    tone === "loading"
      ? Loader2
      : tone === "success"
        ? Check
        : tone === "error"
          ? AlertCircle
          : tone === "warning"
            ? AlertTriangle
            : Info;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "gp-pill-in inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-xs",
        toneClasses[tone],
        placement === "floating" && "fixed bottom-5 right-5 z-50 shadow-md",
        className,
      )}
    >
      <Icon
        size={13}
        className={cn("shrink-0", tone === "loading" && "animate-spin")}
        aria-hidden="true"
      />
      <span className="truncate" title={message}>
        {message}
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold underline underline-offset-2 hover:bg-black/5"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={tr("关闭")}
          title={tr("关闭")}
          className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full opacity-75 transition-opacity hover:bg-black/5 hover:opacity-100"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
