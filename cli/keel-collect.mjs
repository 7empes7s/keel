#!/usr/bin/env node
// /opt/keel/cli/keel-collect.mjs
//
// node keel-collect.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--tier tier1|tier2|tier3]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectSnapshot } from '../engine/collect/snapshot.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

// A partial read fails completeness exactly like a failure; only
// complete / complete-empty / not-requested outcomes keep a zero exit.
export function exitCodeForDigest(coverageDigest) {
  return Object.values(coverageDigest).some((entry) => entry.outcome === 'failed' || entry.outcome === 'partial') ? 1 : 0;
}

export async function runCollect({
  config,
  dbUrl = process.env.KEEL_DB_URL,
  tier,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    getToken: getTokenFn = getToken,
    GraphReader: GraphReaderClass = GraphReader,
    collectSnapshot: collectSnapshotFn = collectSnapshot,
  } = dependencies;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const tenantRef = tenantRefFor(config.tenantId);
  const { accessToken } = await getTokenFn(config);
  const reader = new GraphReaderClass(async () => accessToken);
  const client = await connectFn(dbUrl);
  logger.log('collecting graph-native types…');
  try {
    const { snapshotId, coverageDigest } = await collectSnapshotFn(client, { reader, tenantRef, tenantId: config.tenantId, tier });
    logger.log(`snapshot ${snapshotId} complete`);
    logger.table?.(coverageDigest);
    return { snapshotId, coverageDigest, exitCode: exitCodeForDigest(coverageDigest) };
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
    logger.log('usage: keel-collect.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--tier tier1|tier2|tier3]');
    return 0;
  }
  const tier = arg('tier', undefined, argv);
  if (tier && !['tier1', 'tier2', 'tier3'].includes(tier)) {
    throw new Error('--tier must be tier1, tier2, or tier3');
  }
  const config = JSON.parse(readFile(arg('config', '/etc/keel/tenant.json', argv), 'utf8'));
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL, argv);
  const { exitCode } = await runCollect({ config, dbUrl, tier, dependencies, logger });
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
