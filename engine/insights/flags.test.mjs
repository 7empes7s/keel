import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  FLAG_PATHS, FLAG_RULES, ROLE_ASSIGNMENT_KINDS, evaluateFlags, flagValues, flaggedPriority, serviceFlagValues, tenantWideWrite,
} from './flags.mjs';
import { PRIVILEGED_DRIFT_TYPES } from '../govern/dispositionReview.mjs';

// Risk flags (insights A6). Every rule has a case that must flag and the reverse or a
// harmless change that must not. Payloads are in the shape Graph returns (the collector
// stores them as read: tools/tenant-probe/catalog.d, engine/safety/*.test.mjs fixtures).

const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const BREAK_GLASS = 'b9e00000-0000-4000-8000-0000000000b9';
const FINANCE = '9a000000-0000-4000-8000-000000000002';
const TRUSTED_HQ = '1c000000-0000-4000-8000-0000000000aa';

const caPolicy = (overrides = {}) => ({
  id: 'ca000000-0000-4000-8000-000000000001',
  displayName: 'Require MFA for admins',
  state: 'enabled',
  conditions: {
    clientAppTypes: ['all'],
    applications: { includeApplications: ['All'], excludeApplications: [] },
    users: { includeUsers: [], excludeUsers: [BREAK_GLASS], includeGroups: [], excludeGroups: [], includeRoles: [GLOBAL_ADMIN], excludeRoles: [] },
    locations: { includeLocations: ['All'], excludeLocations: [] },
    ...overrides.conditions,
  },
  grantControls: { operator: 'OR', builtInControls: ['mfa'], customAuthenticationFactors: [], termsOfUse: [], authenticationStrength: null, ...overrides.grantControls },
  sessionControls: null,
  ...(overrides.state ? { state: overrides.state } : {}),
  ...(overrides.displayName ? { displayName: overrides.displayName } : {}),
});
const strengthControls = { builtInControls: [], authenticationStrength: { id: '00000000-0000-0000-0000-000000000004', displayName: 'Phishing-resistant MFA', allowedCombinations: ['fido2'] } };

const namedLocation = (overrides = {}) => ({
  '@odata.type': '#microsoft.graph.ipNamedLocation',
  id: TRUSTED_HQ, displayName: 'HQ egress', isTrusted: false,
  ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
  ...overrides,
});
const range = (cidrAddress) => ({ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress });

const application = (overrides = {}) => ({
  id: 'a9900000-0000-4000-8000-000000000001', appId: 'a9900000-0000-4000-8000-0000000000ff', displayName: 'CRM sync',
  passwordCredentials: [{ keyId: 'k1000000-0000-4000-8000-000000000001', displayName: 'ci', hint: 'Abc', secretText: null, startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2027-01-01T00:00:00Z' }],
  keyCredentials: [],
  ...overrides,
});
const secret = (keyId) => ({ keyId, displayName: 'added', hint: 'Xyz', secretText: null, startDateTime: '2026-10-01T00:00:00Z', endDateTime: '2027-10-01T00:00:00Z' });
const certificate = (keyId) => ({ keyId, type: 'AsymmetricX509Cert', usage: 'Verify', displayName: 'CN=crm-sync', startDateTime: '2026-10-01T00:00:00Z', endDateTime: '2027-10-01T00:00:00Z' });

const methodsPolicy = (states) => ({
  id: 'authenticationMethodsPolicy', displayName: 'Authentication Methods Policy', policyVersion: '1.5',
  authenticationMethodConfigurations: Object.entries({ Fido2: 'enabled', MicrosoftAuthenticator: 'enabled', Sms: 'disabled', Voice: 'disabled', Email: 'disabled', ...states })
    .map(([id, state]) => ({ '@odata.type': `#microsoft.graph.${id.charAt(0).toLowerCase()}${id.slice(1)}AuthenticationMethodConfiguration`, id, state, excludeTargets: [] })),
});
const strengthPolicy = (allowedCombinations) => ({ id: 'a5000000-0000-4000-8000-000000000001', displayName: 'Admins: phishing-resistant', policyType: 'custom', requirementsSatisfied: 'mfa', allowedCombinations });

const crossTenant = (inbound) => ({
  id: 'crossTenantAccessPolicyConfigurationDefault', isServiceDefault: false,
  b2bCollaborationInbound: {
    usersAndGroups: { accessType: inbound, targets: [{ target: 'AllUsers', targetType: 'user' }] },
    applications: { accessType: inbound, targets: [{ target: 'AllApplications', targetType: 'application' }] },
  },
  b2bCollaborationOutbound: { usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] }, applications: { accessType: 'allowed', targets: [{ target: 'AllApplications', targetType: 'application' }] } },
  b2bDirectConnectInbound: { usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] }, applications: { accessType: 'blocked', targets: [{ target: 'AllApplications', targetType: 'application' }] } },
  b2bDirectConnectOutbound: { usersAndGroups: { accessType: 'blocked', targets: [{ target: 'AllUsers', targetType: 'user' }] }, applications: { accessType: 'blocked', targets: [{ target: 'AllApplications', targetType: 'application' }] } },
  inboundTrust: { isMfaAccepted: false, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: false },
});
const authorization = (overrides) => ({
  id: 'authorizationPolicy', displayName: 'Authorization Policy', allowInvitesFrom: 'adminsAndGuestInviters', allowEmailVerifiedUsersToJoinOrganization: false,
  guestUserRoleId: '10dae51f-b6af-4016-8d66-8c2a99b929b3', defaultUserRolePermissions: { allowedToCreateApps: false }, ...overrides,
});

/** A drift row, as the feed builds the evaluator's input from two saved copies. */
const drift = (type, change, before, after, extra = {}) => ({
  source: 'drift', type, change, name: (after ?? before)?.displayName ?? null,
  before: flagValues(type, before), after: flagValues(type, after), ...extra,
});
const service = (type, change, fields, name = 'Sharing settings') => ({ source: 'service', type, change, name, ...serviceFlagValues(fields) });
const audit = (activity, { operation = 'update', targetType = 'policy', name = null } = {}) => ({ source: 'audit', type: targetType, targetType, change: 'modified', activity, operation, name, fields: [] });

// [rule key, must flag, must not flag, sentence the flag carries]
const CASES = [
  ['ca-turned-off',
    drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ state: 'disabled' })),
    drift('conditionalAccessPolicy', 'modified', caPolicy({ state: 'disabled' }), caPolicy()),
    'Turned off: Require MFA for admins.'],
  ['ca-report-only',
    drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ state: 'enabledForReportingButNotEnforced' })),
    drift('conditionalAccessPolicy', 'modified', caPolicy({ state: 'enabledForReportingButNotEnforced' }), caPolicy()),
    'Switched to report-only, so it no longer blocks anything: Require MFA for admins.'],
  ['ca-deleted',
    drift('conditionalAccessPolicy', 'removed', caPolicy(), null),
    // A policy that was already off: deleting it changes nothing.
    drift('conditionalAccessPolicy', 'removed', caPolicy({ state: 'disabled' }), null),
    'Deleted: Require MFA for admins.'],
  ['ca-deleted-audit',
    audit('Delete conditional access policy', { operation: 'delete', name: 'Require MFA for admins' }),
    audit('Add conditional access policy', { operation: 'create', name: 'Require MFA for admins' }),
    'Deleted: Require MFA for admins.'],
  ['ca-exclusions-added',
    drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ conditions: { users: { ...caPolicy().conditions.users, excludeGroups: [FINANCE] }, locations: { includeLocations: ['All'], excludeLocations: [TRUSTED_HQ] } } })),
    // Exclusions taken away make the policy stricter.
    drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ conditions: { users: { ...caPolicy().conditions.users, excludeUsers: [] } } })),
    'Leaves out more groups and locations: Require MFA for admins.'],
  ['ca-mfa-removed',
    drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ grantControls: { builtInControls: ['compliantDevice'] } })),
    // MFA swapped for an authentication strength still asks for MFA.
    drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ grantControls: strengthControls })),
    'No longer asks for MFA: Require MFA for admins.'],
  ['admin-role-added',
    drift('roleAssignment', 'added', null, { id: 'ra1', principalId: BREAK_GLASS, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/' }, { context: { roleName: 'Global Administrator' }, key: `roleAssignment:roleDefinition:${GLOBAL_ADMIN}@user:temp@contoso.test@/` }),
    drift('roleAssignment', 'removed', { id: 'ra1', principalId: BREAK_GLASS, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/' }, null, { context: null }),
    'Someone was given an admin role: Global Administrator.'],
  ['role-group-member-added',
    drift('groupMembership', 'added', null, null, { context: { roleAssignable: true, groupName: 'Tier 0 admins' } }),
    // An ordinary group.
    drift('groupMembership', 'added', null, null, { context: { roleAssignable: false, groupName: 'Finance' } }),
    'Someone was added to a group that holds admin roles: Tier 0 admins.'],
  ['role-group-member-added-service',
    service('exchange-role-groups', 'modified', [{ path: 'Members', kind: 'changed', before: ['Organization Management'], after: ['Organization Management', 'Helpdesk lead'] }], 'Organization Management'),
    service('exchange-role-groups', 'modified', [{ path: 'Members', kind: 'changed', before: ['Organization Management', 'Helpdesk lead'], after: ['Organization Management'] }], 'Organization Management'),
    'Someone was added to an Exchange admin role group: Organization Management.'],
  ['admin-role-added-audit',
    audit('Add member to role', { targetType: 'role', name: 'Global Administrator' }),
    audit('Remove member from role', { targetType: 'role', name: 'Global Administrator' }),
    'Someone was added to an admin role: Global Administrator.'],
  ['app-credential-added',
    drift('application', 'modified', application(), application({ passwordCredentials: [...application().passwordCredentials, secret('k2000000-0000-4000-8000-000000000002')] })),
    // An old secret removed.
    drift('application', 'modified', application(), application({ passwordCredentials: [] })),
    'New client secret on: CRM sync.'],
  ['app-credential-added-audit',
    audit('Add service principal credentials', { targetType: 'servicePrincipal', name: 'CRM sync' }),
    audit('Remove service principal credentials', { targetType: 'servicePrincipal', name: 'CRM sync' }),
    'New secret or certificate on: CRM sync.'],
  ['app-permission-tenant-write',
    drift('appRoleGrant', 'added', null, null, { context: { permission: 'Directory.ReadWrite.All', appName: 'CRM sync' } }),
    drift('appRoleGrant', 'removed', null, null, { context: { permission: 'Directory.ReadWrite.All', appName: 'CRM sync' } }),
    'New tenant-wide permission Directory.ReadWrite.All for: CRM sync.'],
  ['app-permission-granted',
    drift('appRoleGrant', 'added', null, null, { context: { permission: 'User.Read.All', appName: 'CRM sync' } }),
    drift('appRoleGrant', 'removed', null, null, { context: { permission: 'User.Read.All', appName: 'CRM sync' } }),
    'New permission User.Read.All for: CRM sync.'],
  ['app-permission-granted-audit',
    audit('Add app role assignment to service principal', { targetType: 'servicePrincipal', name: 'CRM sync' }),
    audit('Remove app role assignment from service principal', { targetType: 'servicePrincipal', name: 'CRM sync' }),
    'New app permission for: CRM sync.'],
  ['location-trusted',
    drift('namedLocation', 'modified', namedLocation(), namedLocation({ isTrusted: true })),
    drift('namedLocation', 'modified', namedLocation({ isTrusted: true }), namedLocation()),
    'Now trusted for sign-in: HQ egress.'],
  ['trusted-ranges-added',
    drift('namedLocation', 'modified', namedLocation({ isTrusted: true }), namedLocation({ isTrusted: true, ipRanges: [range('203.0.113.0/24'), range('198.51.100.0/24')] })),
    // Ranges added to an untrusted location only narrow other rules.
    drift('namedLocation', 'modified', namedLocation(), namedLocation({ ipRanges: [range('203.0.113.0/24'), range('198.51.100.0/24')] })),
    'New trusted IP ranges (198.51.100.0/24) in: HQ egress.'],
  ['security-defaults-off',
    drift('identitySecurityDefaultsEnforcementPolicy', 'modified', { id: '00000000-0000-0000-0000-000000000005', displayName: 'Security Defaults', isEnabled: true }, { id: '00000000-0000-0000-0000-000000000005', displayName: 'Security Defaults', isEnabled: false }),
    drift('identitySecurityDefaultsEnforcementPolicy', 'modified', { id: '00000000-0000-0000-0000-000000000005', displayName: 'Security Defaults', isEnabled: false }, { id: '00000000-0000-0000-0000-000000000005', displayName: 'Security Defaults', isEnabled: true }),
    'Security defaults turned off for the whole tenant.'],
  ['weak-method-on',
    drift('authenticationMethodsPolicy', 'modified', methodsPolicy({}), methodsPolicy({ Sms: 'enabled' })),
    drift('authenticationMethodsPolicy', 'modified', methodsPolicy({ Sms: 'enabled' }), methodsPolicy({})),
    'Weaker sign-in method turned on: text message (SMS).'],
  ['auth-strength-loosened',
    drift('authenticationStrengthPolicy', 'modified', strengthPolicy(['windowsHelloForBusiness', 'fido2']), strengthPolicy(['windowsHelloForBusiness', 'fido2', 'password,sms'])),
    drift('authenticationStrengthPolicy', 'modified', strengthPolicy(['windowsHelloForBusiness', 'fido2', 'password,sms']), strengthPolicy(['windowsHelloForBusiness', 'fido2'])),
    'Accepts more sign-in methods than before: Admins: phishing-resistant.'],
  ['cross-tenant-opened',
    drift('crossTenantAccessPolicyConfigurationDefault', 'modified', crossTenant('blocked'), crossTenant('allowed')),
    drift('crossTenantAccessPolicyConfigurationDefault', 'modified', crossTenant('allowed'), crossTenant('blocked')),
    'Other organizations are allowed by default now: guests from other organizations.'],
  ['guest-invites-opened',
    drift('authorizationPolicy', 'modified', authorization({}), authorization({ allowInvitesFrom: 'everyone' })),
    drift('authorizationPolicy', 'modified', authorization({ allowInvitesFrom: 'everyone' }), authorization({ allowInvitesFrom: 'adminsAndGuestInviters' })),
    'More people can invite guests: everyone, guests included.'],
  ['sharing-widened',
    service('sharepoint-site-settings', 'modified', [{ path: 'sharingCapability', kind: 'changed', before: 'ExternalUserSharingOnly', after: 'ExternalUserAndGuestSharing' }]),
    service('sharepoint-site-settings', 'modified', [{ path: 'sharingCapability', kind: 'changed', before: 'ExternalUserAndGuestSharing', after: 'ExistingExternalUserSharingOnly' }]),
    'SharePoint sharing opened wider: files can now be shared with anyone, with links that need no sign-in.'],
  ['anyone-link-expiry-longer',
    service('sharepoint-tenant', 'modified', [{ path: 'RequireAnonymousLinksExpireInDays', kind: 'changed', before: 14, after: 0 }], 'Tenant settings'),
    service('sharepoint-tenant', 'modified', [{ path: 'RequireAnonymousLinksExpireInDays', kind: 'changed', before: 0, after: 14 }], 'Tenant settings'),
    'Anyone links no longer expire (they expired after 14 days).'],
];

test('every rule has a case, and every case names a rule', () => {
  assert.deepEqual(CASES.map(([key]) => key).sort(), FLAG_RULES.map((rule) => rule.key).sort());
  for (const rule of FLAG_RULES) {
    assert.ok(['critical', 'high'].includes(rule.severity), rule.key);
    assert.equal(typeof rule.test, 'function', rule.key);
    assert.equal(typeof rule.sentence, 'function', rule.key);
  }
});

for (const [key, flagged, harmless, sentence] of CASES) {
  test(`${key}: flags the change it names, and not the reverse or a harmless one`, () => {
    const rule = FLAG_RULES.find((entry) => entry.key === key);
    const flags = evaluateFlags(flagged);
    const flag = flags.find((entry) => entry.key === key);
    assert.ok(flag, `${key} should flag: ${JSON.stringify(flags)}`);
    assert.equal(flag.severity, rule.severity);
    assert.equal(flag.sentence, sentence);
    assert.deepEqual(evaluateFlags(harmless).filter((entry) => entry.key === key), [], `${key} must not flag the reverse change`);
    // Revert check: without this rule, nothing else raises the same flag.
    assert.ok(!evaluateFlags(flagged, FLAG_RULES.filter((entry) => entry.key !== key)).some((entry) => entry.key === key));
  });
}

test('changes that look alike but are not weaker raise no flag', () => {
  // Entra logs this activity for a secret removed as well as one added.
  assert.deepEqual(evaluateFlags(audit('Update application Certificates and secrets management', { targetType: 'application', name: 'CRM sync' })), []);
  // A policy that was off enforced nothing: turning it on with exclusions, or without MFA, weakens nothing.
  const offWithMfa = caPolicy({ state: 'disabled' });
  assert.deepEqual(evaluateFlags(drift('conditionalAccessPolicy', 'modified', offWithMfa, caPolicy({ grantControls: { builtInControls: ['compliantDevice'] }, conditions: { users: { ...caPolicy().conditions.users, excludeGroups: [FINANCE] } } }))), []);
  // MFA swapped for a block is stricter.
  assert.deepEqual(evaluateFlags(drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ grantControls: { builtInControls: ['block'] } }))), []);
  // An assignment's own name is never used for the role: some services name it after the person.
  const [exchange] = evaluateFlags({ source: 'drift', type: 'exchangeRoleAssignment', change: 'added', name: 'Mail Recipients-Ada Admin', key: 'exchangeRoleAssignment:x', before: null, after: null });
  assert.equal(exchange.sentence, 'Someone was given an admin role.');
});

test('a rename, the most common harmless change, raises no flag', () => {
  assert.deepEqual(evaluateFlags(drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ displayName: 'Require MFA for all admins' }))), []);
  assert.deepEqual(evaluateFlags(drift('namedLocation', 'modified', namedLocation({ isTrusted: true }), namedLocation({ isTrusted: true, displayName: 'Head office' }))), []);
  assert.deepEqual(evaluateFlags(audit('Update conditional access policy', { name: 'Require MFA for admins' })), [], 'the audit log gives no values, so an update is not judged');
});

test('rules read only their own sources and kinds', () => {
  // The same values on another kind, or from another source, do not flag.
  const off = drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ state: 'disabled' }));
  assert.deepEqual(evaluateFlags({ ...off, type: 'deviceConfiguration' }), []);
  assert.deepEqual(evaluateFlags({ ...off, source: 'service' }), []);
  assert.deepEqual(evaluateFlags(null), []);
  // The person and the role are two targets of one audit record: only the role's row flags.
  assert.deepEqual(evaluateFlags(audit('Add member to role', { targetType: 'user', name: 'Ada Admin' })), []);
});

test('sentences use the name as given, so a code name stays a code name, and never invent one', () => {
  const [flag] = evaluateFlags({ ...drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ state: 'disabled' })), name: 'Block Person K7Q2' });
  assert.equal(flag.sentence, 'Turned off: Block Person K7Q2.');
  const [unnamed] = evaluateFlags({ ...drift('conditionalAccessPolicy', 'modified', caPolicy(), caPolicy({ state: 'disabled' })), name: null });
  assert.equal(unnamed.sentence, 'Turned off: a Conditional Access policy.');
  // A role key that holds an id names no role.
  const [role] = evaluateFlags(drift('roleAssignment', 'added', null, { id: 'ra1' }, { key: `roleAssignment:roleDefinition:${GLOBAL_ADMIN}@user:x@/`, name: null }));
  assert.equal(role.sentence, 'Someone was given an admin role.');
  const [named] = evaluateFlags(drift('roleAssignment', 'added', null, { id: 'ra1' }, { key: 'roleAssignment:roleDefinition:Exchange Administrator@group:ops@/', name: null }));
  assert.equal(named.sentence, 'Someone was given an admin role: Exchange Administrator.');
});

test('several flags on one change: the most severe first, and each says its own part', () => {
  const after = caPolicy({ conditions: { users: { ...caPolicy().conditions.users, excludeRoles: [GLOBAL_ADMIN] } }, grantControls: { builtInControls: ['compliantDevice'] } });
  const flags = evaluateFlags(drift('conditionalAccessPolicy', 'modified', caPolicy(), after));
  assert.deepEqual(flags.map((flag) => flag.key), ['ca-exclusions-added', 'ca-mfa-removed']);
  const both = evaluateFlags(drift('application', 'modified', application(), application({ passwordCredentials: [...application().passwordCredentials, secret('k3')], keyCredentials: [certificate('c1')] })));
  assert.equal(both[0].sentence, 'New client secret and certificate on: CRM sync.');
  const methods = evaluateFlags(drift('authenticationMethodsPolicy', 'modified', methodsPolicy({}), methodsPolicy({ Voice: 'enabled', Email: 'enabled' })));
  assert.equal(methods[0].sentence, 'Weaker sign-in methods turned on: voice call and email one-time passcode.');
  const strength = evaluateFlags(drift('conditionalAccessPolicy', 'modified', caPolicy({ grantControls: strengthControls }), caPolicy({ grantControls: { builtInControls: [], authenticationStrength: null } })));
  assert.equal(strength[0].sentence, 'No longer asks for an authentication strength: Require MFA for admins.');
});

test('a new app with a secret, a new trusted location and an expiry made longer flag too', () => {
  assert.equal(evaluateFlags(drift('application', 'added', null, application()))[0].key, 'app-credential-added');
  assert.equal(evaluateFlags(drift('application', 'added', null, application({ passwordCredentials: [] }))).length, 0);
  assert.equal(evaluateFlags(drift('namedLocation', 'added', null, namedLocation({ isTrusted: true })))[0].key, 'location-trusted');
  assert.equal(evaluateFlags(drift('namedLocation', 'added', null, namedLocation())).length, 0);
  const [longer] = evaluateFlags(service('sharepoint-tenant', 'modified', [{ path: 'RequireAnonymousLinksExpireInDays', before: 7, after: 30 }]));
  assert.equal(longer.sentence, 'Anyone links last longer: 30 days instead of 7.');
  assert.equal(evaluateFlags(service('sharepoint-tenant', 'modified', [{ path: 'RequireAnonymousLinksExpireInDays', before: 30, after: 7 }])).length, 0);
  const [onedrive] = evaluateFlags(service('sharepoint-tenant', 'modified', [{ path: 'OneDriveSharingCapability', before: 'Disabled', after: 'ExternalUserSharingOnly' }]));
  assert.equal(onedrive.sentence, 'OneDrive sharing opened wider: files can now be shared with new and existing guests.');
  const [join] = evaluateFlags(drift('authorizationPolicy', 'modified', authorization({}), authorization({ allowEmailVerifiedUsersToJoinOrganization: true })));
  assert.equal(join.sentence, 'Anyone with a verified email can now join the tenant on their own.');
});

test('tenant-wide write permissions are the critical ones', () => {
  for (const permission of ['Directory.ReadWrite.All', 'Directory.Read.All', 'RoleManagement.ReadWrite.Directory', 'AppRoleAssignment.ReadWrite.All', 'Mail.ReadWrite.All', 'Sites.ReadWrite.All']) {
    assert.equal(tenantWideWrite(permission), true, permission);
  }
  for (const permission of ['User.Read.All', 'Mail.Send', 'Sites.Selected', null]) assert.equal(tenantWideWrite(permission), false, String(permission));
  // A permission whose name the backup does not hold is still a new permission.
  const [unknown] = evaluateFlags(drift('appRoleGrant', 'added', null, null, { context: { permission: null, appName: null }, name: null }));
  assert.deepEqual([unknown.key, unknown.severity, unknown.sentence], ['app-permission-granted', 'high', 'New app permission for: an app.']);
});

test('admin-role kinds come from the privileged list a second-person review uses', () => {
  for (const type of PRIVILEGED_DRIFT_TYPES.filter((entry) => entry.endsWith('RoleAssignment'))) assert.ok(ROLE_ASSIGNMENT_KINDS.includes(type), type);
  assert.ok(ROLE_ASSIGNMENT_KINDS.includes('roleAssignment'));
});

test('a critical flag makes the row critical with its sentence; a high flag raises low and normal only', () => {
  const critical = [{ key: 'ca-turned-off', severity: 'critical', sentence: 'Turned off: X.' }];
  const high = [{ key: 'location-trusted', severity: 'high', sentence: 'Now trusted for sign-in: HQ.' }];
  assert.deepEqual(flaggedPriority({ priority: 'normal', priorityReason: null }, critical), { priority: 'critical', priorityReason: 'Turned off: X.' });
  assert.deepEqual(flaggedPriority({ priority: 'critical', priorityReason: 'Can lock out.' }, critical), { priority: 'critical', priorityReason: 'Turned off: X.' });
  assert.deepEqual(flaggedPriority({ priority: 'low', priorityReason: null }, high), { priority: 'high', priorityReason: 'Now trusted for sign-in: HQ.' });
  assert.deepEqual(flaggedPriority({ priority: 'normal', priorityReason: 'r' }, high), { priority: 'high', priorityReason: 'Now trusted for sign-in: HQ.' });
  assert.deepEqual(flaggedPriority({ priority: 'critical', priorityReason: 'r' }, high), { priority: 'critical', priorityReason: 'r' });
  assert.deepEqual(flaggedPriority({ priority: 'normal', priorityReason: 'r' }, []), { priority: 'normal', priorityReason: 'r' });
});

test('flagValues reads only the declared paths, and nothing for a kind no rule reads', () => {
  const values = flagValues('application', application({ keyCredentials: [certificate('c1')] }));
  assert.deepEqual(Object.keys(values).sort(), [...FLAG_PATHS.application].sort());
  assert.deepEqual(values['keyCredentials[*].keyId'], ['c1']);
  assert.ok(!JSON.stringify(values).includes('CRM sync'), 'names and other fields are not read');
  assert.equal(flagValues('deviceConfiguration', { id: 'x' }), null);
  assert.equal(flagValues('application', null), null);
});
