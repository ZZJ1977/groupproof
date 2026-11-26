/* Lucian UX/UI Prompt #448 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#448 */
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { useApp } from "@/shared/components/app-providers";
import { localeNames, locales, normalizeLocale, type Locale } from "@/shared/i18n/config";
import { cn } from "@/shared/lib/utils";
import "./lux/language-picker.css";

const LOCALE_SHORT_CODES: Record<Locale, string> = {
  "zh-Hans": "简",
  "zh-Hant": "繁",
  en: "EN",
};

type PopoverPosition = {
  top: number;
  right: number;
  width: number;
};

type OutgoingLabel = {
  key: number;
  locale: Locale;
};

/** 保留各语言自称（§8.1），避免 jsx-runtime 的 localizeProps 将「简体中文」转译为当前界面语言。 */
function NativeLocaleName({ text }: { text: string }) {
  if (text.length <= 2) return <>{text}</>;
  return (
    <>
      {text.slice(0, 2)}
      {text.slice(2)}
    </>
  );
}

/**
 * 共用语言选择控件（登录页 / 受限个人中心 / 正式工作区同一实现）。
 * 单选语义、选中态、可辨认名称（各语言自称）；切换即生效并保留当前页面、步骤与未保存输入。
 */
export function LanguageSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const t = useTranslations("common");
  const activeLocale = normalizeLocale(useLocale()) ?? "zh-Hans";
  const { switchLocale, localeSwitchError } = useApp();

  const uid = useId();
  const clipId = `${uid}-clip`;
  const listboxId = `${uid}-listbox`;
  const optionId = (index: number) => `${uid}-opt-${index}`;

  const [open, setOpen] = useState(false);
  const [displayLocale, setDisplayLocale] = useState<Locale>(activeLocale);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, locales.indexOf(activeLocale)));
  const [labelVersion, setLabelVersion] = useState(0);
  const [outgoing, setOutgoing] = useState<OutgoingLabel | null>(null);
  const [liveText, setLiveText] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition>({ top: 56, right: 16, width: 192 });

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const labelBoxRef = useRef<HTMLSpanElement>(null);
  const activeLabelRef = useRef<HTMLSpanElement>(null);
  const globeRef = useRef<HTMLSpanElement>(null);

  const restoreFocusRef = useRef(false);
  const outTimerRef = useRef<number | null>(null);
  const spinTimerRef = useRef<number | null>(null);

  const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

  const prefersReducedMotion = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const clearTimers = useCallback(() => {
    if (outTimerRef.current !== null) {
      window.clearTimeout(outTimerRef.current);
      outTimerRef.current = null;
    }
    if (spinTimerRef.current !== null) {
      window.clearTimeout(spinTimerRef.current);
      spinTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  useEffect(() => {
    setDisplayLocale(activeLocale);
  }, [activeLocale, localeSwitchError]);

  const syncLabelWidth = useCallback(() => {
    const box = labelBoxRef.current;
    const activeSpan = activeLabelRef.current;
    if (!box || !activeSpan) return;
    if (window.getComputedStyle(box).display === "none") {
      box.style.width = "";
      return;
    }
    const width = activeSpan.offsetWidth;
    if (width > 0) {
      box.style.width = `${width}px`;
    } else {
      box.style.width = "";
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    syncLabelWidth();
  }, [displayLocale, compact, labelVersion, syncLabelWidth]);

  useEffect(() => {
    let cancelled = false;
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) syncLabelWidth();
      });
    }
    const onResize = () => syncLabelWidth();
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
    };
  }, [syncLabelWidth]);

  const updatePopoverPosition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const width = Math.min(196, Math.max(140, viewportWidth - 16));
    const maxRight = Math.max(8, viewportWidth - width - 8);
    const rawRight = Math.round(viewportWidth - rect.right);
    const right = Math.min(Math.max(8, rawRight), maxRight);
    const top = Math.round(rect.bottom + 8);
    setPopoverPos({ top, right, width });
  }, []);

  const openPicker = useCallback(
    (initialIndex?: number) => {
      updatePopoverPosition();
      const fallbackIndex = Math.max(0, locales.indexOf(displayLocale));
      setActiveIndex(typeof initialIndex === "number" ? initialIndex : fallbackIndex);
      restoreFocusRef.current = false;
      setOpen(true);
    },
    [displayLocale, updatePopoverPosition],
  );

  const closePicker = useCallback((restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    updatePopoverPosition();
    const handleViewportChange = () => updatePopoverPosition();
    window.addEventListener("resize", handleViewportChange, { passive: true });
    window.addEventListener("scroll", handleViewportChange, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (open) {
      listboxRef.current?.focus({ preventScroll: true });
      return;
    }
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target) || portalRef.current?.contains(target)) return;
      closePicker(false);
    };
    document.addEventListener("pointerdown", handleOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
    };
  }, [open, closePicker]);

  const triggerGlobeSpin = useCallback(() => {
    const globe = globeRef.current;
    if (!globe || prefersReducedMotion()) return;
    if (spinTimerRef.current !== null) {
      window.clearTimeout(spinTimerRef.current);
      spinTimerRef.current = null;
    }
    globe.classList.remove("is-spin");
    void globe.offsetWidth;
    globe.classList.add("is-spin");
    spinTimerRef.current = window.setTimeout(() => {
      globe.classList.remove("is-spin");
      spinTimerRef.current = null;
    }, 950);
  }, [prefersReducedMotion]);

  const pickLocale = useCallback(
    (nextLocale: Locale) => {
      closePicker(true);
      if (nextLocale === displayLocale) return;

      const reduced = prefersReducedMotion();
      const prevLocale = displayLocale;
      const nextVersion = labelVersion + 1;

      if (outTimerRef.current !== null) {
        window.clearTimeout(outTimerRef.current);
        outTimerRef.current = null;
      }

      if (!reduced) {
        setOutgoing({ key: labelVersion, locale: prevLocale });
        outTimerRef.current = window.setTimeout(() => {
          setOutgoing(null);
          outTimerRef.current = null;
        }, 420);
      } else {
        setOutgoing(null);
      }

      setLabelVersion(nextVersion);
      setDisplayLocale(nextLocale);
      setLiveText(`${t("language.label")}: ${localeNames[nextLocale]}`);
      triggerGlobeSpin();
      void switchLocale(nextLocale);
    },
    [closePicker, displayLocale, labelVersion, prefersReducedMotion, switchLocale, t, triggerGlobeSpin],
  );

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openPicker();
    }
  };

  const handleListboxKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % locales.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + locales.length) % locales.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(locales.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const chosen = locales[activeIndex];
      if (chosen) pickLocale(chosen);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
    } else if (event.key === "Tab") {
      if (event.shiftKey) {
        event.preventDefault();
        closePicker(true);
      } else {
        triggerRef.current?.focus({ preventScroll: true });
        closePicker(false);
      }
    }
  };

  const labelTitle = t("language.label");

  return (
    <div
      ref={rootRef}
      className={cn("ux u448 gp-lang", compact && "is-compact", open && "is-open", className)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="u448-b gp-rainbow-ring"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={portalTarget ? listboxId : undefined}
        aria-label={`${labelTitle}: ${localeNames[displayLocale]}`}
        onClick={() => {
          if (open) closePicker(false);
          else openPicker();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span ref={globeRef} className="u448-g" aria-hidden="true">
          <svg viewBox="0 0 22 22">
            <defs>
              <clipPath id={clipId}>
                <circle cx="11" cy="11" r="8.6" />
              </clipPath>
            </defs>
            <circle cx="11" cy="11" r="8.6" />
            <g clipPath={`url(#${clipId})`}>
              <g className="mer">
                <path d="M-13 2.4c-4.2 2.6-4.2 14.6 0 17.2M-13 2.4c4.2 2.6 4.2 14.6 0 17.2M-5 2.4c-4.2 2.6-4.2 14.6 0 17.2M-5 2.4c4.2 2.6 4.2 14.6 0 17.2M3 2.4c-4.2 2.6-4.2 14.6 0 17.2M3 2.4c4.2 2.6 4.2 14.6 0 17.2M11 2.4c-4.2 2.6-4.2 14.6 0 17.2M11 2.4c4.2 2.6 4.2 14.6 0 17.2M19 2.4c-4.2 2.6-4.2 14.6 0 17.2M19 2.4c4.2 2.6 4.2 14.6 0 17.2M27 2.4c-4.2 2.6-4.2 14.6 0 17.2M27 2.4c4.2 2.6 4.2 14.6 0 17.2" />
              </g>
              <path d="M2.6 8.2h16.8M2.6 13.8h16.8" />
            </g>
          </svg>
        </span>
        {!compact && <span className="u448-prefix">{labelTitle}</span>}
        <span ref={labelBoxRef} className="u448-lb">
          {outgoing && (
            <span key={`out-${outgoing.key}`} lang={outgoing.locale} className="is-out">
              <NativeLocaleName text={localeNames[outgoing.locale]} />
            </span>
          )}
          <span
            ref={activeLabelRef}
            key={`in-${labelVersion}`}
            lang={displayLocale}
            className={labelVersion > 0 ? "is-in" : undefined}
          >
            <NativeLocaleName text={localeNames[displayLocale]} />
          </span>
        </span>
        <svg className="u448-cv" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.6 6 7.6l3-3" />
        </svg>
      </button>

      {portalTarget &&
        createPortal(
          <div
            ref={portalRef}
            className={cn("ux u448-portal gp-lang-portal", open && "is-open")}
            style={{
              top: `${popoverPos.top}px`,
              right: `${popoverPos.right}px`,
              width: `${popoverPos.width}px`,
            }}
          >
            <ul
              ref={listboxRef}
              id={listboxId}
              className="u448-p"
              role="listbox"
              aria-label={labelTitle}
              aria-hidden={!open}
              aria-activedescendant={open ? optionId(activeIndex) : undefined}
              tabIndex={-1}
              onKeyDown={handleListboxKeyDown}
            >
              {locales.map((locale, index) => {
                const selected = locale === displayLocale;
                const active = open && index === activeIndex;
                return (
                  <li
                    key={locale}
                    id={optionId(index)}
                    className={cn("u448-o", active && "is-act")}
                    role="option"
                    lang={locale}
                    aria-selected={selected}
                    data-code={LOCALE_SHORT_CODES[locale]}
                    style={{ "--i": index } as CSSProperties}
                    onClick={() => pickLocale(locale)}
                    onPointerEnter={() => {
                      if (open) setActiveIndex(index);
                    }}
                  >
                    <span>
                      <NativeLocaleName text={localeNames[locale]} />
                    </span>
                    <em>{LOCALE_SHORT_CODES[locale]}</em>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-6.5" />
                    </svg>
                  </li>
                );
              })}
            </ul>
          </div>,
          portalTarget,
        )}

      <p className="u448-live" aria-live="polite" aria-atomic="true">
        {liveText}
      </p>
    </div>
  );
}
