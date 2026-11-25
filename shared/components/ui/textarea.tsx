import * as React from "react";
import { cn } from "@/shared/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-[94px] w-full rounded-[6px] border border-[#dbe3ee] bg-white px-3 py-2 text-[12px] text-[#1d2a43] shadow-none outline-none ring-0 ring-[#246bfa]/0 transition-[border-color,box-shadow,background-color] duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)] placeholder:text-[#a1adbd] hover:border-[#b8c8df] focus:border-[#246bfa] focus:ring-[3px] focus:ring-[#246bfa]/16 focus:shadow-[0_2px_8px_rgba(36,107,250,0.10)] disabled:cursor-not-allowed disabled:bg-[#f4f6f9] disabled:text-[#7b899e] motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
