"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;
export const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(({ className, children, ...props }, ref) => <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#14233d]/35" /><DialogPrimitive.Content ref={ref} className={cn("fixed inset-y-0 right-0 z-50 w-[min(100vw,520px)] overflow-y-auto border-l border-[#dfe6ee] bg-white p-6 shadow-xl outline-none", className)} {...props}>{children}<DialogPrimitive.Close className="absolute right-4 top-4 rounded p-1 text-[#718097] hover:bg-[#f2f5fa]" aria-label="关闭"><X size={16} /></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>);
SheetContent.displayName = "SheetContent";
