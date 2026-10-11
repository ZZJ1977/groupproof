"use client";

import { useLocale, useTranslations } from "next-intl";
import { Check, ChevronDown, Globe } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useApp } from "@/components/app-providers";
import { localeNames, locales, normalizeLocale, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

/**
 * 共用语言选择控件（登录页 / 受限个人中心 / 正式工作区同一实现）。
 * 单选语义、选中态、可辨认名称（各语言自称）；切换即生效并保留当前页面、步骤与未保存输入。
 */
export function LanguageSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const t = useTranslations("common");
  const activeLocale = normalizeLocale(useLocale()) ?? "zh-Hans";
  const { switchLocale } = useApp();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex min-h-[44px] items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-[#53637d] outline-none hover:bg-[#f5f7fb] focus-visible:ring-2 focus-visible:ring-blue-200",
          className,
        )}
        aria-label={`${t("language.label")}: ${localeNames[activeLocale]}`}
      >
        <Globe size={16} />
        {compact ? (
          // 紧凑模式只显示一次当前语言（此前两个 span 同时渲染导致语言名重复）
          <span className="hidden sm:inline">{localeNames[activeLocale]}</span>
        ) : (
          <>
            <span>{t("language.label")}</span>
            <span className="hidden sm:inline">{localeNames[activeLocale]}</span>
          </>
        )}
        <ChevronDown size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={activeLocale}
          onValueChange={(value) => void switchLocale(value as Locale)}
        >
          {locales.map((locale) => (
            <DropdownMenuRadioItem key={locale} value={locale} aria-label={localeNames[locale]}>
              <span className="flex items-center gap-2">
                {localeNames[locale]}
                {locale === activeLocale && <Check size={13} className="text-[#246bfa]" aria-hidden />}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
