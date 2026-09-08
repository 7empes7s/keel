#!/usr/bin/env node
// /opt/keel/cli/keel-collect.mjs
//
// node keel-collect.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--tier tier1|tier2|tier3]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getToken } from '../tools/tenant-probe/auth.mjs';
import { GraphReader } from '../tools/tenant-probe/graph.mjs';
import { collectSnapshot } from '../engine/collect/snapshot.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-collect.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--tier tier1|tier2|tier3]');
    return;
  }

  const tier = arg('tier');
  if (tier && !['tier1', 'tier2', 'tier3'].includes(tier)) {
    throw new Error('--tier must be tier1, tier2, or tier3');
  }

  const config = JSON.parse(readFileSync(arg('config', '/etc/keel/tenant.json'), 'utf8'));
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const { accessToken } = await getToken(config);
  const reader = new GraphReader(async () => accessToken);
  const tenantRef = `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
  const client = await connect(dbUrl);
  console.log('collecting graph-native types…');
  try {
    const { snapshotId, coverageDigest } = await collectSnapshot(client, { reader, tenantRef, tier });
    console.log(`snapshot ${snapshotId} complete`);
    console.table(coverageDigest);
    if (Object.values(coverageDigest).some((entry) => entry.outcome === 'failed')) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
