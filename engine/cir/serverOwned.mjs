/** Spec M2.3. Three field classes, single source of truth for hashing AND PATCH projection.
 *  - serverOwned: Graph sets it, we cannot. Excluded from the hash and from PATCH bodies.
 *  - immutable:   settable at create, NOT patchable. IN the hash (a change is real drift),
 *                 excluded from PATCH, and reported as not-auto-remediable.
 *  - everything else is writable: in the hash and in PATCH bodies.
 *
 * Microsoft Graph v1.0 documentation verified through Context7 on 2026-09-04:
 * group creation requires mailNickname, mailEnabled, and securityEnabled, while the
 * documented PATCH table lists mailNickname and securityEnabled as updatable. That
 * conflicts with the M2 task's required group immutable set below; this file retains
 * the prescribed M2 classification pending the fixture-only write-side-effect probe.
 * The create response documents id as service-created; Graph response metadata fields
 * and @odata.* annotations are not client-settable configuration.
 */

export const SERVER_OWNED_ALWAYS = new Set([
  'id',
  'createdDateTime',
  'modifiedDateTime',
  'deletedDateTime',
  'renewedDateTime',
]);

const RESOURCE_TYPES = [
  'user',
  'authenticationStrengthPolicy',
  'group',
  'roleAssignment',
  'namedLocation',
  'conditionalAccessPolicy',
];

export const SERVER_OWNED = new Map(
  RESOURCE_TYPES.map((resourceType) => [resourceType, new Set()]),
);

export const IMMUTABLE = new Map(
  RESOURCE_TYPES.map((resourceType) => [
    resourceType,
    new Set(resourceType === 'group'
      ? ['mailNickname', 'mailEnabled', 'securityEnabled', 'groupTypes']
      : []),
  ]),
);

function fieldName(path) {
  return path.split('.').at(-1);
}

/** @returns {'serverOwned' | 'immutable' | 'writable'} */
export function fieldClass(path, resourceType) {
  if (!SERVER_OWNED.has(resourceType) || !IMMUTABLE.has(resourceType)) {
    throw new Error(`unknown resourceType: ${resourceType}`);
  }

  const key = fieldName(path);
  if (
    /(^|\.)@odata\./.test(path)
    || SERVER_OWNED_ALWAYS.has(key)
    || SERVER_OWNED.get(resourceType).has(path)
    || SERVER_OWNED.get(resourceType).has(key)
  ) {
    return 'serverOwned';
  }
  if (IMMUTABLE.get(resourceType).has(path) || IMMUTABLE.get(resourceType).has(key)) {
    return 'immutable';
  }
  return 'writable';
}
