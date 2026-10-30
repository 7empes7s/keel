/**
 * Builds ScubaGear's input document from Keel's backups: one adapter per input key,
 * never one per rule.
 *
 * ScubaGear's PowerShell "providers" read the tenant and write one JSON document per
 * product; its Rego rules read that document. Each adapter here builds one key of the
 * same document from the objects Keel already backed up, the way the provider builds
 * it (engine/benchmarks/scubagear/v2.0.0 is the pinned Rego; the provider code is
 * ScubaGear's PowerShell/ScubaGear/Modules/Providers at the same tag):
 *  - Graph objects are turned into the provider's shape by upper-casing the first
 *    letter of every key, exactly as its ConvertFrom-GraphHashtable does;
 *  - Exchange objects are already in cmdlet shape (Keel stores the cmdlet's fields);
 *  - the few keys the provider assembles from several reads (privileged users and
 *    roles, authentication methods, licences) are assembled from the same objects.
 *
 * An adapter declares:
 *  - `reads`: the backups it needs ({ resourceType, parts? }); a rule's control requires
 *    every read of every key it uses, so a missing or stale backup makes it "could not
 *    check" before anything runs;
 *  - `fields`: for a read limited to declared fields (Exchange), the fields Keel keeps;
 *    for a full Graph object, 'all';
 *  - `lacks`: fields the rules may read that Keel's read does not return (Graph v1.0
 *    leaves out beta-only fields). A rule whose code names one is "could not check".
 *  - `build(facts)`: the value, or a thrown CouldNotBuild when the backup cannot answer
 *    what the rule asks (for example a role held through a group whose members Keel
 *    does not read). Then the rule reads "could not check", never a guess.
 *
 * Read-only: nothing here calls a tenant.
 */
import { FAMILIES } from '../../collect/workloads/mailFlow.mjs';
import { ORGANIZATION_FIELDS } from '../../collect/workloads/exchange.mjs';
import { SENSITIVE_MASK } from '../registry.mjs';

export class CouldNotBuild extends Error {
  constructor(key, why) {
    super(`${key}: ${why}`);
    this.key = key;
    this.why = why;
  }
}

// Backups older than these are too old to judge a tenant by (the same limits Keel's own
// controls use: directory reads several times a day, service reads once a day).
export const GRAPH_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const WORKLOAD_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const MAIL_FLOW = 'exchange-mail-flow';

// ScubaGear's ScubaConfigDefaults.json `privilegedRoles` at the pinned tag.
export const PRIVILEGED_ROLES = Object.freeze([
  'Global Administrator', 'Privileged Role Administrator', 'User Administrator', 'SharePoint Administrator',
  'Exchange Administrator', 'Hybrid Identity Administrator', 'Application Administrator', 'Cloud Application Administrator',
]);
const PREMIUM_P2 = 'AAD_PREMIUM_P2';

/** ConvertFrom-GraphHashtable: the first letter of every key upper-cased, all the way down. */
export function pascal(value) {
  if (Array.isArray(value)) return value.map(pascal);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.charAt(0).toUpperCase() + key.slice(1), pascal(item)]));
  }
  return value;
}

// Types Keel backs up in its daily tier (tier2 in the collection catalogue), not the
// every-few-hours one: a fresher limit would leave their rules could not check most of the day.
const DAILY_TYPES = new Set(['user', 'groupSetting', 'appManagementPolicy', 'tenantAppManagementPolicy']);
const graph = (resourceType) => Object.freeze({ resourceType, maxAgeMs: DAILY_TYPES.has(resourceType) ? WORKLOAD_MAX_AGE_MS : GRAPH_MAX_AGE_MS });
const mailFlow = (...parts) => Object.freeze({ resourceType: MAIL_FLOW, parts: Object.freeze(parts), maxAgeMs: WORKLOAD_MAX_AGE_MS });
const list = (facts, type) => facts[type] ?? [];
const single = (facts, type) => list(facts, type).slice(0, 1);

// Keel's own bookkeeping on a stored service-read object, which the cmdlet never returns.
function cmdletObject(fact) {
  const { kind, identity, id, ...fields } = fact;
  return fields;
}
const ofKind = (facts, kind) => list(facts, MAIL_FLOW).filter((fact) => fact.kind === kind).map(cmdletObject);

function premium(facts) {
  return list(facts, 'subscribedSku').some((sku) => (sku.servicePlans ?? [])
    .some((plan) => plan.servicePlanName === PREMIUM_P2 && plan.provisioningStatus === 'Success'));
}

// The built-in roles ScubaGear treats as highly privileged, as { templateId, displayName }.
// ScubaGear takes them from Microsoft's fixed role catalogue, so all of them are always
// there; a backup that lacks one cannot stand in for it.
function privilegedRoleTemplates(facts, key) {
  const byName = new Map();
  for (const role of list(facts, 'roleDefinition')) {
    if (role.isBuiltIn !== true || !PRIVILEGED_ROLES.includes(role.displayName)) continue;
    byName.set(role.displayName, { templateId: role.templateId ?? role.id, displayName: role.displayName });
  }
  const missing = PRIVILEGED_ROLES.filter((name) => !byName.has(name));
  if (missing.length) throw new CouldNotBuild(key, `the role backup lacks ${missing.join(', ')}`);
  return PRIVILEGED_ROLES.map((name) => byName.get(name));
}

/**
 * Get-PrivilegedUser: every user holding a privileged role, actively (a directory role
 * member, which is a tenant-wide role assignment) or, with Entra ID P2, eligibly.
 * A role held through a group needs the group's members, which Keel does not back up,
 * so then the list cannot be built. A principal found in no backup cannot be typed.
 */
function privilegedUsers(facts) {
  const users = new Map(list(facts, 'user').map((user) => [user.id, user]));
  const groups = new Set(list(facts, 'group').map((group) => group.id));
  const servicePrincipals = new Set(list(facts, 'servicePrincipal').map((sp) => sp.id));
  const roles = privilegedRoleTemplates(facts, 'privileged_users');
  const roleName = new Map(roles.map((role) => [role.templateId, role.displayName]));
  const holders = [
    ...list(facts, 'roleAssignment').filter((assignment) => (assignment.directoryScopeId ?? '/') === '/'),
    ...(premium(facts) ? list(facts, 'roleEligibilitySchedule') : []),
  ].filter((assignment) => roleName.has(assignment.roleDefinitionId));
  const out = {};
  for (const holder of holders) {
    const principal = holder.principalId;
    if (groups.has(principal)) throw new CouldNotBuild('privileged_users', 'a privileged role is held through a group, and Keel does not back up group members');
    if (servicePrincipals.has(principal)) continue; // ScubaGear lists these apart (privileged_service_principals).
    const user = users.get(principal);
    if (!user) throw new CouldNotBuild('privileged_users', 'a privileged role holder is in no backup of users, groups or apps');
    if (user.onPremisesImmutableId === undefined) throw new CouldNotBuild('privileged_users', 'the user backup does not say whether an admin is synced from on-premises');
    out[principal] ??= {
      id: principal,
      DisplayName: user.displayName ?? null,
      // Only whether it is set reaches here (registry.mjs maskedFacts).
      OnPremisesImmutableId: user.onPremisesImmutableId === SENSITIVE_MASK ? SENSITIVE_MASK : user.onPremisesImmutableId ?? null,
      roles: [],
    };
    const name = roleName.get(holder.roleDefinitionId);
    if (!out[principal].roles.includes(name)) out[principal].roles.push(name);
  }
  return out;
}

/**
 * Get-PrivilegedRole: each privileged role with, when the tenant has Entra ID P2, its
 * active assignments and its PIM rules. The provider reads assignment schedule
 * instances; Keel backs up the schedules plus every active assignment. An active
 * assignment with no schedule was made outside PIM and never ends. Rules of PIM for
 * Groups (a group holding the role) are not backed up, so a role held through a group
 * cannot be built.
 */
function privilegedRoles(facts) {
  const roles = privilegedRoleTemplates(facts, 'privileged_roles');
  if (!premium(facts)) return roles.map((role) => ({ DisplayName: role.displayName, RoleTemplateId: role.templateId }));
  const groups = new Set(list(facts, 'group').map((group) => group.id));
  const schedules = list(facts, 'roleAssignmentSchedule');
  const policyFor = new Map(list(facts, 'unifiedRoleManagementPolicyAssignment')
    .map((assignment) => [assignment.roleDefinitionId, assignment.policyId]));
  const policies = new Map(list(facts, 'unifiedRoleManagementPolicy').map((policy) => [policy.id, policy]));
  const known = new Set([...list(facts, 'user'), ...list(facts, 'servicePrincipal')].map((principal) => principal.id));
  const holders = [...list(facts, 'roleAssignment'), ...schedules, ...list(facts, 'roleEligibilitySchedule')]
    .filter((assignment) => roles.some((role) => role.templateId === assignment.roleDefinitionId));
  // Each type comes from its own newest backup, so a holder in none of them may be a newer group.
  if (holders.some((assignment) => !groups.has(assignment.principalId) && !known.has(assignment.principalId))) {
    throw new CouldNotBuild('privileged_roles', 'a privileged role holder is in no backup of users, groups or apps');
  }
  const heldByGroup = holders.some((assignment) => groups.has(assignment.principalId));
  if (heldByGroup) throw new CouldNotBuild('privileged_roles', 'a privileged role is held through a group, and Keel does not back up PIM for Groups rules');
  return roles.map((role) => {
    const own = schedules.filter((schedule) => schedule.roleDefinitionId === role.templateId);
    const expiration = (schedule) => schedule.scheduleInfo?.expiration ?? {};
    const assignments = own.map((schedule) => ({
      Id: schedule.id,
      PrincipalId: schedule.principalId,
      RoleDefinitionId: schedule.roleDefinitionId,
      DirectoryScopeId: schedule.directoryScopeId ?? '/',
      AssignmentType: schedule.assignmentType ?? null,
      MemberType: schedule.memberType ?? null,
      StartDateTime: schedule.scheduleInfo?.startDateTime ?? null,
      EndDateTime: expiration(schedule).type === 'noExpiration' ? null
        : expiration(schedule).endDateTime ?? (expiration(schedule).duration ? `after ${expiration(schedule).duration}` : null),
    }));
    for (const active of list(facts, 'roleAssignment')) {
      if (active.roleDefinitionId !== role.templateId) continue;
      const scheduled = own.some((schedule) => schedule.principalId === active.principalId
        && (schedule.directoryScopeId ?? '/') === (active.directoryScopeId ?? '/'));
      if (!scheduled) {
        assignments.push({
          Id: active.id, PrincipalId: active.principalId, RoleDefinitionId: active.roleDefinitionId,
          DirectoryScopeId: active.directoryScopeId ?? '/', AssignmentType: 'Assigned', MemberType: 'Direct', StartDateTime: null, EndDateTime: null,
        });
      }
    }
    const policy = policies.get(policyFor.get(role.templateId));
    if (!policy) throw new CouldNotBuild('privileged_roles', `no PIM policy backed up for ${role.displayName}`);
    // Entra always ships a role's PIM rules; a policy backed up without them cannot answer.
    if (!Array.isArray(policy.rules) || policy.rules.length === 0) throw new CouldNotBuild('privileged_roles', `the PIM policy for ${role.displayName} was backed up without its rules`);
    const rules = policy.rules.map((rule) => ({ ...pascal(rule), RuleSource: role.displayName, RuleSourceType: 'Directory Role' }));
    return { DisplayName: role.displayName, RoleTemplateId: role.templateId, Assignments: assignments, Rules: rules };
  });
}

/** Get-AppManagementPoliciesApplyTo: custom policies, each restriction with the apps it applies to. */
function appManagementPolicies(facts) {
  return list(facts, 'appManagementPolicy').map((policy) => {
    const restrictions = policy.restrictions ?? {};
    // The rules read AppliesTo only for a restriction a policy turns off for some apps.
    // Keel does not back up which apps a policy applies to, so such a policy cannot be built.
    const shaped = (entries) => (entries ?? []).filter(Boolean).map((entry) => {
      if (policy.isEnabled === true && entry.state !== 'enabled') {
        throw new CouldNotBuild('app_management_policies', 'a policy turns a restriction off for some apps, and Keel does not back up which apps');
      }
      return { ...pascal(entry), AppliesTo: [] };
    });
    return {
      Id: policy.id,
      DisplayName: policy.displayName ?? null,
      IsEnabled: policy.isEnabled ?? null,
      Restrictions: { PasswordCredentials: shaped(restrictions.passwordCredentials), KeyCredentials: shaped(restrictions.keyCredentials) },
    };
  });
}

function authenticationMethod(facts) {
  return single(facts, 'authenticationMethodsPolicy').map((policy) => {
    const { authenticationMethodConfigurations: configurations, ...rest } = policy;
    if (!Array.isArray(configurations)) throw new CouldNotBuild('authentication_method', 'the backup holds no sign-in method settings');
    return {
      authentication_method_policy: pascal(rest),
      authentication_method_feature_settings: configurations.filter((configuration) => configuration?.id).map(pascal),
    };
  });
}

const SCUBA_CONFIG_FIELDS = Object.freeze([
  'M365Environment', 'Aad', 'Exo', 'CapExclusions', 'RoleExclusions', 'AgentExclusions', 'Agents', 'Users', 'Groups',
  'Applications', 'GuestUserTypes', 'AllowedForwardingDomains',
]);

export const ADAPTERS = Object.freeze({
  // Run settings. Keel passes no exclusions (ScubaGear's own default) and a commercial cloud.
  scuba_config: Object.freeze({ setting: true, fields: SCUBA_CONFIG_FIELDS, build: () => ({ M365Environment: 'commercial', Aad: {}, Exo: {} }) }),
  module_version: Object.freeze({ setting: true, fields: [], build: (facts, run) => run.version }),

  // Entra ID
  conditional_access_policies: Object.freeze({
    reads: [graph('conditionalAccessPolicy')], fields: 'all',
    // Agent conditions exist only in Graph beta; Keel reads sign-in rules through v1.0.
    lacks: ['AgentIdRiskLevels', 'IncludeAgentIdServicePrincipals', 'ExcludeAgentIdServicePrincipals'],
    build: (facts) => list(facts, 'conditionalAccessPolicy').map(pascal),
  }),
  authorization_policies: Object.freeze({ reads: [graph('authorizationPolicy')], fields: 'all', build: (facts) => single(facts, 'authorizationPolicy').map(pascal) }),
  authentication_method: Object.freeze({ reads: [graph('authenticationMethodsPolicy')], fields: 'all', build: authenticationMethod }),
  directory_settings: Object.freeze({ reads: [graph('groupSetting')], fields: 'all', build: (facts) => list(facts, 'groupSetting').map(pascal) }),
  domain_settings: Object.freeze({ reads: [graph('domain')], fields: 'all', build: (facts) => list(facts, 'domain').map(pascal) }),
  service_plans: Object.freeze({
    reads: [graph('subscribedSku')], fields: 'all',
    build: (facts) => list(facts, 'subscribedSku').flatMap((sku) => (sku.servicePlans ?? [])
      .filter((plan) => plan.provisioningStatus === 'Success')).map(pascal),
  }),
  license_information: Object.freeze({
    reads: [graph('subscribedSku')], fields: 'all',
    build: (facts) => list(facts, 'subscribedSku').map((sku) => pascal({
      skuId: sku.skuId ?? null, skuPartNumber: sku.skuPartNumber ?? null, consumedUnits: sku.consumedUnits ?? null, prepaidUnits: sku.prepaidUnits ?? null,
    })),
  }),
  default_app_management_policy: Object.freeze({
    reads: [graph('tenantAppManagementPolicy')], fields: 'all', build: (facts) => single(facts, 'tenantAppManagementPolicy').map(pascal),
  }),
  app_management_policies: Object.freeze({ reads: [graph('appManagementPolicy')], fields: 'all', build: appManagementPolicies }),
  privileged_users: Object.freeze({
    reads: ['roleAssignment', 'roleEligibilitySchedule', 'roleDefinition', 'subscribedSku', 'user', 'group', 'servicePrincipal'].map(graph),
    fields: 'all', masked: true, build: privilegedUsers,
  }),
  privileged_roles: Object.freeze({
    reads: ['roleDefinition', 'roleAssignment', 'roleAssignmentSchedule', 'roleEligibilitySchedule', 'unifiedRoleManagementPolicy',
      'unifiedRoleManagementPolicyAssignment', 'subscribedSku', 'group', 'user', 'servicePrincipal'].map(graph),
    fields: 'all',
    // The provider reads schedule instances, where an assignment made outside PIM has no
    // start date. Keel backs up schedules, whose start date for such an assignment is
    // not confirmed against a live tenant yet, so the rule that asks it is not run.
    lacks: ['StartDateTime'],
    build: privilegedRoles,
  }),

  // Exchange Online
  remote_domains: Object.freeze({ reads: [mailFlow('remoteDomain')], fields: FAMILIES.remoteDomain.fields, build: (facts) => ofKind(facts, 'remoteDomain') }),
  accepted_domains: Object.freeze({ reads: [mailFlow('acceptedDomain')], fields: FAMILIES.acceptedDomain.fields, build: (facts) => ofKind(facts, 'acceptedDomain') }),
  dkim_config: Object.freeze({ reads: [mailFlow('dkimSigning')], fields: FAMILIES.dkimSigning.fields, build: (facts) => ofKind(facts, 'dkimSigning') }),
  transport_rule: Object.freeze({ reads: [mailFlow('transportRule')], fields: FAMILIES.transportRule.fields, build: (facts) => ofKind(facts, 'transportRule') }),
  // Keel's organization read keeps a few settings only, and is not wired here yet: a
  // rule that needs only these fields fails registration until it is.
  org_config: Object.freeze({ reads: null, fields: ORGANIZATION_FIELDS, build: null }),
});

/** The input document for `keys`, or { couldNotBuild } naming the first key it could not build. */
export function buildInput(keys, facts, run) {
  const document = {};
  for (const key of keys) {
    const adapter = ADAPTERS[key];
    if (!adapter?.build) throw new Error(`no adapter builds ${key}`);
    try {
      document[key] = adapter.build(facts, run);
    } catch (error) {
      if (error instanceof CouldNotBuild) return { couldNotBuild: error };
      throw error;
    }
  }
  return { document };
}
