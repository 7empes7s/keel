/**
 * Issue #994: the restore approval effects of two sign-in settings, judged
 * from the whole planned resource (contentEffects.mjs CONTENT_EFFECT_RULES
 * `effectsOf`), because what they change depends on more than the object:
 *
 *  - an authentication context (c1..c99): making it available or unavailable
 *    changes sign-in only when something uses it. The restore plan attaches
 *    what uses it (`authenticationContextConsumers`, from
 *    restore/signInSettingsOperations.mjs); when that is not known, it is
 *    treated as used;
 *  - a staged rollout: which sign-in feature it rolls out, to the whole
 *    organization or to groups (`rolloutAppliesTo`, attached by the plan), and
 *    whether it is on. Every change to those is an effect.
 *
 * Pure: no imports, no clock, no network. Each effect is
 * { field, effect: 'changes-sign-in', before, after }.
 */

export const SIGN_IN_EFFECT = 'changes-sign-in';

const present = (resource) => resource?.live?.state === 'present' || resource?.live?.state === 'soft-deleted';
const normal = (value) => (value === undefined ? null : value);
const sortedNames = (names) => [...new Set((names ?? []).map(String))].sort((left, right) => left.localeCompare(right));

/**
 * True unless the plan proved nothing uses the context: no Conditional Access
 * policy in the backup or live names it, and the live read worked.
 */
export function contextInUse(resource) {
  return resource?.authenticationContextConsumers?.inUse !== false;
}

export function authenticationContextEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const after = resource.payload.isAvailable;
  if (after === undefined || !contextInUse(resource)) return [];
  const before = present(resource) ? normal(resource.live.payload?.isAvailable) : null;
  return before === after ? [] : [{ field: 'isAvailable', effect: SIGN_IN_EFFECT, before, after }];
}

/** The group names a rollout's appliesTo read holds, or null when the read is not complete. */
export function rolloutGroupNames(observation) {
  if (!observation || !['complete', 'complete-empty'].includes(observation.outcome)) return null;
  return sortedNames((observation.groups ?? []).map((group) => group.name));
}

/**
 * The groups the restore would add to a rollout (add-only): in the backup's
 * complete read and not in the live one. A create adds them all. Null when
 * either read is not complete, so nothing is added.
 */
export function rolloutGroupsToAdd(resource) {
  const desired = rolloutGroupNames(resource?.rolloutAppliesTo?.desired);
  if (!desired) return null;
  if (!present(resource)) return desired;
  const live = rolloutGroupNames(resource.rolloutAppliesTo?.live);
  if (!live) return null;
  const have = new Set(live.map((name) => name.toLowerCase()));
  return desired.filter((name) => !have.has(name.toLowerCase()));
}

export function featureRolloutEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const before = present(resource) ? (resource.live.payload ?? {}) : null;
  const effects = [];
  for (const field of ['feature', 'isAppliedToOrganization']) {
    const after = resource.payload[field];
    if (after === undefined) continue;
    const was = before ? normal(before[field]) : null;
    if (was !== after) effects.push({ field, effect: SIGN_IN_EFFECT, before: was, after });
  }
  const added = rolloutGroupsToAdd(resource);
  if (added && added.length > 0) {
    const live = before ? (rolloutGroupNames(resource.rolloutAppliesTo?.live) ?? []) : [];
    effects.push({ field: 'appliesTo', effect: SIGN_IN_EFFECT, before: live, after: sortedNames([...live, ...added]) });
  }
  // A recreated rollout lands switched off, so its "before" is off.
  const on = resource.payload.isEnabled;
  const wasOn = before ? before.isEnabled === true : false;
  if (typeof on === 'boolean' && on !== wasOn) effects.push({ field: 'isEnabled', effect: SIGN_IN_EFFECT, before: wasOn, after: on });
  return effects;
}
