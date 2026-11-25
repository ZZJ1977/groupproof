"use client";

import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export interface TeacherTabItem<T extends string = string> {
  id: T;
  label: string;
  href?: string;
  icon?: LucideIcon;
  badge?: number | string | null;
  disabled?: boolean;
  hidden?: boolean;
}

export interface TeacherSegmentedTabsProps<T extends string = string> {
  items: TeacherTabItem<T>[];
  activeId: T;
  onChange?: (id: T) => void;
  ariaLabel: string;
  variant?: "pill" | "segmented" | "underline";
  size?: "sm" | "md";
  className?: string;
  testId?: string;
}

export function TeacherSegmentedTabs<T extends string = string>({
  items,
  activeId,
  onChange,
  ariaLabel,
  variant = "segmented",
  size = "sm",
  className,
  testId,
}: TeacherSegmentedTabsProps<T>) {
  const visibleItems = items.filter((item) => !item.hidden);
  const isLinkNav = visibleItems.every((item) => Boolean(item.href));
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentId: T) => {
    const enabledItems = visibleItems.filter((item) => !item.disabled);
    if (enabledItems.length === 0) return;
    const currentIdx = enabledItems.findIndex((item) => item.id === currentId);
    let nextItem: TeacherTabItem<T> | undefined;

    if (event.key === "ArrowRight") {
      nextItem = enabledItems[(currentIdx + 1) % enabledItems.length];
    } else if (event.key === "ArrowLeft") {
      nextItem = enabledItems[(currentIdx - 1 + enabledItems.length) % enabledItems.length];
    } else if (event.key === "Home") {
      nextItem = enabledItems[0];
    } else if (event.key === "End") {
      nextItem = enabledItems[enabledItems.length - 1];
    }

    if (nextItem) {
      event.preventDefault();
      tabRefs.current[nextItem.id]?.focus();
      onChange?.(nextItem.id);
    }
  };

  const containerClass = cn(
    "max-w-full flex-nowrap items-center overflow-x-auto",
    variant === "segmented"
      ? "inline-flex gap-1 rounded-[10px] border border-[var(--gp-border,#dee0e3)]/70 bg-[var(--gp-canvas,#f5f6f7)] p-1"
      : "flex",
    variant === "pill" && "gap-1",
    variant === "underline" && "gap-4 border-b border-[var(--gp-border,#dee0e3)]",
    className,
  );

  const renderBadge = (badge: number | string | null | undefined, active: boolean) => {
    if (badge === null || badge === undefined || badge === 0 || badge === "") return null;
    return (
      <span
        className={cn(
          "gp-tabular inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none",
          variant === "pill" && active
            ? "bg-[#3370ff] text-white"
            : "bg-[#d93025] text-white",
        )}
      >
        {badge}
      </span>
    );
  };

  const itemClass = (active: boolean, disabled?: boolean) =>
    cn(
      "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98]",
      size === "sm" ? "text-xs" : "text-[13px]",
      disabled && "pointer-events-none opacity-50",
      variant === "pill" &&
        cn(
          "rounded-full px-3 py-1.5",
          active
            ? "bg-[#e8f0fe] font-semibold text-[#1d4ed8]"
            : "text-[var(--gp-ink-soft,#4e5969)] hover:bg-[var(--gp-surface-hover,#eff0f1)] hover:text-[var(--gp-ink,#1f2329)]",
        ),
      variant === "segmented" &&
        cn(
          "rounded-[8px] px-3 py-1.5",
          active
            ? "bg-white font-semibold text-[var(--gp-ink,#1f2329)] shadow-xs"
            : "text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-ink,#1f2329)]",
        ),
      variant === "underline" &&
        cn(
          "border-b-2 px-1 py-2.5 rounded-none active:scale-100",
          active
            ? "border-[var(--gp-action,#3370ff)] font-semibold text-[var(--gp-action,#3370ff)]"
            : "border-transparent text-[var(--gp-muted,#646a73)] hover:text-[var(--gp-ink,#1f2329)]",
        ),
    );

  if (isLinkNav) {
    return (
      <nav aria-label={ariaLabel} data-testid={testId} className={containerClass}>
        {visibleItems.map((item) => {
          const active = item.id === activeId;
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={item.href!}
              aria-current={active ? "page" : undefined}
              className={itemClass(active, item.disabled)}
            >
              {Icon && <Icon size={14} aria-hidden="true" />}
              <span>{item.label}</span>
              {renderBadge(item.badge, active)}
            </Link>
          );
        })}
      </nav>
    );
  }

  const hasActiveEnabled = visibleItems.some((item) => item.id === activeId && !item.disabled);

  return (
    <div role="tablist" aria-label={ariaLabel} data-testid={testId} className={containerClass}>
      {visibleItems.map((item, idx) => {
        const active = item.id === activeId;
        const Icon = item.icon;
        const isFirstEnabled = !hasActiveEnabled && !item.disabled && visibleItems.findIndex((i) => !i.disabled) === idx;
        return (
          <button
            key={item.id}
            ref={(el) => {
              tabRefs.current[item.id] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active || isFirstEnabled ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange?.(item.id)}
            onKeyDown={(event) => handleTabKeyDown(event, item.id)}
            className={itemClass(active, item.disabled)}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            <span>{item.label}</span>
            {renderBadge(item.badge, active)}
          </button>
        );
      })}
    </div>
  );
}
