import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn("min-h-[94px] w-full rounded-[6px] border border-[#dbe3ee] bg-white px-3 py-2 text-[12px] text-[#1d2a43] outline-none placeholder:text-[#a1adbd] focus:border-[#80aafc] focus:ring-2 focus:ring-[#e9f1ff] disabled:bg-[#f4f6f9]", className)} {...props} />
));
Textarea.displayName = "Textarea";
