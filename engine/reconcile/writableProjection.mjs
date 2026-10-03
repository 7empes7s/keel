import { isDeepStrictEqual } from 'node:util';
import { fieldClass } from '../cir/serverOwned.mjs';
import { classifyForOperation, reviewStateFor } from '../contracts/fieldProjection.mjs';

/** Spec M2.3/M2.4.2 (roadmap task-51). Leaves only what Graph accepts in a PATCH
 * body: drops serverOwned and immutable fields via classifyForOperation('update', ...),
 * which resolves through engine/cir/serverOwned.mjs's fieldClass() as the single
 * source of truth and additionally narrows a writable field outside a reviewed
 * type's known-field list to 'unknown' (excluded here, reported by unknownFields()
 * below) instead of letting an unrecognized field silently become writable. */
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
      if (classifyForOperation('update', dottedPath, resourceType) !== 'writable') continue;
      projected[key] = project(value[key], resourceType, dottedPath);
    }
    return projected;
  }
  return value;
}

/**
 * Top-level fields of `payload` that a reviewed type's known-field list does
 * not name — excluded from writableProjection's output above and surfaced
 * here so a caller can flag them for review instead of the field silently
 * vanishing from every future write. An unreviewed type (no field-projection
 * registration) returns null: without a reviewed known-field list there is
 * nothing to compare against, so the question is unanswered, not answered
 * with an empty list.
 */
export function unknownFields(payload, resourceType) {
  fieldClass('', resourceType);
  if (reviewStateFor(resourceType) === 'unreviewed') return null;
  return Object.keys(payload ?? {})
    .filter((key) => classifyForOperation('update', key, resourceType) === 'unknown');
}

/**
 * Roadmap task-108: the top-level fields a create body may carry for a reviewed
 * type, and the ones it may not. serverOwned fields are dropped silently (Graph
 * assigns them); a field outside the reviewed knownFields list is 'unknown' and
 * is dropped AND returned in `unknown`, so the caller reports it instead of the
 * field vanishing from the restored object. An unreviewed type has no
 * known-field list to project against and throws: its create body would be a
 * pass-through.
 */
export function createProjection(payload, resourceType) {
  fieldClass('', resourceType);
  if (reviewStateFor(resourceType) === 'unreviewed') {
    throw new Error(`${resourceType}: no reviewed field projection, so no create body can be projected`);
  }
  const body = {};
  const unknown = [];
  for (const key of Object.keys(payload ?? {})) {
    const cls = classifyForOperation('create', key, resourceType);
    if (cls === 'writable') body[key] = payload[key];
    else if (cls === 'unknown') unknown.push(key);
  }
  return { body, unknown };
}

/**
 * Roadmap task-109: compares two name/value lists (a directory setting's
 * `values`) by name, never by position. Returns
 *   duplicates     — names the desired list repeats;
 *   undefinedNames — desired names the live list does not define;
 *   unobserved     — live names the desired list never observed;
 *   changed        — names present in both whose values differ.
 * A missing list reads as empty, so nothing is ever inferred from absence.
 */
export function namedValueDrift(desired, live) {
  const asList = (values) => (Array.isArray(values) ? values : []);
  const desiredList = asList(desired);
  const liveByName = new Map(asList(live).map((entry) => [entry?.name, entry?.value]));
  const seen = new Set();
  const duplicates = [];
  const undefinedNames = [];
  const changed = [];
  for (const entry of desiredList) {
    const name = entry?.name;
    if (seen.has(name)) { duplicates.push(name); continue; }
    seen.add(name);
    if (!liveByName.has(name)) undefinedNames.push(name);
    else if (!isDeepStrictEqual(entry?.value ?? null, liveByName.get(name) ?? null)) changed.push(name);
  }
  const unobserved = [...liveByName.keys()].filter((name) => !seen.has(name));
  return { duplicates, undefinedNames, unobserved, changed };
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
