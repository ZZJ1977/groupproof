"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/shared/lib/utils";

export type TabsVariant = "underline" | "segmented";

const TabsVariantContext = React.createContext<TabsVariant>("underline");

export const Tabs = TabsPrimitive.Root;

export interface TabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  variant?: TabsVariant;
}

export const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, TabsListProps>(
  ({ className, variant = "underline", ...props }, ref) => (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        ref={ref}
        className={cn(
          variant === "segmented"
            ? "inline-flex items-center gap-1 rounded-[10px] border border-[var(--gp-border,#dee0e3)]/70 bg-[var(--gp-canvas,#f5f6f7)] p-1"
            : "flex gap-5 border-b border-[var(--gp-border,#e1e7f0)]",
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  ),
);
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  ({ className, ...props }, ref) => {
    const variant = React.useContext(TabsVariantContext);
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          variant === "segmented"
            ? "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 py-1.5 text-[12px] font-medium text-[var(--gp-muted,#646a73)] transition-[color,background-color,box-shadow,transform] duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)] hover:text-[var(--gp-ink,#1f2329)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#246bfa]/35 active:scale-[0.98] data-[state=active]:bg-white data-[state=active]:font-semibold data-[state=active]:text-[var(--gp-ink,#1f2329)] data-[state=active]:shadow-xs motion-reduce:transition-none motion-reduce:active:scale-100"
            : "border-b-2 border-transparent px-1 py-3 text-[12px] font-semibold text-[#718097] transition-[color,border-color,transform] duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)] hover:text-[#1d2a43] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#246bfa]/35 active:scale-[0.98] data-[state=active]:border-[var(--gp-action,#246bfa)] data-[state=active]:text-[var(--gp-action,#246bfa)] motion-reduce:transition-none motion-reduce:active:scale-100",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  ({ className, ...props }, ref) => <TabsPrimitive.Content ref={ref} className={cn("pt-4 outline-none", className)} {...props} />,
);
TabsContent.displayName = "TabsContent";
