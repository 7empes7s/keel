"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { LiveIndicator } from "@/components/ui/live-indicator";

// While any listed job is queued or running, refreshes the server
// components on an interval so job progress shows up without a manual reload — the
// portal has no client data library, so router.refresh() IS the polling mechanism.
export function JobRefresher({
  active,
  intervalMs = 3000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);

  return active ? <LiveIndicator intervalMs={intervalMs} /> : null;
}
