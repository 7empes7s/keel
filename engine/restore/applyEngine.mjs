import { enforceReportOnly } from '../safety/conditionalAccessGuard.mjs';
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';
import { refuseUnsafeDeletion } from '../safety/deletionGuard.mjs';
import { canonicalHash, canonicalize } from '../cir/canonicalHash.mjs';
import { immutableDrift, writableProjection } from '../reconcile/writableProjection.mjs';
import { verbCapability } from '../reconcile/verb.mjs';
import { graphPathFor } from '../coverage/capabilities.mjs';
import { recordPriorState } from './rollbackJournal.mjs';
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
  const failure = { naturalKey, error: JSON.stringify(result?.body ?? result?.error) };
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

async function journalBeforeMutation(rollbackClient, { runId, naturalKey, priorState }) {
  if (!rollbackClient) return true;
  try {
    await recordPriorState(rollbackClient, { runId, naturalKey, priorState });
    return true;
  } catch {
    return false;
  }
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
  simulationPassed = false,
  signInPathGate,
  throttleRetryOptions,
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
    const capabilityGate = verbCapability(resource.resourceType, effectiveVerb);
    if (!capabilityGate.supported) {
      failed.push({
        naturalKey: resource.naturalKey,
        error: `unsupported operation: ${resource.resourceType} ${effectiveVerb} is not a registered write capability (claim: ${capabilityGate.capability?.claim ?? 'unsupported'})`,
      });
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

      const journaled = await journalBeforeMutation(rollbackClient, {
        runId,
        naturalKey: resource.naturalKey,
        priorState: resource.live?.payload ?? resource.payload,
      });
      if (!journaled) {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to delete: rollback journal write failed' });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const deleteResult = await retryOperation(() => writer.write('v1.0', path, { method: 'DELETE', body: {} }));
      if (!deleteResult.ok) {
        failed.push(graphFailure(resource.naturalKey, deleteResult));
        continue;
      }

      const reRead = await readAfterWrite(writer, 'v1.0', path, (r) => r?.ok === true && r.body?.deletedDateTime == null, { retryOperation });
      const isAbsent = reRead?.ok === false && reRead.status === 404;
      const live = reRead?.body ?? reRead;
      const isSoftDeleted = live?.deletedDateTime != null;
      if (!isAbsent && !isSoftDeleted) {
        failed.push({ naturalKey: resource.naturalKey, error: 'delete did not verify as absent or soft-deleted' });
        continue;
      }

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
      try {
        desired = rewriteReferences(desired, resource.references, referenceContext, resource.naturalKey);
      } catch (err) {
        failed.push({ naturalKey: resource.naturalKey, error: err.message });
        continue;
      }

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const journaled = await journalBeforeMutation(rollbackClient, {
        runId,
        naturalKey: resource.naturalKey,
        priorState: resource.live?.payload ?? resource.payload,
      });
      if (!journaled) {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to restore: rollback journal write failed' });
        continue;
      }

      const restoreResult = await retryOperation(() => writer.write(
        'v1.0',
        `/directory/deletedItems/${deletedItemId}/restore`,
        { method: 'POST', body: {} },
      ));
      if (!restoreResult.ok) {
        failed.push(graphFailure(resource.naturalKey, restoreResult));
        continue;
      }
      if (restoreResult.body?.id !== targetId) {
        failed.push({
          naturalKey: resource.naturalKey,
          error: 'restore returned a different objectId — references would be broken',
        });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const reRead = await readAfterWrite(writer, 'v1.0', path, isNotFound, { retryOperation });
      if (reRead?.ok === false) {
        failed.push(graphFailure(resource.naturalKey, reRead));
        continue;
      }
      let live = reRead?.body ?? reRead;
      if (canonicalHash(live, resource.resourceType) === canonicalHash(desired, resource.resourceType)) {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const payload = writableProjection(desired, resource.resourceType);
      const updateResult = await retryOperation(() => writer.write('v1.0', path, { method: 'PATCH', body: payload }));
      if (!updateResult.ok) {
        failed.push(graphFailure(resource.naturalKey, updateResult));
        continue;
      }

      const updateReRead = await readAfterWrite(writer, 'v1.0', path, (r) =>
        isNotFound(r) || (r?.ok === true && canonicalHash(r.body, resource.resourceType) !== canonicalHash(desired, resource.resourceType)), { retryOperation });
      if (updateReRead?.ok === false) {
        failed.push(graphFailure(resource.naturalKey, updateReRead));
        continue;
      }
      live = updateReRead?.body ?? updateReRead;
      if (canonicalHash(live, resource.resourceType) !== canonicalHash(desired, resource.resourceType)) {
        const residual = residualDiff(desired, live, resource.resourceType);
        const immutable = immutableDrift(desired, live, resource.resourceType);
        if (residual.length > 0 && residual.every((path) => immutable.some(
          (immutablePath) => path === immutablePath || path.startsWith(`${immutablePath}.`),
        ))) {
          notRemediable.push({ naturalKey: resource.naturalKey, status: 'not-remediable', immutable });
          continue;
        }
        failed.push({ naturalKey: resource.naturalKey, error: 'residual drift after update', residual });
        continue;
      }

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
      try {
        desired = rewriteReferences(desired, resource.references, referenceContext, resource.naturalKey);
      } catch (err) {
        failed.push({ naturalKey: resource.naturalKey, error: err.message });
        continue;
      }
      const normalisedDesired = withoutNulls(desired);
      const payload = writableProjection(desired, resource.resourceType);

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const journaled = await journalBeforeMutation(rollbackClient, {
        runId,
        naturalKey: resource.naturalKey,
        priorState: resource.live?.payload ?? resource.payload,
      });
      if (!journaled) {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to update: rollback journal write failed' });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const writeResult = await writeAfterCreate(writer, 'v1.0', path, { method: 'PATCH', body: payload }, { retryOperation });
      if (!writeResult.ok) {
        failed.push(graphFailure(resource.naturalKey, writeResult));
        continue;
      }

      const reRead = await readAfterWrite(writer, 'v1.0', path, (r) =>
        isNotFound(r) || (r?.ok === true && canonicalHash(withoutNulls(r.body), resource.resourceType) !== canonicalHash(normalisedDesired, resource.resourceType)), { retryOperation });
      if (reRead?.ok === false) {
        failed.push(graphFailure(resource.naturalKey, reRead));
        continue;
      }
      const live = withoutNulls(reRead?.body ?? reRead);
      if (canonicalHash(live, resource.resourceType) !== canonicalHash(normalisedDesired, resource.resourceType)) {
        const residual = residualDiff(normalisedDesired, live, resource.resourceType);
        const immutable = immutableDrift(normalisedDesired, live, resource.resourceType);
        if (residual.length > 0 && residual.every((path) => immutable.some(
          (immutablePath) => path === immutablePath || path.startsWith(`${immutablePath}.`),
        ))) {
          notRemediable.push({ naturalKey: resource.naturalKey, status: 'not-remediable', immutable });
          continue;
        }
        failed.push({ naturalKey: resource.naturalKey, error: 'residual drift after update', residual });
        continue;
      }

      applied.push({ naturalKey: resource.naturalKey, targetId });
      continue;
    }

    let payload = resource.payload;
    if (resource.resourceType === 'conditionalAccessPolicy') payload = enforceReportOnly(payload);
    try {
      payload = rewriteReferences(payload, resource.references, referenceContext, resource.naturalKey);
    } catch (err) {
      failed.push({ naturalKey: resource.naturalKey, error: err.message });
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
      const actualHash = canonicalHash(reRead?.body ?? reRead, resource.resourceType);
      const desiredHash = canonicalHash(payload, resource.resourceType);
      if (actualHash === desiredHash) { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      failed.push({ naturalKey: resource.naturalKey, error: `conflict: ${existingId} exists in target but actual hash ${actualHash} does not match desired hash ${desiredHash} — manual reconciliation required` });
      continue;
    }

    if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: null }); continue; }

    const journaled = await journalBeforeMutation(rollbackClient, {
      runId,
      naturalKey: resource.naturalKey,
      priorState: null,
    });
    if (!journaled) {
      failed.push({ naturalKey: resource.naturalKey, error: 'refusing to create: rollback journal write failed' });
      continue;
    }

    const path = pathFor(resource.resourceType);
    const writeResult = await retryOperation(() => writer.write('v1.0', path, { method: 'POST', body: payload }));
    if (!writeResult.ok) { failed.push(graphFailure(resource.naturalKey, writeResult)); continue; }

    const targetId = writeResult.body.id;
    const reRead = await readAfterWrite(writer, 'v1.0', `${path}/${targetId}`, isNotFound, { retryOperation });
    if (reRead?.ok === false) {
      failed.push(graphFailure(resource.naturalKey, reRead));
      continue;
    }
    const actualHash = canonicalHash(reRead?.body ?? reRead, resource.resourceType);
    const desiredHash = canonicalHash(payload, resource.resourceType);
    if (actualHash !== desiredHash) {
      failed.push({ naturalKey: resource.naturalKey, error: `verification hash mismatch after write to ${targetId}: actual hash ${actualHash}, desired hash ${desiredHash}` });
      continue;
    }

    applied.push({ naturalKey: resource.naturalKey, targetId });
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
