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
// Until the reader file exists (admin consent, ask 1) a run reads nothing, says what it
// waits on, and exits 0, so the nightly schedule does not fail every night.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getToken } from '../tools/tenant-probe/auth.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createLocalStorageAdapter } from '../engine/storage/local.mjs';
import { createPgContentIndex } from '../engine/content/index.mjs';
import { CONTENT_WORKLOADS, createContentStore, parseContentKey } from '../engine/content/store.mjs';
import { contentReadTransport } from '../engine/content/transport.mjs';
import { CONTENT_COLLECTORS } from '../engine/content/collectors.mjs';

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

/**
 * One scheduled run. A collector that throws is recorded as failed with the reason,
 * and the next one still runs. Exit code 1 when any collector failed or was partial.
 */
export async function runContentCollection(client, { tenantRef, store, transport, scope = {}, collectors = CONTENT_COLLECTORS, now = () => new Date(), logger = console }) {
  const runs = [];
  if (!collectors.length) logger.log('content backup: no content collectors are registered yet; nothing was read');
  for (const entry of collectors) {
    if (!CONTENT_WORKLOADS.includes(entry.workload)) throw new Error(`content collector for unknown workload ${entry.workload}`);
    let result;
    try {
      result = await entry.collect(client, { tenantRef, store, transport, scope, sleep, now, logger });
    } catch (error) {
      result = { outcome: 'failed', items: 0, bytes: 0, reasons: [String(error?.message ?? error)] };
    }
    runs.push({ workload: entry.workload, ...result });
    logger.log(`${entry.workload}: ${result.outcome} (${result.items ?? 0} items, ${result.bytes ?? 0} bytes)${result.reasons?.length ? `: ${result.reasons.join('; ')}` : ''}`);
  }
  return { tenantRef, outcome: 'ran', runs, exitCode: runs.some((run) => run.outcome !== 'succeeded') ? 1 : 0 };
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
  const config = JSON.parse(readFile(arg(argv, 'config', '/etc/keel/tenant.json')));
  const tenantRef = tenantRefFor(config.tenantId);
  const requested = arg(argv, 'tenant-ref');
  if (requested !== undefined && requested !== tenantRef) throw new Error('the job names another tenant than the tenant config: refusing to collect');
  const readerPath = arg(argv, 'reader', DEFAULT_READER_PATH);
  if (!exists(readerPath)) {
    logger.log(`content backup is waiting on the content-reader app (admin consent for content reads): ${readerPath} does not exist yet; nothing was read`);
    return 0;
  }
  const reader = JSON.parse(readFile(readerPath));
  const problems = readerProblems(reader, config);
  if (problems.length) throw new Error(`content reader file ${readerPath}: ${problems.join('; ')}`);
  const scopePath = arg(argv, 'scope', DEFAULT_SCOPE_PATH);
  const scope = arg(argv, 'scope') !== undefined || exists(scopePath) ? JSON.parse(readFile(scopePath)) : {};
  const dbUrl = arg(argv, 'db-url', env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connectFn(dbUrl);
  try {
    const store = createContentStore({
      index: createPgContentIndex(client), storage: storageFor(reader.storage), key: parseContentKey(readFile(reader.contentKeyFile)),
    });
    const transport = contentReadTransport(() => getTokenFn(reader), fetchImpl);
    const result = await runContentCollection(client, { tenantRef, store, transport, scope, collectors, logger });
    return result.exitCode;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
