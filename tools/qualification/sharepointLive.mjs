#!/usr/bin/env node
/**
 * Roadmap task-120: capture and import SharePoint configuration live-acceptance
 * evidence. The operator runs this; builders and CI never point it at a tenant.
 *
 *   node tools/qualification/sharepointLive.mjs plan \
 *        --tenant-host contoso.sharepoint.com --fixture-site-url https://contoso.sharepoint.com/sites/KEEL-RT-...
 *     Offline (the default). Prints every request a capture would send. No network.
 *
 *   KEEL_SP_COLLECTOR_TOKEN=... KEEL_SP_RESTORER_TOKEN=... [KEEL_QUALIFICATION_HMAC_KEY=...] \
 *   node tools/qualification/sharepointLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --tenant-host contoso.sharepoint.com \
 *        --fixture-site-url https://contoso.sharepoint.com/sites/KEEL-RT-... \
 *        --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --grants grants.json --docs docs.json \
 *        --out docs/release/qualifications/sharepoint-live-acceptance.json [--build <sha>] [--allow-widening-toggle]
 *
 * What a capture does, in order (and nothing else):
 *  1. collector: GET /admin/sharepoint/settings;
 *  2. collector: GET /sites/getAllSites (all pages; only the count is kept), to
 *     find the KEEL-RT fixture site;
 *  3. collector: GET /sites/{fixture} and /sites/{fixture}/permissions;
 *  4. restorer: GET settings, PATCH isResharingByExternalUsersEnabled to the other
 *     value, read it back, PATCH the original value back, read it back.
 * No other site is addressed by id; no file, list, page or message endpoint is
 * ever requested. Step 4 changes a TENANT-WIDE setting for the few seconds between
 * the two PATCHes: Graph exposes no site-scoped write for the setting task-103
 * restores. When the setting starts `true` the first PATCH narrows sharing; when
 * it starts `false` the first PATCH would widen it, which is refused unless
 * --allow-widening-toggle is given too.
 *
 * Tokens come from the environment and are never written. The record carries
 * credential references only. With KEEL_QUALIFICATION_HMAC_KEY set the record is
 * signed as `keel-release-runner`; without it the record cannot verify.
 *
 * ledgerEvidenceFromAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes task-101 read evidence and a task-103 write
 * capture. Anything less becomes nothing.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readGraphConfiguration } from '../../engine/collect/workloadContract.mjs';
import { siteInScope } from '../../engine/collect/workloads/sharepoint.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../engine/coverage/qualification.mjs';
import { liveSettingsFingerprint } from '../../engine/restore/workloads/sharepoint.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import {
  FIXTURE_SITE_PREFIX, SHAREPOINT_LIVE_CREDENTIAL_MODE, SHAREPOINT_LIVE_GATE, SHAREPOINT_LIVE_OPERATION,
  SHAREPOINT_LIVE_PREREQUISITES, SHAREPOINT_LIVE_READS, SHAREPOINT_LIVE_WRITE, readDescriptor,
} from './sharepointAcceptance.mjs';

const GRAPH = 'https://graph.microsoft.com';
export const TOGGLE_FIELD = 'isResharingByExternalUsersEnabled';
const write = WORKLOAD_WRITE_OPERATIONS[SHAREPOINT_LIVE_WRITE];

const normalUrl = (url) => String(url ?? '').trim().replace(/\/+$/, '').toLowerCase();
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

/** Refuses anything but a disposable KEEL-RT-* site on the tenant host. */
export function fixtureSiteProblems({ tenantHost, fixtureSiteUrl }) {
  const problems = [];
  if (typeof tenantHost !== 'string' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(tenantHost)) problems.push('--tenant-host must be a *.sharepoint.com host');
  let url;
  try { url = new URL(fixtureSiteUrl); } catch { return [...problems, '--fixture-site-url is not a URL']; }
  if (url.hostname.toLowerCase() !== String(tenantHost).toLowerCase()) problems.push('the fixture site is not on the tenant host');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'sites' || !decodeURIComponent(parts[1]).startsWith(FIXTURE_SITE_PREFIX)) {
    problems.push(`the fixture site must be /sites/${FIXTURE_SITE_PREFIX}*: only a disposable KEEL rehearsal site is touched`);
  }
  return problems;
}

/** Offline: the requests a capture would send, in order. */
export function capturePlan({ tenantHost, fixtureSiteUrl }) {
  const problems = fixtureSiteProblems({ tenantHost, fixtureSiteUrl });
  if (problems.length) throw new Error(problems.join('; '));
  return [
    { step: 1, credential: 'collector', method: 'GET', path: '/v1.0/admin/sharepoint/settings', operationId: 'sharepoint.tenant-settings' },
    { step: 2, credential: 'collector', method: 'GET', path: '/v1.0/sites/getAllSites (all pages; count only)', operationId: 'sharepoint.site-discovery' },
    { step: 3, credential: 'collector', method: 'GET', path: '/v1.0/sites/{fixture site id}', operationId: 'sharepoint.site-properties' },
    { step: 3, credential: 'collector', method: 'GET', path: '/v1.0/sites/{fixture site id}/permissions', operationId: 'sharepoint.site-permissions' },
    { step: 4, credential: 'restorer', method: 'GET', path: '/v1.0/admin/sharepoint/settings', operationId: SHAREPOINT_LIVE_WRITE },
    { step: 4, credential: 'restorer', method: 'PATCH', path: `/v1.0/admin/sharepoint/settings { ${TOGGLE_FIELD}: <other value> } (tenant-wide)`, operationId: SHAREPOINT_LIVE_WRITE },
    { step: 4, credential: 'restorer', method: 'GET', path: '/v1.0/admin/sharepoint/settings (read back)', operationId: SHAREPOINT_LIVE_WRITE },
    { step: 4, credential: 'restorer', method: 'PATCH', path: `/v1.0/admin/sharepoint/settings { ${TOGGLE_FIELD}: <original value> }`, operationId: SHAREPOINT_LIVE_WRITE },
    { step: 4, credential: 'restorer', method: 'GET', path: '/v1.0/admin/sharepoint/settings (read back)', operationId: SHAREPOINT_LIVE_WRITE },
  ];
}

/**
 * Runs a capture against two injected transports (collector, restorer), each
 * `(url, init?) => { status, headers, body }`. Returns the unsigned record and the
 * raw capture log; it never signs and never writes files.
 */
export async function captureSharePointAcceptance({
  collector, restorer, tenantHost, fixtureSiteUrl, tenantRef, build, credentials, grants, documentation = [],
  allowWideningToggle = false, now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readBackAttempts = 5, readBackDelayMs = 2000,
}) {
  const problems = fixtureSiteProblems({ tenantHost, fixtureSiteUrl });
  if (problems.length) throw new Error(problems.join('; '));
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

  const [settings] = (await read('sharepoint.tenant-settings')) ?? [];
  const supportedFields = settings ? write.fields.filter((field) => Object.hasOwn(settings, field)) : [];
  const sites = (await read('sharepoint.site-discovery')) ?? [];
  const fixture = sites.find((site) => siteInScope(site, tenantHost) && normalUrl(site.webUrl) === normalUrl(fixtureSiteUrl)) ?? null;
  log.values.discoveredSites = sites.length;
  if (fixture) {
    await read('sharepoint.site-properties', { 'site-id': fixture.id });
    await read('sharepoint.site-permissions', { 'site-id': fixture.id });
  }

  const writeCapture = { operationId: SHAREPOINT_LIVE_WRITE, version: write.version, synthetic: false, writeMode: 'reversible-change', field: TOGGLE_FIELD, ok: false, readBackVerified: false, restoredToOriginal: false, preFingerprint: null, finalFingerprint: null };
  const readsOk = fixture && reads.length === SHAREPOINT_LIVE_READS.length && reads.every((item) => item.ok);
  if (!readsOk) writeCapture.error = fixture ? 'a read failed; nothing was written' : 'the KEEL-RT fixture site was not discovered; nothing was written';
  else {
    await toggleAndRestore({ transport: asRestorer, capture: writeCapture, log, allowWideningToggle, sleep, readBackAttempts, readBackDelayMs });
  }
  writeCapture.capturedAt = now().toISOString();

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: SHAREPOINT_LIVE_GATE,
    tenantRef,
    build,
    operation: SHAREPOINT_LIVE_OPERATION,
    credentialMode: SHAREPOINT_LIVE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      prerequisites: [...SHAREPOINT_LIVE_PREREQUISITES],
      tenantHost,
      fixtureSite: fixture ? { id: fixture.id, webUrl: fixture.webUrl } : { id: null, webUrl: fixtureSiteUrl },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      reads,
      supportedFields,
      write: writeCapture,
      requests: requests.map(({ at, ...request }) => request),
      throttle: { retryAfterResponses },
      documentation,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return { record, captureLog, needsManualRevert: log.values.wrote === true && writeCapture.restoredToOriginal !== true };
}

async function readSettings(transport, sleep) {
  const { items: [body = {}] } = await readGraphConfiguration(readDescriptor(write.readBack), { transport, sleep });
  return body;
}

async function readUntil(transport, expected, { sleep, attempts, delayMs }) {
  let body = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    body = await readSettings(transport, sleep);
    if (body?.[TOGGLE_FIELD] === expected) return { body, matched: true };
  }
  return { body, matched: false };
}

async function patch(transport, value) {
  const response = await transport(`${GRAPH}/${write.version}${write.endpoint}`, { method: write.method, body: { [TOGGLE_FIELD]: value } });
  return response.status >= 200 && response.status < 300 ? null : `HTTP ${response.status}`;
}

async function toggleAndRestore({ transport, capture, log, allowWideningToggle, sleep, readBackAttempts, readBackDelayMs }) {
  const timing = { sleep, attempts: readBackAttempts, delayMs: readBackDelayMs };
  try {
    const before = await readSettings(transport, sleep);
    const original = before[TOGGLE_FIELD];
    capture.preFingerprint = liveSettingsFingerprint(before);
    log.values.original = original;
    if (typeof original !== 'boolean') { capture.error = `${TOGGLE_FIELD} is not a boolean; nothing was written`; return; }
    if (original === false && !allowWideningToggle) {
      capture.error = `${TOGGLE_FIELD} is false, so the first write would widen sharing; rerun with --allow-widening-toggle to accept that`;
      return;
    }
    const failed = await patch(transport, !original);
    if (failed) { capture.error = `the write failed (${failed})`; return; }
    log.values.wrote = true;
    const changed = await readUntil(transport, !original, timing);
    capture.readBackVerified = changed.matched;
    // Always put the setting back once a write was accepted, whatever the read-back said.
    const revertFailed = await patch(transport, original);
    const restored = revertFailed ? { body: await readSettings(transport, sleep), matched: false } : await readUntil(transport, original, timing);
    capture.restoredToOriginal = !revertFailed && restored.matched;
    capture.finalFingerprint = liveSettingsFingerprint(restored.body);
    capture.ok = !revertFailed;
    if (revertFailed) capture.error = `PUTTING THE SETTING BACK FAILED (${revertFailed}): set ${TOGGLE_FIELD} to ${original} by hand`;
  } catch (error) {
    capture.error = error.message;
  }
}

/**
 * Writes the record and its capture log side by side, binding the log's digest as
 * the artifact proof, and signs the record when a runner key is given.
 */
export function writeAcceptanceFiles({ record, captureLog, outPath, hmacKey = null }) {
  const logPath = outPath.replace(/\.json$/, '') + '.capture.json';
  writeFileSync(logPath, captureLog);
  let evidence = { ...record, proof: { artifact: { path: basename(logPath), sha256: sha256Hex(captureLog) } } };
  if (hmacKey) evidence = signEvidence(evidence, hmacKey, 'keel-release-runner');
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidence, logPath };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes
 * task-101 read evidence (for buildWorkloadLedger), a task-103 write capture (for
 * workloadWriteQualification) and the collector's grants. Anything else yields none.
 */
export function ledgerEvidenceFromAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: SHAREPOINT_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${SHAREPOINT_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: subject.reads.map((item) => ({
      operationId: item.operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: item.ok === true, error: null, observed: { pages: item.pages ?? null }, proofRef,
    })),
    writes: [{
      operationId: subject.write.operationId, kind: 'live-write-capture', synthetic: false, tenantRef,
      capturedAt: subject.write.capturedAt, version: subject.write.version, ok: subject.write.ok === true,
      readBackVerified: subject.write.readBackVerified === true, proofRef,
    }],
    grants: { permissions: [...subject.grants.collector.permissions], roles: [...subject.grants.collector.roles] },
  };
}

/** A fetch-backed transport for one bearer token. The token never leaves this closure. */
export function bearerTransport(token, fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false, allowWideningToggle: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--tenant-host': 'tenantHost', '--fixture-site-url': 'fixtureSiteUrl', '--collector-ref': 'collectorRef',
    '--restorer-ref': 'restorerRef', '--grants': 'grants', '--docs': 'docs', '--out': 'out', '--build': 'build',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--confirm-live-tenant-write') options.confirm = true;
    else if (arg === '--allow-widening-toggle') options.allowWideningToggle = true;
    else if (names[arg]) options[names[arg]] = rest[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { out = console.log, env = process.env, transportFor = bearerTransport, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(capturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: sharepointLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(capturePlan(options), null, 2));
    out('refused: a capture writes a tenant-wide SharePoint setting; rerun with --confirm-live-tenant-write');
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
  const { record, captureLog, needsManualRevert } = await captureSharePointAcceptance({
    collector: transportFor(env.KEEL_SP_COLLECTOR_TOKEN),
    restorer: transportFor(env.KEEL_SP_RESTORER_TOKEN),
    tenantHost: options.tenantHost,
    fixtureSiteUrl: options.fixtureSiteUrl,
    tenantRef: options.tenantRef,
    build,
    credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
    documentation: JSON.parse(readFile(options.docs)),
    allowWideningToggle: options.allowWideningToggle,
  });
  const outPath = resolve(options.out);
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, {
    gate: SHAREPOINT_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath),
  });
  out(JSON.stringify({ evidence: outPath, captureLog: logPath, write: record.subject.write, verify: result }, null, 2));
  // 3: the tenant setting may not be back where it started; the output says what to set by hand.
  if (needsManualRevert) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
