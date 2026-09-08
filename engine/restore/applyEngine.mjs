import { enforceReportOnly } from '../safety/conditionalAccessGuard.mjs';
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';
import { refuseUnsafeDeletion } from '../safety/deletionGuard.mjs';
import { canonicalHash, canonicalize } from '../cir/canonicalHash.mjs';
import { immutableDrift, writableProjection } from '../reconcile/writableProjection.mjs';
import { recordPriorState } from './rollbackJournal.mjs';
import { isDeepStrictEqual } from 'node:util';

/** Empirically observed on this tenant: a read immediately after a write to the same object can
 * return 404 or a stale body for up to ~15-20s. Retries only the specific staleness signature the
 * caller names — never masks a genuine error. */
async function readAfterWrite(writer, version, path, isStale, { attempts = 6, delayMs = 3000 } = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await writer.read(version, path);
    if (!isStale(result)) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/** Same lag readAfterWrite retries on the read side — this tenant's write path can also 404 a
 * write to an object this session just created/mutated. Retries ONLY a 404. */
async function writeAfterCreate(writer, version, path, body, { attempts = 6, delayMs = 3000 } = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await writer.write(version, path, body);
    if (result.ok || result.status !== 404) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

const isNotFound = (result) => result?.ok === false && result?.status === 404;

/** Spec §7.1, §9.3, §11.5. An apply is not complete until it reads the state
 * back and confirms it — this function is where that rule lives. */
export async function applyWave(writer, governor, wave, {
  targetTenant,
  mode,
  existingTargetIds = new Map(),
  deletionGuardOptions = { breakGlassUserIds: [], keelAppIds: [], caPolicies: [] },
  rollbackClient,
  runId,
  simulationPassed = false,
}) {
  const applied = [];
  const skipped = [];
  const failed = [];
  const notRemediable = [];

  for (const resource of wave) {
    if (resource.verb === 'delete') {
      const deletionCheck = refuseUnsafeDeletion(resource, deletionGuardOptions);
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

      try {
        await recordPriorState(rollbackClient, {
          runId,
          naturalKey: resource.naturalKey,
          priorState: resource.payload,
        });
      } catch {
        failed.push({ naturalKey: resource.naturalKey, error: 'refusing to delete: rollback journal write failed' });
        continue;
      }

      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      await governor.acquire(targetTenant, 'entra', 'write');
      const deleteResult = await writer.write('v1.0', path, { method: 'DELETE', body: {} });
      if (!deleteResult.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(deleteResult.body) });
        continue;
      }

      const reRead = await readAfterWrite(writer, 'v1.0', path, (r) => r?.ok === true && r.body?.deletedDateTime == null);
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

    const syncCheck = refuseIfSynced(resource);
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

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      await governor.acquire(targetTenant, 'entra', 'write');
      const restoreResult = await writer.write(
        'v1.0',
        `/directory/deletedItems/${deletedItemId}/restore`,
        { method: 'POST', body: {} },
      );
      if (!restoreResult.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(restoreResult.body) });
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
      const reRead = await readAfterWrite(writer, 'v1.0', path, isNotFound);
      if (reRead?.ok === false) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(reRead.body ?? reRead.error) });
        continue;
      }
      let live = reRead?.body ?? reRead;
      if (canonicalHash(live, resource.resourceType) === canonicalHash(desired, resource.resourceType)) {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      const payload = writableProjection(desired, resource.resourceType);
      await governor.acquire(targetTenant, 'entra', 'write');
      const updateResult = await writer.write('v1.0', path, { method: 'PATCH', body: payload });
      if (!updateResult.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(updateResult.body) });
        continue;
      }

      const updateReRead = await readAfterWrite(writer, 'v1.0', path, (r) =>
        isNotFound(r) || (r?.ok === true && canonicalHash(r.body, resource.resourceType) !== canonicalHash(desired, resource.resourceType)));
      if (updateReRead?.ok === false) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(updateReRead.body ?? updateReRead.error) });
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
      const normalisedDesired = withoutNulls(desired);
      const payload = writableProjection(desired, resource.resourceType);

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      await governor.acquire(targetTenant, 'entra', 'write');
      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const writeResult = await writeAfterCreate(writer, 'v1.0', path, { method: 'PATCH', body: payload });
      if (!writeResult.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(writeResult.body) });
        continue;
      }

      const reRead = await readAfterWrite(writer, 'v1.0', path, (r) =>
        isNotFound(r) || (r?.ok === true && canonicalHash(withoutNulls(r.body), resource.resourceType) !== canonicalHash(normalisedDesired, resource.resourceType)));
      if (reRead?.ok === false) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(reRead.body ?? reRead.error) });
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

    const existingId = existingTargetIds.get(resource.naturalKey);
    if (existingId) {
      if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      const path = `${pathFor(resource.resourceType)}/${existingId}`;
      const reRead = await writer.read('v1.0', path);
      if (reRead?.ok === false) {
        failed.push({ naturalKey: resource.naturalKey, error: `conflict: ${existingId} exists in target but could not be read (status ${reRead.status}) — manual reconciliation required` });
        continue;
      }
      const actualHash = canonicalHash(reRead?.body ?? reRead, resource.resourceType);
      const desiredHash = canonicalHash(payload, resource.resourceType);
      if (actualHash === desiredHash) { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      failed.push({ naturalKey: resource.naturalKey, error: `conflict: ${existingId} exists in target but actual hash ${actualHash} does not match desired hash ${desiredHash} — manual reconciliation required` });
      continue;
    }

    if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: null }); continue; }

    await governor.acquire(targetTenant, 'entra', 'write');
    const path = pathFor(resource.resourceType);
    const writeResult = await writer.write('v1.0', path, { method: 'POST', body: payload });
    if (!writeResult.ok) { failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(writeResult.body) }); continue; }

    const targetId = writeResult.body.id;
    const reRead = await readAfterWrite(writer, 'v1.0', `${path}/${targetId}`, isNotFound);
    if (reRead?.ok === false) {
      failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(reRead.body ?? reRead.error) });
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
export async function applyPatches(writer, governor, patches, { targetTenant, mode, appliedIds }) {
  const applied = [];
  const failed = [];

  for (const patch of patches) {
    if (!appliedIds.has(patch.symbol)) {
      failed.push({ naturalKey: patch.naturalKey, reason: `patch symbol ${patch.symbol} was never applied` });
      continue;
    }

    const targetId = appliedIds.get(patch.symbol);
    const resourceType = patch.naturalKey.split(':', 1)[0];
    const patchId = appliedIds.get(patch.naturalKey);
    let body = { [patch.field]: targetId };
    if (resourceType === 'conditionalAccessPolicy') body = enforceReportOnly(body);

    if (mode === 'dry-run') {
      applied.push({ naturalKey: patch.naturalKey, targetId: patchId });
      continue;
    }

    await governor.acquire(targetTenant, 'entra', 'write');
    const writeResult = await writer.write('v1.0', `${pathFor(resourceType)}/${patchId}`, { method: 'PATCH', body });
    if (!writeResult.ok) {
      failed.push({ naturalKey: patch.naturalKey, error: JSON.stringify(writeResult.body) });
      continue;
    }

    applied.push({ naturalKey: patch.naturalKey, targetId: patchId });
  }

  return { applied, failed };
}

function pathFor(resourceType) {
  const paths = {
    group: '/groups',
    roleAssignment: '/roleManagement/directory/roleAssignments',
    namedLocation: '/identity/conditionalAccess/namedLocations',
    conditionalAccessPolicy: '/identity/conditionalAccess/policies',
  };
  const path = paths[resourceType];
  if (!path) throw new Error(`no write path for resource type ${resourceType}`);
  return path;
}
