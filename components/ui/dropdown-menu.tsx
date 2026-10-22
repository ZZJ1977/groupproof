"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuContent = React.forwardRef<React.ElementRef<typeof DropdownMenuPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>>(({ className, sideOffset = 5, ...props }, ref) => <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn("z-50 min-w-[160px] rounded-[6px] border border-[#dfe6ee] bg-white p-1 shadow-lg", className)} {...props} /></DropdownMenuPrimitive.Portal>);
DropdownMenuContent.displayName = "DropdownMenuContent";
export const DropdownMenuItem = React.forwardRef<React.ElementRef<typeof DropdownMenuPrimitive.Item>, React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>>(({ className, ...props }, ref) => <DropdownMenuPrimitive.Item ref={ref} className={cn("flex cursor-pointer items-center gap-2 rounded-[4px] px-3 py-2 text-[12px] text-[#40516c] outline-none focus:bg-[#eef4ff] focus:text-[#246bfa]", className)} {...props} />);
DropdownMenuItem.displayName = "DropdownMenuItem";
/** 单选语义（语言选择等）：RadioGroup + RadioItem，支持方向键/Enter/Esc 与选中态 */
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuRadioItem = React.forwardRef<React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>, React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>>(({ className, children, ...props }, ref) => <DropdownMenuPrimitive.RadioItem ref={ref} className={cn("flex cursor-pointer items-center gap-2 rounded-[4px] px-3 py-2 text-[12px] text-[#40516c] outline-none focus:bg-[#eef4ff] focus:text-[#246bfa]", className)} {...props}><span className="flex h-4 w-4 shrink-0 items-center justify-center"><DropdownMenuPrimitive.ItemIndicator><span className="h-1.5 w-1.5 rounded-full bg-[#246bfa]" /></DropdownMenuPrimitive.ItemIndicator></span>{children}</DropdownMenuPrimitive.RadioItem>);
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";
