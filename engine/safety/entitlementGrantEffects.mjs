/**
 * Issue #1071: what restoring entitlement management grants gives, in names, for
 * the restore approval (contentEffects.mjs) and the writer
 * (restore/entitlementGrantOperations.mjs).
 *
 *  - a group, app or site added to a catalog can be put in a package by the
 *    catalog's owners;
 *  - an access package assignment gives a person the package's access;
 *  - a catalog role lets a person manage the catalog and its packages.
 *
 * Only a write the restore could make carries an effect: a resource of another
 * kind, an assignment that is no longer in effect or names no policy, and a role
 * KEEL does not restore are skipped before any write, so nobody is asked to
 * approve them.
 */

export const GRANT_HELD_FIELDS = Object.freeze({
  accessPackageCatalogResource: Object.freeze(['originId', 'originSystem']),
  accessPackageAssignment: Object.freeze(['target', 'accessPackage', 'assignmentPolicy']),
  entitlementManagementRoleAssignment: Object.freeze(['principalId', 'roleDefinitionId', 'appScopeId']),
});

/** The entitlement management roles a restore gives back, by their built-in ids (the same in every tenant). */
export const ENTITLEMENT_ROLE_NAMES = Object.freeze({
  'ae79f266-94d4-4dab-b730-feca7e132178': 'Catalog owner',
  '44272f93-9762-48e8-af59-1b5351b1d6b3': 'Catalog reader',
  '7f480852-ebdc-47d4-87de-0d8498384a83': 'Access package manager',
});

const CATALOG_RESOURCE_SYSTEMS = new Set(['AadGroup', 'AadApplication', 'SharePointOnline']);
const CATALOG_SCOPE = /^\/AccessPackageCatalog\/[0-9a-f-]{36}$/i;

/** Whether an access package assignment was in effect: delivered, and not past its end date at `now`. */
export function assignmentInEffect(payload, now = Date.now()) {
  if (!['delivered', 'partiallydelivered'].includes(String(payload?.state ?? '').toLowerCase())) return false;
  const end = Date.parse(payload?.schedule?.expiration?.endDateTime ?? '');
  return Number.isNaN(end) || end > now;
}

const subjectText = (target) => `${target?.subjectType === 'servicePrincipal' ? 'the app' : 'the user'} ${target?.principalName ?? target?.email ?? target?.displayName ?? 'the backup does not name'}`;
const quoted = (object, what) => (object?.displayName ? `the ${what} "${object.displayName}"` : `an ${what} the backup does not name`);

/** Who gets which package through which policy, in plain words ("the user ann@contoso.com the access package "Finance" through …"). */
export function assignmentGrantText(payload) {
  const policy = payload?.assignmentPolicy?.displayName ? ` through the policy "${payload.assignmentPolicy.displayName}"` : '';
  return `${subjectText(payload?.target)} ${quoted(payload?.accessPackage, 'access package')}${policy}`;
}

const ASSIGNMENT_PARTS = Object.freeze({
  target: (payload) => subjectText(payload.target),
  accessPackage: (payload) => quoted(payload.accessPackage, 'access package'),
  assignmentPolicy: (payload) => (payload.assignmentPolicy?.displayName ? `the policy "${payload.assignmentPolicy.displayName}"` : 'a policy the backup does not name'),
});

const restoredRole = (payload) => Boolean(ENTITLEMENT_ROLE_NAMES[String(payload?.roleDefinitionId ?? '').toLowerCase()]) && CATALOG_SCOPE.test(String(payload?.appScopeId ?? ''));

/**
 * The value readers of the three kinds, per field. `named(field)` is the
 * shared reader that shows each id the backup holds a reference for by name.
 */
export function grantAccessReaders(named) {
  const readers = {
    accessPackageCatalogResource: (field) => (payload, resource) => (CATALOG_RESOURCE_SYSTEMS.has(payload?.originSystem) ? named(field)(payload, resource) : null),
    accessPackageAssignment: (field) => (payload) => (assignmentInEffect(payload) && payload.assignmentPolicy?.id ? ASSIGNMENT_PARTS[field](payload) : null),
    entitlementManagementRoleAssignment: (field) => (payload, resource) => {
      if (!restoredRole(payload)) return null;
      return field === 'roleDefinitionId' ? ENTITLEMENT_ROLE_NAMES[payload.roleDefinitionId.toLowerCase()] : named(field)(payload, resource);
    },
  };
  return Object.fromEntries(Object.entries(GRANT_HELD_FIELDS).map(([kind, fields]) => [kind, Object.freeze(Object.fromEntries(fields.map((field) => [field, readers[kind](field)])))]));
}
