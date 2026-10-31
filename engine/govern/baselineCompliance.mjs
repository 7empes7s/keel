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
import { fixFor, listFixCandidates } from '../benchmarks/fix.mjs';
import { OWN_PREFIX, controlFromRow, ownCheckRows, shapeOwnCheck } from '../benchmarks/ownChecks.mjs';
import { WORKLOAD_FACT_TYPES, controlFor } from '../benchmarks/registry.mjs';
import { readObservation } from '../contracts/observation.mjs';
import { retentionClaimFor } from '../storage/qualification.mjs';
import { OPEN_DRIFT_PREDICATE } from '../store/openDrift.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { diffSnapshots } from './diffSnapshots.mjs';
import { isEligibleBaselineSource, serviceErrorLeftOut } from './baseline.mjs';

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
/**
 * The service settings a baseline holds (baselineWorkloads.mjs): each service read it
 * captured, with how many settings it holds now (Accept adds and removes them), and the
 * services no read was found for when it was captured. A baseline captured before
 * service settings were held lists neither.
 */
function servicesOf(scope, counts) {
  const entries = Array.isArray(scope?.workloads) ? scope.workloads.filter((entry) => typeof entry?.workload === 'string') : [];
  return {
    services: entries.map((entry) => ({
      workload: entry.workload,
      settings: counts?.get(entry.workload) ?? 0,
      collectedAt: iso(entry.collectedAt),
      outcome: typeof entry.outcome === 'string' ? entry.outcome : null,
    })).sort((a, b) => a.workload.localeCompare(b.workload)),
    servicesNotRead: Array.isArray(scope?.workloadsNotRead) ? scope.workloadsNotRead.filter((item) => typeof item === 'string').sort() : [],
  };
}

function captureOf(baseline, legacyWindow, now, serviceCounts = null) {
  if (baseline.captured_at) {
    const scope = baseline.observation_scope ?? null;
    return {
      ...servicesOf(scope, serviceCounts),
      basis: 'source-snapshot',
      capturedAt: iso(baseline.captured_at),
      ageMs: now.getTime() - ms(baseline.captured_at),
      sourceSnapshotId: baseline.source_snapshot_id ? String(baseline.source_snapshot_id) : null,
      window: scope ? { startedAt: scope.startedAt ?? null, completedAt: scope.completedAt ?? null } : null,
      types: Array.isArray(scope?.types) ? [...scope.types] : [],
      leftOut: Array.isArray(scope?.leftOut) ? scope.leftOut.filter((item) => typeof item?.type === 'string').map((item) => ({ type: item.type, reason: String(item.reason ?? 'unknown') })) : [],
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
      leftOut: [],
    };
  }
  return { basis: 'unknown', capturedAt: null, ageMs: null, sourceSnapshotId: null, window: null, types: [], leftOut: [] };
}

/**
 * Changes since capture: the baseline's resources against the newest whole-estate
 * collection, through the same canonical-hash diff drift detection uses. A change in
 * fields Microsoft sets itself (or key order) hashes identically, so it is zero drift.
 * Two hash versions are never compared directly: the result is "not comparable".
 */
function changesSince(baselineRows, latest, leftOut = new Set()) {
  if (!latest) return { state: 'no-collection', comparedSnapshotId: null, comparedAt: null, added: 0, modified: 0, removed: 0, total: 0 };
  try {
    // A type the newest collection could not read because the tenant has no
    // licence for it (issue #646), or a minor kind Microsoft kept failing on
    // (#666), was not observed: it is neither removed nor kept.
    const unavailable = latest.unavailableTypes ?? new Set();
    const compared = unavailable.size
      ? baselineRows.filter((row) => !unavailable.has(row.resource_type))
      : baselineRows;
    // A kind the baseline left out (#666) holds nothing in it, so a later read of
    // it is not "added".
    const latestRows = leftOut.size ? latest.rows.filter((row) => !leftOut.has(row.resource_type)) : latest.rows;
    const drift = diffSnapshots(compared, latestRows);
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

/**
 * Attaches the stored payload to each baseline row and newest-collection row whose
 * hashes differ for the same resource, so diffSnapshots can tell a change in content
 * from a hash stored under older rules (cir/canonicalHash.mjs sameContent). Only
 * those rows are read: the whole estate's payloads are not.
 */
async function withPayloadsWhereHashesDiffer(client, baselineRows, latest) {
  if (!latest) return;
  const latestByKey = new Map(latest.rows.map((row) => [row.natural_key, row]));
  const differing = [];
  for (const row of baselineRows) {
    const other = latestByKey.get(row.natural_key);
    if (other && other.payload_hash !== row.payload_hash && other.hash_version === row.hash_version) {
      differing.push(row, other);
    }
  }
  if (differing.length === 0) return;
  const { rows } = await client.query(
    'SELECT id::text AS id, payload FROM resource_version WHERE id = ANY($1::uuid[])',
    [[...new Set(differing.map((row) => String(row.id)))]],
  );
  const payloads = new Map(rows.map((row) => [row.id, row.payload]));
  for (const row of differing) row.payload = payloads.get(String(row.id)) ?? null;
}

// Read 50 backups at a time: tier backups can bury the newest complete one deeper than
// one page, and the "Capture new version" list (listEligibleBaselineSnapshots) looks
// through them all, so this must too.
const SNAPSHOT_PAGE = 50;

async function latestEligibleSnapshot(client, tenantRef) {
  let snapshot = null;
  for (let offset = 0; !snapshot; offset += SNAPSHOT_PAGE) {
    const { rows } = await client.query(
      `SELECT id, tenant_ref, status, started_at, completed_at, coverage_digest
       FROM snapshot
       WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, id DESC
       LIMIT ${SNAPSHOT_PAGE} OFFSET $2`,
      [tenantRef, offset],
    );
    snapshot = rows.find((candidate) => isEligibleBaselineSource(candidate, { tenantRef })) ?? null;
    if (rows.length < SNAPSHOT_PAGE) break;
  }
  if (!snapshot) return null;
  const { rows: versions } = await client.query(
    `SELECT id, natural_key, resource_type, payload_hash, hash_version, blast_radius
     FROM resource_version WHERE snapshot_id = $1`,
    [snapshot.id],
  );
  const unavailableTypes = new Set([
    ...Object.entries(snapshot.coverage_digest ?? {})
      .filter(([, coverage]) => coverage?.outcome === 'unavailable')
      .map(([type]) => type),
    ...serviceErrorLeftOut(snapshot.coverage_digest),
  ]);
  return { id: String(snapshot.id), completedAt: iso(snapshot.completed_at), rows: versions, unavailableTypes };
}

/**
 * The versions that were put back (reinstateBaseline), each with the earlier version it
 * copies. A put-back version keeps that version's capture, so it can read older than the
 * version it replaced. reinstateBaseline copies the source snapshot and capture time
 * exactly, and a re-snapshot always takes a newer one, so the earliest earlier version
 * of the same chain with the same capture is the one it copies. A version whose capture
 * is not recorded cannot be matched, and is not named.
 */
function reinstatedFrom(baselines) {
  const byId = new Map(baselines.map((baseline) => [String(baseline.id), baseline]));
  const root = (baseline) => {
    let current = baseline;
    const seen = new Set();
    while (current.supersedes_id && byId.has(String(current.supersedes_id)) && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      current = byId.get(String(current.supersedes_id));
    }
    return String(current.id);
  };
  const sameCapture = (a, b) => iso(a.captured_at) === iso(b.captured_at)
    && String(a.source_snapshot_id ?? '') === String(b.source_snapshot_id ?? '');
  const result = new Map();
  const roots = new Map(baselines.map((baseline) => [String(baseline.id), root(baseline)]));
  for (const baseline of baselines) {
    if (!baseline.supersedes_id || !baseline.captured_at) continue;
    const version = Number(baseline.version ?? 1);
    const source = baselines
      .filter((other) => other !== baseline && roots.get(String(other.id)) === roots.get(String(baseline.id))
        && Number(other.version ?? 1) < version && sameCapture(other, baseline))
      .sort((a, b) => Number(a.version ?? 1) - Number(b.version ?? 1))[0];
    if (source) result.set(String(baseline.id), { id: String(source.id), version: Number(source.version ?? 1) });
  }
  return result;
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

  const { rows: serviceRows } = await client.query(
    `SELECT baseline_id, workload, count(*)::int AS settings FROM baseline_workload
      WHERE baseline_id = ANY($1::uuid[]) GROUP BY baseline_id, workload`,
    [ids],
  );
  const serviceCounts = new Map(ids.map((id) => [String(id), new Map()]));
  for (const row of serviceRows) serviceCounts.get(String(row.baseline_id))?.set(row.workload, row.settings);

  const { rows: resources } = await client.query(
    `SELECT br.baseline_id, rv.id, rv.natural_key, rv.resource_type, rv.payload_hash, rv.hash_version,
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
  await withPayloadsWhereHashesDiffer(client, resources, latest);
  const successor = new Map(baselines
    .filter((baseline) => baseline.supersedes_id)
    .map((baseline) => [String(baseline.supersedes_id), String(baseline.id)]));
  const reinstated = reinstatedFrom(baselines);

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
      reinstatedFrom: reinstated.get(String(baseline.id)) ?? null,
      serviceSettingCount: [...(serviceCounts.get(String(baseline.id))?.values() ?? [])].reduce((sum, count) => sum + count, 0),
      capture: captureOf(baseline, legacyWindow, now, serviceCounts.get(String(baseline.id))),
      changesSinceCapture: changesSince(rows, latest, new Set((baseline.observation_scope?.leftOut ?? []).map((item) => item?.type))),
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
function matchEvidence(evaluation, snapshots, collections = []) {
  const windows = Array.isArray(evaluation.observation_windows) ? evaluation.observation_windows : [];
  return windows.map((window) => {
    // A service read (the Exchange mail protection policies...) is matched to the run
    // of that read covering exactly that window.
    if (WORKLOAD_FACT_TYPES.has(window.resourceType)) {
      const run = collections.find((candidate) => candidate.workload === window.resourceType
        && ms(candidate.observed_from) === ms(window.startedAt)
        && ms(candidate.observed_to) === ms(window.endedAt));
      return {
        resourceType: window.resourceType,
        window: { startedAt: iso(window.startedAt), endedAt: iso(window.endedAt) },
        snapshotId: null,
        collectionId: run ? String(run.id) : null,
        completedAt: run ? iso(run.observed_to) : null,
      };
    }
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
      collectionId: null,
      completedAt: match ? match.completedAt : null,
    };
  });
}

const matched = (entry) => Boolean(entry.snapshotId || entry.collectionId);

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
// A stored { checked, failing } pair, or null when it is missing or malformed.
function detailCounts(value) {
  const checked = Number(value?.checked);
  const failing = Number(value?.failing);
  if (!Number.isInteger(checked) || !Number.isInteger(failing) || checked < 0 || failing < 0 || failing > checked) return null;
  return { checked, failing };
}

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
  let { rows: evaluations } = await client.query(
    `SELECT DISTINCT ON (control_id) *
     FROM benchmark_evaluation
     WHERE tenant_ref = $1
     ORDER BY control_id, evaluated_at DESC, created_at DESC`,
    [tenantRef],
  );
  // A tenant's own check is shown while it is in force; a removed one's results stay
  // stored (and in the evidence chain) but no longer show as findings.
  const ownRows = new Map((await ownCheckRows(client, { tenantRef })).map((row) => [`${OWN_PREFIX}${row.id}`, row]));
  evaluations = evaluations.filter((evaluation) => !evaluation.control_id.startsWith(OWN_PREFIX)
    || (ownRows.has(evaluation.control_id) && !ownRows.get(evaluation.control_id).removed_at));
  if (evaluations.length === 0) return { findings: [], summary: summarize([]) };

  const workloads = [...new Set(evaluations.flatMap((evaluation) => (Array.isArray(evaluation.observation_windows) ? evaluation.observation_windows : [])
    .map((window) => window.resourceType)
    .filter((type) => WORKLOAD_FACT_TYPES.has(type))))];
  const [{ rows: exceptions }, { rows: snapshotRows }, { rows: driftRows }, { rows: planRows }, { rows: collections }] = await Promise.all([
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
      // One row per change: each detect run re-records what it still sees (store/governance.mjs listLatestOpenDrift).
      `WITH latest AS (
         SELECT DISTINCT ON (baseline_id, natural_key) id FROM drift
          WHERE tenant_ref = $1
          ORDER BY baseline_id, natural_key, detected_at DESC, id DESC
       )
       SELECT d.id, d.natural_key, d.resource_type, d.change_type, d.blast_radius,
              d.observed_snapshot, d.detected_at
       FROM drift d JOIN latest ON latest.id = d.id
       WHERE ${OPEN_DRIFT_PREDICATE}`,
      [tenantRef],
    ),
    client.query(
      `SELECT a.id AS request_id, a.expires_at, r.id AS dry_run_id, r.snapshot_id, r.closure_keys, r.created_at
       FROM approval_request a
       JOIN restore_dry_run r ON r.id::text = a.params->>'artifactId' AND r.tenant_ref = $1
       WHERE a.action = 'restore' AND a.status = 'pending' AND a.expires_at > $2`,
      [tenantRef, now],
    ),
    workloads.length
      ? client.query(
        `SELECT id, workload, observed_from, observed_to FROM workload_collection
          WHERE tenant_ref = $1 AND workload = ANY($2::text[])`,
        [tenantRef, workloads],
      )
      : { rows: [] },
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
    const evidence = matchEvidence(evaluation, snapshots, collections);
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
    const own = ownRows.get(evaluation.control_id) ?? null;
    const control = own ? controlFromRow(own) : controlFor(evaluation.control_id);

    return {
      id: String(evaluation.id),
      controlId: evaluation.control_id,
      // The control's own wording from the registry; null for a control it no longer holds.
      title: control?.title ?? null,
      description: control?.description ?? null,
      severity: control?.severity ?? null,
      // A check the tenant wrote itself: what it reads and expects, so it can be shown and removed.
      own: own ? shapeOwnCheck(own) : null,
      framework: evaluation.framework,
      edition: evaluation.edition,
      profile: evaluation.profile,
      evaluatorVersion: Number(evaluation.evaluator_version),
      verdict,
      reason: evaluation.reason ?? null,
      // Each setting the control checked: its value now, what it should be, and whether
      // it meets that. Older results only stored failing lines, without `ok`.
      details: Array.isArray(evaluation.details)
        ? evaluation.details.map((line) => ({ ...line, ok: line?.ok === true }))
        : [],
      // How many settings it checked and how many failed, before the lines were cut to
      // 50. Null for results stored before the counts existed.
      detailCounts: detailCounts(evaluation.detail_counts),
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
          state: evidence.length === 0 ? 'none' : evidence.every(matched) ? 'linked' : 'mismatch',
          linked: evidence.filter(matched),
          mismatched: evidence.filter((entry) => !matched(entry)),
        },
        change: partition(changes, evidenceSnapshotIds),
        restorePlan: partition(plans, evidenceSnapshotIds),
      },
      // Gap 6, "Make it pass": the one setting this control's fix changes, and the
      // objects in the newest backup it would change (filled in below).
      fix: fixDescriptor(evaluation.control_id),
      fixCandidates: [],
    };
  });
  for (const finding of findings) {
    if (finding.verdict === 'fail' && finding.fix) {
      finding.fixCandidates = await listFixCandidates(client, { tenantRef, controlId: finding.controlId });
    }
  }
  return { findings, summary: summarize(findings) };
}

function fixDescriptor(controlId) {
  const fix = fixFor(controlId);
  if (!fix) return null;
  // A fix on a service read changes one of several settings; each candidate names its own.
  if (fix.workload) return { resourceType: fix.resourceType, field: null, to: null, settings: { ...fix.settings } };
  return { resourceType: fix.resourceType, field: fix.field, to: fix.to };
}

function summarize(findings) {
  return {
    controls: findings.length,
    exposed: findings.filter((finding) => finding.exposed).length,
    excepted: findings.filter((finding) => finding.verdict === 'fail' && finding.exceptionState === 'authorized').length,
    expiredExceptions: findings.filter((finding) => finding.verdict === 'fail' && finding.exceptionState === 'expired').length,
    incompleteExceptions: findings.filter((finding) => finding.verdict === 'fail' && finding.exceptionState === 'incomplete').length,
    // Fails because the setting does not exist yet (and no exception is in force).
    notConfigured: findings.filter((finding) => finding.exposed && finding.reason === 'not-configured').length,
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
