/**
 * Roadmap task-108: bounded policy configuration restore qualification.
 *
 * The policy batch (engine/coverage/qualification.mjs's EXPANSION_BATCHES)
 * gets its first qualified operations here: create and update of CUSTOM
 * authentication strengths. Each is an explicit operation record bound to
 *
 *  - one subtype ('custom'). A built-in strength is Microsoft-owned and
 *    immutable: every write to it is refused before the journal or the writer
 *    runs. Any other or missing subtype has no proof and is refused too;
 *  - one field projection. The record carries a digest of the type's reviewed
 *    known fields, immutable and server-owned sets, create exclusions and its
 *    own writable fields. When any of those change, the digest no longer
 *    matches, the proof is invalidated and every write of that operation is
 *    refused until the proof is re-established and the digest re-recorded;
 *  - an explicit writable-field allowlist. Unknown fields (anything Graph
 *    returns that the projection has not reviewed) are never sent: a create
 *    drops and reports them, an update body that would carry one is refused.
 *
 * The capability registry (capabilities.mjs) holds the claim; this module never
 * raises one. qualifyPolicyLiveEvidence() is the explicit live gate: it accepts
 * evidence only for the record's subtype and current projection digest, then
 * defers to capabilities.mjs's qualifyLiveEvidence(). Nothing calls it today.
 *
 * Documentation note: learn.microsoft.com is not reachable from the build
 * container, so the routes and fields below are declarations to confirm against
 * the current Graph v1.0 reference before any live qualification (Global
 * Constraint 8; see docs/roadmap/policy-fidelity.md).
 */
import { createHash } from 'node:crypto';

import { IMMUTABLE, SERVER_OWNED, SERVER_OWNED_ALWAYS } from '../cir/serverOwned.mjs';
import { knownFieldsFor } from '../contracts/fieldProjection.mjs';
import { capabilityFor, isSupportedClaim, qualifyLiveEvidence } from '../coverage/capabilities.mjs';
import { CREATE_EXCLUDED_FIELDS, EXPANSION_BATCHES, buildExpansionInventory } from '../coverage/qualification.mjs';
import { createProjection } from '../reconcile/writableProjection.mjs';

export const POLICY_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';

/**
 * Microsoft-global ids of the three built-in authentication strengths (also
 * WELL_KNOWN in tools/tenant-probe/references.mjs). A payload or target with
 * one of these ids is built-in whatever its policyType says.
 */
export const BUILT_IN_AUTHENTICATION_STRENGTH_IDS = Object.freeze([
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
]);

/**
 * The operation records (at most three, per the task). `projectionDigest` is
 * the digest projectionDigestFor() computed when the fixture proof was
 * established; tests assert it still matches. Changing the projection means
 * re-proving the operation and recording the new digest here — never editing
 * the digest alone.
 */
export const POLICY_OPERATION_RECORDS = Object.freeze([
  Object.freeze({
    resourceType: 'authenticationStrengthPolicy',
    operation: 'create',
    subtype: 'custom',
    route: 'POST /policies/authenticationStrengthPolicies',
    permission: 'Policy.ReadWrite.ConditionalAccess',
    docs: `${DOCS}/authenticationstrengthroot-post-policies?view=graph-rest-1.0`,
    writableFields: Object.freeze(['allowedCombinations', 'description', 'displayName']),
    projectionDigest: '139a42f356f269da9bfe2c9a32db4b06e80f8d10c91455027e76ad73ee874392',
    proofRef: 'engine/roadmap/policy-fidelity.test.mjs',
  }),
  Object.freeze({
    resourceType: 'authenticationStrengthPolicy',
    operation: 'update',
    subtype: 'custom',
    route: 'PATCH /policies/authenticationStrengthPolicies/{id}',
    permission: 'Policy.ReadWrite.ConditionalAccess',
    docs: `${DOCS}/authenticationstrengthpolicy-update?view=graph-rest-1.0`,
    // allowedCombinations changes only through the updateAllowedCombinations
    // action, which is not qualified: its drift is reported not remediable.
    writableFields: Object.freeze(['description', 'displayName']),
    projectionDigest: 'b126d843744d9b39ec5830943e9c14a4899bbe4e0daea767e80854d3c6094879',
    proofRef: 'engine/roadmap/policy-fidelity.test.mjs',
  }),
]);

const POLICY_TYPES = new Set(POLICY_OPERATION_RECORDS.map((record) => record.resourceType));

/** True when writes of this type go through the policy operation records. */
export function isPolicyGoverned(resourceType) {
  return POLICY_TYPES.has(resourceType);
}

/** 'builtIn', 'custom' or 'unknown' — never guessed from a display name. */
export function policySubtypeOf(resourceType, payload, id = null) {
  if (resourceType !== 'authenticationStrengthPolicy') return 'unknown';
  const ids = [id, payload?.id].filter((value) => typeof value === 'string');
  if (ids.some((value) => BUILT_IN_AUTHENTICATION_STRENGTH_IDS.includes(value.toLowerCase()))) return 'builtIn';
  if (payload?.policyType === 'builtIn') return 'builtIn';
  if (payload?.policyType === 'custom') return 'custom';
  return 'unknown';
}

const sorted = (values) => [...(values ?? [])].sort();

/**
 * The digest of everything that decides what a write of this record sends and
 * verifies. Any change to the type's reviewed projection or to the record's
 * subtype or writable fields yields a different digest.
 */
export function projectionDigestFor(record, { projection = currentProjection(record.resourceType) } = {}) {
  const material = JSON.stringify({
    contract: POLICY_OPERATIONS_CONTRACT_VERSION,
    resourceType: record.resourceType,
    operation: record.operation,
    subtype: record.subtype,
    writableFields: sorted(record.writableFields),
    ...projection,
  });
  return createHash('sha256').update(material).digest('hex');
}

/** The projection inputs as they are now, from the single sources of truth. */
export function currentProjection(resourceType) {
  return {
    knownFields: sorted(knownFieldsFor(resourceType)),
    immutable: sorted(IMMUTABLE.get(resourceType)),
    serverOwned: sorted([...(SERVER_OWNED.get(resourceType) ?? []), ...SERVER_OWNED_ALWAYS]),
    createExcluded: sorted(CREATE_EXCLUDED_FIELDS[resourceType]),
  };
}

/**
 * Whether a proof exists for exactly (resourceType, operation, subtype) under
 * the current projection. `projection` is injectable so a test can show that a
 * changed projection invalidates the proof without editing source.
 */
export function policyProofFor(resourceType, operation, subtype, options = {}) {
  const record = POLICY_OPERATION_RECORDS.find((candidate) => candidate.resourceType === resourceType
    && candidate.operation === operation && candidate.subtype === subtype) ?? null;
  if (!record) {
    return Object.freeze({ valid: false, record: null, reason: `no proof covers ${resourceType} ${operation} for subtype '${subtype}'` });
  }
  const capability = capabilityFor(resourceType, operation);
  if (!isSupportedClaim(capability.claim) || capability.subtype !== subtype) {
    return Object.freeze({ valid: false, record, reason: `${resourceType} ${operation} is not registered for subtype '${subtype}'` });
  }
  const digest = projectionDigestFor(record, options);
  if (digest !== record.projectionDigest) {
    return Object.freeze({
      valid: false, record,
      reason: `proof invalidated: the ${resourceType} field projection changed since ${operation} was proven (digest ${digest.slice(0, 12)}, proven ${record.projectionDigest.slice(0, 12)})`,
    });
  }
  return Object.freeze({ valid: true, record, reason: null });
}

/**
 * The write-time gate applyWave runs for a policy-governed type, after the
 * capability gate and before any guard, journal or writer call. Returns null
 * when the write may proceed, otherwise { outcome, reason }: a built-in policy
 * is 'skipped' (nobody can write it; it never halts a run), every other refusal
 * is 'failed' (the write is unproven).
 */
export function policyWriteRefusal(resource, verb, options = {}) {
  if (!isPolicyGoverned(resource.resourceType)) return null;
  const targetId = resource.targetId ?? resource.live?.targetId ?? null;
  const desired = policySubtypeOf(resource.resourceType, resource.payload, verb === 'create' ? null : targetId);
  const live = resource.live?.payload ? policySubtypeOf(resource.resourceType, resource.live.payload, targetId) : null;
  if (desired === 'builtIn' || live === 'builtIn') {
    return {
      outcome: 'skipped',
      reason: `immutable built-in policy: ${resource.resourceType} ${resource.naturalKey} is Microsoft-owned and is never written`,
    };
  }
  if (live !== null && live !== desired) {
    return { outcome: 'failed', reason: `subtype change refused: the target is '${live}' and the snapshot is '${desired}'` };
  }
  const proof = policyProofFor(resource.resourceType, verb, desired, options);
  if (!proof.valid) return { outcome: 'failed', reason: proof.reason };
  return null;
}

/**
 * The create body for a policy-governed type: the record's writable fields
 * only. `unknown` names the top-level fields the reviewed projection does not
 * know; they are never sent and the caller reports them.
 */
export function policyCreateBody(resourceType, payload) {
  const record = POLICY_OPERATION_RECORDS.find((candidate) => candidate.resourceType === resourceType && candidate.operation === 'create');
  if (!record) throw new Error(`${resourceType}: no policy create record`);
  const { body, unknown } = createProjection(payload, resourceType);
  const allowed = {};
  for (const field of record.writableFields) if (Object.hasOwn(body, field)) allowed[field] = body[field];
  return { body: allowed, unknown };
}

/**
 * Refuses an update body that carries anything beyond the record's writable
 * fields. writableProjection() already drops unknown, immutable and
 * server-owned fields; this is the independent check at the writer boundary.
 */
export function policyPatchRefusal(resourceType, body) {
  const record = POLICY_OPERATION_RECORDS.find((candidate) => candidate.resourceType === resourceType && candidate.operation === 'update');
  if (!record) return `${resourceType}: no policy update record`;
  const extra = Object.keys(body ?? {}).filter((field) => !record.writableFields.includes(field));
  return extra.length > 0 ? `refusing to PATCH ${resourceType}: ${extra.join(', ')} outside the proven writable fields` : null;
}

/** After a create, the object must read back as the proven subtype. */
export function policyPostCreateRefusal(resource, live) {
  if (!isPolicyGoverned(resource.resourceType)) return null;
  const subtype = policySubtypeOf(resource.resourceType, live);
  return subtype === 'custom' ? null : `created ${resource.resourceType} read back as subtype '${subtype}', not 'custom'`;
}

/**
 * The explicit live qualification gate for a policy operation. Evidence must
 * name the record's subtype and the CURRENT projection digest, and that digest
 * must still be the proven one; only then is capabilities.mjs's own gate
 * (tenant, freshness, non-synthetic, contract version) consulted.
 */
export function qualifyPolicyLiveEvidence(resourceType, operation, evidence, { tenantRef, now = new Date(), subtype = 'custom' } = {}) {
  const proof = policyProofFor(resourceType, operation, subtype);
  const failures = [];
  if (!proof.valid) failures.push(proof.reason);
  if (evidence?.subtype !== subtype) failures.push(`evidence is for subtype '${evidence?.subtype}', required '${subtype}'`);
  if (proof.record && evidence?.projectionDigest !== proof.record.projectionDigest) {
    failures.push('evidence was taken under a different field projection');
  }
  if (failures.length > 0) return { promoted: false, claim: capabilityFor(resourceType, operation).claim, failures };
  return qualifyLiveEvidence(resourceType, operation, evidence, { tenantRef, now });
}

/**
 * The policy family ledger: every type in the policy batch with its status,
 * the operation records that are qualified (subtype, route, writable fields,
 * whether the proof is current), the subtypes that are refused and why the
 * rest remains manual or research-needed.
 */
export function buildPolicyFamilyLedger() {
  const batch = buildExpansionInventory().batches.find((candidate) => candidate.id === 'policy');
  const label = EXPANSION_BATCHES.find((candidate) => candidate.id === 'policy').label;
  return Object.freeze({
    contractVersion: POLICY_OPERATIONS_CONTRACT_VERSION,
    batch: 'policy',
    label,
    families: Object.freeze(batch.types.map((entry) => {
      const records = POLICY_OPERATION_RECORDS.filter((record) => record.resourceType === entry.resourceType);
      return Object.freeze({
        resourceType: entry.resourceType,
        status: entry.status,
        restoreScope: entry.restoreScope,
        supportedOperations: entry.supportedOperations,
        operations: Object.freeze(records.map((record) => Object.freeze({
          operation: record.operation,
          subtype: record.subtype,
          route: record.route,
          permission: record.permission,
          writableFields: record.writableFields,
          proofCurrent: policyProofFor(record.resourceType, record.operation, record.subtype).valid,
          claim: capabilityFor(record.resourceType, record.operation).claim,
        }))),
        refusedSubtypes: entry.resourceType === 'authenticationStrengthPolicy' ? Object.freeze(['builtIn']) : Object.freeze([]),
        api: entry.api,
        permission: entry.permission,
        reason: entry.reason,
      });
    })),
  });
}
