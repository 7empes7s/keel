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
import { FAMILIES as EXTENDED } from '../../collect/workloads/exchangeExtended.mjs';
import {
  ACCESS_FAMILIES, DEFAULTS_FAMILIES, EXCHANGE_ORG_ACCESS_WORKLOAD, EXCHANGE_ORG_DEFAULTS_WORKLOAD,
} from '../../collect/workloads/exchangeOrgPolicies.mjs';
import { FAMILIES as PURVIEW } from '../../collect/workloads/purviewRetentionDlp.mjs';
import { FAMILIES as POWER_PLATFORM } from '../../collect/workloads/powerPlatform.mjs';
import { FAMILIES as TEAMS } from '../../collect/workloads/teamsPolicies.mjs';
import { FAMILIES as TEAMS_EXTENDED } from '../../collect/workloads/teamsExtended.mjs';
import { SENSITIVE_MASK } from '../registry.mjs';
import { DEFAULT_SCUBA_CONFIG } from './config.mjs';

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
export const EXCHANGE_EXTENDED = 'exchange-extended';
export const PURVIEW_DLP = 'purview-retention-dlp';
export const TEAMS_POLICIES = 'teams-org-policies';
export const TEAMS_VOICE = 'teams-voice-policies';
export const POWER_PLATFORM_SETTINGS = 'power-platform-settings';
export const SHAREPOINT_SETTINGS = 'sharepoint-site-settings';

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
const service = (resourceType, ...parts) => Object.freeze({ resourceType, parts: Object.freeze(parts), maxAgeMs: WORKLOAD_MAX_AGE_MS });
const mailFlow = (...parts) => service(MAIL_FLOW, ...parts);
const list = (facts, type) => facts[type] ?? [];
// A tenant-wide setting every tenant has exactly one of. An empty backup of it is not a
// tenant with nothing set, and the rules would pass on it, so it cannot be checked.
const single = (facts, type, key) => {
  const found = list(facts, type);
  if (found.length !== 1) throw new CouldNotBuild(key, `the backup holds ${found.length} ${type} objects, and every tenant has exactly one`);
  return found;
};

// Keel's own bookkeeping on a stored service-read object, which the cmdlet never returns.
function cmdletObject(fact) {
  const { kind, identity, id, lock, parent, parentStatus, case: _case, environment, ...fields } = fact;
  return fields;
}
const ofKind = (facts, kind, type = MAIL_FLOW) => list(facts, type).filter((fact) => fact.kind === kind).map(cmdletObject);

/**
 * An Exchange protection policy or rule as its Get cmdlet returns it. Keel keys these
 * objects by Guid and keeps the Name; for them the cmdlet's Identity is the Name (the
 * provider's comments say so: "Identity = Name of the policy").
 */
const named = (facts, kind, type) => ofKind(facts, kind, type).map((fields) => ({ ...fields, Identity: fields.Name ?? null }));
const namedFields = (family) => Object.freeze([...family.fields, 'Identity']);

/**
 * Get-SharingPolicy as the provider passes it: each Domains entry is text such as
 * "*:CalendarSharingFreeBusySimple", which the rules search for "*" and the folder.
 * An entry stored as anything else would never match and read as a pass, so then the
 * input cannot be built.
 */
function sharingPolicies(facts) {
  const policies = ofKind(facts, 'sharingPolicy', EXCHANGE_ORG_ACCESS_WORKLOAD);
  // Every tenant has its default sharing policy; none in the backup is not "nothing shared".
  if (policies.length === 0) throw new CouldNotBuild('sharing_policy', 'the backup holds no sharing policy, and every tenant has a default one');
  for (const policy of policies) {
    if (policy.Domains != null && (!Array.isArray(policy.Domains) || policy.Domains.some((domain) => typeof domain !== 'string'))) {
      throw new CouldNotBuild('sharing_policy', 'a sharing policy lists its domains in a form the rules cannot read');
    }
  }
  return policies;
}

/**
 * An organization-wide Exchange answer (Get-TransportConfig, Get-OrganizationConfig):
 * exactly one object, with each setting the rule compares stored as true or false. The
 * rules compare with == false / == true, so a missing object, or a setting stored as
 * text or null, would read as a pass; then the input cannot be built.
 */
function organizationWide(key, kind, booleans) {
  return (facts) => {
    const found = ofKind(facts, kind, EXCHANGE_ORG_DEFAULTS_WORKLOAD);
    if (found.length !== 1) throw new CouldNotBuild(key, `the backup holds ${found.length} ${kind} objects, and every tenant has exactly one`);
    for (const field of booleans) {
      if (typeof found[0][field] !== 'boolean') throw new CouldNotBuild(key, `${field} is not stored as true or false`);
    }
    return found;
  };
}

function premium(facts) {
  return list(facts, 'subscribedSku').some((sku) => (sku.servicePlans ?? [])
    .some((plan) => plan.servicePlanName === PREMIUM_P2 && plan.provisioningStatus === 'Success'));
}

// The built-in roles ScubaGear treats as highly privileged, as { templateId, displayName }.
// ScubaGear takes them from Microsoft's fixed role catalogue, so all of them are always
// there; a backup that lacks one cannot stand in for it.
export function privilegedRoleTemplates(facts, key) {
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
 * The eligibilities in effect at `now`. ScubaGear reads schedule instances, which hold
 * only these; Keel backs up schedules, which also hold ones that start later or have
 * ended. One whose dates cannot be read is not guessed at.
 */
function eligibleNow(facts, key, now) {
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(at)) throw new CouldNotBuild(key, 'the check was run without a time to judge PIM eligibilities by');
  return list(facts, 'roleEligibilitySchedule').filter((schedule) => {
    const info = schedule.scheduleInfo ?? {};
    const start = Date.parse(info.startDateTime);
    const expiration = info.expiration ?? {};
    const end = expiration.type === 'noExpiration' ? Infinity
      : expiration.type === 'afterDateTime' ? Date.parse(expiration.endDateTime) : NaN;
    if (schedule.status !== 'Provisioned' || !Number.isFinite(start) || Number.isNaN(end)) {
      throw new CouldNotBuild(key, 'the backup does not say when a PIM eligibility is in effect');
    }
    return start <= at && at < end;
  });
}

/**
 * Get-PrivilegedUser: every user holding a privileged role, actively (a directory role
 * member, which is a tenant-wide role assignment) or, with Entra ID P2, eligibly.
 * A role held through a group needs the group's members, which Keel does not back up,
 * so then the list cannot be built. A principal found in no backup cannot be typed.
 */
function privilegedUsers(facts, run = {}) {
  const users = new Map(list(facts, 'user').map((user) => [user.id, user]));
  const groups = new Set(list(facts, 'group').map((group) => group.id));
  const servicePrincipals = new Set(list(facts, 'servicePrincipal').map((sp) => sp.id));
  const roles = privilegedRoleTemplates(facts, 'privileged_users');
  const roleName = new Map(roles.map((role) => [role.templateId, role.displayName]));
  const holders = [
    ...list(facts, 'roleAssignment').filter((assignment) => (assignment.directoryScopeId ?? '/') === '/'),
    ...(premium(facts) ? eligibleNow(facts, 'privileged_users', run.now) : []),
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
 * One role's active assignments, as Get-PrivilegedRole lists them, built from Keel's
 * backups: each assignment schedule, then each active assignment with no schedule
 * (made outside PIM, so it never ends and has no start date). Exported for
 * tools/scubagear-pim-check.mjs, which compares it with the schedule instances
 * ScubaGear's provider reads.
 */
export function roleAssignmentsOf(facts, templateId) {
  const own = list(facts, 'roleAssignmentSchedule').filter((schedule) => schedule.roleDefinitionId === templateId);
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
    if (active.roleDefinitionId !== templateId) continue;
    const scheduled = own.some((schedule) => schedule.principalId === active.principalId
      && (schedule.directoryScopeId ?? '/') === (active.directoryScopeId ?? '/'));
    if (!scheduled) {
      assignments.push({
        Id: active.id, PrincipalId: active.principalId, RoleDefinitionId: active.roleDefinitionId,
        DirectoryScopeId: active.directoryScopeId ?? '/', AssignmentType: 'Assigned', MemberType: 'Direct', StartDateTime: null, EndDateTime: null,
      });
    }
  }
  return assignments;
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
    const assignments = roleAssignmentsOf(facts, role.templateId);
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
  return single(facts, 'authenticationMethodsPolicy', 'authentication_method').map((policy) => {
    const { authenticationMethodConfigurations: configurations, ...rest } = policy;
    if (!Array.isArray(configurations)) throw new CouldNotBuild('authentication_method', 'the backup holds no sign-in method settings');
    return {
      authentication_method_policy: pascal(rest),
      authentication_method_feature_settings: configurations.filter((configuration) => configuration?.id).map(pascal),
    };
  });
}

/**
 * Input keys that are one family of a service read, as its cmdlet returns them. With
 * `identity` (the Exchange families), Identity is added from the Name.
 */
function cmdletKeys(resourceType, families, keys, { identity = true, lacks = {}, nested = {}, check = () => (value) => value } = {}) {
  return Object.fromEntries(Object.entries(keys).map(([key, kind]) => [key, Object.freeze({
    reads: [service(resourceType, kind)],
    fields: Object.freeze([...(identity ? namedFields(families[kind]) : families[kind].fields), ...(nested[key] ?? [])]),
    lacks: lacks[key] ?? [],
    build: (facts) => check(key)(identity ? named(facts, kind, resourceType) : ofKind(facts, kind, resourceType)),
  })]));
}

// The Teams settings the rules compare, with the type each must have. The Teams module
// can hand an enum over as a number, which the rules would read as "not Everyone" and
// pass, so a value of any other type is not guessed at.
export const TEAMS_SETTING_TYPES = Object.freeze({
  meeting_policies: Object.freeze({
    AllowAnonymousUsersToStartMeeting: 'boolean', AllowCloudRecording: 'boolean', AllowExternalParticipantGiveRequestControl: 'boolean',
    AllowPSTNUsersToBypassLobby: 'boolean', AutoAdmittedUsers: 'string',
  }),
  federation_configuration: Object.freeze({ AllowFederatedUsers: 'boolean', AllowTeamsConsumer: 'boolean', AllowTeamsConsumerInbound: 'boolean' }),
  client_configuration: Object.freeze({ AllowEmailIntoChannel: 'boolean' }),
  app_policies: Object.freeze({ DefaultCatalogAppsType: 'string', GlobalCatalogAppsType: 'string', PrivateCatalogAppsType: 'string' }),
  broadcast_policies: Object.freeze({ BroadcastRecordingMode: 'string' }),
});

/**
 * Teams policies as the rules read them. Every tenant has a Global policy of each kind,
 * and the rules judge the tenant by it, so a backup without one is not a tenant with
 * nothing set: it cannot be checked.
 */
export const teamsChecked = (key) => (policies) => {
  if (!policies.some((policy) => policy.Identity === 'Global')) {
    throw new CouldNotBuild(key, 'the backup holds no Global Teams policy, which every tenant has');
  }
  for (const policy of policies) {
    for (const [field, type] of Object.entries(TEAMS_SETTING_TYPES[key] ?? {})) {
      if (typeof policy[field] !== type) {
        throw new CouldNotBuild(key, `the backup does not hold ${field} as ${type === 'boolean' ? 'on or off' : 'a named choice'}`);
      }
    }
  }
  return policies;
};

/**
 * The domains Teams external access is limited to, as a list (ScubaGear's REST read
 * gives a list; an empty one means every domain is allowed). The Teams module Keel runs
 * gives { AllowedDomain: [{ Domain }] } for a list and an object with no list when every
 * domain is allowed. Any other shape is not guessed at.
 */
export function allowedDomains(value) {
  const domainOf = (entry) => (typeof entry === 'string' ? entry : entry?.Domain);
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  // An empty list of allowed domains blocks every domain, but an empty list means
  // "every domain" to the rules, so only AllowAllKnownDomains is passed on as one.
  const listed = Array.isArray(value) ? value
    : isObject && Object.hasOwn(value, 'AllowedDomain') ? [value.AllowedDomain].flat().filter((entry) => entry != null)
      : isObject && Object.keys(value).length === 1 && Object.hasOwn(value, 'AllowAllKnownDomains') ? []
        : null;
  const allowsAll = isObject && Object.hasOwn(value, 'AllowAllKnownDomains');
  if (!listed || (listed.length === 0 && !allowsAll) || listed.some((entry) => typeof domainOf(entry) !== 'string')) {
    throw new CouldNotBuild('federation_configuration', 'the backup does not say which domains Teams external access allows');
  }
  return listed.map(domainOf);
}

// SharePoint's numbers for Graph's named choices (SharingCapabilities and
// SharingDomainRestrictionModes in the SharePoint admin API).
export const SHARING_CAPABILITY = Object.freeze({
  disabled: 0, externalUserSharingOnly: 1, externalUserAndGuestSharing: 2, existingExternalUserSharingOnly: 3,
});
export const SHARING_DOMAIN_RESTRICTION = Object.freeze({ none: 0, allowList: 1, blockList: 2 });

function spoTenant(facts) {
  const tenant = list(facts, SHAREPOINT_SETTINGS).find((fact) => fact.id === 'tenant');
  if (!tenant) throw new CouldNotBuild('SPO_tenant', 'the SharePoint backup holds no tenant sharing settings');
  const number = (table, value, name) => {
    if (typeof value === 'string' && Object.hasOwn(table, value)) return table[value];
    throw new CouldNotBuild('SPO_tenant', `the backup does not say how ${name} is set`);
  };
  const domains = (value) => (Array.isArray(value) ? value.join(' ') : '');
  return [{
    SharingCapability: number(SHARING_CAPABILITY, tenant.sharingCapability, 'external sharing'),
    SharingDomainRestrictionMode: number(SHARING_DOMAIN_RESTRICTION, tenant.sharingDomainRestrictionMode, 'the sharing domain list'),
    SharingAllowedDomainList: domains(tenant.sharingAllowedDomainList),
    SharingBlockedDomainList: domains(tenant.sharingBlockedDomainList),
  }];
}

/**
 * Get-PowerPlatformDlpPoliciesRest answers one page, { value: [policy, ...] }. Keel reads
 * the same policies through the newer governance API, whose policies carry the same
 * name, displayName, environmentType and environments (each with its name). This is
 * not confirmed against a live read yet.
 */
function dlpPolicies(facts) {
  const value = list(facts, POWER_PLATFORM_SETTINGS).filter((fact) => fact.kind === 'dlpPolicy').map((policy) => ({
    name: policy.identity ?? null,
    displayName: policy.displayName ?? null,
    environmentType: policy.environmentType ?? null,
    environments: Array.isArray(policy.environments) ? policy.environments : [],
  }));
  return [{ value }];
}

const SCUBA_CONFIG_FIELDS = Object.freeze([
  'M365Environment', 'Aad', 'Exo', 'CapExclusions', 'RoleExclusions', 'AgentExclusions', 'Agents', 'Users', 'Groups',
  'Applications', 'GuestUserTypes', 'AllowedForwardingDomains',
  // Security Suite: its per-rule sections (and the older Defender ones), and where a run writes its files.
  'SecuritySuite', 'Defender', 'OutputPath', 'OutPath', 'OutRegoFileName', 'OutputRegoFileName',
]);

// Every tenant has the Default remote domain (*); a read without it is not a tenant
// with no remote domains.
function remoteDomains(facts) {
  const domains = ofKind(facts, 'remoteDomain');
  if (!domains.some((domain) => domain.DomainName === '*')) {
    throw new CouldNotBuild('remote_domains', 'the backup holds no Default remote domain (*), which every tenant has');
  }
  return domains;
}

export const ADAPTERS = Object.freeze({
  // Run settings: the tenant's lists (config.mjs) on a commercial cloud. Without them,
  // ScubaGear's own default: no exclusions.
  scuba_config: Object.freeze({ setting: true, fields: SCUBA_CONFIG_FIELDS, build: (facts, run) => structuredClone(run?.config ?? DEFAULT_SCUBA_CONFIG) }),
  module_version: Object.freeze({ setting: true, fields: [], build: (facts, run) => run.version }),

  // Entra ID
  conditional_access_policies: Object.freeze({
    reads: [graph('conditionalAccessPolicy')], fields: 'all',
    // Agent conditions exist only in Graph beta; Keel reads sign-in rules through v1.0.
    lacks: ['AgentIdRiskLevels', 'IncludeAgentIdServicePrincipals', 'ExcludeAgentIdServicePrincipals'],
    build: (facts) => list(facts, 'conditionalAccessPolicy').map(pascal),
  }),
  authorization_policies: Object.freeze({ reads: [graph('authorizationPolicy')], fields: 'all', build: (facts) => single(facts, 'authorizationPolicy', 'authorization_policies').map(pascal) }),
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
    reads: [graph('tenantAppManagementPolicy')], fields: 'all', build: (facts) => single(facts, 'tenantAppManagementPolicy', 'default_app_management_policy').map(pascal),
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
  remote_domains: Object.freeze({ reads: [mailFlow('remoteDomain')], fields: FAMILIES.remoteDomain.fields, build: remoteDomains }),
  accepted_domains: Object.freeze({ reads: [mailFlow('acceptedDomain')], fields: FAMILIES.acceptedDomain.fields, build: (facts) => ofKind(facts, 'acceptedDomain') }),
  dkim_config: Object.freeze({ reads: [mailFlow('dkimSigning')], fields: FAMILIES.dkimSigning.fields, build: (facts) => ofKind(facts, 'dkimSigning') }),
  transport_rule: Object.freeze({ reads: [mailFlow('transportRule')], fields: FAMILIES.transportRule.fields, build: (facts) => ofKind(facts, 'transportRule') }),
  // Get-TransportConfig, Get-SharingPolicy and Get-OrganizationConfig, as the
  // exchange-org-defaults and exchange-org-access reads keep them. Those reads stay off
  // until their live read check passes; until then these rules read "could not check".
  transport_config: Object.freeze({
    reads: [service(EXCHANGE_ORG_DEFAULTS_WORKLOAD, 'transportConfig')], fields: DEFAULTS_FAMILIES.transportConfig.fields,
    build: organizationWide('transport_config', 'transportConfig', ['SmtpClientAuthenticationDisabled']),
  }),
  sharing_policy: Object.freeze({
    reads: [service(EXCHANGE_ORG_ACCESS_WORKLOAD, 'sharingPolicy')], fields: ACCESS_FAMILIES.sharingPolicy.fields, build: sharingPolicies,
  }),
  org_config: Object.freeze({
    reads: [service(EXCHANGE_ORG_DEFAULTS_WORKLOAD, 'organizationConfig')], fields: DEFAULTS_FAMILIES.organizationConfig.fields,
    build: organizationWide('org_config', 'organizationConfig', ['AuditDisabled']),
  }),

  // Security Suite (Defender for Office 365, Exchange Online Protection, Purview)
  ...cmdletKeys(MAIL_FLOW, FAMILIES, {
    anti_phish_policies: 'antiPhishPolicy', anti_malware_policies: 'antiMalwarePolicy', safe_attachment_policies: 'safeAttachmentPolicy',
    safe_links_policies: 'safeLinksPolicy', hosted_content_filter_policies: 'antiSpamPolicy',
  }, {
    // Which preset (Standard, Strict or Custom) a policy belongs to: Keel's read does not keep it.
    lacks: { hosted_content_filter_policies: ['RecommendedPolicyType'] },
  }),
  ...cmdletKeys(EXCHANGE_EXTENDED, EXTENDED, {
    protection_policy_rules: 'eopPresetRule', atp_policy_rules: 'defenderPresetRule', atp_policy_for_o365: 'defenderForOffice',
    anti_phish_rules: 'antiPhishRule', anti_malware_rules: 'antiMalwareRule', safe_attachment_rules: 'safeAttachmentRule',
    safe_links_rules: 'safeLinksRule', hosted_content_filter_rules: 'antiSpamRule', conn_filter: 'connectionFilterPolicy',
  }),
  ...cmdletKeys(PURVIEW_DLP, PURVIEW, {
    dlp_compliance_policies: 'dlpPolicy', dlp_compliance_rules: 'dlpRule', protection_alerts: 'alertPolicy',
  }, {
    // Whether a DLP policy is on, and whether a rule is written as an advanced rule: Keel's read keeps neither.
    lacks: { dlp_compliance_policies: ['Enabled'], dlp_compliance_rules: ['IsAdvancedRule'] },
    // Each sensitive type in a rule's ContentContainsSensitiveInformation has a name; Keel keeps that field whole.
    nested: { dlp_compliance_rules: ['name'] },
  }),
  // ScubaGear's provider sets this from whether the Defender for Office 365 cmdlets
  // exist. Keel's read of Get-AtpPolicyForO365 (a Defender for Office 365 cmdlet) is
  // recorded as not licensed, with no object, when they do not: a tenant that has it
  // always has its one Default object.
  defender_license: Object.freeze({
    reads: [service(EXCHANGE_EXTENDED, 'defenderForOffice')], fields: [],
    build: (facts) => list(facts, EXCHANGE_EXTENDED).some((fact) => fact.kind === 'defenderForOffice'),
  }),

  // Teams
  ...cmdletKeys(TEAMS_POLICIES, TEAMS, {
    meeting_policies: 'meetingPolicy', client_configuration: 'clientConfiguration', app_policies: 'appPermissionPolicy',
  }, { identity: false, check: teamsChecked }),
  federation_configuration: Object.freeze({
    reads: [service(TEAMS_POLICIES, 'federationConfiguration')], fields: TEAMS.federationConfiguration.fields,
    build: (facts) => teamsChecked('federation_configuration')(ofKind(facts, 'federationConfiguration', TEAMS_POLICIES)
      .map((configuration) => ({ ...configuration, AllowedDomains: allowedDomains(configuration.AllowedDomains) }))),
  }),
  ...cmdletKeys(TEAMS_VOICE, TEAMS_EXTENDED, { broadcast_policies: 'liveEventsPolicy' }, { identity: false, check: teamsChecked }),

  // SharePoint and OneDrive. Keel reads the tenant's sharing settings through Graph
  // (sharepointSettings), which names its choices; the SharePoint admin API ScubaGear
  // reads gives the same choices as numbers. Only these settings are in Graph: a rule
  // that names any other SharePoint admin setting reads "could not check".
  SPO_tenant: Object.freeze({
    reads: [service(SHAREPOINT_SETTINGS)],
    fields: Object.freeze(['SharingCapability', 'SharingDomainRestrictionMode', 'SharingAllowedDomainList', 'SharingBlockedDomainList']),
    build: spoTenant,
  }),

  // Power Platform
  dlp_policies: Object.freeze({
    reads: [service(POWER_PLATFORM_SETTINGS, 'dlpPolicy')], fields: Object.freeze(['value', 'name', 'displayName', 'environmentType', 'environments']),
    build: dlpPolicies,
  }),
  environment_list: Object.freeze({
    reads: [service(POWER_PLATFORM_SETTINGS, 'environment')], fields: Object.freeze(['EnvironmentName', 'IsDefault']),
    build: (facts) => {
      const environments = list(facts, POWER_PLATFORM_SETTINGS).filter((fact) => fact.kind === 'environment')
        .map((environment) => ({ EnvironmentName: environment.identity ?? null, IsDefault: environment.isDefault ?? null }));
      // Every tenant has one default environment; without it the rules would find none to judge.
      if (!environments.some((environment) => environment.IsDefault === true && typeof environment.EnvironmentName === 'string')) {
        throw new CouldNotBuild('environment_list', 'the backup lists no default Power Platform environment, which every tenant has');
      }
      return environments;
    },
  }),
  // The default environment is named Default-<tenant id>; the rules look for it by name.
  tenant_id: Object.freeze({
    reads: [graph('organization')], fields: [],
    build: (facts) => {
      const [organization] = list(facts, 'organization');
      if (typeof organization?.id !== 'string') throw new CouldNotBuild('tenant_id', 'the backup holds no organization record to take the tenant id from');
      return organization.id;
    },
  }),

  // Power BI. Keel reads the same Fabric admin API ScubaGear does. The license and
  // access keys say the read worked, which the control already requires before it runs.
  powerbi_tenant_settings: Object.freeze({
    reads: [service(POWER_PLATFORM_SETTINGS, 'powerBiSetting')], fields: Object.freeze(['settingName', ...POWER_PLATFORM.powerBiSetting.top]),
    build: (facts) => list(facts, POWER_PLATFORM_SETTINGS).filter((fact) => fact.kind === 'powerBiSetting')
      .map(({ identity, ...fields }) => ({ ...cmdletObject(fields), settingName: identity ?? null })),
  }),
  powerbi_license_found: Object.freeze({ setting: true, fields: [], build: () => true }),
  powerbi_license_reason: Object.freeze({ setting: true, fields: [], build: () => '' }),
  powerbi_access_denied_reason: Object.freeze({ setting: true, fields: [], build: () => '' }),
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
