/**
 * Roadmap task-87: baseline age, compliance views and linked findings.
 *
 * Everything here is a server-side reader. Ages are measured from when the evidence
 * was captured (the baseline's source collection finished), never from when a page
 * was loaded or the baseline row was written. A control finding is linked to a change,
 * a backup or a pending restore plan only when both rest on the same collection; any
 * other pairing is reported as a mismatch rather than joined. Exceptions are honoured
 * only with an owner, a reason and an expiry that has not passed. Storage residency is
 * reported as configured, with its proven-or-not state, and never as a certification
 * of regulatory compliance.
 */
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { recordException } from '../benchmarks/evaluate.mjs';
import { controlFor } from '../benchmarks/registry.mjs';
import { readObservation } from '../contracts/observation.mjs';
import { retentionClaimFor } from '../storage/qualification.mjs';
import { OPEN_DRIFT_PREDICATE } from '../store/openDrift.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { diffSnapshots } from './diffSnapshots.mjs';
import { isEligibleBaselineSource } from './baseline.mjs';

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ms(value) {
  const text = iso(value);
  return text === null ? null : Date.parse(text);
}

/**
 * How old a baseline's evidence is and what it covered. A baseline set with task-87
 * carries its source collection; an older one is read from the snapshots its resource
 * versions came from (the window between the first and last of them). With neither,
 * the age is unknown — it is never filled in from the time of reading.
 */
function captureOf(baseline, legacyWindow, now) {
  if (baseline.captured_at) {
    const scope = baseline.observation_scope ?? null;
    return {
      basis: 'source-snapshot',
      capturedAt: iso(baseline.captured_at),
      ageMs: now.getTime() - ms(baseline.captured_at),
      sourceSnapshotId: baseline.source_snapshot_id ? String(baseline.source_snapshot_id) : null,
      window: scope ? { startedAt: scope.startedAt ?? null, completedAt: scope.completedAt ?? null } : null,
      types: Array.isArray(scope?.types) ? [...scope.types] : [],
    };
  }
  if (legacyWindow?.completed_at) {
    return {
      basis: 'legacy-resource-versions',
      capturedAt: iso(legacyWindow.completed_at),
      ageMs: now.getTime() - ms(legacyWindow.completed_at),
      sourceSnapshotId: null,
      window: { startedAt: iso(legacyWindow.started_at), completedAt: iso(legacyWindow.completed_at) },
      types: [...(legacyWindow.types ?? [])].sort(),
    };
  }
  return { basis: 'unknown', capturedAt: null, ageMs: null, sourceSnapshotId: null, window: null, types: [] };
}

/**
 * Changes since capture: the baseline's resources against the newest whole-estate
 * collection, through the same canonical-hash diff drift detection uses. A change in
 * fields Microsoft sets itself (or key order) hashes identically, so it is zero drift.
 * Two hash versions are never compared directly: the result is "not comparable".
 */
function changesSince(baselineRows, latest) {
  if (!latest) return { state: 'no-collection', comparedSnapshotId: null, comparedAt: null, added: 0, modified: 0, removed: 0, total: 0 };
  try {
    const drift = diffSnapshots(baselineRows, latest.rows);
    const count = (type) => drift.filter((entry) => entry.changeType === type).length;
    return {
      state: 'compared',
      comparedSnapshotId: latest.id,
      comparedAt: latest.completedAt,
      added: count('added'),
      modified: count('modified'),
      removed: count('removed'),
      total: drift.length,
    };
  } catch (error) {
    return {
      state: 'not-comparable',
      comparedSnapshotId: latest.id,
      comparedAt: latest.completedAt,
      reason: error.message,
      added: 0, modified: 0, removed: 0, total: 0,
    };
  }
}

async function latestEligibleSnapshot(client, tenantRef) {
  const { rows } = await client.query(
    `SELECT id, tenant_ref, status, started_at, completed_at, coverage_digest
     FROM snapshot
     WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 50`,
    [tenantRef],
  );
  const snapshot = rows.find((candidate) => isEligibleBaselineSource(candidate, { tenantRef }));
  if (!snapshot) return null;
  const { rows: versions } = await client.query(
    `SELECT natural_key, resource_type, payload_hash, hash_version, blast_radius
     FROM resource_version WHERE snapshot_id = $1`,
    [snapshot.id],
  );
  return { id: String(snapshot.id), completedAt: iso(snapshot.completed_at), rows: versions };
}

/** Every baseline of the tenant, newest first, with capture, scope, version chain and changes since capture. */
export async function baselineCompliance(client, { tenantRef, now = new Date() }) {
  assertTenantRef(tenantRef);
  const { rows: baselines } = await client.query(
    `SELECT b.*, count(br.natural_key)::int AS resource_count
     FROM baseline b
     LEFT JOIN baseline_resource br ON br.baseline_id = b.id
     WHERE b.tenant_ref = $1
     GROUP BY b.id
     ORDER BY b.set_at DESC, b.id DESC`,
    [tenantRef],
  );
  if (baselines.length === 0) return [];
  const ids = baselines.map((baseline) => baseline.id);

  const { rows: resources } = await client.query(
    `SELECT br.baseline_id, rv.natural_key, rv.resource_type, rv.payload_hash, rv.hash_version,
            rv.blast_radius, s.started_at, s.completed_at
     FROM baseline_resource br
     JOIN resource_version rv ON rv.id = br.resource_version_id
     JOIN snapshot s ON s.id = rv.snapshot_id AND s.tenant_ref = $2
     WHERE br.baseline_id = ANY($1::uuid[])`,
    [ids, tenantRef],
  );
  const byBaseline = new Map(ids.map((id) => [String(id), []]));
  for (const row of resources) byBaseline.get(String(row.baseline_id))?.push(row);

  const latest = await latestEligibleSnapshot(client, tenantRef);
  const successor = new Map(baselines
    .filter((baseline) => baseline.supersedes_id)
    .map((baseline) => [String(baseline.supersedes_id), String(baseline.id)]));

  return baselines.map((baseline) => {
    const rows = byBaseline.get(String(baseline.id)) ?? [];
    const legacyWindow = rows.length ? {
      started_at: new Date(Math.min(...rows.map((row) => ms(row.started_at)))),
      completed_at: rows.some((row) => !row.completed_at) ? null : new Date(Math.max(...rows.map((row) => ms(row.completed_at)))),
      types: [...new Set(rows.map((row) => row.resource_type))],
    } : null;
    return {
      id: String(baseline.id),
      label: baseline.label ?? null,
      active: Boolean(baseline.active),
      setAt: iso(baseline.set_at),
      setBy: String(baseline.set_by),
      resourceCount: Number(baseline.resource_count ?? 0),
      version: Number(baseline.version ?? 1),
      supersedesId: baseline.supersedes_id ? String(baseline.supersedes_id) : null,
      supersededById: successor.get(String(baseline.id)) ?? null,
      supersededAt: iso(baseline.superseded_at),
      capture: captureOf(baseline, legacyWindow, now),
      changesSinceCapture: changesSince(rows, latest),
    };
  });
}

/* ---------------------------------------------------------------- findings -- */

function snapshotObservations(snapshot) {
  const digest = snapshot.coverage_digest && typeof snapshot.coverage_digest === 'object' ? snapshot.coverage_digest : {};
  const observations = new Map();
  for (const [resourceType, entry] of Object.entries(digest)) {
    let observation;
    try {
      observation = readObservation(entry, {
        tenantRef: snapshot.tenant_ref,
        observationId: `${snapshot.id}:${resourceType}`,
        resourceType,
        snapshotWindow: { startedAt: snapshot.started_at, endedAt: snapshot.completed_at },
      });
    } catch {
      continue;
    }
    if (observation.completeness === 'complete' && observation.window) observations.set(resourceType, observation.window);
  }
  return observations;
}

/**
 * The collections an evaluation's evidence came from: for each observation window the
 * evaluation recorded, the snapshot whose read of that type covered exactly that window.
 * A window no stored collection reproduces is unmatched; it is never approximated.
 */
function matchEvidence(evaluation, snapshots) {
  const windows = Array.isArray(evaluation.observation_windows) ? evaluation.observation_windows : [];
  return windows.map((window) => {
    const match = snapshots.find((snapshot) => {
      const observed = snapshot.observations.get(window.resourceType);
      return observed
        && ms(observed.startedAt) === ms(window.startedAt)
        && ms(observed.endedAt) === ms(window.endedAt);
    });
    return {
      resourceType: window.resourceType,
      window: { startedAt: iso(window.startedAt), endedAt: iso(window.endedAt) },
      snapshotId: match ? match.id : null,
      completedAt: match ? match.completedAt : null,
    };
  });
}

function exceptionState(exception, now) {
  if (!exception) return { state: 'none', exception: null };
  const shaped = {
    id: String(exception.id),
    owner: exception.owner ?? null,
    reason: exception.reason ?? null,
    grantedBy: exception.actor ?? null,
    grantedAt: iso(exception.granted_at),
    expiresAt: iso(exception.expires_at),
  };
  if (shaped.expiresAt && ms(shaped.expiresAt) <= now.getTime()) return { state: 'expired', exception: shaped };
  if (!shaped.owner || !shaped.reason || !shaped.expiresAt) return { state: 'incomplete', exception: shaped };
  return { state: 'authorized', exception: shaped };
}

/**
 * Linked state for one kind of related record. `linked` holds records resting on a
 * collection the finding's evidence came from; `mismatched` holds records of the same
 * configuration types resting on a different collection, which are shown as such.
 */
function partition(records, evidenceSnapshotIds) {
  const linked = records.filter((record) => evidenceSnapshotIds.has(record.snapshotId));
  const mismatched = records.filter((record) => !evidenceSnapshotIds.has(record.snapshotId));
  return {
    state: linked.length ? 'linked' : mismatched.length ? 'mismatch' : 'none',
    linked,
    mismatched,
  };
}

function keyType(key) {
  return typeof key === 'string' && key.includes(':') ? key.slice(0, key.indexOf(':')) : null;
}

/**
 * The newest evaluation of every control, each with its exception state and its links
 * to open changes, the backups its evidence came from, and pending restore plans.
 */
export async function complianceFindings(client, { tenantRef, now = new Date() }) {
  assertTenantRef(tenantRef);
  const { rows: evaluations } = await client.query(
    `SELECT DISTINCT ON (control_id) *
     FROM benchmark_evaluation
     WHERE tenant_ref = $1
     ORDER BY control_id, evaluated_at DESC, created_at DESC`,
    [tenantRef],
  );
  if (evaluations.length === 0) return { findings: [], summary: summarize([]) };

  const [{ rows: exceptions }, { rows: snapshotRows }, { rows: driftRows }, { rows: planRows }] = await Promise.all([
    client.query(
      `SELECT * FROM benchmark_exception
       WHERE tenant_ref = $1 AND evaluation_id = ANY($2::uuid[])
       ORDER BY granted_at DESC, id DESC`,
      [tenantRef, evaluations.map((evaluation) => evaluation.id)],
    ),
    client.query(
      `SELECT id, tenant_ref, started_at, completed_at, coverage_digest
       FROM snapshot WHERE tenant_ref = $1 AND completed_at IS NOT NULL`,
      [tenantRef],
    ),
    client.query(
      `SELECT d.id, d.natural_key, d.resource_type, d.change_type, d.blast_radius,
              d.observed_snapshot, d.detected_at
       FROM drift d
       WHERE d.tenant_ref = $1 AND ${OPEN_DRIFT_PREDICATE}`,
      [tenantRef],
    ),
    client.query(
      `SELECT a.id AS request_id, a.expires_at, r.id AS dry_run_id, r.snapshot_id, r.closure_keys, r.created_at
       FROM approval_request a
       JOIN restore_dry_run r ON r.id::text = a.params->>'artifactId' AND r.tenant_ref = $1
       WHERE a.action = 'restore' AND a.status = 'pending' AND a.expires_at > $2`,
      [tenantRef, now],
    ),
  ]);

  const snapshots = snapshotRows.map((snapshot) => ({
    id: String(snapshot.id),
    completedAt: iso(snapshot.completed_at),
    observations: snapshotObservations(snapshot),
  }));
  const latestException = new Map();
  for (const exception of exceptions) {
    if (!latestException.has(String(exception.evaluation_id))) latestException.set(String(exception.evaluation_id), exception);
  }

  const findings = evaluations.map((evaluation) => {
    const evidence = matchEvidence(evaluation, snapshots);
    const types = new Set(evidence.map((entry) => entry.resourceType));
    const evidenceSnapshotIds = new Set(evidence.map((entry) => entry.snapshotId).filter(Boolean));

    const changes = driftRows
      .filter((drift) => types.has(drift.resource_type))
      .map((drift) => ({
        id: String(drift.id),
        naturalKey: drift.natural_key,
        resourceType: drift.resource_type,
        changeType: drift.change_type,
        snapshotId: String(drift.observed_snapshot),
        detectedAt: iso(drift.detected_at),
      }));
    const plans = planRows
      .filter((plan) => (Array.isArray(plan.closure_keys) ? plan.closure_keys : []).some((key) => types.has(keyType(key))))
      .map((plan) => ({
        requestId: String(plan.request_id),
        dryRunId: String(plan.dry_run_id),
        snapshotId: String(plan.snapshot_id),
        createdAt: iso(plan.created_at),
        expiresAt: iso(plan.expires_at),
      }));
    const { state, exception } = exceptionState(latestException.get(String(evaluation.id)), now);
    const verdict = evaluation.verdict;

    return {
      id: String(evaluation.id),
      controlId: evaluation.control_id,
      // The control's own wording from the registry; null for a control it no longer holds.
      title: controlFor(evaluation.control_id)?.title ?? null,
      framework: evaluation.framework,
      edition: evaluation.edition,
      profile: evaluation.profile,
      evaluatorVersion: Number(evaluation.evaluator_version),
      verdict,
      reason: evaluation.reason ?? null,
      evaluatedAt: iso(evaluation.evaluated_at),
      evidenceSeq: evaluation.evidence_seq === null || evaluation.evidence_seq === undefined ? null : String(evaluation.evidence_seq),
      exceptionState: state,
      exception,
      // A failing control is hidden only by an authorized exception. An expired or
      // incomplete one leaves the finding exposed.
      exposed: verdict === 'fail' && state !== 'authorized',
      evidence,
      links: {
        backup: {
          state: evidence.length === 0 ? 'none' : evidence.every((entry) => entry.snapshotId) ? 'linked' : 'mismatch',
          linked: evidence.filter((entry) => entry.snapshotId),
          mismatched: evidence.filter((entry) => !entry.snapshotId),
        },
        change: partition(changes, evidenceSnapshotIds),
        restorePlan: partition(plans, evidenceSnapshotIds),
      },
    };
  });
  return { findings, summary: summarize(findings) };
}

function summarize(findings) {
  return {
    controls: findings.length,
    exposed: findings.filter((finding) => finding.exposed).length,
    excepted: findings.filter((finding) => finding.verdict === 'fail' && finding.exceptionState === 'authorized').length,
    expiredExceptions: findings.filter((finding) => finding.verdict === 'fail' && finding.exceptionState === 'expired').length,
    incompleteExceptions: findings.filter((finding) => finding.verdict === 'fail' && finding.exceptionState === 'incomplete').length,
    passing: findings.filter((finding) => finding.verdict === 'pass').length,
    unknown: findings.filter((finding) => finding.verdict === 'unknown').length,
    notApplicable: findings.filter((finding) => finding.verdict === 'not-applicable').length,
  };
}

/**
 * Grants an authorized exception: the grantor must hold `configuration`, and the
 * exception must name an owner, a reason and an expiry in the future. The evaluation
 * row is never changed (engine/benchmarks/evaluate.mjs recordException).
 */
export async function grantComplianceException(client, {
  principalId, tenantRef, evaluationId, owner, reason, expiresAt, now = new Date(),
}) {
  assertTenantRef(tenantRef);
  const principal = await findPrincipalById(client, principalId);
  if (!principal || !(await can(client, principal, 'configuration', now))) {
    throw new Error('forbidden: granting a compliance exception requires configuration');
  }
  for (const [name, value] of [['owner', owner], ['reason', reason]]) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`an exception requires a ${name}`);
  }
  const expiry = ms(expiresAt);
  if (expiry === null || expiry <= now.getTime()) throw new TypeError('an exception requires an expiry in the future');
  return recordException(client, {
    tenantRef, evaluationId, actor: principalId, reason, owner, expiresAt: new Date(expiry),
  });
}

/* ----------------------------------------------------------------- storage -- */

/**
 * Where backups are configured to be stored, read from the recovery manifest's
 * residency (engine/storage/recoveryManifest.mjs), and whether their immutability is
 * proven. This is a statement of configuration, never a certification of regulatory
 * compliance: `certifies` is always null.
 *
 * @param {{ manifest?: Record<string, any> | null, qualification?: Record<string, any> | null }} [input]
 */
export function storageResidency({ manifest = null, qualification = null } = {}) {
  const residency = manifest?.residency;
  if (!residency || typeof residency.provider !== 'string' || residency.provider.length === 0) {
    return { configured: false, provider: null, region: null, boundary: null, immutability: 'unknown', generatedAt: null, certifies: null };
  }
  const claim = retentionClaimFor({ evaluation: qualification });
  // A provider whose ceiling excludes a retention lock (local disk) is unsupported,
  // never "unknown pending proof" (engine/storage/adapter.mjs ceilings).
  const immutability = claim === 'unknown' && residency.provider === 'local-disk' ? 'unsupported' : claim;
  return {
    configured: true,
    provider: residency.provider,
    region: residency.region ?? null,
    boundary: residency.boundary ?? null,
    immutability,
    generatedAt: manifest.generatedAt ?? null,
    certifies: null,
  };
}
