// Failed restores (audit metric 7): one count from the engine
// (engine/restore/failedRestores.mjs), shown with the same words on Resilience,
// Restore and the value report, each linking to the same list.

export interface FailedRestoreCounts {
  total: number;
  recent: { days: number; count: number };
  period: { from: string; to: string; count: number } | null;
  newest: { jobId: string; at: string } | null;
  href: string;
}

/** "47 restores failed" / "A restore failed". */
export function failedRestoresTitle(counts: FailedRestoreCounts): string {
  return counts.total === 1 ? "A restore failed" : `${counts.total} restores failed`;
}

/** "3 in the last 30 days": the window every page shows next to the total. */
export function failedRestoresRecent(counts: FailedRestoreCounts): string {
  return `${counts.recent.count} in the last ${counts.recent.days} days`;
}

/** "47 restores failed · 3 in the last 30 days", or null when none ever failed. */
export function failedRestoresLine(counts: FailedRestoreCounts | null | undefined): string | null {
  if (!counts || counts.total === 0) return null;
  return `${failedRestoresTitle(counts)} · ${failedRestoresRecent(counts)}`;
}
