// Gap P2: the committed live records, verified for this portal's tenant on first use
// and re-checked at most every REFRESH_MS, so a record that expires stops counting as
// live without a restart. Verification is tools/qualification/liveRecords.mjs, which
// runs the same checks the release ledger and the Entra promotion use.
import { loadLiveRecords, NO_KEY_REASON } from "../../tools/qualification/liveRecords.mjs";

import { liveEvidenceDir, qualificationKey } from "@/lib/runtime-config";

export const REFRESH_MS = 10 * 60 * 1000;

export type LiveRecords = ReturnType<typeof loadLiveRecords>;

let cached: { tenantRef: string; at: number; records: LiveRecords } | null = null;

export function getLiveRecords(tenantRef: string, now: Date = new Date()): LiveRecords {
  if (cached && cached.tenantRef === tenantRef && now.getTime() - cached.at < REFRESH_MS && now.getTime() >= cached.at) {
    return cached.records;
  }
  const { key, problem } = qualificationKey();
  const records = loadLiveRecords({
    dir: liveEvidenceDir(),
    hmacKey: key,
    tenantRef,
    now,
    missingKeyReason: problem ?? NO_KEY_REASON,
  });
  cached = { tenantRef, at: now.getTime(), records };
  return records;
}

/** Test seam: forget the cached result. */
export function resetLiveRecordsCache(): void {
  cached = null;
}
