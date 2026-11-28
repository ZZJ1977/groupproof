"use client";

import { GitBranchPlus, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/lib/utils";
import { isCodeDiscoveredTask, type BDiscoveredFrom } from "@/student/api/b-code-discoveries";

export type TaskOriginMeta = {
  origin?: string | null;
  is_code_discovered?: boolean | null;
  discovered_from?: BDiscoveredFrom | null;
};

export function TaskOriginBadge({
  task,
  compact = false,
  showPlanned = false,
  className,
}: {
  task?: TaskOriginMeta | null;
  compact?: boolean;
  showPlanned?: boolean;
  className?: string;
}) {
  const t = useTranslations("codeDiscovery");
  const isCodeDiscovered = isCodeDiscoveredTask(task);

  if (!isCodeDiscovered) {
    if (!showPlanned) return null;
    return (
      <span
        data-testid="task-origin-planned"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-slate-200/80 bg-slate-50/90 px-1.5 py-0.5 text-[10px] font-medium text-slate-500",
          className,
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
        {t("badgePlanned")}
      </span>
    );
  }

  const df = task?.discovered_from;
  const commitCount = df?.commit_count ?? df?.shas?.length ?? df?.commit_ids?.length ?? 0;
  const tooltipParts: string[] = [];
  if (commitCount > 0) tooltipParts.push(t("badgeTooltipCommits", { count: commitCount }));
  if (df?.approved_by_name) tooltipParts.push(t("badgeTooltipApprovedBy", { name: df.approved_by_name }));
  if (df?.reason) tooltipParts.push(df.reason);
  const title = tooltipParts.length > 0 ? tooltipParts.join(" · ") : t("badgeTooltipDefault");

  return (
    <span
      data-testid="task-origin-code-discovered"
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-violet-200/90 bg-violet-50/90 px-2 py-0.5 text-[10px] font-semibold text-violet-700",
        className,
      )}
    >
      <GitBranchPlus size={10} className="shrink-0 text-violet-600" aria-hidden="true" />
      {compact ? t("badgeCodeDiscoveredShort") : t("badgeCodeDiscovered")}
    </span>
  );
}

export function CodeDiscoveredReviewCallout({
  discoveredFrom,
  reviewNote,
  className,
}: {
  discoveredFrom?: BDiscoveredFrom | null;
  reviewNote?: string | null;
  className?: string;
}) {
  const t = useTranslations("codeDiscovery");
  const commitCount =
    discoveredFrom?.commit_count ??
    discoveredFrom?.shas?.length ??
    discoveredFrom?.commit_ids?.length ??
    0;
  const shas = (discoveredFrom?.shas ?? []).slice(0, 4);

  return (
    <div
      data-testid="code-discovered-review-callout"
      role="note"
      className={cn(
        "rounded-xl border border-violet-200/85 bg-violet-50/55 px-3.5 py-2.5 text-xs text-slate-700",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-violet-600" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-semibold text-violet-900">{t("reviewCalloutTitle")}</div>
          <p className="leading-5 text-slate-600">
            {reviewNote?.trim() ? reviewNote : t("reviewCalloutDefault")}
          </p>
          {(commitCount > 0 || discoveredFrom?.approved_by_name || discoveredFrom?.reason) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] text-slate-500">
              {commitCount > 0 && (
                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                  {t("reviewCalloutMeta", { count: commitCount })}
                  {shas.length > 0 && (
                    <span className="text-violet-700">
                      ({shas.map((s) => s.slice(0, 7)).join(", ")})
                    </span>
                  )}
                </span>
              )}
              {discoveredFrom?.approved_by_name && (
                <span>{t("reviewCalloutApproved", { name: discoveredFrom.approved_by_name })}</span>
              )}
              {discoveredFrom?.reason && (
                <span>{t("reviewCalloutReason", { reason: discoveredFrom.reason })}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
