/**
 * Risk flags (insights track, A6): what a change does, not just what kind of setting it is.
 *
 * The change feed ranks a row by its kind (taxonomy.mjs). A flag reads the change itself:
 * "Turned off: Require MFA for admins." is critical, a rename of the same policy is not.
 *
 * Each rule has a key, a severity (critical or high), the sources and kinds it applies to,
 * a test and a sentence built from the setting's own fields. Every rule is directional: the
 * reverse change, or a harmless one, does not flag.
 *
 * What a rule sees:
 *  - drift rows (a backup against the approved setup): the before and after values of the
 *    paths in FLAG_PATHS only, never the whole saved copy (the feed reads up to 500 rows);
 *  - service rows (a service read against the one before): the changed fields the read
 *    recorded, filtered to SERVICE_FLAG_PATHS;
 *  - backup rows (who can reach a site or OneDrive, compared between two content backups,
 *    sharingExposure.mjs): the one change the row is about, as `context.exposure`;
 *  - audit rows (the Microsoft audit log): the activity, the operation, the target's type
 *    and the changed field names. Never values, so an audit rule cannot tell a policy turned
 *    off from one renamed; it flags only what the activity itself says (a policy deleted,
 *    someone added to an admin role, enterprise app credentials added, a new app permission).
 *
 * evaluateFlags is pure (one change in, flags out), so the alerts and Insights work can
 * call it on full payloads through flagValues(). docs/insights.md lists every rule.
 */
import { PRIVILEGED_DRIFT_TYPES, PRIVILEGED_SERVICE_WORKLOADS } from '../govern/dispositionReview.mjs';
import { SHARING_DIRECTION_PATHS, SHARING_ORDER, expiryDays, scaleValue, sharingDirection } from '../govern/sharingDirection.mjs';
import { EXPOSURE_KINDS, canEdit } from './sharingExposure.mjs';

export const FLAG_SEVERITIES = Object.freeze(['critical', 'high']);

// Admin-role assignment kinds: the Entra ones and every other service's from the
// privileged list a second-person review already uses (dispositionReview.mjs).
export const ROLE_ASSIGNMENT_KINDS = Object.freeze([
  'roleAssignment', 'roleAssignmentSchedule', 'roleEligibilitySchedule',
  ...PRIVILEGED_DRIFT_TYPES.filter((type) => /RoleAssignment$/.test(type)),
]);
// Group membership links, as edge changes store them (diffSnapshots.mjs) and as older rows name them.
export const MEMBERSHIP_KINDS = Object.freeze(['groupMembership', 'groupMember']);

const CA_EXCLUSIONS = Object.freeze({
  'conditions.users.excludeUsers': 'users',
  'conditions.users.excludeGroups': 'groups',
  'conditions.users.excludeRoles': 'roles',
  'conditions.locations.excludeLocations': 'locations',
});
const CROSS_TENANT_SECTIONS = Object.freeze({
  b2bCollaborationInbound: 'guests from other organizations',
  b2bCollaborationOutbound: 'your people as guests elsewhere',
  b2bDirectConnectInbound: 'direct connect from other organizations',
  b2bDirectConnectOutbound: 'direct connect to other organizations',
});
const CROSS_TENANT_PATHS = Object.keys(CROSS_TENANT_SECTIONS).flatMap((section) => [`${section}.usersAndGroups.accessType`, `${section}.applications.accessType`]);

/**
 * The paths each drift kind's rules read, from the saved copy before and after. A path is
 * dotted (`grantControls.builtInControls`); `[*]` collects one field of every list entry
 * (`passwordCredentials[*].keyId`). The feed selects only these in SQL (flagPathsSql).
 */
export const FLAG_PATHS = Object.freeze({
  conditionalAccessPolicy: Object.freeze(['state', ...Object.keys(CA_EXCLUSIONS), 'grantControls.builtInControls', 'grantControls.authenticationStrength.id']),
  namedLocation: Object.freeze(['isTrusted', 'ipRanges[*].cidrAddress']),
  application: Object.freeze(['passwordCredentials[*].keyId', 'keyCredentials[*].keyId']),
  servicePrincipal: Object.freeze(['passwordCredentials[*].keyId', 'keyCredentials[*].keyId']),
  identitySecurityDefaultsEnforcementPolicy: Object.freeze(['isEnabled']),
  authenticationMethodsPolicy: Object.freeze(['authenticationMethodConfigurations[*].id', 'authenticationMethodConfigurations[*].state']),
  authenticationStrengthPolicy: Object.freeze(['allowedCombinations']),
  crossTenantAccessPolicyConfigurationDefault: Object.freeze(CROSS_TENANT_PATHS),
  authorizationPolicy: Object.freeze(['allowInvitesFrom', 'allowEmailVerifiedUsersToJoinOrganization']),
});

// SharePoint and OneDrive tenant sharing, as the two SharePoint reads record it.
const SHARING_WORKLOADS = Object.freeze(['sharepoint-site-settings', 'sharepoint-tenant']);
const SHARING_PATHS = Object.freeze({ sharingCapability: 'SharePoint', SharingCapability: 'SharePoint', OneDriveSharingCapability: 'OneDrive' });
const EXPIRY_PATHS = Object.freeze({ RequireAnonymousLinksExpireInDays: 'Anyone links' });
// "Shared wider than before": every other sharing setting with a direction, and every
// one a OneDrive's own settings carry. Rule 9 above already speaks for the tenant and site
// sharing levels and the tenant anyone-link expiry.
const ONEDRIVE_WORKLOAD = 'onedrive-site-settings';
const WIDER_PATHS = Object.freeze({
  ...Object.fromEntries(SHARING_WORKLOADS.map((workload) => [workload, Object.freeze(Object.keys(SHARING_DIRECTION_PATHS).filter((path) => !SHARING_PATHS[path] && !EXPIRY_PATHS[path]))])),
  [ONEDRIVE_WORKLOAD]: Object.freeze(['SharingCapability', 'DefaultSharingLinkType', 'AnonymousLinkExpirationInDays']),
});
/** The changed fields a service row's rules read, by workload. */
export const SERVICE_FLAG_PATHS = Object.freeze({
  ...Object.fromEntries(SHARING_WORKLOADS.map((workload) => [workload, Object.freeze([...Object.keys(SHARING_PATHS), ...Object.keys(EXPIRY_PATHS), ...WIDER_PATHS[workload]])])),
  [ONEDRIVE_WORKLOAD]: WIDER_PATHS[ONEDRIVE_WORKLOAD],
  ...Object.fromEntries(PRIVILEGED_SERVICE_WORKLOADS.map((workload) => [workload, Object.freeze(['Members'])])),
});

// ---------------------------------------------------------------- reading values

const list = (value) => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]);
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : value);
const keyOf = (value) => (value && typeof value === 'object' ? JSON.stringify(value) : String(lower(value)));
/** Entries of `after` that `before` does not hold (compared without case). */
const gained = (before, after) => {
  const had = new Set(list(before).map(keyOf));
  return list(after).filter((entry) => entry !== null && entry !== undefined && !had.has(keyOf(entry)));
};

function readPath(payload, path) {
  if (!payload || typeof payload !== 'object') return null;
  const star = path.indexOf('[*].');
  if (star !== -1) {
    const items = readPath(payload, path.slice(0, star));
    return Array.isArray(items) ? items.map((item) => readPath(item, path.slice(star + 4))).filter((value) => value !== null) : null;
  }
  let value = payload;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = value[part];
  }
  return value ?? null;
}

/** The values a drift kind's rules read, from a full saved copy: { path: value }. Pure. */
export function flagValues(type, payload) {
  const paths = FLAG_PATHS[type];
  if (!paths || !payload || typeof payload !== 'object') return null;
  return Object.fromEntries(paths.map((path) => [path, readPath(payload, path)]));
}

const sqlPath = (path) => `'$.${path.replace(/\[\*\]\./g, '[*].')}'`;
/**
 * SQL for the same values, read in the database: a jsonb object of each path, or NULL for
 * a kind no rule reads, so a row of any other kind costs nothing. `payload` and `type` are
 * SQL expressions.
 */
export function flagPathsSql(payload, type) {
  const cases = Object.entries(FLAG_PATHS).map(([kind, paths]) => {
    const pairs = paths.map((path) => `'${path}', ${path.includes('[*]') ? 'jsonb_path_query_array' : 'jsonb_path_query_first'}(${payload}, ${sqlPath(path)})`);
    return `WHEN '${kind}' THEN jsonb_build_object(${pairs.join(', ')})`;
  });
  return `CASE WHEN ${payload} IS NULL THEN NULL ELSE CASE ${type} ${cases.join(' ')} END END`;
}

/** SQL for a service row's changed fields that a rule reads, or NULL. `workload` and `fields` are SQL. */
export function serviceFlagFieldsSql(workload, fields) {
  const cases = Object.entries(SERVICE_FLAG_PATHS).map(([name, paths]) => `WHEN '${name}' THEN ARRAY[${paths.map((path) => `'${path}'`).join(', ')}]`);
  return `(SELECT jsonb_agg(f) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${fields}) = 'array' THEN ${fields} ELSE '[]'::jsonb END) f
            WHERE f->>'path' = ANY (CASE ${workload} ${cases.join(' ')} ELSE ARRAY[]::text[] END))`;
}

// ---------------------------------------------------------------- words

const named = (input, fallback) => input.name ?? fallback;
const words = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const ACTIVE_CA = (state) => state === 'enabled' || state === 'enabledForReportingButNotEnforced';
const requiresMfa = (values) => list(values?.['grantControls.builtInControls']).map(lower).includes('mfa') || Boolean(values?.['grantControls.authenticationStrength.id']);
const blocks = (values) => list(values?.['grantControls.builtInControls']).map(lower).includes('block');

// Sign-in methods that are easy to phish or intercept, by their Graph configuration id.
const WEAK_METHODS = Object.freeze({ sms: 'text message (SMS)', voice: 'voice call', email: 'email one-time passcode' });
const methodStates = (values) => {
  const ids = list(values?.['authenticationMethodConfigurations[*].id']);
  const states = list(values?.['authenticationMethodConfigurations[*].state']);
  return new Map(ids.map((id, index) => [lower(id), lower(states[index])]));
};

// Wider is later. SharePoint's sharing levels (sharingDirection.mjs), and who may invite guests.
const SHARING_WORDS = Object.freeze({
  Disabled: 'only people in the organization',
  ExistingExternalUserSharingOnly: 'existing guests',
  ExternalUserSharingOnly: 'new and existing guests',
  ExternalUserAndGuestSharing: 'anyone, with links that need no sign-in',
});
const INVITE_ORDER = Object.freeze(['none', 'adminsAndGuestInviters', 'adminsGuestInvitersAndAllMembers', 'everyone']);
const INVITE_WORDS = Object.freeze({
  none: 'nobody', adminsAndGuestInviters: 'admins and guest inviters', adminsGuestInvitersAndAllMembers: 'all members', everyone: 'everyone, guests included',
});
const rank = (order, value) => order.findIndex((entry) => lower(entry) === lower(value));
const opened = (order, before, after) => rank(order, before) !== -1 && rank(order, after) > rank(order, before);
const canonical = (order, value) => order[rank(order, value)] ?? value;

// What each wider sharing setting now allows, in words.
const LINK_TYPE_WORDS = Object.freeze({ Direct: 'specific people', Internal: 'people in the organization', AnonymousAccess: 'anyone with the link' });
const ANONYMOUS_LINK_WORDS = Object.freeze({ View: 'view', Edit: 'edit' });
function widerWords(path, before, after) {
  if (path === 'DefaultSharingLinkType') return `new links are for ${LINK_TYPE_WORDS[scaleValue('linkType', after)]} by default`;
  if (path === 'FileAnonymousLinkType' || path === 'FolderAnonymousLinkType') {
    return `anyone links to ${path === 'FileAnonymousLinkType' ? 'files' : 'folders'} can now ${ANONYMOUS_LINK_WORDS[scaleValue('anonymousLink', after)]}`;
  }
  if (SHARING_DIRECTION_PATHS[path] === 'expiry') {
    const now = expiryDays(after);
    return now === null ? 'anyone links no longer expire' : `anyone links last ${now} days instead of ${expiryDays(before)}`;
  }
  return `files can be shared with ${SHARING_WORDS[scaleValue('sharing', after)]}`;
}
const widened = ({ type, before, after }) => (WIDER_PATHS[type] ?? []).filter((path) => sharingDirection(path, before?.[path], after?.[path]) === 'wider');

// Who an Everyone grant reaches, as a backup row's flag sentence says it.
const EVERYONE_WORDS = Object.freeze({ everyone: 'everyone in the company, guests included', 'everyone-except-external': 'everyone in the company' });
const exposureOf = (input) => input.context?.exposure ?? null;
const everyoneAdded = (input) => {
  const exposure = exposureOf(input);
  return exposure?.what === 'everyone' && exposure.change === 'added' && input.change === 'added';
};

// "Directory.ReadWrite.All": tenant-wide write permissions, the critical ones.
export function tenantWideWrite(permission) {
  return typeof permission === 'string'
    && (/\.ReadWrite\.All$/i.test(permission) || /^(Directory|RoleManagement|AppRoleAssignment)\./i.test(permission));
}

/** The role a roleAssignment natural key names (`roleAssignment:<role key>@<who>@<scope>`). */
function roleNameFromKey(key) {
  if (typeof key !== 'string' || !key.startsWith('roleAssignment:')) return null;
  const at = key.indexOf('@');
  const role = key.slice('roleAssignment:'.length, at === -1 ? undefined : at).replace(/^[A-Za-z]+:/, '').trim();
  return role && !/^unknown/i.test(role) && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(role) ? role : null;
}

const activityIs = (pattern) => (input) => typeof input.activity === 'string' && pattern.test(input.activity);
const targetIs = (...types) => (input) => types.includes(lower(input.targetType ?? input.type));

// ---------------------------------------------------------------- rules

/**
 * Every rule. `sources` and `kinds` say which rows it reads (`kinds` null: any kind, the
 * test decides). `test(input)` and `sentence(input)` take the evaluator's input.
 */
export const FLAG_RULES = Object.freeze([
  // 1. Conditional Access policy turned off, switched to report-only, or deleted.
  {
    key: 'ca-turned-off', severity: 'critical', sources: ['drift'], kinds: ['conditionalAccessPolicy'],
    test: ({ change, before, after }) => change === 'modified' && ACTIVE_CA(before?.state) && after?.state === 'disabled',
    sentence: (input) => `Turned off: ${named(input, 'a Conditional Access policy')}.`,
  },
  {
    key: 'ca-report-only', severity: 'critical', sources: ['drift'], kinds: ['conditionalAccessPolicy'],
    test: ({ change, before, after }) => change === 'modified' && before?.state === 'enabled' && after?.state === 'enabledForReportingButNotEnforced',
    sentence: (input) => `Switched to report-only, so it no longer blocks anything: ${named(input, 'a Conditional Access policy')}.`,
  },
  {
    key: 'ca-deleted', severity: 'critical', sources: ['drift'], kinds: ['conditionalAccessPolicy'],
    // Deleting a policy that was already off changes nothing.
    test: ({ change, before }) => change === 'removed' && ACTIVE_CA(before?.state),
    sentence: (input) => `Deleted: ${named(input, 'a Conditional Access policy')}.`,
  },
  {
    key: 'ca-deleted-audit', severity: 'critical', sources: ['audit'], kinds: null,
    test: (input) => input.operation === 'delete' && activityIs(/^delete conditional access policy/i)(input),
    sentence: (input) => `Deleted: ${named(input, 'a Conditional Access policy')}.`,
  },
  // 2. Conditional Access policy leaves out more people or places, or stops asking for MFA.
  {
    key: 'ca-exclusions-added', severity: 'critical', sources: ['drift'], kinds: ['conditionalAccessPolicy'],
    // A policy that was off enforced nothing, so turning it on with exclusions weakens nothing.
    test: ({ change, before, after }) => change === 'modified' && ACTIVE_CA(before?.state) && ACTIVE_CA(after?.state)
      && Object.keys(CA_EXCLUSIONS).some((path) => gained(before?.[path], after?.[path]).length > 0),
    sentence: (input) => {
      const what = Object.entries(CA_EXCLUSIONS).filter(([path]) => gained(input.before?.[path], input.after?.[path]).length > 0).map(([, noun]) => noun);
      return `Leaves out more ${words(what)}: ${named(input, 'a Conditional Access policy')}.`;
    },
  },
  {
    key: 'ca-mfa-removed', severity: 'critical', sources: ['drift'], kinds: ['conditionalAccessPolicy'],
    // Swapping MFA for a block is stricter, not weaker.
    test: ({ change, before, after }) => change === 'modified' && ACTIVE_CA(before?.state) && ACTIVE_CA(after?.state)
      && requiresMfa(before) && !requiresMfa(after) && !blocks(after),
    sentence: (input) => (input.before?.['grantControls.authenticationStrength.id'] && !list(input.before?.['grantControls.builtInControls']).map(lower).includes('mfa')
      ? `No longer asks for an authentication strength: ${named(input, 'a Conditional Access policy')}.`
      : `No longer asks for MFA: ${named(input, 'a Conditional Access policy')}.`),
  },
  // 3. Someone added to an admin role, or to a group that can hold admin roles.
  {
    key: 'admin-role-added', severity: 'critical', sources: ['drift'], kinds: ROLE_ASSIGNMENT_KINDS,
    test: ({ change }) => change === 'added',
    sentence: (input) => {
      // Never the assignment's own name: some services name it after the person it holds.
      const role = input.context?.roleName ?? roleNameFromKey(input.key);
      return role ? `Someone was given an admin role: ${role}.` : 'Someone was given an admin role.';
    },
  },
  {
    key: 'role-group-member-added', severity: 'critical', sources: ['drift'], kinds: MEMBERSHIP_KINDS,
    test: ({ change, context }) => change === 'added' && context?.roleAssignable === true,
    sentence: (input) => `Someone was added to a group that holds admin roles: ${input.context?.groupName ?? named(input, 'a role-assignable group')}.`,
  },
  {
    key: 'role-group-member-added-service', severity: 'critical', sources: ['service'], kinds: PRIVILEGED_SERVICE_WORKLOADS,
    test: ({ change, before, after }) => change === 'modified' && gained(before?.Members, after?.Members).length > 0,
    sentence: (input) => `Someone was added to an Exchange admin role group: ${named(input, 'a role group')}.`,
  },
  {
    key: 'admin-role-added-audit', severity: 'critical', sources: ['audit'], kinds: null,
    // The log names the role and the person as two targets; the role's row carries the flag.
    test: (input) => activityIs(/^add (eligible |scoped )?member to role/i)(input) && targetIs('role', 'directoryrole', 'roledefinition')(input),
    sentence: (input) => (input.name ? `Someone was added to an admin role: ${input.name}.` : 'Someone was added to an admin role.'),
  },
  // 4. A new secret or certificate on an app registration or enterprise app.
  {
    key: 'app-credential-added', severity: 'high', sources: ['drift'], kinds: ['application', 'servicePrincipal'],
    test: ({ change, before, after }) => (change === 'modified' || change === 'added')
      && (gained(before?.['passwordCredentials[*].keyId'], after?.['passwordCredentials[*].keyId']).length > 0
        || gained(before?.['keyCredentials[*].keyId'], after?.['keyCredentials[*].keyId']).length > 0),
    sentence: (input) => {
      const secret = gained(input.before?.['passwordCredentials[*].keyId'], input.after?.['passwordCredentials[*].keyId']).length > 0;
      const certificate = gained(input.before?.['keyCredentials[*].keyId'], input.after?.['keyCredentials[*].keyId']).length > 0;
      const what = secret && certificate ? 'New client secret and certificate' : secret ? 'New client secret' : 'New certificate';
      return `${what} on: ${named(input, 'an app')}.`;
    },
  },
  {
    key: 'app-credential-added-audit', severity: 'high', sources: ['audit'], kinds: null,
    // Only an activity that can mean nothing but an addition: Entra logs "Update application –
    // Certificates and secrets management" for removals too, and gives no values.
    test: activityIs(/^add service principal credentials/i),
    sentence: (input) => `New secret or certificate on: ${named(input, 'an app')}.`,
  },
  // 5. A new application permission granted to an app.
  {
    key: 'app-permission-tenant-write', severity: 'critical', sources: ['drift'], kinds: ['appRoleGrant'],
    test: ({ change, context }) => change === 'added' && tenantWideWrite(context?.permission),
    sentence: (input) => `New tenant-wide permission ${input.context.permission} for: ${input.context?.appName ?? named(input, 'an app')}.`,
  },
  {
    key: 'app-permission-granted', severity: 'high', sources: ['drift'], kinds: ['appRoleGrant'],
    test: ({ change, context }) => change === 'added' && !tenantWideWrite(context?.permission),
    sentence: (input) => {
      const app = input.context?.appName ?? named(input, 'an app');
      return input.context?.permission ? `New permission ${input.context.permission} for: ${app}.` : `New app permission for: ${app}.`;
    },
  },
  {
    key: 'app-permission-granted-audit', severity: 'high', sources: ['audit'], kinds: null,
    test: activityIs(/^add app role assignment to service principal/i),
    sentence: (input) => `New app permission for: ${named(input, 'an app')}.`,
  },
  // 6. A named location marked trusted, or IP ranges added to a trusted one.
  {
    key: 'location-trusted', severity: 'high', sources: ['drift'], kinds: ['namedLocation'],
    test: ({ change, before, after }) => after?.isTrusted === true && (change === 'added' || (change === 'modified' && before?.isTrusted !== true)),
    sentence: (input) => `Now trusted for sign-in: ${named(input, 'a named location')}.`,
  },
  {
    key: 'trusted-ranges-added', severity: 'high', sources: ['drift'], kinds: ['namedLocation'],
    test: ({ change, before, after }) => change === 'modified' && before?.isTrusted === true && after?.isTrusted === true
      && gained(before?.['ipRanges[*].cidrAddress'], after?.['ipRanges[*].cidrAddress']).length > 0,
    sentence: (input) => {
      const ranges = gained(input.before?.['ipRanges[*].cidrAddress'], input.after?.['ipRanges[*].cidrAddress']);
      const shown = ranges.slice(0, 3).join(', ') + (ranges.length > 3 ? ` and ${ranges.length - 3} more` : '');
      return `New trusted IP ranges (${shown}) in: ${named(input, 'a named location')}.`;
    },
  },
  // 7. Sign-in made weaker tenant-wide.
  {
    key: 'security-defaults-off', severity: 'high', sources: ['drift'], kinds: ['identitySecurityDefaultsEnforcementPolicy'],
    test: ({ change, before, after }) => change === 'modified' && before?.isEnabled === true && after?.isEnabled === false,
    sentence: () => 'Security defaults turned off for the whole tenant.',
  },
  {
    key: 'weak-method-on', severity: 'high', sources: ['drift'], kinds: ['authenticationMethodsPolicy'],
    test: ({ change, before, after }) => {
      if (change !== 'modified') return false;
      const was = methodStates(before);
      const now = methodStates(after);
      return Object.keys(WEAK_METHODS).some((id) => now.get(id) === 'enabled' && was.get(id) !== 'enabled');
    },
    sentence: ({ before, after }) => {
      const was = methodStates(before);
      const now = methodStates(after);
      const methods = Object.entries(WEAK_METHODS).filter(([id]) => now.get(id) === 'enabled' && was.get(id) !== 'enabled').map(([, label]) => label);
      return `Weaker sign-in ${methods.length === 1 ? 'method' : 'methods'} turned on: ${words(methods)}.`;
    },
  },
  {
    key: 'auth-strength-loosened', severity: 'high', sources: ['drift'], kinds: ['authenticationStrengthPolicy'],
    test: ({ change, before, after }) => change === 'modified' && gained(before?.allowedCombinations, after?.allowedCombinations).length > 0,
    sentence: (input) => `Accepts more sign-in methods than before: ${named(input, 'an authentication strength')}.`,
  },
  // 8. Cross-tenant access defaults or guest invites opened wider.
  {
    key: 'cross-tenant-opened', severity: 'high', sources: ['drift'], kinds: ['crossTenantAccessPolicyConfigurationDefault'],
    test: ({ change, before, after }) => change === 'modified'
      && CROSS_TENANT_PATHS.some((path) => lower(before?.[path]) === 'blocked' && lower(after?.[path]) === 'allowed'),
    sentence: ({ before, after }) => {
      const sections = Object.entries(CROSS_TENANT_SECTIONS)
        .filter(([section]) => [`${section}.usersAndGroups.accessType`, `${section}.applications.accessType`].some((path) => lower(before?.[path]) === 'blocked' && lower(after?.[path]) === 'allowed'))
        .map(([, label]) => label);
      return `Other organizations are allowed by default now: ${words(sections)}.`;
    },
  },
  {
    key: 'guest-invites-opened', severity: 'high', sources: ['drift'], kinds: ['authorizationPolicy'],
    test: ({ change, before, after }) => change === 'modified'
      && (opened(INVITE_ORDER, before?.allowInvitesFrom, after?.allowInvitesFrom)
        || (before?.allowEmailVerifiedUsersToJoinOrganization === false && after?.allowEmailVerifiedUsersToJoinOrganization === true)),
    sentence: ({ before, after }) => (opened(INVITE_ORDER, before?.allowInvitesFrom, after?.allowInvitesFrom)
      ? `More people can invite guests: ${INVITE_WORDS[canonical(INVITE_ORDER, after.allowInvitesFrom)]}.`
      : 'Anyone with a verified email can now join the tenant on their own.'),
  },
  // 9. SharePoint and OneDrive sharing widened.
  {
    key: 'sharing-widened', severity: 'high', sources: ['service'], kinds: SHARING_WORKLOADS,
    test: ({ change, before, after }) => change === 'modified' && Object.keys(SHARING_PATHS).some((path) => opened(SHARING_ORDER, before?.[path], after?.[path])),
    sentence: ({ before, after }) => {
      const [path] = Object.keys(SHARING_PATHS).filter((entry) => opened(SHARING_ORDER, before?.[entry], after?.[entry]));
      return `${SHARING_PATHS[path]} sharing opened wider: files can now be shared with ${SHARING_WORDS[canonical(SHARING_ORDER, after[path])]}.`;
    },
  },
  {
    key: 'anyone-link-expiry-longer', severity: 'high', sources: ['service'], kinds: SHARING_WORKLOADS,
    test: ({ change, before, after }) => change === 'modified' && Object.keys(EXPIRY_PATHS).some((path) => {
      const was = expiryDays(before?.[path]);
      const now = expiryDays(after?.[path]);
      return was !== null && (now === null || now > was);
    }),
    sentence: ({ before, after }) => {
      const now = expiryDays(after?.RequireAnonymousLinksExpireInDays);
      const was = expiryDays(before?.RequireAnonymousLinksExpireInDays);
      return now === null ? `Anyone links no longer expire (they expired after ${was} days).` : `Anyone links last longer: ${now} days instead of ${was}.`;
    },
  },
  {
    key: 'shared-wider', severity: 'high', sources: ['service'], kinds: Object.keys(WIDER_PATHS),
    test: (input) => input.change === 'modified' && widened(input).length > 0,
    sentence: (input) => {
      const parts = widened(input).map((path) => widerWords(path, input.before?.[path], input.after?.[path]));
      return `Shared wider than before: ${words(parts)} (${named(input, 'sharing settings')}).`;
    },
  },
  // 10. A site or OneDrive opened up, compared between two content backups (#968).
  {
    key: 'opened-to-everyone-edit', severity: 'critical', sources: ['backup'], kinds: EXPOSURE_KINDS,
    test: (input) => everyoneAdded(input) && canEdit(exposureOf(input).level),
    sentence: (input) => `Opened to everyone in the company: ${EVERYONE_WORDS[exposureOf(input).audience]} can now edit ${named(input, 'a site')}.`,
  },
  {
    key: 'opened-to-everyone', severity: 'high', sources: ['backup'], kinds: EXPOSURE_KINDS,
    test: (input) => everyoneAdded(input) && !canEdit(exposureOf(input).level),
    sentence: (input) => `Opened to everyone in the company: ${EVERYONE_WORDS[exposureOf(input).audience]} can now view ${named(input, 'a site')}.`,
  },
  {
    key: 'anyone-links-added', severity: 'high', sources: ['backup'], kinds: EXPOSURE_KINDS,
    test: (input) => input.change === 'added' && exposureOf(input)?.what === 'anyone-links' && exposureOf(input).count > 0,
    sentence: (input) => {
      const { count } = exposureOf(input);
      return `Anyone links added: ${count} new ${count === 1 ? 'link' : 'links'} that need no sign-in on ${named(input, 'a site')}.`;
    },
  },
]);

/**
 * The flags one change raises, most severe first. Pure.
 * @param {{ source: 'drift' | 'service' | 'backup' | 'audit', type: string, change: 'added' | 'modified' | 'removed',
 *   name?: string | null, key?: string | null, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null,
 *   context?: Record<string, unknown> | null, activity?: string | null, operation?: string | null,
 *   targetType?: string | null, fields?: string[] }} input
 *   Drift: `before`/`after` hold FLAG_PATHS values (flagValues). Service: the changed fields
 *   as { path: value }. Audit: the activity, operation, target type and field names.
 *   `context` carries what a link's own row cannot (a group's role-assignable flag, an app
 *   permission's name). `name` is the name as the page shows it (a code name when hidden).
 * @returns {{ key: string, severity: 'critical' | 'high', sentence: string }[]}
 */
export function evaluateFlags(input, rules = FLAG_RULES) {
  if (!input || typeof input !== 'object') return [];
  const row = { ...input, name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null };
  const flags = [];
  for (const rule of rules) {
    if (!rule.sources.includes(row.source)) continue;
    if (rule.kinds && !rule.kinds.includes(row.type)) continue;
    if (!rule.test(row)) continue;
    flags.push({ key: rule.key, severity: rule.severity, sentence: rule.sentence(row) });
  }
  return flags.sort((a, b) => FLAG_SEVERITIES.indexOf(a.severity) - FLAG_SEVERITIES.indexOf(b.severity));
}

/** A service row's recorded field changes ([{ path, before, after }]) as before and after values. */
export function serviceFlagValues(fields) {
  const before = {};
  const after = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field.path !== 'string') continue;
    before[field.path] = field.before ?? null;
    after[field.path] = field.after ?? null;
  }
  return { before, after };
}

/**
 * A row's priority once its flags count: a critical flag makes it critical with the flag's
 * sentence as the reason; a high flag raises a low or normal row to high. No flag, no change.
 */
export function flaggedPriority({ priority, priorityReason }, flags) {
  const critical = flags.find((flag) => flag.severity === 'critical');
  if (critical) return { priority: 'critical', priorityReason: critical.sentence };
  const high = flags.find((flag) => flag.severity === 'high');
  if (high && (priority === 'low' || priority === 'normal')) return { priority: 'high', priorityReason: high.sentence };
  return { priority, priorityReason };
}
