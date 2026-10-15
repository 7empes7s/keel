#!/usr/bin/env node
/**
 * Gap 5: capture the live proof the two site app grant writes need before they
 * may run (sharepoint.site-permissions.add and .update). The operator runs this
 * against the test tenant; builders and CI never point it at a tenant.
 *
 *   node tools/qualification/sharepointSiteGrantsLive.mjs plan \
 *        --tenant-host contoso.sharepoint.com --fixture-site-url https://contoso.sharepoint.com/sites/KEEL-RT-...
 *     Offline (the default). Prints every request a capture would send. No network.
 *
 *   KEEL_SP_COLLECTOR_TOKEN=... KEEL_SP_RESTORER_TOKEN=... [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/sharepointSiteGrantsLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --tenant-host contoso.sharepoint.com \
 *        --fixture-site-url https://contoso.sharepoint.com/sites/KEEL-RT-... \
 *        --app-id <guid> --app-name KEEL-RT-<name> \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --grants grants.json --docs docs.json \
 *        --out docs/release/qualifications/sharepoint-site-grants-live-acceptance.json [--build <sha>]
 *
 * What a capture does, in order (and nothing else):
 *  1. collector: GET /sites/getAllSites (all pages; only the count is kept), to find
 *     the KEEL-RT- fixture site;
 *  2. collector: GET /sites/{fixture}/permissions. If the KEEL-RT- application
 *     already holds a grant there, nothing is written: remove it by hand and rerun;
 *  3. restorer: POST /sites/{fixture}/permissions granting that application `read`,
 *     then reads the grants back until it shows;
 *  4. restorer: PATCH that grant to `write`, then reads back until it shows.
 * The grant stays on the fixture site afterwards (KEEL never deletes a grant); the
 * live round trip uses it as its backup. No other site and no file, list, page or
 * message endpoint is ever requested.
 *
 * Tokens come from the environment and are never written. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`.
 * ledgerEvidenceFromSiteGrantsAcceptance() is the import seam: a record that
 * passes `verify --require-live` becomes one live write capture per write.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SITE_FIELDS, siteInScope } from '../../engine/collect/workloads/sharepoint.mjs';
import { readGraphConfiguration } from '../../engine/collect/workloadContract.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { SITE_GRANT_ADD, SITE_GRANT_UPDATE, grantAppKey } from '../../engine/restore/workloads/sharepointSiteGrants.mjs';
import { siteRoleRank } from '../../engine/safety/contentEffects.mjs';
import { QUALIFICATION_CONTRACT_VERSION, verifyEvidence } from '../release/qualification.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { FIXTURE_SITE_PREFIX, readDescriptor } from './sharepointAcceptance.mjs';
import { bearerTransport, fixtureSiteProblems, writeAcceptanceFiles } from './sharepointLive.mjs';
import {
  FIXTURE_APP_PREFIX, SITE_GRANTS_CAPTURE_ROLES, SITE_GRANTS_LIVE_CREDENTIAL_MODE, SITE_GRANTS_LIVE_GATE, SITE_GRANTS_LIVE_OPERATION,
} from './sharepointSiteGrantsAcceptance.mjs';

const GRAPH = 'https://graph.microsoft.com';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalise = SITE_FIELDS.appPermissionGrants[1];
const normalUrl = (url) => String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

function problems({ tenantHost, fixtureSiteUrl, appId, appName }) {
  const found = fixtureSiteProblems({ tenantHost, fixtureSiteUrl });
  if (!GUID_RE.test(String(appId ?? ''))) found.push('--app-id must be the test application\'s client id (a GUID)');
  if (!String(appName ?? '').startsWith(FIXTURE_APP_PREFIX)) found.push(`--app-name must be a ${FIXTURE_APP_PREFIX}* test application: only a test app is granted access`);
  return found;
}

/** Offline: the requests a capture would send, in order. */
export function siteGrantsCapturePlan(options) {
  const found = problems(options);
  if (found.length) throw new Error(found.join('; '));
  return [
    { step: 1, credential: 'collector', method: 'GET', path: '/v1.0/sites/getAllSites (all pages; count only)', operationId: 'sharepoint.site-discovery' },
    { step: 2, credential: 'collector', method: 'GET', path: '/v1.0/sites/{fixture site id}/permissions', operationId: 'sharepoint.site-permissions' },
    { step: 3, credential: 'restorer', method: 'POST', path: `/v1.0/sites/{fixture site id}/permissions { roles: [read], application: ${options.appName} }`, operationId: SITE_GRANT_ADD },
    { step: 3, credential: 'restorer', method: 'GET', path: '/v1.0/sites/{fixture site id}/permissions (read back)', operationId: SITE_GRANT_ADD },
    { step: 4, credential: 'restorer', method: 'PATCH', path: '/v1.0/sites/{fixture site id}/permissions/{the new grant} { roles: [write] }', operationId: SITE_GRANT_UPDATE },
    { step: 4, credential: 'restorer', method: 'GET', path: '/v1.0/sites/{fixture site id}/permissions (read back)', operationId: SITE_GRANT_UPDATE },
  ];
}

/**
 * Runs a capture against two injected transports (collector, restorer). Returns the
 * unsigned record and the capture log, pseudonymized; it never signs or writes files.
 */
export async function captureSiteGrantsAcceptance({
  collector, restorer, tenantHost, fixtureSiteUrl, appId, appName, tenantRef, build, credentials, grants, documentation = [],
  now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), readBackAttempts = 5, readBackDelayMs = 2000,
}) {
  const found = problems({ tenantHost, fixtureSiteUrl, appId, appName });
  if (found.length) throw new Error(found.join('; '));
  if (!tenantRef || !build) throw new Error('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) {
    throw new Error('a capture needs two separate credential references (collector, restorer)');
  }

  const requests = [];
  const log = { requests, values: {} };
  let retryAfterResponses = 0;
  const logged = (credential, transport) => async (url, init) => {
    const parsed = new URL(url);
    const [, version, ...rest] = parsed.pathname.split('/');
    const response = await transport(url, init);
    if (response.status === 429 || response.status === 503) retryAfterResponses += 1;
    requests.push({ credential, method: init?.method ?? 'GET', version, path: `/${rest.join('/')}${parsed.search}`, status: response.status, at: now().toISOString() });
    return response;
  };
  const asCollector = logged('collector', collector);
  const asRestorer = logged('restorer', restorer);

  const reads = [];
  const read = async (id, substitute = {}) => {
    const descriptor = readDescriptor(id);
    try {
      const { items, observed } = await readGraphConfiguration(descriptor, { transport: asCollector, sleep, substitute });
      reads.push({ operationId: id, version: descriptor.operation.version, capturedAt: now().toISOString(), ok: true, synthetic: false, pages: observed.pages, items: items.length });
      return items;
    } catch (error) {
      reads.push({ operationId: id, version: descriptor.operation.version, capturedAt: now().toISOString(), ok: false, synthetic: false, error: error.message });
      return null;
    }
  };

  const sites = (await read('sharepoint.site-discovery')) ?? [];
  const fixture = sites.find((site) => siteInScope(site, tenantHost) && normalUrl(site.webUrl) === normalUrl(fixtureSiteUrl)) ?? null;
  log.values.discoveredSites = sites.length;
  const appKey = grantAppKey({ applications: [{ id: appId }] });
  const writes = [SITE_GRANT_ADD, SITE_GRANT_UPDATE].map((operationId) => ({
    operationId, version: WORKLOAD_WRITE_OPERATIONS[operationId].version, synthetic: false, role: SITE_GRANTS_CAPTURE_ROLES[operationId], ok: false, readBackVerified: false,
  }));
  let error = null;
  if (!fixture) error = 'the KEEL-RT fixture site was not discovered; nothing was written';
  else {
    const before = await read('sharepoint.site-permissions', { 'site-id': fixture.id });
    if (!before) error = 'reading the fixture site grants failed; nothing was written';
    else if (normalise(before).some((grant) => grantAppKey(grant) === appKey)) {
      error = `${appName} already holds a grant on the fixture site; remove it by hand and rerun (nothing was written)`;
    } else {
      await grantAndRaise({ transport: asRestorer, siteId: fixture.id, appId, appName, writes, log, now, sleep, attempts: readBackAttempts, delayMs: readBackDelayMs });
    }
  }
  for (const capture of writes) {
    capture.capturedAt ??= now().toISOString();
    if (error) capture.error = error;
  }

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: SITE_GRANTS_LIVE_GATE,
    tenantRef,
    build,
    operation: SITE_GRANTS_LIVE_OPERATION,
    credentialMode: SITE_GRANTS_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      tenantHost,
      fixtureSite: fixture ? { id: fixture.id, webUrl: fixture.webUrl } : { id: null, webUrl: fixtureSiteUrl },
      application: { id: appId, displayName: appName },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      reads,
      writes,
      requests: requests.map(({ at, ...request }) => request),
      throttle: { retryAfterResponses },
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return pseudonymizeCapture({ record, log });
}

async function grantAndRaise({ transport, siteId, appId, appName, writes, log, now, sleep, attempts, delayMs }) {
  const url = `${GRAPH}/v1.0/sites/${encodeURIComponent(siteId)}/permissions`;
  const readBack = async (role) => {
    let mine = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt) await sleep(delayMs);
      const { items } = await readGraphConfiguration(readDescriptor('sharepoint.site-permissions'), { transport, sleep, substitute: { 'site-id': siteId } });
      mine = normalise(items).filter((grant) => grantAppKey(grant) === grantAppKey({ applications: [{ id: appId }] }));
      if (mine.length === 1 && siteRoleRank(mine[0].roles) === siteRoleRank([role])) return mine[0];
    }
    return null;
  };
  const [add, update] = writes;
  try {
    const created = await transport(url, { method: 'POST', body: { roles: [add.role], grantedToIdentities: [{ application: { id: appId, displayName: appName } }] } });
    add.capturedAt = now().toISOString();
    if (created.status < 200 || created.status >= 300) { add.error = `the grant was refused (HTTP ${created.status})`; return; }
    add.ok = true;
    log.values.granted = true;
    const shown = await readBack(add.role);
    add.readBackVerified = Boolean(shown);
    // The app Graph granted must itself be named KEEL-RT-, not only the name typed.
    add.grantedName = shown?.applications?.[0]?.displayName ?? null;
    if (shown && !String(add.grantedName ?? '').startsWith(FIXTURE_APP_PREFIX)) {
      update.error = `the granted app reads back as ${add.grantedName ?? 'no name'}, not a ${FIXTURE_APP_PREFIX} test app; nothing more was written, remove the grant by hand`;
      return;
    }
    const permissionId = shown?.id ?? created.body?.id;
    if (!permissionId) { update.error = 'the new grant has no id to update'; return; }
    const raised = await transport(`${url}/${encodeURIComponent(permissionId)}`, { method: 'PATCH', body: { roles: [update.role] } });
    update.capturedAt = now().toISOString();
    if (raised.status < 200 || raised.status >= 300) { update.error = `the update was refused (HTTP ${raised.status})`; return; }
    update.ok = true;
    update.readBackVerified = Boolean(await readBack(update.role));
  } catch (thrown) {
    for (const capture of writes) if (!capture.ok) capture.error ??= thrown.message;
  }
}

/**
 * The import seam: a record that passes the gate with --require-live becomes read
 * evidence, one live write capture per proven write and the restorer's grants.
 */
export function ledgerEvidenceFromSiteGrantsAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: SITE_GRANTS_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${SITE_GRANTS_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: subject.reads.map((item) => ({
      operationId: item.operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, error: null, observed: { pages: item.pages ?? null }, proofRef,
    })),
    writes: subject.writes.map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: { permissions: [...subject.grants.collector.permissions], roles: [...(subject.grants.collector.roles ?? [])] },
    restorerGrants: { permissions: [...subject.grants.restorer.permissions], roles: [...(subject.grants.restorer.roles ?? [])] },
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--tenant-host': 'tenantHost', '--fixture-site-url': 'fixtureSiteUrl', '--app-id': 'appId', '--app-name': 'appName',
    '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef', '--grants': 'grants', '--docs': 'docs', '--out': 'out', '--build': 'build',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { out = console.log, env = process.env, transportFor = bearerTransport, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(siteGrantsCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: sharepointSiteGrantsLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(siteGrantsCapturePlan(options), null, 2));
    out(`refused: a capture grants a ${FIXTURE_APP_PREFIX} test app access to a ${FIXTURE_SITE_PREFIX} site; rerun with --confirm-live-tenant-write`);
    return 2;
  }
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'], ['--grants', 'grants'], ['--docs', 'docs'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (!env.KEEL_SP_COLLECTOR_TOKEN || !env.KEEL_SP_RESTORER_TOKEN) {
    throw new Error('capture needs KEEL_SP_COLLECTOR_TOKEN and KEEL_SP_RESTORER_TOKEN in the environment');
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const { record, captureLog } = await captureSiteGrantsAcceptance({
    collector: transportFor(env.KEEL_SP_COLLECTOR_TOKEN),
    restorer: transportFor(env.KEEL_SP_RESTORER_TOKEN),
    tenantHost: options.tenantHost,
    fixtureSiteUrl: options.fixtureSiteUrl,
    appId: options.appId,
    appName: options.appName,
    tenantRef: options.tenantRef,
    build,
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    documentation: JSON.parse(readFile(options.docs)),
  });
  const outPath = resolve(options.out);
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: SITE_GRANTS_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  out(JSON.stringify({ evidence: outPath, captureLog: logPath, writes: record.subject.writes, verify: result }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
