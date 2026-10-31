import type { Evidence, EvidenceStatus } from "@/types/domain";

export const taskDetailTabs = ["overview", "evidence", "verification", "discussion", "history"] as const;
export const evidenceViews = ["task", "timeline", "source"] as const;
export const evidenceSources = ["github", "file", "screenshot", "feishu", "discussion", "manual"] as const;
export const evidenceStatuses: readonly EvidenceStatus[] = ["candidate", "pending_confirmation", "formal", "withdrawn", "void"];

type QueryReader = Pick<URLSearchParams, "get">;
export type QueryPatch = Record<string, string | null>;

function allowedValue<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

export function readTaskDetailTab(query: QueryReader) {
  return allowedValue(query.get("tab"), taskDetailTabs, "overview");
}

export function readEvidenceView(query: QueryReader) {
  return allowedValue(query.get("view"), evidenceViews, "task");
}

export interface EvidenceFilters {
  task: string;
  source: Evidence["source"] | "all";
  author: string;
  criterion: string;
  status: EvidenceStatus | "all";
  q: string;
}

export function readEvidenceFilters(query: QueryReader): EvidenceFilters {
  return {
    task: query.get("task") || "all",
    source: allowedValue(query.get("source"), ["all", ...evidenceSources], "all"),
    author: query.get("author") || "all",
    criterion: query.get("criterion") || "all",
    status: allowedValue(query.get("status"), ["all", ...evidenceStatuses], "all"),
    q: query.get("q") ?? "",
  };
}

/** Preserve unrelated query parameters and anchors when changing one filter. */
export function patchQueryHref(currentHref: string, patch: QueryPatch): string {
  const url = new URL(currentHref);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function filterEvidence(
  evidence: readonly Evidence[],
  filters: EvidenceFilters,
  labels: { task: (id: string) => string; author: (id: string) => string },
): Evidence[] {
  const query = filters.q.trim().toLocaleLowerCase();
  return evidence.filter((item) =>
    (filters.task === "all" || item.taskId === filters.task)
    && (filters.source === "all" || item.source === filters.source)
    && (filters.author === "all" || item.authorId === filters.author)
    && (filters.criterion === "all" || item.criterionIds.includes(filters.criterion))
    && (filters.status === "all" || item.status === filters.status)
    && (!query || `${item.title} ${item.description} ${labels.task(item.taskId)} ${labels.author(item.authorId)}`.toLocaleLowerCase().includes(query)),
  );
}

/** Never turn arbitrary evidence metadata into an executable or local URL. */
export function safeEvidenceSourceUrl(value?: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
