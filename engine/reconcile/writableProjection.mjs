import { isDeepStrictEqual } from 'node:util';
import { fieldClass } from '../cir/serverOwned.mjs';

/** Spec M2.4.2. Leaves only what Graph accepts in a PATCH body: drops serverOwned AND
 * immutable fields, using engine/cir/serverOwned.mjs as the single source of truth.
 * Do NOT define a second field list here — one definition, two consumers (Task 1). */
export function writableProjection(payload, resourceType) {
  // Validate the type even for an empty payload: unknown types must not be
  // allowed to reach Graph with a pass-through PATCH body.
  fieldClass('', resourceType);

  return project(payload, resourceType);
}

function project(value, resourceType, path = '') {
  if (Array.isArray(value)) {
    return value.map((item) => project(item, resourceType, path));
  }
  if (value && typeof value === 'object') {
    const projected = {};
    for (const key of Object.keys(value)) {
      const dottedPath = path ? `${path}.${key}` : key;
      if (fieldClass(dottedPath, resourceType) !== 'writable') continue;
      projected[key] = project(value[key], resourceType, dottedPath);
    }
    return projected;
  }
  return value;
}

export function immutableDrift(desired, live, resourceType) {
  // Validate the type even when both objects are empty.
  fieldClass('', resourceType);

  const drift = [];
  collectImmutableDrift(desired, live, resourceType, '', drift);
  return drift;
}

function collectImmutableDrift(desired, live, resourceType, path, drift) {
  if (path && fieldClass(path, resourceType) === 'immutable') {
    if (!isDeepStrictEqual(desired, live)) drift.push(path);
    return;
  }

  if (Array.isArray(desired) || Array.isArray(live)) {
    const desiredItems = Array.isArray(desired) ? desired : [];
    const liveItems = Array.isArray(live) ? live : [];
    const length = Math.max(desiredItems.length, liveItems.length);
    for (let index = 0; index < length; index += 1) {
      collectImmutableDrift(desiredItems[index], liveItems[index], resourceType, path, drift);
    }
    return;
  }

  if (
    (desired && typeof desired === 'object')
    || (live && typeof live === 'object')
  ) {
    const keys = new Set([
      ...Object.keys(desired && typeof desired === 'object' ? desired : {}),
      ...Object.keys(live && typeof live === 'object' ? live : {}),
    ]);
    for (const key of keys) {
      const dottedPath = path ? `${path}.${key}` : key;
      collectImmutableDrift(
        desired && typeof desired === 'object' ? desired[key] : undefined,
        live && typeof live === 'object' ? live[key] : undefined,
        resourceType,
        dottedPath,
        drift,
      );
    }
  }
}
