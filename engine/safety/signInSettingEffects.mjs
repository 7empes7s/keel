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

/** What a 'changes-sign-in' approval says, before the "not backed up" disclosure (contentEffects.mjs). */
export const SIGN_IN_DISCLOSURE = 'This changes how people sign in: whether Conditional Access can ask for an authentication context, '
  + 'which sign-in feature (such as cloud authentication instead of federation) is rolled out to whom, '
  + 'how long everyone can stay idle before being signed out (the organization default idle sign-out policy), '
  + 'or which apps\' sign-ins call a custom authentication extension and which claims it adds to their tokens. '
  + 'People may be asked for other sign-in methods, may stop being asked, or may not be able to sign in until it is set right. '
  + 'Check the change with the person who owns sign-in before approving.';

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

/** A definition entry without its spacing, so only a changed timeout is a change. */
const parsedEntry = (entry) => {
  try { return JSON.stringify(JSON.parse(entry)); } catch { return entry; }
};
const comparable = (field, value) => (field === 'definition' && Array.isArray(value) ? value.map(parsedEntry) : normal(value));

/**
 * Issue #1008: an idle sign-out policy applies only as the organization default,
 * which signs out every user of every app after the idle time. A write whose
 * backup was the default (the writer puts it into the live default) or whose live
 * object is the default changes sign-in for everyone: its name and definition are
 * each an effect.
 */
export function idleSignOutDefaultEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const before = present(resource) ? (resource.live.payload ?? {}) : null;
  if (resource.payload.isOrganizationDefault !== true && before?.isOrganizationDefault !== true) return [];
  const effects = [];
  for (const field of ['displayName', 'definition']) {
    const after = resource.payload[field];
    if (after === undefined) continue;
    const was = before ? normal(before[field]) : null;
    if (JSON.stringify(comparable(field, was)) !== JSON.stringify(comparable(field, after))) effects.push({ field, effect: SIGN_IN_EFFECT, before: was, after });
  }
  return effects;
}

/** Issue #1072: the claims a token issuance extension adds, by their name in the API's answer, sorted. */
export const tokenClaimIds = (payload) => sortedNames((payload?.claimsForTokenConfiguration ?? []).map((claim) => claim?.claimIdInApiResponse).filter(Boolean));

/**
 * Issue #1072: a custom authentication extension's token claims are what its
 * API's answer adds to every token of the apps whose listener calls it, so a
 * change to them changes sign-in. Its name and description do not.
 */
export function customAuthenticationExtensionEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete' || resource.payload.claimsForTokenConfiguration === undefined) return [];
  const after = tokenClaimIds(resource.payload);
  const before = present(resource) ? tokenClaimIds(resource.live.payload) : null;
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ field: 'claimsForTokenConfiguration', effect: SIGN_IN_EFFECT, before, after }];
}

/** Issue #1072: the apps a listener applies to (their app ids, sorted), or ['all apps']. */
export function listenerApps(payload) {
  const applications = payload?.conditions?.applications;
  if (applications?.includeAllApplications === true) return ['all apps'];
  return sortedNames((applications?.includeApplications ?? []).map((app) => app?.appId).filter(Boolean));
}

/** Issue #1072: the custom authentication extension a listener calls, by name (a list read expands it), or null. */
export const listenerExtensionName = (payload) => {
  const name = payload?.handler?.customExtension?.displayName;
  return typeof name === 'string' && name.length > 0 ? name : null;
};

/**
 * Issue #1072: an authentication event listener decides which apps' sign-ins
 * call which custom authentication extension, and in which order. Which apps,
 * which extension (by name) and its priority are each an effect, judged on
 * create too: a recreated listener starts calling the extension at once.
 */
export function authenticationEventListenerEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const live = present(resource) ? (resource.live.payload ?? {}) : null;
  const views = {
    conditions: (payload) => (payload?.conditions === undefined ? undefined : listenerApps(payload)),
    handler: (payload) => (payload?.handler === undefined ? undefined : listenerExtensionName(payload) ?? normal(payload.handler?.customExtension?.id)),
    priority: (payload) => payload?.priority,
  };
  const effects = [];
  for (const [field, view] of Object.entries(views)) {
    const after = view(resource.payload);
    if (after === undefined || after === null) continue;
    const before = live ? normal(view(live)) : null;
    if (JSON.stringify(before) !== JSON.stringify(after)) effects.push({ field, effect: SIGN_IN_EFFECT, before, after });
  }
  return effects;
}
