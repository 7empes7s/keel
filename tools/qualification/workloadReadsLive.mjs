#!/usr/bin/env node
/**
 * Live read proof for the Wave 2 cmdlet workloads (mail flow, Exchange settings, Teams
 * org-wide, Teams voice and live events, Purview retention and DLP, retention labels),
 * and for SharePoint's per-site sharing read (`--workload sharepoint-site-settings`,
 * one `Get-PnPTenantSite` with the PnP collector config).
 *
 * Their reads ship disabled until each one is live-qualified in the task-101 ledger, and
 * the scheduled `workload-collect` job builds that ledger only from signed records it
 * imports. Until now no record carried these reads, so the groups stayed off on live.
 * This tool is read-only: it runs the workload's own collector once with the collector
 * credential, through the bounded job transport and the production allowlists, and
 * records which reads answered. It sends no Set-, New- or Remove- cmdlet.
 *
 *   node tools/qualification/workloadReadsLive.mjs plan --workload exchange-mail-flow
 *     Offline. Prints the cmdlets a capture would send. No network.
 *
 *   KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/workloadReadsLive.mjs capture \
 *        --workload <workload> --tenant-ref sha256:... --collector-ref app:<collector app id> \
 *        --collector-config /etc/keel/<collector>.json --build <sha> \
 *        --out docs/release/qualifications/workload-reads-<workload>-live-acceptance.json \
 *        [--powershell-image <tag>] [--site https://<tenant>.sharepoint.com/sites/KEEL-RT-... (sharepoint-structure, repeatable)]
 *
 * The record keeps, per read: its operation, family, status, object count, the module
 * version and the error code when it failed. No object, field value, name or tenant id
 * is kept. A read is proof only when its family answered in full (`read`); an empty
 * answer counts. Signed as `keel-release-runner` with KEEL_QUALIFICATION_HMAC_KEY.
 *
 * ledgerEvidenceFromWorkloadReadsAcceptance() is the import seam: a record that passes
 * `verify --require-live` becomes one live capture per read that answered, bound to the
 * module version the image pins. The collector's grants are left as the other records
 * stored them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { structuredFailure } from '../../engine/collect/workloads/exchange.mjs';
import {
  EXCHANGE_ORG_ACCESS_WORKLOAD, EXCHANGE_ORG_DEFAULTS_WORKLOAD, readExchangeOrgAccess, readExchangeOrgDefaults,
} from '../../engine/collect/workloads/exchangeOrgPolicies.mjs';
import { DEFENDER_EMAIL_WORKLOAD, readDefenderEmail } from '../../engine/collect/workloads/defenderEmail.mjs';
import { readExchangeRoleGroups } from '../../engine/collect/workloads/exchangeRoleGroups.mjs';
import {
  EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD, EXCHANGE_RECIPIENTS_WORKLOAD, readExchangeDistributionGroups, readExchangeRecipients,
} from '../../engine/collect/workloads/exchangeRecipients.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence, verifyEvidence } from '../release/qualification.mjs';
import { pseudonymizeCapture } from './pseudonymize.mjs';
import {
  READ_FAMILIES, WORKLOAD_READS_CREDENTIAL_MODE, WORKLOAD_READS_LIVE_GATE, WORKLOAD_READS_LIVE_OPERATION, WORKLOAD_READS_TRANSPORT,
  knownWorkload, provenReads, readModule, workloadReads, workloadReadsCapturePlan, workloadReadsRecordFile,
} from './workloadReadsAcceptance.mjs';
import { SHAREPOINT_WORKLOAD, readSiteSharing } from '../../engine/collect/workloads/sharepoint.mjs';
import { SHAREPOINT_STRUCTURE_WORKLOAD, readSharePointStructure } from '../../engine/collect/workloads/sharepointStructure.mjs';
import {
  TEAMS_DEVICE_POLICIES_WORKLOAD, TEAMS_VOICE_NETWORK_WORKLOAD, readTeamsDevicePolicies, readTeamsVoiceNetwork,
} from '../../engine/collect/workloads/teamsVoiceNetwork.mjs';
import { WORKLOAD_READERS as WRITTEN_READERS, pinnedModuleVersions } from './workloadWritesLive.mjs';
import { readConfigFile } from '../../engine/config/configFile.mjs';

/**
 * The SharePoint per-site sharing read, in the shape the written workloads' readers
 * answer: one `site-sharing` family, `read` with the number of sites listed.
 */
export async function readSharePointSiteSharing({ powershell }) {
  try {
    const sites = await readSiteSharing(powershell);
    return { outcome: 'complete', discovery: { families: { 'site-sharing': { status: 'read', objects: sites.size } } }, failures: [] };
  } catch (error) {
    return { outcome: 'failed', discovery: { families: { 'site-sharing': { status: 'failed', objects: 0 } } }, failures: [{ family: 'site-sharing', error: structuredFailure(error).error }] };
  }
}

export const WORKLOAD_READERS = Object.freeze({
  ...WRITTEN_READERS, [SHAREPOINT_WORKLOAD]: readSharePointSiteSharing, 'exchange-role-groups': readExchangeRoleGroups,
  [EXCHANGE_DISTRIBUTION_GROUPS_WORKLOAD]: readExchangeDistributionGroups, [EXCHANGE_RECIPIENTS_WORKLOAD]: readExchangeRecipients,
  [SHAREPOINT_STRUCTURE_WORKLOAD]: readSharePointStructure,
  [TEAMS_VOICE_NETWORK_WORKLOAD]: readTeamsVoiceNetwork, [TEAMS_DEVICE_POLICIES_WORKLOAD]: readTeamsDevicePolicies,
  [EXCHANGE_ORG_ACCESS_WORKLOAD]: readExchangeOrgAccess, [EXCHANGE_ORG_DEFAULTS_WORKLOAD]: readExchangeOrgDefaults,
  [DEFENDER_EMAIL_WORKLOAD]: readDefenderEmail,
});

/**
 * What a workload's reader needs beside the collector, from the capture's arguments and the
 * collector config: SharePoint structure reads the templates of the sites named with --site,
 * on the host of the config's admin site. Other workloads need nothing.
 */
export function readOptionsFor(workload, { sites = [], collectorConfig = {} } = {}) {
  if (workload !== SHAREPOINT_STRUCTURE_WORKLOAD) {
    if (sites.length) throw new Error(`--site is only for --workload ${SHAREPOINT_STRUCTURE_WORKLOAD}`);
    return {};
  }
  let adminHost = '';
  try { adminHost = new URL(String(collectorConfig.sharePointAdminUrl ?? '')).hostname.toLowerCase(); } catch { adminHost = ''; }
  if (!/^[a-z0-9-]+-admin\.sharepoint\.com$/.test(adminHost)) throw new Error('the collector config names no SharePoint admin site (sharePointAdminUrl); nothing was sent');
  if (!sites.length) throw new Error('a SharePoint structure capture needs at least one --site (a KEEL-RT- site); nothing was sent');
  return { sites, tenantHost: adminHost.replace(/-admin\.sharepoint\.com$/, '.sharepoint.com') };
}

export { READ_FAMILIES, WORKLOAD_READS_LIVE_GATE, workloadReadsCapturePlan, workloadReadsRecordFile };

const MODULE_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;

/**
 * Runs the workload's collector once with the collector's PowerShell options. Returns the
 * unsigned record, with ids such as the collector's app id pseudonymized so it can be
 * published, and, for the operator only, each failed read's error message (messages can
 * name the tenant, so they stay out of the record). It never signs or writes files.
 */
export async function captureWorkloadReads({
  workload, collector, read = WORKLOAD_READERS[workload], tenantRef, build, credential, moduleVersion, now = () => new Date(), readOptions = {},
}) {
  knownWorkload(workload);
  const module = readModule(workload);
  const problems = [];
  if (!tenantRef || !build) problems.push('a capture needs --tenant-ref and a build');
  if (typeof credential !== 'string' || !credential.trim()) problems.push('a capture needs --collector-ref');
  if (typeof moduleVersion !== 'string' || !MODULE_VERSION_RE.test(moduleVersion)) problems.push(`the ${module} version is unknown`);
  if (problems.length) throw new Error(problems.join('; '));

  const declared = workloadReads(workload);
  let result = null;
  let error = null;
  try {
    result = await read({ ...readOptions, powershell: collector, families: declared.map((item) => item.family) });
  } catch (failure) {
    error = failure;
  }
  const capturedAt = now().toISOString();
  const diagnostics = [];
  const failureOf = (family) => [...(result?.failures ?? []), ...(result?.unavailable ?? [])].find((item) => item.family === family) ?? null;
  const reads = declared.map(({ family, operationId }) => {
    const summary = result?.discovery?.families?.[family] ?? null;
    const status = summary?.status ?? 'failed';
    const failed = failureOf(family);
    const detail = failed?.error ?? (error ? structuredFailure(error).error : null);
    const code = [detail?.code, detail?.errorId].filter(Boolean).join(':') || null;
    if (status !== 'read') diagnostics.push({ operationId, status, message: detail?.message ?? (summary ? null : 'the collector did not read this family') });
    return {
      operationId, family, version: moduleVersion, synthetic: false, capturedAt,
      ok: status === 'read', status, objects: summary?.objects ?? 0, error: status === 'read' ? null : (code ?? status),
    };
  });
  const record = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: WORKLOAD_READS_LIVE_GATE,
    tenantRef,
    build,
    operation: WORKLOAD_READS_LIVE_OPERATION,
    credentialMode: WORKLOAD_READS_CREDENTIAL_MODE,
    observedAt: capturedAt,
    evidenceLevel: 'live-qualified',
    synthetic: false,
    subject: {
      workload,
      execution: { transport: WORKLOAD_READS_TRANSPORT, module, moduleVersion },
      credentials: { collector: credential },
      outcome: result?.outcome ?? 'failed',
      reads,
    },
  };
  return { record: pseudonymizeCapture({ record, log: {} }).record, diagnostics };
}

/**
 * The import seam: a record that passes the gate with --require-live becomes one live
 * capture per read that answered, and the module version they are bound to. Anything
 * else becomes nothing. Grants are not changed here.
 */
export function ledgerEvidenceFromWorkloadReadsAcceptance(evidence, options = {}) {
  const result = verifyEvidence(evidence, { ...options, gate: WORKLOAD_READS_LIVE_GATE, requireLive: true });
  if (!result.ok) return { ok: false, failures: result.failures, reads: [], writes: [], grants: null, restorerGrants: null, runtime: null };
  const { subject, tenantRef } = evidence;
  const proofRef = `${WORKLOAD_READS_LIVE_GATE}/${subject.workload}@${evidence.observedAt}`;
  return {
    ok: true,
    failures: [],
    reads: provenReads(subject).map((item) => ({
      operationId: item.operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: item.capturedAt,
      version: item.version, ok: true, error: null, observed: { objects: item.objects }, proofRef,
    })),
    writes: [],
    grants: null,
    restorerGrants: null,
    runtime: { modules: { [subject.execution.module]: subject.execution.moduleVersion } },
  };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { command, sites: [] };
  const names = {
    '--workload': 'workload', '--tenant-ref': 'tenantRef', '--collector-ref': 'collectorRef', '--collector-config': 'collectorConfig',
    '--out': 'out', '--build': 'build', '--powershell-image': 'image',
  };
  for (let index = 0; index < rest.length; index += 1) {
    // --site may be given more than once.
    if (rest[index] === '--site') { options.sites.push(rest[++index]); continue; }
    if (!names[rest[index]]) throw new Error(`unknown argument: ${rest[index]}`);
    options[names[rest[index]]] = rest[++index];
  }
  return options;
}

const POWERSHELL_DOCKERFILE = new URL('../../ops/powershell/Dockerfile', import.meta.url);

export async function main(argv = process.argv.slice(2), {
  out = console.log, env = process.env, readFile = (path) => readFileSync(path, 'utf8'), capture = captureWorkloadReads,
  powershell = (tenantConfigPath, image) => ({ tenantConfigPath, ...(image ? { image } : {}) }),
  pins = () => pinnedModuleVersions(readFileSync(POWERSHELL_DOCKERFILE, 'utf8')), write = writeFileSync,
} = {}) {
  const options = parseArgs(argv);
  if (options.command === 'plan') {
    out(JSON.stringify(workloadReadsCapturePlan(options), null, 2));
    return 0;
  }
  if (options.command !== 'capture') throw new Error('usage: workloadReadsLive.mjs plan|capture --workload <workload> ...');
  for (const [flag, key] of [['--workload', 'workload'], ['--tenant-ref', 'tenantRef'], ['--collector-ref', 'collectorRef'], ['--collector-config', 'collectorConfig'], ['--out', 'out']]) {
    if (!options[key]) throw new Error(`capture needs ${flag}`);
  }
  knownWorkload(options.workload);
  if (basename(options.out) !== workloadReadsRecordFile(options.workload)) {
    throw new Error(`--out must be named ${workloadReadsRecordFile(options.workload)}, where the import looks for it`);
  }
  const build = options.build ?? env.KEEL_QUALIFICATION_BUILD;
  if (!build) throw new Error('capture needs --build (or KEEL_QUALIFICATION_BUILD): the build this capture qualifies');
  const collectorConfig = readConfigFile(options.collectorConfig, { readFile, what: 'collector settings' });
  const { tenantId } = collectorConfig;
  if (typeof tenantId !== 'string' || options.tenantRef !== tenantRefFor(tenantId)) {
    throw new Error('--tenant-ref is not the tenant the collector config names; nothing was sent');
  }
  const module = readModule(options.workload);
  const moduleVersion = pins()[module];
  if (!moduleVersion) throw new Error(`ops/powershell/Dockerfile pins no ${module} version; nothing was sent`);
  const readOptions = readOptionsFor(options.workload, { sites: options.sites, collectorConfig });
  const { record, diagnostics } = await capture({
    workload: options.workload, collector: powershell(options.collectorConfig, options.image), readOptions,
    tenantRef: options.tenantRef, build, credential: options.collectorRef, moduleVersion,
  });
  const hmacKey = env.KEEL_QUALIFICATION_HMAC_KEY ?? null;
  const evidence = hmacKey ? signEvidence(record, hmacKey, 'keel-release-runner') : record;
  const outPath = resolve(options.out);
  write(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  const result = verifyEvidence(evidence, { gate: WORKLOAD_READS_LIVE_GATE, tenantRef: options.tenantRef, build, requireLive: true, evidenceDir: dirname(outPath), hmacKey });
  out(JSON.stringify({
    evidence: outPath,
    outcome: evidence.subject.outcome,
    proven: provenReads(evidence.subject).map((item) => item.operationId),
    notProven: evidence.subject.reads.filter((item) => !item.ok).map(({ operationId, status, error }) => ({
      operationId, status, error, message: diagnostics.find((entry) => entry.operationId === operationId)?.message ?? null,
    })),
    verify: result,
  }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
