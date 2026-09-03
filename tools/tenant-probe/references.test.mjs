/**
 * Tests for the reference analyser.
 *
 * This module produces the number the M1 go/no-go decision rests on, so the
 * fixture is built to separate a correct implementation from the plausible
 * wrong ones. Every classification branch appears exactly once with a distinct
 * expected count, so a rule that fires too broadly or not at all changes a
 * total and fails the run.
 *
 * The fixture is drawn from shapes actually observed in the sandbox tenant on
 * 2026-09-03 — permission ids under requiredResourceAccess, licence SKUs on
 * users, GUID-shaped mailNicknames, a partner tenant id, built-in role
 * templates referenced from roleAssignment, and the all-zero "no target"
 * sentinel — because those were the cases the first two implementations got
 * wrong, each caught by running against the real tenant.
 */

import { strict as assert } from 'node:assert';
import { analyseReferences, buildIndex, classify, naturalKey } from './references.mjs';

const USER_A = '11111111-1111-1111-1111-111111111111';
const GROUP_B = '22222222-2222-2222-2222-222222222222';
const SP_OBJECT = '33333333-3333-3333-3333-333333333333';
const SP_APPID = '44444444-4444-4444-4444-444444444444';
const POLICY_ID = '55555555-5555-5555-5555-555555555555';
const PERM_ID = '66666666-6666-6666-6666-666666666666';
const SKU_ID = '77777777-7777-7777-7777-777777777777';
const PLAN_ID = '88888888-8888-8888-8888-888888888888';
const PARTNER_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUTH_STRENGTH = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GUID_NICKNAME = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DANGLING = '99999999-9999-9999-9999-999999999999';
const ROLE_TEMPLATE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NO_TARGET_SENTINEL = '00000000-0000-0000-0000-000000000000';

const collected = new Map([
  ['user', [{
    id: USER_A,
    userPrincipalName: 'ana@contoso.com',
    assignedLicenses: [{ skuId: SKU_ID }], // resolvable → SKU part number
  }]],
  ['group', [{
    id: GROUP_B,
    mailNickname: GUID_NICKNAME, // GUID-shaped NAME, not a reference
    displayName: 'Break Glass',
  }]],
  ['servicePrincipal', [{
    id: SP_OBJECT,
    appId: SP_APPID,
    displayName: 'Payroll App',
    appRoles: [{ id: PERM_ID, value: 'Payroll.Read.All' }], // child identity
  }]],
  ['subscribedSku', [{
    id: 'sku-obj',
    skuId: SKU_ID,
    skuPartNumber: 'ENTERPRISEPREMIUM',
    servicePlans: [{ servicePlanId: PLAN_ID, servicePlanName: 'EXCHANGE_S_ENTERPRISE' }],
  }]],
  ['application', [{
    id: 'app-obj-1',
    appId: 'app-id-1',
    createdByAppId: DANGLING, // server-assigned provenance, rejected on write
    requiredResourceAccess: [{
      resourceAppId: SP_APPID,                       // resolvable → the SP
      resourceAccess: [{ id: PERM_ID, type: 'Role' }], // resolvable → permission
    }],
  }]],
  ['crossTenantAccessPolicyPartner', [{
    id: 'partner-1',
    tenantId: PARTNER_TENANT, // foreign tenant, preserved verbatim
  }]],
  ['conditionalAccessPolicy', [{
    id: POLICY_ID, // identity
    displayName: 'Require MFA',
    conditions: {
      users: {
        includeUsers: [USER_A],   // resolvable, nested in an array
        excludeGroups: [GROUP_B], // resolvable
        excludeUsers: [DANGLING], // UNRESOLVABLE — the only real risk here
      },
    },
    grantControls: {
      authenticationStrength: { id: AUTH_STRENGTH }, // Microsoft-global constant
    },
  }]],
  // Microsoft's built-in role template catalog — same GUID in every tenant.
  // Confirmed live 2026-09-03: a roleAssignment.roleDefinitionId that isn't in
  // /roleManagement/directory/roleDefinitions resolves here, not to nothing.
  ['directoryRoleTemplate', [{ id: ROLE_TEMPLATE, displayName: 'Helpdesk Administrator' }]],
  ['roleAssignment', [{
    id: 'assignment-1',
    roleDefinitionId: ROLE_TEMPLATE, // resolves, verbatim — must be globalConstant, not resolvable
    principalId: USER_A,             // resolvable
    excludeTarget: { id: NO_TARGET_SENTINEL }, // "no target" sentinel — not a reference at all
  }]],
]);

// ---------------------------------------------------------------- index
const index = buildIndex(collected);

assert.equal(index.get(PERM_ID)?.kind, 'permission', 'appRole id must be indexed as a permission');
assert.equal(index.get(PERM_ID)?.key, `${SP_APPID}/role:Payroll.Read.All`);
assert.equal(index.get(SKU_ID)?.kind, 'sku');
assert.equal(index.get(SKU_ID)?.key, 'ENTERPRISEPREMIUM');
assert.equal(index.get(PLAN_ID)?.kind, 'servicePlan');
assert.equal(index.get(PLAN_ID)?.key, 'EXCHANGE_S_ENTERPRISE');

// ------------------------------------------------------------- analysis
const r = analyseReferences(collected);

// nonReference: the GUID-shaped mailNickname, and the all-zero "no target"
// sentinel on roleAssignment.excludeTarget.id.
assert.equal(r.nonReference, 2, `nonReference: got ${r.nonReference}`);

// Real references, 11 total:
//   resolvable(6)     user.skuId, app.resourceAppId, app.resourceAccess.id,
//                     policy.includeUsers, policy.excludeGroups,
//                     roleAssignment.principalId
//   globalConstant(2) policy.authenticationStrength.id,
//                     roleAssignment.roleDefinitionId (-> built-in role template)
//   foreignTenant(1)  partner.tenantId
//   readOnly(1)       app.createdByAppId
//   unresolvable(1)   policy.excludeUsers — the only real risk here
assert.equal(r.totalReferences, 11, `totalReferences: got ${r.totalReferences}`);
assert.equal(r.resolvable, 6, `resolvable: got ${r.resolvable}`);
assert.equal(r.globalConstant, 2, `globalConstant: got ${r.globalConstant}`);
assert.equal(r.foreignTenant, 1, `foreignTenant: got ${r.foreignTenant}`);
assert.equal(r.readOnly, 1, `readOnly: got ${r.readOnly}`);
assert.equal(r.unresolvable, 1, `unresolvable: got ${r.unresolvable}`);

// A read-only field must be classified by its path, not by whether its value
// happens to be resolvable — the same dangling GUID appears in both places.
assert.equal(classify({ path: 'createdByAppId', guid: DANGLING, ownIds: new Set(), index: buildIndex(collected) }).klass, 'readOnly');

// The permission and SKU resolutions are the whole point of the richer index.
assert.equal(r.resolvableByKind.permission, 1, 'permission id must resolve');
assert.equal(r.resolvableByKind.sku, 1, 'licence SKU must resolve');
assert.equal(r.resolvableByKind.object, 4, 'object references must resolve');
// resolvableByKind must never carry 'roleTemplate': a built-in role template
// id is the same GUID in every tenant, so it is reported as globalConstant,
// not as something that was looked up and remapped.
assert.equal(r.resolvableByKind.roleTemplate, undefined, 'roleTemplate hits must not be classed as resolvable');

// Built-in role templates: same GUID everywhere, so referencing one is
// "restores verbatim", not "remapped via a natural key".
assert.equal(
  classify({ path: 'roleDefinitionId', guid: ROLE_TEMPLATE, ownIds: new Set(), index }).klass,
  'globalConstant',
  'a roleAssignment pointing at a built-in role template must be globalConstant, not resolvable',
);

// The one genuine gap must be attributed to its exact field.
assert.equal(r.unresolvedSamples.length, 1);
assert.deepEqual(r.unresolvedSamples[0], {
  type: 'conditionalAccessPolicy',
  field: 'conditions.users.excludeUsers',
  guid: DANGLING,
});

// ------------------------------------------------- classification units
const noOwn = new Set();
assert.equal(classify({ path: 'assignedLicenses[0].skuId', guid: SKU_ID, ownIds: noOwn, index }).klass, 'resolvable');
assert.equal(classify({ path: 'mailNickname', guid: GUID_NICKNAME, ownIds: noOwn, index }).klass, 'nonReference');
assert.equal(classify({ path: 'appRoles[2].id', guid: DANGLING, ownIds: noOwn, index }).klass, 'identity');
assert.equal(classify({ path: 'tenantId', guid: DANGLING, ownIds: noOwn, index }).klass, 'foreignTenant');
assert.equal(classify({ path: 'conditions.users.excludeUsers[0]', guid: DANGLING, ownIds: noOwn, index }).klass, 'unresolvable');

// The all-zero GUID means "no target" in Graph, not a dangling reference —
// observed live at authenticationMethodConfigurations.*.excludeTarget.id.
assert.equal(
  classify({ path: 'featureSettings.excludeTarget.id', guid: NO_TARGET_SENTINEL, ownIds: noOwn, index }).klass,
  'nonReference',
  'the all-zero sentinel GUID must never be reported as unresolvable',
);
// A near-miss (trailing non-zero nibble) must NOT be swept in by the same
// rule — SENTINEL is a literal match, not a "mostly zero" pattern. Note
// 00000000-0000-0000-0000-000000000001 is itself a *different*, separately
// verified constant (the built-in default passkey profile — see WELL_KNOWN),
// so an unrelated near-miss value is used here instead.
assert.equal(
  classify({ path: 'somePath', guid: '00000000-0000-0000-0000-0000000000ab', ownIds: noOwn, index }).klass,
  'unresolvable',
  'a GUID that is not exactly all-zero must still be evaluated normally',
);

// An id we can name must never be written off as an opaque constant, even when
// its field path also matches a global-constant rule.
assert.equal(
  classify({ path: 'requiredResourceAccess[0].resourceAccess[0].id', guid: PERM_ID, ownIds: noOwn, index }).klass,
  'resolvable',
  'index resolution must take precedence over the field-path constant rule',
);

// Confirmed live 2026-09-03 (Graph's own response names this object
// "Default passkey profile"): a documented Microsoft-global constant, not a
// tenant object, so it resolves via WELL_KNOWN rather than the tenant index.
assert.equal(
  classify({ path: 'authenticationMethodConfigurations.includeTargets.allowedPasskeyProfiles',
    guid: '00000000-0000-0000-0000-000000000001', ownIds: noOwn, index }).klass,
  'globalConstant',
);

// ----------------------------------------------------------- natural keys
assert.equal(naturalKey('user', { id: USER_A, userPrincipalName: 'ana@contoso.com' }), 'ana@contoso.com');
assert.equal(naturalKey('servicePrincipal', { id: SP_OBJECT, appId: SP_APPID }), SP_APPID);
assert.equal(naturalKey('subscribedSku', { skuPartNumber: 'ENTERPRISEPREMIUM' }), 'ENTERPRISEPREMIUM');

console.log('references.test.mjs — all assertions passed');
