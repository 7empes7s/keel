#!/usr/bin/env node
// /opt/keel/cli/keel-content-collect.mjs
//
// node keel-content-collect.mjs run [--config /etc/keel/tenant.json] [--reader /etc/keel/content-reader.json]
//                                   [--scope /etc/keel/content-scope.json] [--tenant-ref REF] [--db-url $KEEL_DB_URL]
//
// Wave 1 CONT: scheduled content backup (the `content-collect` job kind). Runs every
// content collector registered in engine/content/collectors.mjs, in its order, as the
// content-reader identity: a separate app registration from the configuration
// collector, consented for content reads only (engine/bootstrap/prerequisites.mjs,
// `content-backup`). Every request is a read (engine/content/transport.mjs). Items go
// to the content store (engine/content/store.mjs): chunked, deduplicated and
// encrypted before they reach storage.
//
// The reader file (mode 600, under /etc/keel) names the reader app and where content goes:
//   { "tenantId": "...", "clientId": "...", "certPath": "...", "keyPath": "...",
//     "contentKeyFile": "/etc/keel/content.key", "storage": { "kind": "local", "root": "/var/lib/keel/content" } }
// contentKeyFile holds the 32-byte master key (64 hex characters); losing it loses the content.
// Site permissions (SharePoint groups and role assignments) are read through SharePoint
// REST as the Collector from --config, when that config has a certificate: reading role
// assignments needs Sites.FullControl.All on SharePoint, which the Content Reader does
// not hold. Those reads are GET-only too (sharePointReadTransport). Without a certificate
// in --config the part is declared missing on every site.
// Until the reader file exists (admin consent, ask 1) a run reads nothing, says what it
// waits on, and exits 0, so the nightly schedule does not fail every night.
import { existsSync, readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getToken } from '../tools/tenant-probe/auth.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createLocalStorageAdapter } from '../engine/storage/local.mjs';
import { createPgContentIndex } from '../engine/content/index.mjs';
import { CONTENT_WORKLOADS, createContentStore, parseContentKey } from '../engine/content/store.mjs';
import { contentReadTransport, sharePointReadTransport } from '../engine/content/transport.mjs';
import { CONTENT_COLLECTORS } from '../engine/content/collectors.mjs';
import { recordContentRun } from '../engine/coverage/serviceBackups.mjs';
import { MAX_LISTED_REASONS, listedReasons, progressTracker, progressWriter, reasonsLine } from '../engine/jobs/progress.mjs';

export { MAX_LISTED_REASONS };
import { INCOMPLETE_TYPES_PREFIX, PARTIAL_EXIT_CODE } from '../engine/collect/incomplete.mjs';

export const DEFAULT_READER_PATH = '/etc/keel/content-reader.json';
export const DEFAULT_SCOPE_PATH = '/etc/keel/content-scope.json';
const CONFIG_DIR = '/etc/keel/';

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** Checks the reader file: same tenant, its own app, key file under /etc/keel, known storage. */
export function readerProblems(reader, config) {
  const problems = [];
  if (reader?.tenantId !== config.tenantId) problems.push('the reader file names another tenant than the tenant config');
  if (typeof reader?.clientId !== 'string' || !reader.clientId) problems.push('the reader file needs the content-reader clientId');
  else if (reader.clientId === config.clientId) problems.push('the content reader must be its own app registration, not the collector');
  const keyFile = reader?.contentKeyFile;
  if (typeof keyFile !== 'string' || resolve(keyFile) !== keyFile || !keyFile.startsWith(CONFIG_DIR)) {
    problems.push(`contentKeyFile must be an absolute path under ${CONFIG_DIR}`);
  }
  if (reader?.storage?.kind !== 'local' || typeof reader.storage.root !== 'string' || resolve(reader.storage.root) !== reader.storage.root) {
    problems.push('storage must be { "kind": "local", "root": "<absolute path>" } (more targets come with Wave 2 STORE)');
  }
  return problems;
}

// A content run's outcome as the Job page names it.
const CONTENT_PROGRESS_OUTCOME = { succeeded: 'complete', failed: 'failed', partial: 'partial', skipped: 'unavailable', disabled: 'disabled' };

/**
 * Exit codes (#447 for settings, the same rule for content). 0: every workload read in
 * full. 3: no workload failed, but some were read only in part (a locked OneDrive, one
 * refused mailbox); they are named on stdout and the run is partial, not failed. 1: any
 * workload failed or ended in any other state, or could not list what it backs up (a
 * refused users, groups, sites or teams listing hides whole sets of items).
 */
export function contentExitCode(runs) {
  if (runs.every((run) => run.outcome === 'succeeded' && !run.discoveryFailed)) return 0;
  return runs.every((run) => (run.outcome === 'succeeded' || run.outcome === 'partial') && !run.discoveryFailed) ? PARTIAL_EXIT_CODE : 1;
}

/** The workloads a run read only in part, in the shape the worker's partial result takes. */
export function incompleteWorkloadsOf(runs) {
  return runs.filter((run) => run.outcome !== 'succeeded').map((run) => ({
    type: `content:${run.workload}`, outcome: run.outcome, httpStatus: null,
    items: Number(run.items ?? 0), reasonCount: Array.isArray(run.reasons) ? run.reasons.length : 0, reasons: listedReasons(run.reasons),
  }));
}

/**
 * One scheduled run. A collector that throws is recorded as failed with the reason,
 * and the next one still runs. See contentExitCode for the exit code.
 */
export async function runContentCollection(client, {
  tenantRef, tenantId, store, transport, sharePointTransportFor, scope = {}, collectors = CONTENT_COLLECTORS, now = () => new Date(), logger = console,
  onProgress,
}) {
  const runs = [];
  // Job page: every workload starts as waiting, is marked reading, then shows its outcome.
  const progress = progressTracker(collectors.map((entry) => `content:${entry.workload}`), onProgress, now);
  await progress.start();
  if (!collectors.length) logger.log('content backup: no content collectors are registered yet; nothing was read');
  for (const entry of collectors) {
    if (!CONTENT_WORKLOADS.includes(entry.workload)) throw new Error(`content collector for unknown workload ${entry.workload}`);
    let result;
    const startedAt = now();
    await progress.reading(`content:${entry.workload}`, startedAt);
    try {
      result = await entry.collect(client, { tenantRef, tenantId, store, transport, sharePointTransportFor, scope, sleep, now, logger });
    } catch (error) {
      result = { outcome: 'failed', items: 0, bytes: 0, reasons: [String(error?.message ?? error)] };
    }
    // A workload that could not list what it backs up failed, even if it read some items.
    if (result.discoveryFailed && result.outcome === 'partial') result = { ...result, outcome: 'failed' };
    runs.push({ workload: entry.workload, ...result });
    const completedAt = now();
    await progress.done(`content:${entry.workload}`, {
      outcome: CONTENT_PROGRESS_OUTCOME[result.outcome] ?? 'failed', itemCount: Number(result.items ?? 0),
      startedAt, completedAt, error: reasonsLine(result.reasons), reasons: result.reasons,
    });
    // Each workload's run is kept so freshness and reports count content beside settings.
    const namePrefix = typeof scope?.namePrefix === 'string' && scope.namePrefix ? scope.namePrefix : null;
    try {
      await recordContentRun(client, {
        tenantRef, workload: entry.workload, outcome: result.outcome, items: result.items, bytes: result.bytes,
        reasons: result.reasons ?? [], skipped: result.skipped ?? [], namePrefix, startedAt, completedAt,
      });
    } catch (error) {
      logger.log(`${entry.workload}: the run could not be recorded: ${error?.message ?? error}`);
    }
    logger.log(`${entry.workload}: ${result.outcome} (${result.items ?? 0} items, ${result.bytes ?? 0} bytes)${result.reasons?.length ? `: ${result.reasons.join('; ')}` : ''}`);
  }
  const exitCode = contentExitCode(runs);
  // One machine-readable line the worker turns into the job's result, so the Job page
  // can list what was not backed up.
  if (exitCode === PARTIAL_EXIT_CODE) logger.log(`${INCOMPLETE_TYPES_PREFIX}${JSON.stringify(incompleteWorkloadsOf(runs))}`);
  return { tenantRef, outcome: 'ran', runs, exitCode };
}

export async function main(argv = process.argv.slice(2), {
  readFile = (path) => readFileSync(path, 'utf8'), exists = existsSync, connectFn = connect, getTokenFn = getToken,
  fetchImpl = globalThis.fetch, env = process.env, logger = console, collectors = CONTENT_COLLECTORS,
  storageFor = ({ root }) => createLocalStorageAdapter({ root }),
} = {}) {
  if (argv[0] !== 'run' || argv.includes('--help')) {
    logger.log('usage: keel-content-collect.mjs run [--config /etc/keel/tenant.json] [--reader FILE] [--scope FILE] [--tenant-ref REF] [--db-url URL]');
    return argv[0] === undefined || argv.includes('--help') ? 0 : 2;
  }
  const config = readConfigFile(arg(argv, 'config', '/etc/keel/tenant.json'), { readFile, what: 'collector settings' });
  const tenantRef = tenantRefFor(config.tenantId);
  const requested = arg(argv, 'tenant-ref');
  if (requested !== undefined && requested !== tenantRef) throw new Error('the job names another tenant than the tenant config: refusing to collect');
  const readerPath = arg(argv, 'reader', DEFAULT_READER_PATH);
  if (!exists(readerPath)) {
    logger.log(`content backup is waiting on the content-reader app (admin consent for content reads): ${readerPath} does not exist yet; nothing was read`);
    return 0;
  }
  const reader = readConfigFile(readerPath, { readFile, what: 'content backup reader settings' });
  const problems = readerProblems(reader, config);
  if (problems.length) throw new Error(`content reader file ${readerPath}: ${problems.join('; ')}`);
  const scopePath = arg(argv, 'scope', DEFAULT_SCOPE_PATH);
  const scope = arg(argv, 'scope') !== undefined || exists(scopePath) ? readConfigFile(scopePath, { readFile, what: 'content scope' }) : {};
  const dbUrl = arg(argv, 'db-url', env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connectFn(dbUrl);
  try {
    const store = createContentStore({
      index: createPgContentIndex(client), storage: storageFor(reader.storage), key: parseContentKey(readFile(reader.contentKeyFile)),
    });
    const transport = contentReadTransport(() => getTokenFn(reader), fetchImpl);
    const sharePointTransportFor = config.certPath && config.keyPath
      ? (tenantHost) => sharePointReadTransport(() => getTokenFn(config, { scope: `https://${tenantHost}/.default` }), fetchImpl, { tenantHost })
      : undefined;
    const result = await runContentCollection(client, {
      tenantRef, tenantId: config.tenantId, store, transport, sharePointTransportFor, scope, collectors, logger,
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
