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
//           database, then runs every workload collector registered in
//           engine/collect/workloads/registry.mjs, in its order. A workload the ledger
//           does not enable records a `disabled` run and sends nothing. Every request is a read: the Graph
//           transport refuses anything but GET, and each collector keeps its own
//           read-only allowlist. Each run is a workload snapshot a restore can use.
//   import  reads the four signed live acceptance records (SharePoint, Teams, Exchange,
//           OneDrive and Purview), and each Wave 2 writer capture record present (one per
//           written workload), each Wave 2 read capture record present (one per workload,
//           tools/qualification/workloadReadsLive.mjs), the site app grant and site permissions records (absent ones are listed, not refused), verifies each through
//           its own import seam, and stores the evidence rows, the collector and restorer
//           grants and the module versions. A record that does not verify stores nothing.
//           The collector's roles are also read live from the tenant (its Entra directory
//           roles, GET only, with the tenant config's app, which is the collector), so a
//           role granted after the records were captured counts on the next import.
//           Run it after every recapture, and after a role is granted to the collector.
//           Each record is verified at the build it was captured on, not the running
//           build (see importLedgerInputs). --build, when given, names the running build
//           for the report only.
//   proof   (gap W3) prints when each stored live proof expires. Exits 1 when any proof
//           has expired or expires within 14 days, so a monthly check can raise it.
//
// The scope file names what the collectors may read beyond tenant-wide settings:
//   { "sharepointHost": "contoso.sharepoint.com", "mailboxes": ["user@contoso.com"],
//     "onedriveHost": "contoso-my.sharepoint.com", "onedriveSites": ["https://contoso-my.sharepoint.com/personal/..."],
//     "sharepointStructureSites": ["https://contoso.sharepoint.com/sites/..."],
//     "powershellConfigs": { "exchange": "/etc/keel/exchange-collector.json", "onedrive": "/etc/keel/purview-collector.json",
//                            "purview": "/etc/keel/purview-collector.json", "sharepoint": "/etc/keel/purview-collector.json",
//                            "teams": "/etc/keel/teams-collector.json" } }
// It is optional; without it SharePoint cannot run and Exchange reads organization settings only.
// powershellConfigs names the certificate config each PowerShell module connects with (the
// Graph tenant config has no `organization` or certificate, so Exchange, OneDrive and Purview
// cannot connect with it). A family it leaves out uses --config. Each file must be under
// /etc/keel (the container mounts only that) and name the same tenant as --config.
import { existsSync, readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getToken } from '../tools/tenant-probe/auth.mjs';
import { connect } from '../engine/store/db.mjs';
import { parseCliArgs } from './args.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { loadLedgerInputs, loadWorkloadLedger, proofExpiry, saveLedgerInputs } from '../engine/collect/workloadLedgerStore.mjs';
import { WORKLOAD_COLLECTORS } from '../engine/collect/workloads/registry.mjs';
import { DEFAULT_SCOPE_PATH, POWERSHELL_FAMILY, powershellConfigPaths } from '../engine/collect/workloads/powershellConfigs.mjs';
import { detectWorkloadDrift } from '../engine/govern/workloadDrift.mjs';
import { listedReasons, progressTracker, progressWriter, reasonsLine } from '../engine/jobs/progress.mjs';
import { workloadGapReasons } from '../engine/collect/workloads/gaps.mjs';
import { INCOMPLETE_TYPES_PREFIX, PARTIAL_EXIT_CODE } from '../engine/collect/incomplete.mjs';
import { runComplianceChecks } from '../engine/benchmarks/runChecks.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_RECORD_DIR = join(__dirname, '..', 'docs', 'release', 'qualifications');
const GRAPH_HOST = 'graph.microsoft.com';

const ARGS = {
  name: 'keel-workload-collect',
  strings: ['config', 'scope', 'tenant-ref', 'dir', 'build', 'db-url'],
  booleans: ['help'],
  positionals: 1,
};

function arg(opts, name, fallback) {
  return opts[name] ?? fallback;
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

// The family configs live in engine/collect/workloads/powershellConfigs.mjs, shared
// with the restore and Discovery (issue #542).
export { DEFAULT_SCOPE_PATH, POWERSHELL_FAMILY, powershellConfigPaths };

function powershellForFamily(family, { scope = {}, powershell = {} }) {
  const path = family ? scope.powershellConfigs?.[family] : undefined;
  return path ? { ...powershell, tenantConfigPath: path } : powershell;
}

/** The PowerShell options one workload runs with: its family's config, else the default. */
export function powershellFor(workload, { scope = {}, powershell = {} }) {
  return powershellForFamily(POWERSHELL_FAMILY[workload], { scope, powershell });
}

/**
 * The collectors from engine/collect/workloads/registry.mjs, each bound to this run's
 * config, scope, transport and its family's PowerShell options.
 */
export function workloadSteps({ config, scope, transport, powershell, collectors = WORKLOAD_COLLECTORS }) {
  return collectors.map((entry) => ({
    workload: entry.workload,
    record: entry.record,
    collect: (client, base) => entry.collect(client, {
      base, config, scope, transport, sleep, powershell: powershellForFamily(entry.powershellFamily, { scope, powershell }),
    }),
  }));
}

/** How many settings a workload run stored, for the Job page; null when it cannot be read. */
async function settingsCount(client, collectionId) {
  if (!collectionId) return null;
  try {
    const { rows } = await client.query('SELECT count(*)::int AS settings FROM workload_observation WHERE collection_id = $1', [collectionId]);
    return Number.isSafeInteger(rows[0]?.settings) ? rows[0].settings : null;
  } catch {
    return null;
  }
}

/**
 * Exit codes (#447 for settings, the same rule as content backups). 0: every workload
 * read in full, or not switched on. 3: no workload failed and drift detection ran for
 * each, but some workloads were read only in part; they are named on stdout and the
 * run is partial, not failed. 1: any workload failed, or a drift detection failed.
 */
export function workloadExitCode(runs) {
  if (runs.some((run) => run.outcome === 'failed' || run.drift?.status === 'failed')) return 1;
  return runs.some((run) => run.outcome === 'partial') ? PARTIAL_EXIT_CODE : 0;
}

/** The workloads a run read only in part, in the shape the worker's partial result takes. */
export function incompleteWorkloadsOf(runs) {
  return runs.filter((run) => run.outcome === 'partial').map((run) => ({
    type: `workload:${run.workload}`, outcome: run.outcome, httpStatus: null,
    items: Number.isSafeInteger(run.settings) ? run.settings : null,
    reasonCount: run.gaps?.length ?? 0, reasons: listedReasons(run.gaps),
  }));
}

/**
 * One scheduled run. A collector that throws (a missing scope entry, a container that
 * would not start) is recorded as a `failed` run with the reason, and the next
 * workload still runs.
 */
export async function runWorkloadCollection(client, { tenantRef, config, scope = {}, transport, powershell = {}, now = () => new Date(), logger = console, collectors, onProgress }) {
  const { ledger, inputs } = await loadWorkloadLedger(client, { tenantRef, now: now() });
  const runs = [];
  const steps = workloadSteps({ config, scope, transport, powershell, collectors });
  // Job page: every workload starts as waiting, is marked reading, then shows its outcome.
  const progress = progressTracker(steps.map((step) => `workload:${step.workload}`), onProgress, now);
  await progress.start();
  for (const step of steps) {
    const base = { tenantRef, ledger, now };
    const startedAt = now();
    await progress.reading(`workload:${step.workload}`, startedAt);
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
    // A workload that raises drift compares this run with its previous one. A failed
    // detection fails the job but never the collection, which is already stored.
    let drift;
    try {
      const found = await detectWorkloadDrift(client, { collectionId: run.id });
      drift = { status: found.status, changes: found.drift.length };
    } catch (error) {
      drift = { status: 'failed', error: String(error?.message ?? error) };
    }
    // A partial run names what it could not read, so the Job page can list it.
    const gaps = run.outcome === 'partial' ? workloadGapReasons(run.digest) : [];
    const settings = progress.enabled || run.outcome === 'partial' ? await settingsCount(client, run.id) : null;
    runs.push({ workload: step.workload, outcome: run.outcome, collectionId: run.id, reasons, drift, ...(run.outcome === 'partial' ? { gaps, settings } : {}) });
    await progress.done(`workload:${step.workload}`, {
      outcome: run.outcome, itemCount: progress.enabled ? settings : null,
      startedAt, completedAt: now(), error: reasonsLine(reasons.length ? reasons : gaps.length ? gaps : run.digest?.reasons), reasons: gaps,
    });
    logger.log(`${step.workload}: ${run.outcome}${run.outcome === 'disabled' ? ' (not qualified; nothing was read)' : ''}`);
    if (gaps.length) logger.log(`${step.workload}: not read in full: ${gaps.join('; ')}`);
    if (drift.status === 'detected') logger.log(`${step.workload}: ${drift.changes} new change(s) against the approved setup`);
    if (drift.status === 'failed') logger.log(`${step.workload}: drift detection failed: ${drift.error}`);
  }
  // Compliance controls that rest on these reads (Defender email protection...) are
  // checked again now, as they are after each backup. A failed check is logged and
  // never fails the collection, which is already stored.
  let checks;
  try {
    checks = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now: now() });
    logger.log(`compliance checks: ${checks.checked} run (${checks.pass} pass, ${checks.fail} fail, ${checks.unknown} could not check)`);
  } catch (error) {
    checks = { status: 'failed', error: String(error?.message ?? error) };
    logger.log(`compliance checks failed: ${checks.error}`);
  }
  const proof = proofExpiry([...inputs.reads, ...inputs.writes], { now: now() });
  for (const entry of proof.filter((item) => item.status !== 'current')) logger.log(entry.message);
  const exitCode = workloadExitCode(runs);
  // One machine-readable line the worker turns into the job's result, so the Job page
  // shows the backup as partly done and names what was not read.
  if (exitCode === PARTIAL_EXIT_CODE) logger.log(`${INCOMPLETE_TYPES_PREFIX}${JSON.stringify(incompleteWorkloadsOf(runs))}`);
  return { tenantRef, runs, proof, exitCode };
}

/**
 * The live acceptance records and the import seam each one goes through. The four
 * workload records are required; a Wave 2 writer capture record is optional until
 * its workload has been captured (`optional`), so its absence is listed, not refused.
 */
export async function importSeams() {
  const [{ ledgerEvidenceFromAcceptance }, { ledgerEvidenceFromTeamsAcceptance }, { ledgerEvidenceFromExchangeAcceptance },
    { ledgerEvidenceFromOneDrivePurviewAcceptance }, { ledgerEvidenceFromWorkloadWritesAcceptance },
    { WRITTEN_WORKLOADS, workloadWritesRecordFile }, { ledgerEvidenceFromSiteGrantsAcceptance },
    { SITE_GRANTS_RECORD_FILE }, { ledgerEvidenceFromSitePermissionsAcceptance }, { SITE_PERMISSIONS_RECORD_FILE },
    { READ_FAMILIES, ledgerEvidenceFromWorkloadReadsAcceptance, workloadReadsRecordFile },
    { ledgerEvidenceFromStructureWritesAcceptance }, { STRUCTURE_WRITES_RECORD_FILE },
    { ledgerEvidenceFromDscWritesAcceptance }, { DSC_WRITES_RECORD_FILE },
    { ledgerEvidenceFromRoleWritesAcceptance }, { ROLE_WRITES_RECORD_FILE },
    { ledgerEvidenceFromUnpublishAcceptance }, { UNPUBLISH_RECORD_FILE }] = await Promise.all([
    import('../tools/qualification/sharepointLive.mjs'), import('../tools/qualification/teamsLive.mjs'),
    import('../tools/qualification/exchangeLive.mjs'), import('../tools/qualification/onedrivePurviewLive.mjs'),
    import('../tools/qualification/workloadWritesLive.mjs'), import('../tools/qualification/workloadWritesAcceptance.mjs'),
    import('../tools/qualification/sharepointSiteGrantsLive.mjs'), import('../tools/qualification/sharepointSiteGrantsAcceptance.mjs'),
    import('../tools/qualification/sharepointSitePermissionsLive.mjs'), import('../tools/qualification/sharepointSitePermissionsAcceptance.mjs'),
    import('../tools/qualification/workloadReadsLive.mjs'),
    import('../tools/qualification/sharepointStructureWritesLive.mjs'), import('../tools/qualification/sharepointStructureWritesAcceptance.mjs'),
    import('../tools/qualification/dscDistributionGroupsLive.mjs'), import('../tools/qualification/dscDistributionGroupsAcceptance.mjs'),
    import('../tools/qualification/exchangeRoleDefinitionsLive.mjs'), import('../tools/qualification/exchangeRoleDefinitionsAcceptance.mjs'),
    import('../tools/qualification/purviewUnpublishLive.mjs'), import('../tools/qualification/purviewUnpublishAcceptance.mjs'),
  ]);
  return [
    { file: 'sharepoint-live-acceptance.json', seam: ledgerEvidenceFromAcceptance },
    { file: 'teams-live-acceptance.json', seam: ledgerEvidenceFromTeamsAcceptance },
    { file: 'exchange-live-acceptance.json', seam: ledgerEvidenceFromExchangeAcceptance },
    { file: 'onedrive-purview-live-acceptance.json', seam: ledgerEvidenceFromOneDrivePurviewAcceptance },
    // A record proves only the workload its file is named for.
    ...Object.keys(WRITTEN_WORKLOADS).map((workload) => ({
      file: workloadWritesRecordFile(workload), optional: true,
      seam: (record, options) => (record?.subject?.workload === workload
        ? ledgerEvidenceFromWorkloadWritesAcceptance(record, options)
        : { ok: false, failures: [`the record is for ${record?.subject?.workload ?? 'no workload'}, not ${workload}`] }),
    })),
    // The Wave 2 cmdlet workloads' reads, one record per workload, optional until captured.
    ...Object.keys(READ_FAMILIES).map((workload) => ({
      file: workloadReadsRecordFile(workload), optional: true,
      seam: (record, options) => (record?.subject?.workload === workload
        ? ledgerEvidenceFromWorkloadReadsAcceptance(record, options)
        : { ok: false, failures: [`the record is for ${record?.subject?.workload ?? 'no workload'}, not ${workload}`] }),
    })),
    // Gap 5: the site app grant writes, optional until captured.
    { file: SITE_GRANTS_RECORD_FILE, optional: true, seam: ledgerEvidenceFromSiteGrantsAcceptance },
    // Gap 4: the site group, member, admin, level and role assignment writes, optional until captured.
    { file: SITE_PERMISSIONS_RECORD_FILE, optional: true, seam: ledgerEvidenceFromSitePermissionsAcceptance },
    // The SharePoint structure restore writes, optional until captured.
    { file: STRUCTURE_WRITES_RECORD_FILE, optional: true, seam: ledgerEvidenceFromStructureWritesAcceptance },
    // The distribution list writes through Microsoft365DSC, optional until captured.
    { file: DSC_WRITES_RECORD_FILE, optional: true, seam: ledgerEvidenceFromDscWritesAcceptance },
    // The custom Exchange admin role write through Exchange Online PowerShell, optional until captured.
    { file: ROLE_WRITES_RECORD_FILE, optional: true, seam: ledgerEvidenceFromRoleWritesAcceptance },
    // Removing labels from a Purview label policy, optional until captured.
    { file: UNPUBLISH_RECORD_FILE, optional: true, seam: ledgerEvidenceFromUnpublishAcceptance },
  ];
}

const graphUrl = (path) => `https://${GRAPH_HOST}/v1.0${path}`;

async function graphPages(transport, url, what) {
  const items = [];
  for (let next = url; next;) {
    const response = await transport(next, { method: 'GET' });
    if (response.status !== 200) {
      throw new Error(`reading ${what} returned HTTP ${response.status}${response.body?.error?.code ? ` (${response.body.error.code})` : ''}`);
    }
    items.push(...(response.body?.value ?? []));
    next = response.body?.['@odata.nextLink'] ?? null;
  }
  return items;
}

/**
 * The collector app's tenant-wide Entra directory roles, read live (GET only). A role
 * scoped to an administrative unit or an app is left out: the workload reads need it
 * tenant-wide. Purview role groups (eDiscovery Manager) are not Entra roles and never
 * show here.
 */
export async function observeCollectorRoles(transport, { appId }) {
  if (typeof appId !== 'string' || !appId) throw new Error('the tenant config names no clientId for the collector app');
  const principal = await transport(graphUrl(`/servicePrincipals(appId='${encodeURIComponent(appId)}')?$select=id`), { method: 'GET' });
  if (principal.status !== 200 || !principal.body?.id) throw new Error(`reading the collector's service principal returned HTTP ${principal.status}`);
  const query = new URLSearchParams({ $filter: `principalId eq '${principal.body.id}'`, $expand: 'roleDefinition' });
  const assignments = await graphPages(transport, graphUrl(`/roleManagement/directory/roleAssignments?${query}`), 'the collector\'s directory roles');
  return [...new Set(assignments
    .filter((item) => item.directoryScopeId === '/' && item.roleDefinition?.displayName)
    .map((item) => item.roleDefinition.displayName))].sort();
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
export async function importLedgerInputs(client, {
  tenantRef, dir, seams, verify = {}, readFile = (path) => readFileSync(path, 'utf8'), observeRoles = null,
}) {
  const { build: runningBuild = null, ...checks } = verify;
  const imported = [];
  const refused = [];
  const absent = [];
  for (const { file, seam, optional = false } of seams) {
    const path = join(dir, file);
    let record;
    try { record = JSON.parse(readFile(path)); } catch (error) {
      if (optional && error?.code === 'ENOENT') { absent.push(file); continue; }
      refused.push({ file, failures: [`unreadable: ${error.message}`] });
      continue;
    }
    const evidenceBuild = typeof record?.build === 'string' && record.build ? record.build : null;
    const result = seam(record, { ...checks, build: evidenceBuild, tenantRef, evidenceDir: dir });
    if (!result.ok) { refused.push({ file, evidenceBuild, failures: result.failures }); continue; }
    imported.push({ file, evidenceBuild, optional, ...result });
  }
  // One version is stored per module. A writer capture taken at another version than the
  // read proof imported with it would replace it and void that proof, so it is refused instead.
  const versions = Object.assign({}, ...imported.filter((item) => !item.optional).map((item) => item.runtime?.modules ?? {}));
  for (const item of imported.filter((entry) => entry.optional)) {
    const clash = Object.entries(item.runtime?.modules ?? {}).find(([module, version]) => versions[module] !== undefined && versions[module] !== version);
    if (clash) {
      imported.splice(imported.indexOf(item), 1);
      refused.push({ file: item.file, evidenceBuild: item.evidenceBuild, failures: [`captured at ${clash[0]} ${clash[1]}, but the read proof in this import is at ${versions[clash[0]]}: capture again at that version`] });
      continue;
    }
    Object.assign(versions, item.runtime?.modules ?? {});
  }
  const evidence = imported.flatMap((item) => [...item.reads, ...item.writes]);
  let grants = union(imported.map((item) => item.grants));
  // The roles the records declared, plus the roles the collector holds live now. A failed
  // live read keeps the declared roles only, as before, and says why.
  let collectorRoles = { source: 'declared', live: null, error: null };
  if (grants && observeRoles) {
    try {
      const live = await observeRoles();
      grants = union([grants, { permissions: [], roles: live }]);
      collectorRoles = { source: 'declared+live', live, error: null };
    } catch (error) {
      collectorRoles = { source: 'declared', live: null, error: error.message ?? String(error) };
    }
  }
  const restorerGrants = union(imported.map((item) => item.restorerGrants));
  const runtime = { modules: Object.assign({}, ...imported.map((item) => item.runtime?.modules ?? {})) };
  if (imported.length) await saveLedgerInputs(client, { tenantRef, evidence, grants, restorerGrants, runtime });
  return {
    tenantRef,
    runningBuild,
    imported: imported.map((item) => ({ file: item.file, evidenceBuild: item.evidenceBuild, reads: item.reads.length, writes: item.writes.length })),
    refused,
    absent,
    collectorRoles: { ...collectorRoles, stored: grants?.roles ?? null },
    exitCode: refused.length ? 1 : 0,
  };
}

export async function main(argv = process.argv.slice(2), {
  readFile = (path) => readFileSync(path, 'utf8'), connectFn = connect, getTokenFn = getToken, fetchImpl = globalThis.fetch,
  env = process.env, logger = console, seams,
} = {}) {
  const { values: opts, positionals: [command] } = parseCliArgs(argv, ARGS);
  if (!['run', 'import', 'proof'].includes(command) || opts.help) {
    logger.log('usage: keel-workload-collect.mjs run|import|proof [--config /etc/keel/tenant.json] [--scope FILE] [--dir DIR] [--db-url URL]');
    return command === undefined || opts.help ? 0 : 2;
  }
  const configPath = arg(opts, 'config', '/etc/keel/tenant.json');
  const config = readConfigFile(configPath, { readFile, what: 'collector settings' });
  const tenantRef = tenantRefFor(config.tenantId);
  const requested = arg(opts, 'tenant-ref');
  if (requested !== undefined && requested !== tenantRef) {
    throw new Error('the job names another tenant than the tenant config: refusing to collect');
  }
  const dbUrl = arg(opts, 'db-url', env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connectFn(dbUrl);
  try {
    if (command === 'import') {
      const dir = resolve(arg(opts, 'dir', DEFAULT_RECORD_DIR));
      const result = await importLedgerInputs(client, {
        tenantRef, dir, seams: seams ?? await importSeams(), readFile,
        verify: { build: arg(opts, 'build', null), hmacKey: env.KEEL_QUALIFICATION_HMAC_KEY ?? null },
        observeRoles: () => observeCollectorRoles(
          readOnlyGraphTransport(async () => (await getTokenFn(config)).accessToken, fetchImpl), { appId: config.clientId },
        ),
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
    const scopePath = arg(opts, 'scope', DEFAULT_SCOPE_PATH);
    const scope = arg(opts, 'scope') !== undefined || existsSync(scopePath) ? readConfigFile(scopePath, { readFile, what: 'workload scope' }) : {};
    scope.powershellConfigs = powershellConfigPaths(scope, { config, readFile });
    const transport = readOnlyGraphTransport(async () => (await getTokenFn(config)).accessToken, fetchImpl);
    const result = await runWorkloadCollection(client, {
      tenantRef, config, scope, transport, powershell: { tenantConfigPath: configPath }, logger,
      onProgress: progressWriter(client, env.KEEL_JOB_ID),
    });
    return result.exitCode;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
