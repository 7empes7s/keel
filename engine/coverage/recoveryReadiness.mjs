/**
 * Roadmap task-72: Keel recovery readiness from recovery-drill evidence.
 *
 * A drill counts as a recovery drill only when every one of these holds on
 * the recorded evidence itself:
 *  - it ran live (offline plan validation never counts, whatever it says);
 *  - it was a bounded same-tenant drill pinned to the tenant being asked about;
 *  - its outcome is "passed";
 *  - its cleanup was verified complete (every created object read back absent);
 *  - its elapsed time is the observed clock difference between its recorded
 *    start and finish, inside the manifest's time bound.
 * A drill whose cleanup failed is listed in cleanupFailures and turns the
 * readiness state to "attention": residual disposable objects may still be in
 * the tenant. No evidence at all is "unmeasured", never "ready".
 */

export const RECOVERY_DRILL_EVIDENCE_KIND = 'recovery-drill';

function instant(value) {
  const date = new Date(value);
  return typeof value === 'string' && !Number.isNaN(date.getTime()) ? date : null;
}

/** Why a single drill record does or does not count. */
export function classifyDrillRecord(subject, { tenantRef }) {
  if (!subject || typeof subject !== 'object') return { counts: false, reason: 'malformed' };
  if (subject.tenantRef !== tenantRef) return { counts: false, reason: 'foreign-tenant' };
  if (subject.mode !== 'live') return { counts: false, reason: 'offline-validation' };
  if (subject.scope !== 'bounded-same-tenant') return { counts: false, reason: 'unbounded-scope' };
  if (subject.cleanup?.status !== 'complete') return { counts: false, reason: 'cleanup-failed' };
  if (subject.outcome !== 'passed') return { counts: false, reason: `outcome-${subject.outcome ?? 'unknown'}` };
  const started = instant(subject.startedAt);
  const finished = instant(subject.finishedAt);
  if (subject.elapsedSource !== 'observed-clock' || !started || !finished
    || subject.elapsedMs !== finished.getTime() - started.getTime() || subject.elapsedMs < 0) {
    return { counts: false, reason: 'elapsed-not-observed' };
  }
  if (!Number.isInteger(subject.bounds?.maxElapsedMs) || subject.elapsedMs > subject.bounds.maxElapsedMs) {
    return { counts: false, reason: 'exceeded-bound' };
  }
  return { counts: true, reason: 'live-bounded-drill' };
}

/**
 * records: evidence rows ({ tenant_ref, occurred_at, subject }) in any order.
 * Rows of another tenant are ignored entirely; they are never a candidate.
 */
export function summarizeRecoveryReadiness(records, { tenantRef }) {
  const own = records
    .filter((record) => record.tenant_ref === tenantRef)
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const counted = [];
  const notCounted = [];
  const cleanupFailures = [];
  for (const record of own) {
    const verdict = classifyDrillRecord(record.subject, { tenantRef });
    const at = new Date(record.occurred_at).toISOString();
    if (record.subject?.cleanup && record.subject.cleanup.status !== 'complete') {
      cleanupFailures.push({ at, objects: record.subject.objects ?? [], residuals: record.subject.cleanup.residuals ?? [] });
    }
    if (verdict.counts) {
      counted.push({ at, elapsedMs: record.subject.elapsedMs, objects: record.subject.objects ?? [] });
    } else {
      notCounted.push({ at, reason: verdict.reason });
    }
  }
  const lastCountedDrill = counted.at(-1) ?? null;
  let state = 'unmeasured';
  if (cleanupFailures.length) state = 'attention';
  else if (lastCountedDrill) state = 'drilled';
  return {
    tenantRef,
    state,
    countedDrills: counted.length,
    lastCountedDrill,
    notCounted,
    cleanupFailures,
    scope: 'bounded same-tenant drills of disposable objects; not a tenant-wide recovery proof',
  };
}

/** Tenant-scoped read of recovery-drill evidence. */
export async function loadRecoveryReadiness(client, { tenantRef }) {
  if (!tenantRef) throw new Error('recovery readiness needs a tenantRef');
  const { rows } = await client.query(
    `SELECT tenant_ref, occurred_at, subject
       FROM evidence
      WHERE tenant_ref = $1 AND kind = $2
      ORDER BY occurred_at, seq`,
    [tenantRef, RECOVERY_DRILL_EVIDENCE_KIND],
  );
  return summarizeRecoveryReadiness(rows, { tenantRef });
}
