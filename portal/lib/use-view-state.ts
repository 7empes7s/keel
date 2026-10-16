"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

// View state lives in the URL (redesign rule 8): grouping, sort, filters, the chosen
// dates and which groups are closed. A new tab, Back or a saved view brings the same
// view back. Defaults stay out of the URL so links stay short.
export function useViewState() {
  const pathname = usePathname() ?? "/";
  const params = useSearchParams();
  const router = useRouter();

  const get = useCallback((key: string, fallback = ""): string => params?.get(key) ?? fallback, [params]);

  const set = useCallback((changes: Record<string, string | null | undefined>, defaults: Record<string, string> = {}) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "" || value === defaults[key]) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  return { get, set };
}

/** A comma-separated list kept in one query parameter. */
export function readList(value: string): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}
