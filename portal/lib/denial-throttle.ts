// Security audit run 2, finding 10: every denied action used to append one evidence record,
// each under the tenant's evidence lock, so a client retrying a forbidden request could
// flood the audit chain. The first denial of a kind (same tenant, actor, action and reason)
// is recorded at once; repeats inside the window are counted, and the count is written on
// the next record of that kind as `repeatedDenials`. Repeats are written only when a later
// denial of the same kind is recorded, so a burst followed by silence (or a portal restart)
// leaves its count unrecorded; the first denial of every kind is always written.
export const DENIAL_WINDOW_MS = 60 * 1000;
const MAX_TRACKED = 1000;

export interface DenialThrottle {
  /** null: skip recording this one. A number: record it, with that many earlier repeats. */
  admit(key: string): number | null;
  /** The record for an admitted denial could not be written: let the next one through. */
  forget(key: string, repeats: number): void;
}

export function createDenialThrottle({
  windowMs = DENIAL_WINDOW_MS,
  maxTracked = MAX_TRACKED,
  now = Date.now,
}: { windowMs?: number; maxTracked?: number; now?: () => number } = {}): DenialThrottle {
  const seen = new Map<string, { until: number; repeats: number }>();
  return {
    admit(key) {
      const at = now();
      const entry = seen.get(key);
      if (entry && at < entry.until) {
        entry.repeats += 1;
        return null;
      }
      const repeats = entry?.repeats ?? 0;
      seen.delete(key);
      if (seen.size >= maxTracked) {
        for (const [tracked, value] of seen) if (value.until <= at) seen.delete(tracked);
        // Still full: drop the oldest. Its uncounted repeats are lost, never its first record.
        if (seen.size >= maxTracked) seen.delete(seen.keys().next().value as string);
      }
      seen.set(key, { until: at + windowMs, repeats: 0 });
      return repeats;
    },
    forget(key, repeats) {
      // Keep the uncounted repeats so the next record still carries them.
      const entry = seen.get(key);
      seen.set(key, { until: 0, repeats: repeats + (entry?.repeats ?? 0) });
    },
  };
}

export const denialThrottle = createDenialThrottle();
