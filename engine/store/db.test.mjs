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
