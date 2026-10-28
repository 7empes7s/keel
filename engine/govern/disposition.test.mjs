import { strict as assert } from 'node:assert';
import { applyDisposition, isSuppressed } from './disposition.mjs';
import { seedFromSnapshot } from './baseline.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

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

// An ignore recorded under older hash rules still covers the same content (#580 follow-up).
const oldRuleIgnore = {
  ...unexpiredIgnore,
  drift: { naturalKey: 'group:disposition-test', resourceType: 'group', afterHash: 'old-rule-hash', afterPayload: { displayName: 'Changed' } },
};
assert.equal(isSuppressed({ ...drift, resourceType: 'group', afterPayload: { displayName: 'Changed' } }, [oldRuleIgnore], now), true);
assert.equal(isSuppressed({ ...drift, resourceType: 'group', afterPayload: { displayName: 'Changed again' } }, [oldRuleIgnore], now), false);
assert.equal(isSuppressed(drift, [oldRuleIgnore], now), false, 'without the payload, a different hash stays a difference');

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(schemaSql());

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
await completeSnapshot(client, {
  id: baselineSnapshotId,
  status: 'complete',
  coverageDigest: fullSuccessfulCoverageDigest(),
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

const ignoreUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
const dispositionId = await applyDisposition(client, {
  driftId,
  action: 'ignore',
  actor: 'test-operator',
  reason: 'time-boxed investigation',
  // An ignore is compared with now (at most 90 days ahead), so its end is set from the run.
  expiresAt: ignoreUntil,
});
assert.ok(dispositionId);
const { rows: dispositions } = await client.query(
  'SELECT action, expires_at FROM disposition WHERE id = $1',
  [dispositionId],
);
assert.equal(dispositions[0].action, 'ignore');
assert.equal(dispositions[0].expires_at.toISOString(), ignoreUntil.toISOString());
await assert.rejects(
  () => applyDisposition(client, {
    driftId,
    action: 'ignore',
    actor: 'test-operator',
    reason: 'unbounded ignore',
  }),
  /requires expiresAt/,
);

// An ignored change recorded under older hash rules is seen again with the same content
// under new hashes: the ignored row is kept, so the change does not come back.
const oldRuleKey = 'group:disposition-old-rule';
const oldRule = {
  tenantRef, baselineId, observedSnapshot: observedSnapshotId, naturalKey: oldRuleKey, resourceType: 'group',
  changeType: 'modified', beforePayload: { displayName: 'Before' }, afterPayload: { displayName: 'After' }, blastRadius: 'access-affecting',
};
const ignoredId = await recordDrift(client, { ...oldRule, beforeHash: 'old-rule-before', afterHash: 'old-rule-after' });
await applyDisposition(client, {
  driftId: ignoredId, action: 'ignore', actor: 'test-operator', reason: 'known change',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
});
assert.equal(await recordDrift(client, { ...oldRule, beforeHash: 'new-rule-before', afterHash: 'new-rule-after' }), ignoredId);
// A different content is a new change.
const laterSnapshotId = await createSnapshot(client, { tenantRef });
assert.notEqual(await recordDrift(client, {
  ...oldRule, observedSnapshot: laterSnapshotId, beforeHash: 'new-rule-before', afterHash: 'changed-again', afterPayload: { displayName: 'After again' },
}), ignoredId);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('disposition.test.mjs — all assertions passed');
