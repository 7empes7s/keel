/**
 * Tests for the reference analyser.
 *
 * This module produces the number the M1 go/no-go decision rests on, so the
 * fixture is built to separate a correct implementation from the plausible
 * wrong ones. Every classification rule fires in the fixture with a distinct
 * expected count, so a rule that fires too broadly or not at all changes a
 * total and fails the run.
 *
 * The fixture is drawn from shapes actually observed in the sandbox tenant on
 * 2026-09-03 — permission ids under requiredResourceAccess, licence SKUs on
 * users, GUID-shaped mailNicknames, a partner tenant id, built-in role
 * templates referenced from roleAssignment, and the all-zero "no target"
 * sentinel — because those were the cases the first two implementations got
 * wrong, each caught by running against the real tenant. Later additions come
 * from documented Graph schema shapes: directory setting values, custom
 * authentication strengths (Microsoft's own docs use a random tenant GUID for
 * the custom-strength example), passkey profiles, and FIDO2 AAGUID
 * restrictions.
 */

import { strict as assert } from 'node:assert';
import { analyseReferences, buildIndex, classify, naturalKey } from './references.mjs';

const USER_A = '11111111-1111-1111-1111-111111111111';
// Mixed case on purpose: Graph (Intune especially) returns upper-case GUIDs,
// and the match must be case-insensitive end to end.
const GROUP_B = '22222222-2B2B-4C4C-8D8D-222222222222';
const SP_OBJECT = '33333333-3333-3333-3333-333333333333';
const SP_APPID = '44444444-4444-4444-4444-444444444444';
const POLICY_ID = '55555555-5555-5555-5555-555555555555';
const PERM_ID = '66666666-6666-6666-6666-666666666666';
const SKU_ID = '77777777-7777-7777-7777-777777777777';
const PLAN_ID = '88888888-8888-8888-8888-888888888888';
const PARTNER_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
// The BUILT-IN "Multifactor authentication" strength — documented
// Microsoft-global id, same in every tenant.
const AUTH_STRENGTH = '00000000-0000-0000-0000-000000000002';
// A CUSTOM authentication strength — a tenant-created object with a
// tenant-random id, collected below so the reference can resolve by name.
const CUSTOM_STRENGTH = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
// A custom strength that was NOT collected (id lifted from Microsoft's own
// Graph docs example of a custom authenticationStrengthPolicy).
const UNCOLLECTED_STRENGTH = '7d718ef4-5493-4313-a52c-7401b7df3a9c';
const SETTING_TEMPLATE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const GUID_SETTING_VALUE = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a';
const CUSTOM_PASSKEY_PROFILE = '1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b';
// YubiKey 5 NFC — a documented FIDO Alliance AAGUID, not a tenant object.
const AAGUID_YUBIKEY = 'fa2b99dc-9e39-4257-8f92-4a30d23c4118';
const GUID_NICKNAME = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DANGLING = '99999999-9999-9999-9999-999999999999';
const ROLE_TEMPLATE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NO_TARGET_SENTINEL = '00000000-0000-0000-0000-000000000000';

const collected = new Map([
  ['user', [{
    id: USER_A,
    userPrincipalName: 'ana@contoso.com',
    assignedLicenses: [{ skuId: SKU_ID }], // resolvable → SKU part number
    // assignedPlans.servicePlanId is a service-plan reference, not part of the
    // user's own identity — it must resolve through the SKU's servicePlans.
    assignedPlans: [{ servicePlanId: PLAN_ID, service: 'exchange' }],
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
  // Custom authentication strengths are tenant objects; collected so a CA
  // policy referencing one resolves by displayName instead of reading as a
  // Microsoft-global constant or a dangling reference.
  ['authenticationStrengthPolicy', [{
    id: CUSTOM_STRENGTH,
    displayName: 'Contractor VPN MFA',
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
        excludeGroups: [GROUP_B], // resolvable, mixed-case GUID
        excludeUsers: [DANGLING], // UNRESOLVABLE — the only real risk here
      },
    },
    grantControls: {
      authenticationStrength: { id: AUTH_STRENGTH }, // built-in strength → globalConstant
    },
  }, {
    id: 'policy-2',
    displayName: 'Contractor VPN',
    grantControls: {
      authenticationStrength: { id: CUSTOM_STRENGTH }, // custom strength → resolvable via index
    },
  }]],
  // Microsoft's built-in role template catalog — same GUID in every tenant.
  // Confirmed live 2026-09-03: a roleAssignment.roleDefinitionId that isn't in
  // /roleManagement/directory/roleDefinitions resolves here, not to nothing.
  ['directoryRoleTemplate', [{ id: ROLE_TEMPLATE, displayName: 'Helpdesk Administrator' }]],
  // Directory setting templates (e.g. Group.Unified) are the same kind of
  // Microsoft-defined catalog: identical GUIDs in every tenant.
  ['directorySettingTemplate', [{ id: SETTING_TEMPLATE, displayName: 'Group.Unified' }]],
  ['roleAssignment', [{
    id: 'assignment-1',
    roleDefinitionId: ROLE_TEMPLATE, // resolves, verbatim — must be globalConstant, not resolvable
    principalId: USER_A,             // resolvable
    excludeTarget: { id: NO_TARGET_SENTINEL }, // "no target" sentinel — not a reference at all
  }]],
  ['groupSetting', [{
    id: 'setting-1',
    templateId: SETTING_TEMPLATE, // built-in setting template — same id in every tenant
    values: [
      // A directory setting value is free text; a GUID-shaped string here is
      // something an admin typed, not a reference the analyser can re-point.
      { name: 'CustomBlockedWordsList', value: GUID_SETTING_VALUE },
    ],
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
assert.equal(index.get(SETTING_TEMPLATE)?.kind, 'settingTemplate', 'setting templates are a global catalog, like role templates');

// ------------------------------------------------------------- analysis
const r = analyseReferences(collected);

// nonReference: the GUID-shaped mailNickname, the all-zero "no target"
// sentinel on roleAssignment.excludeTarget.id, and the admin-typed GUID-shaped
// directory setting value.
assert.equal(r.nonReference, 3, `nonReference: got ${r.nonReference}`);

// Real references, 14 total:
//   resolvable(8)     user.skuId, user.assignedPlans.servicePlanId,
//                     app.resourceAppId, app.resourceAccess.id,
//                     policy.includeUsers, policy.excludeGroups,
//                     policy2.authenticationStrength.id (custom, collected),
//                     roleAssignment.principalId
//   globalConstant(3) policy.authenticationStrength.id (built-in MFA strength),
//                     roleAssignment.roleDefinitionId (built-in role template),
//                     groupSetting.templateId (built-in setting template)
//   foreignTenant(1)  partner.tenantId
//   readOnly(1)       app.createdByAppId
//   unresolvable(1)   policy.excludeUsers — the only real risk here
assert.equal(r.totalReferences, 14, `totalReferences: got ${r.totalReferences}`);
assert.equal(r.resolvable, 8, `resolvable: got ${r.resolvable}`);
assert.equal(r.globalConstant, 3, `globalConstant: got ${r.globalConstant}`);
assert.equal(r.foreignTenant, 1, `foreignTenant: got ${r.foreignTenant}`);
assert.equal(r.readOnly, 1, `readOnly: got ${r.readOnly}`);
assert.equal(r.unresolvable, 1, `unresolvable: got ${r.unresolvable}`);

// A read-only field must be classified by its path, not by whether its value
// happens to be resolvable — the same dangling GUID appears in both places.
assert.equal(classify({ path: 'createdByAppId', guid: DANGLING, ownIds: new Set(), index: buildIndex(collected) }).klass, 'readOnly');

// The permission and SKU resolutions are the whole point of the richer index.
assert.equal(r.resolvableByKind.permission, 1, 'permission id must resolve');
assert.equal(r.resolvableByKind.sku, 1, 'licence SKU must resolve');
assert.equal(r.resolvableByKind.servicePlan, 1, 'service plan must resolve');
assert.equal(r.resolvableByKind.object, 5, 'object references must resolve');
// resolvableByKind must never carry a catalog kind: a built-in role or setting
// template id is the same GUID in every tenant, so it is reported as
// globalConstant, not as something that was looked up and remapped.
assert.equal(r.resolvableByKind.roleTemplate, undefined, 'roleTemplate hits must not be classed as resolvable');
assert.equal(r.resolvableByKind.settingTemplate, undefined, 'settingTemplate hits must not be classed as resolvable');

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
// Any OTHER passkey profile id is a tenant-created custom profile — a blanket
// "allowedPasskeyProfiles is global" rule would hide a real reference.
assert.equal(
  classify({ path: 'authenticationMethodConfigurations.fido2.includeTargets.allowedPasskeyProfiles',
    guid: CUSTOM_PASSKEY_PROFILE, ownIds: noOwn, index }).klass,
  'unresolvable',
  'custom passkey profiles are tenant objects, not global constants',
);

// FIDO2 key restrictions list FIDO Alliance AAGUIDs (authenticator model ids),
// identical in every tenant. The real Graph field name is plural: aaGuids.
assert.equal(
  classify({ path: 'authenticationMethodConfigurations.fido2.keyRestrictions.aaGuids',
    guid: AAGUID_YUBIKEY, ownIds: noOwn, index }).klass,
  'globalConstant',
  'FIDO2 keyRestrictions.aaGuids hold FIDO Alliance model ids',
);

// A custom authentication strength the probe did NOT collect is a genuine
// cross-tenant risk — only the three built-in strengths are global constants,
// so a blanket rule on grantControls.authenticationStrength.id would hide
// exactly this case. (Guid is Microsoft's own docs example of a custom one.)
assert.equal(
  classify({ path: 'grantControls.authenticationStrength.id', guid: UNCOLLECTED_STRENGTH, ownIds: noOwn, index }).klass,
  'unresolvable',
  'uncollected custom authentication strengths must not pass as global constants',
);
// The built-in strengths are global whether or not the policies were read.
for (const [guid, name] of [
  ['00000000-0000-0000-0000-000000000002', 'MFA'],
  ['00000000-0000-0000-0000-000000000003', 'passwordless MFA'],
  ['00000000-0000-0000-0000-000000000004', 'phishing-resistant MFA'],
]) {
  assert.equal(
    classify({ path: 'grantControls.authenticationStrength.id', guid, ownIds: noOwn, index }).klass,
    'globalConstant',
    `built-in ${name} strength must be a global constant`,
  );
}

// Verified live against Microsoft's "Manage app consent policies" doc
// (learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies)
// on 2026-09-03: each id below is quoted there verbatim. Pinned individually —
// WELL_KNOWN is a data table, not logic, so only an assertion naming each
// literal id catches one entry being dropped or mistyped later.
for (const [guid, name] of [
  ['f8d98a96-0999-43f5-8af3-69971c7bb423', 'Apple Mail'],
  ['b50c1dbd-1855-4e54-b07c-d3c3029e93d3', 'Spark Email'],
  ['e9a7fea1-1cc0-4cd9-a31b-9137ca5deedd', 'eM Client'],
  ['8acd33ea-7197-4a96-bc33-d7cc7101262f', 'Samsung Email for Android'],
  ['2cee05de-2b8f-45a2-8289-2a06ca32c4c8', 'Android Mail'],
  ['9e5f94bc-e8a4-4e73-b8be-63364c29d753', 'Thunderbird'],
  ['fb78d390-0c51-40cd-8e17-fdbfab77341b', 'Exchange Online PowerShell'],
]) {
  assert.equal(
    classify({ path: 'includes.clientApplicationIds', guid, ownIds: noOwn, index }).klass,
    'globalConstant',
    `${name} (${guid}) must be a documented global constant`,
  );
}

// Field-path constant rules still apply when the index cannot name the value:
// a SKU the tenant no longer subscribes, a service plan from such a SKU, and
// catalog template ids (setting/role templates) beyond the collected set.
assert.equal(classify({ path: 'assignedLicenses[0].skuId', guid: DANGLING, ownIds: noOwn, index }).klass, 'globalConstant');
assert.equal(classify({ path: 'assignedPlans[0].servicePlanId', guid: DANGLING, ownIds: noOwn, index }).klass, 'globalConstant');
assert.equal(classify({ path: 'templateId', guid: DANGLING, ownIds: noOwn, index }).klass, 'globalConstant');
assert.equal(classify({ path: 'roleTemplateId', guid: DANGLING, ownIds: noOwn, index }).klass, 'globalConstant');

// Server-assigned provenance stays read-only even when the value is one we
// could name: it cannot be written, so it is never a restore-fidelity risk.
assert.equal(
  classify({ path: 'createdByAppId', guid: PERM_ID, ownIds: noOwn, index }).klass,
  'readOnly',
  'readOnly classification takes precedence over index resolution',
);

// ----------------------------------------------------------- natural keys
assert.equal(naturalKey('user', { id: USER_A, userPrincipalName: 'ana@contoso.com' }), 'ana@contoso.com');
assert.equal(naturalKey('servicePrincipal', { id: SP_OBJECT, appId: SP_APPID }), SP_APPID);
assert.equal(naturalKey('subscribedSku', { skuPartNumber: 'ENTERPRISEPREMIUM' }), 'ENTERPRISEPREMIUM');

console.log('references.test.mjs — all assertions passed');
