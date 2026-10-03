/**
 * Roadmap task-73: measured freshness, recoverable point and recovery time.
 *
 * Every number here is measured from what KEEL actually holds, never from what
 * it is configured to do:
 *
 *  - Freshness (achieved RPO) comes from SUCCESSFUL per-type and per-relationship
 *    observation sets. The oldest required dependency decides it. A failed or
 *    partial latest collection never moves it forward: the last success stands.
 *    A dependency with no successful observation at all is a gap, and while any
 *    gap exists the achieved RPO is unmeasured, not the age of the others.
 *  - The recoverable point comes from off-site copies whose recovery manifest
 *    was verified against the actual artifact bytes and whose remote checksum
 *    matched. A copy's point is the oldest observation (window start) it holds
 *    for any required dependency. A copy that lacks a successful observation of
 *    a required dependency recovers nothing complete and never advances the
 *    point, however new it is.
 *  - Recovery time (achieved RTO) comes from verified history only: recovery
 *    drills that task-72's classifier counts, and enforced restores that
 *    succeeded and whose completion items are all verified. A failed, cancelled
 *    or unverified attempt is listed but never becomes a sample.
 *  - Configured collection cadence is reported beside the measurements, labelled
 *    as configuration. It is never used as an achieved value. KEEL has no stored
 *    recovery objective, so objectives read as not set.
 *
 * No samples means "unmeasured". Every read is pinned to one tenant_ref; rows of
 * another tenant are never candidates. Jobs carry no tenant_ref, so a restore job
 * is attributed through its dry-run plan's tenant_ref.
 */
import { appendEvidence } from '../govern/evidence.mjs';
import { verifyRecoveryManifest } from '../storage/recoveryManifest.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { classifyDrillRecord, loadRecoveryReadiness, RECOVERY_DRILL_EVIDENCE_KIND } from './recoveryReadiness.mjs';
import { readCoverageOutcome } from './snapshots.mjs';

export const RECOVERY_METRICS_VERSION = 1;
export const OFFSITE_COPY_EVIDENCE_KIND = 'offsite-copy';

const HEX64 = /^[0-9a-f]{64}$/;
const SUCCESS = new Set(['complete', 'complete-empty']);

function instant(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOf(value) {
  return instant(value)?.toISOString() ?? null;
}

export function typeDependency(type) {
  return { key: `type:${type}`, kind: 'type', type };
}

export function relationshipDependency(parentType, family) {
  return { key: `relationship:${parentType}/${family}`, kind: 'relationship', parentType, family };
}

/**
 * One type's digest entry as an observation. Success is the coverage report's own
 * rule (readCoverageOutcome); the window prefers the entry's own instants and falls
 * back to its snapshot's run bounds.
 */
export function typeObservation({ type, entry, snapshotId, snapshotStartedAt, snapshotCompletedAt }) {
  const startedAt = instant(entry?.startedAt) ?? instant(snapshotStartedAt);
  const completedAt = instant(entry?.completedAt) ?? instant(snapshotCompletedAt);
  return {
    dependency: typeDependency(type).key,
    observationId: `${snapshotId}:${type}`,
    snapshotId,
    outcome: typeof entry === 'number' ? 'legacy-count' : (entry?.outcome ?? null),
    success: readCoverageOutcome(entry).covered === true && startedAt !== null,
    startedAt: startedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
  };
}

/**
 * One relationship family read in one snapshot, from its edge-set rows. Successful
 * only when every read of the family in that snapshot completed (an unsupported
 * parent read is neither success nor failure; a family read only as unsupported is
 * not an observation at all).
 */
export function relationshipObservation({ parentType, family, snapshotId, sets }) {
  const reads = sets.filter((set) => set.outcome !== 'unsupported');
  if (reads.length === 0) return null;
  const starts = reads.map((set) => instant(set.started_at ?? set.startedAt)).filter(Boolean);
  const ends = reads.map((set) => instant(set.completed_at ?? set.completedAt)).filter(Boolean);
  const success = reads.every((set) => SUCCESS.has(set.outcome)) && starts.length === reads.length;
  const failed = reads.find((set) => !SUCCESS.has(set.outcome));
  return {
    dependency: relationshipDependency(parentType, family).key,
    observationId: `${snapshotId}:${parentType}/${family}`,
    snapshotId,
    outcome: failed ? failed.outcome : 'complete',
    success,
    startedAt: starts.length ? new Date(Math.min(...starts.map(Number))).toISOString() : null,
    completedAt: ends.length ? new Date(Math.max(...ends.map(Number))).toISOString() : null,
  };
}

function newest(observations) {
  return [...observations].sort((a, b) => String(b.completedAt ?? b.startedAt ?? '')
    .localeCompare(String(a.completedAt ?? a.startedAt ?? '')))[0] ?? null;
}

/**
 * Live freshness over the required dependencies. `observations` may hold any
 * mix of attempts; only successes count toward age.
 */
export function computeFreshness({ required, observations, now }) {
  const at = instant(now) ?? new Date();
  const byDependency = new Map(required.map((dependency) => [dependency.key, []]));
  for (const observation of observations) byDependency.get(observation.dependency)?.push(observation);
  const dependencies = required.map((dependency) => {
    const attempts = byDependency.get(dependency.key) ?? [];
    const lastSuccess = newest(attempts.filter((observation) => observation.success));
    const latest = newest(attempts);
    const point = lastSuccess ? instant(lastSuccess.startedAt) : null;
    return {
      ...dependency,
      lastSuccess,
      latestAttempt: latest,
      latestFailed: latest !== null && latest.success !== true,
      ageMs: point ? Math.max(0, at.getTime() - point.getTime()) : null,
    };
  });
  const gaps = dependencies.filter((dependency) => dependency.lastSuccess === null);
  const measured = dependencies.filter((dependency) => dependency.ageMs !== null);
  const oldest = measured.reduce((worst, dependency) => (worst === null || dependency.ageMs > worst.ageMs ? dependency : worst), null);
  let state = 'measured';
  if (required.length === 0 || measured.length === 0) state = 'unmeasured';
  else if (gaps.length > 0) state = 'gaps';
  return {
    state,
    // The achieved RPO exists only when every required dependency has a success.
    achievedRpoMs: state === 'measured' ? oldest.ageMs : null,
    oldestDependency: oldest ? { key: oldest.key, kind: oldest.kind, type: oldest.type ?? null, parentType: oldest.parentType ?? null, family: oldest.family ?? null, ageMs: oldest.ageMs, since: oldest.lastSuccess.startedAt } : null,
    gaps: gaps.map(({ key, kind, type, parentType, family, latestAttempt }) => ({
      key, kind, type: type ?? null, parentType: parentType ?? null, family: family ?? null,
      lastAttempt: latestAttempt ? { at: latestAttempt.completedAt ?? latestAttempt.startedAt, outcome: latestAttempt.outcome } : null,
    })),
    latestFailures: dependencies.filter((dependency) => dependency.latestFailed && dependency.lastSuccess !== null)
      .map(({ key, kind, type, parentType, family, latestAttempt, lastSuccess }) => ({
        key, kind, type: type ?? null, parentType: parentType ?? null, family: family ?? null,
        failedAt: latestAttempt.completedAt ?? latestAttempt.startedAt, outcome: latestAttempt.outcome,
        lastSuccessAt: lastSuccess.startedAt,
      })),
    required: required.length,
  };
}

/** Why an off-site copy record does or does not count as a verified copy. */
export function classifyOffsiteRecord(subject, { tenantRef }) {
  if (!subject || typeof subject !== 'object') return { counts: false, reason: 'malformed' };
  if (subject.tenantRef !== tenantRef) return { counts: false, reason: 'foreign-tenant' };
  if (subject.verification?.ok !== true) return { counts: false, reason: 'manifest-not-verified' };
  if (!HEX64.test(subject.dumpSha256 ?? '') || subject.remoteSha256 !== subject.dumpSha256) {
    return { counts: false, reason: 'remote-checksum-mismatch' };
  }
  if (!instant(subject.shippedAt)) return { counts: false, reason: 'shipped-at-missing' };
  if (!Array.isArray(subject.observationIds) || subject.observationIds.length === 0) {
    return { counts: false, reason: 'no-observations' };
  }
  return { counts: true, reason: 'verified-offsite-copy' };
}

/**
 * The newest recoverable point across verified off-site copies.
 * copies: [{ at, subject }] (evidence rows). observationsById: Map of type
 * observation id -> observation. relationshipsBySnapshot: Map of snapshot id ->
 * relationship observations read in that snapshot.
 */
export function computeRecoverablePoint({ required, copies, observationsById, relationshipsBySnapshot, tenantRef, now }) {
  const at = instant(now) ?? new Date();
  const evaluated = [];
  for (const copy of copies) {
    const verdict = classifyOffsiteRecord(copy.subject, { tenantRef });
    const base = {
      recordedAt: isoOf(copy.at),
      shippedAt: isoOf(copy.subject?.shippedAt),
      dumpSha256: copy.subject?.dumpSha256 ?? null,
      manifestGeneratedAt: copy.subject?.manifestGeneratedAt ?? null,
      seq: copy.seq ?? null,
    };
    if (!verdict.counts) {
      if (verdict.reason !== 'foreign-tenant') evaluated.push({ ...base, counts: false, reason: verdict.reason, point: null, missing: [] });
      continue;
    }
    const included = new Map();
    const snapshots = new Set();
    for (const id of copy.subject.observationIds) {
      const observation = observationsById.get(id);
      if (observation) snapshots.add(observation.snapshotId);
      if (observation?.success) {
        const previous = included.get(observation.dependency);
        if (!previous || observation.startedAt > previous.startedAt) included.set(observation.dependency, observation);
      }
    }
    for (const snapshotId of snapshots) {
      for (const observation of relationshipsBySnapshot.get(snapshotId) ?? []) {
        if (!observation.success) continue;
        const previous = included.get(observation.dependency);
        if (!previous || observation.startedAt > previous.startedAt) included.set(observation.dependency, observation);
      }
    }
    const missing = required.filter((dependency) => !included.has(dependency.key)).map((dependency) => dependency.key);
    if (required.length === 0 || missing.length > 0) {
      evaluated.push({ ...base, counts: false, reason: required.length === 0 ? 'nothing-required' : 'missing-required-observation', point: null, missing });
      continue;
    }
    const point = required.map((dependency) => included.get(dependency.key).startedAt).sort()[0];
    evaluated.push({ ...base, counts: true, reason: verdict.reason, point, missing: [] });
  }
  const counted = evaluated.filter((copy) => copy.counts);
  const best = counted.reduce((winner, copy) => (winner === null || copy.point > winner.point ? copy : winner), null);
  const latestCopy = newest(evaluated.map((copy) => ({ ...copy, completedAt: copy.shippedAt ?? copy.recordedAt })));
  return {
    state: best ? 'measured' : 'unmeasured',
    point: best?.point ?? null,
    ageMs: best ? Math.max(0, at.getTime() - new Date(best.point).getTime()) : null,
    fromCopy: best,
    latestCopy,
    copies: evaluated,
  };
}

function isEnforcedRestore(params) {
  if (!params || typeof params !== 'object' || typeof params.artifactId !== 'string') return false;
  const keys = Object.keys(params);
  return params.mode === 'enforce' || (keys.length === 1 && keys[0] === 'artifactId');
}

/**
 * Whether one enforced restore is a verified recovery sample. Only a succeeded
 * job counts, and only once every completion item of its plan is verified; its
 * duration runs from the job's start to the later of its finish and the last
 * item's verification.
 */
export function classifyRestoreJob(job, completionItems = []) {
  if (job.status !== 'succeeded') return { counts: false, reason: `restore-${job.status}` };
  const started = instant(job.started_at);
  const finished = instant(job.finished_at);
  if (!started || !finished || finished < started) return { counts: false, reason: 'timing-not-observed' };
  if (completionItems.some((item) => item.state !== 'verified')) return { counts: false, reason: 'awaiting-verification' };
  const closes = completionItems.map((item) => instant(item.closed_at)).filter(Boolean);
  if (closes.length !== completionItems.length) return { counts: false, reason: 'awaiting-verification' };
  const verifiedAt = new Date(Math.max(finished.getTime(), ...closes.map(Number)));
  return { counts: true, reason: 'verified-restore', elapsedMs: verifiedAt.getTime() - started.getTime(), verifiedAt: verifiedAt.toISOString() };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Observed recovery time from drill evidence rows and restore jobs (with their items). */
export function computeRecoveryTime({ drills = [], restores = [], tenantRef }) {
  const attempts = [];
  for (const record of drills) {
    if (record.tenant_ref !== tenantRef) continue;
    const verdict = classifyDrillRecord(record.subject, { tenantRef });
    attempts.push({
      source: 'drill',
      ref: record.seq !== undefined && record.seq !== null ? String(record.seq) : null,
      at: isoOf(record.subject?.finishedAt) ?? isoOf(record.occurred_at),
      counts: verdict.counts,
      reason: verdict.reason,
      elapsedMs: verdict.counts ? record.subject.elapsedMs : null,
      outcome: record.subject?.outcome ?? null,
    });
  }
  for (const { job, items } of restores) {
    const verdict = classifyRestoreJob(job, items);
    attempts.push({
      source: 'restore',
      ref: job.id,
      at: verdict.verifiedAt ?? isoOf(job.finished_at) ?? isoOf(job.created_at),
      counts: verdict.counts,
      reason: verdict.reason,
      elapsedMs: verdict.counts ? verdict.elapsedMs : null,
      outcome: job.status,
    });
  }
  attempts.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const samples = attempts.filter((attempt) => attempt.counts);
  const values = samples.map((sample) => sample.elapsedMs);
  return {
    state: samples.length ? 'measured' : 'unmeasured',
    samples: samples.length,
    latestMs: samples.at(-1)?.elapsedMs ?? null,
    latestAt: samples.at(-1)?.at ?? null,
    worstMs: values.length ? Math.max(...values) : null,
    medianMs: median(values),
    lastAttempt: attempts.at(-1) ?? null,
    attempts,
  };
}

/** Configured cadence, kept apart from every measured value. */
export function configuredCadence(schedules) {
  return schedules.map((row) => ({
    id: row.id,
    jobKind: row.job_kind,
    tier: row.tier ?? null,
    cadence: row.cadence ?? null,
    cron: row.cron_override ?? null,
    enabled: row.enabled === true,
  }));
}

// ------------------------------------------------------------------- loaders

const SUCCESS_ENTRY_SQL = `(
  ((entry.value ->> 'outcome' IN ('complete','complete-empty') OR entry.value ->> 'completeness' IN ('complete','complete-empty'))
    AND jsonb_typeof(entry.value -> 'itemCount') = 'number')
  OR (jsonb_typeof(entry.value) = 'number' AND (entry.value #>> '{}')::numeric > 0)
)`;

async function loadTypeObservations(client, { tenantRef }) {
  // Newest attempt per type (including failures) and newest success per type.
  const { rows } = await client.query(
    `WITH entries AS (
       SELECT entry.key AS resource_type, entry.value AS coverage_entry, s.id AS snapshot_id,
              s.started_at, s.completed_at, ${SUCCESS_ENTRY_SQL} AS success_shaped
         FROM snapshot s
         CROSS JOIN LATERAL jsonb_each(COALESCE(s.coverage_digest, '{}'::jsonb)) entry
        WHERE s.tenant_ref = $1 AND s.status = 'complete' AND s.completed_at IS NOT NULL
          AND entry.value ->> 'outcome' IS DISTINCT FROM 'not-requested'
     )
     (SELECT DISTINCT ON (resource_type) * FROM entries
       ORDER BY resource_type, completed_at DESC, started_at DESC, snapshot_id DESC)
     UNION ALL
     (SELECT DISTINCT ON (resource_type) * FROM entries WHERE success_shaped
       ORDER BY resource_type, completed_at DESC, started_at DESC, snapshot_id DESC)`,
    [tenantRef],
  );
  return rows.map((row) => typeObservation({
    type: row.resource_type,
    entry: row.coverage_entry,
    snapshotId: String(row.snapshot_id),
    snapshotStartedAt: row.started_at,
    snapshotCompletedAt: row.completed_at,
  }));
}

function groupRelationshipRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.snapshot_id}|${row.parent_type}|${row.family}`;
    if (!groups.has(key)) groups.set(key, { parentType: row.parent_type, family: row.family, snapshotId: String(row.snapshot_id), sets: [] });
    groups.get(key).sets.push(row);
  }
  return [...groups.values()].map(relationshipObservation).filter(Boolean);
}

async function loadRelationshipObservations(client, { tenantRef, snapshotIds = null }) {
  const { rows } = await client.query(
    `SELECT es.snapshot_id, es.parent_type, es.family, es.outcome, es.started_at, es.completed_at
       FROM relationship_edge_set es
       JOIN snapshot s ON s.id = es.snapshot_id AND s.tenant_ref = es.tenant_ref
      WHERE es.tenant_ref = $1 AND s.status = 'complete'
        AND ($2::uuid[] IS NULL OR es.snapshot_id = ANY($2::uuid[]))`,
    [tenantRef, snapshotIds],
  );
  return groupRelationshipRows(rows);
}

async function loadOffsiteCopies(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT seq, occurred_at, subject FROM evidence
      WHERE tenant_ref = $1 AND kind = $2 ORDER BY occurred_at, seq`,
    [tenantRef, OFFSITE_COPY_EVIDENCE_KIND],
  );
  return rows.map((row) => ({ seq: String(row.seq), at: row.occurred_at, subject: row.subject }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadListedObservations(client, { tenantRef, observationIds }) {
  const bySnapshot = new Map();
  for (const id of observationIds) {
    const split = typeof id === 'string' ? id.indexOf(':') : -1;
    if (split < 0) continue;
    const snapshotId = id.slice(0, split);
    if (!UUID.test(snapshotId)) continue;
    if (!bySnapshot.has(snapshotId)) bySnapshot.set(snapshotId, new Set());
    bySnapshot.get(snapshotId).add(id.slice(split + 1));
  }
  const snapshotIds = [...bySnapshot.keys()];
  if (snapshotIds.length === 0) return { observationsById: new Map(), relationshipsBySnapshot: new Map() };
  const { rows } = await client.query(
    `SELECT id, started_at, completed_at, coverage_digest FROM snapshot
      WHERE tenant_ref = $1 AND status = 'complete' AND id = ANY($2::uuid[])`,
    [tenantRef, snapshotIds],
  );
  const observationsById = new Map();
  for (const row of rows) {
    const digest = row.coverage_digest && typeof row.coverage_digest === 'object' ? row.coverage_digest : {};
    for (const type of bySnapshot.get(String(row.id)) ?? []) {
      if (!(type in digest)) continue;
      const observation = typeObservation({ type, entry: digest[type], snapshotId: String(row.id), snapshotStartedAt: row.started_at, snapshotCompletedAt: row.completed_at });
      observationsById.set(observation.observationId, observation);
    }
  }
  const relationshipsBySnapshot = new Map();
  for (const observation of await loadRelationshipObservations(client, { tenantRef, snapshotIds: rows.map((row) => String(row.id)) })) {
    if (!relationshipsBySnapshot.has(observation.snapshotId)) relationshipsBySnapshot.set(observation.snapshotId, []);
    relationshipsBySnapshot.get(observation.snapshotId).push(observation);
  }
  return { observationsById, relationshipsBySnapshot };
}

async function loadRestoreHistory(client, { tenantRef }) {
  // Jobs carry no tenant_ref: a restore belongs to the tenant of the dry-run plan it ran.
  const { rows: jobs } = await client.query(
    `SELECT j.id, j.status, j.params, j.created_at, j.started_at, j.finished_at
       FROM job j
       JOIN restore_dry_run rd ON rd.id::text = j.params ->> 'artifactId'
      WHERE j.kind = 'restore' AND rd.tenant_ref = $1 AND rd.compensation IS NULL
        AND j.status IN ('succeeded','failed','cancelled')
      ORDER BY j.created_at`,
    [tenantRef],
  );
  const enforced = jobs.filter((job) => isEnforcedRestore(job.params));
  if (enforced.length === 0) return [];
  const { rows: items } = await client.query(
    `SELECT restore_ref, state, closed_at FROM recovery_completion_item
      WHERE tenant_ref = $1 AND restore_ref = ANY($2::text[])`,
    [tenantRef, enforced.map((job) => job.params.artifactId)],
  );
  return enforced.map((job) => ({ job, items: items.filter((item) => item.restore_ref === job.params.artifactId) }));
}

async function loadRequiredRelationships(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT DISTINCT parent_type, family FROM relationship_edge_set
      WHERE tenant_ref = $1 AND outcome <> 'unsupported' ORDER BY parent_type, family`,
    [tenantRef],
  );
  return rows.map((row) => relationshipDependency(row.parent_type, row.family));
}

/**
 * The tenant's recovery metrics. requiredTypes are the configuration types KEEL
 * collects (the collector descriptors); required relationship families are every
 * family KEEL has read for this tenant (an unsupported-only family is not one).
 */
export async function loadRecoveryMetrics(client, { tenantRef, requiredTypes, now = new Date() }) {
  assertTenantRef(tenantRef);
  if (!Array.isArray(requiredTypes)) throw new TypeError('requiredTypes must be an array of type names');
  const generatedAt = instant(now) ?? new Date();
  const required = [
    ...[...new Set(requiredTypes)].sort().map(typeDependency),
    ...await loadRequiredRelationships(client, { tenantRef }),
  ];
  const observations = [
    ...await loadTypeObservations(client, { tenantRef }),
    ...await loadRelationshipObservations(client, { tenantRef }),
  ];
  const copies = await loadOffsiteCopies(client, { tenantRef });
  const listed = copies.flatMap((copy) => (Array.isArray(copy.subject?.observationIds) ? copy.subject.observationIds : []));
  const { observationsById, relationshipsBySnapshot } = await loadListedObservations(client, { tenantRef, observationIds: listed });
  const { rows: drills } = await client.query(
    `SELECT seq, tenant_ref, occurred_at, subject FROM evidence
      WHERE tenant_ref = $1 AND kind = $2 ORDER BY occurred_at, seq`,
    [tenantRef, RECOVERY_DRILL_EVIDENCE_KIND],
  );
  const restores = await loadRestoreHistory(client, { tenantRef });
  const { rows: schedules } = await client.query(
    `SELECT id, job_kind, tier, cadence, cron_override, enabled FROM schedule
      WHERE tenant_ref = $1 AND job_kind IN ('collect','backup','offsite') ORDER BY job_kind, tier NULLS LAST`,
    [tenantRef],
  );
  return {
    version: RECOVERY_METRICS_VERSION,
    tenantRef,
    generatedAt: generatedAt.toISOString(),
    freshness: computeFreshness({ required, observations, now: generatedAt }),
    recoverablePoint: computeRecoverablePoint({ required, copies, observationsById, relationshipsBySnapshot, tenantRef, now: generatedAt }),
    recoveryTime: computeRecoveryTime({ drills, restores, tenantRef }),
    readiness: await loadRecoveryReadiness(client, { tenantRef }),
    configured: {
      cadence: configuredCadence(schedules),
      // KEEL stores no recovery objective; configuration never stands in for a measurement.
      objectives: null,
    },
  };
}

// -------------------------------------------------------------------- writer

/**
 * Records one off-site copy. The recovery manifest is verified HERE against the
 * actual artifact bytes (task-67 verifyRecoveryManifest), never taken from the
 * caller. A copy that fails verification is recorded too, as not verified, so a
 * failed shipment is visible rather than silently missing.
 */
export async function recordOffsiteCopy(client, {
  tenantRef, manifest, remoteSha256, shippedAt, actor, verifyOptions = {}, verify = verifyRecoveryManifest, eventSink,
}) {
  assertTenantRef(tenantRef);
  const shipped = instant(shippedAt);
  if (!shipped) throw new TypeError('shippedAt must be the instant the off-site copy was confirmed');
  if (typeof actor !== 'string' || actor.length === 0) throw new TypeError('actor is required');
  const verification = await verify(manifest, { ...verifyOptions, expectedTenantRef: tenantRef });
  const subject = {
    version: RECOVERY_METRICS_VERSION,
    tenantRef,
    manifestTenantRef: manifest?.tenantRef ?? null,
    manifestGeneratedAt: manifest?.generatedAt ?? null,
    dumpSha256: manifest?.dump?.sha256 ?? null,
    remoteSha256: typeof remoteSha256 === 'string' ? remoteSha256.toLowerCase() : null,
    shippedAt: shipped.toISOString(),
    observationIds: Array.isArray(manifest?.observationIds) ? [...manifest.observationIds] : [],
    verification: {
      ok: verification.ok === true,
      recoveryComplete: verification.recoveryComplete === true,
      failures: verification.failures ?? [],
      incomplete: verification.incomplete ?? [],
    },
  };
  const record = await appendEvidence(client, { tenantRef, kind: OFFSITE_COPY_EVIDENCE_KIND, subject, actor, ...(eventSink ? { eventSink } : {}) });
  return { record, subject, verdict: classifyOffsiteRecord(subject, { tenantRef }) };
}
