"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { currentQuery, replaceUrl } from "@/lib/url-history";

// View state lives in the URL (redesign rule 8): grouping, sort, filters, the chosen
// dates and which groups are closed. A new tab, Back or a saved view brings the same
// view back. Defaults stay out of the URL so links stay short. Changing it never asks
// the server for the page again (lib/url-history). Each change starts from the live
// address, so two changes close together (a tile click, then the Find box's delayed
// write) both stay.
export function useViewState() {
  const pathname = usePathname() ?? "/";
  const params = useSearchParams();

  const get = useCallback((key: string, fallback = ""): string => params?.get(key) ?? fallback, [params]);

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
