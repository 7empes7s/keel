/**
 * Evidence-backed operation capability registry (roadmap task-52).
 *
 * Every write operation applyEngine.mjs can perform is only as trustworthy
 * as the evidence behind the claim that it works. This registry is the
 * single place that claim is recorded, distinguishing five explicit states
 * (spec Global Constraint #6): declared, fixture-tested, live-qualified,
 * unsupported and unknown. Three rules are enforced here, non-negotiably:
 *
 * 1. A claim is never a boolean and never derived from whether a Graph
 *    collection path exists for the type — tools/tenant-probe/catalog.mjs's
 *    CATALOG names a `path` for all 52 catalogue types; only a handful can
 *    actually be written. It is likewise never derived from
 *    engine/collect/descriptors.mjs's `remappable` flag, which answers a
 *    different question (can this type be resolved as a cross-tenant
 *    reference TARGET from another resource's foreign-key field) that has
 *    no bearing on whether the type's own create/update/delete/restore is
 *    implemented — a same-tenant update must not be blanket-refused merely
 *    because remappable is false. Only an explicit call to
 *    registerOperationCapability() below can move a claim off 'unsupported'.
 * 2. fixture-tested proves the production applyWave() code path against a
 *    fake writer; it can never promote itself to live-qualified.
 *    live-qualified requires evidence whose tenantRef, resourceType,
 *    operation and field-projection contract version all match the
 *    qualification request, observed within LIVE_EVIDENCE_MAX_AGE_MS (never
 *    in the future), and explicitly marked non-synthetic — a fixture
 *    harness's evidence is always synthetic and is refused here.
 * 3. capabilityFor() is the ONLY read path every caller uses, including
 *    engine/restore/applyEngine.mjs's own write-path lookup (graphPathFor).
 *    There is no second, parallel "is this a Graph write path" map to drift
 *    out of sync — extending an existing registry, never creating one.
 *
 * `subtype` is named in every record for forward compatibility (a future
 * per-subtype capability, e.g. distinct Intune configurationPolicy
 * templates) but is always null today: no currently-registered type has
 * subtype-specific write behavior, so no subtype-keyed lookup machinery is
 * built until a task actually needs it.
 */

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { FIELD_PROJECTION_CONTRACT_VERSION, reviewStateFor } from '../contracts/fieldProjection.mjs';

export const CAPABILITY_CONTRACT_VERSION = 1;

// Ordered weakest to strongest evidence, except the two terminal non-claims.
// 'unsupported' is a valid, named operation with no registration; 'unknown'
// is a string that is not even one of OPERATIONS.
export const CLAIM_LEVELS = Object.freeze([
  'declared', 'fixture-tested', 'live-qualified', 'unsupported', 'unknown',
]);

export const OPERATIONS = Object.freeze(['create', 'update', 'delete', 'restore-soft-deleted']);

export const CREDENTIAL_MODES = Object.freeze(['collector', 'restorer']);

// Evidence older than this can no longer promote a claim — matches
// tools/release/qualification.mjs's DEFAULT_MAX_AGE_HOURS (30 days), kept as
// an independent constant here since this registry does not import that
// release-gate module (a different workstream's evidence contract).
const LIVE_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class UnregisteredCapabilityError extends Error {
  constructor(resourceType, operation) {
    super(`${resourceType} ${operation}: no capability has been registered — register it explicitly before proving or qualifying it`);
    this.name = 'UnregisteredCapabilityError';
    this.resourceType = resourceType;
    this.operation = operation;
  }
}

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

// resourceType -> { path, operations: Map<operation, record> }
const REGISTRY = new Map();

function limitsFor(resourceType) {
  const entry = CATALOG_BY_TYPE.get(resourceType);
  return Object.freeze({
    criticality: entry?.criticality ?? null,
    blastRadius: entry?.blastRadius ?? null,
  });
}

/**
 * Declares a supported operation. This is the ONLY way a (resourceType,
 * operation) pair can read above 'unsupported' — never inferred from
 * CATALOG path presence or descriptor.remappable (see file header). `claim`
 * starts at 'declared'; call recordFixtureProof() separately, once an
 * adversarial boundary test has actually exercised the production code
 * path, to earn 'fixture-tested'.
 */
export function registerOperationCapability({
  resourceType, operation, subtype = null, path, handler, credentialMode = 'restorer', idOutcome,
}) {
  if (!OPERATIONS.includes(operation)) {
    throw new TypeError(`unknown operation: ${operation}`);
  }
  if (!CREDENTIAL_MODES.includes(credentialMode)) {
    throw new TypeError(`unknown credential mode: ${credentialMode}`);
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(`${resourceType}: registration requires a Graph write path`);
  }
  if (typeof handler !== 'string' || handler.length === 0) {
    throw new TypeError(`${resourceType} ${operation}: registration requires a handler reference`);
  }
  if (!REGISTRY.has(resourceType)) REGISTRY.set(resourceType, { path, operations: new Map() });
  const entry = REGISTRY.get(resourceType);
  if (entry.path !== path) {
    throw new Error(`${resourceType}: conflicting write path registered (${entry.path} vs ${path})`);
  }
  entry.operations.set(operation, {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    resourceType,
    subtype,
    operation,
    path,
    handler,
    credentialMode,
    idOutcome,
    limits: limitsFor(resourceType),
    claim: 'declared',
    proofRef: null,
  });
}

/**
 * Marks a registered operation as proven against the production applyWave()
 * code path with a fake writer. Never callable for an unregistered pair —
 * there is nothing to attach proof to.
 */
export function recordFixtureProof(resourceType, operation, proofRef) {
  const entry = REGISTRY.get(resourceType);
  const record = entry?.operations.get(operation);
  if (!record) throw new UnregisteredCapabilityError(resourceType, operation);
  if (typeof proofRef !== 'string' || proofRef.length === 0) {
    throw new TypeError(`${resourceType} ${operation}: recordFixtureProof requires a proofRef naming the test that established it`);
  }
  entry.operations.set(operation, Object.freeze({ ...record, claim: 'fixture-tested', proofRef }));
}

/**
 * Promotes a fixture-tested (or already live-qualified) capability to
 * live-qualified. `evidence` must match this exact tenant, resourceType and
 * operation and the CURRENT field-projection contract version, be fresh
 * (observed within LIVE_EVIDENCE_MAX_AGE_MS, not in the future) and
 * explicitly non-synthetic. Any failure leaves the existing claim untouched
 * and returns the specific reasons — this never partially promotes.
 */
export function qualifyLiveEvidence(resourceType, operation, evidence, { tenantRef, now = new Date() } = {}) {
  const entry = REGISTRY.get(resourceType);
  const record = entry?.operations.get(operation);
  if (!record) throw new UnregisteredCapabilityError(resourceType, operation);

  if (record.claim !== 'fixture-tested' && record.claim !== 'live-qualified') {
    return { promoted: false, claim: record.claim, failures: [`${resourceType} ${operation} has not been fixture-tested yet — live qualification requires prior fixture proof`] };
  }
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) {
    return { promoted: false, claim: record.claim, failures: ['qualifyLiveEvidence requires the tenantRef being qualified'] };
  }

  const failures = [];
  if (!evidence || typeof evidence !== 'object') {
    failures.push('evidence is missing');
  } else {
    if (evidence.tenantRef !== tenantRef) {
      failures.push(`cross-tenant evidence refused: evidence is '${evidence.tenantRef}', required '${tenantRef}'`);
    }
    if (evidence.resourceType !== resourceType || evidence.operation !== operation) {
      failures.push(`evidence is for '${evidence.resourceType}'/'${evidence.operation}', required '${resourceType}'/'${operation}'`);
    }
    if (evidence.fieldProjectionContractVersion !== FIELD_PROJECTION_CONTRACT_VERSION) {
      failures.push(`stale field-projection contract: evidence is v${evidence.fieldProjectionContractVersion}, current is v${FIELD_PROJECTION_CONTRACT_VERSION}`);
    }
    if (typeof evidence.build !== 'string' || evidence.build.length === 0) {
      failures.push('evidence is missing its build identifier');
    }
    if (evidence.synthetic !== false) {
      failures.push('a synthetic fixture proof can never promote a claim to live-qualified');
    }
    const observedAt = Date.parse(evidence.observedAt);
    if (Number.isNaN(observedAt)) {
      failures.push('evidence.observedAt is not a valid timestamp');
    } else {
      if (observedAt > now.getTime() + 5 * 60 * 1000) failures.push('evidence.observedAt is in the future');
      if (now.getTime() - observedAt > LIVE_EVIDENCE_MAX_AGE_MS) failures.push('evidence is stale');
    }
    if (typeof evidence.proofRef !== 'string' || evidence.proofRef.length === 0) {
      failures.push('evidence is missing a proofRef');
    }
  }

  if (failures.length > 0) return { promoted: false, claim: record.claim, failures };

  entry.operations.set(operation, Object.freeze({ ...record, claim: 'live-qualified', proofRef: evidence.proofRef }));
  return { promoted: true, claim: 'live-qualified', failures: [] };
}

/**
 * The read path every caller must use. An unregistered-but-valid operation
 * reads 'unsupported'; an operation name outside OPERATIONS reads
 * 'unknown'. Nothing about CATALOG path presence or descriptor.remappable
 * feeds this.
 */
export function capabilityFor(resourceType, operation) {
  const record = REGISTRY.get(resourceType)?.operations.get(operation);
  if (record) return record;
  return Object.freeze({
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    resourceType,
    subtype: null,
    operation,
    path: null,
    handler: null,
    credentialMode: null,
    idOutcome: null,
    limits: limitsFor(resourceType),
    claim: OPERATIONS.includes(operation) ? 'unsupported' : 'unknown',
    proofRef: null,
  });
}

export function isSupportedClaim(claim) {
  return claim === 'declared' || claim === 'fixture-tested' || claim === 'live-qualified';
}

/**
 * The Graph collection path for a resourceType's registered write
 * capability, or null when nothing is registered. This is
 * engine/restore/applyEngine.mjs's ONLY source for that path — replacing
 * its former hand-maintained duplicate map — so a resourceType can never be
 * writable-by-accident merely because a path string exists somewhere.
 */
export function graphPathFor(resourceType) {
  return REGISTRY.get(resourceType)?.path ?? null;
}

/**
 * Every OPERATIONS claim for a resourceType, keyed by operation. Used by
 * engine/coverage/report.mjs to surface evidence-backed capability claims
 * per catalogue type, alongside (never instead of) the existing bare
 * descriptor.remappable boolean.
 */
export function capabilitySummaryFor(resourceType) {
  const operations = {};
  for (const operation of OPERATIONS) {
    const record = capabilityFor(resourceType, operation);
    operations[operation] = Object.freeze({
      claim: record.claim,
      credentialMode: record.credentialMode,
      idOutcome: record.idOutcome,
      handler: record.handler,
      proofRef: record.proofRef,
      projection: reviewStateFor(resourceType),
    });
  }
  return Object.freeze({ contractVersion: CAPABILITY_CONTRACT_VERSION, resourceType, operations: Object.freeze(operations) });
}

// --- Explicit registrations ------------------------------------------------
// Every entry below is a deliberate, individually reviewed decision, never a
// derivation from CATALOG or descriptors.mjs. See docs/roadmap/
// capability-registry.md for the evidence backing each proofRef. Only the
// operations Microsoft Graph and applyEngine.mjs actually support per type
// are registered — e.g. roleAssignment/namedLocation/conditionalAccessPolicy
// are not soft-deletable objects (engine/reconcile/liveState.mjs's
// SOFT_DELETABLE names only user/group/application), so they carry no
// 'restore-soft-deleted' entry.

const HANDLER = 'engine/restore/applyEngine.mjs#applyWave';

function idOutcomeFor(operation) {
  if (operation === 'create') return 'server-assigned';
  if (operation === 'delete') return 'terminal';
  return 'preserved';
}

function registerAll(resourceType, path, operations) {
  for (const operation of operations) {
    registerOperationCapability({ resourceType, operation, path, handler: HANDLER, idOutcome: idOutcomeFor(operation) });
  }
}

registerAll('group', '/groups', ['create', 'update', 'delete', 'restore-soft-deleted']);
recordFixtureProof('group', 'create', 'engine/restore/applyEngine.test.mjs');
recordFixtureProof('group', 'update', 'engine/restore/updatePath.test.mjs');
recordFixtureProof('group', 'delete', 'engine/restore/deletePath.test.mjs');
recordFixtureProof('group', 'restore-soft-deleted', 'engine/restore/softDeleteRestore.test.mjs');

registerAll('roleAssignment', '/roleManagement/directory/roleAssignments', ['create', 'update', 'delete']);
recordFixtureProof('roleAssignment', 'create', 'engine/restore/applyEngine.test.mjs');
recordFixtureProof('roleAssignment', 'update', 'engine/roadmap/capability-registry.test.mjs');
recordFixtureProof('roleAssignment', 'delete', 'engine/roadmap/capability-registry.test.mjs');

registerAll('namedLocation', '/identity/conditionalAccess/namedLocations', ['create', 'update', 'delete']);
recordFixtureProof('namedLocation', 'create', 'engine/roadmap/capability-registry.test.mjs');
recordFixtureProof('namedLocation', 'update', 'engine/roadmap/capability-registry.test.mjs');
recordFixtureProof('namedLocation', 'delete', 'engine/roadmap/capability-registry.test.mjs');

registerAll('conditionalAccessPolicy', '/identity/conditionalAccess/policies', ['create', 'update', 'delete']);
recordFixtureProof('conditionalAccessPolicy', 'create', 'engine/restore/applyEngine.test.mjs');
recordFixtureProof('conditionalAccessPolicy', 'update', 'engine/restore/updatePath.test.mjs');
recordFixtureProof('conditionalAccessPolicy', 'delete', 'engine/roadmap/capability-registry.test.mjs');
