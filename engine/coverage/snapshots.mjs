/**
 * Shared by coverage and holdings. $1 is the tenant reference. Select the
 * newest mention, including failures, nulls and legacy zeros; filtering for
 * success here would resurrect an older success after a later failure.
 * started_at is carried alongside completed_at so each per-type entry keeps
 * its own observation window — a report assembled from these rows is a merge
 * of per-type runs, never an atomic tenant-wide image.
 */
import { OBSERVATION_CONTRACT_VERSION, readObservation } from '../contracts/observation.mjs';

export const TYPE_COVERAGE_CTES = `
  completed_snapshots AS (
    SELECT id, status, started_at, completed_at, coverage_digest
    FROM snapshot
    WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
  ),
  latest_type_coverage AS (
    SELECT DISTINCT ON (entry.key)
      entry.key AS resource_type, entry.value AS coverage_entry,
      s.id AS snapshot_id, s.started_at, s.completed_at
    FROM completed_snapshots s
    CROSS JOIN LATERAL jsonb_each(COALESCE(s.coverage_digest, '{}'::jsonb)) entry
    ORDER BY entry.key, s.completed_at DESC, s.started_at DESC, s.id DESC
  )`;

/**
 * Legacy non-zero counts are evidence; legacy zero cannot prove an empty read.
 * Versioned entries (observation contract v1) are covered by their recorded
 * completeness with a valid count; a partial or failed window never reads as
 * covered regardless of how many items it saw.
 */
export function readCoverageOutcome(entry) {
  if (entry && typeof entry === 'object' && entry.contractVersion === OBSERVATION_CONTRACT_VERSION) {
    const count = entry.itemCount;
    const validCount = Number.isSafeInteger(count) && count >= 0;
    return {
      covered: entry.completeness === 'complete' && validCount,
      itemCount: validCount ? count : null,
    };
  }
  const legacy = typeof entry === 'number';
  const count = legacy ? entry : entry?.itemCount;
  const validCount = Number.isSafeInteger(count) && count >= 0;
  const complete = legacy ? count > 0 : entry?.outcome === 'complete';
  return { covered: complete && validCount, itemCount: validCount ? count : null };
}

/**
 * Read one per-type coverage-digest entry as a versioned observation
 * (task-45). Legacy entries keep their old outcome meaning via
 * readObservation; their window falls back to the snapshot run bounds and
 * their evidence level stays 'unknown'. A digest entry naming a different
 * tenant than the snapshot it is stored under is rejected, never joined.
 */
export function readTypeObservation({
  resourceType, coverageEntry, snapshotId, snapshotStartedAt, snapshotCompletedAt, tenantRef,
}) {
  return readObservation(coverageEntry, {
    tenantRef,
    observationId: `${snapshotId}:${resourceType}`,
    resourceType,
    snapshotWindow: { startedAt: snapshotStartedAt, endedAt: snapshotCompletedAt },
  });
}
