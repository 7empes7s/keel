#!/usr/bin/env node
// /opt/keel/cli/keel-prune.mjs
//
// node keel-prune.mjs [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL] [--dry-run]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from '../engine/store/db.mjs';
import { OPEN_DRIFT_PREDICATE } from '../engine/store/openDrift.mjs';
import { isPrunable, pruneSnapshots } from '../engine/store/retention.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

// The read half of pruneSnapshots (engine/store/retention.mjs): which snapshots
// are prunable under the default retention policy. Used by --dry-run so that
// nothing is deleted. The delete half lives only in pruneSnapshots.
async function listPrunableSnapshots(client, { tenantRef, now }) {
  const { rows: referencedSnapshots } = await client.query(
    `SELECT DISTINCT snapshot_id
     FROM (
       SELECT rv.snapshot_id
       FROM baseline_resource br
       JOIN baseline b ON b.id = br.baseline_id
       JOIN resource_version rv ON rv.id = br.resource_version_id
       WHERE b.active
       UNION
       SELECT d.observed_snapshot AS snapshot_id
       FROM drift d
       WHERE ${OPEN_DRIFT_PREDICATE}
       UNION
       SELECT p.source_snapshot AS snapshot_id
       FROM plan p
     ) AS referenced_snapshots`,
  );
  const referencedSnapshotIds = new Set(referencedSnapshots.map(({ snapshot_id }) => snapshot_id));

  const { rows: snapshots } = await client.query(
    `SELECT s.*,
            CASE
              WHEN COALESCE(bool_or(rv.criticality = 'tier3'), false) THEN 'tier3'
              WHEN COALESCE(bool_or(rv.criticality = 'tier2'), false) THEN 'tier2'
              ELSE 'tier1'
            END AS tier
     FROM snapshot s
     LEFT JOIN resource_version rv ON rv.snapshot_id = s.id
     WHERE s.tenant_ref = $1
     GROUP BY s.id
     ORDER BY s.started_at`,
    [tenantRef],
  );
  return snapshots
    .filter((snapshot) => isPrunable(snapshot, { now, referencedSnapshotIds }))
    .map((snapshot) => snapshot.id);
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
