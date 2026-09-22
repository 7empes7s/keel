import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';

/** Spec M2.4. desired/live are { payloadHash } or null; softDeleted is a boolean.
 * Returns one of: 'create' | 'update' | 'noop' | 'delete' | 'restore-soft-deleted'. */
export function decideVerb({ desired, live, softDeleted }) {
  const isPresent = (state) => state !== null
    && typeof state === 'object'
    && !Array.isArray(state)
    && typeof state.payloadHash === 'string';

  if (desired !== null && !isPresent(desired)) {
    throw new Error('Unrecognised desired state: expected { payloadHash } or null');
  }
  if (live !== null && !isPresent(live)) {
    throw new Error('Unrecognised live state: expected { payloadHash } or null');
  }
  if (typeof softDeleted !== 'boolean') {
    throw new Error('Unrecognised softDeleted state: expected a boolean');
  }

  if (isPresent(desired) && live === null && softDeleted === true) {
    return {
      verb: 'restore-soft-deleted',
      reason: `desired present: baseline ${desired.payloadHash}; live absent; soft-deleted`,
    };
  }
  if (isPresent(desired) && live === null && softDeleted === false) {
    return {
      verb: 'create',
      reason: `desired present: baseline ${desired.payloadHash}; live absent; not soft-deleted`,
    };
  }
  if (isPresent(desired) && isPresent(live) && desired.payloadHash !== live.payloadHash) {
    return {
      verb: 'update',
      reason: `hash differs: baseline ${desired.payloadHash} vs live ${live.payloadHash}`,
    };
  }
  if (isPresent(desired) && isPresent(live) && desired.payloadHash === live.payloadHash) {
    return {
      verb: 'noop',
      reason: `hash equal: baseline ${desired.payloadHash} vs live ${live.payloadHash}`,
    };
  }
  if (desired === null && isPresent(live)) {
    return {
      verb: 'delete',
      reason: `desired absent; live present: live ${live.payloadHash}`,
    };
  }
  if (desired === null && live === null) {
    return {
      verb: 'noop',
      reason: 'desired absent; live absent',
    };
  }

  throw new Error('Unrecognised desired/live/softDeleted combination');
}

/**
 * Fail-closed capability gate ahead of any writer call (roadmap task-52).
 * decideVerb() above answers "what does the diff require"; this answers
 * "can applyWave actually perform that verb for this resourceType" — two
 * independent questions that must never be merged into one function. An
 * unregistered (resourceType, verb) pair is refused here, before
 * applyEngine.mjs's deletion/sync guards, rollback journal or writer ever
 * run for that resource.
 */
export function verbCapability(resourceType, verb) {
  if (verb === 'noop') return { supported: true, capability: null };
  const capability = capabilityFor(resourceType, verb);
  return { supported: isSupportedClaim(capability.claim), capability };
}
