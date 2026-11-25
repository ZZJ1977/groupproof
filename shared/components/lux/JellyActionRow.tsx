/* Lucian UX/UI Prompt #416 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#416 */
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/shared/lib/utils";
import "./JellyActionRow.css";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function isItemDisabled(el: HTMLElement): boolean {
  return (
    (el instanceof HTMLButtonElement && el.disabled) ||
    el.getAttribute("aria-disabled") === "true"
  );
}

function getActionItems(row: HTMLElement): HTMLElement[] {
  return Array.from(row.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && (child.tagName === "A" || child.tagName === "BUTTON"),
  );
}

export function JellyActionRow({
  children,
  className,
  pill = false,
  ariaLabel,
  defaultActiveIndex = 0,
}: {
  children: ReactNode;
  className?: string;
  pill?: boolean;
  ariaLabel?: string;
  defaultActiveIndex?: number;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const currentIdxRef = useRef(defaultActiveIndex);
  const hoverIdxRef = useRef<number | null>(null);
  const focusIdxRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [isHot, setIsHot] = useState(false);

  const moveThumb = useCallback((idx: number, dir: number, instant = false) => {
    const row = rowRef.current;
    const thumb = thumbRef.current;
    if (!row || !thumb) return;
    const items = getActionItems(row);
    if (items.length === 0) return;

    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    const item = items[clamped];
    const W = row.clientWidth;
    const H = row.clientHeight;
    const left = item.offsetLeft;
    const top = item.offsetTop;
    const right = Math.max(0, W - left - item.offsetWidth);
    const bottom = Math.max(0, H - top - item.offsetHeight);

    if (instant) row.classList.add("no-t");
    thumb.style.setProperty("--tl", dir > 0 ? ".62s" : ".38s");
    thumb.style.setProperty("--tr", dir > 0 ? ".38s" : ".62s");
    thumb.style.setProperty("--l", `${left}px`);
    thumb.style.setProperty("--r", `${right}px`);
    thumb.style.setProperty("--t", `${top}px`);
    thumb.style.setProperty("--b", `${bottom}px`);
    currentIdxRef.current = clamped;
  }, []);

  const getRestIndex = useCallback(
    (items: HTMLElement[]) => {
      if (items.length === 0) return 0;
      const candidate = Math.max(0, Math.min(items.length - 1, defaultActiveIndex));
      if (!isItemDisabled(items[candidate])) return candidate;
      const firstEnabled = items.findIndex((el) => !isItemDisabled(el));
      return firstEnabled >= 0 ? firstEnabled : 0;
    },
    [defaultActiveIndex],
  );

  useIsomorphicLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const items = getActionItems(row);
    const activeTarget =
      hoverIdxRef.current ?? focusIdxRef.current ?? getRestIndex(items);
    const isInitial = !mountedRef.current;
    mountedRef.current = true;
    moveThumb(activeTarget, 1, isInitial);
    setReady(true);

    let rafId = 0;
    if (isInitial) {
      rafId = window.requestAnimationFrame(() => {
        row.classList.remove("no-t");
      });
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [children, getRestIndex, moveThumb]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    let rafId = 0;
    const syncOnResize = () => {
      const items = getActionItems(row);
      const target =
        hoverIdxRef.current ?? focusIdxRef.current ?? getRestIndex(items);
      moveThumb(target, 1, true);
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rowRef.current?.classList.remove("no-t");
      });
    };

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncOnResize);
      return () => {
        if (rafId) window.cancelAnimationFrame(rafId);
        window.removeEventListener("resize", syncOnResize);
      };
    }

    const observer = new ResizeObserver(() => {
      syncOnResize();
    });
    observer.observe(row);
    for (const item of getActionItems(row)) {
      observer.observe(item);
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [children, getRestIndex, moveThumb]);

  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row) return;
    const target = (event.target as HTMLElement | null)?.closest("a, button");
    if (!(target instanceof HTMLElement) || target.parentElement !== row) return;
    if (isItemDisabled(target)) return;
    const items = getActionItems(row);
    const idx = items.indexOf(target);
    if (idx < 0) return;

    hoverIdxRef.current = idx;
    setIsHot(true);
    if (idx !== currentIdxRef.current) {
      const dir = idx > currentIdxRef.current ? 1 : -1;
      moveThumb(idx, dir);
    }
  };

  const handlePointerLeave = () => {
    const row = rowRef.current;
    hoverIdxRef.current = null;
    if (!row) return;
    const items = getActionItems(row);
    const fallback = focusIdxRef.current ?? getRestIndex(items);
    setIsHot(focusIdxRef.current !== null);
    if (fallback !== currentIdxRef.current) {
      const dir = fallback > currentIdxRef.current ? 1 : -1;
      moveThumb(fallback, dir);
    }
  };

  const handleFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.parentElement !== row) return;
    if (target.tagName !== "A" && target.tagName !== "BUTTON") return;
    const items = getActionItems(row);
    const idx = items.indexOf(target);
    if (idx < 0) return;

    focusIdxRef.current = idx;
    setIsHot(true);
    if (idx !== currentIdxRef.current) {
      const dir = idx > currentIdxRef.current ? 1 : -1;
      moveThumb(idx, dir);
    }
  };

  const handleBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row) return;
    if (!row.contains(event.relatedTarget as Node | null)) {
      focusIdxRef.current = null;
      const items = getActionItems(row);
      const fallback = hoverIdxRef.current ?? getRestIndex(items);
      setIsHot(hoverIdxRef.current !== null);
      if (fallback !== currentIdxRef.current) {
        const dir = fallback > currentIdxRef.current ? 1 : -1;
        moveThumb(fallback, dir);
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const row = rowRef.current;
    if (!row) return;
    const items = getActionItems(row);
    const enabled = items.filter((el) => !isItemDisabled(el));
    if (enabled.length === 0) return;

    const activeEl = document.activeElement;
    const curEnabledIdx =
      activeEl instanceof HTMLElement ? enabled.indexOf(activeEl) : -1;
    if (curEnabledIdx < 0) return;

    let nextEnabledIdx = curEnabledIdx;
    if (event.key === "ArrowRight") {
      nextEnabledIdx = (curEnabledIdx + 1) % enabled.length;
    } else if (event.key === "ArrowLeft") {
      nextEnabledIdx = (curEnabledIdx - 1 + enabled.length) % enabled.length;
    } else if (event.key === "Home") {
      nextEnabledIdx = 0;
    } else if (event.key === "End") {
      nextEnabledIdx = enabled.length - 1;
    }

    event.preventDefault();
    const nextEl = enabled[nextEnabledIdx];
    const nextFullIdx = items.indexOf(nextEl);
    if (nextFullIdx < 0) return;

    const dir = nextFullIdx > currentIdxRef.current ? 1 : -1;
    focusIdxRef.current = nextFullIdx;
    setIsHot(true);
    moveThumb(nextFullIdx, dir);
    nextEl.focus({ preventScroll: true });
  };

  return (
    <div
      ref={rowRef}
      role="group"
      aria-label={ariaLabel}
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      onKeyDown={handleKeyDown}
      className={cn(
        "ux u416-tl",
        pill && "u416-tl-pill",
        ready && "is-ready",
        isHot && "is-hot",
        className,
      )}
    >
      <span ref={thumbRef} className="u416-th" aria-hidden="true" />
      {children}
    </div>
  );
}
