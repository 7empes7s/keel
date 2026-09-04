import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect, createSnapshot, insertResourceVersion } from './db.mjs';
import { isPrunable, pruneSnapshots } from './retention.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');

const now = new Date('2026-09-04T12:00:00.000Z');
const policy = { tier1: 7, tier2: 90, tier3: 365 };
const oldTier1Snapshot = {
  id: '00000000-0000-0000-0000-000000000001',
  tier: 'tier1',
  startedAt: '2026-08-01T12:00:00.000Z',
};

assert.equal(isPrunable(oldTier1Snapshot, {
  now,
  referencedSnapshotIds: new Set(),
  policy,
}), true);
assert.equal(isPrunable(oldTier1Snapshot, {
  now,
  referencedSnapshotIds: new Set([oldTier1Snapshot.id]),
  policy,
}), false);

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
  'DROP TABLE IF EXISTS evidence, disposition, drift, baseline_resource, baseline, resource_reference, rollback_entry, resource_version, plan, snapshot CASCADE',
);
await admin.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
await admin.end();

const client = await connect(url);
const tenantRef = 'sha256:retention-test';
const activeBaselineSnapshotId = await createSnapshot(client, { tenantRef });
await insertResourceVersion(client, {
  snapshotId: activeBaselineSnapshotId,
  resource: {
    naturalKey: 'group:retention-test',
    resourceType: 'group',
    payload: { displayName: 'Retention test' },
    payloadHash: 'retention-test-hash',
    criticality: 'tier1',
    blastRadius: 'access-affecting',
    fidelity: 'full',
    provenance: { adapter: 'test' },
  },
});
await client.query(
  `UPDATE snapshot
   SET started_at = $2, completed_at = $2
   WHERE id = $1`,
  [activeBaselineSnapshotId, oldTier1Snapshot.startedAt],
);

const { rows: baselineRows } = await client.query(
  `INSERT INTO baseline (tenant_ref, set_by, active)
   VALUES ($1, $2, true)
   RETURNING id`,
  [tenantRef, 'test-operator'],
);
await client.query(
  `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
   SELECT $1, natural_key, id
   FROM resource_version
   WHERE snapshot_id = $2`,
  [baselineRows[0].id, activeBaselineSnapshotId],
);

const prunedSnapshotIds = await pruneSnapshots(client, { tenantRef, policy, now });
assert.deepEqual(prunedSnapshotIds, []);
const { rows: remainingSnapshots } = await client.query(
  'SELECT id FROM snapshot WHERE id = $1',
  [activeBaselineSnapshotId],
);
assert.equal(remainingSnapshots.length, 1);

await client.end();
console.log('retention.test.mjs — all assertions passed');
