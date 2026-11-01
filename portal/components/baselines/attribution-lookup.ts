"use client";

import { useEffect, useState } from "react";

import type { ChangeAttribution } from "@/lib/types";

// The Changes list reads the audit log for its first 200 changes only. A change further
// down, or one whose read failed, is looked up on its own when a person opens it.
export type AttributionLookup = { state: "checking" } | { state: "found"; attribution: ChangeAttribution } | { state: "failed" };

export function useAttributionLookup(id: string | null): AttributionLookup | null {
  const [result, setResult] = useState<{ id: string; lookup: AttributionLookup } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetch(`/api/drift/attribution?id=${encodeURIComponent(id)}`, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = response.ok ? ((await response.json()) as { attribution?: ChangeAttribution | null }) : null;
        if (live) setResult({ id, lookup: body?.attribution ? { state: "found", attribution: body.attribution } : { state: "failed" } });
      })
      .catch(() => {
        if (live) setResult({ id, lookup: { state: "failed" } });
      });
    return () => {
      live = false;
    };
  }, [id]);
  if (!id) return null;
  return result?.id === id ? result.lookup : { state: "checking" };
}
