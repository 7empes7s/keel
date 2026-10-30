#!/usr/bin/env node
/**
 * Removing labels from a Purview label policy: capture the live proof the write
 * (purview.label-policy.remove-labels) needs before it may run. The operator runs this
 * against the test tenant, with the keel-powershell image; builders and CI never point it
 * at a tenant.
 *
 *   node tools/qualification/purviewUnpublishLive.mjs plan
 *     Offline (the default). Prints what a capture would send. No network.
 *
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] node tools/qualification/purviewUnpublishLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/<purview collector>.json --restorer-config /etc/keel/<purview restorer>.json \
 *        --grants grants.json --out docs/release/qualifications/purview-label-unpublish-live-acceptance.json [--build <sha>]
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks the ordinary Purview call for Set-LabelPolicy -RemoveLabels, and the
 *     unpublish call for a parameter it never sends; both must be refused before sending;
 *  1. collector: Get-Label and Get-LabelPolicy. Picks the first KEEL-RT- label policy (by
 *     name, matched on the prefix only) that reports no preservation lock and publishes to
 *     no `All` location, and a KEEL-RT- label with no lock, preferring one that policy
 *     already publishes;
 *  2. restorer, only if the label is not published there yet: Set-LabelPolicy -AddLabels
 *     {label}; collector reads it back published;
 *  3. restorer: the writer's own unpublish call, Set-LabelPolicy -RemoveLabels {label};
 *     collector reads it back gone;
 *  4. restorer, only if the label was published at the start: Set-LabelPolicy -AddLabels
 *     {label} to put it back; collector reads the policy back as it started;
 *  5. collector: every other label and policy reads the same as at the start.
 * Only the KEEL-RT- policy is written, and only with the KEEL-RT- label. Tenant ids are
 * pseudonymized. With KEEL_QUALIFICATION_HMAC_KEY set the record is signed as
 * `keel-release-runner`. Exit 3 means the policy may not be back as it started: the
 * output names the label to publish again (or remove) by hand.
 *
 * ledgerEvidenceFromUnpublishAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes one live write capture.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readConfigFile } from '../../engine/config/configFile.mjs';
import {
  PURVIEW_MODULE, PurviewScopeError, definitionFingerprint, purviewCmdlet, purviewUnpublishCmdlet, readPurview,
} from '../../engine/collect/workloads/purview.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, verifyEvidence } from '../release/qualification.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import {
  UNPUBLISH_CREDENTIAL_MODE, UNPUBLISH_LIVE_GATE, UNPUBLISH_LIVE_OPERATION, UNPUBLISH_RECORD_FILE, UNPUBLISH_TRANSPORT, UNPUBLISH_WRITE,
  isUnpublishFixture, provenUnpublishWrites,
} from './purviewUnpublishAcceptance.mjs';
import { writeAcceptanceFiles } from './sharepointLive.mjs';
import { pinnedModuleVersions } from './workloadWritesLive.mjs';

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const POWERSHELL_DOCKERFILE = new URL('../../ops/powershell/Dockerfile', import.meta.url);
const LOCATIONS = Object.freeze(['ExchangeLocation', 'ModernGroupLocation', 'SharePointLocation', 'OneDriveLocation']);
const list = (value) => (Array.isArray(value) ? value.map(String) : value === null || value === undefined || value === '' ? [] : [String(value)]);
const has = (names, name) => list(names).some((entry) => entry.toLowerCase() === name.toLowerCase());

/** Offline: what a capture would send, in order. */
export function unpublishCapturePlan() {
  return [
    { step: 0, credential: 'none', refused: 'Set-LabelPolicy -RemoveLabels through the ordinary Purview call (refused before sending)' },
    { step: 0, credential: 'none', refused: 'Set-LabelPolicy -RemoveLabels -AddLabels through the unpublish call (refused before sending)' },
    { step: 1, credential: 'collector', cmdlet: 'Get-Label' },
    { step: 1, credential: 'collector', cmdlet: 'Get-LabelPolicy', expect: 'a KEEL-RT- policy with no lock and no All location, and a KEEL-RT- label' },
    { step: 2, credential: 'restorer', cmdlet: 'Set-LabelPolicy', parameters: { Identity: '<KEEL-RT- policy id>', AddLabels: ['<KEEL-RT- label>'] }, when: 'only if the policy does not publish the label yet' },
    { step: 3, credential: 'restorer', cmdlet: 'Set-LabelPolicy', parameters: { Identity: '<KEEL-RT- policy id>', RemoveLabels: ['<KEEL-RT- label>'] }, operationId: UNPUBLISH_WRITE },
    { step: 3, credential: 'collector', cmdlet: 'Get-LabelPolicy', expect: 'the label is gone' },
    { step: 4, credential: 'restorer', cmdlet: 'Set-LabelPolicy', parameters: { Identity: '<KEEL-RT- policy id>', AddLabels: ['<KEEL-RT- label>'] }, when: 'only if the label was published at the start' },
    { step: 5, credential: 'collector', cmdlet: 'Get-Label' },
    { step: 5, credential: 'collector', cmdlet: 'Get-LabelPolicy', expect: 'every label and policy as at the start' },
  ];
}

/** A policy's definition with its labels as a set, so a label published again at the end compares equal. */
function comparable(entry) {
  if (!entry) return null;
  return definitionFingerprint({
    ...entry,
    fields: { ...entry.fields, Labels: list(entry.fields?.Labels).map((name) => name.toLowerCase()).sort() },
  });
}

/** The KEEL-RT- policy and label a capture uses, or the reason there are none. */
export function chooseUnpublishFixtures(read) {
  const byName = (a, b) => String(a.fields?.Name).localeCompare(String(b.fields?.Name));
  const policies = read.resources.filter((entry) => entry.kind === 'policy' && isUnpublishFixture(entry.fields?.Name) && entry.lock !== 'locked'
    && LOCATIONS.every((location) => !has(entry.fields?.[location], 'All'))).sort(byName);
  if (!policies.length) return { reason: 'no KEEL-RT- label policy with no preservation lock that publishes to no All location' };
  const policy = policies[0];
  const labels = read.resources.filter((entry) => entry.kind === 'label' && isUnpublishFixture(entry.fields?.Name) && entry.lock !== 'locked').sort(byName);
  if (!labels.length) return { reason: 'no KEEL-RT- label with no preservation lock' };
  const label = labels.find((entry) => has(policy.fields.Labels, entry.fields.Name)) ?? labels[0];
  return { policy, label, published: has(policy.fields.Labels, label.fields.Name) };
}

/**
 * Runs a capture. `collector` and `restorer` are the cmdlet job options for each
 * identity's Purview config. Returns the unsigned record, the capture log, pseudonymized,
 * and whether the policy may need a hand fix; it never signs and never writes files.
 */
export async function captureUnpublish({
  collector, restorer, tenantRef, build, credentials, grants, moduleVersion, now = () => new Date(),
}) {
  const problems = [];
  if (!tenantRef || !build) problems.push('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) problems.push('a capture needs two separate credential references (collector, restorer)');
  if (!grants?.restorer || !Array.isArray(grants.restorer.roles)) problems.push('--grants must name the restorer\'s roles');
  if (typeof moduleVersion !== 'string' || !moduleVersion) problems.push(`the ${PURVIEW_MODULE} version the image pins is unknown`);
  if (problems.length) throw new Error(problems.join('; '));

  const requests = [];
  const log = { requests, values: {} };
  const read = async (credential, side) => {
    const result = await readPurview({ powershell: side });
    for (const [cmdlet, group] of [['Get-Label', 'label'], ['Get-LabelPolicy', 'policy']]) {
      const failure = result.failures.find((item) => item.group === group);
      requests.push({ credential, cmdlet, outcome: failure ? failure.status : 'ok', ...(failure ? { error: failure.error?.message ?? null } : {}) });
    }
    if (result.failures.length) throw new Error(`the ${credential} read was ${result.failures.map((item) => `${item.group} ${item.status}`).join(', ')}`);
    return result;
  };
  // A write is logged only when it reached the transport; a call refused before sending is not.
  const write = async (send, { policy, label, parameters }) => {
    const entry = { credential: 'restorer', cmdlet: 'Set-LabelPolicy', policy, labels: [label], parameters: Object.keys(parameters).sort(), outcome: 'ok' };
    try {
      await send();
      requests.push(entry);
    } catch (error) {
      if (error instanceof PurviewScopeError) throw error;
      requests.push({ ...entry, outcome: 'failed', error: error?.detail?.message ?? error.message });
      throw error;
    }
  };
  const add = (policy, label) => {
    const parameters = { Identity: policy.id, AddLabels: [label.fields.Name] };
    return write(() => purviewCmdlet({ cmdlet: 'Set-LabelPolicy', parameters }, restorer), { policy: policy.fields.Name, label: label.fields.Name, parameters });
  };
  const remove = (policy, label) => {
    const parameters = { Identity: policy.id, RemoveLabels: [label.fields.Name] };
    return write(() => purviewUnpublishCmdlet(parameters, restorer), { policy: policy.fields.Name, label: label.fields.Name, parameters });
  };

  // 0. Offline refusals: neither leaves this process.
  const refusals = {
    ordinaryCall: { cmdlet: 'Set-LabelPolicy', parameter: 'RemoveLabels', refused: false, sent: false },
    undeclaredParameter: { cmdlet: 'Set-LabelPolicy', parameter: 'AddLabels', refused: false, sent: false },
  };
  const probe = { Identity: '00000000-0000-4000-8000-000000000000', RemoveLabels: ['KEEL-RT-refusal'] };
  for (const [key, send] of [
    ['ordinaryCall', () => purviewCmdlet({ cmdlet: 'Set-LabelPolicy', parameters: probe }, restorer)],
    ['undeclaredParameter', () => purviewUnpublishCmdlet({ ...probe, AddLabels: ['KEEL-RT-refusal'] }, restorer)],
  ]) {
    const before = requests.length;
    try {
      await write(send, { policy: 'KEEL-RT-refusal', label: 'KEEL-RT-refusal', parameters: probe });
    } catch (error) {
      refusals[key].refused = error instanceof PurviewScopeError;
      refusals[key].reason = error.message;
    }
    refusals[key].sent = requests.length !== before;
  }

  const writes = [];
  const skipped = [];
  let needsManualRevert = null;
  let refusal = Object.values(refusals).every((item) => item.refused && !item.sent) ? null : 'a removal through the ordinary call or with an undeclared parameter was not refused; nothing was written';

  // 1. The read, and the fixtures.
  let start = null;
  let chosen = null;
  if (!refusal) {
    try {
      start = await read('collector', collector);
      chosen = chooseUnpublishFixtures(start);
      if (chosen.reason) refusal = `${chosen.reason}; nothing was written`;
    } catch (error) { refusal = `${error.message}; nothing was written`; }
  }

  if (!refusal) {
    const { policy, label, published } = chosen;
    const name = label.fields.Name;
    const capture = {
      operationId: UNPUBLISH_WRITE, version: moduleVersion, synthetic: false, policy: policy.fields.Name, label: name, publishedAtStart: published,
      ok: false, readBackVerified: false, putBack: false, collateralUnchanged: false, capturedAt: null, error: null,
    };
    const policyNow = async () => (await read('collector', collector)).resources.find((entry) => entry.resourceKey === policy.resourceKey) ?? null;
    let removed = false;
    try {
      // 2. Publish it first when the policy does not yet, so there is something to remove.
      if (!published) {
        await add(policy, label);
        if (!has((await policyNow())?.fields?.Labels, name)) throw new Error(`${name} did not read back published before the removal`);
      }
      // 3. The write being proven.
      await remove(policy, label);
      removed = true;
      const after = await policyNow();
      capture.readBackVerified = Boolean(after) && after.fieldCoverage?.Labels?.status === 'observed' && !has(after.fields.Labels, name);
      if (!capture.readBackVerified) throw new Error(`${name} still reads back published after the removal`);
      // 4. Put it back.
      if (published) await add(policy, label);
    } catch (error) {
      capture.error = error?.detail?.message ?? error.message;
    }
    // 5. Everything as it started.
    try {
      const end = await read('collector', collector);
      const policyEnd = end.resources.find((entry) => entry.resourceKey === policy.resourceKey) ?? null;
      capture.putBack = comparable(policyEnd) === comparable(policy);
      const others = (resources) => Object.fromEntries(resources.filter((entry) => entry.resourceKey !== policy.resourceKey)
        .map((entry) => [entry.resourceKey, definitionFingerprint(entry)]));
      capture.collateralUnchanged = JSON.stringify(others(end.resources)) === JSON.stringify(others(start.resources));
      if (!capture.putBack) {
        needsManualRevert = { policy: policy.fields.Name, label: name, publish: published && !has(policyEnd?.fields?.Labels, name), unpublish: !published && has(policyEnd?.fields?.Labels, name) };
        capture.error = capture.error ?? `${policy.fields.Name} does not read back as it started`;
      }
      if (!capture.collateralUnchanged) capture.error = capture.error ?? 'another label or policy changed during the capture';
      log.values.end = { policy: policyEnd?.fields ?? null };
    } catch (error) {
      capture.error = capture.error ?? error.message;
      needsManualRevert = { policy: policy.fields.Name, label: name, publish: published && removed, unpublish: !published };
    }
    capture.ok = capture.readBackVerified && capture.putBack && capture.collateralUnchanged && capture.error === null;
    capture.capturedAt = now().toISOString();
    log.values.start = { policy: policy.fields, label: name, published };
    writes.push(capture);
  }
  if (refusal) skipped.push({ operationId: UNPUBLISH_WRITE, reason: refusal });

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: UNPUBLISH_LIVE_GATE,
    tenantRef,
    build,
    operation: UNPUBLISH_LIVE_OPERATION,
    credentialMode: UNPUBLISH_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      execution: { transport: UNPUBLISH_TRANSPORT, module: PURVIEW_MODULE, moduleVersion },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      refusals,
      writes,
      skipped,
      requests,
      captureLogSha256: sha256Hex(captureLog),
    },
  };
  return { ...pseudonymizeCapture({ record, log }), needsManualRevert };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one live
 * write capture, the restorer's grants and the module version the capture is bound to.
 * Anything else yields none.
 */
export function ledgerEvidenceFromUnpublishAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: UNPUBLISH_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${UNPUBLISH_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: [],
    writes: provenUnpublishWrites(subject).map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: null,
    restorerGrants: { permissions: [...(subject.grants.restorer.permissions ?? [])], roles: [...subject.grants.restorer.roles] },
    runtime: { modules: { [PURVIEW_MODULE]: subject.execution.moduleVersion } },
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
  out = console.log, env = process.env, readFile = (path) => readFileSync(path, 'utf8'), capture = captureUnpublish,
  pins = () => pinnedModuleVersions(readFileSync(POWERSHELL_DOCKERFILE, 'utf8')),
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(unpublishCapturePlan(), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: purviewUnpublishLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(unpublishCapturePlan(), null, 2));
    out('refused: a capture removes one KEEL-RT- label from one KEEL-RT- label policy and puts it back; rerun with --confirm-live-tenant-write');
    return 2;
  }
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'], ['--grants', 'grants'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate config files');
  if (basename(options.out) !== UNPUBLISH_RECORD_FILE) throw new Error(`--out must be named ${UNPUBLISH_RECORD_FILE}, where the import looks for it`);
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const collectorConfig = readConfigFile(options.collectorConfig, { readFile, what: 'Purview collector settings' });
  const restorerConfig = readConfigFile(options.restorerConfig, { readFile, what: 'Purview restorer settings' });
  if (typeof collectorConfig.tenantId !== 'string' || options.tenantRef !== tenantRefFor(collectorConfig.tenantId)) throw new Error('--tenant-ref is not the tenant the collector config names; nothing was sent');
  if (restorerConfig.tenantId !== collectorConfig.tenantId) throw new Error('the restorer config names another tenant; nothing was sent');
  if (restorerConfig.clientId && restorerConfig.clientId === collectorConfig.clientId) throw new Error('the restorer config is the collector app; nothing was sent');
  const outPath = resolve(options.out);
  const { record, captureLog, needsManualRevert } = await capture({
    collector: { tenantConfigPath: options.collectorConfig }, restorer: { tenantConfigPath: options.restorerConfig },
    tenantRef: options.tenantRef, build, credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: readConfigFile(options.grants, { readFile, what: 'restorer grants' }), moduleVersion: pins()[PURVIEW_MODULE] ?? null,
  });
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: UNPUBLISH_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  const proven = provenUnpublishWrites(evidence.subject).map((item) => item.operationId);
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath, proven, skipped: evidence.subject.skipped, needsManualRevert,
    notProven: evidence.subject.writes.filter((item) => !proven.includes(item.operationId)).map(({ operationId, error }) => ({ operationId, error })),
    verify: result,
  }, null, 2));
  if (needsManualRevert) return 3;
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
