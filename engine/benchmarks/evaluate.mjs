/**
 * Versioned benchmark control evaluation (roadmap task-85).
 *
 * evaluateControl() is a pure function: given a control id and per-type
 * observation evidence, it returns one evaluation result. Persistence
 * (recordEvaluation/recordException) is a thin layer on top that never
 * changes the verdict decision itself. Four rules are enforced here,
 * non-negotiably:
 *
 * 1. A required observation that is missing, stale, future-dated or not a
 *    completed read makes the whole control 'unknown' — the predicate is
 *    never invoked in that case (mutation check: treat missing observation
 *    as pass). Every one of a control's requiredObservations must be usable
 *    before any predicate runs.
 * 2. A different framework edition or evaluatorVersion between two
 *    evaluations is never treated as tenant drift: compareEvaluationsAcrossEditions()
 *    refuses to compare (comparable: false) whenever either differs, exactly
 *    like engine/cir/canonicalHash.mjs's compareAcrossHashVersions() refuses
 *    to compare raw hashes across HASH_VERSIONs (mutation check: conflate
 *    edition changes with tenant drift). Nothing in this module writes to
 *    the drift/baseline tables — a benchmark result is never fed into drift
 *    detection.
 * 3. recordException() never rewrites a stored evaluation's verdict; it
 *    inserts a benchmark_exception row that references the evaluation.
 *    effectiveVerdict() computes the overlay at read time. The underlying
 *    'fail' verdict, its reason and its evidence stay exactly as recorded
 *    (mutation check: erase underlying finding under exception) — the
 *    database schema itself also refuses 'exception' as a stored verdict
 *    value (see engine/store/schema.sql's benchmark_evaluation CHECK).
 * 4. Every observation is tenant-scoped; a cross-tenant mention refuses the
 *    whole evaluation by throwing CrossTenantObservationError, the same
 *    contract engine/coverage/diagnosis.mjs already enforces.
 */
import { CrossTenantObservationError } from '../contracts/observation.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { controlFor, predicateFor, semanticFacts, PREDICATE_VERDICTS } from './registry.mjs';

export const EVALUATION_CONTRACT_VERSION = 1;

// Mirrors diagnosis.mjs's future-tolerance: small clock skew between the
// collector and this evaluation is expected, a genuinely future-dated
// observation window is not.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * A required observation is usable only when it names the expected resource
 * type, matches the evaluating tenant, carries a valid (non-future, not
 * stale) window and completed successfully. Any other case degrades the
 * whole control to 'unknown' — never a guessed pass.
 */
function usableObservation(entry, { tenantRef, now, resourceType, maxAgeMs }) {
  const observation = entry?.observation;
  if (!observation) return { usable: false, reason: 'no-observation' };
  if (observation.resourceType !== resourceType) {
    return { usable: false, reason: 'resource-type-mismatch' };
  }
  if (observation.tenantRef !== undefined && observation.tenantRef !== tenantRef) {
    throw new CrossTenantObservationError(observation.tenantRef, tenantRef);
  }
  const startedAt = Date.parse(observation.window?.startedAt);
  const endedAt = Date.parse(observation.window?.endedAt);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) {
    return { usable: false, reason: 'untimed-observation' };
  }
  if (endedAt > now.getTime() + FUTURE_TOLERANCE_MS) {
    return { usable: false, reason: 'future-observation' };
  }
  if (now.getTime() - endedAt > maxAgeMs) {
    return { usable: false, reason: 'stale-observation' };
  }
  // engine/contracts/observation.mjs's COMPLETENESS_STATES has no separate
  // "empty" state — a completed read that found zero items is 'complete'
  // (readObservation() already normalizes the legacy 'complete-empty'
  // outcome string down to completeness: 'complete'), so only 'complete'
  // itself is usable here.
  if (observation.completeness !== 'complete') {
    return { usable: false, reason: `observation-${observation.completeness ?? 'unknown'}` };
  }
  return { usable: true };
}

function freezeResult({ control, verdict, reason, evidenceRefs, observationWindows, now }) {
  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    controlId: control.controlId,
    framework: control.framework,
    edition: control.edition,
    profile: control.profile,
    evaluatorVersion: control.evaluatorVersion,
    verdict,
    reason,
    evidenceRefs: Object.freeze(evidenceRefs),
    observationWindows: Object.freeze(observationWindows),
    evaluatedAt: now.toISOString(),
  });
}

/**
 * `observations` maps resourceType -> { observation: <observation-contract
 * object, see engine/contracts/observation.mjs>, resources: [rawPayload,...] }.
 * Pure and synchronous: no DB access, no evidence write.
 */
export function evaluateControl({ controlId, tenantRef, observations = {}, now = new Date() }) {
  assertTenantRef(tenantRef);
  const control = controlFor(controlId);
  if (!control) throw new TypeError(`${controlId}: control is not registered`);

  const factsByType = {};
  const evidenceRefs = [];
  const observationWindows = [];

  for (const required of control.requiredObservations) {
    const entry = observations[required.resourceType];
    const usability = usableObservation(entry, {
      tenantRef, now, resourceType: required.resourceType, maxAgeMs: required.maxAgeMs,
    });
    if (!usability.usable) {
      return freezeResult({
        control, verdict: 'unknown', reason: `${required.resourceType}:${usability.reason}`,
        evidenceRefs: [], observationWindows: [], now,
      });
    }
    const resources = Array.isArray(entry.resources) ? entry.resources : [];
    factsByType[required.resourceType] = resources.map((resource) => semanticFacts(required.resourceType, resource));
    for (const resource of resources) {
      evidenceRefs.push({ resourceType: required.resourceType, id: resource?.id ?? null });
    }
    observationWindows.push({
      resourceType: required.resourceType,
      startedAt: entry.observation.window.startedAt,
      endedAt: entry.observation.window.endedAt,
    });
  }

  // Single-type controls (every shipped fixture today) get the plain facts
  // array; a multi-type control would get the full per-type map instead.
  const factsArg = control.requiredObservations.length === 1
    ? factsByType[control.requiredObservations[0].resourceType]
    : factsByType;

  const predicate = predicateFor(control.predicate.name);
  const verdict = predicate(factsArg, control.predicate.args);
  if (!PREDICATE_VERDICTS.includes(verdict)) {
    throw new TypeError(`${controlId}: predicate must return one of ${PREDICATE_VERDICTS.join(', ')}, got ${JSON.stringify(verdict)}`);
  }

  return freezeResult({ control, verdict, reason: null, evidenceRefs, observationWindows, now });
}

/**
 * Refuses to compare two evaluations across a different framework edition or
 * evaluatorVersion (rule 2 above). Only ever called with two results for the
 * SAME controlId — a different controlId is a caller error, not a drift
 * question this function answers.
 */
export function compareEvaluationsAcrossEditions(previous, next) {
  if (previous.controlId !== next.controlId) {
    throw new TypeError('compareEvaluationsAcrossEditions requires the same controlId on both sides');
  }
  if (previous.edition !== next.edition || previous.evaluatorVersion !== next.evaluatorVersion) {
    return Object.freeze({ comparable: false, changed: null, reason: 'edition-or-evaluator-changed' });
  }
  return Object.freeze({ comparable: true, changed: previous.verdict !== next.verdict, reason: null });
}

/** Persists one evaluation result and appends its evidence record. */
export async function recordEvaluation(client, { tenantRef, result, actor }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `INSERT INTO benchmark_evaluation
       (tenant_ref, control_id, framework, edition, profile, evaluator_version,
        verdict, reason, evidence_refs, observation_windows, evaluated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      tenantRef, result.controlId, result.framework, result.edition, result.profile,
      result.evaluatorVersion, result.verdict, result.reason,
      JSON.stringify(result.evidenceRefs), JSON.stringify(result.observationWindows), result.evaluatedAt,
    ],
  );
  const evaluation = rows[0];
  const evidence = await appendEvidence(client, {
    tenantRef,
    kind: 'benchmark-evaluation',
    actor,
    subject: {
      evaluationId: evaluation.id,
      controlId: result.controlId,
      framework: result.framework,
      edition: result.edition,
      profile: result.profile,
      evaluatorVersion: result.evaluatorVersion,
      verdict: result.verdict,
      reason: result.reason,
    },
  });
  const { rows: updated } = await client.query(
    `UPDATE benchmark_evaluation SET evidence_seq = $2 WHERE id = $1 RETURNING *`,
    [evaluation.id, evidence.seq],
  );
  return updated[0];
}

/**
 * Records an exception (waiver) against an existing evaluation. Only a
 * stored 'fail' verdict may be waived — waiving a 'pass' is meaningless and
 * waiving an 'unknown' would hide a coverage gap behind an apparently
 * reviewed status. The evaluation row itself is never updated (rule 3
 * above): this only inserts an overlay row plus its own evidence entry.
 */
export async function recordException(client, { tenantRef, evaluationId, actor, reason, expiresAt = null }) {
  assertTenantRef(tenantRef);
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError('recordException requires a non-empty reason');
  }
  const { rows: evaluationRows } = await client.query(
    `SELECT * FROM benchmark_evaluation WHERE id = $1 AND tenant_ref = $2`,
    [evaluationId, tenantRef],
  );
  const evaluation = evaluationRows[0];
  if (!evaluation) throw new Error(`benchmark evaluation not found for this tenant: ${evaluationId}`);
  if (evaluation.verdict !== 'fail') {
    throw new Error(`${evaluationId}: exception requires an underlying 'fail' verdict, got '${evaluation.verdict}'`);
  }

  const { rows } = await client.query(
    `INSERT INTO benchmark_exception (tenant_ref, evaluation_id, actor, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [tenantRef, evaluationId, actor, reason, expiresAt],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: 'benchmark-exception',
    actor,
    subject: {
      evaluationId,
      controlId: evaluation.control_id,
      underlyingVerdict: evaluation.verdict,
      reason,
      expiresAt: expiresAt ?? null,
    },
  });
  return rows[0];
}

/** Reads active (unexpired) exceptions for a set of evaluation ids. */
export async function listActiveExceptions(client, { tenantRef, evaluationIds }) {
  assertTenantRef(tenantRef);
  if (!Array.isArray(evaluationIds) || evaluationIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT * FROM benchmark_exception
      WHERE tenant_ref = $1 AND evaluation_id = ANY($2::uuid[])
        AND (expires_at IS NULL OR expires_at > now())`,
    [tenantRef, evaluationIds],
  );
  return rows;
}

/**
 * Computes the effective, read-time verdict for one evaluation row given its
 * (already-loaded) exceptions. Never mutates evaluation or exceptions; the
 * underlying stored verdict is always still readable via underlyingVerdict.
 */
export function effectiveVerdict(evaluation, exceptions, { now = new Date() } = {}) {
  const active = (exceptions ?? []).find((exception) => (
    exception.evaluation_id === evaluation.id
    && (exception.expires_at === null || new Date(exception.expires_at) > now)
  ));
  if (active) {
    return Object.freeze({ verdict: 'exception', underlyingVerdict: evaluation.verdict, exception: active });
  }
  return Object.freeze({ verdict: evaluation.verdict, underlyingVerdict: evaluation.verdict, exception: null });
}
