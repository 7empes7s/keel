import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createSnapshot, insertResourceVersion } from './db.mjs';
import { recordDisposition, recordDrift } from './governance.mjs';
import { isPrunable, pruneSnapshots } from './retention.mjs';
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

const unexpiredIgnoreSnapshotId = await createOldSnapshotWithIgnoredDrift(unexpiredIgnoreAt);
const deletedSnapshotIds = [];
const deleteSnapshotFake = {
  query(query, values) {
    if (query === 'DELETE FROM snapshot WHERE id = ANY($1::uuid[])') {
      deletedSnapshotIds.push(...values[0]);
      return Promise.resolve({ rows: [] });
    }
    return client.query(query, values);
  },
};
const unexpiredPrunedSnapshotIds = await pruneSnapshots(deleteSnapshotFake, { tenantRef, policy, now });
assert.ok(unexpiredPrunedSnapshotIds.includes(unexpiredIgnoreSnapshotId));
assert.ok(deletedSnapshotIds.includes(unexpiredIgnoreSnapshotId));

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('retention.test.mjs — all assertions passed');
