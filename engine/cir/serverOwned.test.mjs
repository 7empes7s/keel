import { strict as assert } from 'node:assert';
import { M1_TYPES } from '../collect/entraAdapter.mjs';
import { canonicalHash } from './canonicalHash.mjs';
import {
  fieldClass,
  IMMUTABLE,
  SERVER_OWNED,
  SERVER_OWNED_ALWAYS,
} from './serverOwned.mjs';

for (const resourceType of M1_TYPES) {
  assert.ok(SERVER_OWNED.has(resourceType), `missing server-owned entry for ${resourceType}`);
  assert.ok(IMMUTABLE.has(resourceType), `missing immutable entry for ${resourceType}`);
}

assert.deepEqual(SERVER_OWNED_ALWAYS, new Set([
  'id', 'createdDateTime', 'modifiedDateTime', 'lastModifiedDateTime', 'deletedDateTime', 'renewedDateTime',
]));
assert.equal(fieldClass('id', 'user'), 'serverOwned');
assert.equal(fieldClass('nested.modifiedDateTime', 'namedLocation'), 'writable');
assert.equal(fieldClass('nested.id', 'conditionalAccessPolicy'), 'writable');
assert.equal(fieldClass('conditions.@odata.type', 'conditionalAccessPolicy'), 'serverOwned');
assert.equal(fieldClass('mailNickname', 'group'), 'writable');
assert.equal(fieldClass('nested.mailNickname', 'group'), 'writable');
assert.equal(fieldClass('mailEnabled', 'group'), 'immutable');
assert.equal(fieldClass('securityEnabled', 'group'), 'writable');
assert.equal(fieldClass('groupTypes', 'group'), 'immutable');
assert.equal(fieldClass('displayName', 'group'), 'writable');
assert.throws(() => fieldClass('displayName', 'unknown'), /unknown resourceType/);

// The fields settable only at creation.
assert.equal(fieldClass('isAssignableToRole', 'group'), 'immutable');

// Server-owned fields must be excluded from both the hash and PATCH bodies.
for (const field of [
  'classification', 'creationOptions', 'expirationDateTime', 'infoCatalogs', 'mail',
  'onPremisesDomainName', 'onPremisesLastSyncDateTime', 'onPremisesNetBiosName',
  'onPremisesProvisioningErrors', 'onPremisesSamAccountName', 'onPremisesSecurityIdentifier',
  'onPremisesSyncEnabled', 'proxyAddresses', 'resourceBehaviorOptions', 'resourceProvisioningOptions',
  'securityIdentifier', 'serviceProvisioningErrors', 'theme',
]) {
  assert.equal(fieldClass(field, 'group'), 'serverOwned', `expected ${field} to be serverOwned`);
}

// The convergence invariant this whole fix exists for. A payload captured via a narrow
// $select (missing these keys entirely) and a payload from an unfiltered read (these keys
// present, value null) must canonicalize identically once they're both classified serverOwned —
// this is the exact structural mismatch that broke the live rehearsal's rollback verification.
const narrowSelect = { id: 'g1', displayName: 'Alpha', mailNickname: 'alpha', groupTypes: [], securityEnabled: true, mailEnabled: false };
const unfilteredRead = {
  ...narrowSelect,
  classification: null, mail: null, onPremisesSecurityIdentifier: null, theme: null,
  securityIdentifier: 'S-1-5-21-fake', proxyAddresses: [], expirationDateTime: null,
};
assert.equal(canonicalHash(narrowSelect, 'group'), canonicalHash(unfilteredRead, 'group'));

// user
assert.equal(fieldClass('userPrincipalName', 'user'), 'writable');
assert.equal(fieldClass('onPremisesSyncEnabled', 'user'), 'serverOwned');
assert.equal(fieldClass('onPremisesImmutableId', 'user'), 'serverOwned');
assert.equal(fieldClass('userType', 'user'), 'serverOwned');
assert.equal(fieldClass('assignedLicenses', 'user'), 'serverOwned');

// roleAssignment — no PATCH support at all; every real field is immutable
assert.equal(fieldClass('principalId', 'roleAssignment'), 'immutable');
assert.equal(fieldClass('principalOrganizationId', 'roleAssignment'), 'immutable');
assert.equal(fieldClass('directoryScopeId', 'roleAssignment'), 'immutable');
assert.equal(fieldClass('roleDefinitionId', 'roleAssignment'), 'immutable');

// namedLocation
assert.equal(fieldClass('displayName', 'namedLocation'), 'writable');
assert.equal(fieldClass('isTrusted', 'namedLocation'), 'writable');
assert.equal(fieldClass('ipRanges', 'namedLocation'), 'writable');
assert.equal(fieldClass('countriesAndRegions', 'namedLocation'), 'writable');
assert.equal(fieldClass('includeUnknownCountriesAndRegions', 'namedLocation'), 'writable');

// conditionalAccessPolicy
assert.equal(fieldClass('conditions', 'conditionalAccessPolicy'), 'writable');
assert.equal(fieldClass('grantControls', 'conditionalAccessPolicy'), 'writable');
assert.equal(fieldClass('sessionControls', 'conditionalAccessPolicy'), 'writable');
assert.equal(fieldClass('state', 'conditionalAccessPolicy'), 'writable');
assert.equal(fieldClass('templateId', 'conditionalAccessPolicy'), 'serverOwned');

// authenticationStrengthPolicy
assert.equal(fieldClass('displayName', 'authenticationStrengthPolicy'), 'writable');
assert.equal(fieldClass('description', 'authenticationStrengthPolicy'), 'writable');
assert.equal(fieldClass('allowedCombinations', 'authenticationStrengthPolicy'), 'immutable');

console.log('serverOwned.test.mjs — all assertions passed');
