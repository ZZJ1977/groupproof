"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useGpThemeScope } from "@/shared/components/ui/theme-scope";
import { cn } from "@/shared/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: "right" | "left";
  overlayClassName?: string;
}

export const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ className, overlayClassName, children, side = "right", ...props }, ref) => {
    const t = useTranslations("pages.shared");
    const scope = useGpThemeScope();
    const isTeacher = scope === "teacher";
    const portalClass = isTeacher ? "gp-teacher-portal" : undefined;

    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-radix-dialog-overlay
          className={cn(
            "fixed inset-0 z-50 bg-[#14233d]/35",
            isTeacher && "gp-overlay-anim",
            portalClass,
            overlayClassName,
          )}
        />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "fixed inset-y-0 z-50 w-[min(100vw,520px)] overflow-y-auto bg-white p-6 shadow-xl outline-none",
            side === "left"
              ? cn("left-0 border-r border-[var(--gp-border,#dfe6ee)]", isTeacher && "gp-sheet-left")
              : cn("right-0 border-l border-[var(--gp-border,#dfe6ee)]", isTeacher && "gp-sheet-right"),
            portalClass,
            className,
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-full p-1.5 text-[#718097] transition-colors hover:bg-[#f2f5fa] hover:text-[#1f2329]"
            aria-label={t("close")}
            title={t("close")}
          >
            <X size={16} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
SheetContent.displayName = "SheetContent";

export const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mb-4 space-y-1", className)} {...props} />
);
export const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />
);
