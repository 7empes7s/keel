#!/usr/bin/env node
// /opt/keel/cli/keel-prune.mjs
//
// node keel-prune.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--dry-run]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from '../engine/store/db.mjs';
import { listPrunableSnapshots, pruneSnapshots } from '../engine/store/retention.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-prune.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--dry-run]');
    return;
  }

  const dryRun = process.argv.includes('--dry-run');
  const config = JSON.parse(readFileSync(arg('config', '/etc/keel/tenant.json'), 'utf8'));
  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const tenantRef = `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
  const client = await connect(dbUrl);
  try {
    const now = new Date();
    const snapshotIds = dryRun
      ? await listPrunableSnapshots(client, { tenantRef, now })
      : await pruneSnapshots(client, { tenantRef, now });
    const verb = dryRun ? 'would prune' : 'pruned';
    console.log(`${verb} ${snapshotIds.length} snapshot(s)${snapshotIds.length ? `: ${snapshotIds.join(', ')}` : ''}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
