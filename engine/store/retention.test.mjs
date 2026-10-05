import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createSnapshot, insertResourceVersion } from './db.mjs';
import { recordDisposition, recordDrift } from './governance.mjs';
import { isPrunable, listPrunableSnapshots, pruneSnapshots } from './retention.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

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

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

const tenantRef = 'sha256:retention-test';
const expiredIgnoreAt = new Date('2000-01-01T00:00:00.000Z');
const unexpiredIgnoreAt = new Date('2099-01-01T00:00:00.000Z');
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

async function createOldSnapshotWithIgnoredDrift(expiresAt) {
  const observedSnapshot = await createSnapshot(client, { tenantRef });
  await client.query(
    `UPDATE snapshot
     SET started_at = $2, completed_at = $2
     WHERE id = $1`,
    [observedSnapshot, oldTier1Snapshot.startedAt],
  );
  const driftId = await recordDrift(client, {
    tenantRef,
    baselineId: baselineRows[0].id,
    observedSnapshot,
    naturalKey: 'group:retention-test',
    resourceType: 'group',
    changeType: 'modified',
    beforeHash: 'retention-test-hash',
    afterHash: 'retention-test-drift-hash',
    beforePayload: { displayName: 'Retention test' },
    afterPayload: { displayName: 'Retention test changed' },
    blastRadius: 'access-affecting',
  });
  await recordDisposition(client, {
    driftId,
    action: 'ignore',
    actor: 'test-operator',
    reason: 'retention ignore test',
    expiresAt,
  });
  return observedSnapshot;
}

const expiredIgnoreSnapshotId = await createOldSnapshotWithIgnoredDrift(expiredIgnoreAt);
assert.equal(isPrunable({
  id: expiredIgnoreSnapshotId,
  tier: 'tier1',
  startedAt: oldTier1Snapshot.startedAt,
}, {
  now,
  referencedSnapshotIds: new Set(),
  policy,
}), true);

const prunedSnapshotIds = await pruneSnapshots(client, { tenantRef, policy, now });
assert.deepEqual(prunedSnapshotIds, []);
const { rows: remainingSnapshots } = await client.query(
  'SELECT id FROM snapshot WHERE id = $1',
  [activeBaselineSnapshotId],
);
assert.equal(remainingSnapshots.length, 1);

const { rows: expiredIgnoreSnapshots } = await client.query(
  'SELECT id FROM snapshot WHERE id = $1',
  [expiredIgnoreSnapshotId],
);
assert.equal(expiredIgnoreSnapshots.length, 1);

// A dispositioned (closed) drift still points at its observed snapshot. Drift and its
// disposition are the governance record, so the snapshot stays, and the prune run
// completes instead of failing on drift_observed_snapshot_fkey.
const unexpiredIgnoreSnapshotId = await createOldSnapshotWithIgnoredDrift(unexpiredIgnoreAt);

async function createOldSnapshot(naturalKey) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey,
      resourceType: 'group',
      payload: { displayName: naturalKey },
      payloadHash: `${naturalKey}-hash`,
      criticality: 'tier1',
      blastRadius: 'access-affecting',
      fidelity: 'full',
      provenance: { adapter: 'test' },
    },
  });
  await client.query(
    'UPDATE snapshot SET started_at = $2, completed_at = $2 WHERE id = $1',
    [snapshotId, oldTier1Snapshot.startedAt],
  );
  return snapshotId;
}

// A superseded (inactive) baseline keeps its baseline_resource rows and its source
// snapshot; both point into the old snapshot.
const supersededBaselineSnapshotId = await createOldSnapshot('group:retention-superseded');
const { rows: supersededRows } = await client.query(
  `INSERT INTO baseline (tenant_ref, set_by, active, source_snapshot_id)
   VALUES ($1, 'test-operator', false, $2)
   RETURNING id`,
  [tenantRef, supersededBaselineSnapshotId],
);
await client.query(
  `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
   SELECT $1, natural_key, id FROM resource_version WHERE snapshot_id = $2`,
  [supersededRows[0].id, supersededBaselineSnapshotId],
);

// The snapshot that last evidenced a since-deleted object (a tombstoned symbol).
const tombstoneSnapshotId = await createOldSnapshot('group:retention-tombstone');
await client.query(
  `INSERT INTO resource_symbol (tenant_ref, resource_type, source_id, natural_key, source_snapshot, tombstoned_at)
   VALUES ($1, 'group', 'retention-tombstone', 'group:retention-tombstone', $2, now())`,
  [tenantRef, tombstoneSnapshotId],
);

// An active incident pin keeps its snapshot; a released one does not.
const { rows: incidentRows } = await client.query(
  `INSERT INTO incident (tenant_ref, title, owner) VALUES ($1, 'retention test', 'test-operator') RETURNING id`,
  [tenantRef],
);
const pinnedSnapshotId = await createOldSnapshot('group:retention-pinned');
const releasedPinSnapshotId = await createOldSnapshot('group:retention-released');
await client.query(
  `INSERT INTO retention_pin (tenant_ref, incident_id, snapshot_id, reason, pinned_by, released_at)
   VALUES ($1, $2, $3, 'held', 'test-operator', NULL),
          ($1, $2, $4, 'held', 'test-operator', now())`,
  [tenantRef, incidentRows[0].id, pinnedSnapshotId, releasedPinSnapshotId],
);

// The snapshot's own relationship observations go with it.
const edgeSetSnapshotId = await createOldSnapshot('group:retention-edges');
const { rows: edgeSetRows } = await client.query(
  `INSERT INTO relationship_edge_set
     (snapshot_id, tenant_ref, parent_type, parent_source_id, family, edge_type, direction, outcome)
   VALUES ($1, $2, 'group', 'retention-edges', 'membership', 'member', 'outbound', 'complete')
   RETURNING id`,
  [edgeSetSnapshotId, tenantRef],
);
await client.query(
  `INSERT INTO relationship_edge (set_id, tenant_ref, edge_key, target_source_id)
   VALUES ($1, $2, 'retention-target', 'retention-target')`,
  [edgeSetRows[0].id, tenantRef],
);

const expectedPrunable = [releasedPinSnapshotId, edgeSetSnapshotId].sort();
assert.deepEqual((await listPrunableSnapshots(client, { tenantRef, policy, now })).sort(), expectedPrunable);
assert.deepEqual((await pruneSnapshots(client, { tenantRef, policy, now })).sort(), expectedPrunable);

const { rows: survivors } = await client.query('SELECT id FROM snapshot WHERE tenant_ref = $1', [tenantRef]);
assert.deepEqual(survivors.map(({ id }) => id).sort(), [
  activeBaselineSnapshotId,
  expiredIgnoreSnapshotId,
  unexpiredIgnoreSnapshotId,
  supersededBaselineSnapshotId,
  tombstoneSnapshotId,
  pinnedSnapshotId,
].sort());
const { rows: leftoverEdgeSets } = await client.query(
  'SELECT 1 FROM relationship_edge_set WHERE snapshot_id = $1',
  [edgeSetSnapshotId],
);
assert.equal(leftoverEdgeSets.length, 0);

// Every foreign key into a snapshot (directly or through resource_version) must be
// either a dependency the prune honours or one of the snapshot's own rows it deletes.
// A new table that points at snapshots fails here until retention.mjs handles it.
const honouredOrOwned = new Set([
  'baseline_resource.resource_version_id',
  'baseline.source_snapshot_id',
  'drift.observed_snapshot',
  'plan.source_snapshot',
  'restore_dry_run.snapshot_id',
  'resource_symbol.source_snapshot',
  'resource_lineage_alias.source_snapshot',
  'resource_version.snapshot_id',
  'resource_reference.from_version',
  'relationship_edge_set.snapshot_id',
]);
const { rows: foreignKeys } = await client.query(
  `SELECT k.conrelid::regclass::text AS table_name, a.attname AS column_name
   FROM pg_constraint k
   JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
   WHERE k.contype = 'f'
     AND k.connamespace = current_schema()::regnamespace
     AND k.confrelid IN ('snapshot'::regclass, 'resource_version'::regclass)`,
);
for (const { table_name: tableName, column_name: columnName } of foreignKeys) {
  assert.ok(
    honouredOrOwned.has(`${tableName}.${columnName}`),
    `${tableName}.${columnName} points at a snapshot but retention.mjs does not account for it`,
  );
}

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('retention.test.mjs — all assertions passed');
