"use client";

import { useSearchParams } from "next/navigation";
import { patchQueryHref, type QueryPatch } from "./url-filters";

/** Next's history integration keeps search params in sync on Back/Forward. */
export function useUrlQuery() {
  const query = useSearchParams();
  const updateQuery = (patch: QueryPatch) => {
    // Read the latest location so consecutive controls cannot overwrite each other.
    const nextHref = patchQueryHref(window.location.href, patch);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref !== currentHref) window.history.pushState(null, "", nextHref);
  };
  return { query, updateQuery };
}
