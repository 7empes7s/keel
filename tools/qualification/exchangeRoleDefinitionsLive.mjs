#!/usr/bin/env node
/**
 * Custom Exchange admin role restore: capture the live proof its write needs before it may
 * run. The operator runs this against the test tenant, with the keel-powershell image;
 * builders and CI never point it at a tenant.
 *
 *   node tools/qualification/exchangeRoleDefinitionsLive.mjs plan
 *     Offline (the default). Prints what a capture would send. No network.
 *
 *   [KEEL_QUALIFICATION_HMAC_KEY=...] node tools/qualification/exchangeRoleDefinitionsLive.mjs capture --confirm-live-tenant-write \
 *        --tenant-ref sha256:... --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
 *        --collector-config /etc/keel/exchange-collector.json --restorer-config /etc/keel/exchange-restorer.json \
 *        --grants grants.json --out docs/release/qualifications/exchange-role-definitions-writes-live-acceptance.json \
 *        [--parent "Address Lists"] [--build <sha>]
 *
 * What a capture does, in order (and nothing else):
 *  0. offline: asks the transport for Remove-ManagementRole and for New-ManagementRole with
 *     a parameter Keel never sends; both must be refused before anything is sent;
 *  1. collector: lists every role (the parent must exist, KEEL-RT-capture-role-<random>
 *     must not) and reads the parent's entries;
 *  2. builds the backup a recreate would come from: the parent as a built-in role, and the
 *     capture role holding two of the parent's cmdlets, one of them with fewer parameters;
 *     plans it with the writer's own planner (the parent must be the one chosen);
 *  3. restorer: the writer's own create-and-trim step (New-ManagementRole, then
 *     Set-/Remove-ManagementRoleEntry on the new role only);
 *  4. collector: reads the new role back (entries and description exactly as planned) and
 *     the parent's entries again (unchanged).
 * Keel never deletes, so the capture role stays. It has no holders, so it grants nothing.
 * Tenant ids are pseudonymized. With KEEL_QUALIFICATION_HMAC_KEY set the record is signed as
 * `keel-release-runner`.
 *
 * ledgerEvidenceFromRoleWritesAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes one live write capture.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readConfigFile } from '../../engine/config/configFile.mjs';
import {
  EXCHANGE_ROLE_ADD, RoleWriteScopeError, entryDifferences, planExchangeRoleRestore, readLiveRoleEntries, readLiveRoles, recreateRole, roleCmdletRunner,
} from '../../engine/restore/workloads/exchangeRoleDefinitions.mjs';
import { EXCHANGE_ROLE_MODULE } from '../../engine/restore/workloads/exchangeRoleDeclarations.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, verifyEvidence } from '../release/qualification.mjs';
import {
  ROLE_CAPTURE_PREFIX, ROLE_WRITES_CREDENTIAL_MODE, ROLE_WRITES_LIVE_GATE, ROLE_WRITES_LIVE_OPERATION, ROLE_WRITES_RECORD_FILE, ROLE_WRITES_TRANSPORT,
  provenRoleWrites,
} from './exchangeRoleDefinitionsAcceptance.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import { writeAcceptanceFiles } from './sharepointLive.mjs';
import { pinnedModuleVersions } from './workloadWritesLive.mjs';

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
export const DEFAULT_PARENT = 'Address Lists';
const POWERSHELL_DOCKERFILE = new URL('../../ops/powershell/Dockerfile', import.meta.url);

/** Offline: what a capture would send, in order. */
export function roleWritesCapturePlan({ parent = DEFAULT_PARENT } = {}) {
  const name = `${ROLE_CAPTURE_PREFIX}<random>`;
  return [
    { step: 0, credential: 'none', refused: 'Remove-ManagementRole (Keel never removes a role; refused before sending)' },
    { step: 0, credential: 'none', refused: 'New-ManagementRole with -Force (a parameter Keel never sends; refused before sending)' },
    { step: 1, credential: 'collector', cmdlet: 'Get-ManagementRole', expect: `${parent} present, ${name} absent` },
    { step: 1, credential: 'collector', cmdlet: 'Get-ManagementRoleEntry', identity: `${parent}\\*`, expect: 'the parent\'s entries' },
    { step: 2, credential: 'none', plan: `the capture role holds two of ${parent}'s cmdlets, one with fewer parameters; the writer's planner must choose ${parent}` },
    { step: 3, credential: 'restorer', cmdlet: 'Get-ManagementRole', expect: `${name} still absent (the writer's check just before writing)` },
    { step: 3, credential: 'restorer', cmdlet: 'New-ManagementRole', parameters: { Name: name, Parent: parent, Description: 'KEEL-RT capture role <random>', EnabledCmdlets: ['<two cmdlets>'] }, operationId: EXCHANGE_ROLE_ADD },
    { step: 3, credential: 'restorer', cmdlet: 'Get-ManagementRoleEntry', identity: `${name}\\*` },
    { step: 3, credential: 'restorer', cmdlet: 'Set-ManagementRoleEntry', identity: `${name}\\<cmdlet>`, parameters: { Parameters: ['<the parameters the capture role does not hold>'], RemoveParameter: true } },
    { step: 3, credential: 'restorer', cmdlet: 'Remove-ManagementRoleEntry', identity: `${name}\\<cmdlet>`, when: 'only if New-ManagementRole copied cmdlets it was not asked for' },
    { step: 4, credential: 'collector', cmdlet: 'Get-ManagementRoleEntry', identity: `${name}\\*`, expect: 'exactly the planned entries' },
    { step: 4, credential: 'collector', cmdlet: 'Get-ManagementRole', expect: `${name} present with the planned description` },
    { step: 4, credential: 'collector', cmdlet: 'Get-ManagementRoleEntry', identity: `${parent}\\*`, expect: 'unchanged' },
  ];
}

const SNAPIN = '(Microsoft.Exchange.Management.PowerShell.E2010)';
const asAction = (cmdlet, parameters) => [SNAPIN, cmdlet, ...parameters.map((name) => `-${name}`)].join(' ');
/** A Graph exchangeRoleDefinition record holding `entries`. */
const asRecord = (id, displayName, entries, { isBuiltIn, description }) => ({
  id, displayName, description, isBuiltIn, isEnabled: true,
  rolePermissions: [{ allowedResourceActions: Object.entries(entries).map(([cmdlet, parameters]) => asAction(cmdlet, parameters)), excludedResourceActions: [], condition: null }],
});

/** Two of the parent's cmdlets (reads first), the first cut to one parameter so the trim runs. */
export function chooseCaptureEntries(parentEntries) {
  const names = Object.keys(parentEntries).sort((a, b) => Number(!a.startsWith('Get-')) - Number(!b.startsWith('Get-')) || a.localeCompare(b));
  const first = names.find((name) => parentEntries[name].length >= 2);
  if (!first) return null;
  const second = names.find((name) => name !== first);
  if (!second) return null;
  return { [first]: [parentEntries[first].find((p) => /^identity$/i.test(p)) ?? parentEntries[first][0]], [second]: [...parentEntries[second]] };
}

/**
 * Runs a capture. `collector` and `restorer` are the cmdlet job options for each
 * identity's Exchange config. Returns the unsigned record and the capture log,
 * pseudonymized; it never signs and never writes files.
 */
export async function captureRoleWrites({
  collector, restorer, tenantRef, tenantId, build, credentials, grants, moduleVersion, parent = DEFAULT_PARENT, runner = roleCmdletRunner,
  now = () => new Date(), suffix = () => randomBytes(4).toString('hex'),
}) {
  const problems = [];
  if (!tenantRef || !build) problems.push('a capture needs --tenant-ref and a build');
  if (!credentials?.collector || !credentials?.restorer || credentials.collector === credentials.restorer) problems.push('a capture needs two separate credential references (collector, restorer)');
  if (!grants?.restorer || !Array.isArray(grants.restorer.roles)) problems.push('--grants must name the restorer\'s roles');
  if (typeof moduleVersion !== 'string' || !moduleVersion) problems.push(`the ${EXCHANGE_ROLE_MODULE} version the image pins is unknown`);
  if (problems.length) throw new Error(problems.join('; '));

  const requests = [];
  const log = { requests, values: {} };
  const recorded = (credential, run) => async (call) => {
    const parameters = call.parameters ?? {};
    const role = typeof parameters.Name === 'string' ? parameters.Name : (typeof parameters.Identity === 'string' ? parameters.Identity.split('\\')[0] : null);
    const entry = { credential, cmdlet: call.cmdlet, role, parameters: Object.keys(parameters).sort(), outcome: 'ok', at: now().toISOString() };
    try {
      const output = await run(call);
      requests.push(entry);
      return output;
    } catch (error) {
      if (error instanceof RoleWriteScopeError) throw error;
      requests.push({ ...entry, outcome: 'failed', error: error.message });
      throw error;
    }
  };
  const read = recorded('collector', runner(collector));
  const write = recorded('restorer', runner(restorer));

  // 0. Offline refusals: a role removal and an undeclared parameter never leave this process.
  const refusals = {
    removeRole: { cmdlet: 'Remove-ManagementRole', refused: false, sent: false },
    undeclaredParameter: { cmdlet: 'New-ManagementRole', parameter: 'Force', refused: false, sent: false },
  };
  const probe = `${ROLE_CAPTURE_PREFIX}refusal`;
  for (const [key, call] of [['removeRole', { cmdlet: 'Remove-ManagementRole', parameters: { Identity: probe } }],
    ['undeclaredParameter', { cmdlet: 'New-ManagementRole', parameters: { Name: probe, Parent: parent, Force: true } }]]) {
    const before = requests.length;
    try { await write(call); } catch (error) {
      refusals[key].refused = error instanceof RoleWriteScopeError;
      refusals[key].reason = error.message;
    }
    refusals[key].sent = requests.length !== before;
  }

  const name = `${ROLE_CAPTURE_PREFIX}${suffix()}`;
  const writes = [];
  const skipped = [];
  const created = [];
  let refusal = Object.values(refusals).every((item) => item.refused && !item.sent) ? null : 'the transport did not refuse a role removal or an undeclared parameter; nothing was written';

  // 1. The reads the writer depends on.
  let roles = null;
  let parentBefore = null;
  if (!refusal) {
    try {
      roles = await readLiveRoles(read);
      if (!roles.some((item) => item.name.toLowerCase() === parent.toLowerCase())) refusal = `the parent role ${parent} was not found; nothing was written`;
      else if (roles.some((item) => item.name.toLowerCase() === name.toLowerCase())) refusal = `${name} already exists; nothing was written`;
      else parentBefore = await readLiveRoleEntries(read, parent);
    } catch (error) { refusal = `a read failed (${error.message}); nothing was written`; }
  }

  // 2. The backup a recreate would come from, planned with the writer's own planner.
  let op = null;
  if (!refusal) {
    const wanted = chooseCaptureEntries(parentBefore);
    if (!wanted) refusal = `${parent} holds too few entries to show a trim; nothing was written`;
    else {
      const description = `KEEL-RT capture role ${name.slice(ROLE_CAPTURE_PREFIX.length)}`;
      const source = {
        collectionId: 'capture', outcome: 'complete', observedTo: now().toISOString(),
        roles: [
          { naturalKey: 'exchangeRoleDefinition:capture-parent', record: asRecord('capture-parent', parent, parentBefore, { isBuiltIn: true, description: `${parent} role` }) },
          { naturalKey: 'exchangeRoleDefinition:capture-role', record: asRecord('capture-role', name, wanted, { isBuiltIn: false, description }) },
        ],
      };
      const plan = planExchangeRoleRestore({ source, live: { roles, entries: {} }, tenantId, tenantRef, targets: [name], testTenantRefs: [tenantRef] });
      log.values.plan = { operations: plan.operations, manual: plan.manual, refusals: plan.refusals };
      [op] = plan.operations;
      if (!op) refusal = `the planner planned no recreate (${JSON.stringify(plan.manual.concat(plan.refusals)).slice(0, 300)}); nothing was written`;
      else if (op.parent.toLowerCase() !== parent.toLowerCase()) refusal = `the planner chose ${op.parent}, not ${parent}; nothing was written`;
    }
  }

  if (!refusal) {
    // 3. The writer's own create-and-trim step, with the restorer; first the check it makes just before writing.
    const capture = {
      operationId: EXCHANGE_ROLE_ADD, version: moduleVersion, synthetic: false, fixture: name, ok: false, readBackVerified: false, collateralUnchanged: false,
      trimmedParameters: 0, trimmedEntries: 0, enabledCmdletsHonoured: null, capturedAt: null, error: null,
    };
    let stillAbsent = false;
    try { stillAbsent = !(await readLiveRoles(write)).some((item) => item.name.toLowerCase() === name.toLowerCase()); } catch (error) { capture.error = `the restorer could not list roles (${error.message})`; }
    if (stillAbsent) {
      const result = await recreateRole(op, { cmdlet: write });
      log.values.result = result;
      if (result.outcome !== 'failed' && result.outcome !== 'refused') created.push({ kind: 'managementRole', name, parent: op.parent });
      capture.trimmedParameters = result.trimmed?.parameters ?? 0;
      capture.trimmedEntries = result.trimmed?.entries ?? 0;
      capture.enabledCmdletsHonoured = result.trimmed ? result.trimmed.entries === 0 : null;
      if (result.outcome !== 'verified') capture.error = `the writer answered ${result.outcome}: ${result.reasons.join('; ')}`;
      // 4. Read back with the collector, independently of the writer's own read-back.
      try {
        const after = await readLiveRoleEntries(read, name);
        const role = (await readLiveRoles(read)).find((item) => item.name.toLowerCase() === name.toLowerCase()) ?? null;
        const left = entryDifferences(after, op.entries);
        capture.readBackVerified = Boolean(role) && !left.removeEntries.length && !left.removeParameters.length && !left.missing.length
          && (role.description === null || role.description === op.description);
        const parentAfter = await readLiveRoleEntries(read, parent);
        const sameParent = entryDifferences(parentAfter, parentBefore);
        capture.collateralUnchanged = !sameParent.removeEntries.length && !sameParent.removeParameters.length && !sameParent.missing.length;
        if (!capture.collateralUnchanged) capture.error = `the parent role ${parent} changed`;
        log.values.readBack = { role, entries: after };
      } catch (error) { capture.error = capture.error ?? `the collector could not read the role back (${error.message})`; }
      capture.ok = result.outcome === 'verified' && capture.readBackVerified && capture.collateralUnchanged && capture.error === null;
    } else if (!capture.error) capture.error = `${name} appeared before the write; nothing was written`;
    capture.capturedAt = now().toISOString();
    writes.push(capture);
  }
  if (refusal) skipped.push({ operationId: null, reason: refusal });

  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: ROLE_WRITES_LIVE_GATE,
    tenantRef,
    build,
    operation: ROLE_WRITES_LIVE_OPERATION,
    credentialMode: ROLE_WRITES_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      execution: { transport: ROLE_WRITES_TRANSPORT, module: EXCHANGE_ROLE_MODULE, moduleVersion },
      credentials: { collector: credentials.collector, restorer: credentials.restorer },
      grants,
      refusals,
      parent,
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
 * write capture, the restorer's grants and the module version the capture is bound to.
 * Anything else yields none.
 */
export function ledgerEvidenceFromRoleWritesAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: ROLE_WRITES_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${ROLE_WRITES_LIVE_GATE}@${subject.captureLogSha256}`;
  return {
    ok: true,
    failures: [],
    reads: [],
    writes: provenRoleWrites(subject).map((item) => ({
      operationId: item.operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, readBackVerified: true, proofRef,
    })),
    grants: null,
    restorerGrants: { permissions: [...(subject.grants.restorer.permissions ?? [])], roles: [...subject.grants.restorer.roles] },
    runtime: { modules: { [EXCHANGE_ROLE_MODULE]: subject.execution.moduleVersion } },
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, confirm: false };
  const names = {
    '--tenant-ref': 'tenantRef', '--collector-ref': 'collectorRef', '--restorer-ref': 'restorerRef',
    '--collector-config': 'collectorConfig', '--restorer-config': 'restorerConfig', '--grants': 'grants', '--out': 'out', '--build': 'build',
    '--parent': 'parent',
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
  out = console.log, env = process.env, readFile = (path) => readFileSync(path, 'utf8'), capture = captureRoleWrites,
  pins = () => pinnedModuleVersions(readFileSync(POWERSHELL_DOCKERFILE, 'utf8')),
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(roleWritesCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: exchangeRoleDefinitionsLive.mjs plan|capture ...');
  if (!options.confirm) {
    out(JSON.stringify(roleWritesCapturePlan(options), null, 2));
    out(`refused: a capture creates one ${ROLE_CAPTURE_PREFIX} Exchange admin role in the tenant; rerun with --confirm-live-tenant-write`);
    return 2;
  }
  for (const [flag, key] of [['--tenant-ref', 'tenantRef'], ['--collector-ref', 'collectorRef'], ['--restorer-ref', 'restorerRef'],
    ['--collector-config', 'collectorConfig'], ['--restorer-config', 'restorerConfig'], ['--grants', 'grants'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  if (options.collectorConfig === options.restorerConfig) throw new Error('the collector and restorer must use separate config files');
  if (basename(options.out) !== ROLE_WRITES_RECORD_FILE) throw new Error(`--out must be named ${ROLE_WRITES_RECORD_FILE}, where the import looks for it`);
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
    tenantRef: options.tenantRef, tenantId: collectorConfig.tenantId, build, credentials: { collector: options.collectorRef, restorer: options.restorerRef },
    grants: readConfigFile(options.grants, { readFile, what: 'restorer grants' }), moduleVersion: pins()[EXCHANGE_ROLE_MODULE] ?? null,
    parent: options.parent ?? DEFAULT_PARENT,
  });
  const { evidence, logPath } = writeAcceptanceFiles({ record, captureLog, outPath, hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null });
  const result = verifyEvidence(evidence, { gate: ROLE_WRITES_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath) });
  const proven = provenRoleWrites(evidence.subject).map((item) => item.operationId);
  out(JSON.stringify({
    evidence: outPath, captureLog: logPath, proven, skipped: evidence.subject.skipped, created: evidence.subject.created,
    notProven: evidence.subject.writes.filter((item) => !proven.includes(item.operationId)).map(({ operationId, error }) => ({ operationId, error })),
    enabledCmdletsHonoured: evidence.subject.writes[0]?.enabledCmdletsHonoured ?? null,
    verify: result,
  }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
