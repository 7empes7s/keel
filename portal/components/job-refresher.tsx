"use client";

import { LiveIndicator } from "@/components/ui/live-indicator";
import { useRefreshPoll } from "@/lib/use-poll";

// While any listed job is queued or running, refreshes the server
// components on an interval so job progress shows up without a manual reload — the
// portal has no client data library, so router.refresh() IS the polling mechanism.
// Only while the tab is visible, and never while the last refresh is still loading.
export function JobRefresher({
  active,
  intervalMs = 3000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  useRefreshPoll(intervalMs, active);

  return active ? <LiveIndicator intervalMs={intervalMs} /> : null;
}
