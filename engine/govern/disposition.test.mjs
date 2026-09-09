import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { applyDisposition, isSuppressed } from './disposition.mjs';
import { seedFromSnapshot } from './baseline.mjs';
import { createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const now = new Date('2026-09-04T12:00:00.000Z');
const drift = { naturalKey: 'group:disposition-test', afterHash: 'changed-hash' };
const unexpiredIgnore = {
  action: 'ignore',
  expiresAt: new Date('2026-09-04T12:01:00.000Z'),
  drift: { naturalKey: 'group:disposition-test', afterHash: 'changed-hash' },
};

assert.equal(isSuppressed(drift, [unexpiredIgnore], now), true);
assert.equal(isSuppressed(drift, [{
  ...unexpiredIgnore,
  expiresAt: new Date('2026-09-04T11:59:00.000Z'),
}], now), false);
assert.equal(isSuppressed(drift, [{
  ...unexpiredIgnore,
  drift: { naturalKey: 'group:disposition-test', afterHash: 'different-hash' },
}], now), false);

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

const tenantRef = 'sha256:disposition-test';
const baselineSnapshotId = await createSnapshot(client, { tenantRef });
await insertResourceVersion(client, {
  snapshotId: baselineSnapshotId,
  resource: {
    naturalKey: drift.naturalKey,
    resourceType: 'group',
    payload: { displayName: 'Baseline' },
    payloadHash: 'baseline-hash',
    criticality: 'tier1',
    blastRadius: 'access-affecting',
    fidelity: 'full',
    provenance: { adapter: 'test' },
  },
});
const baselineId = await seedFromSnapshot(client, {
  tenantRef,
  snapshotId: baselineSnapshotId,
  setBy: 'test-operator',
});
const observedSnapshotId = await createSnapshot(client, { tenantRef });
await insertResourceVersion(client, {
  snapshotId: observedSnapshotId,
  resource: {
    naturalKey: drift.naturalKey,
    resourceType: 'group',
    payload: { displayName: 'Changed' },
    payloadHash: drift.afterHash,
    criticality: 'tier1',
    blastRadius: 'access-affecting',
    fidelity: 'full',
    provenance: { adapter: 'test' },
  },
});
const driftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot: observedSnapshotId,
  naturalKey: drift.naturalKey,
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'baseline-hash',
  afterHash: drift.afterHash,
  beforePayload: { displayName: 'Baseline' },
  afterPayload: { displayName: 'Changed' },
  blastRadius: 'access-affecting',
});

const dispositionId = await applyDisposition(client, {
  driftId,
  action: 'ignore',
  actor: 'test-operator',
  reason: 'time-boxed investigation',
  expiresAt: new Date('2026-09-05T12:00:00.000Z'),
});
assert.ok(dispositionId);
const { rows: dispositions } = await client.query(
  'SELECT action, expires_at FROM disposition WHERE id = $1',
  [dispositionId],
);
assert.equal(dispositions[0].action, 'ignore');
assert.equal(dispositions[0].expires_at.toISOString(), '2026-09-05T12:00:00.000Z');
await assert.rejects(
  () => applyDisposition(client, {
    driftId,
    action: 'ignore',
    actor: 'test-operator',
    reason: 'unbounded ignore',
  }),
  /requires expiresAt/,
);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('disposition.test.mjs — all assertions passed');
