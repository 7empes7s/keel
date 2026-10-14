#!/usr/bin/env node
// /opt/keel/cli/keel-workload-collect.mjs
//
// node keel-workload-collect.mjs run [--config /etc/keel/tenant.json] [--scope /etc/keel/workload-scope.json]
//                                    [--tenant-ref REF] [--db-url $KEEL_DB_URL]
// node keel-workload-collect.mjs import [--config /etc/keel/tenant.json] [--dir docs/release/qualifications]
//                                       [--build SHA] [--db-url $KEEL_DB_URL]
// node keel-workload-collect.mjs proof [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//
// Gap W1: scheduled workload settings collection (the `workload-collect` job kind).
//   run     rebuilds the task-101 workload ledger from the live proof stored in the
//           database, then runs every workload collector in its gated order (SharePoint,
//           Teams, Exchange, OneDrive, Purview labels, mail flow, Teams org policies,
//           Purview retention and DLP). A workload the ledger does not enable records a
//           `disabled` run and sends nothing. Every request is a read: the Graph
//           transport refuses anything but GET, and each collector keeps its own
//           read-only allowlist. Each run is a workload snapshot a restore can use.
//   import  reads the four signed live acceptance records (SharePoint, Teams, Exchange,
//           OneDrive and Purview), verifies each through its own import seam, and stores
//           the evidence rows, the collector and restorer grants and the module versions.
//           A record that does not verify stores nothing. Run it after every recapture.
//           Each record is verified at the build it was captured on, not the running
//           build (see importLedgerInputs). --build, when given, names the running build
//           for the report only.
//   proof   (gap W3) prints when each stored live proof expires. Exits 1 when any proof
//           has expired or expires within 14 days, so a monthly check can raise it.
//
// The scope file names what the collectors may read beyond tenant-wide settings:
//   { "sharepointHost": "contoso.sharepoint.com", "mailboxes": ["user@contoso.com"],
//     "onedriveHost": "contoso-my.sharepoint.com", "onedriveSites": ["https://contoso-my.sharepoint.com/personal/..."],
//     "powershellConfigs": { "exchange": "/etc/keel/exchange-collector.json", "onedrive": "/etc/keel/purview-collector.json",
//                            "purview": "/etc/keel/purview-collector.json", "teams": "/etc/keel/teams-collector.json" } }
// It is optional; without it SharePoint cannot run and Exchange reads organization settings only.
// powershellConfigs names the certificate config each PowerShell module connects with (the
// Graph tenant config has no `organization` or certificate, so Exchange, OneDrive and Purview
// cannot connect with it). A family it leaves out uses --config. Each file must be under
// /etc/keel (the container mounts only that) and name the same tenant as --config.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getToken } from '../tools/tenant-probe/auth.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { loadLedgerInputs, loadWorkloadLedger, proofExpiry, saveLedgerInputs } from '../engine/collect/workloadLedgerStore.mjs';
import { SHAREPOINT_WORKLOAD, collectSharePointSites, recordSharePointRun } from '../engine/collect/workloads/sharepoint.mjs';
import { collectTeams, recordTeamsRun } from '../engine/collect/workloads/teams.mjs';
import { collectExchange, recordExchangeRun } from '../engine/collect/workloads/exchange.mjs';
import { collectOneDrive, recordOneDriveRun } from '../engine/collect/workloads/onedrive.mjs';
import { collectPurview, recordPurviewRun } from '../engine/collect/workloads/purview.mjs';
import { collectMailFlow, recordMailFlowRun } from '../engine/collect/workloads/mailFlow.mjs';
import { collectTeamsPolicies, recordTeamsPolicyRun } from '../engine/collect/workloads/teamsPolicies.mjs';
import { collectRetentionDlp, recordRetentionDlpRun } from '../engine/collect/workloads/purviewRetentionDlp.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_RECORD_DIR = join(__dirname, '..', 'docs', 'release', 'qualifications');
export const DEFAULT_SCOPE_PATH = '/etc/keel/workload-scope.json';
const GRAPH_HOST = 'graph.microsoft.com';

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * A Graph transport that can only read. A non-GET request, or a request to any host
 * but Microsoft Graph, is refused before it is sent. The token never leaves the closure.
 */
export function readOnlyGraphTransport(tokenSource, fetchImpl = globalThis.fetch) {
  let token = null;
  return async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || init?.body !== undefined) throw new Error(`workload collection is read-only: refused ${method} ${url}`);
    if (new URL(url).hostname !== GRAPH_HOST) throw new Error(`workload collection reads Microsoft Graph only: refused ${url}`);
    token ??= await tokenSource();
    const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}

/**
 * The collectors in their gated order. Each later workload's activation requires the
 * earlier ones, so the order only decides the order of the log, never what may run.
 */
// Which PowerShell config family each PowerShell workload connects with.
export const POWERSHELL_FAMILY = {
  'exchange-mailbox-settings': 'exchange',
  'exchange-mail-flow': 'exchange',
  'onedrive-site-settings': 'onedrive',
  'purview-labels': 'purview',
  'purview-retention-dlp': 'purview',
  'teams-org-policies': 'teams',
};
const POWERSHELL_FAMILIES = new Set(Object.values(POWERSHELL_FAMILY));
const CONFIG_DIR = '/etc/keel/';

/**
 * The PowerShell config path per family, from the scope file. Throws on an unknown
 * family, a path outside /etc/keel, or a file that names another tenant, so a
 * misconfigured host fails the run loudly instead of connecting somewhere else.
 */
export function powershellConfigPaths(scope, { config, readFile }) {
  const paths = scope?.powershellConfigs ?? {};
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) throw new Error('powershellConfigs must be an object');
  for (const [family, path] of Object.entries(paths)) {
    if (!POWERSHELL_FAMILIES.has(family)) throw new Error(`powershellConfigs.${family} is not a PowerShell family (${[...POWERSHELL_FAMILIES].join(', ')})`);
    if (typeof path !== 'string' || !resolve(path).startsWith(CONFIG_DIR) || resolve(path) !== path) {
      throw new Error(`powershellConfigs.${family} must be an absolute path under ${CONFIG_DIR}`);
    }
    const tenantId = JSON.parse(readFile(path)).tenantId;
    if (tenantId !== undefined && tenantId !== config.tenantId) {
      throw new Error(`powershellConfigs.${family} names another tenant than the tenant config: refusing to collect`);
    }
  }
  return { ...paths };
}

/** The PowerShell options one workload runs with: its family's config, else the default. */
export function powershellFor(workload, { scope = {}, powershell = {} }) {
  const path = scope.powershellConfigs?.[POWERSHELL_FAMILY[workload]];
  return path ? { ...powershell, tenantConfigPath: path } : powershell;
}

export function workloadSteps({ config, scope, transport, powershell }) {
  const common = { sleep };
  const shellFor = (workload) => powershellFor(workload, { scope, powershell });
  return [
    { workload: SHAREPOINT_WORKLOAD, record: recordSharePointRun,
      collect: (client, base) => collectSharePointSites(client, { ...base, ...common, transport, tenantHost: scope.sharepointHost }) },
    { workload: 'teams-settings', record: recordTeamsRun,
      collect: (client, base) => collectTeams(client, { ...base, ...common, transport, tenantId: config.tenantId }) },
    { workload: 'exchange-mailbox-settings', record: recordExchangeRun,
      collect: (client, base) => collectExchange(client, { ...base, ...common, transport, powershell: shellFor('exchange-mailbox-settings'), mailboxes: scope.mailboxes ?? [] }) },
    { workload: 'onedrive-site-settings', record: recordOneDriveRun,
      collect: (client, base) => collectOneDrive(client, { ...base, powershell: shellFor('onedrive-site-settings'), sites: scope.onedriveSites ?? [], myHost: scope.onedriveHost }) },
    { workload: 'purview-labels', record: recordPurviewRun, collect: (client, base) => collectPurview(client, { ...base, powershell: shellFor('purview-labels') }) },
    { workload: 'exchange-mail-flow', record: recordMailFlowRun, collect: (client, base) => collectMailFlow(client, { ...base, powershell: shellFor('exchange-mail-flow') }) },
    { workload: 'teams-org-policies', record: recordTeamsPolicyRun, collect: (client, base) => collectTeamsPolicies(client, { ...base, powershell: shellFor('teams-org-policies') }) },
    { workload: 'purview-retention-dlp', record: recordRetentionDlpRun, collect: (client, base) => collectRetentionDlp(client, { ...base, powershell: shellFor('purview-retention-dlp') }) },
  ];
}

/**
 * One scheduled run. A collector that throws (a missing scope entry, a container that
 * would not start) is recorded as a `failed` run with the reason, and the next
 * workload still runs.
 */
export async function runWorkloadCollection(client, { tenantRef, config, scope = {}, transport, powershell = {}, now = () => new Date(), logger = console }) {
  const { ledger, inputs } = await loadWorkloadLedger(client, { tenantRef, now: now() });
  const runs = [];
  for (const step of workloadSteps({ config, scope, transport, powershell })) {
    const base = { tenantRef, ledger, now };
    let run;
    let reasons = [];
    try {
      const outcome = await step.collect(client, base);
      run = outcome.run;
      reasons = outcome.activation?.enabled ? [] : outcome.activation?.reasons ?? [];
    } catch (error) {
      const at = now().toISOString();
      reasons = [String(error?.message ?? error)];
      run = await step.record(client, {
        tenantRef,
        result: { workload: step.workload, outcome: 'failed', observedFrom: at, observedTo: at, reasons },
      });
    }
    runs.push({ workload: step.workload, outcome: run.outcome, collectionId: run.id, reasons });
    logger.log(`${step.workload}: ${run.outcome}${run.outcome === 'disabled' ? ' (not qualified; nothing was read)' : ''}`);
  }
  const proof = proofExpiry([...inputs.reads, ...inputs.writes], { now: now() });
  for (const entry of proof.filter((item) => item.status !== 'current')) logger.log(entry.message);
  const exitCode = runs.some((item) => ['failed', 'partial'].includes(item.outcome)) ? 1 : 0;
  return { tenantRef, runs, proof, exitCode };
}

/** The four live acceptance records and the import seam each one goes through. */
export async function importSeams() {
  const [{ ledgerEvidenceFromAcceptance }, { ledgerEvidenceFromTeamsAcceptance }, { ledgerEvidenceFromExchangeAcceptance },
    { ledgerEvidenceFromOneDrivePurviewAcceptance }] = await Promise.all([
    import('../tools/qualification/sharepointLive.mjs'), import('../tools/qualification/teamsLive.mjs'),
    import('../tools/qualification/exchangeLive.mjs'), import('../tools/qualification/onedrivePurviewLive.mjs'),
  ]);
  return [
    { file: 'sharepoint-live-acceptance.json', seam: ledgerEvidenceFromAcceptance },
    { file: 'teams-live-acceptance.json', seam: ledgerEvidenceFromTeamsAcceptance },
    { file: 'exchange-live-acceptance.json', seam: ledgerEvidenceFromExchangeAcceptance },
    { file: 'onedrive-purview-live-acceptance.json', seam: ledgerEvidenceFromOneDrivePurviewAcceptance },
  ];
}

const union = (list) => {
  const present = list.filter(Boolean);
  if (!present.length) return null;
  return {
    permissions: [...new Set(present.flatMap((item) => item.permissions ?? []))].sort(),
    roles: [...new Set(present.flatMap((item) => item.roles ?? []))].sort(),
  };
};

/**
 * Imports every record that verifies. `seams` is [{ file, seam }]; `verify` is passed
 * to each seam (hmacKey, now). Records that fail store nothing and are listed with
 * their failures.
 *
 * Which build a record is checked against: the build it names (the build the capture
 * ran on), never the running build. Master deploys many times a day, so requiring the
 * running build would void every workload proof on the next unrelated deploy. The
 * record still has to hold for the code running now, because each gate validator
 * checks it against this build's declarations: every read and write is still
 * declared, at the same API or module version, with the same method, endpoint,
 * written fields and grants, so a changed write is refused with its own reason. The
 * signature, the same-tenant rule and the 30-day limit apply as before. This is the
 * rule the Entra live records and the portal's live records view already use.
 * `verify.build` (the running build) is only reported.
 */
export async function importLedgerInputs(client, { tenantRef, dir, seams, verify = {}, readFile = (path) => readFileSync(path, 'utf8') }) {
  const { build: runningBuild = null, ...checks } = verify;
  const imported = [];
  const refused = [];
  for (const { file, seam } of seams) {
    const path = join(dir, file);
    let record;
    try { record = JSON.parse(readFile(path)); } catch (error) { refused.push({ file, failures: [`unreadable: ${error.message}`] }); continue; }
    const evidenceBuild = typeof record?.build === 'string' && record.build ? record.build : null;
    const result = seam(record, { ...checks, build: evidenceBuild, tenantRef, evidenceDir: dir });
    if (!result.ok) { refused.push({ file, evidenceBuild, failures: result.failures }); continue; }
    imported.push({ file, evidenceBuild, ...result });
  }
  const evidence = imported.flatMap((item) => [...item.reads, ...item.writes]);
  const grants = union(imported.map((item) => item.grants));
  const restorerGrants = union(imported.map((item) => item.restorerGrants));
  const runtime = { modules: Object.assign({}, ...imported.map((item) => item.runtime?.modules ?? {})) };
  if (imported.length) await saveLedgerInputs(client, { tenantRef, evidence, grants, restorerGrants, runtime });
  return {
    tenantRef,
    runningBuild,
    imported: imported.map((item) => ({ file: item.file, evidenceBuild: item.evidenceBuild, reads: item.reads.length, writes: item.writes.length })),
    refused,
    exitCode: refused.length ? 1 : 0,
  };
}

export async function main(argv = process.argv.slice(2), {
  readFile = (path) => readFileSync(path, 'utf8'), connectFn = connect, getTokenFn = getToken, fetchImpl = globalThis.fetch,
  env = process.env, logger = console, seams,
} = {}) {
  const command = argv[0];
  if (!['run', 'import', 'proof'].includes(command) || argv.includes('--help')) {
    logger.log('usage: keel-workload-collect.mjs run|import|proof [--config /etc/keel/tenant.json] [--scope FILE] [--dir DIR] [--db-url URL]');
    return command === undefined || argv.includes('--help') ? 0 : 2;
  }
  const configPath = arg(argv, 'config', '/etc/keel/tenant.json');
  const config = JSON.parse(readFile(configPath));
  const tenantRef = tenantRefFor(config.tenantId);
  const requested = arg(argv, 'tenant-ref');
  if (requested !== undefined && requested !== tenantRef) {
    throw new Error('the job names another tenant than the tenant config: refusing to collect');
  }
  const dbUrl = arg(argv, 'db-url', env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connectFn(dbUrl);
  try {
    if (command === 'import') {
      const dir = resolve(arg(argv, 'dir', DEFAULT_RECORD_DIR));
      const result = await importLedgerInputs(client, {
        tenantRef, dir, seams: seams ?? await importSeams(), readFile,
        verify: { build: arg(argv, 'build', null), hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null },
      });
      logger.log(JSON.stringify(result, null, 2));
      return result.exitCode;
    }
    if (command === 'proof') {
      const { reads, writes } = await loadLedgerInputs(client, { tenantRef });
      const proof = proofExpiry([...reads, ...writes]);
      for (const entry of proof) logger.log(entry.message);
      if (!proof.length) logger.log('No workload live proof is stored. Run the import after a live capture.');
      return proof.length && proof.every((entry) => entry.status === 'current') ? 0 : 1;
    }
    const scopePath = arg(argv, 'scope', DEFAULT_SCOPE_PATH);
    const scope = arg(argv, 'scope') !== undefined || existsSync(scopePath) ? JSON.parse(readFile(scopePath)) : {};
    scope.powershellConfigs = powershellConfigPaths(scope, { config, readFile });
    const transport = readOnlyGraphTransport(async () => (await getTokenFn(config)).accessToken, fetchImpl);
    const result = await runWorkloadCollection(client, {
      tenantRef, config, scope, transport, powershell: { tenantConfigPath: configPath }, logger,
    });
    return result.exitCode;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
