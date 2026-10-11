import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[6px] text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-[var(--gp-action)] text-white hover:bg-[var(--gp-action-hover)]",
      secondary: "bg-[var(--gp-action-soft)] text-[var(--gp-action)] hover:bg-[#bae6fd]",
      outline: "border border-[var(--gp-border)] bg-white text-[var(--gp-ink-soft)] hover:bg-[var(--gp-canvas)]",
      ghost: "text-[var(--gp-muted)] hover:bg-[var(--gp-canvas)]",
      destructive: "bg-[var(--gp-danger)] text-white hover:bg-[#991b1b]",
      link: "text-[var(--gp-action)] hover:underline",
    },
    size: { default: "h-9 px-4", sm: "h-8 px-3", lg: "h-10 px-5", icon: "h-8 w-8 p-0" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** 保存中/加载中：禁用重复提交并保留可读文案（阶段 14 状态表） */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, disabled, children, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading ? <span className="gp-fade-in inline-flex items-center gap-2">处理中…{children}</span> : children}
  </button>
));
Button.displayName = "Button";

export { buttonVariants };
