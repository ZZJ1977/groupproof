/* Lucian UX/UI Prompt #025 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#025 */
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEventHandler, type ReactNode } from "react";
import { useUiText } from "@/shared/i18n/use-ui-text";
import { cn } from "@/shared/lib/utils";
import "./FloatingField.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface FloatingFieldControlProps {
  id: string;
  className: string;
  onFocus: FocusEventHandler<HTMLInputElement>;
  onBlur: FocusEventHandler<HTMLInputElement>;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

export interface FloatingFieldProps {
  label: string;
  value: string;
  validation?: "none" | "identifier";
  invalidHint?: string;
  className?: string;
  children: (controlProps: FloatingFieldControlProps) => ReactNode;
}

function evaluateIdentifier(raw: string): { ok: boolean; emailInvalid: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, emailInvalid: false };
  if (trimmed.includes("@")) {
    const valid = EMAIL_RE.test(trimmed);
    return { ok: valid, emailInvalid: !valid };
  }
  return { ok: true, emailInvalid: false };
}

export function FloatingField({
  label,
  value,
  validation = "none",
  invalidHint,
  className,
  children,
}: FloatingFieldProps) {
  const tr = useUiText();
  const inputId = useId();
  const msgId = `${inputId}-msg`;
  const boxRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<HTMLLabelElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const shakeRafRef = useRef<number | null>(null);

  const [focused, setFocused] = useState(false);
  const [autofilled, setAutofilled] = useState(false);
  const [bad, setBad] = useState(false);
  const [shaking, setShaking] = useState(false);

  const hasCheck = validation === "identifier";
  const status = hasCheck ? evaluateIdentifier(value) : { ok: false, emailInvalid: false };
  const isBad = hasCheck && bad && status.emailInvalid;
  const isOk = hasCheck && status.ok;
  const isUp = focused || value.length > 0 || autofilled;

  useEffect(() => {
    const input = boxRef.current?.querySelector<HTMLInputElement>(".u025-in");
    if (!input) return;
    const syncAutofill = () => {
      try {
        setAutofilled(input.matches(":-webkit-autofill") || input.value.length > 0);
      } catch {
        setAutofilled(input.value.length > 0);
      }
    };
    syncAutofill();
    const timer = window.setTimeout(syncAutofill, 120);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    return () => {
      if (shakeRafRef.current !== null) {
        cancelAnimationFrame(shakeRafRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const updateGap = () => {
      const line = lineRef.current;
      const lab = labRef.current;
      if (!line || !lab) return;
      const gap = isUp ? `${lab.offsetWidth * 0.8 + 6}px` : "0px";
      line.style.setProperty("--gap", gap);
    };

    updateGap();
    const lab = labRef.current;
    if (!lab || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateGap);
    ro.observe(lab);
    return () => ro.disconnect();
  }, [isUp, label]);

  const triggerShake = () => {
    if (shakeRafRef.current !== null) {
      cancelAnimationFrame(shakeRafRef.current);
      shakeRafRef.current = null;
    }
    setShaking(false);
    shakeRafRef.current = requestAnimationFrame(() => {
      shakeRafRef.current = null;
      setShaking(true);
    });
  };

  const handleFocus: FocusEventHandler<HTMLInputElement> = () => {
    setFocused(true);
  };

  const handleBlur: FocusEventHandler<HTMLInputElement> = (event) => {
    setFocused(false);
    if (!hasCheck) return;
    const nextStatus = evaluateIdentifier(event.currentTarget.value);
    if (nextStatus.emailInvalid) {
      setBad(true);
      triggerShake();
    } else {
      setBad(false);
      setShaking(false);
    }
  };

  const handleBoxInput = (event: React.FormEvent<HTMLDivElement>) => {
    if (!hasCheck || !bad) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const nextStatus = evaluateIdentifier(target.value);
    if (!nextStatus.emailInvalid) {
      setBad(false);
      setShaking(false);
    }
  };

  const hintText = invalidHint ?? tr("请检查邮箱格式，例如 name@must.edu.mo");

  return (
    <div
      className={cn(
        "ux u025-f",
        hasCheck && "has-check",
        isUp && "is-up",
        focused && "is-focus",
        isOk && "is-ok",
        isBad && "is-bad",
        shaking && "is-shake",
        className,
      )}
    >
      <div
        ref={boxRef}
        className="u025-box"
        onInput={handleBoxInput}
        onAnimationEnd={() => setShaking(false)}
      >
        {children({
          id: inputId,
          className: "u025-in",
          onFocus: handleFocus,
          onBlur: handleBlur,
          "aria-invalid": isBad ? true : undefined,
          "aria-describedby": hasCheck ? msgId : undefined,
        })}
        <span ref={lineRef} className="u025-line" aria-hidden="true">
          <i className="l" />
          <i className="g" />
          <i className="r" />
        </span>
        <label ref={labRef} htmlFor={inputId} className="u025-lab">
          {label}
        </label>
        {hasCheck && (
          <span className="u025-ok" aria-hidden="true">
            <svg viewBox="0 0 14 14">
              <path d="M3 7.3l2.7 2.7L11 4.5" />
            </svg>
          </span>
        )}
      </div>
      {hasCheck && (
        <div className="u025-help">
          <span id={msgId} className="u025-msg" aria-live="polite">
            {isBad ? hintText : ""}
          </span>
        </div>
      )}
    </div>
  );
}
