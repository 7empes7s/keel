/**
 * Gap 4: the gate for the live proof of the five site permission writes
 * (permission level, group, group member, site collection admin and role assignment).
 * A record holds one capture by tools/qualification/sharepointSitePermissionsLive.mjs on
 * a KEEL-RT- site: it creates a KEEL-RT- permission level and group, adds a KEEL-RT- test
 * user to the group and as a site collection admin, grants the group the level on the
 * site (and on one list when one is named), and reads each back through SharePoint REST.
 *
 * It never sends a request and never enables anything. A verified record is turned into
 * ledger evidence only by sharepointSitePermissionsLive.mjs.
 */
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { WRITE_PATHS } from '../../engine/restore/workloads/sharepointRest.mjs';
import { PERMISSION_API_PATHS } from '../../engine/content/sharepointSites.mjs';
import { FIXTURE_SITE_PREFIX, captureTimeProblems, secretProblems } from './sharepointAcceptance.mjs';

export const SITE_PERMISSIONS_LIVE_GATE = 'sharepoint-site-permissions-live-acceptance';
export const SITE_PERMISSIONS_LIVE_OPERATION = 'sharepoint.site-permissions-qualification';
export const SITE_PERMISSIONS_LIVE_CREDENTIAL_MODE = 'collector-read+restorer-write';
export const SITE_PERMISSIONS_RECORD_FILE = `${SITE_PERMISSIONS_LIVE_GATE}.json`;
// The five writes (engine/restore/workloads/sharepointSitePermissions.mjs), written out
// here because the release gate table loads this module before the restore module.
const ROLE_DEFINITION_ADD = 'sharepoint.site-role-definitions.add';
const GROUP_ADD = 'sharepoint.site-groups.add';
const GROUP_MEMBER_ADD = 'sharepoint.site-group-members.add';
const SITE_ADMIN_ADD = 'sharepoint.site-admins.add';
const ROLE_ASSIGNMENT_ADD = 'sharepoint.site-role-assignments.add';
export const SITE_PERMISSIONS_LIVE_WRITES = Object.freeze([ROLE_DEFINITION_ADD, GROUP_ADD, GROUP_MEMBER_ADD, SITE_ADMIN_ADD, ROLE_ASSIGNMENT_ADD]);
export const FIXTURE_PREFIX = 'KEEL-RT-';
// How many requests of each write a capture sends: one of each, and one role
// assignment per scope (the site, and the list when one was named).
const EXPECTED = Object.freeze({ roledefinitions: 1, sitegroups: 1, members: 1, admin: 1 });

/** True when a sign-in name names a KEEL-RT- test user (claims or plain). */
export function isFixtureLogin(loginName) {
  const name = String(loginName ?? '').split('|').pop().split('@')[0];
  return name.toLowerCase().startsWith(FIXTURE_PREFIX.toLowerCase());
}

export function requiredDocumentation() {
  return [...new Set(SITE_PERMISSIONS_LIVE_WRITES.map((id) => WORKLOAD_WRITE_OPERATIONS[id]?.source).filter(Boolean))];
}

export function requiredGrants() {
  const restorer = new Set(SITE_PERMISSIONS_LIVE_WRITES.flatMap((id) => WORKLOAD_WRITE_OPERATIONS[id]?.rbac?.permissions ?? []));
  // Reading role assignments needs the same SharePoint permission (engine/content/sharepointSites.mjs).
  return { collector: { permissions: ['Sites.FullControl.All'], roles: [] }, restorer: { permissions: [...restorer].sort(), roles: [] } };
}

const missing = (held, needed) => needed.filter((item) => !(Array.isArray(held) ? held : []).includes(item));

function requestProblems(requests, { sitePath, scopes }) {
  if (!Array.isArray(requests) || requests.length === 0) return ['no request log recorded'];
  const failures = [];
  const counts = { roledefinitions: 0, sitegroups: 0, members: 0, admin: 0, roles: 0, ensure: 0 };
  const prefix = `${sitePath.toLowerCase()}/_api/`;
  for (const [index, request] of requests.entries()) {
    const label = `request ${index} (${request?.method ?? '?'} ${request?.path ?? '?'})`;
    if (!['collector', 'restorer'].includes(request?.credential)) { failures.push(`${label}: unknown credential`); continue; }
    if (typeof request.path !== 'string') { failures.push(`${label}: no path`); continue; }
    const [pathOnly, query = ''] = request.path.split('?');
    const path = decodeURIComponent(pathOnly).toLowerCase();
    if (!path.startsWith(prefix)) { failures.push(`${label}: addresses something other than the KEEL-RT fixture site's REST API`); continue; }
    const api = path.slice(prefix.length);
    if (request.method === 'GET') {
      if (!PERMISSION_API_PATHS.some((pattern) => pattern.test(api))) failures.push(`${label}: not a site permissions read`);
      continue;
    }
    if (request.credential !== 'restorer' || request.method !== 'POST' || query) { failures.push(`${label}: only the restorer writes, with POST and no query`); continue; }
    const write = WRITE_PATHS.find((entry) => entry.pattern.test(api));
    if (!write) { failures.push(`${label}: not an allowed write`); continue; }
    if (api === 'web/roledefinitions') counts.roledefinitions += 1;
    else if (api === 'web/sitegroups') counts.sitegroups += 1;
    else if (api === 'web/ensureuser') counts.ensure += 1;
    else if (/\/users$/.test(api)) counts.members += 1;
    else if (/^web\/siteusers\//.test(api)) counts.admin += 1;
    else counts.roles += 1;
  }
  for (const [kind, expected] of Object.entries(EXPECTED)) {
    if (counts[kind] !== expected) failures.push(`expected exactly ${expected} ${kind} write, found ${counts[kind]}`);
  }
  if (counts.roles !== scopes) failures.push(`expected exactly ${scopes} role assignment write(s), found ${counts.roles}`);
  if (counts.ensure > 1) failures.push(`expected at most 1 ensureuser, found ${counts.ensure}`);
  return failures;
}

/** Gate validator. Returns failure reasons; empty means the subject holds. */
export function validateSitePermissionsLiveSubject(evidence, { tenantRef, build } = {}) {
  const failures = [];
  if (!tenantRef || !build) failures.push('site permissions expected tenant/build identity required');
  if (build && evidence.build !== build) failures.push(`site permissions build mismatch: evidence is '${evidence.build}', required '${build}'`);
  if (evidence.operation !== SITE_PERMISSIONS_LIVE_OPERATION) failures.push(`site permissions operation mismatch: expected '${SITE_PERMISSIONS_LIVE_OPERATION}'`);
  if (evidence.credentialMode !== SITE_PERMISSIONS_LIVE_CREDENTIAL_MODE) failures.push(`site permissions capture requires credential mode '${SITE_PERMISSIONS_LIVE_CREDENTIAL_MODE}'`);
  failures.push(...secretProblems(evidence));
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  const observedAt = Date.parse(evidence.observedAt ?? '');

  const credentials = subject.credentials ?? {};
  for (const role of ['collector', 'restorer']) {
    if (typeof credentials[role] !== 'string' || !credentials[role].trim()) failures.push(`no ${role} credential reference`);
  }
  if (credentials.collector && credentials.collector === credentials.restorer) failures.push('collector and restorer must be separate credentials');
  const needed = requiredGrants();
  for (const role of ['collector', 'restorer']) {
    for (const permission of missing(subject.grants?.[role]?.permissions, needed[role].permissions)) failures.push(`missing prerequisite: ${role} lacks ${permission}`);
  }

  let sitePath = '';
  if (typeof subject.tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(subject.tenantHost)) failures.push('no SharePoint tenant host');
  try {
    const url = new URL(subject.fixtureSite?.webUrl);
    if (url.hostname.toLowerCase() !== String(subject.tenantHost).toLowerCase()) failures.push('the fixture site is not on the tenant host');
    sitePath = url.pathname.replace(/\/+$/, '');
  } catch { failures.push('no fixture site URL'); }
  const parts = sitePath.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'sites' || !decodeURIComponent(parts[1]).startsWith(FIXTURE_SITE_PREFIX)) {
    failures.push(`the fixture site is not a disposable /sites/${FIXTURE_SITE_PREFIX}* site`);
  }
  const fixture = subject.fixture ?? {};
  if (!String(fixture.level ?? '').startsWith(FIXTURE_PREFIX)) failures.push(`the permission level is not a ${FIXTURE_PREFIX}* test level`);
  if (!String(fixture.group ?? '').startsWith(FIXTURE_PREFIX)) failures.push(`the group is not a ${FIXTURE_PREFIX}* test group`);
  if (!isFixtureLogin(fixture.member)) failures.push(`the user added is not a ${FIXTURE_PREFIX}* test user`);
  const scopes = 1 + (fixture.listId ? 1 : 0);

  const writes = Array.isArray(subject.writes) ? subject.writes : [];
  for (const id of SITE_PERMISSIONS_LIVE_WRITES) {
    const capture = writes.find((item) => item?.operationId === id);
    if (!capture) { failures.push(`missing prerequisite: no live capture of ${id}`); continue; }
    if (capture.synthetic !== false) failures.push(`${id}: synthetic or unlabelled capture`);
    if (capture.version !== WORKLOAD_WRITE_OPERATIONS[id]?.version) failures.push(`${id}: not captured at the declared version`);
    if (capture.ok !== true) failures.push(`${id}: the write failed`);
    if (capture.readBackVerified !== true) failures.push(`${id}: the write was not read back as written`);
    if (id === ROLE_ASSIGNMENT_ADD && capture.scopes !== scopes) failures.push(`${id}: not proven on every scope named (${capture.scopes ?? 0} of ${scopes})`);
    failures.push(...captureTimeProblems(id, capture.capturedAt, observedAt));
  }
  for (const [id, key] of [[ROLE_DEFINITION_ADD, 'level'], [GROUP_ADD, 'group'], [GROUP_MEMBER_ADD, 'member'], [SITE_ADMIN_ADD, 'member']]) {
    const capture = writes.find((item) => item?.operationId === id);
    if (capture && capture.subject !== fixture[key]) failures.push(`${id}: wrote ${capture.subject ?? 'nothing named'}, not the fixture ${key}`);
  }

  if (typeof subject.captureLogSha256 !== 'string' || subject.captureLogSha256 !== evidence.proof?.artifact?.sha256) {
    failures.push('the capture log digest is not bound to the signed subject');
  }
  if (sitePath) failures.push(...requestProblems(subject.requests, { sitePath, scopes }));
  if (!Number.isInteger(subject.throttle?.retryAfterResponses) || subject.throttle.retryAfterResponses < 0) failures.push('throttle behaviour not recorded');
  const docs = Array.isArray(subject.documentation) ? subject.documentation : [];
  for (const url of requiredDocumentation()) {
    const entry = docs.find((item) => item?.url === url);
    if (!entry || Number.isNaN(Date.parse(entry.retrievedAt ?? ''))) failures.push(`documentation not retrieved: ${url}`);
  }
  return failures;
}
