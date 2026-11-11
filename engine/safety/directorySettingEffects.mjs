/**
 * Issue #1075: the restore approval effects of the Entra directory settings and
 * objects written by restore/directorySettingOperations.mjs and
 * restore/directoryObjectOperations.mjs, judged from the whole planned resource
 * (contentEffects.mjs CONTENT_EFFECT_RULES `effectsOf`). Each effect carries
 * `why`: what the write does, in plain words, for the dry run.
 *
 *  - a sign-in identifier turned on or off changes how everyone signs in;
 *  - a default cross-tenant capability (free/busy, mail tips, room booking)
 *    opened or closed changes what every other tenant sees;
 *  - a Verified ID profile's state, priority, Face Check and purposes decide how
 *    people prove who they are (account recovery, onboarding);
 *  - a lifecycle policy that is on acts on accounts by itself: its scope, action
 *    and grace period decide which accounts are disabled or deleted. A created
 *    policy is always off, so a create carries none.
 *
 * Pure: no clock, no network. Each effect is { field, effect, before, after, why }.
 */
import { SIGN_IN_EFFECT } from './signInSettingEffects.mjs';

const present = (resource) => resource?.live?.state === 'present' || resource?.live?.state === 'soft-deleted';
const normal = (value) => (value === undefined ? null : value);
const livePayload = (resource) => (present(resource) ? (resource.live.payload ?? {}) : null);
const differs = (left, right) => JSON.stringify(normal(left)) !== JSON.stringify(normal(right));

export function signInIdentifierEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete' || typeof resource.payload.isEnabled !== 'boolean') return [];
  const before = livePayload(resource)?.isEnabled ?? null;
  const after = resource.payload.isEnabled;
  if (before === after) return [];
  const name = resource.payload.name ?? 'this identifier';
  return [{
    field: 'isEnabled', effect: SIGN_IN_EFFECT, before, after,
    why: after
      ? `This lets everyone in the tenant sign in with their ${name} identifier again.`
      : `This stops everyone in the tenant signing in with their ${name} identifier: people who use it must sign in another way until it is turned back on.`,
  }];
}

/** The groups a capability's inbound access is limited to (or excluded from), by id, sorted. */
const scopeIds = (access, side) => (access?.resourceScopes?.[side] ?? []).map((scope) => `${scope?.resourceType ?? ''}:${String(scope?.resourceId ?? '').toLowerCase()}`).sort();

/** Whether two inboundAccess values limit the capability to the same groups. */
export const sameScopes = (desired, live) => ['included', 'excluded'].every((side) => !differs(scopeIds(desired, side), scopeIds(live, side)));

export function crossTenantCapabilityEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete' || resource.payload.inboundAccess === undefined) return [];
  const live = livePayload(resource);
  // A scope that differs is left for a person (the writer writes nothing), so it carries no effect.
  if (!sameScopes(resource.payload.inboundAccess, live?.inboundAccess)) return [];
  const before = normal(live?.inboundAccess?.isAllowed);
  const after = normal(resource.payload.inboundAccess?.isAllowed);
  if (before === after) return [];
  const name = resource.payload.name ?? 'this capability';
  return [{
    field: 'inboundAccess.isAllowed', effect: 'externally-sharing', before, after,
    why: after
      ? `This opens ${name} to people in every other organization by default (unless a partner setting says otherwise), so they can see what it shares, such as free/busy times or mail tips.`
      : `This closes ${name} to people in other organizations by default, so features they use with this tenant stop working for them.`,
  }];
}

const VERIFIED_ID_FIELDS = Object.freeze(['state', 'priority', 'faceCheckConfiguration', 'verifiedIdUsageConfigurations']);

export function verifiedIdProfileEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const live = livePayload(resource);
  const name = resource.payload.name ?? 'this profile';
  return VERIFIED_ID_FIELDS.filter((field) => resource.payload[field] !== undefined && differs(live?.[field], resource.payload[field]))
    .map((field) => ({
      field, effect: SIGN_IN_EFFECT, before: normal(live?.[field]), after: resource.payload[field],
      why: `This changes how people prove who they are with the Verified ID profile "${name}" (whether it is on, which comes first, Face Check, and whether it is used for account recovery or onboarding).`,
    }));
}

const LIFECYCLE_FIELDS = Object.freeze(['scope', 'enforcementAction', 'gracePeriodInDays']);

export function lifecyclePolicyEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const live = livePayload(resource);
  // A policy that is off acts on nobody; a restore never turns one on.
  if (live?.isEnabled !== true) return [];
  const name = resource.payload.displayName ?? 'this policy';
  return LIFECYCLE_FIELDS.filter((field) => resource.payload[field] !== undefined && differs(live[field], resource.payload[field]))
    .map((field) => ({
      field, effect: 'acts-on-accounts', before: normal(live[field]), after: resource.payload[field],
      why: `The lifecycle policy "${name}" is on: this changes which accounts it covers, what it does to them (disable or delete) or how long it waits first.`,
    }));
}

/** contentEffects.mjs CONTENT_EFFECT_RULES entries for these kinds. */
export const DIRECTORY_SETTING_EFFECT_RULES = Object.freeze({
  signInIdentifier: { reviewed: true, effectsOf: signInIdentifierEffects },
  crossTenantM365Capability: { reviewed: true, effectsOf: crossTenantCapabilityEffects },
  verifiedIdProfile: { reviewed: true, effectsOf: verifiedIdProfileEffects },
  lifecyclePolicy: { reviewed: true, effectsOf: lifecyclePolicyEffects },
});
