// engine/govern/sharingDirection.mjs
//
// Which way a SharePoint or OneDrive sharing setting moved: wider (more people can reach
// files) or narrower. Workload drift rates a narrowing as low priority, and the risk
// flags (engine/insights/flags.mjs) flag a widening. Pure.

// SharePoint's sharing levels, narrowest first. PnP writes them as numbers 0-3 in this
// order: Disabled, ExternalUserSharingOnly, ExternalUserAndGuestSharing,
// ExistingExternalUserSharingOnly.
export const SHARING_ORDER = Object.freeze(['Disabled', 'ExistingExternalUserSharingOnly', 'ExternalUserSharingOnly', 'ExternalUserAndGuestSharing']);
const SHARING_BY_NUMBER = Object.freeze(['Disabled', 'ExternalUserSharingOnly', 'ExternalUserAndGuestSharing', 'ExistingExternalUserSharingOnly']);
// The link a person gets by default, narrowest first. `None` (use the tenant's default)
// has no direction.
export const LINK_TYPE_ORDER = Object.freeze(['Direct', 'Internal', 'AnonymousAccess']);
const LINK_TYPE_BY_NUMBER = Object.freeze(['None', 'Direct', 'Internal', 'AnonymousAccess']);
// What an anyone link to a file or folder allows, narrowest first.
export const ANONYMOUS_LINK_ORDER = Object.freeze(['None', 'View', 'Edit']);

/** The sharing settings with a direction, by field path, and the scale each is on. */
export const SHARING_DIRECTION_PATHS = Object.freeze({
  sharingCapability: 'sharing',
  SharingCapability: 'sharing',
  OneDriveSharingCapability: 'sharing',
  DefaultSharingLinkType: 'linkType',
  FileAnonymousLinkType: 'anonymousLink',
  FolderAnonymousLinkType: 'anonymousLink',
  RequireAnonymousLinksExpireInDays: 'expiry',
  AnonymousLinkExpirationInDays: 'expiry',
});
/** The workloads whose reads carry those settings. */
export const SHARING_DIRECTION_WORKLOADS = Object.freeze(['sharepoint-site-settings', 'sharepoint-tenant', 'onedrive-site-settings']);

const SCALES = Object.freeze({
  sharing: { order: SHARING_ORDER, byNumber: SHARING_BY_NUMBER },
  linkType: { order: LINK_TYPE_ORDER, byNumber: LINK_TYPE_BY_NUMBER },
  anonymousLink: { order: ANONYMOUS_LINK_ORDER, byNumber: ANONYMOUS_LINK_ORDER },
});

/** A setting's value by name on its scale ('ExternalUserSharingOnly'), or null when it is not on it. */
export function scaleValue(scale, value) {
  const { order, byNumber } = SCALES[scale];
  const named = Number.isInteger(value) || (typeof value === 'string' && /^\d+$/.test(value)) ? byNumber[Number(value)] : value;
  if (typeof named !== 'string') return null;
  return order.find((entry) => entry.toLowerCase() === named.toLowerCase()) ?? null;
}

/** An expiry in days: 0, a negative number or nothing means links never expire (null). */
export function expiryDays(value) {
  const number = Number(value);
  return value === null || value === undefined || value === '' || typeof value === 'boolean' || !Number.isFinite(number) || number <= 0 ? null : number;
}

/**
 * 'wider', 'narrower' or null (not a sharing setting, unchanged, or a value whose
 * direction is unknown) for one field's change.
 */
export function sharingDirection(path, before, after) {
  const scale = SHARING_DIRECTION_PATHS[path];
  if (!scale) return null;
  if (scale === 'expiry') {
    const was = expiryDays(before);
    const now = expiryDays(after);
    if (was === now) return null;
    if (now === null) return 'wider';
    if (was === null) return 'narrower';
    return now > was ? 'wider' : 'narrower';
  }
  const { order } = SCALES[scale];
  const was = order.indexOf(scaleValue(scale, before));
  const now = order.indexOf(scaleValue(scale, after));
  if (was === -1 || now === -1 || was === now) return null;
  return now > was ? 'wider' : 'narrower';
}
