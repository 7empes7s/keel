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
import { seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function requireArg(name) {
  const value = arg(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

// The tenant ref is the hash of the tenant id in the config file, exactly as
// keel-collect.mjs and keel-prune.mjs derive it; an explicit --tenant-ref wins.
function resolveTenantRef() {
  const explicit = arg('tenant-ref');
  if (explicit) return explicit;
  const config = JSON.parse(readFileSync(arg('config', '/etc/keel/tenant.json'), 'utf8'));
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-baseline-create.mjs --snapshot-id ID --label LABEL --set-by PRINCIPAL [--description TEXT] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]');
    return;
  }

  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const client = await connect(dbUrl);
  try {
    const baselineId = await seedFromSnapshot(client, {
      tenantRef: resolveTenantRef(),
      snapshotId: requireArg('snapshot-id'),
      setBy: requireArg('set-by'),
      label: requireArg('label'),
      description: arg('description') ?? null,
    });
    console.log(`baseline ${baselineId} created and active`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
