/**
 * Roadmap task-63: the per-operation qualification (fidelity) ledger.
 *
 * One explicit row per catalogue type × operation. It answers, from declared
 * evidence only:
 *  - can this operation be performed (the task-52 capability claim);
 *  - which credential performs it;
 *  - what happens to the object id;
 *  - why a retry is safe;
 *  - whether the operation needs reference remapping, and whether that
 *    remapping is proven;
 *  - what fixture and live evidence back the claim.
 *
 * Three rules, mirroring capabilities.mjs:
 *
 * 1. Every catalogue type has an EXPLICIT decision in TYPE_DECISIONS below:
 *    'automated' (writes registered in capabilities.mjs), 'manual' (recovery
 *    stays a refusal plus human steps, by design) or 'unknown' (not
 *    investigated). buildOperationLedger() throws if a catalogue type is
 *    missing, so a new type can never be silently treated as either.
 * 2. descriptor.remappable is NOT a write gate. Remapping is qualified per
 *    (resourceType, operation), and only where an operation actually rewrites
 *    a reference to a different id. A same-tenant update whose references
 *    resolve to the ids already in the payload remaps nothing and needs no
 *    remapping proof. A rewrite to a different id (a new object, another
 *    tenant) requires a recorded proof for exactly that operation.
 * 3. Nothing here can raise a claim. A decision label, a passing fixture
 *    harness run or a ledger row never changes capabilityFor(); only
 *    capabilities.mjs's explicit registration and qualifyLiveEvidence() can.
 */
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { reviewStateFor } from '../contracts/fieldProjection.mjs';
import {
  EDGE_OPERATIONS, OPERATIONS, capabilityFor, edgeCapabilityKey, isSupportedClaim,
} from './capabilities.mjs';

export const LEDGER_CONTRACT_VERSION = 1;
export const TYPE_DECISION_VALUES = Object.freeze(['automated', 'manual', 'unknown']);

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const automated = (resource, reason) => ({ decision: 'automated', docs: `${DOCS}/resources/${resource}?view=graph-rest-1.0`, reason });
const manual = (reason, extra = {}) => ({ decision: 'manual', reason, ...extra });
const unknown = (extra = {}) => ({ decision: 'unknown', reason: 'not yet investigated for automated recovery', ...extra });

/**
 * The explicit per-type decision. Reviewed by hand, never derived from
 * CATALOG paths, descriptor.remappable or a fixture result. `softRestoreCandidate`
 * marks types Graph can restore from deleted items. That is a candidate for
 * investigation, not a capability.
 */
export const TYPE_DECISIONS = Object.freeze({
  organization: manual('the tenant object itself; it is never recreated'),
  domain: manual('requires DNS ownership verification outside Graph'),
  subscribedSku: manual('licences are purchased, not configured'),
  directorySettingTemplate: manual('Microsoft-published template catalogue'),
  groupSetting: unknown(),
  user: manual('tenant-bound identity; credentials are never readable', { softRestoreCandidate: true }),
  group: automated('group', 'create/update/delete/restore and member/owner edges are registered'),
  administrativeUnit: unknown(),
  contact: manual('organizational contacts are directory-synchronised and read-only in Graph'),
  application: unknown({ softRestoreCandidate: true }),
  servicePrincipal: unknown(),
  oauth2PermissionGrant: unknown(),
  identityProvider: manual('client secrets are never readable'),
  certificateBasedAuthConfiguration: unknown(),
  directoryRole: manual('built-in roles are activated from templates, never authored'),
  roleDefinition: unknown(),
  directoryRoleTemplate: manual('Microsoft-published template catalogue'),
  roleAssignment: automated('unifiedroleassignment', 'create/update/delete are registered'),
  roleEligibilitySchedule: unknown(),
  conditionalAccessPolicy: automated('conditionalaccesspolicy', 'create/update/delete are registered; writes are forced report-only'),
  authenticationStrengthPolicy: unknown(),
  namedLocation: automated('namedlocation', 'create/update/delete are registered'),
  authenticationContextClassReference: unknown(),
  authenticationMethodsPolicy: unknown(),
  authorizationPolicy: unknown(),
  crossTenantAccessPolicy: unknown(),
  crossTenantAccessPolicyPartner: unknown(),
  permissionGrantPolicy: unknown(),
  adminConsentRequestPolicy: unknown(),
  activityBasedTimeoutPolicy: unknown(),
  claimsMappingPolicy: unknown(),
  homeRealmDiscoveryPolicy: unknown(),
  tokenIssuancePolicy: unknown(),
  tokenLifetimePolicy: unknown(),
  featureRolloutPolicy: unknown(),
  accessReviewScheduleDefinition: unknown(),
  accessPackage: unknown(),
  connectedOrganization: unknown(),
  deviceConfiguration: unknown(),
  deviceCompliancePolicy: unknown(),
  configurationPolicy: unknown(),
  deviceEnrollmentConfiguration: unknown(),
  deviceManagementRoleDefinition: unknown(),
  deviceCategory: unknown(),
  termsAndConditions: unknown(),
  windowsAutopilotDeploymentProfile: unknown(),
  deviceManagementIntent: unknown(),
  managedDevice: manual('device state, enrolled by the device, not configuration'),
  mobileApp: unknown(),
  managedAppPolicy: unknown(),
  targetedManagedAppConfiguration: unknown(),
  mobileAppConfiguration: unknown(),
});

// Why a retried operation can never double-apply — each names the mechanism in
// applyEngine.mjs / relationshipWriter.mjs that makes it so.
const IDEMPOTENCY = Object.freeze({
  create: 'natural-key reconciled: the target is re-collected before every run, so an existing object is updated, never re-created',
  update: 'full-state PATCH verified by read-back; repeating it converges',
  delete: 'verified by a read-back 404; an already-absent object is a no-op',
  'restore-soft-deleted': 'verified present after restore; an already-restored object takes the update path',
  'edge-add': 'precondition read; an ambiguous outcome is re-read, never re-sent',
  'edge-remove': 'precondition read; an ambiguous outcome is re-read, never re-sent',
});

// Which operations ever rewrite references in their payload (applyEngine.mjs's
// rewriteReferences call sites). Delete and edge operations write no payload.
const REWRITES_REFERENCES = new Set(['create', 'update', 'restore-soft-deleted']);

// resourceType -> Map<operation, { proofRef }>
const REMAPPING_PROOFS = new Map();

/**
 * Records that rewriting references to a DIFFERENT id has been proven for
 * exactly this (resourceType, operation), through the production applyWave
 * path. A proof for one operation never covers another.
 */
export function recordRemappingProof(resourceType, operation, proofRef) {
  if (!REWRITES_REFERENCES.has(operation)) {
    throw new TypeError(`${resourceType} ${operation}: this operation writes no references, so there is nothing to remap`);
  }
  if (!isSupportedClaim(capabilityFor(resourceType, operation).claim)) {
    throw new Error(`${resourceType} ${operation}: remapping proof requires a registered write capability first`);
  }
  if (typeof proofRef !== 'string' || proofRef.length === 0) {
    throw new TypeError(`${resourceType} ${operation}: remapping proof requires a proofRef`);
  }
  if (!REMAPPING_PROOFS.has(resourceType)) REMAPPING_PROOFS.set(resourceType, new Map());
  REMAPPING_PROOFS.get(resourceType).set(operation, Object.freeze({ proofRef }));
}

/** The remapping qualification applyWave consults when a rewrite changes an id. */
export function remappingFor(resourceType, operation) {
  if (!REWRITES_REFERENCES.has(operation)) return Object.freeze({ requirement: 'none', qualified: true, proofRef: null });
  const proof = REMAPPING_PROOFS.get(resourceType)?.get(operation) ?? null;
  return Object.freeze({ requirement: 'when-a-reference-id-changes', qualified: proof !== null, proofRef: proof?.proofRef ?? null });
}

// Remapping proven against the production applyWave path. Each proofRef names
// the test that rewrites a reference to a different target id for exactly this
// operation and asserts the written payload carries it.
recordRemappingProof('group', 'create', 'engine/restore/applyPatches.test.mjs');
recordRemappingProof('roleAssignment', 'create', 'engine/restore/applyEngine.test.mjs');
recordRemappingProof('conditionalAccessPolicy', 'create', 'cli/keel-restore.test.mjs');
recordRemappingProof('conditionalAccessPolicy', 'update', 'engine/roadmap/fidelity-ledger.test.mjs');

function sourceFor(type, decision) {
  const entry = CATALOG.find((candidate) => candidate.type === type);
  return Object.freeze({
    graphPath: entry?.path ?? null,
    apiVersion: entry?.version ?? null,
    docs: decision.docs ?? null,
  });
}

function rowFor(resourceType, operation, { capabilityKey = resourceType, decision }) {
  const capability = capabilityFor(capabilityKey, operation);
  const supported = isSupportedClaim(capability.claim);
  const remapping = supported ? remappingFor(capabilityKey, operation) : null;
  return Object.freeze({
    resourceType: capabilityKey,
    operation,
    // A row is 'supported' only through a registered capability; otherwise the
    // type's explicit decision ('manual' or 'unknown') stands for the operation.
    decision: supported ? 'supported' : decision.decision === 'automated' ? 'unsupported' : decision.decision,
    claim: capability.claim,
    credentialMode: capability.credentialMode,
    idOutcome: capability.idOutcome,
    idempotency: supported ? IDEMPOTENCY[operation] : null,
    remapping,
    fieldClassification: reviewStateFor(resourceType),
    fixture: capability.claim === 'fixture-tested' || capability.claim === 'live-qualified'
      ? { result: 'passed', proofRef: capability.claim === 'fixture-tested' ? capability.proofRef : null }
      : { result: 'none', proofRef: null },
    live: capability.claim === 'live-qualified' ? { result: 'qualified', proofRef: capability.proofRef } : { result: 'none', proofRef: null },
    softRestoreCandidate: operation === 'restore-soft-deleted' && decision.softRestoreCandidate === true && !supported,
  });
}

/**
 * The full ledger: every catalogue type (and every collecting descriptor) ×
 * OPERATIONS, plus the registered relationship edge operations. Throws when
 * any type lacks an explicit decision.
 */
export function buildOperationLedger({ decisions = TYPE_DECISIONS } = {}) {
  const types = [...new Set([...CATALOG.map((entry) => entry.type), ...DESCRIPTORS.map((descriptor) => descriptor.type)])];
  const missing = types.filter((type) => !decisions[type]);
  if (missing.length > 0) throw new Error(`no explicit qualification decision for: ${missing.join(', ')}`);
  for (const [type, decision] of Object.entries(decisions)) {
    if (!TYPE_DECISION_VALUES.includes(decision.decision)) throw new Error(`${type}: invalid decision ${decision.decision}`);
  }

  const rows = types.map((type) => {
    const decision = decisions[type];
    const operations = OPERATIONS.map((operation) => rowFor(type, operation, { decision }));
    if (decision.decision === 'automated') {
      // A type marked automated must actually have at least one registered
      // operation; the label alone proves nothing.
      if (!operations.some((row) => row.decision === 'supported')) {
        throw new Error(`${type} is marked automated but has no registered write capability`);
      }
    } else if (operations.some((row) => row.decision === 'supported')) {
      throw new Error(`${type} has a registered write capability but is marked ${decision.decision}`);
    }
    return Object.freeze({
      resourceType: type,
      decision: decision.decision,
      reason: decision.reason,
      softRestoreCandidate: decision.softRestoreCandidate === true,
      source: sourceFor(type, decision),
      operations: Object.freeze(operations),
    });
  });

  const edges = ['member', 'owner'].flatMap((family) => EDGE_OPERATIONS.map((operation) => rowFor('group', operation, {
    capabilityKey: edgeCapabilityKey('group', family), decision: decisions.group,
  })));

  return Object.freeze({ contractVersion: LEDGER_CONTRACT_VERSION, types: Object.freeze(rows), edges: Object.freeze(edges) });
}

/** The compact per-type decision the coverage report and portal show. */
export function qualificationFor(resourceType, { decisions = TYPE_DECISIONS } = {}) {
  const decision = decisions[resourceType];
  if (!decision) return Object.freeze({ decision: 'unknown', reason: 'no explicit decision recorded', softRestoreCandidate: false, remapping: {} });
  const remapping = {};
  for (const operation of REWRITES_REFERENCES) {
    if (isSupportedClaim(capabilityFor(resourceType, operation).claim)) remapping[operation] = remappingFor(resourceType, operation).qualified;
  }
  return Object.freeze({
    decision: decision.decision,
    reason: decision.reason,
    softRestoreCandidate: decision.softRestoreCandidate === true,
    remapping: Object.freeze(remapping),
  });
}
