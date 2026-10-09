/**
 * Roadmap task-152: turning a restored Conditional Access policy back on.
 *
 * Every automated Conditional Access write lands report-only
 * (engine/safety/conditionalAccessGuard.mjs). That keeps a restore from locking
 * anyone out, but a restored MFA or block policy then protects nobody. So:
 *
 *  1. A restore that leaves a policy report-only while the snapshot had it
 *     `enabled` lists that as a pending step (pendingEnforcementSteps) and, when
 *     enforced, as an `enforcement` completion item (completion.mjs).
 *  2. Turning it on is a separate step with its own immutable dry run, promoted
 *     through the normal restore approval (cli/keel-restore.mjs
 *     --enforce-conditional-access). It writes only when:
 *       - the restore it follows left an open enforcement item for the policy;
 *       - the snapshot had the policy `enabled` and it is report-only now;
 *       - the break-glass lockout gate (engine/safety/lockoutGate.mjs) finds
 *         every break-glass account still ready with this policy turned on;
 *       - an approver other than the requester approved the dry run.
 *  3. The write is journaled, sends `state` only, and is read back. The sign-in
 *     path is compared before and after: anything beyond this one policy's state
 *     turns the policy back to report-only and fails the step.
 *
 * Pure planning plus one writer path; it never decides on its own to enforce.
 */
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { graphPathFor } from '../coverage/capabilities.mjs';
import { verbCapability } from '../reconcile/verb.mjs';
import { enforceReportOnly } from '../safety/conditionalAccessGuard.mjs';
import { compareSignInPaths, snapshotSignInPath } from '../safety/signInPathGate.mjs';
import { classifyWriteOutcome, recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';

export const REPORT_ONLY = 'enabledForReportingButNotEnforced';
export const ENFORCED = 'enabled';
export const ENFORCEMENT_STEP = 'turn-on-conditional-access-policy';
const RESOURCE_TYPE = 'conditionalAccessPolicy';
const POLICIES_PATH = '/identity/conditionalAccess/policies';
// Verbs whose write forces the policy report-only (applyEngine.mjs).
const WRITTEN_VERBS = new Set(['create', 'update', 'restore-soft-deleted']);

export class EnforcementRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnforcementRefusal';
  }
}

/** True when this planned resource is a Conditional Access policy the snapshot had
 * turned on and the restore writes (so it lands report-only). */
export function enforcementPendingFor(resource) {
  return resource?.resourceType === RESOURCE_TYPE
    && resource.payload?.state === ENFORCED
    && WRITTEN_VERBS.has(resource.verb ?? 'create');
}

/** The pending steps a run leaves: one per applied policy that was enabled in the snapshot. */
export function pendingEnforcementSteps(resources, applied) {
  const appliedKeys = new Set((applied ?? []).map((entry) => entry.naturalKey));
  return (resources ?? [])
    .filter((resource) => appliedKeys.has(resource.naturalKey) && enforcementPendingFor(resource))
    .map((resource) => ({
      naturalKey: resource.naturalKey,
      resourceType: RESOURCE_TYPE,
      step: ENFORCEMENT_STEP,
      snapshotState: ENFORCED,
      restoredState: REPORT_ONLY,
      description: 'Left in report-only mode; the backup had this policy turned on. Turning it on is a separate, approved step that first checks break-glass access.',
    }))
    .sort((left, right) => left.naturalKey.localeCompare(right.naturalKey));
}

const withState = (payload, state) => ({ ...(payload ?? {}), state });

/** The live policy's hash with its state set aside: what must not change when it is turned on. */
export function policyBodyHash(payload) {
  return canonicalHash(withState(payload, REPORT_ONLY), RESOURCE_TYPE);
}

/**
 * Plans turning one policy on. Throws EnforcementRefusal with the reason when
 * the step does not apply. `pendingItem` is the restore's enforcement completion
 * item ({ id, state }) or null, `snapshotPayload` the policy as the snapshot
 * held it, `live` the target's current policy ({ targetId, payload }) or null.
 */
export function planConditionalAccessEnforcement({ restoreRef, naturalKey, pendingItem, snapshotPayload, live }) {
  if (typeof naturalKey !== 'string' || !naturalKey.startsWith(`${RESOURCE_TYPE}:`)) {
    throw new EnforcementRefusal(`${naturalKey} is not a Conditional Access policy`);
  }
  if (!pendingItem) {
    throw new EnforcementRefusal(`restore ${restoreRef} left no enforcement step for ${naturalKey}: it did not restore this policy report-only from an enabled backup`);
  }
  if (pendingItem.state !== 'pending') {
    throw new EnforcementRefusal(`the enforcement step for ${naturalKey} is already closed`);
  }
  if (snapshotPayload?.state !== ENFORCED) {
    throw new EnforcementRefusal(`the backup did not have ${naturalKey} turned on (state ${snapshotPayload?.state ?? 'unknown'}), so KEEL does not turn it on`);
  }
  if (!live?.targetId || !live.payload) {
    throw new EnforcementRefusal(`${naturalKey} is not in the target tenant`);
  }
  const state = live.payload.state;
  if (state === ENFORCED) throw new EnforcementRefusal(`${naturalKey} is already turned on`);
  if (state !== REPORT_ONLY) {
    throw new EnforcementRefusal(`${naturalKey} is ${state ?? 'in an unreadable state'} now, not report-only: someone changed it after the restore, and KEEL turns on only a policy its restore left report-only`);
  }
  return Object.freeze({
    promotes: restoreRef,
    naturalKey,
    resourceType: RESOURCE_TYPE,
    targetId: live.targetId,
    fromState: REPORT_ONLY,
    toState: ENFORCED,
    policyHash: policyBodyHash(live.payload),
    completionItemId: pendingItem.id ?? null,
  });
}

/** The lockout gate's verdict on this policy turned on. No gate is a refusal. */
export function evaluateEnforcementGate(lockoutGate, { naturalKey, livePayload }) {
  if (!lockoutGate) return { allowed: false, reason: 'no break-glass lockout gate was available' };
  return lockoutGate.evaluate({ resourceType: RESOURCE_TYPE, naturalKey, desired: withState(livePayload, ENFORCED) });
}

/** A reader that keeps what it read, so the sign-in path can be replayed with one change. */
function recordingReader(reader) {
  const seen = new Map();
  return {
    reader: {
      async collect(version, path) {
        const result = await reader.collect(version, path);
        seen.set(`collect ${path}`, result);
        return result;
      },
      async get(version, path) {
        const result = await reader.get(version, path);
        seen.set(`get ${path}`, result);
        return result;
      },
    },
    /** The recorded reads, with the policy's state as intended. */
    expected(targetId) {
      return {
        async collect(_version, path) {
          const result = structuredClone(seen.get(`collect ${path}`));
          if (path !== POLICIES_PATH || !Array.isArray(result?.items)) return result;
          return { ...result, items: result.items.map((item) => (item?.id === targetId ? withState(item, ENFORCED) : item)) };
        },
        async get(_version, path) {
          return structuredClone(seen.get(`get ${path}`));
        },
      };
    },
  };
}

async function readBack(writer, path, { attempts, delayMs, isStale }) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await writer.read('v1.0', path);
    if (!isStale(result)) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/**
 * Turns the planned policy on (or, in a dry run, evaluates every gate and
 * writes nothing). Returns { applied, skipped, failed } like applyWave.
 *
 * - `live`: the target's current policy ({ targetId, payload }), read for this run.
 * - `approval`: { approvedBy, reason } from the approved request; required to write.
 * - `signInPathGate`: { reader, protectedPrincipalIds } (Collector credential).
 */
export async function applyConditionalAccessEnforcement(writer, plan, {
  mode,
  live,
  lockoutGate,
  approval = null,
  signInPathGate = null,
  rollbackClient = null,
  runId = null,
  restoreRef = null,
  readAttempts = 6,
  readDelayMs = 3000,
}) {
  const result = { applied: [], skipped: [], failed: [] };
  const { naturalKey } = plan;
  const fail = (error) => { result.failed.push({ naturalKey, error }); return result; };

  if (!verbCapability(RESOURCE_TYPE, 'update').supported) return fail('unsupported operation: conditionalAccessPolicy update is not a registered write capability');
  if (live?.targetId !== plan.targetId || policyBodyHash(live?.payload) !== plan.policyHash || live?.payload?.state !== REPORT_ONLY) {
    return fail('the policy changed since this step was planned — plan it again');
  }
  const gate = evaluateEnforcementGate(lockoutGate, { naturalKey, livePayload: live.payload });
  if (!gate.allowed) {
    result.skipped.push({ naturalKey, reason: `break-glass lockout gate: ${gate.reason}` });
    return result;
  }
  if (mode === 'dry-run') {
    result.applied.push({ naturalKey, targetId: plan.targetId, change: `state ${REPORT_ONLY} -> ${ENFORCED}` });
    return result;
  }
  if (mode !== 'enforce') return fail(`unknown mode ${mode}`);
  if (typeof approval?.approvedBy !== 'string' || !approval.approvedBy) {
    return fail('turning a Conditional Access policy on requires an approved request, and none was found');
  }
  if (!signInPathGate?.reader) return fail('turning a Conditional Access policy on requires the sign-in path gate');

  // The one place this module sets `state`: the guard's signed override.
  const body = enforceReportOnly({ state: ENFORCED }, { override: { reason: approval.reason ?? `approved: turn on ${naturalKey}`, signedBy: approval.approvedBy } });
  const path = `${graphPathFor(RESOURCE_TYPE)}/${encodeURIComponent(plan.targetId)}`;

  // Read (and keep) the sign-in path before the write; it is replayed below with
  // only this policy turned on, as the expected state after the write.
  const recorder = recordingReader(signInPathGate.reader);
  await snapshotSignInPath(recorder.reader, { protectedPrincipalIds: signInPathGate.protectedPrincipalIds });

  let entryId = null;
  if (rollbackClient) {
    try {
      entryId = await recordPriorState(rollbackClient, {
        runId, naturalKey, priorState: live.payload, restoreRef, resourceType: RESOURCE_TYPE, operation: 'update',
        targetId: plan.targetId, blastRadius: 'tenant-lockout', intendedState: withState(live.payload, ENFORCED),
      });
    } catch {
      return fail('refusing to turn the policy on: rollback journal write failed');
    }
  }
  const note = async (outcome, extras = {}) => {
    if (!rollbackClient || !entryId) return;
    try { await recordWriteOutcome(rollbackClient, { entryId, outcome, ...extras }); } catch { /* left pending */ }
  };

  const written = await writer.write('v1.0', path, { method: 'PATCH', body });
  if (!written?.ok) {
    await note(classifyWriteOutcome(written), { detail: `status ${written?.status ?? 'none'}` });
    return fail(`Graph refused the change: ${JSON.stringify(written?.body ?? written?.error ?? null)}`);
  }

  const reRead = await readBack(writer, path, {
    attempts: readAttempts, delayMs: readDelayMs,
    isStale: (r) => r?.ok === false ? r.status === 404 : r?.body?.state !== ENFORCED,
  });
  const after = reRead?.ok ? reRead.body : null;
  if (!after || after.state !== ENFORCED || policyBodyHash(after) !== plan.policyHash) {
    await note('uncertain', { postState: after, detail: 'turned on, but the read-back did not verify' });
    return fail('the policy did not read back as turned on with nothing else changed');
  }

  // Only this policy's state may differ in the sign-in path.
  const expected = await snapshotSignInPath(recorder.expected(plan.targetId), { protectedPrincipalIds: signInPathGate.protectedPrincipalIds });
  const actual = await snapshotSignInPath(signInPathGate.reader, { protectedPrincipalIds: signInPathGate.protectedPrincipalIds });
  const compared = compareSignInPaths(expected, actual);
  if (!compared.allowed) {
    const reverted = await writer.write('v1.0', path, { method: 'PATCH', body: enforceReportOnly({}) });
    await note('succeeded', { postState: after, detail: `turned on, then put back to report-only (${reverted?.ok ? 'reverted' : 'revert failed'}): ${compared.reason}` });
    return fail(`the sign-in path changed beyond this policy (${compared.reason}); the policy was ${reverted?.ok ? 'put back to report-only' : 'NOT put back to report-only — check it now'}`);
  }

  await note('succeeded', { postState: after });
  result.applied.push({ naturalKey, targetId: plan.targetId, change: `state ${REPORT_ONLY} -> ${ENFORCED}` });
  return result;
}
