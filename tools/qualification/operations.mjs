#!/usr/bin/env node
/**
 * Roadmap task-63: the operation qualification ledger, on the command line,
 * plus a fixture harness for the operations that are registered today.
 *
 *   node tools/qualification/operations.mjs            # table: every catalogue type and its decision
 *   node tools/qualification/operations.mjs --json     # the full per-operation ledger
 *   node tools/qualification/operations.mjs --harness  # also run the fixture harness
 *   node tools/qualification/operations.mjs --check    # exit 1 if any catalogue type lacks a decision
 *   node tools/qualification/operations.mjs --batch identity-application [--json]
 *   node tools/qualification/operations.mjs --batch policy  # task-108: also prints the policy family ledger
 *   node tools/qualification/operations.mjs --batch administrative-configuration  # task-109: also prints what cannot be recovered
 *                                                       # task-107: run one expansion batch and print its evidence report
 *   node tools/qualification/operations.mjs --live-evidence docs/release/qualifications/entra-live
 *                                                       # issue #148: apply committed Entra live records first
 *
 * The harness drives the PRODUCTION applyWave() path, once for each registered
 * group, named location, role assignment and conditional access operation
 * (including the task-152 Conditional Access soft-delete restore),
 * against an in-memory fake Graph. Its results are reported beside the ledger
 * and never change it: a passing fake cannot register, promote or qualify
 * anything (capabilities.mjs owns claims). No network, no tenant.
 */
import { pathToFileURL } from 'node:url';

import { CATALOG } from '../tenant-probe/catalog.mjs';
import { OPERATIONS, capabilityFor, graphPathFor, isSupportedClaim } from '../../engine/coverage/capabilities.mjs';
import { EXPANSION_BATCHES, buildExpansionInventory, buildOperationLedger } from '../../engine/coverage/qualification.mjs';
import { buildPolicyFamilyLedger } from '../../engine/restore/policyOperations.mjs';
import { buildAdministrativeFamilyLedger } from '../../engine/restore/administrativeOperations.mjs';
import { TENANT_POLICY_RECORDS, tenantPolicyRecordFor, tenantPolicyRoute } from '../../engine/restore/tenantPolicyOperations.mjs';

const TENANT_POLICY_TYPES = new Set(TENANT_POLICY_RECORDS.map((entry) => entry.resourceType));
import { applyWave } from '../../engine/restore/applyEngine.mjs';
import { completionItemsFor } from '../../engine/restore/completion.mjs';

const FIXTURE_PAYLOADS = Object.freeze({
  group: { displayName: 'Fixture group', mailNickname: 'fixture-group', mailEnabled: false, securityEnabled: true, groupTypes: [] },
  // Roadmap task-150: a cloud user with one direct licence.
  user: {
    userPrincipalName: 'fixture.user@fixture.example', displayName: 'Fixture User', accountEnabled: true,
    department: 'Finance', jobTitle: 'Analyst', usageLocation: 'GB', onPremisesSyncEnabled: null,
    assignedLicenses: [{ skuId: '6fd2c87f-b296-42f0-b197-1e91e994b900', disabledPlans: [] }],
    licenseAssignmentStates: [{ skuId: '6fd2c87f-b296-42f0-b197-1e91e994b900', disabledPlans: [], assignedByGroup: null, state: 'Active' }],
  },
  roleAssignment: { principalId: 'fixture-principal', roleDefinitionId: 'fixture-role', directoryScopeId: '/' },
  namedLocation: {
    '@odata.type': '#microsoft.graph.ipNamedLocation', displayName: 'Fixture location', isTrusted: false,
    ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
  },
  conditionalAccessPolicy: {
    displayName: 'Fixture policy', state: 'enabledForReportingButNotEnforced',
    conditions: { users: { includeUsers: ['None'] }, applications: { includeApplications: ['None'] } },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  },
  // Roadmap task-107. The snapshot carries credential metadata and the old
  // appId; neither may reach a create body.
  application: {
    displayName: 'Fixture app', signInAudience: 'AzureADMyOrg', appId: 'fixture-source-appid',
    passwordCredentials: [{ keyId: 'fixture-key', displayName: 'fixture secret', hint: 'abc', secretText: null }],
    keyCredentials: [], requiredResourceAccess: [], tags: [],
  },
  servicePrincipal: { appId: 'fixture-existing-appid', accountEnabled: true, appRoleAssignmentRequired: false, tags: [] },
  // Roadmap task-108: a custom strength. policyType and requirementsSatisfied
  // are computed by Entra and never sent.
  authenticationStrengthPolicy: {
    displayName: 'Fixture strength', description: 'Fixture custom strength', policyType: 'custom',
    requirementsSatisfied: 'mfa', allowedCombinations: ['fido2', 'windowsHelloForBusiness'],
  },
  // Roadmap task-109: an administrative unit and a tenant-wide setting bound to
  // the Microsoft-published Group.Unified template.
  administrativeUnit: { displayName: 'Fixture unit', description: 'Fixture administrative unit', visibility: null },
  groupSetting: {
    displayName: 'Group.Unified', templateId: '62375ab9-6b52-47ed-826b-58e47e0e304b',
    values: [{ name: 'AllowGuestsToAccessGroups', value: 'false' }, { name: 'EnableGroupCreation', value: 'true' }],
  },
  // Roadmap task-149: the tenant-wide security policies (singletons and partners).
  authorizationPolicy: {
    displayName: 'Authorization Policy', allowInvitesFrom: 'adminsAndGuestInviters', allowedToUseSSPR: true,
    blockMsolPowerShell: true, defaultUserRolePermissions: { allowedToCreateApps: false, allowedToCreateSecurityGroups: false },
  },
  authenticationMethodsPolicy: {
    displayName: 'Authentication Methods Policy', policyMigrationState: 'migrationComplete',
    registrationEnforcement: { authenticationMethodsRegistrationCampaign: { state: 'enabled', snoozeDurationInDays: 1 } },
    authenticationMethodConfigurations: [
      { id: 'Fido2', state: 'enabled', isAttestationEnforced: true, includeTargets: [{ targetType: 'group', id: 'all_users' }] },
      { id: 'Sms', state: 'disabled', includeTargets: [] },
    ],
  },
  identitySecurityDefaultsEnforcementPolicy: { displayName: 'Security Defaults', isEnabled: false },
  crossTenantAccessPolicy: { displayName: 'CrossTenantAccessPolicy', allowedCloudEndpoints: [] },
  crossTenantAccessPolicyConfigurationDefault: {
    isServiceDefault: false,
    inboundTrust: { isMfaAccepted: true, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: false },
    b2bCollaborationInbound: { usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] } },
  },
  crossTenantAccessPolicyPartner: {
    tenantId: 'fixture-partner-tenant',
    inboundTrust: { isMfaAccepted: true, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: false },
  },
  adminConsentRequestPolicy: {
    isEnabled: true, notifyReviewers: true, remindersEnabled: true, requestDurationInDays: 30,
    reviewers: [{ query: '/v1.0/users/fixture-reviewer', queryType: 'MicrosoftGraph', queryRoot: null }],
  },
  // Issue #156: basic tenant settings. Image paths and the CDN list are
  // collected but never written.
  organizationalBranding: {
    id: '0', signInPageText: 'Welcome to Fixture', usernameHintText: 'name@fixture.example', backgroundColor: '#1B2A4A',
    cdnList: ['fixture-cdn.example'], bannerLogoRelativeUrl: 'fixture/banner.png',
  },
  organizationalBrandingLocalization: { id: 'fr-FR', signInPageText: 'Bienvenue chez Fixture', usernameHintText: 'nom@fixture.example' },
  groupLifecyclePolicy: { id: 'fixture-lifecycle', groupLifetimeInDays: 180, managedGroupTypes: 'Selected', alternateNotificationEmails: 'admins@fixture.example' },
  authenticationFlowsPolicy: { id: 'authenticationFlowsPolicy', displayName: 'Authentication flows policy', selfServiceSignUp: { isEnabled: false } },
  // Issue #155: an Intune compliance policy (with the actions Graph needs on
  // create), a device restriction profile and a settings catalog policy.
  deviceCompliancePolicy: {
    '@odata.type': '#microsoft.graph.windows10CompliancePolicy', displayName: 'Fixture compliance', description: 'Fixture',
    passwordRequired: true, passwordMinimumLength: 12, bitLockerEnabled: true, roleScopeTagIds: ['0'], version: 3,
    scheduledActionsForRule: [{
      id: 'fixture-rule', ruleName: 'PasswordRequired',
      scheduledActionConfigurations: [{ id: 'fixture-action', actionType: 'block', gracePeriodHours: 24, notificationTemplateId: '00000000-0000-0000-0000-000000000000', notificationMessageCCList: [] }],
    }],
  },
  deviceConfiguration: {
    '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', displayName: 'Fixture restrictions', description: 'Fixture',
    passwordRequired: true, cameraBlocked: false, defenderRequireRealTimeMonitoring: true, roleScopeTagIds: ['0'], version: 2, supportsScopeTags: true,
  },
  configurationPolicy: {
    name: 'Fixture settings catalog', description: 'Fixture', platforms: 'windows10', technologies: 'mdm', roleScopeTagIds: ['0'],
    settingCount: 1, creationSource: null, isAssigned: false,
    templateReference: { templateId: '', templateFamily: 'none', templateDisplayName: null, templateDisplayVersion: null },
    settings: [{
      id: '0',
      settingInstance: {
        '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
        settingDefinitionId: 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring',
        settingInstanceTemplateReference: null,
        choiceSettingValue: { value: 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring_1', settingValueTemplateReference: null, children: [] },
      },
    }],
  },
  // Roadmap task-151: a custom role, a time-bound PIM eligibility and the PIM
  // settings of one role (MFA and justification on activation, 8-hour maximum).
  roleDefinition: {
    displayName: 'Fixture helpdesk role', description: 'Fixture custom role', isBuiltIn: false, isEnabled: true,
    templateId: 'fixture-role-template', version: '1',
    rolePermissions: [{ allowedResourceActions: ['microsoft.directory/users/password/update'], condition: null }],
  },
  roleEligibilitySchedule: {
    principalId: 'fixture-principal', roleDefinitionId: 'fixture-role', directoryScopeId: '/', memberType: 'Direct', status: 'Provisioned',
    scheduleInfo: { startDateTime: '2026-01-01T00:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2099-01-01T00:00:00Z' } },
  },
  unifiedRoleManagementPolicy: {
    displayName: 'DirectoryRole', scopeId: '/', scopeType: 'DirectoryRole', isOrganizationDefault: false,
    rules: [
      {
        '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule', id: 'Enablement_EndUser_Assignment',
        enabledRules: ['MultiFactorAuthentication', 'Justification'],
        target: { caller: 'EndUser', operations: ['all'], level: 'Assignment' },
      },
      {
        '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule', id: 'Expiration_EndUser_Assignment',
        isExpirationRequired: true, maximumDuration: 'PT8H',
        target: { caller: 'EndUser', operations: ['all'], level: 'Assignment' },
      },
    ],
  },
});

// Roadmap task-109: the drift an update fixture reverts, for a type whose
// display name is not writable.
const FIXTURE_DRIFT = Object.freeze({
  // Roadmap task-150: a changed department and a removed licence.
  user: () => ({ department: 'Sales', assignedLicenses: [], licenseAssignmentStates: [] }),
  groupSetting: (payload) => ({ values: payload.values.map((entry) => ({ ...entry, value: entry.value === 'true' ? 'false' : 'true' })) }),
  // Roadmap task-149: each singleton drifts a writable setting.
  authorizationPolicy: () => ({ allowInvitesFrom: 'everyone' }),
  authenticationMethodsPolicy: (payload) => ({
    authenticationMethodConfigurations: payload.authenticationMethodConfigurations.map((config) => (config.id === 'Fido2' ? { ...config, state: 'disabled' } : config)),
  }),
  identitySecurityDefaultsEnforcementPolicy: () => ({ isEnabled: true }),
  crossTenantAccessPolicy: () => ({ allowedCloudEndpoints: ['microsoftonline.us'] }),
  crossTenantAccessPolicyConfigurationDefault: (payload) => ({ inboundTrust: { ...payload.inboundTrust, isMfaAccepted: false } }),
  crossTenantAccessPolicyPartner: (payload) => ({ inboundTrust: { ...payload.inboundTrust, isMfaAccepted: false } }),
  adminConsentRequestPolicy: () => ({ isEnabled: false }),
  // Issue #156: the restore reverts defaced text, a shortened group lifetime
  // (a longer one is restored; a shorter one would be refused) and an enabled
  // self-service sign-up.
  organizationalBranding: () => ({ signInPageText: 'Defaced' }),
  organizationalBrandingLocalization: () => ({ signInPageText: 'Defaced' }),
  groupLifecyclePolicy: () => ({ groupLifetimeInDays: 90 }),
  authenticationFlowsPolicy: () => ({ selfServiceSignUp: { isEnabled: true } }),
  // Issue #155: a weakened password rule and grace period, a camera unblocked,
  // and a settings catalog value switched off.
  deviceCompliancePolicy: (payload) => ({
    passwordMinimumLength: 4,
    scheduledActionsForRule: payload.scheduledActionsForRule.map((rule) => ({
      ...rule, scheduledActionConfigurations: rule.scheduledActionConfigurations.map((action) => ({ ...action, gracePeriodHours: 720 })),
    })),
  }),
  deviceConfiguration: () => ({ cameraBlocked: true, version: 5 }),
  configurationPolicy: (payload) => ({
    settings: payload.settings.map((setting) => ({
      ...setting,
      settingInstance: { ...setting.settingInstance, choiceSettingValue: { ...setting.settingInstance.choiceSettingValue, value: 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring_0' } },
    })),
  }),
  // Roadmap task-151: MFA on activation was turned off; the restore turns it back on.
  unifiedRoleManagementPolicy: (payload) => ({
    rules: payload.rules.map((rule) => (rule.id === 'Enablement_EndUser_Assignment' ? { ...rule, enabledRules: ['Justification'] } : rule)),
  }),
});

// Roadmap task-149: lockout-sensitive tenant policies need a lockout gate; the
// harness supplies one that allows, because it proves the writer, not the gate.
const FIXTURE_LOCKOUT_GATE = Object.freeze({ evaluate: () => ({ allowed: true, reason: 'fixture harness' }) });

const FIXTURE_TENANT = 'fixture-tenant';

/** Where the fake Graph holds a tenant policy object: the same route its update writes to. */
function tenantPolicyFixturePath(resource) {
  return tenantPolicyRoute(tenantPolicyRecordFor(resource.resourceType, 'update'), resource, { targetTenant: FIXTURE_TENANT });
}

// Roadmap task-109: the harness's snapshot read every collection completely,
// which is what a governed delete needs as evidence of absence.
const FIXTURE_COVERAGE = Object.freeze(Object.fromEntries(
  Object.keys(FIXTURE_PAYLOADS).map((type) => [type, Object.freeze({ outcome: 'complete' })]),
));

// Natural keys that already exist in the fixture target, per type (a service
// principal's explicit appId reference resolves against its application).
const FIXTURE_TARGET_IDS = Object.freeze({
  servicePrincipal: [['application:fixture-existing-appid', 'fixture-app-object']],
});

/** An in-memory Graph that honours create/PATCH/DELETE/soft-restore and read-back. */
export function fakeGraph() {
  const objects = new Map();
  const deleted = new Map();
  const writes = [];
  let next = 0;
  return {
    objects,
    deleted,
    writes,
    async write(version, path, { method, body }) {
      writes.push({ method, path });
      // Roadmap task-152: a Conditional Access policy is restored from its own
      // deleted-items container; the fake keeps one deleted map for both.
      const restore = /^\/directory\/deletedItems\/([^/]+)\/restore$/.exec(path)
        ?? /^\/identity\/conditionalAccess\/deletedItems\/policies\/([^/]+)\/restore$/.exec(path);
      if (restore && method === 'POST') {
        const id = decodeURIComponent(restore[1]);
        const entry = deleted.get(id);
        if (!entry) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
        deleted.delete(id);
        objects.set(entry.path, entry.body);
        return { ok: true, status: 200, body: entry.body };
      }
      // Roadmap task-149: a partner is addressed by its tenantId, a method
      // configuration lives inside its policy, and PUT replaces the object.
      if (method === 'POST' && path === '/policies/crossTenantAccessPolicy/partners') {
        const created = { ...body };
        objects.set(`${path}/${body.tenantId}`, created);
        return { ok: true, status: 201, body: created };
      }
      const methodConfig = /^\/policies\/authenticationMethodsPolicy\/authenticationMethodConfigurations\/([^/]+)$/.exec(path);
      if (methodConfig && method === 'PATCH') {
        const policy = objects.get('/policies/authenticationMethodsPolicy');
        const id = decodeURIComponent(methodConfig[1]);
        const index = policy?.authenticationMethodConfigurations?.findIndex((config) => config.id === id) ?? -1;
        if (index < 0) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
        const { '@odata.type': _type, ...fields } = body;
        const configurations = policy.authenticationMethodConfigurations.map((config, i) => (i === index ? { ...config, ...fields } : config));
        objects.set('/policies/authenticationMethodsPolicy', { ...policy, authenticationMethodConfigurations: configurations });
        return { ok: true, status: 204, body: null };
      }
      // Roadmap task-150: assignLicense adds (or re-plans) licences on the object.
      const licence = /^\/(users|groups)\/([^/]+)\/assignLicense$/.exec(path);
      if (licence && method === 'POST') {
        const target = `/${licence[1]}/${decodeURIComponent(licence[2])}`;
        const object = objects.get(target);
        if (!object) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
        if (licence[1] === 'users' && !object.usageLocation) return { ok: false, status: 400, body: { error: { code: 'Request_BadRequest', message: 'usage location is not set' } } };
        const removed = new Set((body.removeLicenses ?? []).map((sku) => sku.toLowerCase()));
        const added = new Map(body.addLicenses.map((entry) => [entry.skuId.toLowerCase(), entry]));
        const assignedLicenses = [
          ...(object.assignedLicenses ?? []).filter((entry) => !removed.has(entry.skuId.toLowerCase()) && !added.has(entry.skuId.toLowerCase())),
          ...body.addLicenses.map((entry) => ({ skuId: entry.skuId, disabledPlans: entry.disabledPlans })),
        ];
        const updated = { ...object, assignedLicenses };
        if (licence[1] === 'users') {
          updated.licenseAssignmentStates = [
            ...(object.licenseAssignmentStates ?? []).filter((entry) => entry.assignedByGroup || !added.has(entry.skuId.toLowerCase())),
            ...body.addLicenses.map((entry) => ({ skuId: entry.skuId, disabledPlans: entry.disabledPlans, assignedByGroup: null, state: 'Active' })),
          ];
        }
        objects.set(target, updated);
        return { ok: true, status: 200, body: updated };
      }
      // Issue #155: Intune. /assign replaces a policy's whole assignment list;
      // scheduleActionsForRules replaces a compliance policy's actions; and a
      // compliance policy cannot be created without its actions.
      const assign = /^(\/device(?:Management|AppManagement)\/[^/]+\/[^/]+)\/assign$/.exec(path);
      if (assign && method === 'POST') {
        if (!objects.has(assign[1])) return { ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } };
        const value = (body.assignments ?? []).map((entry, index) => ({ ...entry, id: `${assign[1].split('/').pop()}_${index}` }));
        objects.set(`${assign[1]}/assignments`, { value });
        return { ok: true, status: 200, body: { value } };
      }
      const actions = /^(\/deviceManagement\/deviceCompliancePolicies\/[^/]+)\/scheduleActionsForRules$/.exec(path);
      if (actions && method === 'POST') {
        if (!objects.has(actions[1])) return { ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } };
        objects.set(actions[1], { ...objects.get(actions[1]), scheduledActionsForRule: body.deviceComplianceScheduledActionForRules });
        return { ok: true, status: 204, body: null };
      }
      if (method === 'POST' && path === '/deviceManagement/deviceCompliancePolicies' && !(body.scheduledActionsForRule?.length > 0)) {
        return { ok: false, status: 400, body: { error: { code: 'BadRequest', message: 'scheduledActionsForRule is required' } } };
      }
      // Roadmap task-151: an eligibility request creates its schedule (adminAssign
      // only, with a justification and an end date not in the past), and a PIM
      // rule is patched inside its policy.
      if (method === 'POST' && path === '/roleManagement/directory/roleEligibilityScheduleRequests') {
        const end = Date.parse(body?.scheduleInfo?.expiration?.endDateTime ?? '');
        if (body?.action !== 'adminAssign' || !body.justification || !body.scheduleInfo || (!Number.isNaN(end) && end <= Date.now())) {
          return { ok: false, status: 400, body: { error: { code: 'RoleAssignmentRequestPolicyValidationFailed' } } };
        }
        next += 1;
        const scheduleId = `fixture-schedule-${next}`;
        objects.set(`/roleManagement/directory/roleEligibilitySchedules/${scheduleId}`, {
          id: scheduleId, principalId: body.principalId, roleDefinitionId: body.roleDefinitionId, directoryScopeId: body.directoryScopeId,
          memberType: 'Direct', status: 'Provisioned', scheduleInfo: body.scheduleInfo,
        });
        return { ok: true, status: 201, body: { ...body, id: `fixture-request-${next}`, status: 'Provisioned', targetScheduleId: scheduleId } };
      }
      const pimRule = /^\/policies\/roleManagementPolicies\/([^/]+)\/rules\/([^/]+)$/.exec(path);
      if (pimRule && method === 'PATCH') {
        const policyPath = `/policies/roleManagementPolicies/${decodeURIComponent(pimRule[1])}`;
        const policy = objects.get(policyPath);
        const ruleId = decodeURIComponent(pimRule[2]);
        if (!policy?.rules?.some((rule) => rule.id === ruleId)) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
        const { '@odata.type': _type, ...fields } = body;
        objects.set(policyPath, { ...policy, rules: policy.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...fields } : rule)) });
        return { ok: true, status: 204, body: null };
      }
      if (method === 'PUT' && objects.has(path)) {
        objects.set(path, { ...body });
        return { ok: true, status: 204, body: null };
      }
      if (method === 'POST') {
        next += 1;
        const id = `fixture-${next}`;
        // Entra assigns an application's appId, and computes a custom
        // strength's policyType and requirementsSatisfied; the fake does the same.
        const created = path === '/applications' ? { ...body, id, appId: `fixture-appid-${next}` }
          : path === '/policies/authenticationStrengthPolicies' ? { ...body, id, policyType: 'custom', requirementsSatisfied: 'mfa' }
            // A created role is custom; Entra keeps a templateId it is given.
            : path === '/roleManagement/directory/roleDefinitions' ? { ...body, id, isBuiltIn: false, templateId: body.templateId ?? id }
              : { ...body, id };
        objects.set(`${path}/${id}`, created);
        return { ok: true, status: 201, body: created };
      }
      if (!objects.has(path)) return { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
      if (method === 'PATCH') {
        objects.set(path, { ...objects.get(path), ...body });
        return { ok: true, status: 204, body: null };
      }
      if (method === 'DELETE') {
        objects.delete(path);
        return { ok: true, status: 204, body: null };
      }
      return { ok: false, status: 405, body: null };
    },
    async read(version, requested) {
      // A $select narrows nothing here: the fake returns the whole object.
      const path = requested.split('?')[0];
      // Issue #155: an Intune policy that exists and was never assigned lists no assignments.
      const assignments = /^(\/device(?:Management|AppManagement)\/[^/]+\/[^/]+)\/assignments$/.exec(path);
      if (assignments && !objects.has(path) && objects.has(assignments[1])) return { ok: true, status: 200, body: { value: [] } };
      // Roadmap task-151: the eligibility collection answers a filter of
      // `field eq 'value'` terms joined by `and`.
      if (path === '/roleManagement/directory/roleEligibilitySchedules') {
        const filter = /\$filter=([^&]*)/.exec(requested)?.[1] ?? '';
        const terms = [...decodeURIComponent(filter).matchAll(/(\w+) eq '((?:[^']|'')*)'/g)].map(([, field, value]) => [field, value.replace(/''/g, "'")]);
        const value = [...objects.entries()]
          .filter(([key, object]) => key.startsWith(`${path}/`) && terms.every(([field, want]) => String(object[field]).toLowerCase() === want.toLowerCase()))
          .map(([, object]) => object);
        return { ok: true, status: 200, body: { value } };
      }
      return objects.has(path) ? { ok: true, status: 200, body: objects.get(path) } : { ok: false, status: 404, body: null };
    },
  };
}

const governor = { async acquire() {}, observeRetryAfter() {} };

function fixtureFor(resourceType, operation, graph) {
  const collection = graphPathFor(resourceType);
  const payload = FIXTURE_PAYLOADS[resourceType];
  const blastRadius = CATALOG.find((entry) => entry.type === resourceType)?.blastRadius ?? null;
  const base = { naturalKey: `${resourceType}:fixture`, resourceType, references: [], blastRadius };
  const existingId = 'fixture-existing';
  if (TENANT_POLICY_TYPES.has(resourceType)) {
    if (operation === 'create') return { ...base, verb: 'create', payload };
    if (operation !== 'update') return null;
    const live = { ...payload, ...FIXTURE_DRIFT[resourceType](payload) };
    const targetId = payload.id ?? existingId;
    const resource = { ...base, verb: 'update', payload, targetId, live: { state: 'present', targetId, payload: live } };
    graph.objects.set(tenantPolicyFixturePath(resource), live);
    return resource;
  }
  if (operation === 'create') return { ...base, verb: 'create', payload };
  if (operation === 'update') {
    // Drift a field the type actually has; a role assignment has no mutable name.
    const drifted = FIXTURE_DRIFT[resourceType]?.(payload) ?? ('displayName' in payload ? { displayName: 'Drifted' } : {});
    const live = { ...payload, id: existingId, ...drifted };
    graph.objects.set(`${collection}/${existingId}`, live);
    return { ...base, verb: 'update', payload, targetId: existingId, live: { state: 'present', targetId: existingId, payload: live } };
  }
  if (operation === 'delete') {
    graph.objects.set(`${collection}/${existingId}`, { ...payload, id: existingId });
    return { ...base, verb: 'delete', payload: null, targetId: existingId, live: { targetId: existingId, payload: { ...payload, id: existingId } } };
  }
  if (operation === 'restore-soft-deleted') {
    // Roadmap task-152: a deleted Conditional Access policy comes back in the
    // state it was deleted in; the fixture deletes an enabled one, so the run
    // must put it back to report-only.
    const deletedState = resourceType === 'conditionalAccessPolicy' ? { state: 'enabled' } : {};
    graph.deleted.set(existingId, { path: `${collection}/${existingId}`, body: { ...payload, ...deletedState, id: existingId } });
    return { ...base, verb: 'restore-soft-deleted', payload, targetId: existingId, deletedItemId: existingId };
  }
  return null;
}

/**
 * Runs every registered object operation through applyWave against fakeGraph.
 * Returns one result per (resourceType, operation). It never touches the
 * registry: the claims read before and after a run are identical.
 */
export async function runFixtureHarness({ types = Object.keys(FIXTURE_PAYLOADS) } = {}) {
  const results = [];
  for (const resourceType of types) {
    for (const operation of OPERATIONS) {
      if (!isSupportedClaim(capabilityFor(resourceType, operation).claim)) continue;
      const graph = fakeGraph();
      const resource = fixtureFor(resourceType, operation, graph);
      try {
        const outcome = await applyWave(graph, governor, [resource], {
          targetTenant: FIXTURE_TENANT, mode: 'enforce', simulationPassed: true, lockoutGate: FIXTURE_LOCKOUT_GATE,
          existingTargetIds: new Map(FIXTURE_TARGET_IDS[resourceType] ?? []),
          observedCoverage: FIXTURE_COVERAGE,
          // The deletion guard verifies a policy against the CURRENT target state;
          // the fixture's live object is that state (it excludes no break-glass id).
          deletionGuardOptions: {
            breakGlassUserIds: ['fixture-break-glass'], breakGlassGroupIds: [], keelAppIds: [],
            caPolicies: resource.live ? [{ naturalKey: resource.naturalKey, payload: resource.live.payload }] : [],
          },
        });
        const passed = outcome.applied.length === 1 && outcome.failed.length === 0 && outcome.skipped.length === 0;
        results.push({
          resourceType, operation, result: passed ? 'passed' : 'failed', synthetic: true,
          writes: graph.writes.map((write) => `${write.method} ${write.path}`),
          applied: outcome.applied,
          detail: passed ? null : JSON.stringify({ failed: outcome.failed, skipped: outcome.skipped }),
        });
      } catch (error) {
        results.push({ resourceType, operation, result: 'failed', synthetic: true, detail: error.message });
      }
    }
  }
  return results;
}

const MECHANISM_FOR_OPERATION = Object.freeze({
  create: 'recreate', update: 'update-existing', 'restore-soft-deleted': 'soft-delete-restore', delete: 'delete',
});

/**
 * Roadmap task-107: runs one expansion batch. Every registered operation of a
 * qualified-subset type in the batch goes through the production applyWave()
 * path against fakeGraph; the report adds what still has to be done by hand
 * after each operation (completion.mjs's items, so a recreated application
 * always lists its secrets and certificates) and every remaining type in the
 * batch with its API and permission reason. The report is synthetic evidence:
 * it never registers, promotes or qualifies anything.
 */
export async function runExpansionBatch(batchId, { now = () => new Date() } = {}) {
  const inventory = buildExpansionInventory();
  const batch = inventory.batches.find((candidate) => candidate.id === batchId);
  if (!batch) throw new Error(`unknown expansion batch: ${batchId} (known: ${EXPANSION_BATCHES.map((entry) => entry.id).join(', ')})`);
  const qualified = batch.types.filter((entry) => entry.status === 'qualified-subset');
  const harnessable = qualified.map((entry) => entry.resourceType).filter((type) => FIXTURE_PAYLOADS[type]);
  const before = qualified.map((entry) => entry.supportedOperations.map((operation) => capabilityFor(entry.resourceType, operation).claim).join());
  const harness = await runFixtureHarness({ types: harnessable });
  const after = qualified.map((entry) => entry.supportedOperations.map((operation) => capabilityFor(entry.resourceType, operation).claim).join());
  if (before.join('|') !== after.join('|')) throw new Error('a fixture run changed a capability claim');

  const operations = qualified.flatMap((entry) => entry.supportedOperations.map((operation) => {
    const capability = capabilityFor(entry.resourceType, operation);
    const run = harness.find((result) => result.resourceType === entry.resourceType && result.operation === operation) ?? null;
    return {
      resourceType: entry.resourceType,
      operation,
      claim: capability.claim,
      credentialMode: capability.credentialMode,
      idOutcome: capability.idOutcome,
      proofRef: capability.proofRef,
      subtype: capability.subtype,
      result: run ? run.result : 'not-run',
      synthetic: true,
      writes: run?.writes ?? [],
      completionSteps: completionItemsFor({ resourceType: entry.resourceType, mechanism: MECHANISM_FOR_OPERATION[operation] })
        .map((step) => ({ kind: step.kind, requirement: step.requirement, description: step.description })),
      detail: run?.detail ?? null,
    };
  }));

  return {
    contractVersion: inventory.contractVersion,
    batch: { id: batch.id, label: batch.label, task: batch.task },
    generatedAt: now().toISOString(),
    synthetic: true,
    claimsChanged: false,
    operations,
    refused: qualified.flatMap((entry) => entry.unsupportedOperations.map((operation) => ({ resourceType: entry.resourceType, operation, claim: capabilityFor(entry.resourceType, operation).claim }))),
    remaining: batch.types.filter((entry) => entry.status !== 'qualified-subset').map((entry) => ({
      resourceType: entry.resourceType, status: entry.status, restoreScope: entry.restoreScope,
      api: entry.api, permission: entry.permission, reason: entry.reason,
    })),
    // Roadmap task-108: the policy batch also carries its family ledger
    // (subtype-bound records, whether each proof is current, refused subtypes).
    ...(batch.id === 'policy' ? { policyLedger: buildPolicyFamilyLedger() } : {}),
    // Roadmap task-109: the administrative batch carries its family ledger,
    // including what configuration and relationships cannot be recovered.
    ...(batch.id === 'administrative-configuration' ? { administrativeLedger: buildAdministrativeFamilyLedger() } : {}),
  };
}

function batchTable(report) {
  const lines = [`batch ${report.batch.id} (${report.batch.label}) — synthetic fixture evidence, never a live claim`];
  for (const op of report.operations) {
    lines.push(`  ${op.resourceType} ${op.operation}: ${op.result} · claim ${op.claim} · id ${op.idOutcome}${op.subtype ? ` · subtype ${op.subtype} only` : ''}`);
    for (const step of op.completionSteps) lines.push(`      then by hand: ${step.kind} (${step.requirement}) — ${step.description}`);
  }
  for (const family of report.policyLedger?.families ?? []) {
    for (const op of family.operations) {
      lines.push(`  ${family.resourceType} ${op.operation} proof: ${op.proofCurrent ? 'current' : 'INVALIDATED'} · writes ${op.writableFields.join(', ')}`);
    }
    for (const subtype of family.refusedSubtypes) lines.push(`  ${family.resourceType} ${subtype}: refused (immutable)`);
  }
  for (const family of report.administrativeLedger?.families ?? []) {
    for (const op of family.operations) lines.push(`  ${family.resourceType} ${op.operation} checks: ${op.checks.join('; ')}`);
    for (const reason of family.refusals) lines.push(`  ${family.resourceType}: refused — ${reason}`);
    for (const item of family.unrecoverable) lines.push(`  ${family.resourceType} cannot recover ${item.kind} ${item.name}: ${item.reason}`);
  }
  for (const refusal of report.refused) lines.push(`  ${refusal.resourceType} ${refusal.operation}: refused (${refusal.claim})`);
  for (const entry of report.remaining) lines.push(`  ${entry.resourceType}: ${entry.status} — ${entry.reason} [${entry.api ?? 'no write route'}; ${entry.permission}]`);
  return lines.join('\n');
}

function table(ledger) {
  const lines = ['type                                   decision   operations'];
  for (const row of ledger.types) {
    const ops = row.operations.map((op) => `${op.operation}=${op.decision}`).join(' ');
    lines.push(`${row.resourceType.padEnd(38)} ${row.decision.padEnd(10)} ${ops}`);
  }
  for (const edge of ledger.edges) lines.push(`${edge.resourceType.padEnd(38)} ${'automated'.padEnd(10)} ${edge.operation}=${edge.decision}`);
  return lines.join('\n');
}

export async function main({ argv = process.argv.slice(2), out = console, env = process.env } = {}) {
  // Issue #148: --live-evidence DIR applies the committed Entra live records
  // (signed, test tenant only) through qualifyLiveEvidence before the ledger is
  // built. Without KEEL_QUALIFICATION_HMAC_KEY nothing verifies, so nothing flips.
  const liveIndex = argv.indexOf('--live-evidence');
  if (liveIndex !== -1) {
    const { applyCommittedEvidence } = await import('./entraLive.mjs');
    const results = applyCommittedEvidence({ dir: argv[liveIndex + 1], hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY || null });
    for (const result of results) {
      if (result.promoted) out.error(`live evidence ${result.file}: ${result.before} -> ${result.after}`);
      else out.error(`live evidence ${result.file}: not applied (${result.failures.join('; ')})`);
    }
  }
  let ledger;
  try {
    ledger = buildOperationLedger();
  } catch (error) {
    out.error(error.message);
    return 1;
  }
  const batchIndex = argv.indexOf('--batch');
  if (batchIndex !== -1) {
    let report;
    try {
      report = await runExpansionBatch(argv[batchIndex + 1]);
    } catch (error) {
      out.error(error.message);
      return 1;
    }
    out.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : batchTable(report));
    return report.operations.some((op) => op.result !== 'passed') ? 1 : 0;
  }
  if (argv.includes('--check')) {
    try {
      buildExpansionInventory();
    } catch (error) {
      out.error(error.message);
      return 1;
    }
    out.log(`${ledger.types.length} catalogue types, each with an explicit decision and an expansion batch`);
    return 0;
  }
  const harness = argv.includes('--harness') ? await runFixtureHarness() : null;
  if (argv.includes('--json')) {
    out.log(JSON.stringify({ ...ledger, ...(harness ? { fixtureHarness: harness } : {}) }, null, 2));
  } else {
    out.log(table(ledger));
    if (harness) {
      out.log('\nfixture harness (synthetic; never changes a claim):');
      for (const result of harness) out.log(`  ${result.resourceType} ${result.operation}: ${result.result}${result.detail ? ` — ${result.detail}` : ''}`);
    }
  }
  return harness?.some((result) => result.result !== 'passed') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
