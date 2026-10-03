// engine/coverage/protectionHeadline.mjs
//
// Roadmap task-129 (portal experience contract, "The memorable number"): the one
// sentence an executive can repeat, computed from the coverage report
// (engine/coverage/report.mjs buildCoverageReport().types) and the restore-drill
// evidence it already carries. Never a constant, and honest when the data is absent:
//
//  - collection failing, stale or never run for some type:
//      "3 configuration types have not been backed up since 1 Oct 2026."
//  - a restore has been proven on this tenant (fidelity-drill evidence):
//      "KEEL can restore 48 of 52 configuration types today. Last proven restore: 20 Sept 2026."
//  - nothing proven yet:
//      "KEEL backs up 52 configuration types. No restore has been proven on this tenant yet."
//
// A type counts as backed up when its latest collection completed and is fresh for
// its tier. It counts as restorable when it is backed up and its fidelity — measured
// by a drill when one ran, otherwise declared — is full or partial. "Not covered"
// types (no collector exists) are a coverage gap reported elsewhere, not a failure.

const RESTORABLE = new Set(['full', 'partial']);

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function formatHeadlineDate(value) {
  return DATE.format(new Date(value));
}

function plural(count, one, many) {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;
}

/**
 * @param {Array<{ type: string, status: string, stale?: boolean, lastCollectedAt?: string | Date | null,
 *   fidelity?: { declared?: string | null, verifiedBy?: { at?: string | Date, measuredFidelity?: string | null } | null } }>} types
 * @returns {{ state: 'collection' | 'proven' | 'unproven', tone: 'good' | 'attention' | 'critical', headline: string,
 *   sentence: string, action: { label: string, href: string } | null, counts: { backedUp: number, restorable: number,
 *   failing: number, failed: number, stale: number, neverCollected: number }, lastProvenRestoreAt: string | null, failingSince: string | null }}
 */
export function protectionHeadline(types) {
  const failing = types.filter((entry) => entry.status === 'failed' || entry.status === 'never-collected'
    || (entry.status === 'covered' && entry.stale === true));
  const backedUp = types.filter((entry) => entry.status === 'covered' && entry.stale !== true);
  const restorable = backedUp.filter((entry) => {
    const measured = entry.fidelity?.verifiedBy?.measuredFidelity ?? null;
    return RESTORABLE.has(measured ?? entry.fidelity?.declared ?? '');
  });
  const drills = types
    .map((entry) => entry.fidelity?.verifiedBy?.at ?? null)
    .filter((at) => at !== null)
    .map((at) => new Date(at))
    .filter((at) => Number.isFinite(at.getTime()));
  const lastProven = drills.length ? new Date(Math.max(...drills.map((at) => at.getTime()))) : null;
  const neverCollected = failing.filter((entry) => entry.status === 'never-collected');
  const failed = failing.filter((entry) => entry.status === 'failed');
  const stale = failing.filter((entry) => entry.status === 'covered');
  // Only a stale type has a known last GOOD backup; a failed type's timestamp is the
  // failed attempt, so it never feeds "since".
  const staleTimes = stale
    .map((entry) => (entry.lastCollectedAt ? new Date(entry.lastCollectedAt) : null))
    .filter((at) => at && Number.isFinite(at.getTime()));
  const failingSince = staleTimes.length ? new Date(Math.min(...staleTimes.map((at) => at.getTime()))) : null;
  const counts = {
    backedUp: backedUp.length, restorable: restorable.length, failing: failing.length,
    failed: failed.length, stale: stale.length, neverCollected: neverCollected.length,
  };
  const base = { counts, lastProvenRestoreAt: lastProven?.toISOString() ?? null, failingSince: failingSince?.toISOString() ?? null };

  if (failing.length > 0) {
    const subject = plural(failing.length, 'configuration type has', 'configuration types have');
    let sentence;
    if (stale.length === failing.length) sentence = `${subject} not been backed up since ${formatHeadlineDate(failingSince)}.`;
    else if (neverCollected.length === failing.length) sentence = `${subject} never been backed up.`;
    else if (failed.length === failing.length) {
      sentence = `${plural(failed.length, 'configuration type', 'configuration types')} failed ${failed.length === 1 ? 'its' : 'their'} last backup.`;
    } else {
      sentence = `${subject} no current backup; the last backup failed for ${failed.length.toLocaleString('en-GB')} of them.`;
    }
    return {
      ...base,
      state: 'collection',
      tone: backedUp.length === 0 ? 'critical' : 'attention',
      headline: backedUp.length === 0 ? 'Not protected' : 'Backups need attention',
      sentence,
      action: { label: 'Review backups', href: '/protect' },
    };
  }
  if (backedUp.length === 0) {
    return {
      ...base,
      state: 'collection',
      tone: 'critical',
      headline: 'Not protected',
      sentence: 'Nothing has been backed up yet, so there is nothing to restore from.',
      action: { label: 'Review backups', href: '/protect' },
    };
  }
  if (lastProven) {
    return {
      ...base,
      state: 'proven',
      tone: 'good',
      headline: 'Protected',
      sentence: `KEEL can restore ${restorable.length.toLocaleString('en-GB')} of ${plural(backedUp.length, 'configuration type', 'configuration types')} today. Last proven restore: ${formatHeadlineDate(lastProven)}.`,
      action: null,
    };
  }
  return {
    ...base,
    state: 'unproven',
    tone: 'attention',
    // Backed up, but no restore has been proven: "Protected" would overclaim.
    headline: 'Backed up',
    sentence: `KEEL backs up ${plural(backedUp.length, 'configuration type', 'configuration types')}. No restore has been proven on this tenant yet.`,
    action: { label: 'Plan a test restore', href: '/restore' },
  };
}
