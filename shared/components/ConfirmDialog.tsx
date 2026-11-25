"use client";

import * as React from "react";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { tr } from "@/shared/i18n/tr";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger" | "warning";
  confirmDisabled?: boolean;
  loading?: boolean;
  presentation?: "dialog" | "sheet";
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  tone = "default",
  confirmDisabled = false,
  loading = false,
  presentation = "dialog",
  onConfirm,
}: ConfirmDialogProps) {
  const handleOpenChange = (next: boolean) => {
    if (loading && !next) return;
    onOpenChange(next);
  };

  const footer = (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => handleOpenChange(false)}
      >
        {cancelLabel ?? tr("取消")}
      </Button>
      <Button
        type="button"
        variant={tone === "danger" ? "destructive" : "default"}
        size="sm"
        pill
        loading={loading}
        preserveWidth
        disabled={confirmDisabled}
        onClick={() => void onConfirm()}
      >
        {confirmLabel ?? tr("确认")}
      </Button>
    </>
  );

  if (presentation === "sheet") {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          className="flex flex-col justify-between transition-[border-color,box-shadow] duration-[180ms] motion-reduce:transition-none"
          onEscapeKeyDown={(event) => {
            if (loading) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (loading) event.preventDefault();
          }}
        >
          <div>
            <SheetHeader className="pr-8">
              <SheetTitle className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                {title}
              </SheetTitle>
              {description && (
                <SheetDescription className="text-xs text-[var(--gp-muted,#646a73)]">
                  {description}
                </SheetDescription>
              )}
            </SheetHeader>
            {children && <div className="mt-4">{children}</div>}
          </div>
          <SheetFooter className="border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
            {footer}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="border-[var(--gp-border,#e2e8f0)] shadow-[0_24px_48px_-16px_rgba(15,23,42,0.18)] transition-[border-color,box-shadow] duration-[180ms] motion-reduce:transition-none"
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (loading) event.preventDefault();
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="text-base font-semibold text-[var(--gp-ink,#1f2329)]">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="text-xs text-[var(--gp-muted,#646a73)]">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {children && <div className="mt-2">{children}</div>}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmDialogOptions {
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger" | "warning";
  presentation?: "dialog" | "sheet";
}

type ConfirmDialogState = ConfirmDialogOptions & {
  id: number;
  open: boolean;
};

/**
 * Imperative confirmation dialog hook backed by the shared Radix ConfirmDialog.
 * Guarantees each confirm() call resolves once (true on confirm, false on cancel/dismiss/replace/unmount).
 */
export function useConfirmDialog(): [
  (options: ConfirmDialogOptions) => Promise<boolean>,
  React.ReactElement,
] {
  const [state, setState] = React.useState<ConfirmDialogState | null>(null);
  const pendingRef = React.useRef<{ id: number; resolve: (confirmed: boolean) => void } | null>(null);
  const nextIdRef = React.useRef(0);

  const settle = React.useCallback((confirmed: boolean, expectedId?: number) => {
    const current = pendingRef.current;
    if (current && (expectedId === undefined || current.id === expectedId)) {
      pendingRef.current = null;
      current.resolve(confirmed);
    }
    setState((prev) => {
      if (!prev || !prev.open) return prev;
      if (expectedId !== undefined && prev.id !== expectedId) return prev;
      return { ...prev, open: false };
    });
  }, []);

  const confirm = React.useCallback((options: ConfirmDialogOptions) => {
    const previous = pendingRef.current;
    if (previous) {
      pendingRef.current = null;
      previous.resolve(false);
    }
    const id = ++nextIdRef.current;
    return new Promise<boolean>((resolve) => {
      pendingRef.current = { id, resolve };
      setState({ ...options, id, open: true });
    });
  }, []);

  React.useEffect(() => {
    return () => {
      const current = pendingRef.current;
      if (current) {
        pendingRef.current = null;
        current.resolve(false);
      }
    };
  }, []);

  const dialogId = state?.id;
  const dialogElement = (
    <ConfirmDialog
      open={Boolean(state?.open)}
      onOpenChange={(next) => {
        if (!next) settle(false, dialogId);
      }}
      title={state?.title ?? ""}
      description={state?.description}
      confirmLabel={state?.confirmLabel}
      cancelLabel={state?.cancelLabel}
      tone={state?.tone}
      presentation={state?.presentation}
      onConfirm={() => settle(true, dialogId)}
    >
      {state?.children}
    </ConfirmDialog>
  );

  return [confirm, dialogElement];
}
