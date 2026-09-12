import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createSnapshot, completeSnapshot, insertResourceVersion,
  insertReferences, getLatestSnapshot, getResourceVersions, getReferences,
} from './db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:test' });
assert.ok(snapshotId);

const versionId = await insertResourceVersion(client, {
  snapshotId,
  resource: {
    naturalKey: 'group:FIN-Admins',
    resourceType: 'group',
    payload: { id: 'g-a', mailNickname: 'FIN-Admins' },
    payloadHash: 'abc123',
    criticality: 'tier1',
    blastRadius: 'access-affecting',
    fidelity: 'full',
    provenance: { adapter: 'test' },
  },
});
assert.ok(versionId);

await insertReferences(client, {
  fromVersion: versionId,
  references: [{ field: 'owners[0]', symbol: 'user:ana@contoso.com', required: true }],
});

await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: { group: 1 } });

const latest = await getLatestSnapshot(client, { tenantRef: 'sha256:test' });
assert.equal(latest.id, snapshotId);
assert.equal(latest.status, 'complete');

// The newest usable snapshot is complete with a real completion timestamp. Newer
// running, failed, and incomplete rows stay available as operational evidence.
const usableTenantRef = 'sha256:latest-usable';
const completedSnapshotId = await createSnapshot(client, { tenantRef: usableTenantRef });
await completeSnapshot(client, { id: completedSnapshotId, status: 'complete' });
await client.query(
  'UPDATE snapshot SET started_at = $2, completed_at = $3 WHERE id = $1',
  [completedSnapshotId, '2040-01-01T00:00:00Z', '2040-01-01T00:01:00Z'],
);

const runningSnapshotId = await createSnapshot(client, { tenantRef: usableTenantRef });
await client.query(
  'UPDATE snapshot SET started_at = $2 WHERE id = $1',
  [runningSnapshotId, '2040-01-01T00:04:00Z'],
);

const failedSnapshotId = await createSnapshot(client, { tenantRef: usableTenantRef });
await client.query(
  'UPDATE snapshot SET status = $2, started_at = $3 WHERE id = $1',
  [failedSnapshotId, 'failed', '2040-01-01T00:02:00Z'],
);

const incompleteSnapshotId = await createSnapshot(client, { tenantRef: usableTenantRef });
await client.query(
  'UPDATE snapshot SET status = $2, started_at = $3 WHERE id = $1',
  [incompleteSnapshotId, 'complete', '2040-01-01T00:03:00Z'],
);

const incompleteSnapshotIds = [runningSnapshotId, failedSnapshotId, incompleteSnapshotId];
const { rows: incompleteBeforeLookup } = await client.query(
  `SELECT id, status, started_at, completed_at
   FROM snapshot
   WHERE id = ANY($1::uuid[])
   ORDER BY id`,
  [incompleteSnapshotIds],
);
const latestUsable = await getLatestSnapshot(client, { tenantRef: usableTenantRef });
assert.equal(latestUsable.id, completedSnapshotId, 'a newer running snapshot is not usable');
const { rows: incompleteAfterLookup } = await client.query(
  `SELECT id, status, started_at, completed_at
   FROM snapshot
   WHERE id = ANY($1::uuid[])
   ORDER BY id`,
  [incompleteSnapshotIds],
);
assert.deepEqual(incompleteAfterLookup, incompleteBeforeLookup, 'incomplete rows remain unchanged');

const noUsableTenantRef = 'sha256:no-usable-snapshot';
const onlyIncompleteSnapshotId = await createSnapshot(client, { tenantRef: noUsableTenantRef });
await client.query('UPDATE snapshot SET status = $2 WHERE id = $1', [onlyIncompleteSnapshotId, 'complete']);
assert.equal(
  await getLatestSnapshot(client, { tenantRef: noUsableTenantRef }),
  null,
  'a row labelled complete without completed_at is not usable',
);

const tieTenantRef = 'sha256:completion-tie';
const firstTieSnapshotId = await createSnapshot(client, { tenantRef: tieTenantRef });
const secondTieSnapshotId = await createSnapshot(client, { tenantRef: tieTenantRef });
await completeSnapshot(client, { id: firstTieSnapshotId, status: 'complete' });
await completeSnapshot(client, { id: secondTieSnapshotId, status: 'complete' });
await client.query(
  `UPDATE snapshot
   SET started_at = $2, completed_at = $2
   WHERE id = ANY($1::uuid[])`,
  [[firstTieSnapshotId, secondTieSnapshotId], '2040-01-02T00:00:00Z'],
);
const { rows: expectedTieWinner } = await client.query(
  `SELECT id FROM snapshot
   WHERE id = ANY($1::uuid[])
   ORDER BY id DESC
   LIMIT 1`,
  [[firstTieSnapshotId, secondTieSnapshotId]],
);
const tiedLatest = await getLatestSnapshot(client, { tenantRef: tieTenantRef });
assert.equal(tiedLatest.id, expectedTieWinner[0].id, 'equal timestamps resolve deterministically');

const versions = await getResourceVersions(client, { snapshotId });
assert.equal(versions.length, 1);
assert.equal(versions[0].natural_key, 'group:FIN-Admins');

const refs = await getReferences(client, { snapshotId });
assert.equal(refs.length, 1);
assert.equal(refs[0].to_symbol, 'user:ana@contoso.com');

// Duplicate natural key within one snapshot must be rejected at the DB level too
// (defence in depth — canonicalize.mjs already refuses it in-process).
await assert.rejects(() =>
  insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:FIN-Admins', resourceType: 'group', payload: {}, payloadHash: 'x',
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: {},
    },
  }),
);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('db.test.mjs — all assertions passed');
