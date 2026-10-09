/**
 * Roadmap task-64: choose how each restore resource is recovered.
 *
 * decideVerb() answers what the diff requires (create / update / restore /
 * delete / noop). This module answers HOW that verb may be carried out, given
 * qualified capability, retention evidence and the outcome of every lookup that
 * could change the answer:
 *
 *   none                — nothing to do
 *   update-existing     — PATCH the object in place; the target id is retained
 *   soft-delete-restore — restore from deleted items; the id is retained, but
 *                         only until the retention deadline
 *   recreate            — create a new object; a new id is assigned
 *   delete              — remove the object (not a recovery, recorded for completeness)
 *   manual              — hand off to an operator, with the reason and a source link
 *   refused             — no mechanism may run (lookup failed, recovery point
 *                         expired, deadline unprovable)
 *
 * Two rules are non-negotiable:
 *  - A lookup that FAILED is never treated as "not found". If KEEL cannot
 *    prove an object is not soft-deleted (or held by a native recovery route),
 *    it never recreates it: a recreated twin would silently orphan the
 *    original's id and every reference to it.
 *  - An expired or unprovable retention deadline refuses soft-delete restore,
 *    at planning and again at execution (applyWave re-checks the deadline).
 *
 * The chosen mechanism is persisted in the dry-run artifact and folded into the
 * plan digest, so a mechanism that changes between review and promotion
 * invalidates the approval.
 */
import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';

/** Entra keeps deleted users, groups, applications and Conditional Access
 * policies for 30 days (the Conditional Access figure is a declaration to
 * confirm before live qualification, roadmap task-152). */
export const SOFT_DELETE_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const RECOVERY_MECHANISMS = Object.freeze([
  'none', 'update-existing', 'soft-delete-restore', 'recreate', 'delete', 'manual', 'refused',
]);

/** Mechanisms applyWave may execute; anything else is skipped before any write. */
export const EXECUTABLE_MECHANISMS = Object.freeze(new Set(['none', 'update-existing', 'soft-delete-restore', 'recreate', 'delete']));

const VERB_FOR_MECHANISM = Object.freeze({
  'update-existing': 'update',
  'soft-delete-restore': 'restore-soft-deleted',
  recreate: 'create',
  delete: 'delete',
  none: 'noop',
});

/**
 * Native (Microsoft-hosted) recovery routes that could recover an object
 * without recreating it. None is credential-qualified for KEEL, so a resource
 * that a native lookup reports as recoverable through one of these is a manual
 * handoff, never an automated recreate. Routes are named placeholders, not
 * capabilities: their Graph endpoints, API version, retention and permissions
 * must be checked against current Microsoft documentation (and credential-
 * qualified) before any route can be marked qualified. `docs` stays null until
 * that check is recorded — see docs/roadmap/native-recovery.md.
 *
 * Roadmap task-152: Conditional Access policies left this table. Their deleted
 * items are now read by the reconciliation plan itself (liveState.mjs) and
 * restored through the registered, fixture-tested restore-soft-deleted
 * operation, so a deleted policy is a soft-delete restore, not a handoff.
 */
export const NATIVE_RECOVERY_ROUTES = Object.freeze({
  namedLocation: Object.freeze({
    route: 'conditional-access-deleted-named-locations',
    docs: null,
    qualified: false,
    reason: 'named location recovery from deleted items is not credential-qualified for KEEL',
  }),
});

/** Deadline for a soft-deleted object, from Graph's deletedDateTime. Null when unprovable. */
export function softDeleteDeadline(payload, { retentionDays = SOFT_DELETE_RETENTION_DAYS } = {}) {
  const deletedAt = Date.parse(payload?.deletedDateTime ?? '');
  if (Number.isNaN(deletedAt)) return null;
  return new Date(deletedAt + retentionDays * DAY_MS).toISOString();
}

function capability(resourceType, verb) {
  const record = capabilityFor(resourceType, verb);
  return { supported: isSupportedClaim(record.claim), record };
}

function decision(resource, mechanism, fields) {
  return Object.freeze({
    naturalKey: resource.naturalKey,
    resourceType: resource.resourceType,
    mechanism,
    verb: VERB_FOR_MECHANISM[mechanism] ?? resource.verb ?? null,
    idOutcome: 'none',
    retainedId: null,
    deadline: null,
    credentialMode: null,
    proofRef: null,
    docs: null,
    reason: null,
    ...fields,
  });
}

/**
 * Selects the mechanism for one reconciled resource.
 *
 * - `resource`: { naturalKey, resourceType, verb, live } from buildReconciliationPlan.
 * - `deletedLookup`: 'ok' | 'failed' | 'not-applicable' — the deleted-items read
 *   for this resource's type.
 * - `nativeLookup`: optional { state: 'found' | 'not-found' | 'failed' } from a
 *   native recovery route; absent when no route was consulted.
 */
export function selectRecoveryMechanism(resource, { deletedLookup = 'not-applicable', nativeLookup = null, now = new Date() } = {}) {
  const verb = resource.verb;
  if (verb === 'noop') return decision(resource, 'none', {});

  const { supported, record } = capability(resource.resourceType, verb);
  const proven = { credentialMode: record.credentialMode, proofRef: record.proofRef };
  // An unregistered verb keeps applyWave's own fail-closed capability refusal;
  // the mechanism only says no automated route exists.
  if (!supported) {
    return decision(resource, 'manual', { reason: `${resource.resourceType} ${verb} has no qualified capability (claim: ${record.claim})` });
  }

  if (verb === 'update') {
    return decision(resource, 'update-existing', { ...proven, idOutcome: 'retained', retainedId: resource.live?.targetId ?? resource.targetId ?? null });
  }
  if (verb === 'delete') {
    return decision(resource, 'delete', { ...proven, idOutcome: 'terminal', retainedId: resource.live?.targetId ?? resource.targetId ?? null });
  }
  if (verb === 'restore-soft-deleted') {
    const deadline = softDeleteDeadline(resource.live?.payload);
    if (!deadline) {
      return decision(resource, 'refused', { reason: 'soft-delete retention deadline is unprovable (no deletedDateTime) — restore refused, and the object is never recreated beside its deleted original' });
    }
    if (Date.parse(deadline) <= now.getTime()) {
      return decision(resource, 'refused', { deadline, reason: `recovery-point-expired: the soft-deleted object passed its retention deadline ${deadline}` });
    }
    return decision(resource, 'soft-delete-restore', {
      ...proven, idOutcome: 'retained', retainedId: resource.live?.deletedItemId ?? resource.deletedItemId ?? null, deadline,
    });
  }

  // verb === 'create': the object was not found live. Only a lookup that
  // SUCCEEDED can prove there is nothing better than a recreate.
  if (deletedLookup === 'failed') {
    return decision(resource, 'refused', {
      reason: `lookup-failed: the deleted-items read for ${resource.resourceType} failed, so a soft-deleted original cannot be ruled out — recreation refused`,
    });
  }
  if (nativeLookup) {
    const route = NATIVE_RECOVERY_ROUTES[resource.resourceType] ?? null;
    if (nativeLookup.state === 'failed') {
      return decision(resource, 'refused', { docs: route?.docs ?? null, reason: 'lookup-failed: the native recovery lookup failed — recreation refused' });
    }
    if (nativeLookup.state === 'found') {
      if (!route?.qualified) {
        return decision(resource, 'manual', { docs: route?.docs ?? null, reason: route?.reason ?? 'the native recovery route is not qualified' });
      }
    }
  }
  return decision(resource, 'recreate', { ...proven, idOutcome: 'new' });
}

/**
 * The execution-time gate applyWave calls when a resource carries a mechanism.
 * Returns null when the write may proceed, or { outcome: 'skipped' | 'failed', reason }.
 */
export function recoveryGate(resource, { now = new Date() } = {}) {
  const recovery = resource.recovery;
  if (!recovery) return null; // a caller that predates task-64: unchanged behaviour
  if (!EXECUTABLE_MECHANISMS.has(recovery.mechanism)) {
    return { outcome: 'skipped', reason: `${recovery.mechanism}: ${recovery.reason ?? 'no automated recovery mechanism'}` };
  }
  const expectedVerb = VERB_FOR_MECHANISM[recovery.mechanism];
  const actualVerb = resource.verb ?? 'create';
  if (expectedVerb !== actualVerb) {
    return { outcome: 'failed', reason: `mechanism-mismatch: planned ${recovery.mechanism} cannot execute verb ${actualVerb}` };
  }
  if (recovery.mechanism === 'soft-delete-restore') {
    const deadline = Date.parse(recovery.deadline ?? '');
    if (Number.isNaN(deadline)) return { outcome: 'skipped', reason: 'soft-delete retention deadline is unprovable — restore refused' };
    if (deadline <= now.getTime()) {
      return { outcome: 'skipped', reason: `recovery-point-expired: the soft-deleted object passed its retention deadline ${recovery.deadline}` };
    }
  }
  return null;
}

/** The plan-bound projection of a mechanism (persisted and digested). */
export function planMechanism(recovery) {
  return {
    naturalKey: recovery.naturalKey,
    mechanism: recovery.mechanism,
    verb: recovery.verb,
    idOutcome: recovery.idOutcome,
    retainedId: recovery.retainedId,
    deadline: recovery.deadline,
    credentialMode: recovery.credentialMode,
    proofRef: recovery.proofRef,
    docs: recovery.docs,
    reason: recovery.reason,
  };
}
