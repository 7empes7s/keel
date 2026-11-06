/**
 * Issue #1015: the restore approval effects of writes that cannot be undone,
 * judged from the whole planned resource (contentEffects.mjs
 * CONTENT_EFFECT_RULES `effectsOf`):
 *
 *  - a custom security attribute set, or a custom security attribute, that a
 *    restore creates: Entra never deletes either once it exists;
 *  - turning on user sync from a partner tenant: the users it syncs in stay
 *    when sync is turned off again. It also changes who is in the tenant, so
 *    it is a "changes admin access" effect too.
 *
 * Each effect carries `why`: what stays, in plain words, for the dry run.
 * Pure: no imports, no clock, no network.
 */

export const PERMANENT_EFFECT = 'permanent';

const present = (resource) => resource?.live?.state === 'present' || resource?.live?.state === 'soft-deleted';

function attributeCreateWhy(resource) {
  const payload = resource.payload ?? {};
  if (resource.resourceType === 'attributeSet') {
    return `Entra never deletes a custom security attribute set: once "${payload.id}" is made it stays in the tenant for good, `
      + 'and only its description and how many attributes it can hold can be changed later.';
  }
  return `Entra never deletes a custom security attribute: once "${payload.name}" is made in the attribute set "${payload.attributeSet}" it stays for good `
    + '(it can only be deactivated), and its name, type and whether it holds more than one value can never be changed. '
    + 'Its allowed values can only be deactivated, never removed.';
}

/** A create of an attribute set or attribute: one permanent effect. Updates carry none. */
export function attributeCreateEffects(resource) {
  if (resource?.verb !== 'create' || !resource.payload || present(resource)) return [];
  const name = resource.resourceType === 'attributeSet' ? resource.payload.id : resource.payload.name;
  return [{ field: '(object created)', effect: PERMANENT_EFFECT, before: null, after: name ?? null, why: attributeCreateWhy(resource) }];
}

const SYNC_FIELD = 'userSyncInbound.isSyncAllowed';

/** Turning sync on: changes access, and is permanent. Turning it off or keeping it carries none. */
export function identitySyncEffects(resource) {
  if (!resource?.payload || resource.verb === 'delete') return [];
  const after = resource.payload.userSyncInbound?.isSyncAllowed;
  const before = present(resource) ? (resource.live.payload?.userSyncInbound?.isSyncAllowed ?? null) : null;
  if (after !== true || before === true) return [];
  const partner = resource.payload.displayName || 'this partner organization';
  return [
    { field: SYNC_FIELD, effect: 'access-changing', before, after,
      why: `This turns on user sync from ${partner}: its sync job can then create accounts for its users in this tenant, and they reach what members here can reach.` },
    { field: SYNC_FIELD, effect: PERMANENT_EFFECT, before, after,
      why: `Turning user sync from ${partner} off again only stops new users being synced: the accounts it already synced stay in this tenant until someone removes them by hand.` },
  ];
}
