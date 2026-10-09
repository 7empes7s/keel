/**
 * Roadmap task-61: qualified relationship (edge) restore operations.
 *
 * Group member and owner edges are restored ONLY through Microsoft Graph's
 * qualified `$ref` navigation handlers:
 *
 *   add    POST   /groups/{parent}/{members|owners}/$ref
 *                 { "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/{target}" }
 *   remove DELETE /groups/{parent}/{members|owners}/{target}/$ref
 *
 * A membership is never PATCHed onto the parent object (applyEngine.mjs refuses
 * a parent payload that carries membership navigation). Every other
 * relationship family (transitive members, application/service principal
 * owners, app role grants, Intune assignments) has no edge capability
 * registered in engine/coverage/capabilities.mjs and is refused here. Intune
 * assignments are restored only with their policy, through /assign
 * (applyEngine.mjs, issue #155).
 *
 * Planning (planRelationshipOperations) and execution
 * (applyRelationshipOperations) keep five guarantees:
 *  - lineage remapping: a desired target is resolved to its TARGET-tenant
 *    identity by natural key (existing objects, or objects this run creates);
 *    a target with no resolvable identity is refused, never written by its
 *    source id;
 *  - only a complete live read and a complete, fully-resolved desired
 *    inventory can authorise a removal; a failed or partial read refuses the
 *    whole parent/family before anything is written;
 *  - a live edge that changed after the dry run changes the dry run's
 *    current-state fingerprint (see dryRunArtifact.mjs), so promotion refuses;
 *  - every write is journalled first, and verified by re-reading the edge set;
 *  - an ambiguous write outcome (a thrown request, a 5xx, a lost response) is
 *    reconciled by re-reading — the add is never sent a second time.
 */
import { collectRelationships } from '../collect/relationships.mjs';
import { capabilityFor, edgeCapabilityKey, isSupportedClaim } from '../coverage/capabilities.mjs';
import { decideEdgeVerb } from '../reconcile/verb.mjs';
import { recordPriorState } from './rollbackJournal.mjs';

/** The only families with a write path. Everything else is observed, never written. */
export const RELATIONSHIP_RESTORE_FAMILIES = Object.freeze(['member', 'owner']);

const ACTION_VERB = Object.freeze({ add: 'edge-add', remove: 'edge-remove' });
const DIRECTORY_OBJECT = 'https://graph.microsoft.com/v1.0/directoryObjects';
const THROTTLE_MAX_ATTEMPTS = 3;
const lower = (id) => (typeof id === 'string' && id.length > 0 ? id.toLowerCase() : null);
const isComplete = (outcome) => outcome === 'complete' || outcome === 'complete-empty';
const setKey = (parentNaturalKey, family) => `${parentNaturalKey}|${family}`;

/** Stable identity of one edge operation — its result/refusal/journal key. */
export function relationshipOperationKey(op) {
  return `edge:${op.parentNaturalKey}|${op.family}|${op.action}|${op.targetNaturalKey ?? op.targetId}`;
}

/** The Graph path and request for an edge operation. There is deliberately no
 * branch that produces a PATCH or a path without the `$ref` segment. */
export function refRequestFor({ family, action }, parentTargetId, targetId) {
  if (!RELATIONSHIP_RESTORE_FAMILIES.includes(family)) {
    throw new Error(`no qualified $ref handler for relationship family ${family}`);
  }
  const collection = `/groups/${encodeURIComponent(parentTargetId)}/${family}s`;
  if (action === 'add') {
    return { path: `${collection}/$ref`, method: 'POST', body: { '@odata.id': `${DIRECTORY_OBJECT}/${encodeURIComponent(targetId)}` } };
  }
  if (action === 'remove') {
    return { path: `${collection}/${encodeURIComponent(targetId)}/$ref`, method: 'DELETE', body: undefined };
  }
  throw new Error(`unknown edge action ${action}`);
}

function edgeCapability(family, action) {
  const capability = capabilityFor(edgeCapabilityKey('group', family), ACTION_VERB[action]);
  return { supported: isSupportedClaim(capability.claim), capability };
}

function compareOperations(a, b) {
  return a.parentNaturalKey.localeCompare(b.parentNaturalKey)
    || a.family.localeCompare(b.family)
    // Adds before removes: an owner set is never transiently emptier than needed.
    || (a.action === b.action ? 0 : a.action === 'add' ? -1 : 1)
    || String(a.targetNaturalKey ?? a.targetId).localeCompare(String(b.targetNaturalKey ?? b.targetId));
}

/**
 * Plans edge operations for the groups a restore covers.
 *
 * - `parents`: restore resources of type group ({ naturalKey, verb, liveTargetId }),
 *   liveTargetId set only when the group currently exists in the target.
 * - `desired`: loadSnapshotRelationships() output for the source snapshot.
 * - `live`: Map setKey -> live observation (collectRelationships) for parents that exist.
 * - `resolveTargetId(naturalKey)`: target-tenant id of an existing object, or null.
 * - `pendingCreates`: natural keys this run will create (their id is resolved at execution).
 * - `naturalKeyForTargetId(id)`: display/digest natural key of a live edge target.
 * - `protectedPrincipalIds`: break-glass principals that are never removed from any edge set.
 *
 * Returns `operations` (ordered), `refusals` (guard refusals: naturalKey + reason),
 * `notes` (edge sets deliberately not reconciled, e.g. a legacy snapshot) and
 * `observed` (the live edge sets the fingerprint must bind).
 */
export function planRelationshipOperations({
  parents, desired, live = new Map(), resolveTargetId = () => null, pendingCreates = new Set(),
  naturalKeyForTargetId = () => null, protectedPrincipalIds = [], families = RELATIONSHIP_RESTORE_FAMILIES,
}) {
  const operations = [];
  const refusals = [];
  const notes = [];
  const observed = [];
  const protectedIds = new Set(protectedPrincipalIds.map(lower).filter(Boolean));

  for (const parent of parents) {
    if (parent.verb === 'delete') continue; // a deleted group's edges go with it
    for (const family of families) {
      const key = setKey(parent.naturalKey, family);
      const want = desired.get(key);
      if (!want) continue; // never observed in this snapshot (legacy): edges untouched
      const refuse = (reason) => refusals.push({ naturalKey: `edge:${key}`, reason });

      if (!isComplete(want.outcome) && want.outcome !== 'partial') {
        notes.push({ naturalKey: `edge:${key}`, note: `snapshot ${family} read for ${parent.naturalKey} was ${want.outcome}; edges are not reconciled` });
        continue;
      }
      const { supported } = edgeCapability(family, 'add');
      if (!supported || !edgeCapability(family, 'remove').supported) {
        refuse(`unsupported operation: group ${family} edges have no registered write capability`);
        continue;
      }

      // Current state. A parent that does not exist yet (created or restored by
      // this run) has no live read; its adds are resolved and re-read at execution.
      let liveIds = new Set();
      const parentLive = typeof parent.liveTargetId === 'string';
      if (parentLive) {
        const obs = live.get(key);
        if (!obs || !isComplete(obs.outcome)) {
          refuse(`blocked-edge-read: the live ${family} read for ${parent.naturalKey} was ${obs?.outcome ?? 'not performed'} — edge reconciliation refused, nothing is added or removed`);
          continue;
        }
        liveIds = new Set(obs.targets.map((t) => lower(t.targetId)).filter(Boolean));
        observed.push({ parentNaturalKey: parent.naturalKey, family, outcome: obs.outcome, targetIds: [...liveIds] });
      }

      // Desired state, remapped to target-tenant identity through lineage.
      const desiredIds = new Map(); // live id -> natural key
      const deferred = [];
      let unresolved = 0;
      for (const target of want.targets) {
        const naturalKey = target.targetNaturalKey ?? null;
        const resolved = naturalKey ? lower(resolveTargetId(naturalKey)) : null;
        if (resolved) {
          desiredIds.set(resolved, naturalKey);
        } else if (naturalKey && pendingCreates.has(naturalKey)) {
          deferred.push(naturalKey);
        } else {
          unresolved += 1;
          refuse(`unresolved-edge-target: ${family} ${naturalKey ?? `source object ${target.targetId}`} of ${parent.naturalKey} has no target-tenant identity — it is never written by its source id`);
        }
      }
      const removalProven = isComplete(want.outcome) && unresolved === 0;

      for (const [targetId, naturalKey] of desiredIds) {
        if (decideEdgeVerb({ desired: true, live: liveIds.has(targetId), removalProven }).verb === 'edge-add') {
          operations.push({ parentNaturalKey: parent.naturalKey, family, action: 'add', targetNaturalKey: naturalKey, targetId });
        }
      }
      for (const naturalKey of deferred) {
        operations.push({ parentNaturalKey: parent.naturalKey, family, action: 'add', targetNaturalKey: naturalKey, targetId: null });
      }
      for (const targetId of liveIds) {
        const { verb } = decideEdgeVerb({ desired: desiredIds.has(targetId), live: true, removalProven });
        if (verb === 'refuse-remove') {
          refuse(want.outcome === 'partial'
            ? `partial-edge-inventory: the snapshot's ${family} set for ${parent.naturalKey} is partial — removing ${naturalKeyForTargetId(targetId) ?? targetId} is refused`
            : `removal-unproven: ${parent.naturalKey} has an unresolved desired ${family} — removing ${naturalKeyForTargetId(targetId) ?? targetId} is refused`);
        } else if (verb === 'edge-remove') {
          if (protectedIds.has(targetId)) {
            refuse(`protected-principal: refusing to remove break-glass principal ${targetId} from ${parent.naturalKey} ${family}s`);
            continue;
          }
          operations.push({ parentNaturalKey: parent.naturalKey, family, action: 'remove', targetNaturalKey: naturalKeyForTargetId(targetId), targetId });
        }
      }
    }
  }

  operations.sort(compareOperations);
  observed.sort((a, b) => setKey(a.parentNaturalKey, a.family).localeCompare(setKey(b.parentNaturalKey, b.family)));
  return { operations, refusals, notes, observed };
}

async function readEdgeSet(reader, parentTargetId, family) {
  const [observation] = await collectRelationships(reader, {
    tenantRef: 'restore-execution', parents: [{ type: 'group', sourceId: parentTargetId, naturalKey: null }], families: [family],
  });
  return observation;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes planned edge operations. `mode` other than exactly 'dry-run' writes
 * (the same fail-closed rule as applyWave). Returns { applied, skipped, failed }.
 */
export async function applyRelationshipOperations(writer, governor, operations, {
  reader, mode, targetTenant, parentTargetIds = new Map(), targetIds = new Map(),
  rollbackClient, runId, restoreRef = null, verifyAttempts = 6, verifyDelayMs = 3000, sleep = defaultSleep,
} = {}) {
  const applied = [];
  const skipped = [];
  const failed = [];

  const groups = new Map();
  for (const op of operations) {
    const key = setKey(op.parentNaturalKey, op.family);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(op);
  }

  for (const ops of groups.values()) {
    const { parentNaturalKey, family } = ops[0];
    const writable = [];
    for (const op of ops) {
      const naturalKey = relationshipOperationKey(op);
      if (!RELATIONSHIP_RESTORE_FAMILIES.includes(op.family) || !ACTION_VERB[op.action]) {
        failed.push({ naturalKey, error: `unsupported operation: group ${op.family} ${op.action} has no qualified $ref handler` });
        continue;
      }
      const gate = edgeCapability(op.family, op.action);
      if (!gate.supported) {
        failed.push({ naturalKey, error: `unsupported operation: ${edgeCapabilityKey('group', op.family)} ${ACTION_VERB[op.action]} is not a registered write capability (claim: ${gate.capability.claim})` });
        continue;
      }
      writable.push(op);
    }
    if (writable.length === 0) continue;

    const parentTargetId = lower(parentTargetIds.get(parentNaturalKey));
    const resolve = (op) => lower(op.targetId) ?? lower(targetIds.get(op.targetNaturalKey));

    if (mode === 'dry-run') {
      // Nothing is read or written: the plan was computed from a fresh read. An
      // operation whose parent/target this run would create is still reportable.
      for (const op of writable) applied.push({ naturalKey: relationshipOperationKey(op), edge: op });
      continue;
    }
    if (!parentTargetId) {
      for (const op of writable) failed.push({ naturalKey: relationshipOperationKey(op), error: `${parentNaturalKey} has no target-tenant identity` });
      continue;
    }

    // Precondition read: a failed or partial read forbids every write to this set.
    const before = await readEdgeSet(reader, parentTargetId, family);
    if (!isComplete(before.outcome)) {
      for (const op of writable) {
        skipped.push({ naturalKey: relationshipOperationKey(op), reason: `blocked-edge-read: the live ${family} read for ${parentNaturalKey} was ${before.outcome} — no edge is added or removed` });
      }
      continue;
    }
    let current = new Set(before.targets.map((t) => t.targetId));
    const expectations = [];

    for (const op of writable) {
      const naturalKey = relationshipOperationKey(op);
      const targetId = resolve(op);
      if (!targetId) {
        failed.push({ naturalKey, error: `unresolved-edge-target: ${op.targetNaturalKey} has no target-tenant identity` });
        continue;
      }
      const wantPresent = op.action === 'add';
      if (current.has(targetId) === wantPresent) {
        expectations.push({ op, naturalKey, targetId, wantPresent, reconciled: wantPresent ? 'already-present' : 'already-absent' });
        continue;
      }

      let journaled = true;
      if (rollbackClient) {
        try {
          await recordPriorState(rollbackClient, {
            runId,
            naturalKey,
            priorState: { kind: 'relationship-edge', parentNaturalKey, parentTargetId, family, targetId, present: !wantPresent },
            // Task-70: journaled under the promoted artifact so compensation lists
            // the edge (as a manual item) instead of losing it.
            ...(restoreRef ? { restoreRef, resourceType: 'group', operation: `edge-${op.action}`, targetId: parentTargetId } : {}),
          });
        } catch {
          journaled = false;
        }
      }
      if (!journaled) {
        failed.push({ naturalKey, error: `refusing to ${op.action} ${family}: rollback journal write failed` });
        continue;
      }

      const request = refRequestFor(op, parentTargetId, targetId);
      let result;
      for (let attempt = 1; attempt <= THROTTLE_MAX_ATTEMPTS; attempt += 1) {
        await governor.acquire(targetTenant, 'entra', 'write');
        try {
          result = await writer.write('v1.0', request.path, { method: request.method, body: request.body });
        } catch (error) {
          result = { ok: false, status: null, lost: true, error: error?.message ?? String(error) };
        }
        // Only a 429 provably did nothing and may be re-sent. A 5xx or a lost
        // response may have been applied: it is reconciled by reading, below.
        if (result?.ok || result?.status !== 429 || attempt === THROTTLE_MAX_ATTEMPTS) break;
        const delay = Number.isSafeInteger(result.retryAfter) && result.retryAfter >= 0 ? result.retryAfter : 1;
        governor.observeRetryAfter?.(targetTenant, 'entra', 'write', delay);
        await sleep(delay * 1000);
      }

      if (result?.ok) {
        expectations.push({ op, naturalKey, targetId, wantPresent, reconciled: null });
        continue;
      }
      // Ambiguous or refused: the edge set itself decides. Never re-send.
      const after = await readEdgeSet(reader, parentTargetId, family);
      if (isComplete(after.outcome)) {
        current = new Set(after.targets.map((t) => t.targetId));
        if (current.has(targetId) === wantPresent) {
          expectations.push({ op, naturalKey, targetId, wantPresent, reconciled: 'lost-response' });
          continue;
        }
      }
      failed.push({
        naturalKey,
        error: `${op.action} ${family} failed: ${JSON.stringify(result?.body ?? result?.error ?? null)}${isComplete(after.outcome) ? '' : ` (reconciliation read ${after.outcome})`}`,
        ...(Number.isInteger(result?.status) ? { status: result.status } : {}),
      });
    }

    if (expectations.length === 0) continue;

    // Post-write verification: the whole set is re-read until every expectation
    // holds, tolerating Graph's short read-after-write lag, never past it.
    let verified = null;
    for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
      const read = await readEdgeSet(reader, parentTargetId, family);
      if (isComplete(read.outcome)) {
        const ids = new Set(read.targets.map((t) => t.targetId));
        verified = ids;
        if (expectations.every((e) => ids.has(e.targetId) === e.wantPresent)) break;
      } else {
        verified = null;
      }
      if (attempt < verifyAttempts) await sleep(verifyDelayMs);
    }
    for (const expectation of expectations) {
      if (verified === null) {
        failed.push({ naturalKey: expectation.naturalKey, error: `post-write verification refused: the ${family} read for ${parentNaturalKey} never completed` });
      } else if (verified.has(expectation.targetId) !== expectation.wantPresent) {
        failed.push({ naturalKey: expectation.naturalKey, error: `post-write verification failed: ${expectation.targetId} is ${expectation.wantPresent ? 'still absent from' : 'still present in'} ${parentNaturalKey} ${family}s` });
      } else {
        applied.push({
          naturalKey: expectation.naturalKey,
          edge: expectation.op,
          ...(expectation.reconciled ? { reconciled: expectation.reconciled } : {}),
        });
      }
    }
  }

  return { applied, skipped, failed };
}
