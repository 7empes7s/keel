/**
 * Shared by coverage and holdings. $1 is the tenant reference. Select the
 * newest mention, including failures, nulls and legacy zeros; filtering for
 * success here would resurrect an older success after a later failure. A
 * not-requested entry is the one exception: it records that a run deliberately
 * did not read the type (e.g. tier filtering), which is not an observation and
 * must never shadow an older genuine one. started_at is carried alongside
 * completed_at so each per-type entry keeps its own observation window — a
 * report assembled from these rows is a merge of per-type runs, never an
 * atomic tenant-wide image.
 */
import { OBSERVATION_CONTRACT_VERSION, readObservation } from '../contracts/observation.mjs';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';

export const OUTCOME_STATES = Object.freeze(['complete', 'complete-empty', 'partial', 'failed', 'not-requested']);

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
    WHERE entry.value ->> 'outcome' IS DISTINCT FROM 'not-requested'
    ORDER BY entry.key, s.completed_at DESC, s.started_at DESC, s.id DESC
  )`;

/**
 * Legacy non-zero counts are evidence; legacy zero cannot prove an empty read.
 * Versioned entries (observation contract v1) are covered by their recorded
 * completeness with a valid count; a partial or failed window never reads as
 * covered regardless of how many items it saw. A completed empty read
 * ('complete-empty') is a strict coverage success, exactly like 'complete'
 * with a zero count; 'partial' and 'not-requested' never are.
 */
export function readCoverageOutcome(entry) {
  if (entry && typeof entry === 'object' && entry.contractVersion === OBSERVATION_CONTRACT_VERSION) {
    const count = entry.itemCount;
    const validCount = Number.isSafeInteger(count) && count >= 0;
    const complete = entry.completeness === 'complete' || entry.completeness === 'complete-empty'
      || entry.outcome === 'complete' || entry.outcome === 'complete-empty';
    return {
      covered: complete && validCount,
      itemCount: validCount ? count : null,
    };
  }
  const legacy = typeof entry === 'number';
  const count = legacy ? entry : entry?.itemCount;
  const validCount = Number.isSafeInteger(count) && count >= 0;
  const complete = legacy
    ? count > 0
    : entry?.outcome === 'complete' || entry?.outcome === 'complete-empty';
  return { covered: complete && validCount, itemCount: validCount ? count : null };
}

/**
 * The normalized outcome vocabulary of a digest entry, or null when the entry
 * predates explicit outcomes (bare counts, nulls, silence) — absence is
 * reported, never rewritten into a claim.
 */
export function readOutcome(entry) {
  if (entry && typeof entry === 'object' && OUTCOME_STATES.includes(entry.outcome)) {
    return entry.outcome;
  }
  return null;
}

function asIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

/**
 * The structured evidence a digest entry carries: HTTP status, Graph code,
 * redacted message, endpoint/API version, observation timestamps and
 * pagination state. Fields that were never observed stay null; an entry with
 * no evidence at all (bare counts, contract-v1 observations) reads as null
 * rather than inventing detail. Messages are redacted again at this boundary
 * so token-shaped values can never reach a report even from a hand-written or
 * older digest row.
 */
export function readOutcomeDetail(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const detail = {
    httpStatus: Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
    graphCode: typeof entry.graphCode === 'string' ? entry.graphCode : null,
    message: typeof entry.error === 'string' ? redactSecrets(entry.error) : null,
    endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : null,
    apiVersion: typeof entry.apiVersion === 'string' ? entry.apiVersion : null,
    pagesCompleted: Number.isSafeInteger(entry.pagesCompleted) ? entry.pagesCompleted : null,
    startedAt: asIso(entry.startedAt),
    completedAt: asIso(entry.completedAt),
  };
  return Object.values(detail).some((value) => value !== null) ? detail : null;
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
