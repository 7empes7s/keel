#!/usr/bin/env node
/**
 * Gap 4: capture the live proof the five site permission writes need before they may
 * run. The operator runs this against the test tenant; builders and CI never point it
 * at a tenant.
 *
 *   node tools/qualification/sharepointSitePermissionsLive.mjs plan \
 *        --tenant-host contoso.sharepoint.com --fixture-site-url https://contoso.sharepoint.com/sites/KEEL-RT-... \
 *        --label KEEL-RT-perm-1 --member 'i:0#.f|membership|keel-rt-user@contoso.onmicrosoft.com' --list-id <guid>
 *     Offline (the default). Prints every request a capture would send. No network.
 *
 *   KEEL_SPO_COLLECTOR_TOKEN=... KEEL_SPO_RESTORER_TOKEN=... [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/sharepointSitePermissionsLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --tenant-host contoso.sharepoint.com \
 *        --fixture-site-url https://contoso.sharepoint.com/sites/KEEL-RT-... \
 *        --label KEEL-RT-perm-1 --member <claims sign-in name of a KEEL-RT- test user> --list-id <guid> \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --grants grants.json --docs docs.json \
 *        --out docs/release/qualifications/sharepoint-site-permissions-live-acceptance.json [--build <sha>]
 *
 * The two tokens are SharePoint tokens (audience https://<tenant host>), not Graph ones:
 * the Collector's for the reads, the Restorer's for the writes.
 *
 * What a capture does, in order (and nothing else):
 *  1. collector: reads the fixture site's permissions (the backup's own reads). If the
 *     site inherits its permissions, if `<label> level` or `<label> group` already
 *     exists, or if the test user is already a site collection admin, nothing is
 *     written: clean up by hand and rerun.
 *  2. restorer, with the restore's own request builder (sendSitePermissionWrite):
 *     creates the permission level `<label> level` with the site's Read permissions,
 *     creates the group `<label> group`, adds the test user to it, makes the test user a
 *     site collection admin, and grants the group the new level on the site and on the
 *     list named by --list-id, which must have its own permissions.
 *  3. collector: reads the site's permissions back until every write shows.
 * Nothing is removed afterwards (KEEL never removes a grant); the fixture stays on the
 * KEEL-RT- site for the restore round trip, and a person cleans it up by hand.
 *
 * Tokens come from the environment and are never written. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`.
 * ledgerEvidenceFromSitePermissionsAcceptance() is the import seam: a record that
 * passes `verify --require-live` becomes one live write capture per write.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import {
  GROUP_ADD, GROUP_MEMBER_ADD, ROLE_ASSIGNMENT_ADD, ROLE_DEFINITION_ADD, SITE_ADMIN_ADD, principalKey, readLiveSitePermissions,
  sendSitePermissionWrite, siteIds,
} from '../../engine/restore/workloads/sharepointSitePermissions.mjs';
import { QUALIFICATION_CONTRACT_VERSION, verifyEvidence } from '../release/qualification.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { fixtureSiteProblems, writeAcceptanceFiles } from './sharepointLive.mjs';
import {
  FIXTURE_PREFIX, SITE_PERMISSIONS_LIVE_CREDENTIAL_MODE, SITE_PERMISSIONS_LIVE_GATE, SITE_PERMISSIONS_LIVE_OPERATION, isFixtureLogin,
} from './sharepointSitePermissionsAcceptance.mjs';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const lc = (value) => String(value ?? '').toLowerCase();
const READ_ROLE_KIND = 2;

function problems({ tenantHost, fixtureSiteUrl, label, member, listId }) {
  const found = fixtureSiteProblems({ tenantHost, fixtureSiteUrl });
  if (!/^KEEL-RT-[A-Za-z0-9-]{1,40}$/.test(String(label ?? ''))) found.push(`--label must be ${FIXTURE_PREFIX}<letters, digits or dashes>: it names the test level and group`);
  if (!isFixtureLogin(member) || !String(member).includes('|')) found.push(`--member must be the claims sign-in name of a ${FIXTURE_PREFIX}* test user (i:0#.f|membership|keel-rt-...)`);
  // Role assignments are restored on lists too, so the proof must cover a list.
  if (!GUID_RE.test(String(listId ?? ''))) found.push('--list-id must be the id (a GUID) of a list with its own permissions: the role assignment is proven on the site and on that list');
  return found;
}

/** The fixture a capture writes, named from the label. */
export function captureFixture({ label, member, listId }) {
  return { level: `${label} level`, group: `${label} group`, member, ...(listId ? { listId: lc(listId) } : {}) };
}

/** The planned writes of a capture, in the restore's own shape. */
function captureOperations({ fixture, readPermissions, description }) {
  const group = {
    title: fixture.group, description, allowMembersEditMembership: false, allowRequestToJoinLeave: false,
    autoAcceptRequestToJoinLeave: false, onlyAllowMembersViewMembership: true, requestToJoinLeaveEmailSetting: null,
  };
  const assignment = (scope) => ({
    operationId: ROLE_ASSIGNMENT_ADD, subject: `${fixture.level} for ${fixture.group}`, scope: scope ? `list:${scope}` : 'web',
    ...(scope ? { listId: scope } : {}), role: fixture.level, principal: { kind: 'group', title: fixture.group },
  });
  return [
    { operationId: ROLE_DEFINITION_ADD, subject: fixture.level, roleDefinition: { name: fixture.level, description, order: 250, basePermissions: readPermissions } },
    { operationId: GROUP_ADD, subject: fixture.group, group },
    { operationId: GROUP_MEMBER_ADD, subject: fixture.member, group: fixture.group, principal: { loginName: fixture.member, title: null } },
    { operationId: SITE_ADMIN_ADD, subject: fixture.member, principal: { loginName: fixture.member, title: null } },
    assignment(null),
    ...(fixture.listId ? [assignment(fixture.listId)] : []),
  ];
}

/** Offline: the requests a capture would send, in order. */
export function sitePermissionsCapturePlan(options) {
  const found = problems(options);
  if (found.length) throw new Error(found.join('; '));
  const fixture = captureFixture(options);
  const site = '{fixture site}/_api';
  const steps = [
    { step: 1, credential: 'collector', method: 'GET', path: `${site}/web, roledefinitions, sitegroups (+ users), siteusers (admins), roleassignments, lists (+ roleassignments)` },
    { step: 2, credential: 'restorer', method: 'POST', path: `${site}/web/roledefinitions { Name: ${fixture.level}, the site's Read permissions }`, operationId: ROLE_DEFINITION_ADD },
    { step: 2, credential: 'restorer', method: 'POST', path: `${site}/web/sitegroups { Title: ${fixture.group} }`, operationId: GROUP_ADD },
    { step: 2, credential: 'restorer', method: 'POST', path: `${site}/web/sitegroups/getbyid({new group})/users { LoginName: ${fixture.member} }`, operationId: GROUP_MEMBER_ADD },
    { step: 2, credential: 'restorer', method: 'POST', path: `${site}/web/ensureuser { logonName: ${fixture.member} }`, operationId: SITE_ADMIN_ADD },
    { step: 2, credential: 'restorer', method: 'POST (MERGE)', path: `${site}/web/siteusers/getbyid({user}) { IsSiteAdmin: true }`, operationId: SITE_ADMIN_ADD },
    { step: 2, credential: 'restorer', method: 'POST', path: `${site}/web/roleassignments/addroleassignment(principalid={new group},roledefid={new level})`, operationId: ROLE_ASSIGNMENT_ADD },
  ];
  if (fixture.listId) {
    steps.push({ step: 2, credential: 'restorer', method: 'POST', path: `${site}/web/lists(guid'${fixture.listId}')/roleassignments/addroleassignment(principalid={new group},roledefid={new level})`, operationId: ROLE_ASSIGNMENT_ADD });
  }
  steps.push({ step: 3, credential: 'collector', method: 'GET', path: `${site} (the reads of step 1, until every write shows)` });
  return steps;
}

/** Whether one capture write shows in the site's permissions read now. */
function shows(operation, value) {
  const group = (value.groups ?? []).find((item) => lc(item.title) === lc(operation.group?.title ?? operation.group ?? operation.principal?.title));
  switch (operation.operationId) {
    case ROLE_DEFINITION_ADD: {
      const level = (value.roleDefinitions ?? []).find((item) => lc(item.name) === lc(operation.roleDefinition.name));
      return Boolean(level && level.basePermissions?.high === operation.roleDefinition.basePermissions.high && level.basePermissions?.low === operation.roleDefinition.basePermissions.low);
    }
    case GROUP_ADD: return Boolean(group);
    case GROUP_MEMBER_ADD: return Boolean(group?.members?.some((member) => lc(member.loginName) === lc(operation.principal.loginName)));
    case SITE_ADMIN_ADD: return (value.siteCollectionAdmins ?? []).some((admin) => lc(admin.loginName) === lc(operation.principal.loginName));
    case ROLE_ASSIGNMENT_ADD: {
      const rows = operation.scope === 'web' ? value.roleAssignments : (value.lists ?? []).find((list) => list.id === operation.listId)?.roleAssignments;
      return (rows ?? []).some((row) => principalKey(row.member) === `group:${lc(operation.principal.title)}`
        && row.roles.some((role) => lc(role.name) === lc(operation.role)));
    }
    default: return false;
  }
}

/**
 * Runs a capture against two injected SharePoint REST transports (collector, restorer).
 * Returns the unsigned record and the capture log, pseudonymized; it never signs or
 * writes files.
 */
export async function captureSitePermissionsAcceptance({
  collector, restorer, tenantHost, fixtureSiteUrl, label, member, listId, tenantRef, build, credentials, grants, documentation = [],
  now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), readBackAttempts = 5, readBackDelayMs = 3000,
}) {
  const found = problems({ tenantHost, fixtureSiteUrl, label, member, listId });
  if (found.length) throw new Error(found.join('; '));
  if (!tenantRef || !build) throw new Error('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) {
    throw new Error('a capture needs two separate credential references (collector, restorer)');
  }
  const fixture = captureFixture({ label, member, listId });
  const webUrl = String(fixtureSiteUrl).replace(/\/+$/, '');

  const requests = [];
  const log = { requests, values: {} };
  let retryAfterResponses = 0;
  const logged = (credential, transport) => async (url, init) => {
    const parsed = new URL(url);
    const response = await transport(url, init);
    if (response.status === 429 || response.status === 503) retryAfterResponses += 1;
    requests.push({ credential, method: init?.method ?? 'GET', path: `${parsed.pathname}${parsed.search}`, status: response.status, at: now().toISOString() });
    return response;
  };
  const asCollector = logged('collector', collector);
  const asRestorer = logged('restorer', restorer);
  const read = () => readLiveSitePermissions({ transport: asCollector, tenantHost, webUrl, sleep });

  const writes = [ROLE_DEFINITION_ADD, GROUP_ADD, GROUP_MEMBER_ADD, SITE_ADMIN_ADD, ROLE_ASSIGNMENT_ADD].map((operationId) => ({
    operationId, version: WORKLOAD_WRITE_OPERATIONS[operationId].version, synthetic: false, ok: false, readBackVerified: false,
    subject: { [ROLE_DEFINITION_ADD]: fixture.level, [GROUP_ADD]: fixture.group, [GROUP_MEMBER_ADD]: fixture.member, [SITE_ADMIN_ADD]: fixture.member }[operationId] ?? null,
    ...(operationId === ROLE_ASSIGNMENT_ADD ? { scopes: 0 } : {}),
  }));
  const captureOf = (operationId) => writes.find((item) => item.operationId === operationId);
  let error = null;
  let before = null;
  try { before = await read(); } catch (thrown) { error = `reading the fixture site failed; nothing was written: ${thrown.message}`; }
  const readLevel = before?.roleDefinitions?.find((item) => item.roleTypeKind === READ_ROLE_KIND && item.basePermissions);
  if (!error && before.web?.hasUniqueRoleAssignments !== true) error = 'the fixture site inherits its permissions; nothing was written';
  else if (!error && !readLevel) error = 'the fixture site has no Read permission level to copy; nothing was written';
  else if (!error && before.roleDefinitions.some((item) => lc(item.name) === lc(fixture.level))) error = `${fixture.level} already exists; remove it by hand or use another --label (nothing was written)`;
  else if (!error && before.groups.some((item) => lc(item.title) === lc(fixture.group))) error = `${fixture.group} already exists; remove it by hand or use another --label (nothing was written)`;
  else if (!error && before.siteCollectionAdmins.some((admin) => lc(admin.loginName) === lc(fixture.member))) error = 'the test user is already a site collection admin; remove that by hand and rerun (nothing was written)';
  else if (!error && fixture.listId && !before.lists.some((list) => list.id === fixture.listId && Array.isArray(list.roleAssignments))) error = 'the list named does not have its own permissions on the fixture site; nothing was written';

  if (!error) {
    const operations = captureOperations({ fixture, readPermissions: readLevel.basePermissions, description: 'KEEL live proof fixture; safe to delete' });
    const ids = siteIds(before);
    for (const operation of operations) {
      const capture = captureOf(operation.operationId);
      let result;
      try { result = await sendSitePermissionWrite(asRestorer, { webUrl, operation, ids }); } catch (thrown) { result = { ok: false, reason: thrown.message }; }
      capture.capturedAt = now().toISOString();
      if (!result.ok) { capture.error = result.reason; error = `${operation.operationId}: ${result.reason}; nothing more was written`; break; }
      if (operation.operationId === ROLE_ASSIGNMENT_ADD) capture.scopes += 1;
      capture.ok = true;
    }
    // Read back until every write that was sent shows.
    const sent = operations.filter((operation) => captureOf(operation.operationId).ok);
    for (let attempt = 0; attempt < readBackAttempts && sent.length; attempt += 1) {
      if (attempt) await sleep(readBackDelayMs);
      let value;
      try { value = await read(); } catch { continue; }
      const missing = sent.filter((operation) => !shows(operation, value));
      for (const capture of writes) {
        if (!capture.ok) continue;
        capture.readBackVerified = !missing.some((operation) => operation.operationId === capture.operationId);
      }
      if (missing.length === 0) break;
    }
  }
  for (const capture of writes) {
    capture.capturedAt ??= now().toISOString();
    if (error && !capture.ok) capture.error ??= error;
  }
  log.values.written = writes.filter((capture) => capture.ok).map((capture) => capture.operationId);

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: SITE_PERMISSIONS_LIVE_GATE,
    tenantRef,
    build,
    operation: SITE_PERMISSIONS_LIVE_OPERATION,
    credentialMode: SITE_PERMISSIONS_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      tenantHost,
      fixtureSite: { webUrl },
      fixture,
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      writes,
      requests: requests.map(({ at, ...request }) => request),
      throttle: { retryAfterResponses },
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return pseudonymizeCapture({ record, log });
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one live
 * write capture per proven write, and the two identities' grants. It carries no read
 * evidence: the read-back gate is the ledger's own site permissions read.
 */
export function ledgerEvidenceFromSitePermissionsAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: SITE_PERMISSIONS_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${SITE_PERMISSIONS_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: [],
    writes: subject.writes.map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: { permissions: [...subject.grants.collector.permissions], roles: [...(subject.grants.collector.roles ?? [])] },
    restorerGrants: { permissions: [...subject.grants.restorer.permissions], roles: [...(subject.grants.restorer.roles ?? [])] },
  };
}

/** A SharePoint REST transport with a fixed token, for the capture only. */
export function sharePointBearerTransport(token, fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json;odata=nometadata', ...(init?.headers ?? {}) };
    if (init?.body !== undefined) headers['content-type'] = 'application/json;odata=nometadata';
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET', redirect: 'error', headers, body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--tenant-host': 'tenantHost', '--fixture-site-url': 'fixtureSiteUrl', '--label': 'label', '--member': 'member',
    '--list-id': 'listId', '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef', '--grants': 'grants', '--docs': 'docs',
    '--out': 'out', '--build': 'build',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, transportFor = sharePointBearerTransport, readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(sitePermissionsCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: sharepointSitePermissionsLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(sitePermissionsCapturePlan(options), null, 2));
    out(`refused: a capture adds a ${FIXTURE_PREFIX} level, group and admin on a ${FIXTURE_PREFIX} site; rerun with --confirm-live-tenant-write`);
    return 2;
  }
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'], ['--grants', 'grants'], ['--docs', 'docs'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (!env.KEEL_SPO_COLLECTOR_TOKEN || !env.KEEL_SPO_RESTORER_TOKEN) {
    throw new Error('capture needs KEEL_SPO_COLLECTOR_TOKEN and KEEL_SPO_RESTORER_TOKEN (SharePoint tokens for the tenant host) in the environment');
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const { record, captureLog } = await captureSitePermissionsAcceptance({
    collector: transportFor(env.KEEL_SPO_COLLECTOR_TOKEN),
    restorer: transportFor(env.KEEL_SPO_RESTORER_TOKEN),
    tenantHost: options.tenantHost,
    fixtureSiteUrl: options.fixtureSiteUrl,
    label: options.label,
    member: options.member,
    listId: options.listId,
    tenantRef: options.tenantRef,
    build,
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    documentation: JSON.parse(readFile(options.docs)),
  });
  const outPath = resolve(options.out);
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: SITE_PERMISSIONS_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  out(JSON.stringify({ evidence: outPath, captureLog: logPath, writes: record.subject.writes, verify: result }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
