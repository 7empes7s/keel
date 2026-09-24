#!/usr/bin/env node
// /opt/keel/cli/keel-export.mjs
//
// node keel-export.mjs --export-root PATH [--snapshot-id ID] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//
// Publishes an atomic, redacted configuration export of one snapshot to the
// local filesystem (engine/export/configExport.mjs). Read-side only: it reads
// the local keel database and writes local files — no Graph token, no tenant
// write, no credentials beyond the database URL. Storage/offsite policy
// belongs to WS10; this command only publishes locally.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exportSnapshot } from '../engine/export/configExport.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

// The tenant ref is the hash of the tenant id in the config file, exactly as
// keel-collect.mjs and keel-baseline-create.mjs derive it; an explicit
// --tenant-ref wins.
function resolveTenantRef({ argv, readFile }) {
  const explicit = arg('tenant-ref', undefined, argv);
  if (explicit) return explicit;
  const config = JSON.parse(readFile(arg('config', '/etc/keel/tenant.json', argv), 'utf8'));
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function runExport({
  tenantRef,
  snapshotId,
  exportRoot,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    exportSnapshot: exportSnapshotFn = exportSnapshot,
  } = dependencies;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  if (typeof exportRoot !== 'string' || exportRoot.length === 0) {
    throw new Error('--export-root (or KEEL_EXPORT_ROOT) is required');
  }

  const client = await connectFn(dbUrl);
  try {
    const result = await exportSnapshotFn(client, { tenantRef, snapshotId, exportRoot });
    logger.log(`snapshot ${result.snapshotId} exported to ${result.exportDir}`);
    logger.log(`latest -> ${result.snapshotId}`);
    return { ...result, exitCode: 0 };
  } finally {
    await client.end();
  }
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dependencies,
  logger = console,
} = {}) {
  if (argv.includes('--help')) {
    logger.log('usage: keel-export.mjs --export-root PATH [--snapshot-id ID] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]');
    return 0;
  }
  const { exitCode } = await runExport({
    tenantRef: resolveTenantRef({ argv, readFile }),
    snapshotId: arg('snapshot-id', undefined, argv),
    exportRoot: arg('export-root', process.env.KEEL_EXPORT_ROOT, argv),
    dbUrl: arg('db-url', process.env.KEEL_DB_URL, argv),
    dependencies,
    logger,
  });
  return exitCode;
}

export async function runCli(options = {}) {
  try {
    return await main(options);
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
