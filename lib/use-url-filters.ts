"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { clearUrlFilters, patchUrlFilters, readUrlFilters, type UrlFilterPatch, type UrlFilterSchema, type UrlFilterValues } from "@/lib/url-filters";

/**
 * Read and write a page's tabs, filters, sort and page number in the URL.
 * Next keeps useSearchParams in sync with pushState, so Back/Forward restore state.
 */
export function useUrlFilters<S extends UrlFilterSchema>(schema: S) {
  const query = useSearchParams();
  const values = useMemo(() => readUrlFilters(schema, query), [schema, query]);
  const push = (href: string) => {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href !== current) window.history.pushState(null, "", href);
  };
  // Read window.location at call time so two quick updates cannot overwrite each other.
  const setFilters = useCallback((patch: UrlFilterPatch<S>) => push(patchUrlFilters(schema, window.location.href, patch)), [schema]);
  const clearFilters = useCallback(() => push(clearUrlFilters(schema, window.location.href)), [schema]);
  return { filters: values as UrlFilterValues<S>, setFilters, clearFilters };
}
