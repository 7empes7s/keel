import { enforceReportOnly } from '../safety/conditionalAccessGuard.mjs';
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';

/** Spec §7.1, §9.3, §11.5. An apply is not complete until verify() reads the
 * state back and confirms it — this function is where that rule lives. */
export async function applyWave(writer, governor, wave, { targetTenant, mode, existingTargetIds = new Map() }) {
  const applied = [];
  const skipped = [];
  const failed = [];

  for (const resource of wave) {
    const syncCheck = refuseIfSynced(resource);
    if (syncCheck.refused) { skipped.push({ naturalKey: resource.naturalKey, reason: syncCheck.reason }); continue; }

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

  return { applied, skipped, failed };
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
