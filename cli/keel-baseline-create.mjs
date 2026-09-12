#!/usr/bin/env node
// /opt/keel/cli/keel-baseline-create.mjs
//
// node keel-baseline-create.mjs --snapshot-id ID --label LABEL --set-by PRINCIPAL
//   [--description TEXT] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//
// Thin worker-dispatch wrapper around engine/govern/baseline.mjs seedFromSnapshot(): the
// worker spawns this so baseline creation gets the same child-process timeout and
// process-group teardown as every other job kind. All governance logic stays in the
// engine module — this file only parses argv and connects.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

function requireArg(name, argv = process.argv) {
  const value = arg(name, undefined, argv);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

// The tenant ref is the hash of the tenant id in the config file, exactly as
// keel-collect.mjs and keel-prune.mjs derive it; an explicit --tenant-ref wins.
function resolveTenantRef({ argv, readFile }) {
  const explicit = arg('tenant-ref', undefined, argv);
  if (explicit) return explicit;
  const config = JSON.parse(readFile(arg('config', '/etc/keel/tenant.json', argv), 'utf8'));
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
} = {}) {
  if (argv.includes('--help')) {
    logger.log('usage: keel-baseline-create.mjs --snapshot-id ID --label LABEL --set-by PRINCIPAL [--description TEXT] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]');
    return;
  }

  const selectedDbUrl = arg('db-url', dbUrl, argv);
  if (!selectedDbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const {
    connect: connectFn = connect,
    seedFromSnapshot: seedFromSnapshotFn = seedFromSnapshot,
  } = dependencies;

  const client = await connectFn(selectedDbUrl);
  try {
    const baselineId = await seedFromSnapshotFn(client, {
      tenantRef: resolveTenantRef({ argv, readFile }),
      snapshotId: requireArg('snapshot-id', argv),
      setBy: requireArg('set-by', argv),
      label: requireArg('label', argv),
      description: arg('description', undefined, argv) ?? null,
    });
    logger.log(`baseline ${baselineId} created and active`);
    return baselineId;
  } finally {
    await client.end();
  }
}

export async function runCli(options = {}) {
  try {
    await main(options);
    return 0;
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
