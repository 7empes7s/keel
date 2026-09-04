import { enforceReportOnly } from '../safety/conditionalAccessGuard.mjs';
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';
import { canonicalHash, canonicalize } from '../cir/canonicalHash.mjs';
import { immutableDrift, writableProjection } from '../reconcile/writableProjection.mjs';
import { isDeepStrictEqual } from 'node:util';

/** Spec §7.1, §9.3, §11.5. An apply is not complete until verify() reads the
 * state back and confirms it — this function is where that rule lives. */
export async function applyWave(writer, governor, wave, { targetTenant, mode, existingTargetIds = new Map() }) {
  const applied = [];
  const skipped = [];
  const failed = [];
  const notRemediable = [];

  for (const resource of wave) {
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
      const reRead = await writer.read('v1.0', path);
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

      const updateReRead = await writer.read('v1.0', path);
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
      const payload = writableProjection(desired, resource.resourceType);

      if (mode === 'dry-run') {
        applied.push({ naturalKey: resource.naturalKey, targetId });
        continue;
      }

      await governor.acquire(targetTenant, 'entra', 'write');
      const path = `${pathFor(resource.resourceType)}/${targetId}`;
      const writeResult = await writer.write('v1.0', path, { method: 'PATCH', body: payload });
      if (!writeResult.ok) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(writeResult.body) });
        continue;
      }

      const reRead = await writer.read('v1.0', path);
      if (reRead?.ok === false) {
        failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(reRead.body ?? reRead.error) });
        continue;
      }
      const live = reRead?.body ?? reRead;
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

    let payload = resource.payload;
    if (resource.resourceType === 'conditionalAccessPolicy') payload = enforceReportOnly(payload);

    const existingId = existingTargetIds.get(resource.naturalKey);
    if (existingId) {
      if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      const verified = await writer.verify(existingId);
      if (verified) { applied.push({ naturalKey: resource.naturalKey, targetId: existingId }); continue; }
      failed.push({ naturalKey: resource.naturalKey, error: `conflict: ${existingId} exists in target but does not verify() against the plan — manual reconciliation required` });
      continue;
    }

    if (mode === 'dry-run') { applied.push({ naturalKey: resource.naturalKey, targetId: null }); continue; }

    await governor.acquire(targetTenant, 'entra', 'write');
    const path = pathFor(resource.resourceType);
    const writeResult = await writer.write('v1.0', path, { method: 'POST', body: payload });
    if (!writeResult.ok) { failed.push({ naturalKey: resource.naturalKey, error: JSON.stringify(writeResult.body) }); continue; }

    const targetId = writeResult.body.id;
    const verified = await writer.verify(targetId);
    if (!verified) { failed.push({ naturalKey: resource.naturalKey, error: `verify() did not match after write to ${targetId}` }); continue; }

    applied.push({ naturalKey: resource.naturalKey, targetId });
  }

  return { applied, skipped, failed, notRemediable };
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
