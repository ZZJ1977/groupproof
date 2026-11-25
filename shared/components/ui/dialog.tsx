"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useGpThemeScope } from "@/shared/components/ui/theme-scope";
import { cn } from "@/shared/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(({ className, children, ...props }, ref) => {
  const t = useTranslations("pages.shared");
  const isTeacher = useGpThemeScope() === "teacher";

  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-[#14233d]/40 gp-overlay-anim", isTeacher && "gp-teacher-portal")} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-[min(92vw,540px)] -translate-x-1/2 -translate-y-1/2 bg-white p-6 shadow-xl outline-none gp-dialog-anim",
        isTeacher
          ? "rounded-[12px] border border-[var(--gp-border)] gp-teacher-portal"
          : "rounded-[8px] border border-[#dbe3ee]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(
          "absolute right-4 top-4 text-[#718097] transition-colors duration-150 hover:bg-[#f2f5fa] hover:text-[#1f2329] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#246bfa]/40",
          isTeacher ? "rounded-full p-1.5" : "rounded p-1",
        )}
        aria-label={t("close")}
        title={t("close")}
      >
        <X size={16} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
});
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("mb-4 space-y-1", className)} {...props} />;
export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
export const DialogTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn("text-[17px] font-semibold text-[#16243c]", className)} {...props} />);
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn("text-[12px] text-[#718097]", className)} {...props} />);
DialogDescription.displayName = "DialogDescription";
