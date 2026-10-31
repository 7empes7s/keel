"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { announceUrl, currentPath, currentQuery, replaceUrl, subscribeUrl } from "@/lib/url-history";

/** The address's query as the browser holds it now. Use this, not useSearchParams, for
 * view state kept in the URL. Next.js applies an address change as a low-priority router
 * update that a background refresh still waiting on the server holds back, so on a slow
 * server a clicked row changed the address but its panel did not open, and the Find box
 * stopped filtering. This reads the browser's address at once after each write
 * (lib/url-history). The server's draw and the first draw in the browser use what Next.js
 * read from the request, so they match. */
export function useLiveSearchParams(): URLSearchParams {
  const drawnPath = usePathname() ?? "/";
  const drawnQuery = useSearchParams()?.toString() ?? "";
  // A Next.js link to another page draws that page before the address bar changes, so
  // until the address catches up, the page's own path and query are the ones to use.
  const live = useSyncExternalStore(subscribeUrl, liveAddress, () => "");
  const query = live && (live === drawnPath || live.startsWith(`${drawnPath}?`)) ? live.slice(drawnPath.length + 1) : drawnQuery;
  // A Next.js link (a tile, a chip) moves the address after drawing: read it again then.
  useEffect(() => { announceUrl(); }, [drawnPath, drawnQuery]);
  return useMemo(() => new URLSearchParams(query), [query]);
}

function liveAddress(): string {
  const query = currentQuery();
  return query ? `${currentPath()}?${query}` : currentPath();
}

// View state lives in the URL (redesign rule 8): grouping, sort, filters, the chosen
// dates and which groups are closed. A new tab, Back or a saved view brings the same
// view back. Defaults stay out of the URL so links stay short. Changing it never asks
// the server for the page again (lib/url-history). Each change starts from the live
// address, so two changes close together (a tile click, then the Find box's delayed
// write) both stay.
export function useViewState() {
  const pathname = usePathname() ?? "/";
  const params = useLiveSearchParams();

  const get = useCallback((key: string, fallback = ""): string => params.get(key) ?? fallback, [params]);

  const set = useCallback((changes: Record<string, string | null | undefined>, defaults: Record<string, string> = {}) => {
    const next = new URLSearchParams(currentQuery());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "" || value === defaults[key]) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    replaceUrl(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);

  return { get, set };
}

/** A comma-separated list kept in one query parameter. */
export function readList(value: string): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}
