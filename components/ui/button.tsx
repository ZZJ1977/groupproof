import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[6px] text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-[#246bfa] text-white hover:bg-[#1459e3]",
      secondary: "bg-[#eef4ff] text-[#246bfa] hover:bg-[#e3edff]",
      outline: "border border-[#dbe3ee] bg-white text-[#40516c] hover:bg-[#f5f8fc]",
      ghost: "text-[#607088] hover:bg-[#f1f5fb]",
      destructive: "bg-[#e54955] text-white hover:bg-[#cf3643]",
      link: "text-[#246bfa] hover:underline",
    },
    size: { default: "h-9 px-4", sm: "h-8 px-3", lg: "h-10 px-5", icon: "h-8 w-8 p-0" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";

export { buttonVariants };
