import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createSnapshot, insertResourceVersion } from './db.mjs';
import {
  createBaseline, seedBaselineFromSnapshot, getActiveBaseline, recordDrift,
  listOpenDrift, recordDisposition,
} from './governance.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const tenantRef = 'sha256:governance-test';
const expiredIgnoreAt = new Date('2000-01-01T00:00:00.000Z');
const unexpiredIgnoreAt = new Date('2099-01-01T00:00:00.000Z');
const snapshotId = await createSnapshot(client, { tenantRef });
const versionId = await insertResourceVersion(client, {
  snapshotId,
  resource: {
    naturalKey: 'group:governance-test',
    resourceType: 'group',
    payload: { displayName: 'Governance test' },
    payloadHash: 'baseline-hash',
    criticality: 'tier1',
    blastRadius: 'access-affecting',
    fidelity: 'full',
    provenance: { adapter: 'test' },
  },
});

const baselineId = await createBaseline(client, { tenantRef, setBy: 'test-operator' });
await seedBaselineFromSnapshot(client, { baselineId, snapshotId });
const activeBaseline = await getActiveBaseline(client, { tenantRef });
assert.equal(activeBaseline.id, baselineId);

const { rows: baselineResources } = await client.query(
  'SELECT * FROM baseline_resource WHERE baseline_id = $1',
  [baselineId],
);
assert.equal(baselineResources.length, 1);
assert.equal(baselineResources[0].resource_version_id, versionId);

await assert.rejects(() =>
  createBaseline(client, { tenantRef, setBy: 'another-operator' }),
);

const observedSnapshot = await createSnapshot(client, { tenantRef });
const expiredDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot,
  naturalKey: 'group:governance-test',
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'baseline-hash',
  afterHash: 'expired-ignore-hash',
  beforePayload: { displayName: 'Governance test' },
  afterPayload: { displayName: 'Changed' },
  blastRadius: 'access-affecting',
});
assert.ok(expiredDriftId);

let openDrift = await listOpenDrift(client, { tenantRef });
assert.deepEqual(openDrift.map((row) => row.id), [expiredDriftId]);

await recordDisposition(client, {
  driftId: expiredDriftId,
  action: 'ignore',
  actor: 'test-operator',
  reason: 'expired test ignore',
  expiresAt: expiredIgnoreAt,
});
openDrift = await listOpenDrift(client, { tenantRef });
assert.deepEqual(openDrift.map((row) => row.id), [expiredDriftId]);

const unexpiredDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot,
  naturalKey: 'group:governance-test-unexpired',
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'baseline-hash',
  afterHash: 'unexpired-ignore-hash',
  beforePayload: { displayName: 'Governance test' },
  afterPayload: { displayName: 'Changed again' },
  blastRadius: 'access-affecting',
});
await recordDisposition(client, {
  driftId: unexpiredDriftId,
  action: 'ignore',
  actor: 'test-operator',
  reason: 'unexpired test ignore',
  expiresAt: unexpiredIgnoreAt,
});
openDrift = await listOpenDrift(client, { tenantRef });
assert.deepEqual(openDrift.map((row) => row.id), [expiredDriftId]);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('governance.test.mjs — all assertions passed');
