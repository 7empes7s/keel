// engine/restore/plannedIds.mjs
//
// A dry run writes nothing, so an object it plans to create has no target id
// yet. A later write in the same run that references that object (a service
// principal naming a recreated app's appId, a role assignment naming a
// recreated group) would otherwise fail to resolve and fail the whole dry run.
// The dry run instead records a placeholder id for each planned create: the
// dependent write plans cleanly against it, and the dry run reports it.
//
// A placeholder is never a value Graph would accept, and an enforce run never
// records one. applyWave and applyPatches refuse to run anything but a dry run
// while a placeholder is in the run's id map, so one can never be written.
import { ALTERNATE_IDENTIFIERS } from '../coverage/qualification.mjs';

export const PLANNED_ID_PREFIX = 'planned:';

const NOT_CREATES = new Set(['noop', 'delete', 'update', 'restore-soft-deleted']);

export function isPlannedId(value) {
  return typeof value === 'string' && value.startsWith(PLANNED_ID_PREFIX);
}

/** The placeholder for a planned create, or for one of its alternate identifiers. */
export function plannedId(naturalKey, identifier = null) {
  return `${PLANNED_ID_PREFIX}${naturalKey}${identifier ? `#${identifier}` : ''}`;
}

/**
 * Records a placeholder for every create a dry-run wave planned: its object id
 * under `<naturalKey>`, and each alternate identifier its type reports on a
 * real create (an application's appId) under `<naturalKey>#<name>`. Only an
 * applied entry with no target id whose resource is a create counts, and a
 * value already known is never replaced. Does nothing outside a dry run.
 */
export function recordPlannedCreates(appliedIds, applied, wave, mode) {
  if (mode !== 'dry-run') return;
  const planned = new Map((wave ?? []).map((resource) => [resource.naturalKey, resource]));
  for (const { naturalKey, targetId } of applied ?? []) {
    const resource = planned.get(naturalKey);
    if (targetId || !resource || NOT_CREATES.has(resource.verb)) continue;
    if (!appliedIds.has(naturalKey)) appliedIds.set(naturalKey, plannedId(naturalKey));
    const resourceType = resource.resourceType ?? naturalKey.split(':', 1)[0];
    for (const name of ALTERNATE_IDENTIFIERS[resourceType] ?? []) {
      const key = `${naturalKey}#${name}`;
      if (!appliedIds.has(key)) appliedIds.set(key, plannedId(naturalKey, name));
    }
  }
}

/** Fails closed when a placeholder could reach anything but a dry run. */
export function assertNoPlannedIds(appliedIds, mode) {
  if (mode === 'dry-run' || !appliedIds) return;
  for (const [key, value] of appliedIds) {
    if (isPlannedId(value)) {
      throw new Error(`refusing to write: ${key} holds the dry-run placeholder ${value}, which is never a target id`);
    }
  }
}

/** True when `value` holds a placeholder anywhere (a rewritten reference). */
export function holdsPlannedId(value) {
  if (isPlannedId(value)) return true;
  if (Array.isArray(value)) return value.some(holdsPlannedId);
  if (value && typeof value === 'object') return Object.values(value).some(holdsPlannedId);
  return false;
}
