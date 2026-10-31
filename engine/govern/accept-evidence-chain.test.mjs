// Accepting a change writes its audit record through the same path as every other
// record, so the audit record still passes its integrity check afterwards. The accept
// path used to insert its record without moving the stored head (evidence_head), so the
// next check reported the record as cut short, and the next appendEvidence chained onto
// the stale head and broke the chain for good.
import { strict as assert } from 'node:assert';
import { acceptDrift, seedFromSnapshot } from './baseline.mjs';
import { appendEvidence, verifyChain } from './evidence.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const connections = [];

try {
  const client = await database.connect();
  connections.push(client);
  await client.query(schemaSql());
  const tenantRef = 'sha256:accept-evidence-chain-test';

  async function fullSnapshot() {
    const id = await createSnapshot(client, { tenantRef });
    await completeSnapshot(client, { id, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
    return id;
  }
  async function addGroup(snapshotId, naturalKey, displayName) {
    return insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey, resourceType: 'group', payload: { displayName }, payloadHash: `${naturalKey}:${displayName}`,
        criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
  }

  const keys = Array.from({ length: 8 }, (_, index) => `g${index}`);
  const baselineSnapshot = await fullSnapshot();
  for (const key of keys) await addGroup(baselineSnapshot, `group:${key}`, key);
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: baselineSnapshot, setBy: 'tester' });

  const observed = await fullSnapshot();
  const driftIds = [];
  for (const key of keys) {
    await addGroup(observed, `group:${key}`, `${key} changed`);
    driftIds.push(await recordDrift(client, {
      tenantRef, baselineId, observedSnapshot: observed, naturalKey: `group:${key}`, resourceType: 'group',
      changeType: 'modified', beforeHash: `group:${key}:${key}`, afterHash: `group:${key}:${key} changed`,
      beforePayload: { displayName: key }, afterPayload: { displayName: `${key} changed` }, blastRadius: 'access-affecting',
    }));
  }

  const records = async () => (await client.query('SELECT count(*)::int AS n FROM evidence WHERE tenant_ref = $1', [tenantRef])).rows[0].n;
  await appendEvidence(client, { tenantRef, kind: 'test.before', subject: { n: 1 }, actor: 'tester', eventSink: () => {} });
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });

  // One accept on its own: the head moves with it.
  await acceptDrift(client, { driftId: driftIds[0], actor: 'tester', reason: 'one' });
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true }, 'an accept keeps the record whole');
  const { rows: [head] } = await client.query(
    'SELECT h.head_seq::text AS seq, h.record_count::text AS count, (SELECT max(seq)::text FROM evidence WHERE tenant_ref = $1) AS last FROM evidence_head h WHERE h.tenant_ref = $1',
    [tenantRef],
  );
  assert.equal(head.seq, head.last, 'the stored head points at the accept record');
  assert.equal(head.count, String(await records()), 'the stored count includes the accept record');

  // A record written after an accept chains onto the accept record.
  await appendEvidence(client, { tenantRef, kind: 'test.after', subject: { n: 2 }, actor: 'tester', eventSink: () => {} });
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true }, 'a record after an accept still chains');

  // A burst: accepts on several connections at once, with other records written between
  // them. Each operation has its own connection, as each request has in the portal.
  const pool = [];
  for (let index = 0; index < keys.length - 1 + 3; index += 1) {
    const connection = await database.connect();
    connections.push(connection);
    pool.push(connection);
  }
  const beforeBurst = await records();
  await Promise.all([
    ...driftIds.slice(1).map((driftId, index) => acceptDrift(pool[index], { driftId, actor: 'tester', reason: 'burst' })),
    ...[3, 4, 5].map((n, index) => appendEvidence(pool[keys.length - 1 + index], { tenantRef, kind: 'test.burst', subject: { n }, actor: 'tester', eventSink: () => {} })),
  ]);
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true }, 'a burst of accepts keeps the record whole');
  assert.equal(await records(), beforeBurst + (keys.length - 1) + 3);
} finally {
  for (const connection of connections) await connection.end();
  await database.cleanup();
}
console.log('accept-evidence-chain.test.mjs — all assertions passed');
