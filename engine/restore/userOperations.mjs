/**
 * Roadmap task-150: restore of users (attributes and a deleted user) and of
 * directly assigned licences, for users and for groups.
 *
 * Creating a user from nothing stays manual: a password and MFA methods are
 * never readable, so a recreated user could not sign in as before. What this
 * module covers is the common case where the user still exists:
 *
 *  - update: PATCH /users/{id} with only the reviewed attributes below whose
 *    snapshot value differs from the live one. Never a password, an
 *    authentication method, the sign-in name, whether the account is enabled,
 *    or a sync-owned field. A user synced from on-premises AD (by the snapshot,
 *    the live object or the restored object) is refused.
 *  - restore-soft-deleted: POST /directory/deletedItems/{id}/restore keeps the
 *    object id, then the same attribute and licence step as update.
 *  - licences: POST /{users|groups}/{id}/assignLicense, ADD ONLY. A licence the
 *    snapshot assigned directly and the live object lacks (or holds with other
 *    disabled plans) is assigned again. A licence is never removed, and a
 *    licence a user inherits from a group is never assigned directly: the
 *    group's own licences are restored on the group.
 *
 * Every write is read back with an explicit $select, and every written
 * attribute and licence must match.
 */
import { isDeepStrictEqual } from 'node:util';

export const USER_OPERATIONS_CONTRACT_VERSION = 1;

/**
 * The reviewed attributes an update may write. accountEnabled is deliberately
 * absent: restoring an older snapshot would re-enable a leaver's account, or
 * disable a break-glass account. A difference in it is reported, never written.
 */
export const USER_WRITABLE_FIELDS = Object.freeze([
  'businessPhones', 'city', 'companyName', 'country', 'department', 'displayName',
  'employeeId', 'employeeType', 'givenName', 'jobTitle', 'mobilePhone', 'officeLocation', 'postalCode',
  'preferredLanguage', 'state', 'streetAddress', 'surname', 'usageLocation',
]);

/** Attributes compared and reported, but only ever changed by hand. */
export const USER_REPORTED_FIELDS = Object.freeze(['accountEnabled']);

const LICENCE_FIELDS = Object.freeze(['assignedLicenses', 'licenseAssignmentStates']);
export const USER_READ_SELECT = Object.freeze([
  'id', 'onPremisesSyncEnabled', 'onPremisesImmutableId', ...USER_REPORTED_FIELDS, ...USER_WRITABLE_FIELDS, ...LICENCE_FIELDS,
]);
export const GROUP_LICENCE_SELECT = Object.freeze(['id', 'assignedLicenses']);

/** The Restorer's Graph permissions for these writes (engine/bootstrap/prerequisites.mjs). */
export const USER_PERMISSIONS = Object.freeze({
  update: 'User.ReadWrite.All',
  'restore-soft-deleted': 'User.ReadWrite.All',
  licences: 'LicenseAssignment.ReadWrite.All',
});

export function isUserGoverned(resourceType) {
  return resourceType === 'user';
}

function sameValue(left, right) {
  const norm = (value) => (Array.isArray(value) ? [...value].map(String).sort() : value ?? null);
  return isDeepStrictEqual(norm(left), norm(right));
}

/**
 * The allowlisted attributes the snapshot holds whose value differs from live.
 * A usage location is never cleared: a licensed user must keep one.
 */
export function changedUserFields(desired, live) {
  return USER_WRITABLE_FIELDS.filter((field) => Object.hasOwn(desired ?? {}, field)
    && !(field === 'usageLocation' && desired[field] == null)
    && !sameValue(desired[field], live?.[field]));
}

/** Reported-only attributes that differ: the dry run lists them as manual steps. */
export function manualUserFields(desired, live) {
  return USER_REPORTED_FIELDS.filter((field) => Object.hasOwn(desired ?? {}, field) && live && !sameValue(desired[field], live[field]));
}

/** A user whose source of authority is on-premises AD, by either side's evidence. */
export function isSyncedUser(...payloads) {
  return payloads.some((payload) => payload?.onPremisesSyncEnabled === true
    || (typeof payload?.onPremisesImmutableId === 'string' && payload.onPremisesImmutableId.length > 0));
}

const lower = (value) => String(value ?? '').toLowerCase();
const plans = (value) => (Array.isArray(value) ? value.map(lower).sort() : []);

/**
 * The licences an object holds directly, by skuId. For a user that is every
 * licenseAssignmentStates entry not assigned by a group; for a group it is
 * assignedLicenses. Null when the object does not say (an older snapshot).
 */
export function directLicences(payload, { resourceType = 'user' } = {}) {
  if (resourceType === 'group') {
    if (!Array.isArray(payload?.assignedLicenses)) return null;
    return new Map(payload.assignedLicenses.filter((entry) => entry?.skuId)
      .map((entry) => [lower(entry.skuId), { skuId: entry.skuId, disabledPlans: plans(entry.disabledPlans) }]));
  }
  if (!Array.isArray(payload?.licenseAssignmentStates)) return null;
  return new Map(payload.licenseAssignmentStates.filter((entry) => entry?.skuId && !entry.assignedByGroup)
    .map((entry) => [lower(entry.skuId), { skuId: entry.skuId, disabledPlans: plans(entry.disabledPlans) }]));
}

/** Every licence the live object holds, however assigned, by skuId. */
function heldLicences(payload) {
  return new Map((payload?.assignedLicenses ?? []).filter((entry) => entry?.skuId)
    .map((entry) => [lower(entry.skuId), plans(entry.disabledPlans)]));
}

/**
 * The add-only licence plan: { add: [{ skuId, disabledPlans }], note }. `note`
 * explains why licences were not compared at all (never a refusal of the
 * attribute restore).
 */
export function licencePlan(desired, live, { resourceType = 'user' } = {}) {
  const want = directLicences(desired, { resourceType });
  if (!want) return { add: [], note: 'licences not compared: the snapshot predates licence assignment states' };
  const liveDirect = directLicences(live, { resourceType });
  const held = heldLicences(live);
  const add = [];
  for (const [sku, licence] of want) {
    const current = liveDirect?.get(sku)?.disabledPlans ?? (liveDirect ? null : held.get(sku) ?? null);
    if (current && isDeepStrictEqual(current, licence.disabledPlans)) continue;
    add.push({ skuId: licence.skuId, disabledPlans: licence.disabledPlans });
  }
  return { add, note: null };
}

/** The assignLicense request body: add only, nothing removed. */
export function assignLicenseBody(add) {
  return { addLicenses: add.map((licence) => ({ skuId: licence.skuId, disabledPlans: licence.disabledPlans })), removeLicenses: [] };
}

/**
 * After the writes: every written attribute and licence reads back as
 * intended. A user's licence is checked against its direct assignment state
 * (assignedLicenses merges direct and inherited copies); a group's, or a user
 * read without states, against assignedLicenses.
 */
export function userPostStateRefusal(desired, live, { fields = [], licences = [], resourceType = 'user' } = {}) {
  const wrong = fields.filter((field) => !sameValue(desired[field], live?.[field]));
  const direct = directLicences(live, { resourceType });
  const held = heldLicences(live);
  for (const licence of licences) {
    const got = direct ? direct.get(lower(licence.skuId))?.disabledPlans : held.get(lower(licence.skuId));
    if (!got || !isDeepStrictEqual(got, licence.disabledPlans)) wrong.push(`licence ${licence.skuId}`);
  }
  return wrong.length > 0 ? `post-state: ${wrong.join(', ')} did not read back as written` : null;
}

export function userReadPath(targetId) {
  return `/users/${encodeURIComponent(targetId)}?$select=${USER_READ_SELECT.join(',')}`;
}

export function groupLicenceReadPath(targetId) {
  return `/groups/${encodeURIComponent(targetId)}?$select=${GROUP_LICENCE_SELECT.join(',')}`;
}
