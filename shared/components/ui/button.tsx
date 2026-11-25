import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[6px] text-[12px] font-semibold transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#246bfa]/40 focus-visible:ring-offset-1 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--gp-action)] text-white shadow-xs hover:bg-[var(--gp-action-hover)] hover:shadow-[0_6px_16px_-6px_rgba(36,107,250,0.45)] hover:-translate-y-[0.5px] disabled:hover:translate-y-0 motion-reduce:hover:translate-y-0",
        tonal:
          "bg-[#e8f0fe] text-[#1d4ed8] shadow-xs hover:bg-[#d6e4fd] hover:shadow-sm hover:-translate-y-[0.5px] active:bg-[#c7dafc] disabled:hover:translate-y-0 motion-reduce:hover:translate-y-0",
        secondary:
          "bg-[var(--gp-action-soft)] text-[var(--gp-action)] hover:bg-[#bae6fd] hover:shadow-xs hover:-translate-y-[0.5px] disabled:hover:translate-y-0 motion-reduce:hover:translate-y-0",
        outline:
          "border border-[var(--gp-border)] bg-white text-[var(--gp-ink-soft)] hover:bg-[var(--gp-canvas)] hover:border-[#cbd5e1] hover:text-[var(--gp-ink)] hover:shadow-xs",
        ghost: "text-[var(--gp-muted)] hover:bg-[var(--gp-canvas)] hover:text-[var(--gp-ink)]",
        destructive:
          "bg-[var(--gp-danger)] text-white shadow-xs hover:bg-[#991b1b] hover:shadow-sm hover:-translate-y-[0.5px] disabled:hover:translate-y-0 motion-reduce:hover:translate-y-0",
        link: "text-[var(--gp-action)] hover:text-[var(--gp-action-hover)] hover:underline active:scale-100",
      },
      size: { default: "h-9 px-4", sm: "h-8 px-3", lg: "h-10 px-5", icon: "h-8 w-8 p-0" },
      pill: { true: "rounded-full", false: "" },
    },
    defaultVariants: { variant: "default", size: "default", pill: false },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** 保存中/加载中：禁用重复提交并保留可读文案（阶段 14 状态表） */
  loading?: boolean;
  /** 仅在窄操作按钮（如教师确认弹窗/行内重置）中启用占位宽度防抖 */
  preserveWidth?: boolean;
  /** 默认在主按钮上启用悬停彩虹描边光环；禁用或加载中自动关闭 */
  rainbow?: boolean;
}

function ProcessingLabel() {
  return <>{useTranslations("pages.shared")("processing")}</>;
}

function hasTextNode(node: React.ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some(hasTextNode);
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return hasTextNode(node.props.children);
  }
  return false;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pill, loading, preserveWidth = false, rainbow, disabled, children, ...props }, ref) => {
    const isDefaultVariant = (variant ?? "default") === "default";
    const hasRainbow = (rainbow ?? isDefaultVariant) && !disabled && !loading;

    return (
      <button
        ref={ref}
        data-variant={variant ?? "default"}
        className={cn(
          buttonVariants({ variant, size, pill }),
          hasRainbow && "gp-rainbow-ring",
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          preserveWidth ? (
            <span className="inline-grid place-items-center">
              <span aria-hidden="true" className="invisible col-start-1 row-start-1 inline-flex items-center gap-2">
                {children}
              </span>
              <span className="gp-fade-in col-start-1 row-start-1 inline-flex items-center justify-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span className="sr-only">
                  {hasTextNode(children) ? children : <ProcessingLabel />}
                </span>
              </span>
            </span>
          ) : size === "icon" ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span className="sr-only">
                {hasTextNode(children) ? children : <ProcessingLabel />}
              </span>
            </>
          ) : (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
              {children}
            </>
          )
        ) : (
          children
        )}
      </button>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
