/**
 * Gap 4 (site permissions audit, 2026-10-15): restore one SharePoint site's groups,
 * group members, site collection admins, custom permission levels and the role
 * assignments on the site and on its lists with their own permissions, from the
 * `site/permissions` item the content backup stores (engine/content/sharepointSites.mjs).
 *
 * One plan covers one site. KEEL only ever adds what the backup held:
 *  - a custom permission level missing now is re-created with the backup's permissions;
 *  - a group missing now is re-created (by name) with the backup's settings;
 *  - a member, site collection admin or role assignment missing now is added back.
 * Everything else is listed for a person and left as it is (`manual`): a group or
 * permission level whose settings differ, anything on the site the backup does not
 * have (a member, admin, group, level or role assignment: wider than the backup),
 * a site or list whose inheritance changed, an app principal, and a group owner.
 * KEEL never removes, narrows or changes an existing grant, and never breaks or
 * restores permission inheritance. Sharing-link and limited-access groups and the
 * Limited Access levels are SharePoint's own and are left out (`excluded`).
 *
 * Rules, the same as the site app grant restore (sharepointSiteGrants.mjs):
 *  - Never wider than the backup. Every write names something the backup holds;
 *    execute re-checks this and rebuilds the plan from the backup and the live site,
 *    which must give exactly the stored digest.
 *  - Immutable plan, persisted as a restore_dry_run artifact; the two-person approval
 *    and the separate content-effect approval (a member, admin or role assignment
 *    gives someone access to content) are the existing ones.
 *  - Disabled until qualified. Nothing is sent unless every write the plan uses is
 *    live-qualified and enabled (coverage/qualification.mjs).
 *  - No overwrite. The site is re-read before writing; if it changed since the plan,
 *    nothing is written and a new dry run is required.
 *  - Verified. After writing, the site is read back and every write must show.
 *  - Idempotent. Once restored, a new dry run plans nothing, and the same artifact run
 *    again is stale and writes nothing.
 *  - On the test tenant only a KEEL-RT- site is planned, and only KEEL-RT- levels, groups and users
 *    are written (fixtureGuard.mjs); anything else is refused at plan time and before each write.
 */
import { createHash, randomUUID } from 'node:crypto';

import { SITES_WORKLOAD, createPermissionsReader, readSitePermissions } from '../../content/sharepointSites.mjs';
import { targetProblems } from '../../content/restore/gate.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { assertContentEffectApproval, classifyContentEffects, isPreservationLockFailure } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';
import { fixtureProblem } from './fixtureGuard.mjs';

export const SITE_PERMISSIONS_RESTORE = 'sharepoint-site-permissions';
export const ROLE_DEFINITION_ADD = 'sharepoint.site-role-definitions.add';
export const GROUP_ADD = 'sharepoint.site-groups.add';
export const GROUP_MEMBER_ADD = 'sharepoint.site-group-members.add';
export const SITE_ADMIN_ADD = 'sharepoint.site-admins.add';
export const ROLE_ASSIGNMENT_ADD = 'sharepoint.site-role-assignments.add';
// In the order a plan writes them: levels and groups first, so members and role
// assignments can name them.
export const SITE_PERMISSION_WRITE_OPERATIONS = Object.freeze([ROLE_DEFINITION_ADD, GROUP_ADD, GROUP_MEMBER_ADD, SITE_ADMIN_ADD, ROLE_ASSIGNMENT_ADD]);
export const SITE_PERMISSIONS_ITEM = 'site/permissions';
export const SITE_PERMISSIONS_RESTORE_EVIDENCE_KIND = 'workload-restore';
const RESOURCE_TYPE = 'sharepointSitePermission';
const CONFIG_PATH = `workload:${SITE_PERMISSIONS_RESTORE}`;
const GRANTS_ACCESS = new Set([GROUP_MEMBER_ADD, SITE_ADMIN_ADD, ROLE_ASSIGNMENT_ADD]);
for (const id of SITE_PERMISSION_WRITE_OPERATIONS) {
  if (WORKLOAD_WRITE_OPERATIONS[id]?.resourceType !== RESOURCE_TYPE) throw new Error(`${id} must be a declared ${RESOURCE_TYPE} write`);
}

// SharePoint's own groups and principals: sharing links and limited access are made
// and removed by SharePoint as people share; the system account is not a person.
const SYSTEM_GROUP = /^(sharinglinks\.|limited access system group)/i;
const SYSTEM_LOGIN = /^sharepoint\\system$/i;
// An app principal cannot be added through ensureuser.
const APP_PRINCIPAL = /^i:0i\.t\|ms\.sp\.ext\|/i;
const SHAREPOINT_GROUP = 8;
const LIMITED_ACCESS_KIND = 1;
const CUSTOM_KIND = 0;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const lc = (value) => String(value ?? '').toLowerCase();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const isSystemGroup = (title) => SYSTEM_GROUP.test(String(title ?? ''));
const isSystemPrincipal = (principal) => SYSTEM_LOGIN.test(String(principal?.loginName ?? ''))
  || (principal?.principalType === SHAREPOINT_GROUP && isSystemGroup(principal?.title));
/** How a principal is matched between the backup and the site: a group by name, anyone else by sign-in name. */
export const principalKey = (member) => (member?.principalType === SHAREPOINT_GROUP ? `group:${lc(member.title)}` : `user:${lc(member?.loginName)}`);
const principalLabel = (member) => member?.title ?? member?.loginName ?? 'a principal';
/** True for SharePoint's Limited Access levels, which it assigns and removes itself. */
function systemRole(name, definitions) {
  const definition = (definitions ?? []).find((item) => lc(item.name) === lc(name));
  return definition ? definition.hidden === true || definition.roleTypeKind === LIMITED_ACCESS_KIND : /limited access/i.test(String(name ?? ''));
}
const groupSettings = (group) => ({
  description: group.description ?? null,
  allowMembersEditMembership: group.allowMembersEditMembership ?? null,
  allowRequestToJoinLeave: group.allowRequestToJoinLeave ?? null,
  autoAcceptRequestToJoinLeave: group.autoAcceptRequestToJoinLeave ?? null,
  onlyAllowMembersViewMembership: group.onlyAllowMembersViewMembership ?? null,
  requestToJoinLeaveEmailSetting: group.requestToJoinLeaveEmailSetting ?? null,
});
const roleDefinitionOf = (definition) => ({
  name: definition.name, description: definition.description ?? null, order: definition.order ?? null,
  basePermissions: { high: String(definition.basePermissions.high), low: String(definition.basePermissions.low) },
});
const normalUrl = (url) => String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();

/** The role assignments of one scope, as principal|role pairs (SharePoint's own left out). */
function assignmentPairs(rows, definitions) {
  const pairs = new Map();
  for (const row of rows ?? []) {
    const member = row.member ?? {};
    if (isSystemPrincipal(member)) continue;
    for (const role of row.roles ?? []) {
      if (systemRole(role.name, definitions)) continue;
      pairs.set(`${principalKey(member)}|${lc(role.name)}`, { member, role: role.name });
    }
  }
  return pairs;
}

/** The scopes with role assignments: the site, then each list with its own permissions. */
function scopesOf(value) {
  return [
    { scope: 'web', label: 'the site', unique: value.web?.hasUniqueRoleAssignments === true, assignments: value.roleAssignments ?? null, read: null },
    ...(value.lists ?? []).map((list) => ({
      scope: `list:${lc(list.id)}`, listId: lc(list.id), label: `list ${list.title ?? list.id}`, unique: true, assignments: list.roleAssignments ?? null, read: list.read ?? null,
    })),
  ];
}

export function sitePermissionsPlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

/** The live site as KEEL compares it (the backup's own form). */
export function livePermissionsFingerprint(value) {
  return sha256(value);
}

/**
 * True when a planned write adds nothing the backup does not hold: the level, group,
 * member, admin or role assignment it names is in `backup` (the `site/permissions` value).
 */
export function withinBackup(operation, backup) {
  const groups = backup?.groups ?? [];
  const group = (title) => groups.find((item) => lc(item.title) === lc(title) && !isSystemGroup(item.title));
  switch (operation?.operationId) {
    case ROLE_DEFINITION_ADD: {
      const definition = (backup?.roleDefinitions ?? []).find((item) => lc(item.name) === lc(operation.roleDefinition?.name));
      return Boolean(definition && definition.roleTypeKind === CUSTOM_KIND && definition.hidden !== true && definition.basePermissions
        && same(roleDefinitionOf(definition), operation.roleDefinition));
    }
    case GROUP_ADD: {
      const held = group(operation.group?.title);
      return Boolean(held && same({ title: held.title, ...groupSettings(held) }, operation.group));
    }
    case GROUP_MEMBER_ADD: {
      const held = group(operation.group);
      return Boolean(held && Array.isArray(held.members) && !APP_PRINCIPAL.test(operation.principal?.loginName ?? '')
        && held.members.some((member) => member.loginName && lc(member.loginName) === lc(operation.principal?.loginName) && !isSystemPrincipal(member)));
    }
    case SITE_ADMIN_ADD:
      return !APP_PRINCIPAL.test(operation.principal?.loginName ?? '')
        && (backup?.siteCollectionAdmins ?? []).some((admin) => admin.loginName && lc(admin.loginName) === lc(operation.principal?.loginName) && !isSystemPrincipal(admin));
    case ROLE_ASSIGNMENT_ADD: {
      const scope = scopesOf(backup ?? {}).find((item) => item.scope === operation.scope);
      if (!scope || !Array.isArray(scope.assignments) || (operation.scope === 'web' && !scope.unique)) return false;
      const member = operation.principal?.kind === 'group'
        ? { principalType: SHAREPOINT_GROUP, title: operation.principal.title }
        : { loginName: operation.principal?.loginName };
      if (operation.principal?.kind !== 'group' && APP_PRINCIPAL.test(member.loginName ?? '')) return false;
      return assignmentPairs(scope.assignments, backup.roleDefinitions).has(`${principalKey(member)}|${lc(operation.role)}`);
    }
    default:
      return false;
  }
}

// The account part of a claims sign-in name (i:0#.f|membership|keel-rt-x@contoso.com -> keel-rt-x).
const accountName = (loginName) => String(loginName ?? '').split('|').pop().split('@')[0];

/**
 * Why the fixture guard (fixtureGuard.mjs, #317) refuses this write, or null. On the test
 * tenant every object a write creates or names must be a KEEL-RT- fixture: the level, the
 * group, the user, and the principal a role is granted to (a built-in level may be granted).
 */
export function sitePermissionFixtureProblem(operation, { tenantRef, testTenantRefs }) {
  const check = (label, names) => fixtureProblem({ tenantRef, testTenantRefs, label, names });
  switch (operation.operationId) {
    case ROLE_DEFINITION_ADD: return check('the permission level', [operation.roleDefinition?.name]);
    case GROUP_ADD: return check('the group', [operation.group?.title]);
    case GROUP_MEMBER_ADD: return check('the group', [operation.group]) ?? check('the member', [accountName(operation.principal?.loginName)]);
    case SITE_ADMIN_ADD: return check('the admin', [accountName(operation.principal?.loginName)]);
    case ROLE_ASSIGNMENT_ADD: return operation.principal?.kind === 'group'
      ? check('the group granted', [operation.principal.title])
      : check('the user granted', [accountName(operation.principal?.loginName)]);
    default: return check('the write', [null]);
  }
}

/**
 * Builds the frozen plan for one site. `source` is loadSitePermissionsSource(); `live`
 * is the site's permissions read now (readLiveSitePermissions), in the same form.
 * `testTenantRefs` lists the test tenants, where only a KEEL-RT- site is planned.
 */
export function planSitePermissionsRestore({ source, live, tenantHost, siteId, tenantRef, testTenantRefs }) {
  if (typeof source?.ref !== 'string' || !source.value) throw new TypeError('a site permissions restore needs a stored site/permissions backup');
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) throw new Error('--tenant-host must be the tenant\'s SharePoint host');
  if (typeof siteId !== 'string' || siteId.split(',')[0].toLowerCase() !== tenantHost.toLowerCase()) {
    throw new Error('the site is not on this SharePoint tenant');
  }
  const backup = source.value;
  let webUrl;
  try { webUrl = new URL(backup.web?.url); } catch { throw new Error('the backup holds no site URL'); }
  if (webUrl.protocol !== 'https:' || webUrl.hostname.toLowerCase() !== tenantHost.toLowerCase()) {
    throw new Error('the backup was taken from a different SharePoint tenant');
  }
  if (source.siteId !== siteId) throw new Error('the backup is of another site');
  if (normalUrl(live?.web?.url) !== normalUrl(backup.web.url)) throw new Error('the site read now is not the site in the backup');
  // Both the site collection and the site itself must be KEEL-RT- on a test tenant: an
  // admin added on a subsite is an admin of its whole collection.
  const parts = webUrl.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const refused = [parts[1] ?? '', parts.at(-1) ?? ''].flatMap((name) => targetProblems({ tenantRef, names: [name], testTenantRefs }));
  if (refused.length) throw new Error(`${refused.join('; ')}; nothing is planned`);

  const operations = [];
  const manual = [];
  const excluded = [];
  const note = (subject, reason) => manual.push({ subject, reason });
  const key = (...parts) => ['sharepoint', ...parts.map(String)].join(':');

  // Permission levels. Built-in ones exist on every site; only custom ones are written.
  const plannedRoles = new Set();
  const liveRoles = new Map((live.roleDefinitions ?? []).map((definition) => [lc(definition.name), definition]));
  const backupRoles = new Map((backup.roleDefinitions ?? []).map((definition) => [lc(definition.name), definition]));
  const ownLevels = backup.web?.hasUniqueRoleAssignments === true && live.web?.hasUniqueRoleAssignments === true;
  for (const definition of backup.roleDefinitions ?? []) {
    if (definition.hidden === true || definition.roleTypeKind === LIMITED_ACCESS_KIND) continue;
    const subject = `permission level ${definition.name}`;
    const current = liveRoles.get(lc(definition.name));
    if (current) {
      if (!same(current.basePermissions, definition.basePermissions)) note(subject, 'its permissions differ from the backup; KEEL never changes an existing permission level, a person decides');
      continue;
    }
    if (definition.roleTypeKind !== CUSTOM_KIND) { note(subject, 'a built-in permission level is missing; KEEL does not recreate built-in levels'); continue; }
    if (!ownLevels) { note(subject, 'the site uses its parent site\'s permission levels; restore the level there'); continue; }
    if (!definition.name || !definition.basePermissions) { note(subject, 'the backup holds no permissions for it'); continue; }
    operations.push({ operationId: ROLE_DEFINITION_ADD, naturalKey: key('site-role-definition', siteId, lc(definition.name)), subject, roleDefinition: roleDefinitionOf(definition) });
    plannedRoles.add(lc(definition.name));
  }
  for (const definition of live.roleDefinitions ?? []) {
    if (definition.hidden === true || definition.roleTypeKind === LIMITED_ACCESS_KIND || backupRoles.has(lc(definition.name))) continue;
    note(`permission level ${definition.name}`, 'the site has a permission level the backup does not; KEEL never removes one');
  }

  // Groups, then their members. Groups are matched by name: a re-created group gets a new id.
  const plannedGroups = new Set();
  const liveGroups = new Map((live.groups ?? []).map((group) => [lc(group.title), group]));
  const backupGroups = new Set((backup.groups ?? []).map((group) => lc(group.title)));
  for (const group of backup.groups ?? []) {
    const subject = `group ${group.title ?? group.id}`;
    if (isSystemGroup(group.title)) { excluded.push({ subject, reason: 'SharePoint makes and removes sharing-link and limited-access groups itself' }); continue; }
    if (!group.title) { note(subject, 'the backup holds a group with no name'); continue; }
    const current = liveGroups.get(lc(group.title));
    if (!current) {
      operations.push({ operationId: GROUP_ADD, naturalKey: key('site-group', siteId, lc(group.title)), subject, group: { title: group.title, ...groupSettings(group) } });
      plannedGroups.add(lc(group.title));
      if (group.ownerTitle) note(subject, `its owner was ${group.ownerTitle}; KEEL creates the group, a person sets its owner back`);
    } else if (!same(groupSettings(current), groupSettings(group))) {
      note(subject, 'its settings differ from the backup; KEEL never changes an existing group, a person decides');
    }
    if (!Array.isArray(group.members)) { note(`members of ${group.title}`, 'the backup could not read them, so there are none to put back'); continue; }
    const liveMembers = new Set((current?.members ?? []).map((member) => lc(member.loginName)));
    const backupMembers = new Set();
    for (const member of group.members) {
      if (isSystemPrincipal(member)) continue;
      const who = `${principalLabel(member)} in ${group.title}`;
      if (!member.loginName) { note(who, 'the backup holds no sign-in name for this member'); continue; }
      backupMembers.add(lc(member.loginName));
      if (liveMembers.has(lc(member.loginName))) continue;
      if (APP_PRINCIPAL.test(member.loginName)) { note(who, 'an app principal; a person adds it back'); continue; }
      operations.push({
        operationId: GROUP_MEMBER_ADD, naturalKey: key('site-group-member', siteId, lc(group.title), lc(member.loginName)), subject: who,
        group: group.title, principal: { loginName: member.loginName, title: member.title ?? null },
      });
    }
    for (const member of current?.members ?? []) {
      if (isSystemPrincipal(member) || backupMembers.has(lc(member.loginName))) continue;
      note(`${principalLabel(member)} in ${group.title}`, 'a member now but not in the backup; KEEL never removes a member');
    }
  }
  for (const group of live.groups ?? []) {
    if (isSystemGroup(group.title) || backupGroups.has(lc(group.title))) continue;
    note(`group ${group.title}`, 'the site has a group the backup does not; KEEL never removes a group');
  }

  // Site collection admins.
  const liveAdmins = new Set((live.siteCollectionAdmins ?? []).map((admin) => lc(admin.loginName)));
  const backupAdmins = new Set();
  for (const admin of backup.siteCollectionAdmins ?? []) {
    if (isSystemPrincipal(admin)) continue;
    const subject = `site collection admin ${principalLabel(admin)}`;
    if (!admin.loginName) { note(subject, 'the backup holds no sign-in name for this admin'); continue; }
    backupAdmins.add(lc(admin.loginName));
    if (liveAdmins.has(lc(admin.loginName))) continue;
    if (APP_PRINCIPAL.test(admin.loginName)) { note(subject, 'an app principal; a person adds it back'); continue; }
    operations.push({ operationId: SITE_ADMIN_ADD, naturalKey: key('site-admin', siteId, lc(admin.loginName)), subject, principal: { loginName: admin.loginName, title: admin.title ?? null } });
  }
  for (const admin of live.siteCollectionAdmins ?? []) {
    if (isSystemPrincipal(admin) || backupAdmins.has(lc(admin.loginName))) continue;
    note(`site collection admin ${principalLabel(admin)}`, 'an admin now but not in the backup; KEEL never removes an admin');
  }

  // Role assignments on the site and on each list with its own permissions.
  const liveScopes = new Map(scopesOf(live).map((scope) => [scope.scope, scope]));
  const backupScopes = scopesOf(backup);
  const groupThere = (title) => liveGroups.has(lc(title)) || plannedGroups.has(lc(title));
  const roleThere = (name) => liveRoles.has(lc(name)) || plannedRoles.has(lc(name));
  for (const scope of backupScopes) {
    const now = liveScopes.get(scope.scope);
    if (scope.scope === 'web' && !scope.unique) {
      if (now?.unique) note('the site', 'it has its own permissions now but inherited them in the backup; KEEL never changes inheritance, a person decides');
      continue;
    }
    if (scope.read || !Array.isArray(scope.assignments)) { note(scope.label, 'the backup could not read its permissions, so there are none to put back'); continue; }
    if (!now || !now.unique) {
      note(scope.label, 'it inherits its permissions now (or is gone) but had its own in the backup; KEEL never breaks inheritance, a person decides');
      continue;
    }
    const held = assignmentPairs(scope.assignments, backup.roleDefinitions);
    const present = assignmentPairs(now.assignments, live.roleDefinitions);
    for (const [pair, { member, role }] of held) {
      if (present.has(pair)) continue;
      const subject = `${role} for ${principalLabel(member)} on ${scope.label}`;
      const group = member.principalType === SHAREPOINT_GROUP;
      if (!group && !member.loginName) { note(subject, 'the backup holds no sign-in name for this principal'); continue; }
      if (!group && APP_PRINCIPAL.test(member.loginName)) { note(subject, 'an app principal; a person grants it back'); continue; }
      if (group && !groupThere(member.title)) { note(subject, `the group ${member.title} is not on the site and is not re-created`); continue; }
      if (!roleThere(role)) { note(subject, `the permission level ${role} is not on the site and is not re-created`); continue; }
      operations.push({
        operationId: ROLE_ASSIGNMENT_ADD, naturalKey: key('site-role-assignment', siteId, scope.scope, principalKey(member), lc(role)), subject,
        scope: scope.scope, ...(scope.listId ? { listId: scope.listId } : {}), role,
        principal: group ? { kind: 'group', title: member.title } : { kind: 'user', loginName: member.loginName, title: member.title ?? null },
      });
    }
    for (const [pair, { member, role }] of present) {
      if (held.has(pair)) continue;
      note(`${role} for ${principalLabel(member)} on ${scope.label}`, 'wider than the backup; KEEL never removes a role assignment, a person decides');
    }
  }
  const backupScopeKeys = new Set(backupScopes.map((scope) => scope.scope));
  for (const scope of liveScopes.values()) {
    if (scope.scope === 'web' || backupScopeKeys.has(scope.scope)) continue;
    note(scope.label, 'it has its own permissions now but not in the backup; KEEL never changes inheritance, a person decides');
  }

  // Write order: levels and groups before the members and role assignments that name them.
  const rank = (operation) => SITE_PERMISSION_WRITE_OPERATIONS.indexOf(operation.operationId);
  operations.sort((a, b) => rank(a) - rank(b));
  for (const operation of operations) {
    if (!withinBackup(operation, backup)) throw new Error(`refusing a write the backup does not hold: ${operation.naturalKey}`);
  }
  const notFixtures = [];
  for (const operation of [...operations]) {
    const problem = sitePermissionFixtureProblem(operation, { tenantRef, testTenantRefs });
    if (!problem) continue;
    notFixtures.push({ naturalKey: operation.naturalKey, reason: `not-a-fixture: ${problem}` });
    operations.splice(operations.indexOf(operation), 1);
  }
  const { effects, refusals: effectRefusals } = classifyContentEffects(operations.map((operation) => ({
    naturalKey: operation.naturalKey,
    resourceType: RESOURCE_TYPE,
    verb: 'create',
    payload: { grantsAccess: GRANTS_ACCESS.has(operation.operationId) },
    live: { state: 'absent' },
  })));
  const refusals = [...effectRefusals, ...notFixtures];

  const plan = {
    workload: SITE_PERMISSIONS_RESTORE,
    tenantHost,
    siteId,
    webUrl: backup.web.url,
    source: { ref: source.ref, storedAt: source.storedAt ?? null, sha256: source.sha256 ?? null },
    operations,
    manual,
    excluded,
    contentEffects: effects,
    refusals,
    liveFingerprint: livePermissionsFingerprint(live),
  };
  plan.digest = sitePermissionsPlanDigest(plan);
  return deepFreeze(plan);
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * The site's `site/permissions` backup from the content store: the item named by `ref`,
 * or else the last one stored at or before `at` (the latest without `at`). Null when
 * the store holds none.
 */
export async function loadSitePermissionsSource({ store, tenantRef, siteId, at = null, ref = null }) {
  const limit = at === null || at === undefined ? Infinity : Date.parse(at);
  if (Number.isNaN(limit)) throw new TypeError('--at must be a date');
  let chosen = null;
  let after = null;
  for (;;) {
    const page = await store.listItems({ container: `site:${siteId}`, tenantRef, workload: SITES_WORKLOAD, after, limit: 1000 });
    for (const item of page) {
      if (item.itemKey !== SITE_PERMISSIONS_ITEM) continue;
      if (ref !== null) { if (item.ref === ref) chosen = item; continue; }
      const when = new Date(item.createdAt).valueOf();
      if (when <= limit && (!chosen || when >= new Date(chosen.createdAt).valueOf())) chosen = item;
    }
    if (page.length < 1000) break;
    after = page[page.length - 1];
  }
  if (!chosen) return null;
  const value = JSON.parse((await readAll(await store.getItem(chosen.ref))).toString('utf8'));
  return { ref: chosen.ref, tenantRef, siteId, storedAt: new Date(chosen.createdAt).toISOString(), sha256: chosen.sha256 ?? null, value };
}

/** Reads one site's permissions now, in the backup's form. A partial read is refused. */
export async function readLiveSitePermissions({ transport, tenantHost, webUrl, sleep }) {
  const reader = createPermissionsReader({ transport, tenantHost, sleep });
  const { value, failed } = await readSitePermissions(reader, webUrl);
  if (failed.length) throw new Error(`${failed.length} permission read(s) failed, first ${failed[0].what}: ${failed[0].error}`);
  return value;
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createSitePermissionsRestoreArtifact(client, { tenantRef, plan, requestedBy, id = randomUUID() }) {
  const keys = plan.operations.map((operation) => operation.naturalKey);
  return createDryRunArtifact(client, {
    id,
    tenantRef,
    snapshotId: null,
    selection: keys.length ? keys : [`site:${plan.siteId}`],
    closureKeys: keys.length ? keys : [`site:${plan.siteId}`],
    targetTenantId: plan.tenantHost,
    collectorConfigPath: CONFIG_PATH,
    targetConfigPath: CONFIG_PATH,
    reconciliationResources: null,
    waves: [],
    patches: [],
    guardRefusals: plan.refusals,
    results: { operations: plan.operations.length, manual: plan.manual.length, excluded: plan.excluded.length },
    currentStateFingerprint: plan.liveFingerprint,
    digest: plan.digest,
    status: plan.refusals.length ? 'refused' : 'completed',
    requestedBy,
    contentEffects: plan.contentEffects,
    workloadRestore: plan,
  });
}

/**
 * Sends one planned write. `ids` maps group names (`groups`) and permission level
 * names (`roles`, lower case) to the site's ids, and is updated with what a create
 * returns; `users` caches the ids ensureuser gives sign-in names. Returns
 * { ok, status, response, reason }. Shared with the live capture
 * (tools/qualification/sharepointSitePermissionsLive.mjs), so the proof sends the
 * same requests a restore does.
 */
export async function sendSitePermissionWrite(transport, { webUrl, operation, ids }) {
  const api = `${String(webUrl).replace(/\/+$/, '')}/_api`;
  const post = (path, body, headers) => transport(`${api}/${path}`, { method: 'POST', ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
  const failed = (response, what) => ({ ok: false, status: response?.status ?? null, response, reason: `${what} (HTTP ${response?.status ?? 'no answer'})` });
  const ok = (response) => response && response.status >= 200 && response.status < 300;
  const idOf = (response) => (Number.isInteger(response?.body?.Id) ? response.body.Id : null);
  const ensure = async (loginName) => {
    if (ids.users.has(lc(loginName))) return { id: ids.users.get(lc(loginName)) };
    const response = await post('web/ensureuser', { logonName: loginName });
    if (!ok(response) || idOf(response) === null) return { error: failed(response, `the site could not resolve ${loginName}`) };
    ids.users.set(lc(loginName), idOf(response));
    return { id: idOf(response) };
  };
  const without = (body) => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null && value !== undefined));

  switch (operation.operationId) {
    case ROLE_DEFINITION_ADD: {
      const { name, description, order, basePermissions } = operation.roleDefinition;
      const response = await post('web/roledefinitions', without({
        Name: name, Description: description, Order: order, BasePermissions: { High: basePermissions.high, Low: basePermissions.low },
      }));
      if (!ok(response)) return failed(response, `the permission level ${name} was not created`);
      if (idOf(response) !== null) ids.roles.set(lc(name), idOf(response));
      return { ok: true, status: response.status, response };
    }
    case GROUP_ADD: {
      const { group } = operation;
      const response = await post('web/sitegroups', without({
        Title: group.title, Description: group.description, AllowMembersEditMembership: group.allowMembersEditMembership,
        AllowRequestToJoinLeave: group.allowRequestToJoinLeave, AutoAcceptRequestToJoinLeave: group.autoAcceptRequestToJoinLeave,
        OnlyAllowMembersViewMembership: group.onlyAllowMembersViewMembership, RequestToJoinLeaveEmailSetting: group.requestToJoinLeaveEmailSetting,
      }));
      if (!ok(response)) return failed(response, `the group ${group.title} was not created`);
      if (idOf(response) !== null) ids.groups.set(lc(group.title), idOf(response));
      return { ok: true, status: response.status, response };
    }
    case GROUP_MEMBER_ADD: {
      const groupId = ids.groups.get(lc(operation.group));
      if (!Number.isInteger(groupId)) return { ok: false, status: null, response: null, reason: `the group ${operation.group} has no id on the site` };
      const response = await post(`web/sitegroups/getbyid(${groupId})/users`, { LoginName: operation.principal.loginName });
      return ok(response) ? { ok: true, status: response.status, response } : failed(response, `${operation.principal.loginName} was not added to ${operation.group}`);
    }
    case SITE_ADMIN_ADD: {
      const user = await ensure(operation.principal.loginName);
      if (user.error) return user.error;
      const response = await post(`web/siteusers/getbyid(${user.id})`, { IsSiteAdmin: true }, { 'X-HTTP-Method': 'MERGE' });
      return ok(response) ? { ok: true, status: response.status, response } : failed(response, `${operation.principal.loginName} was not made a site collection admin`);
    }
    case ROLE_ASSIGNMENT_ADD: {
      let principalId;
      if (operation.principal.kind === 'group') {
        principalId = ids.groups.get(lc(operation.principal.title));
        if (!Number.isInteger(principalId)) return { ok: false, status: null, response: null, reason: `the group ${operation.principal.title} has no id on the site` };
      } else {
        const user = await ensure(operation.principal.loginName);
        if (user.error) return user.error;
        principalId = user.id;
      }
      const roleId = ids.roles.get(lc(operation.role));
      if (!Number.isInteger(roleId)) return { ok: false, status: null, response: null, reason: `the permission level ${operation.role} has no id on the site` };
      if (operation.scope !== 'web' && !GUID.test(operation.listId ?? '')) return { ok: false, status: null, response: null, reason: 'the list has no id' };
      const base = operation.scope === 'web' ? 'web' : `web/lists(guid'${operation.listId}')`;
      const response = await post(`${base}/roleassignments/addroleassignment(principalid=${principalId},roledefid=${roleId})`);
      return ok(response) ? { ok: true, status: response.status, response } : failed(response, `${operation.subject} was not granted`);
    }
    default:
      return { ok: false, status: null, response: null, reason: `${operation.operationId} is not a site permissions write` };
  }
}

/** The ids a write needs, from the site read now. */
export function siteIds(live) {
  return {
    groups: new Map((live.groups ?? []).filter((group) => Number.isInteger(group.id)).map((group) => [lc(group.title), group.id])),
    roles: new Map((live.roleDefinitions ?? []).filter((definition) => Number.isInteger(definition.id)).map((definition) => [lc(definition.name), definition.id])),
    users: new Map(),
  };
}

/**
 * Promotes one approved artifact. `transport(url, init?)` is the Restorer's SharePoint
 * REST transport (sitePermissionsWriteTransport); `store` the content store holding the
 * backup. `qualifications` maps each write operation id to workloadWriteQualification(id, ...).
 * Outcomes: disabled, refused, stale, blocked-content-effect, no-change, failed,
 * verification-failed, verified.
 */
export async function executeSitePermissionsRestore(client, {
  tenantRef, artifactId, tenantHost, transport, store, testTenantRefs, qualifications = {}, actor = null, sleep,
}) {
  const requests = [];
  const counted = async (url, init) => { requests.push({ url, method: init?.method ?? 'GET' }); return transport(url, init); };
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const done = async (result) => {
    const full = { writes: 0, verified: [], ...result, requests };
    await appendEvidence(client, {
      tenantRef,
      kind: SITE_PERMISSIONS_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, workload: SITE_PERMISSIONS_RESTORE, outcome: full.outcome, writes: full.writes, verified: full.verified, reasons: full.reasons },
      actor: actor ?? artifact?.requestedBy ?? 'keel',
    });
    return full;
  };

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== SITE_PERMISSIONS_RESTORE) return done({ outcome: 'refused', reasons: ['no site permissions restore plan with this id'] });
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return done({ outcome: 'refused', reasons: [promotable.reason] });
  if (sitePermissionsPlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest
      || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return done({ outcome: 'refused', reasons: ['the stored plan no longer matches its digest; a new dry run is required'] });
  }
  if (plan.tenantHost !== tenantHost) return done({ outcome: 'refused', reasons: [`the plan targets ${plan.tenantHost}, not ${tenantHost}`] });
  if (plan.operations.some((operation) => !SITE_PERMISSION_WRITE_OPERATIONS.includes(operation.operationId))) {
    return done({ outcome: 'refused', reasons: ['the plan names a write this restore does not make'] });
  }
  if (plan.operations.length === 0) return done({ outcome: 'no-change', reasons: ['the site permissions already hold everything in the backup'] });
  // Qualification first: if any write the plan uses is not qualified, nothing is sent.
  const off = [...new Set(plan.operations.map((operation) => operation.operationId))]
    .filter((id) => qualifications[id]?.operationId !== id || qualifications[id].enabled !== true);
  if (off.length) {
    return done({ outcome: 'disabled', reasons: off.flatMap((id) => (qualifications[id]?.reasons?.length ? qualifications[id].reasons.map((reason) => `${id}: ${reason}`) : [`${id}: no write qualification was supplied`])) });
  }
  try {
    await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
  } catch (error) {
    return done({ outcome: 'blocked-content-effect', reasons: [error.message] });
  }

  // The backup the plan was made from, by its own ref; every write must be in it.
  let source;
  try {
    source = await loadSitePermissionsSource({ store, tenantRef, siteId: plan.siteId, ref: plan.source.ref });
  } catch (error) {
    return done({ outcome: 'failed', reasons: [`could not re-load the backup: ${error.message}`] });
  }
  if (!source) return done({ outcome: 'refused', reasons: ['the backup this plan was made from is not in the content store'] });
  const wider = plan.operations.filter((operation) => !withinBackup(operation, source.value));
  if (wider.length) return done({ outcome: 'refused', reasons: wider.map((operation) => `${operation.naturalKey}: not in the backup`) });

  let live;
  try {
    live = await readLiveSitePermissions({ transport: counted, tenantHost, webUrl: plan.webUrl, sleep });
  } catch (error) {
    return done({ outcome: 'failed', reasons: [`could not re-read the site permissions before writing: ${error.message}`] });
  }
  if (livePermissionsFingerprint(live) !== plan.liveFingerprint) {
    return done({ outcome: 'stale', reasons: ['the site permissions changed since the dry run; a new dry run is required'] });
  }
  // The stored plan must be exactly what the backup and the site give now: an edited
  // plan never reaches SharePoint, even with a recomputed digest.
  const replan = (state) => planSitePermissionsRestore({ source, live: state, tenantHost, siteId: plan.siteId, tenantRef, testTenantRefs });
  let replanned = null;
  try { replanned = replan(live); } catch { replanned = null; }
  if (replanned?.digest !== plan.digest) {
    return done({ outcome: 'refused', reasons: ['the stored plan is not what the backup gives; a new dry run is required'] });
  }

  const ids = siteIds(live);
  let writes = 0;
  for (const operation of plan.operations) {
    const notFixture = sitePermissionFixtureProblem(operation, { tenantRef, testTenantRefs });
    if (notFixture) return done({ outcome: 'refused', writes, reasons: [notFixture] });
    const before = requests.length;
    const result = await sendSitePermissionWrite(counted, { webUrl: plan.webUrl, operation, ids });
    writes += requests.length - before;
    if (!result.ok) {
      const locked = result.response && isPreservationLockFailure(result.response);
      return done({
        outcome: locked ? 'refused' : 'failed',
        writes,
        reasons: [locked
          ? `${operation.naturalKey}: the platform refused the change under a preservation lock; KEEL does not retry or work around it`
          : `${operation.naturalKey}: ${result.reason}; nothing is retried automatically`],
      });
    }
  }

  let after;
  try {
    after = await readLiveSitePermissions({ transport: counted, tenantHost, webUrl: plan.webUrl, sleep });
  } catch (error) {
    return done({ outcome: 'verification-failed', writes, reasons: [`the permissions were written but could not be read back: ${error.message}`] });
  }
  // Read back: a write shows when a new plan from the same backup no longer needs it.
  let remaining;
  try { remaining = new Set(replan(after).operations.map((operation) => operation.naturalKey)); } catch (error) {
    return done({ outcome: 'verification-failed', writes, reasons: [`the site could not be compared with the backup after writing: ${error.message}`] });
  }
  const verified = [];
  const reasons = [];
  for (const operation of plan.operations) {
    if (remaining.has(operation.naturalKey)) reasons.push(`${operation.naturalKey} did not read back as written`);
    else verified.push(operation.naturalKey);
  }
  return done({ outcome: reasons.length ? 'verification-failed' : 'verified', writes, verified, reasons });
}
