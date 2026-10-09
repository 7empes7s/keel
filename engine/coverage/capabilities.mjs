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
 * `subtype` is named in every record. It is null for every type whose write
 * behaviour does not depend on a subtype. Roadmap task-108 registers the first
 * subtype-bound operations (custom authentication strengths): the record names
 * the one subtype its proof covers, and engine/restore/policyOperations.mjs
 * refuses a write whose resource is any other subtype — a proof is never
 * reused across subtypes. The registry stays keyed by (resourceType,
 * operation); a second subtype of the same operation would need its own key.
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

// Roadmap task-61: relationship (edge) write operations. Kept apart from
// OPERATIONS — an edge is never a create/update of its parent object — and
// registered under an edge capability key ('<parentType>#<family>', e.g.
// 'group#member'), never under the parent resourceType itself, so a parent's
// object capabilities cannot imply an edge capability or vice versa.
export const EDGE_OPERATIONS = Object.freeze(['edge-add', 'edge-remove']);

export function edgeCapabilityKey(parentType, family) {
  return `${parentType}#${family}`;
}

const isKnownOperation = (operation) => OPERATIONS.includes(operation) || EDGE_OPERATIONS.includes(operation);

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
  if (!isKnownOperation(operation)) {
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
    claim: isKnownOperation(operation) ? 'unsupported' : 'unknown',
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
// are registered — e.g. roleAssignment/namedLocation are not soft-deletable
// objects (engine/reconcile/liveState.mjs's SOFT_DELETABLE names only
// user/group/application/conditionalAccessPolicy), so they carry no
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

// Roadmap task-152: restore-soft-deleted restores a deleted policy from the
// Conditional Access deleted-items container with the same id, and lands it
// report-only like every other Conditional Access write. Fixture-tested only.
registerAll('conditionalAccessPolicy', '/identity/conditionalAccess/policies', ['create', 'update', 'delete', 'restore-soft-deleted']);
recordFixtureProof('conditionalAccessPolicy', 'create', 'engine/restore/applyEngine.test.mjs');
recordFixtureProof('conditionalAccessPolicy', 'update', 'engine/restore/updatePath.test.mjs');
recordFixtureProof('conditionalAccessPolicy', 'delete', 'engine/roadmap/capability-registry.test.mjs');
recordFixtureProof('conditionalAccessPolicy', 'restore-soft-deleted', 'engine/roadmap/conditional-access-enforce.test.mjs');

// Roadmap task-107: the first bounded application/service-principal subset of
// the Entra expansion batches (engine/coverage/qualification.mjs's
// EXPANSION_BATCHES). Only these operations are registered; every sibling verb
// stays unsupported and refused by verbCapability(). application delete is
// deliberately absent: deleting an app registration strands every consumer of
// its credentials, and KEEL has no qualified guard for that yet. Credential
// material (passwordCredentials, keyCredentials) is immutable for the
// application type and excluded from create bodies, so no operation here ever
// writes it; a recreate leaves
// owned credential completion items instead (engine/restore/completion.mjs).
registerAll('application', '/applications', ['create', 'update', 'restore-soft-deleted']);
recordFixtureProof('application', 'create', 'engine/roadmap/fidelity-expansion.test.mjs');
recordFixtureProof('application', 'update', 'engine/roadmap/fidelity-expansion.test.mjs');
recordFixtureProof('application', 'restore-soft-deleted', 'engine/roadmap/fidelity-expansion.test.mjs');

// Roadmap task-150: a user is updated through a reviewed attribute allowlist and
// restored from deleted items with the same id; licences are assigned add-only
// (engine/restore/userOperations.mjs). create stays manual: a password and MFA
// methods are never readable, and delete is not qualified.
registerAll('user', '/users', ['update', 'restore-soft-deleted']);
recordFixtureProof('user', 'update', 'engine/roadmap/user-fidelity.test.mjs');
recordFixtureProof('user', 'restore-soft-deleted', 'engine/roadmap/user-fidelity.test.mjs');

registerAll('servicePrincipal', '/servicePrincipals', ['create']);
recordFixtureProof('servicePrincipal', 'create', 'engine/roadmap/fidelity-expansion.test.mjs');

// Roadmap task-108: the custom authentication-strength subset of the policy
// batch. Only create and update, and only for the 'custom' subtype: built-in
// strengths are Microsoft-owned and immutable, and are refused before any write
// (engine/restore/policyOperations.mjs). delete is not registered — a strength
// referenced by a Conditional Access policy cannot be removed safely, and KEEL
// has no qualified guard for that.
for (const operation of ['create', 'update']) {
  registerOperationCapability({
    resourceType: 'authenticationStrengthPolicy', operation, subtype: 'custom',
    path: '/policies/authenticationStrengthPolicies', handler: HANDLER, idOutcome: idOutcomeFor(operation),
  });
  recordFixtureProof('authenticationStrengthPolicy', operation, 'engine/roadmap/policy-fidelity.test.mjs');
}

// Roadmap task-109: the administrative-configuration subset. Three operation
// records only (engine/restore/administrativeOperations.mjs): update of an
// administrative unit's name and description, and update and delete of a
// tenant-wide directory setting. Every other verb stays unsupported; global
// setting templates are never registered and are refused even if they were.
registerAll('administrativeUnit', '/directory/administrativeUnits', ['update']);
recordFixtureProof('administrativeUnit', 'update', 'engine/roadmap/administrative-fidelity.test.mjs');
registerAll('groupSetting', '/groupSettings', ['update', 'delete']);
recordFixtureProof('groupSetting', 'update', 'engine/roadmap/administrative-fidelity.test.mjs');
recordFixtureProof('groupSetting', 'delete', 'engine/roadmap/administrative-fidelity.test.mjs');

// Roadmap task-149: the tenant-wide Entra security policies. Explicit records
// (engine/restore/tenantPolicyOperations.mjs) bind each to its route, method and
// writable fields. Singletons register their own route; a partner registers the
// partners collection. Only update (and partner create) is registered: a
// singleton is never created or deleted, and a partner delete is not qualified.
// The authentication methods policy, security defaults and the authorization
// policy are written only behind the break-glass lockout gate.
for (const [resourceType, path] of [
  ['authorizationPolicy', '/policies/authorizationPolicy'],
  ['authenticationMethodsPolicy', '/policies/authenticationMethodsPolicy'],
  ['identitySecurityDefaultsEnforcementPolicy', '/policies/identitySecurityDefaultsEnforcementPolicy'],
  ['crossTenantAccessPolicy', '/policies/crossTenantAccessPolicy'],
  ['crossTenantAccessPolicyConfigurationDefault', '/policies/crossTenantAccessPolicy/default'],
  ['adminConsentRequestPolicy', '/policies/adminConsentRequestPolicy'],
]) {
  registerAll(resourceType, path, ['update']);
  recordFixtureProof(resourceType, 'update', 'engine/roadmap/tenant-policy-fidelity.test.mjs');
}
registerAll('crossTenantAccessPolicyPartner', '/policies/crossTenantAccessPolicy/partners', ['create', 'update']);
recordFixtureProof('crossTenantAccessPolicyPartner', 'create', 'engine/roadmap/tenant-policy-fidelity.test.mjs');
recordFixtureProof('crossTenantAccessPolicyPartner', 'update', 'engine/roadmap/tenant-policy-fidelity.test.mjs');

// Issue #156: basic tenant settings, written through the same explicit records
// (engine/restore/tenantPolicyOperations.mjs). Update only: Graph has no create
// or delete for the default branding or the authentication flows policy, and
// creating or deleting a branding localization or a group expiration policy is
// not qualified. The device registration policy is never registered.
for (const [resourceType, path] of [
  ['organizationalBranding', '/organization/{org}/branding'],
  ['organizationalBrandingLocalization', '/organization/{org}/branding/localizations'],
  ['groupLifecyclePolicy', '/groupLifecyclePolicies'],
  ['authenticationFlowsPolicy', '/policies/authenticationFlowsPolicy'],
]) {
  registerAll(resourceType, path, ['update']);
  recordFixtureProof(resourceType, 'update', 'engine/roadmap/entra-basic-settings.test.mjs');
}
// Roadmap task-151: the admin role model (engine/restore/adminRoleOperations.mjs).
// Custom roles are created and updated for the 'custom' subtype only: a built-in
// role is immutable and skipped before any write. An eligibility is created
// through a schedule request (its registered path), never updated or removed.
// A PIM settings policy is only updated, rule by rule: Entra creates one per
// role and it is never created or deleted. Role delete is not registered.
for (const operation of ['create', 'update']) {
  registerOperationCapability({
    resourceType: 'roleDefinition', operation, subtype: 'custom',
    path: '/roleManagement/directory/roleDefinitions', handler: HANDLER, idOutcome: idOutcomeFor(operation),
  });
  recordFixtureProof('roleDefinition', operation, 'engine/roadmap/admin-role-fidelity.test.mjs');
}
registerAll('roleEligibilitySchedule', '/roleManagement/directory/roleEligibilityScheduleRequests', ['create']);
recordFixtureProof('roleEligibilitySchedule', 'create', 'engine/roadmap/admin-role-fidelity.test.mjs');
registerAll('unifiedRoleManagementPolicy', '/policies/roleManagementPolicies', ['update']);
recordFixtureProof('unifiedRoleManagementPolicy', 'update', 'engine/roadmap/admin-role-fidelity.test.mjs');

// Issue #155: Intune compliance policies, device configuration profiles and
// settings catalog policies (the settings catalog through Graph beta, which is
// the only version that has it). Create and update only, each through its
// operation record in engine/restore/intuneOperations.mjs, with assignments
// written through /assign. Delete is not registered: removing a policy
// unprotects every device it applies to, and KEEL has no qualified guard for that.
for (const [resourceType, path] of [
  ['deviceCompliancePolicy', '/deviceManagement/deviceCompliancePolicies'],
  ['deviceConfiguration', '/deviceManagement/deviceConfigurations'],
  ['configurationPolicy', '/deviceManagement/configurationPolicies'],
]) {
  registerAll(resourceType, path, ['create', 'update']);
  recordFixtureProof(resourceType, 'create', 'engine/roadmap/intune-restore.test.mjs');
  recordFixtureProof(resourceType, 'update', 'engine/roadmap/intune-restore.test.mjs');
}

// Roadmap task-61: group member/owner edges, written ONLY through the qualified
// `$ref` navigation handlers in engine/restore/relationshipWriter.mjs — never by
// PATCHing a members/owners array onto the parent group. Every other relationship
// family (transitiveMember, application/servicePrincipal owners, app role grants,
// Intune assignments) has no edge registration, so it reads 'unsupported'. Issue
// #155: an Intune policy's assignments are written only with the policy itself
// (its create/update record above, through /assign), never as a standalone edge.
const EDGE_HANDLER = 'engine/restore/relationshipWriter.mjs#applyRelationshipOperations';
for (const family of ['member', 'owner']) {
  const resourceType = edgeCapabilityKey('group', family);
  for (const operation of EDGE_OPERATIONS) {
    registerOperationCapability({
      resourceType, operation, path: `/groups/{id}/${family}s/$ref`, handler: EDGE_HANDLER, idOutcome: 'edge',
    });
    recordFixtureProof(resourceType, operation, 'engine/roadmap/relationship-restore.test.mjs');
  }
}
