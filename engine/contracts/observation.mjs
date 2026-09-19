/**
 * Versioned observation and evidence contract (roadmap task-45).
 *
 * Every coverage or qualification claim is anchored to an observation: a
 * tenant-scoped, per-type read with an explicit start/end window, the build
 * that produced it, a completeness state and an evidence level. Three rules
 * are enforced here, non-negotiably:
 *
 * 1. tenant_ref is mandatory and joins across tenants are refused. An
 *    observation can never be merged with evidence from another tenant.
 * 2. The window is per observation. Two observations whose windows differ
 *    are not simultaneous; a tiered snapshot merges per-type runs and is
 *    never an atomic tenant-wide image.
 * 3. evidenceLevel distinguishes fixture-tested, live-qualified and unknown.
 *    Legacy digests carry no proof and always read as 'unknown'; a fixture
 *    can never promote itself to live-qualified.
 */

export const OBSERVATION_CONTRACT_VERSION = 1;

export const EVIDENCE_LEVELS = Object.freeze(['fixture-tested', 'live-qualified', 'unknown']);
export const COMPLETENESS_STATES = Object.freeze(['complete', 'partial', 'failed', 'unknown']);

export class CrossTenantObservationError extends Error {
  constructor(a, b) {
    super(`cross-tenant observation join refused: ${a} vs ${b}`);
    this.name = 'CrossTenantObservationError';
  }
}

function asIsoInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

export function defineObservation({
  tenantRef, observationId, resourceType, window, sourceBuild, completeness, evidenceLevel,
}) {
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) {
    throw new TypeError('observation requires a tenant_ref');
  }
  if (typeof observationId !== 'string' || observationId.length === 0) {
    throw new TypeError('observation requires an observation id');
  }
  if (typeof resourceType !== 'string' || resourceType.length === 0) {
    throw new TypeError('observation requires a resource type');
  }
  const startedAt = asIsoInstant(window?.startedAt);
  const endedAt = asIsoInstant(window?.endedAt);
  if (!startedAt || !endedAt) {
    throw new TypeError('observation window requires valid startedAt/endedAt instants');
  }
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new RangeError('observation window ends before it starts');
  }
  if (!COMPLETENESS_STATES.includes(completeness)) {
    throw new TypeError(`unknown completeness state: ${completeness}`);
  }
  if (!EVIDENCE_LEVELS.includes(evidenceLevel)) {
    throw new TypeError(`unknown evidence level: ${evidenceLevel}`);
  }
  return Object.freeze({
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    tenantRef,
    observationId,
    resourceType,
    window: Object.freeze({ startedAt, endedAt }),
    sourceBuild: sourceBuild ?? null,
    completeness,
    evidenceLevel,
  });
}

/**
 * Read any stored coverage-digest entry as an observation. Legacy entries
 * (bare counts and { outcome, itemCount } without a contract version) are
 * preserved exactly: their window falls back to the enclosing snapshot run
 * bounds, their completeness comes from the legacy outcome rules, and their
 * evidence level is always 'unknown' — a legacy row can never be promoted
 * to fixture-tested or live-qualified. A versioned entry that names a
 * different tenant than its enclosing snapshot is rejected, never joined.
 */
export function readObservation(entry, {
  tenantRef, observationId, resourceType, snapshotWindow = null,
}) {
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) {
    throw new TypeError('readObservation requires the enclosing tenant_ref');
  }
  if (entry && typeof entry === 'object' && entry.contractVersion === OBSERVATION_CONTRACT_VERSION) {
    if (entry.tenantRef !== undefined && entry.tenantRef !== tenantRef) {
      throw new CrossTenantObservationError(entry.tenantRef, tenantRef);
    }
    return defineObservation({
      tenantRef,
      observationId: entry.observationId ?? observationId,
      resourceType: entry.resourceType ?? resourceType,
      window: entry.window,
      sourceBuild: entry.sourceBuild ?? null,
      completeness: entry.completeness,
      evidenceLevel: entry.evidenceLevel,
    });
  }
  // Legacy reads: no contract version, no per-type window, no proof.
  const legacyCount = typeof entry === 'number' ? entry : entry?.itemCount;
  const legacyOutcome = typeof entry === 'number'
    ? (entry > 0 ? 'complete' : 'unknown')
    : entry?.outcome === 'complete' || entry?.outcome === 'complete-empty' ? 'complete'
      : entry?.outcome === 'partial' ? 'partial'
        : entry?.outcome === 'failed' ? 'failed'
          : 'unknown';
  // A structured entry carries its own observation window; only entries
  // without one fall back to the enclosing snapshot run bounds.
  const startedAt = asIsoInstant(entry?.startedAt) ?? asIsoInstant(snapshotWindow?.startedAt);
  const endedAt = asIsoInstant(entry?.completedAt) ?? asIsoInstant(snapshotWindow?.endedAt);
  return Object.freeze({
    contractVersion: 0,
    legacy: true,
    tenantRef,
    observationId,
    resourceType,
    window: startedAt && endedAt ? Object.freeze({ startedAt, endedAt }) : null,
    sourceBuild: null,
    completeness: legacyOutcome,
    itemCount: Number.isSafeInteger(legacyCount) && legacyCount >= 0 ? legacyCount : null,
    evidenceLevel: 'unknown',
  });
}

/**
 * Simultaneity is a property of identical windows only. Different or unknown
 * windows can never be labeled simultaneous; the result names each mismatch
 * instead of silently merging observations taken at different times.
 */
export function assertSimultaneous(observations) {
  const mismatches = [];
  const [first, ...rest] = observations;
  for (const other of rest) {
    if (!first?.window || !other?.window) {
      mismatches.push({
        a: first?.observationId ?? null,
        b: other?.observationId ?? null,
        reason: 'window-unknown',
      });
    } else if (
      first.window.startedAt !== other.window.startedAt
      || first.window.endedAt !== other.window.endedAt
    ) {
      mismatches.push({
        a: first.observationId,
        b: other.observationId,
        reason: 'window-mismatch',
        aWindow: first.window,
        bWindow: other.window,
      });
    }
  }
  return { simultaneous: mismatches.length === 0 && observations.length > 0, mismatches };
}

/**
 * Tenant-checked join over observations. Any tenant_ref mismatch refuses the
 * whole join by throwing; there is no partial cross-tenant merge.
 */
export function joinObservations(observations) {
  for (const observation of observations) {
    if (typeof observation?.tenantRef !== 'string' || observation.tenantRef.length === 0) {
      throw new TypeError('joined observation requires a tenant_ref');
    }
    if (observation.tenantRef !== observations[0]?.tenantRef) {
      throw new CrossTenantObservationError(observation.tenantRef, observations[0]?.tenantRef);
    }
  }
  return [...observations].sort((a, b) => {
    const aEnd = a.window?.endedAt ?? '';
    const bEnd = b.window?.endedAt ?? '';
    return aEnd < bEnd ? -1 : aEnd > bEnd ? 1 : 0;
  });
}
