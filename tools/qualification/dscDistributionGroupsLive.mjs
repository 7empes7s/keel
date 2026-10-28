#!/usr/bin/env node
/**
 * Distribution list restore through Microsoft365DSC: capture the live proof its two writes
 * need before they may run. The operator runs this against the test tenant, in the keel-dsc
 * image; builders and CI never point it at a tenant.
 *
 *   node tools/qualification/dscDistributionGroupsLive.mjs plan
 *     Offline (the default). Prints what a capture would send. No network.
 *
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] node tools/qualification/dscDistributionGroupsLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/exchange-collector.json --restorer-config /etc/keel/exchange-restorer.json \
 *        --grants grants.json --out docs/release/qualifications/dsc-distribution-groups-writes-live-acceptance.json [--build <sha>]
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks the DSC transport for a Set with Ensure = Absent and for a Set of
 *     ManagedBy (a field KEEL only lists); both must be refused before anything is sent;
 *  1. collector: Get KEEL-RT-capture-<random> (expected absent);
 *  2. restorer: one Set, Ensure Present, creating that list with a name, display name,
 *     alias, type and three settings (the add); collector: read back until it matches;
 *  3. restorer: one Set changing the declared settings, the others sent with the values
 *     just read (the update); collector: read back until it matches, and check that the
 *     fields KEEL never sends (owners, moderators, senders, addresses) did not change.
 * KEEL never deletes, so the KEEL-RT-capture- list stays; it holds no members and is hidden
 * from the address book. Tenant ids and addresses are pseudonymized. With
 * KEEL_QUALIFICATION_HMAC_KEY set the record is signed as `keel-release-runner`.
 *
 * ledgerEvidenceFromDscWritesAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes one live write capture per proven write.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readConfigFile } from '../../engine/config/configFile.mjs';
import { DSC_MODULE, DSC_MODULE_VERSION, DscError, DscScopeError } from '../../engine/powershell/dscJob.mjs';
import {
  DISTRIBUTION_GROUP_ADD, DISTRIBUTION_GROUP_RESOURCE, DISTRIBUTION_GROUP_UPDATE, LISTED_FIELDS, UPDATE_FIELDS, dscRunner, normalize,
} from '../../engine/restore/workloads/dscDistributionGroups.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, verifyEvidence } from '../release/qualification.mjs';
import {
  DSC_CAPTURE_PREFIX, DSC_WRITES_CREDENTIAL_MODE, DSC_WRITES_LIVE_GATE, DSC_WRITES_LIVE_OPERATION, DSC_WRITES_RECORD_FILE, DSC_WRITES_TRANSPORT,
  provenDscWrites,
} from './dscDistributionGroupsAcceptance.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { writeAcceptanceFiles } from './sharepointLive.mjs';

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
// What the capture list is created with, and what the update changes.
const CREATED = Object.freeze({ HiddenFromAddressListsEnabled: true, MemberJoinRestriction: 'Closed', MemberDepartRestriction: 'Closed' });
const CHANGED = Object.freeze({ MemberJoinRestriction: 'ApprovalRequired', SendOofMessageToOriginatorEnabled: true });
// Fields a write must leave alone: the ones KEEL only lists, and the addresses.
const UNTOUCHED = Object.freeze([...LISTED_FIELDS, 'Alias', 'PrimarySmtpAddress', 'Type']);

/** Offline: what a capture would send, in order. */
export function dscWritesCapturePlan() {
  const name = `${DSC_CAPTURE_PREFIX}<random>`;
  return [
    { step: 0, credential: 'none', refused: 'EXODistributionGroup Set with Ensure = Absent (KEEL never removes; refused before sending)' },
    { step: 0, credential: 'none', refused: 'EXODistributionGroup Set of ManagedBy (a field KEEL only lists; refused before sending)' },
    { step: 1, credential: 'collector', resource: DISTRIBUTION_GROUP_RESOURCE, method: 'Get', name, expect: 'absent' },
    { step: 2, credential: 'restorer', resource: DISTRIBUTION_GROUP_RESOURCE, method: 'Set', properties: { Identity: name, Name: name, Ensure: 'Present', Type: 'Distribution', DisplayName: name, Alias: '<name without punctuation>', ...CREATED }, operationId: DISTRIBUTION_GROUP_ADD },
    { step: 2, credential: 'collector', resource: DISTRIBUTION_GROUP_RESOURCE, method: 'Get', name, expect: 'present, as created' },
    { step: 3, credential: 'restorer', resource: DISTRIBUTION_GROUP_RESOURCE, method: 'Set', properties: { Identity: name, Name: name, Ensure: 'Present', DisplayName: `${name} updated`, ...CHANGED, '...': 'the other declared settings, as read' }, operationId: DISTRIBUTION_GROUP_UPDATE },
    { step: 3, credential: 'collector', resource: DISTRIBUTION_GROUP_RESOURCE, method: 'Get', name, expect: `as changed; ${UNTOUCHED.join(', ')} unchanged` },
  ];
}

/** Reads until `matches`; a read that fails counts as no match and is retried. */
async function readUntil(readOnce, matches, { sleep, attempts, delayMs }) {
  let found = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await sleep(delayMs);
    try { found = await readOnce(); } catch { found = null; continue; }
    if (matches(found)) return { found, matched: true };
  }
  return { found, matched: false };
}

const sameValue = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
  || (typeof normalize(a) === 'string' && typeof normalize(b) === 'string' && normalize(a).toLowerCase() === normalize(b).toLowerCase());
const matchesAll = (state, wanted) => state?.Ensure === 'Present' && Object.entries(wanted).every(([field, value]) => sameValue(state[field], value));

/**
 * Runs a capture. `collector` and `restorer` are the DSC runner options for each identity's
 * Exchange config (dscRunner). Returns the unsigned record and the capture log,
 * pseudonymized; it never signs and never writes files.
 */
export async function captureDscWrites({
  collector, restorer, tenantRef, build, credentials, grants, runner = dscRunner,
  now = () => new Date(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), readBackAttempts = 6, readBackDelayMs = 10_000,
  suffix = () => randomBytes(4).toString('hex'),
}) {
  const problems = [];
  if (!tenantRef || !build) problems.push('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) problems.push('a capture needs two separate credential references (collector, restorer)');
  if (!grants?.restorer || !Array.isArray(grants.restorer.roles)) problems.push('--grants must name the restorer\'s roles');
  if (problems.length) throw new Error(problems.join('; '));
  const read = runner(collector);
  const write = runner(restorer);
  const requests = [];
  const log = { requests, values: {} };
  const timing = { sleep, attempts: readBackAttempts, delayMs: readBackDelayMs };
  let moduleVersion = null;

  const get = async (name) => {
    const entry = { credential: 'collector', resource: DISTRIBUTION_GROUP_RESOURCE, methods: ['Get'], name, outcome: 'ok', at: now().toISOString() };
    let answer;
    try {
      answer = await read({ resource: DISTRIBUTION_GROUP_RESOURCE, calls: [{ method: 'Get', properties: { Identity: name, Name: name, Ensure: 'Present' } }] });
    } catch (error) {
      requests.push({ ...entry, outcome: 'failed', error: error.message });
      throw error;
    }
    moduleVersion = answer.moduleVersion;
    const [result] = answer.results;
    requests.push({ ...entry, ...(result.ok ? {} : { outcome: 'failed', error: result.error?.message ?? null }), ...(result.missing?.length ? { missing: result.missing } : {}) });
    if (!result.ok) throw new Error(result.error?.message ?? 'the read failed');
    return result.state;
  };
  const set = async (capture, properties) => {
    const entry = { credential: 'restorer', resource: DISTRIBUTION_GROUP_RESOURCE, methods: ['Set'], name: properties.Name, ensure: properties.Ensure, fields: Object.keys(properties).sort(), outcome: 'ok', at: now().toISOString() };
    try {
      const answer = await write({ resource: DISTRIBUTION_GROUP_RESOURCE, calls: [{ method: 'Set', properties }] });
      moduleVersion = answer.moduleVersion;
      const [result] = answer.results;
      if (!result.ok) {
        requests.push({ ...entry, outcome: 'failed', error: result.error?.message ?? null });
        capture.error = `the Set failed: ${result.error?.message ?? 'no message'}`;
        return false;
      }
      requests.push(entry);
      return true;
    } catch (error) {
      if (error instanceof DscScopeError) throw error;
      requests.push({ ...entry, outcome: 'failed', error: error.message });
      // The container refused or could not connect: nothing was sent.
      if (error instanceof DscError && error.detail.code === 'DSC_JOB_REFUSED') { capture.error = `the Set was not sent: ${error.message}`; return false; }
      capture.error = `the Set had no answer (${error.message}); it may have applied`;
      return true;
    }
  };

  // 0. Offline refusals: a removal and a listed field never leave this process.
  const refusals = {
    remove: { resource: DISTRIBUTION_GROUP_RESOURCE, ensure: 'Absent', refused: false, sent: false },
    listedField: { resource: DISTRIBUTION_GROUP_RESOURCE, field: 'ManagedBy', refused: false, sent: false },
  };
  const probe = `${DSC_CAPTURE_PREFIX}refusal`;
  for (const [key, properties] of [['remove', { Identity: probe, Name: probe, Ensure: 'Absent' }], ['listedField', { Identity: probe, Name: probe, Ensure: 'Present', ManagedBy: ['nobody'] }]]) {
    const before = requests.length;
    try { await set({}, properties); } catch (error) {
      refusals[key].refused = error instanceof DscScopeError;
      refusals[key].reason = error.message;
    }
    refusals[key].sent = requests.length !== before;
  }

  const name = `${DSC_CAPTURE_PREFIX}${suffix()}`;
  const writes = [];
  const skipped = [];
  const created = [];
  const base = (operationId) => ({
    operationId, version: DSC_MODULE_VERSION, synthetic: false, fixture: name, ok: false, readBackVerified: false, collateralUnchanged: false, capturedAt: null, error: null,
  });
  const finish = (capture) => { capture.capturedAt = now().toISOString(); writes.push(capture); return capture; };
  let refusal = Object.values(refusals).every((item) => item.refused && !item.sent) ? null : 'the DSC transport did not refuse a removal or a listed field; nothing was written';
  if (!refusal) {
    try {
      const first = await get(name);
      if (first?.Ensure === 'Present') refusal = `${name} already exists; nothing was written`;
    } catch (error) { refusal = `the first read failed (${error.message}); nothing was written`; }
  }

  if (!refusal) {
    // 2. The add: a new list, created with its name, addresses, type and settings.
    const add = base(DISTRIBUTION_GROUP_ADD);
    const alias = name.replace(/[^A-Za-z0-9-]/g, '');
    const wanted = { Name: name, DisplayName: name, Alias: alias, Type: 'Distribution', ...CREATED };
    let state = null;
    if (await set(add, { Identity: name, Ensure: 'Present', ...wanted })) {
      created.push({ kind: 'distributionGroup', name });
      const seen = await readUntil(() => get(name), (found) => matchesAll(found, wanted), timing);
      add.readBackVerified = seen.matched;
      state = seen.found;
      // A new list has no owners, moderators or sender limits KEEL did not set.
      add.collateralUnchanged = seen.matched && ['ModeratedBy', 'GrantSendOnBehalfTo', 'AcceptMessagesOnlyFromSendersOrMembers', 'RejectMessagesFromSendersOrMembers', 'Members']
        .every((field) => normalize(state?.[field]) === null);
      add.ok = add.readBackVerified && add.collateralUnchanged && add.error === null;
      log.values.created = state;
    }
    finish(add);

    // 3. The update: the declared set, changed fields from CHANGED, the rest as read.
    if (state?.Ensure === 'Present') {
      const update = base(DISTRIBUTION_GROUP_UPDATE);
      const properties = { Identity: name, Name: name, Ensure: 'Present' };
      for (const field of UPDATE_FIELDS) {
        const value = field === 'DisplayName' ? `${name} updated` : Object.hasOwn(CHANGED, field) ? CHANGED[field] : normalize(state[field]);
        if (value !== null && (['string', 'boolean', 'number'].includes(typeof value) || Array.isArray(value))) properties[field] = value;
      }
      const changed = { DisplayName: `${name} updated`, ...CHANGED };
      const before = Object.fromEntries(UNTOUCHED.map((field) => [field, normalize(state[field])]));
      if (await set(update, properties)) {
        const seen = await readUntil(() => get(name), (found) => matchesAll(found, changed), timing);
        update.readBackVerified = seen.matched;
        update.collateralUnchanged = seen.matched && UNTOUCHED.every((field) => sameValue(seen.found?.[field], before[field]));
        if (seen.matched && !update.collateralUnchanged) {
          update.error = `a field KEEL never sends changed: ${UNTOUCHED.filter((field) => !sameValue(seen.found?.[field], before[field])).join(', ')}`;
        }
        update.ok = update.readBackVerified && update.collateralUnchanged && update.error === null;
        log.values.updated = seen.found;
      }
      finish(update);
    } else skipped.push({ operationId: DISTRIBUTION_GROUP_UPDATE, reason: 'the capture list was not created' });
  }
  if (refusal) skipped.push({ operationId: null, reason: refusal });

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: DSC_WRITES_LIVE_GATE,
    tenantRef,
    build,
    operation: DSC_WRITES_LIVE_OPERATION,
    credentialMode: DSC_WRITES_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      execution: { transport: DSC_WRITES_TRANSPORT, module: DSC_MODULE, moduleVersion: moduleVersion ?? DSC_MODULE_VERSION },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      refusals,
      writes,
      skipped,
      created,
      requests: requests.map(({ at, ...request }) => request),
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return pseudonymizeCapture({ record, log });
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one live
 * write capture per proven write, the restorer's grants and the Microsoft365DSC version
 * the captures are bound to. Anything else yields none.
 */
export function ledgerEvidenceFromDscWritesAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: DSC_WRITES_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${DSC_WRITES_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: [],
    writes: provenDscWrites(subject).map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: null,
    restorerGrants: { permissions: [...(subject.grants.restorer.permissions ?? [])], roles: [...subject.grants.restorer.roles] },
    runtime: { modules: { [DSC_MODULE]: subject.execution.moduleVersion } },
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef',
    '--collector-config': 'collectorConfig', '--restorer-config': 'restorerConfig', '--grants': 'grants', '--out': 'out', '--build': 'build',
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
  out = console.log, env = process.env, readFile = (path) => readFileSync(path, 'utf8'), capture = captureDscWrites,
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(dscWritesCapturePlan(), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: dscDistributionGroupsLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(dscWritesCapturePlan(), null, 2));
    out('refused: a capture creates and changes one KEEL-RT-capture- distribution list in the tenant; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'], ['--grants', 'grants'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate config files');
  if (basename(options.out) !== DSC_WRITES_RECORD_FILE) throw new Error(`--out must be named ${DSC_WRITES_RECORD_FILE}, where the import looks for it`);
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const collectorConfig = readConfigFile(options.collectorConfig, { readFile, what: 'Exchange collector settings' });
  const restorerConfig = readConfigFile(options.restorerConfig, { readFile, what: 'Exchange restorer settings' });
  if (typeof collectorConfig.tenantId !== 'string' || options.tenantRef !== tenantRefFor(collectorConfig.tenantId)) throw new Error('--tenant-ref is not the tenant the collector config names; nothing was sent');
  if (restorerConfig.tenantId !== collectorConfig.tenantId) throw new Error('the restorer config names another tenant; nothing was sent');
  if (restorerConfig.clientId && restorerConfig.clientId === collectorConfig.clientId) throw new Error('the restorer config is the collector app; nothing was sent');
  const outPath = resolve(options.out);
  const { record, captureLog } = await capture({
    collector: { tenantConfigPath: options.collectorConfig }, restorer: { tenantConfigPath: options.restorerConfig },
    tenantRef: options.tenantRef, build, credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: JSON.parse(readFile(options.grants)),
  });
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: DSC_WRITES_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  const proven = provenDscWrites(evidence.subject).map((item) => item.operationId);
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath, proven, skipped: evidence.subject.skipped, created: evidence.subject.created,
    notProven: evidence.subject.writes.filter((item) => !proven.includes(item.operationId)).map(({ operationId, error }) => ({ operationId, error })),
    missingProperties: [...new Set(evidence.subject.requests.flatMap((request) => request.missing ?? []))],
    verify: result,
  }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
