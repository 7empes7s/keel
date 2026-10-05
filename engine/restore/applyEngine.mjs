import { enforceReportOnly } from '../safety/conditionalAccessGuard.mjs';
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';
import { refuseUnsafeDeletion } from '../safety/deletionGuard.mjs';
import { canonicalHash, canonicalize } from '../cir/canonicalHash.mjs';
import { immutableDrift, writableProjection } from '../reconcile/writableProjection.mjs';
import { verbCapability } from '../reconcile/verb.mjs';
import { graphPathFor } from '../coverage/capabilities.mjs';
import {
  ALTERNATE_IDENTIFIERS, CREATE_EXCLUDED_FIELDS, remappingFor, withExplicitReferences,
} from '../coverage/qualification.mjs';
import { recoveryGate } from './recoveryMechanism.mjs';
import {
  isPolicyGoverned, policyCreateBody, policyPatchRefusal, policyPostCreateRefusal, policyWriteRefusal,
} from './policyOperations.mjs';
import {
  administrativePatchRefusal, administrativePostStateRefusal, administrativeWriteRefusal, isAdministrativeGoverned,
} from './administrativeOperations.mjs';
import { isPreservationLockFailure } from '../safety/contentEffects.mjs';
import { recordPriorState, recordWriteOutcome, classifyWriteOutcome } from './rollbackJournal.mjs';
import { resolveSymbol } from '../graph/resolver.mjs';
import { compareSignInPaths, snapshotSignInPath } from '../safety/signInPathGate.mjs';
import { RETRY_AFTER_FALLBACK_SECONDS } from './graphWriter.mjs';
import { isDeepStrictEqual } from 'node:util';

/** Thrown by rewriteReferences when a reference cannot be resolved. Caught at every call site
 * and turned into a `failed` entry — a resource whose references don't all resolve must never
 * reach writer.write with a dangling source-tenant guid (spec §8.2/§9.3 cross-tenant risk). */
export class UnresolvedReferenceError extends Error {
  constructor(naturalKey, ref, reason) {
    super(`${naturalKey}: cannot resolve reference at "${ref.field}" (symbol ${ref.symbol ?? 'null'}): ${reason}`);
    this.name = 'UnresolvedReferenceError';
    this.naturalKey = naturalKey;
    this.field = ref.field;
    this.symbol = ref.symbol;
    this.reason = reason;
  }
}

/** Parses a resolver reference's `field` path (dot-separated object keys, `[n]` array indices —
 * the exact syntax walkGuids()/canonicalize.mjs's referenceValues() produce, e.g.
 * "conditions.users.excludeGroups[0]") into an ordered list of object-key/array-index segments. */
function parseFieldPath(path) {
  const segments = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path))) {
    segments.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  }
  return segments;
}

/** Immutable set: returns a NEW object/array with `value` placed at `path`, sharing every
 * untouched branch with the original. Payload objects are reused across multiple applyWave
 * calls in tests (and, in the pipeline, potentially across resources), so mutating in place
 * would leak a rewrite from one write into an unrelated one. */
function setAtPath(root, path, value) {
  const segments = parseFieldPath(path);
  if (segments.length === 0) return root;
  const walk = (node, i) => {
    const key = segments[i];
    const isLast = i === segments.length - 1;
    const nextValue = isLast ? value : walk(node?.[key], i + 1);
    let copy;
    if (Array.isArray(node)) copy = node.slice();
    else if (node && typeof node === 'object') copy = { ...node };
    else copy = typeof key === 'number' ? [] : {};
    copy[key] = nextValue;
    return copy;
  };
  return walk(root, 0);
}

function valueAtPath(root, path) {
  return parseFieldPath(path).reduce((value, segment) => value?.[segment], root);
}

/** Where the resolver meets the writer: rewrites every GUID-valued reference field in `payload`
 * from its source-tenant id to the target tenant's id, using the EXACT resolution order defined
 * in engine/graph/resolver.mjs's resolveSymbol (exact-match > mapping-table > prior-restore,
 * global constants short-circuit first) — this must never diverge from what keel-plan.mjs's
 * pre-flight already proved resolvable for the same symbol.
 *
 * A reference that fails to resolve throws rather than returning a payload with a dangling
 * source-tenant guid — callers must catch UnresolvedReferenceError and fail the resource.
 * A `global-constant` resolution leaves the field UNTOUCHED: resolveSymbol reports its
 * targetId as the symbolic string itself (e.g. "global:GlobalAdministrator"), which is a
 * placeholder for "resolvable, no rewrite needed" — not a literal value to write. */
export function rewriteReferences(payload, references, ctx, naturalKey) {
  if (!references || references.length === 0) return payload;
  let rewritten = payload;
  for (const ref of references) {
    // Roadmap task-107: an explicit reference that holds one of the target's
    // alternate identifiers (a service principal's appId). The identifier is
    // rewritten only to a value a create in THIS run reported; a target that
    // already exists under the same natural key keeps the identifier the key
    // encodes. Anything else refuses — an object id is never written into an
    // appId field.
    if (ref.identifier) {
      const recreated = ctx.runProvenance.get(`${ref.symbol}#${ref.identifier}`);
      if (typeof recreated === 'string' && recreated.length > 0) {
        rewritten = setAtPath(rewritten, ref.field, recreated);
        continue;
      }
      if (ctx.targetIndex.has(ref.symbol)) continue;
      throw new UnresolvedReferenceError(naturalKey, ref, `no ${ref.identifier} known for ${ref.symbol} in the target or this run`);
    }
    const result = resolveSymbol(ref.symbol, ctx);
    if (!result.resolved) {
      throw new UnresolvedReferenceError(naturalKey, ref, result.reason);
    }
    if (result.via === 'global-constant') continue;
    rewritten = setAtPath(rewritten, ref.field, result.targetId);
  }
  return rewritten;
}

/** Empirically observed on this tenant: a read immediately after a write to the same object can
 * return 404 or a stale body for up to ~15-20s. Retries only the specific staleness signature the
 * caller names — never masks a genuine error. */
async function readAfterWrite(writer, version, path, isStale, {
  attempts = 6,
  delayMs = 3000,
  retryOperation = (operation) => operation(),
} = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await retryOperation(() => writer.read(version, path));
    if (!isStale(result)) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/** Same lag readAfterWrite retries on the read side — this tenant's write path can also 404 a
 * write to an object this session just created/mutated. Retries ONLY a 404. */
async function writeAfterCreate(writer, version, path, body, {
  attempts = 6,
  delayMs = 3000,
  retryOperation = (operation) => operation(),
} = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await retryOperation(() => writer.write(version, path, body));
    if (result.ok || result.status !== 404) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

const isNotFound = (result) => result?.ok === false && result?.status === 404;

const THROTTLE_RETRY_MAX_ATTEMPTS = 3;

const sleepSeconds = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function isThrottleResponse(result) {
  return result?.ok === false && (result.status === 429 || result.status === 503);
}

function retryDelaySeconds(result) {
  const delay = result?.retryAfter;
  return Number.isSafeInteger(delay) && delay >= 0 ? delay : RETRY_AFTER_FALLBACK_SECONDS;
}

/** Every Graph operation in an apply wave uses this bounded retry path. Its
 * sleeper is injected by tests so observed Graph delays never make fixtures
 * wait in real time. */
export async function retryThrottledGraphOperation(operation, {
  governor,
  targetTenant,
  operationClass = 'write',
  maxAttempts = THROTTLE_RETRY_MAX_ATTEMPTS,
  sleep = sleepSeconds,
} = {}) {
  const attemptsLimit = Number.isInteger(maxAttempts)
    ? Math.min(Math.max(maxAttempts, 1), THROTTLE_RETRY_MAX_ATTEMPTS)
    : THROTTLE_RETRY_MAX_ATTEMPTS;
  let result;
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    await governor.acquire(targetTenant, 'entra', operationClass);
    result = await operation();
    if (!isThrottleResponse(result)) return result;
    if (attempt === attemptsLimit) return { ...result, attempts: attempt };

    const delay = retryDelaySeconds(result);
    governor.observeRetryAfter(targetTenant, 'entra', operationClass, delay);
    await sleep(delay);
  }
  return result;
}

function graphFailure(naturalKey, result) {
  // Roadmap task-66: a platform preservation-lock refusal is final. It is never
  // retried (only 429/503 are) and no other write path is tried around it.
  const lock = isPreservationLockFailure(result) ? 'preservation-lock: the platform refused this change and KEEL never retries or works around it — ' : '';
  const failure = { naturalKey, error: `${lock}${JSON.stringify(result?.body ?? result?.error)}` };
  if (result?.attempts !== undefined) {
    failure.status = result.status;
    failure.attempts = result.attempts;
  }
  return failure;
}

// Parent types whose edges are relationship observations (task-57), and the
// navigation properties that would write those edges through the parent.
const RELATIONSHIP_NAVIGATION = new Map([
  ['group', ['members', 'owners', 'transitiveMembers']],
  ['application', ['owners']],
  ['servicePrincipal', ['owners', 'appRoleAssignments']],
]);

function relationshipNavigationFields(resourceType, payload) {
  const navigation = RELATIONSHIP_NAVIGATION.get(resourceType);
  if (!navigation || !payload || typeof payload !== 'object') return [];
  return Object.keys(payload).filter((field) => navigation.some(
    (name) => field === name || field === `${name}@odata.bind` || field === `${name}@delta`,
  ));
}

// Roadmap task-63: remapping is qualified per operation, never by the blanket
// descriptor.remappable flag. A rewrite that leaves every reference id as it was
// (a same-tenant update) remaps nothing and needs no proof; a rewrite to a
// DIFFERENT id needs a recorded remapping proof for exactly this operation.
function unqualifiedRemapping(resource, verb, before, after) {
  const changed = withExplicitReferences(resource).filter((ref) => {
    const was = valueAtPath(before, ref.field);
    const now = valueAtPath(after, ref.field);
    return String(was ?? '').toLowerCase() !== String(now ?? '').toLowerCase();
  });
  if (changed.length === 0) return null;
  const remapping = remappingFor(resource.resourceType, verb);
  if (remapping.qualified) return null;
  return `unqualified-remapping: ${resource.resourceType} ${verb} would rewrite ${changed.map((ref) => ref.field).join(', ')} to a different id, and reference remapping is not proven for this operation`;
}

// Task-70: a journal entry carries the operation identity and intent when the
// run has a restore reference (a promoted artifact), so a failed run can be
// compensated against exactly what it tried. Returns { ok, entryId }.
async function journalBeforeMutation(rollbackClient, {
  runId, restoreRef = null, resource, operation, targetId = null, priorState, intendedState,
}) {
  if (!rollbackClient) return { ok: true, entryId: null };
  try {
    const entryId = await recordPriorState(rollbackClient, restoreRef
      ? {
        runId, naturalKey: resource.naturalKey, priorState, restoreRef,
        resourceType: resource.resourceType, operation, targetId, blastRadius: resource.blastRadius ?? null,
        intendedState,
      }
      : { runId, naturalKey: resource.naturalKey, priorState });
    return { ok: true, entryId: restoreRef ? entryId : null };
  } catch {
    return { ok: false, entryId: null };
  }
}

// Task-70: what a journaled write actually did. Never fails the run: a write
// whose outcome could not be recorded stays 'pending', which compensation
// treats as uncertain and reconciles by reading.
async function noteOutcome(rollbackClient, journal, outcome, extras = {}) {
  if (!rollbackClient || !journal?.entryId) return;
  try {
    await recordWriteOutcome(rollbackClient, { entryId: journal.entryId, outcome, ...extras });
  } catch {
    // left pending
  }
}

function outcomeDetail(result) {
  if (result?.status !== undefined && result?.status !== null) return `status ${result.status}`;
  return result?.error ? String(result.error).slice(0, 200) : 'no response';
}

/** Spec §7.1, §9.3, §11.5. An apply is not complete until it reads the state
 * back and confirms it — this function is where that rule lives. */
export async function applyWave(writer, governor, wave, {
  targetTenant,
  mode,
  existingTargetIds = new Map(),
  // Natural-key -> target-id of resources already applied EARLIER IN THIS SAME RUN (across
  // prior waves). Feeds resolveSymbol's `runProvenance` lookup. Defaults to empty so the
  // existing cli/keel-restore.mjs call site (which does not yet pass this) is unaffected.
  appliedIds = new Map(),
  // Manual symbol->symbol override table. Feeds resolveSymbol's `mappingTable` lookup.
  // No caller currently populates this; kept as an option for parity with resolvePlan's ctx.
  mappingTable = new Map(),
  deletionGuardOptions = { breakGlassUserIds: [], keelAppIds: [], caPolicies: [] },
  rollbackClient,
  runId,
  // Task-70: the promoted dry-run artifact this run executes; when present every
  // journal entry records its operation, intent and outcome for compensation.
  restoreRef = null,
  simulationPassed = false,
  signInPathGate,
  throttleRetryOptions,
  // Clock for the task-64 recovery deadline check; injectable for tests.
  now = () => new Date(),
  // Roadmap task-109: the source snapshot's per-type coverage entries
  // ({ [resourceType]: { outcome } }). A governed delete needs a complete one.
  observedCoverage = null,
}) {
  const applied = [];
  const skipped = [];
  const failed = [];
  const notRemediable = [];
  const signInPathBefore = signInPathGate && await snapshotSignInPath(signInPathGate.reader, {
    protectedPrincipalIds: signInPathGate.protectedPrincipalIds,
  });
  // Same three lookup sources resolvePlan() uses in cli/keel-plan.mjs, so a symbol that the
  // pre-flight proved resolvable resolves identically here at write time.
  const referenceContext = { targetIndex: existingTargetIds, mappingTable, runProvenance: appliedIds };
  const retryOperation = (operation) => retryThrottledGraphOperation(operation, {
    governor,
    targetTenant,
    operationClass: 'write',
    ...throttleRetryOptions,
  });

  for (const resource of wave) {
    if (resource.verb === 'noop') {
      applied.push({ naturalKey: resource.naturalKey, targetId: resource.targetId ?? null });
      continue;
    }

    // Roadmap task-52: fail closed before any guard, journal write or writer
    // call — an unevidenced (resourceType, verb) pair must never reach
    // Graph. Mirrors the exact verb normalisation the branches below use: a
    // verb that names none of 'delete'/'restore-soft-deleted'/'update'
    // (including an absent verb) falls through to the create path.
    const effectiveVerb = resource.verb === 'delete' || resource.verb === 'restore-soft-deleted' || resource.verb === 'update'
      ? resource.verb
      : 'create';
    // Roadmap task-109: global reference templates are never written, a
    // non-cloud source of authority is refused for every verb (delete included),
    // and a governed write needs its operation record's parent and dependency
    // checks to hold — a delete also needs a complete snapshot observation.
    const administrativeRefusal = administrativeWriteRefusal(resource, effectiveVerb, { observedCoverage });
    if (administrativeRefusal) {
      (administrativeRefusal.outcome === 'skipped' ? skipped : failed).push(administrativeRefusal.outcome === 'skipped'
        ? { naturalKey: resource.naturalKey, reason: administrativeRefusal.reason }
        : { naturalKey: resource.naturalKey, error: administrativeRefusal.reason });
      continue;
    }

    const capabilityGate = verbCapability(resource.resourceType, effectiveVerb);
    if (!capabilityGate.supported) {
      failed.push({
        naturalKey: resource.naturalKey,
        error: `unsupported operation: ${resource.resourceType} ${effectiveVerb} is not a registered write capability (claim: ${capabilityGate.capability?.claim ?? 'unsupported'})`,
      });
      continue;
    }

    // Roadmap task-108: a policy-governed type writes only the subtype its proof
    // covers, under the projection it was proven with. A built-in (immutable)
    // policy is skipped; an unproven subtype or a changed projection fails.
    const policyRefusal = policyWriteRefusal(resource, effectiveVerb);
    if (policyRefusal) {
      (policyRefusal.outcome === 'skipped' ? skipped : failed).push(policyRefusal.outcome === 'skipped'
        ? { naturalKey: resource.naturalKey, reason: policyRefusal.reason }
        : { naturalKey: resource.naturalKey, error: policyRefusal.reason });
      continue;
    }

    // Roadmap task-64: a planned recovery mechanism is re-checked here, so a
    // manual/refused mechanism never writes and an expired recovery point is
    // refused at execution even after a clean dry run.
    const recoveryRefusal = recoveryGate(resource, { now: now() });
    if (recoveryRefusal) {
      (recoveryRefusal.outcome === 'failed' ? failed : skipped).push(recoveryRefusal.outcome === 'failed'
        ? { naturalKey: resource.naturalKey, error: recoveryRefusal.reason }
        : { naturalKey: resource.naturalKey, reason: recoveryRefusal.reason });
      continue;
    }

    // Roadmap task-61: an edge is never written through its parent. A group
    // payload carrying membership/ownership navigation (a `members` array, an
    // `owners@odata.bind`, ...) is refused here; edges go only through the
    // qualified $ref handlers in relationshipWriter.mjs, which read, journal and
    // verify each edge individually.
    if (resource.verb !== 'delete') {
      const smuggled = relationshipNavigationFields(resource.resourceType, resource.payload);
      if (smuggled.length > 0) {
        failed.push({
          naturalKey: resource.naturalKey,
          error: `relationship-via-parent refused: ${resource.resourceType} payload carries ${smuggled.join(', ')} — edges are written only through qualified $ref operations`,
        });
        continue;
      }
    }

    if (resource.verb === 'delete') {
      const deletionCheck = refuseUnsafeDeletion({
        ...resource,
        payload: resource.live?.payload ?? resource.payload,
      }, deletionGuardOptions);
      if (deletionCheck.refused) {
        skipped.push({ naturalKey: resource.naturalKey, reason: deletionCheck.reason });
        continue;
      }
      if (resource.blastRadius === 'tenant-lockout' && simulationPassed !== true) {
        skipped.push({
          naturalKey: resource.naturalKey,
          reason: 'refusing to delete tenant-lockout resource: simulationPassed must be true',
        });
        continue;
      }

      const targetId = resource.targetId ?? resource.live?.targetId ?? existingTargetIds.get(resource.naturalKey);
      if (!targetId) {
        failed.push({ naturalKey: resource.naturalKey, error: 'delete has no targetId' });
        continue;
      }

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const journal = await journalBeforeMutation(rollbackClient, {
        runId, restoreRef, resource, operation: 'delete', targetId,
        priorState: resource.live?.payload ?? resource.payload,
        intendedState: null,
      });
      if (!journal.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to delete: rollback journal write failed' });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const deleteResult = await retryOperation(() => writer.write('v1.0', path, { method: 'DELETE', body: {} }));
      if (!deleteResult.ok) {
        await noteOutcome(rollbackClient, journal, classifyWriteOutcome(deleteResult), { detail: outcomeDetail(deleteResult) });
        failed.push(graphFailure(resource.naturalKey, deleteResult));
        continue;
      }

      const reRead = await readAfterWrite(writer, 'v1.0', path, (r) => r?.ok === true && r.body?.deletedDateTime == null, { retryOperation });
      const isAbsent = reRead?.ok === false && reRead.status === 404;
      const live = reRead?.body ?? reRead;
      const isSoftDeleted = live?.deletedDateTime != null;
      if (!isAbsent && !isSoftDeleted) {
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: live ?? null, detail: 'delete did not verify' });
        failed.push({ naturalKey: resource.naturalKey, error: 'delete did not verify as absent or soft-deleted' });
        continue;
      }

      await noteOutcome(rollbackClient, journal, 'succeeded', { detail: isAbsent ? 'absent' : 'soft-deleted' });
      applied.push({ naturalKey: resource.naturalKey, targetId });
      continue;
    }

    const syncCheck = refuseIfSynced({
      ...resource,
      payload: resource.live?.payload ?? resource.payload,
    });
    if (syncCheck.refused) { skipped.push({ naturalKey: resource.naturalKey, reason: syncCheck.reason }); continue; }

    if (resource.verb === 'restore-soft-deleted') {
      const targetId = resource.targetId ?? resource.live?.targetId ?? existingTargetIds.get(resource.naturalKey);
      const deletedItemId = resource.deletedItemId ?? resource.live?.deletedItemId;
      if (!targetId) {
        failed.push({ naturalKey: resource.naturalKey, error: 'restore has no targetId' });
        continue;
      }
      if (!deletedItemId) {
        failed.push({ naturalKey: resource.naturalKey, error: 'restore has no deletedItemId' });
        continue;
      }

      let desired = resource.payload;
      if (resource.resourceType === 'conditionalAccessPolicy') desired = enforceReportOnly(desired);
      const beforeRewrite = desired;
      try {
        desired = rewriteReferences(desired, withExplicitReferences(resource), referenceContext, resource.naturalKey);
      } catch (err) {
        failed.push({ naturalKey: resource.naturalKey, error: err.message });
        continue;
      }
      const remapRefusal = unqualifiedRemapping(resource, effectiveVerb, beforeRewrite, desired);
      if (remapRefusal) {
        failed.push({ naturalKey: resource.naturalKey, error: remapRefusal });
        continue;
      }

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const journal = await journalBeforeMutation(rollbackClient, {
        runId, restoreRef, resource, operation: 'restore-soft-deleted', targetId,
        priorState: resource.live?.payload ?? resource.payload,
        intendedState: desired,
      });
      if (!journal.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to restore: rollback journal write failed' });
        continue;
      }

      const restoreResult = await retryOperation(() => writer.write(
        'v1.0',
        `/directory/deletedItems/${deletedItemId}/restore`,
        { method: 'POST', body: {} },
      ));
      if (!restoreResult.ok) {
        await noteOutcome(rollbackClient, journal, classifyWriteOutcome(restoreResult), { detail: outcomeDetail(restoreResult) });
        failed.push(graphFailure(resource.naturalKey, restoreResult));
        continue;
      }
      if (restoreResult.body?.id !== targetId) {
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: restoreResult.body ?? null, detail: 'restore returned a different objectId' });
        failed.push({
          naturalKey: resource.naturalKey,
          error: 'restore returned a different objectId — references would be broken',
        });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const reRead = await readAfterWrite(writer, 'v1.0', path, isNotFound, { retryOperation });
      if (reRead?.ok === false) {
        await noteOutcome(rollbackClient, journal, 'uncertain', { detail: 'restored object could not be re-read' });
        failed.push(graphFailure(resource.naturalKey, reRead));
        continue;
      }
      let live = reRead?.body ?? reRead;
      if (canonicalHash(live, resource.resourceType) === canonicalHash(desired, resource.resourceType)) {
        await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live });
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const payload = writableProjection(desired, resource.resourceType);
      const updateResult = await retryOperation(() => writer.write('v1.0', path, { method: 'PATCH', body: payload }));
      if (!updateResult.ok) {
        // The restore landed (the object is back); only the follow-up PATCH did not.
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: live, detail: `restored; follow-up update ${outcomeDetail(updateResult)}` });
        failed.push(graphFailure(resource.naturalKey, updateResult));
        continue;
      }

      const updateReRead = await readAfterWrite(writer, 'v1.0', path, (r) =>
        isNotFound(r) || (r?.ok === true && canonicalHash(r.body, resource.resourceType) !== canonicalHash(desired, resource.resourceType)), { retryOperation });
      if (updateReRead?.ok === false) {
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: live, detail: 'restored; follow-up update could not be re-read' });
        failed.push(graphFailure(resource.naturalKey, updateReRead));
        continue;
      }
      live = updateReRead?.body ?? updateReRead;
      if (canonicalHash(live, resource.resourceType) !== canonicalHash(desired, resource.resourceType)) {
        const residual = residualDiff(desired, live, resource.resourceType);
        if (residual.length === 0) {
          // The hashes differ only where an empty array or object meets an absent field.
          await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live, detail: 'converged: only empty values differ' });
          applied.push({ naturalKey: resource.naturalKey, targetId });
          continue;
        }
        const immutable = immutableDrift(desired, live, resource.resourceType);
        if (residual.length > 0 && residual.every((path) => immutable.some(
          (immutablePath) => path === immutablePath || path.startsWith(`${immutablePath}.`),
        ))) {
          await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live, detail: 'not-remediable residual' });
          notRemediable.push({ naturalKey: resource.naturalKey, status: 'not-remediable', immutable });
          continue;
        }
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: live, detail: 'residual drift after update' });
        failed.push({ naturalKey: resource.naturalKey, error: 'residual drift after update', residual });
        continue;
      }

      await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live });
      applied.push({ naturalKey: resource.naturalKey, targetId });
      continue;
    }

    if (resource.verb === 'update') {
      const targetId = resource.targetId ?? resource.live?.targetId ?? existingTargetIds.get(resource.naturalKey);
      if (!targetId) {
        failed.push({ naturalKey: resource.naturalKey, error: 'update has no targetId' });
        continue;
      }

      let desired = resource.payload;
      if (resource.resourceType === 'conditionalAccessPolicy') desired = enforceReportOnly(desired);
      const beforeRewrite = desired;
      try {
        desired = rewriteReferences(desired, withExplicitReferences(resource), referenceContext, resource.naturalKey);
      } catch (err) {
        failed.push({ naturalKey: resource.naturalKey, error: err.message });
        continue;
      }
      const remapRefusal = unqualifiedRemapping(resource, effectiveVerb, beforeRewrite, desired);
      if (remapRefusal) {
        failed.push({ naturalKey: resource.naturalKey, error: remapRefusal });
        continue;
      }
      const normalisedDesired = withoutNulls(desired);
      const payload = writableProjection(desired, resource.resourceType);
      const patchRefusal = isPolicyGoverned(resource.resourceType) ? policyPatchRefusal(resource.resourceType, payload)
        : isAdministrativeGoverned(resource.resourceType) ? administrativePatchRefusal(resource.resourceType, payload) : null;
      if (patchRefusal) {
        failed.push({ naturalKey: resource.naturalKey, error: patchRefusal });
        continue;
      }

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const journal = await journalBeforeMutation(rollbackClient, {
        runId, restoreRef, resource, operation: 'update', targetId,
        priorState: resource.live?.payload ?? resource.payload,
        intendedState: desired,
      });
      if (!journal.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to update: rollback journal write failed' });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const writeResult = await writeAfterCreate(writer, 'v1.0', path, { method: 'PATCH', body: payload }, { retryOperation });
      if (!writeResult.ok) {
        await noteOutcome(rollbackClient, journal, classifyWriteOutcome(writeResult), { detail: outcomeDetail(writeResult) });
        failed.push(graphFailure(resource.naturalKey, writeResult));
        continue;
      }

      const reRead = await readAfterWrite(writer, 'v1.0', path, (r) =>
        isNotFound(r) || (r?.ok === true && canonicalHash(forVerification(withoutNulls(r.body), resource), resource.resourceType) !== canonicalHash(normalisedDesired, resource.resourceType)), { retryOperation });
      if (reRead?.ok === false) {
        await noteOutcome(rollbackClient, journal, 'uncertain', { detail: 'update could not be re-read' });
        failed.push(graphFailure(resource.naturalKey, reRead));
        continue;
      }
      const live = forVerification(withoutNulls(reRead?.body ?? reRead), resource);
      // Roadmap task-109: a governed update also verifies its own post-state
      // (every written value, and a setting still bound to its template) before
      // the hash comparison, so a template that changed under the write fails
      // instead of reading as an immutable, not-remediable residual.
      const postStateRefusal = isAdministrativeGoverned(resource.resourceType)
        ? administrativePostStateRefusal(resource, reRead?.body ?? reRead) : null;
      if (postStateRefusal) {
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: live, detail: 'administrative post-state did not verify' });
        failed.push({ naturalKey: resource.naturalKey, error: postStateRefusal });
        continue;
      }

      if (canonicalHash(live, resource.resourceType) !== canonicalHash(normalisedDesired, resource.resourceType)) {
        const residual = residualDiff(normalisedDesired, live, resource.resourceType);
        if (residual.length === 0) {
          // The hashes differ only where an empty array or object meets an absent field.
          await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live, detail: 'converged: only empty values differ' });
          applied.push({ naturalKey: resource.naturalKey, targetId });
          continue;
        }
        const immutable = immutableDrift(normalisedDesired, live, resource.resourceType);
        if (residual.length > 0 && residual.every((path) => immutable.some(
          (immutablePath) => path === immutablePath || path.startsWith(`${immutablePath}.`),
        ))) {
          await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live, detail: 'not-remediable residual' });
          notRemediable.push({ naturalKey: resource.naturalKey, status: 'not-remediable', immutable });
          continue;
        }
        await noteOutcome(rollbackClient, journal, 'uncertain', { postState: live, detail: 'residual drift after update' });
        failed.push({ naturalKey: resource.naturalKey, error: 'residual drift after update', residual });
        continue;
      }

      await noteOutcome(rollbackClient, journal, 'succeeded', { postState: live });
      applied.push({ naturalKey: resource.naturalKey, targetId });
      continue;
    }

    let payload = resource.payload;
    if (resource.resourceType === 'conditionalAccessPolicy') payload = enforceReportOnly(payload);
    const beforeRewrite = payload;
    try {
      payload = rewriteReferences(payload, withExplicitReferences(resource), referenceContext, resource.naturalKey);
    } catch (err) {
      failed.push({ naturalKey: resource.naturalKey, error: err.message });
      continue;
    }
    const remapRefusal = unqualifiedRemapping(resource, effectiveVerb, beforeRewrite, payload);
    if (remapRefusal) {
      failed.push({ naturalKey: resource.naturalKey, error: remapRefusal });
      continue;
    }

    const existingId = existingTargetIds.get(resource.naturalKey);
    if (existingId) {
      if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      const path = `${pathFor(resource.resourceType)}/${existingId}`;
      const reRead = await retryOperation(() => writer.read('v1.0', path));
      if (reRead?.ok === false) {
        const failure = { naturalKey: resource.naturalKey, error: `conflict: ${existingId} exists in target but could not be read (status ${reRead.status}) — manual reconciliation required` };
        if (reRead?.attempts !== undefined) {
          failure.status = reRead.status;
          failure.attempts = reRead.attempts;
        }
        failed.push(failure);
        continue;
      }
      const actualHash = canonicalHash(forVerification(reRead?.body ?? reRead, resource), resource.resourceType);
      const desiredHash = canonicalHash(payload, resource.resourceType);
      if (actualHash === desiredHash) { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      failed.push({ naturalKey: resource.naturalKey, error: `conflict: ${existingId} exists in target but actual hash ${actualHash} does not match desired hash ${desiredHash} — manual reconciliation required` });
      continue;
    }

    if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: null }); continue; }

    const journal = await journalBeforeMutation(rollbackClient, {
      runId, restoreRef, resource, operation: 'create',
      priorState: null,
      intendedState: payload,
    });
    if (!journal.ok) {
      failed.push({ naturalKey: resource.naturalKey, error: 'refusing to create: rollback journal write failed' });
      continue;
    }

    const path = pathFor(resource.resourceType);
    // Roadmap task-107: for a type with CREATE_EXCLUDED_FIELDS the body leaves out
    // what Entra assigns and the credential material KEEL can never read back,
    // and verification compares exactly the fields that were written.
    const createExcluded = CREATE_EXCLUDED_FIELDS[resource.resourceType] ?? null;
    // Roadmap task-108: a policy-governed create sends only its record's
    // writable fields; unknown fields are never sent and are reported.
    const policyCreate = isPolicyGoverned(resource.resourceType) ? policyCreateBody(resource.resourceType, payload) : null;
    const createBody = policyCreate ? policyCreate.body : createExcluded ? withoutFields(payload, createExcluded) : payload;
    const writeResult = await retryOperation(() => writer.write('v1.0', path, { method: 'POST', body: createBody }));
    if (!writeResult.ok) {
      await noteOutcome(rollbackClient, journal, classifyWriteOutcome(writeResult), { detail: outcomeDetail(writeResult) });
      failed.push(graphFailure(resource.naturalKey, writeResult));
      continue;
    }

    const targetId = writeResult.body.id;
    const reRead = await readAfterWrite(writer, 'v1.0', `${path}/${targetId}`, isNotFound, { retryOperation });
    if (reRead?.ok === false) {
      await noteOutcome(rollbackClient, journal, 'uncertain', { targetId, detail: 'created object could not be re-read' });
      failed.push(graphFailure(resource.naturalKey, reRead));
      continue;
    }
    const createdLive = forVerification(reRead?.body ?? reRead, resource);
    const actualHash = canonicalHash(createExcluded ? onlyFields(createdLive, createBody) : createdLive, resource.resourceType);
    const desiredHash = canonicalHash(createBody, resource.resourceType);
    if (actualHash !== desiredHash) {
      await noteOutcome(rollbackClient, journal, 'uncertain', { targetId, postState: reRead?.body ?? reRead, detail: 'created object did not verify' });
      failed.push({ naturalKey: resource.naturalKey, error: `verification hash mismatch after write to ${targetId}: actual hash ${actualHash}, desired hash ${desiredHash}` });
      continue;
    }

    // Roadmap task-107: a created object's alternate identifiers (an
    // application's new appId) are reported only when the read-back agrees with
    // the create response, so a dependent reference is never remapped to a value
    // Entra did not confirm.
    const subtypeRefusal = policyPostCreateRefusal(resource, reRead?.body ?? reRead);
    if (subtypeRefusal) {
      await noteOutcome(rollbackClient, journal, 'uncertain', { targetId, postState: reRead?.body ?? reRead, detail: 'created subtype did not verify' });
      failed.push({ naturalKey: resource.naturalKey, error: subtypeRefusal });
      continue;
    }

    const identifiers = createdIdentifiers(resource.resourceType, writeResult.body, reRead?.body ?? reRead);
    if (identifiers === false) {
      await noteOutcome(rollbackClient, journal, 'uncertain', { targetId, postState: reRead?.body ?? reRead, detail: 'created identifiers did not verify' });
      failed.push({ naturalKey: resource.naturalKey, error: `created ${resource.resourceType} ${targetId} did not read back the identifiers its create returned` });
      continue;
    }
    await noteOutcome(rollbackClient, journal, 'succeeded', { targetId, postState: reRead?.body ?? reRead });
    const entry = identifiers ? { naturalKey: resource.naturalKey, targetId, identifiers } : { naturalKey: resource.naturalKey, targetId };
    if (policyCreate?.unknown.length > 0) entry.unwrittenFields = policyCreate.unknown;
    applied.push(entry);
  }

  if (signInPathGate) {
    const signInPathAfter = await snapshotSignInPath(signInPathGate.reader, {
      protectedPrincipalIds: signInPathGate.protectedPrincipalIds,
    });
    const gate = compareSignInPaths(signInPathBefore, signInPathAfter);
    if (!gate.allowed) {
      failed.push({ naturalKey: 'sign-in-path-gate', error: gate.reason, changed: gate.changed });
    }
  }

  return { applied, skipped, failed, notRemediable };
}

/** The collector projects group/user through a $select; the verify re-read has none, so Graph
 * returns its full default projection with uncaptured properties set to null. For restore purposes
 * a null-valued property is unset, so absent-vs-null is a projection artifact, not drift. Applied
 * symmetrically to both sides so it cannot blind drift in either direction; NOT applied to
 * canonicalHash, whose output is persisted as payload_hash. Top-level only — canonicalize()
 * already strips server-owned fields recursively. */
// Roadmap task-71: a field an incident assessment excluded as malicious is never
// written, so post-write verification compares only what the plan writes: those exact
// paths are left out of the live side. Every other field still verifies, and the
// excluded value itself is checked separately after recovery (incident post-restore
// checks). A no-op for every resource without exclusions.
function forVerification(value, resource) {
  const paths = resource.excludedFields;
  if (!paths?.length || !value || typeof value !== 'object') return value;
  let out = value;
  for (const path of paths) out = withoutPath(out, String(path).split('.'));
  return out;
}

function withoutFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const field of fields) delete out[field];
  return out;
}

function onlyFields(value, shape) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const key of Object.keys(shape ?? {})) if (Object.hasOwn(value, key)) out[key] = value[key];
  return out;
}

// null: the type declares no alternate identifiers. false: they did not verify.
function createdIdentifiers(resourceType, created, live) {
  const names = ALTERNATE_IDENTIFIERS[resourceType];
  if (!names) return null;
  const identifiers = {};
  for (const name of names) {
    const value = created?.[name];
    if (typeof value !== 'string' || value.length === 0 || live?.[name] !== value) return false;
    identifiers[name] = value;
  }
  return identifiers;
}

function withoutPath(value, [head, ...rest]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, head)) return value;
  const copy = { ...value };
  if (rest.length === 0) delete copy[head];
  else copy[head] = withoutPath(copy[head], rest);
  return copy;
}

function withoutNulls(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (value[key] !== null && value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function residualDiff(desired, live, resourceType) {
  const paths = [];
  collectResidualPaths(
    canonicalize(desired, resourceType),
    canonicalize(live, resourceType),
    '',
    paths,
  );
  return paths;
}

function collectResidualPaths(desired, live, path, paths) {
  if (isDeepStrictEqual(desired, live)) return;

  if (Array.isArray(desired) || Array.isArray(live)) {
    const desiredItems = Array.isArray(desired) ? desired : [];
    const liveItems = Array.isArray(live) ? live : [];
    const length = Math.max(desiredItems.length, liveItems.length);
    for (let index = 0; index < length; index += 1) {
      collectResidualPaths(desiredItems[index], liveItems[index], path ? `${path}.${index}` : String(index), paths);
    }
    return;
  }

  if (
    (desired && typeof desired === 'object')
    || (live && typeof live === 'object')
  ) {
    const desiredObject = desired && typeof desired === 'object' ? desired : {};
    const liveObject = live && typeof live === 'object' ? live : {};
    const keys = new Set([...Object.keys(desiredObject), ...Object.keys(liveObject)]);
    for (const key of keys) {
      collectResidualPaths(
        desiredObject[key],
        liveObject[key],
        path ? `${path}.${key}` : key,
        paths,
      );
    }
    return;
  }

  if (path) paths.push(path);
}

/** Spec §8.4 — second phase of the two-phase apply. Each patch re-adds the field that was
 * omitted to break a cycle, once every node it depends on exists. */
export async function applyPatches(writer, governor, patches, {
  targetTenant,
  mode,
  appliedIds,
  readAfterWriteOptions,
  throttleRetryOptions,
}) {
  const applied = [];
  const failed = [];
  const retryOperation = (operation) => retryThrottledGraphOperation(operation, {
    governor,
    targetTenant,
    operationClass: 'write',
    ...throttleRetryOptions,
  });

  for (const patch of patches) {
    if (!appliedIds.has(patch.symbol)) {
      failed.push({ naturalKey: patch.naturalKey, reason: `patch symbol ${patch.symbol} was never applied` });
      return { applied, failed };
    }

    const targetId = appliedIds.get(patch.symbol);
    const resourceType = patch.resourceType ?? patch.naturalKey.split(':', 1)[0];
    const patchId = appliedIds.get(patch.naturalKey);
    if (!patchId) {
      failed.push({ naturalKey: patch.naturalKey, reason: `patch target ${patch.naturalKey} was never applied` });
      return { applied, failed };
    }

    // A deferred reference patch is a PATCH — the same write capability an
    // 'update' verb requires. Fail closed before any writer call here too.
    const patchCapability = verbCapability(resourceType, 'update');
    if (!patchCapability.supported) {
      failed.push({
        naturalKey: patch.naturalKey,
        reason: `unsupported operation: ${resourceType} update is not a registered write capability (claim: ${patchCapability.capability?.claim ?? 'unsupported'})`,
      });
      return { applied, failed };
    }

    // Roadmap task-108: a policy-governed type has no proven deferred-reference
    // patch (its records name whole-object writes only), so none is sent.
    if (isPolicyGoverned(resourceType) || isAdministrativeGoverned(resourceType)) {
      failed.push({ naturalKey: patch.naturalKey, reason: `unsupported operation: no proven deferred reference patch for ${resourceType}` });
      return { applied, failed };
    }

    let body = setAtPath({}, patch.field, targetId);
    if (resourceType === 'conditionalAccessPolicy') body = enforceReportOnly(body);

    if (mode === 'dry-run') {
      applied.push({ naturalKey: patch.naturalKey, targetId: patchId });
      continue;
    }

    const writeResult = await retryOperation(() => writer.write('v1.0', `${pathFor(resourceType)}/${patchId}`, { method: 'PATCH', body }));
    if (!writeResult.ok) {
      failed.push(graphFailure(patch.naturalKey, writeResult));
      return { applied, failed };
    }

    const path = `${pathFor(resourceType)}/${patchId}`;
    const reRead = await readAfterWrite(writer, 'v1.0', path, (result) => {
      if (isNotFound(result)) return true;
      if (!result?.ok) return false;
      const actual = valueAtPath(result.body ?? result, patch.field);
      // A missing value or the source-tenant value is the observed
      // read-after-write lag signature. An unexpected third value is a real
      // mismatch and is not retried as though it were staleness.
      return actual === undefined || ('sourceValue' in patch && isDeepStrictEqual(actual, patch.sourceValue));
    }, { ...readAfterWriteOptions, retryOperation });
    if (reRead?.ok === false) {
      failed.push(graphFailure(patch.naturalKey, reRead));
      return { applied, failed };
    }
    const actual = valueAtPath(reRead?.body ?? reRead, patch.field);
    if (!isDeepStrictEqual(actual, targetId)) {
      failed.push({
        naturalKey: patch.naturalKey,
        error: `deferred reference at ${patch.field} did not verify as ${targetId}`,
      });
      return { applied, failed };
    }

    applied.push({ naturalKey: patch.naturalKey, targetId: patchId });
  }

  return { applied, failed };
}

/** Sourced from engine/coverage/capabilities.mjs's registry (roadmap
 * task-52) — the single place a resourceType's write path is declared.
 * This is a defensive fallback only: verbCapability() above already refuses
 * an unregistered (resourceType, verb) pair before any call site below is
 * reached. */
function pathFor(resourceType) {
  const path = graphPathFor(resourceType);
  if (!path) throw new Error(`no write path for resource type ${resourceType}`);
  return path;
}
