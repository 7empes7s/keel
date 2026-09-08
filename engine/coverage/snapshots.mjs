/**
 * Shared by coverage and holdings. $1 is the tenant reference. Select the
 * newest mention, including failures, nulls and legacy zeros; filtering for
 * success here would resurrect an older success after a later failure.
 */
export const TYPE_COVERAGE_CTES = `
  completed_snapshots AS (
    SELECT id, status, started_at, completed_at, coverage_digest
    FROM snapshot
    WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
  ),
  latest_type_coverage AS (
    SELECT DISTINCT ON (entry.key)
      entry.key AS resource_type, entry.value AS coverage_entry,
      s.id AS snapshot_id, s.completed_at
    FROM completed_snapshots s
    CROSS JOIN LATERAL jsonb_each(COALESCE(s.coverage_digest, '{}'::jsonb)) entry
    ORDER BY entry.key, s.completed_at DESC, s.started_at DESC, s.id DESC
  )`;

/** Legacy non-zero counts are evidence; legacy zero cannot prove an empty read. */
export function readCoverageOutcome(entry) {
  const legacy = typeof entry === 'number';
  const count = legacy ? entry : entry?.itemCount;
  const validCount = Number.isSafeInteger(count) && count >= 0;
  const complete = legacy ? count > 0 : entry?.outcome === 'complete';
  return { covered: complete && validCount, itemCount: validCount ? count : null };
}
