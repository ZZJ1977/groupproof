/* Lucian UX/UI Prompt #354 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#354 */
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import "./MorphNav.css";

export interface MorphNavItem {
  id: string;
  label: string;
  href: string;
  icon?: LucideIcon;
  badge?: number;
}

export type HubSlideDirection = "left" | "right" | "none";

interface ItemRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RecordedHub {
  hubId: string;
  index: number;
  rect?: ItemRect;
}

const lastHubByCourse = new Map<string, RecordedHub>();
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function useHubSlideDirection(
  courseId: string,
  activeHub: string,
  hubIds: readonly string[],
): HubSlideDirection {
  const nextIndex = hubIds.indexOf(activeHub);
  const [navState, setNavState] = useState<{
    courseId: string;
    hubId: string;
    index: number;
    dir: HubSlideDirection;
  }>(() => {
    if (typeof window === "undefined" || nextIndex < 0) {
      return { courseId, hubId: activeHub, index: nextIndex, dir: "none" };
    }
    const prev = lastHubByCourse.get(courseId);
    if (!prev || prev.index < 0 || prev.index === nextIndex) {
      return { courseId, hubId: activeHub, index: nextIndex, dir: "none" };
    }
    return {
      courseId,
      hubId: activeHub,
      index: nextIndex,
      dir: nextIndex > prev.index ? "right" : "left",
    };
  });

  if (navState.courseId !== courseId || navState.hubId !== activeHub) {
    let dir: HubSlideDirection = "none";
    if (
      navState.courseId === courseId &&
      navState.index >= 0 &&
      nextIndex >= 0 &&
      navState.index !== nextIndex
    ) {
      dir = nextIndex > navState.index ? "right" : "left";
    }
    setNavState({ courseId, hubId: activeHub, index: nextIndex, dir });
  }

  useEffect(() => {
    if (nextIndex < 0) return;
    const prev = lastHubByCourse.get(courseId);
    lastHubByCourse.set(courseId, {
      hubId: activeHub,
      index: nextIndex,
      rect: prev?.rect,
    });
  }, [courseId, activeHub, nextIndex]);

  return navState.dir;
}

function applyMorphVars(track: HTMLElement, rect: ItemRect) {
  track.style.setProperty("--mx", `${rect.x}px`);
  track.style.setProperty("--my", `${rect.y}px`);
  track.style.setProperty("--mw", `${rect.w}px`);
  track.style.setProperty("--mh", `${rect.h}px`);
  track.style.setProperty("--cx", `${rect.x + rect.w / 2 - 4}px`);
  track.style.setProperty("--cy", `${rect.y + rect.h - 4}px`);
}

function readItemRect(el: HTMLElement | null): ItemRect | null {
  if (!el) return null;
  return {
    x: el.offsetLeft,
    y: el.offsetTop,
    w: el.offsetWidth,
    h: el.offsetHeight,
  };
}

export function MorphNav({
  items,
  activeId,
  courseKey,
  ariaLabel,
  testId,
  className,
  trailing,
}: {
  items: MorphNavItem[];
  activeId: string;
  courseKey?: string;
  ariaLabel: string;
  testId?: string;
  className?: string;
  trailing?: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const activeIdx = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const [mountSnapshot] = useState<{
    courseKey?: string;
    prevIndex: number;
    prevRect?: ItemRect;
  } | null>(() => {
    if (typeof window === "undefined" || !courseKey) return null;
    const prev = lastHubByCourse.get(courseKey);
    if (!prev || !prev.rect) return null;
    return {
      courseKey,
      prevIndex: prev.index,
      prevRect: prev.rect,
    };
  });

  const hasMountedGlideRef = useRef(false);
  const targetIdx = hoverIdx ?? focusIdx ?? activeIdx;
  const isPreviewing =
    (hoverIdx !== null && hoverIdx !== activeIdx) ||
    (hoverIdx === null && focusIdx !== null && focusIdx !== activeIdx);

  const syncTrackToIndex = useCallback((idx: number, instant = false) => {
    const track = trackRef.current;
    const targetEl = itemRefs.current[idx] ?? null;
    if (!track || !targetEl) return null;
    const rect = readItemRect(targetEl);
    if (!rect) return null;
    if (instant) track.classList.add("no-t");
    applyMorphVars(track, rect);
    return rect;
  }, []);

  useIsomorphicLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    let rafId = 0;
    const shouldGlideFromPrev =
      !hasMountedGlideRef.current &&
      mountSnapshot &&
      mountSnapshot.courseKey === courseKey &&
      mountSnapshot.prevRect &&
      mountSnapshot.prevIndex !== activeIdx;

    if (shouldGlideFromPrev && mountSnapshot.prevRect) {
      hasMountedGlideRef.current = true;
      track.classList.add("no-t");
      applyMorphVars(track, mountSnapshot.prevRect);
      setReady(true);
      rafId = window.requestAnimationFrame(() => {
        track.classList.remove("no-t");
        syncTrackToIndex(targetIdx, false);
      });
    } else {
      const initialSnap = !hasMountedGlideRef.current;
      hasMountedGlideRef.current = true;
      syncTrackToIndex(targetIdx, initialSnap);
      setReady(true);
      if (initialSnap) {
        rafId = window.requestAnimationFrame(() => {
          track.classList.remove("no-t");
        });
      }
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [activeIdx, courseKey, mountSnapshot, syncTrackToIndex, targetIdx]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    let resizeRaf = 0;

    const handleMeasure = () => {
      const activeRect = readItemRect(itemRefs.current[activeIdx] ?? null);
      if (courseKey && activeRect) {
        lastHubByCourse.set(courseKey, {
          hubId: activeId,
          index: activeIdx,
          rect: activeRect,
        });
      }
      syncTrackToIndex(targetIdx, true);
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      resizeRaf = window.requestAnimationFrame(() => {
        trackRef.current?.classList.remove("no-t");
      });
    };

    const activeRect = readItemRect(itemRefs.current[activeIdx] ?? null);
    if (courseKey && activeRect) {
      lastHubByCourse.set(courseKey, {
        hubId: activeId,
        index: activeIdx,
        rect: activeRect,
      });
    }

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", handleMeasure);
      return () => {
        if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
        window.removeEventListener("resize", handleMeasure);
      };
    }

    const observer = new ResizeObserver(() => {
      handleMeasure();
    });
    observer.observe(track);
    for (const el of itemRefs.current) {
      if (el) observer.observe(el);
    }

    return () => {
      if (resizeRaf) window.cancelAnimationFrame(resizeRaf);
      observer.disconnect();
    };
  }, [activeId, activeIdx, courseKey, items.length, syncTrackToIndex, targetIdx]);

  const handleTrackBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusIdx(null);
    }
  };

  return (
    <nav aria-label={ariaLabel} data-testid={testId} className={cn("ux u354-shell", className)}>
      <div
        ref={trackRef}
        className={cn(
          "u354-nav",
          ready && "is-ready",
          isPreviewing && "is-preview",
        )}
        onPointerLeave={() => setHoverIdx(null)}
        onBlurCapture={handleTrackBlur}
      >
        <span className="u354-pn" aria-hidden="true" />
        <span className="u354-car" aria-hidden="true" />
        {items.map((item, idx) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          const isTarget = targetIdx === idx;
          return (
            <Link
              key={item.id}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onPointerEnter={() => setHoverIdx(idx)}
              onFocus={() => setFocusIdx(idx)}
              onClick={() => {
                const rect = readItemRect(itemRefs.current[activeIdx] ?? null);
                if (courseKey && rect) {
                  lastHubByCourse.set(courseKey, {
                    hubId: activeId,
                    index: activeIdx,
                    rect,
                  });
                }
              }}
              className={cn(
                "u354-tab",
                active && "is-active",
                isTarget && "is-target",
              )}
            >
              {Icon && (
                <Icon
                  size={13}
                  className="shrink-0 xl:max-[1679px]:hidden"
                  aria-hidden="true"
                />
              )}
              <span>{item.label}</span>
              {item.badge !== undefined && (
                <span className="gp-tabular inline-flex min-w-[16px] items-center justify-center rounded-full bg-[#d93025] px-1 py-0.5 text-[10px] font-bold leading-none text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
        {trailing && <div className="u354-trailing">{trailing}</div>}
      </div>
    </nav>
  );
}
