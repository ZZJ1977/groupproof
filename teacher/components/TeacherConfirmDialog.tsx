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

export interface TeacherConfirmDialogProps {
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

export function TeacherConfirmDialog({
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
}: TeacherConfirmDialogProps) {
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
          className="flex flex-col justify-between"
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
