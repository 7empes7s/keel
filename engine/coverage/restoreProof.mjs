// engine/coverage/restoreProof.mjs
//
// "Restore proven", defined once (portal audit 31 Oct 2026, metric 5). Overview,
// What's protected and Setup each counted it their own way, so the same tenant read
// "107 of 192", "0 of 107" and "none proven yet". Every page now counts it here.
//
// For each kind Keel knows:
//  - none:     Keel cannot put it back (no collector, not on this tenant, Microsoft
//              manages it, or read-only with no tested writer).
//  - proven:   a live test restore on this tenant succeeded: a restore drill measured
//              full or partial fidelity, or a write ran live on the tenant and its
//              record still counts (claim "live-qualified").
//  - tested:   Keel's writer passes its fixture tests, but nothing ran live yet.
//  - untested: Keel declares it can put the kind back, with no test of either sort.
//
// The denominator is always the kinds Keel can put back (every kind not "none"),
// whatever the state of their last backup.
//
// Reads both the engine coverage entry (engine/coverage/report.mjs: `status`,
// `fidelity.verifiedBy`) and the portal's normalised kind (`reportStatus`,
// `fidelity.measured`, `fidelity.verifiedAt`), so the server and the browser count
// with the same code.

const RESTORABLE = new Set(['full', 'partial']);
const TESTED_CLAIMS = new Set(['fixture-tested', 'live-qualified']);
const NOT_COLLECTED = new Set(['not-covered', 'never-collected']);

/** The list every "restore proven" number counts. */
export const RESTORE_PROVEN_HREF = '/protect?health=proven';

function operations(entry) {
  return Object.values(entry?.writeCapability?.operations ?? {}).filter(Boolean);
}

const FIDELITIES = new Set(['full', 'partial', 'read-only', 'unprotectable']);

// Only the four known values count, as in the portal's normaliser, so both paths agree.
function measuredFidelity(entry) {
  const value = entry?.fidelity?.verifiedBy?.measuredFidelity ?? entry?.fidelity?.measured ?? null;
  return FIDELITIES.has(value) ? value : null;
}

function drillAt(entry) {
  return entry?.fidelity?.verifiedBy?.at ?? entry?.fidelity?.verifiedAt ?? null;
}

function liveOperations(entry) {
  return operations(entry).filter((capability) => capability.claim === 'live-qualified' && capability.liveRecord?.live !== false);
}

/**
 * Whether Keel has a tested writer for the kind: an automated recovery decision and at
 * least one write operation tested on fixtures or proven live.
 */
export function hasRestoreWriter(entry) {
  if (entry?.qualification?.decision !== 'automated' || !entry.writeCapability) return false;
  return operations(entry).some((capability) => TESTED_CLAIMS.has(capability.claim));
}

/** Whether Keel can put the kind back at all. */
export function canRestore(entry) {
  const status = entry?.status ?? entry?.reportStatus;
  if (NOT_COLLECTED.has(status) || entry?.outcome === 'unavailable') return false;
  // A drill's measurement wins over what the kind declares.
  const measured = measuredFidelity(entry);
  if (measured) return RESTORABLE.has(measured);
  const declared = entry?.fidelity?.declared ?? null;
  if (declared === 'unprotectable') return false;
  return RESTORABLE.has(declared ?? '') || hasRestoreWriter(entry);
}

/** @returns {'proven' | 'tested' | 'untested' | 'none'} */
export function restoreProof(entry) {
  if (!canRestore(entry)) return 'none';
  if (RESTORABLE.has(measuredFidelity(entry) ?? '') || liveOperations(entry).length > 0) return 'proven';
  return hasRestoreWriter(entry) ? 'tested' : 'untested';
}

function time(value) {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/** When a live test restore last proved this kind, or null when it is not proven. */
export function provenAt(entry) {
  if (restoreProof(entry) !== 'proven') return null;
  const times = [
    RESTORABLE.has(measuredFidelity(entry) ?? '') ? time(drillAt(entry)) : null,
    ...liveOperations(entry).map((capability) => time(capability.liveRecord?.observedAt)),
  ].filter((at) => at !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * The one "restore proven" count.
 * @returns {{ restorable: number, proven: number, tested: number, untested: number,
 *   lastProvenAt: string | null, href: string }}
 */
export function restoreProofSummary(entries) {
  const counts = { proven: 0, tested: 0, untested: 0 };
  let last = null;
  for (const entry of entries ?? []) {
    const proof = restoreProof(entry);
    if (proof === 'none') continue;
    counts[proof] += 1;
    const at = time(provenAt(entry));
    if (at !== null && (last === null || at > last)) last = at;
  }
  return {
    restorable: counts.proven + counts.tested + counts.untested,
    ...counts,
    lastProvenAt: last === null ? null : new Date(last).toISOString(),
    href: RESTORE_PROVEN_HREF,
  };
}
