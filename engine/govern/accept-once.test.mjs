// A change is accepted once. The 31 Oct burst sent each accept twice (all at once, then
// again), and 880 accept rows were written for 571 changes. A second accept, sent after
// the first or at the same moment, now writes no second row.
import { strict as assert } from 'node:assert';
import { acceptDrift, seedFromSnapshot } from './baseline.mjs';
import { applyDisposition } from './disposition.mjs';
import { DISPOSE_APPROVAL_ACTION, driftAlreadyAccepted, pendingDisposeRequest } from './dispositionReview.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
let other;

try {
  client = await database.connect();
  other = await database.connect();
  await client.query(schemaSql());
  const tenantRef = 'sha256:accept-once-test';

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

  const baselineSnapshot = await fullSnapshot();
  for (const key of ['alpha', 'beta', 'gamma']) await addGroup(baselineSnapshot, `group:${key}`, key);
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: baselineSnapshot, setBy: 'tester' });

  const observed = await fullSnapshot();
  const driftIds = {};
  for (const key of ['alpha', 'beta', 'gamma']) {
    await addGroup(observed, `group:${key}`, `${key} changed`);
    driftIds[key] = await recordDrift(client, {
      tenantRef, baselineId, observedSnapshot: observed, naturalKey: `group:${key}`, resourceType: 'group',
      changeType: 'modified', beforeHash: `group:${key}:${key}`, afterHash: `group:${key}:${key} changed`,
      beforePayload: { displayName: key }, afterPayload: { displayName: `${key} changed` }, blastRadius: 'access-affecting',
    });
  }
  const acceptRows = async (driftId) => (await client.query(
    "SELECT count(*)::int AS n FROM disposition WHERE drift_id = $1 AND action = 'accept'", [driftId],
  )).rows[0].n;
  const acceptEvidence = async () => (await client.query(
    "SELECT count(*)::int AS n FROM evidence WHERE tenant_ref = $1 AND kind = 'disposition'", [tenantRef],
  )).rows[0].n;

  // Sent again after the first finished: the second is skipped and says so.
  assert.equal(await driftAlreadyAccepted(client, { driftId: driftIds.alpha }), false);
  assert.equal(await acceptDrift(client, { driftId: driftIds.alpha, actor: 'tester', reason: 'first' }), undefined);
  const evidenceAfterFirst = await acceptEvidence();
  assert.deepEqual(
    await acceptDrift(client, { driftId: driftIds.alpha, actor: 'tester', reason: 'second' }),
    { alreadyAccepted: true },
  );
  assert.deepEqual(
    await applyDisposition(client, { driftId: driftIds.alpha, action: 'accept', actor: 'tester', reason: 'third' }),
    { alreadyAccepted: true },
  );
  assert.equal(await acceptRows(driftIds.alpha), 1);
  assert.equal(await acceptEvidence(), evidenceAfterFirst, 'a skipped accept writes no evidence');
  assert.equal(await driftAlreadyAccepted(client, { driftId: driftIds.alpha }), true);

  // Sent twice at the same moment on two connections: the row lock makes one wait, and it
  // then sees the first accept.
  const both = await Promise.all([
    acceptDrift(client, { driftId: driftIds.beta, actor: 'tester', reason: 'one' }),
    acceptDrift(other, { driftId: driftIds.beta, actor: 'tester', reason: 'two' }),
  ]);
  assert.equal(both.filter((result) => result?.alreadyAccepted).length, 1);
  assert.equal(await acceptRows(driftIds.beta), 1);

  // An ignore is still recorded on its own: only a second accept is skipped.
  await applyDisposition(client, { driftId: driftIds.gamma, action: 'ignore', actor: 'tester', reason: 'later',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  assert.equal(await driftAlreadyAccepted(client, { driftId: driftIds.gamma }), false);

  // A dispose request already waiting for the same accept is found, so it is not asked twice.
  const { rows: [waiting] } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, expires_at)
     VALUES ($1, $2, 'requester', now() + interval '1 day') RETURNING id`,
    [DISPOSE_APPROVAL_ACTION, { driftIds: [driftIds.gamma], action: 'accept', reason: 'r' }],
  );
  await client.query(
    `INSERT INTO approval_request (action, params, requested_by, expires_at)
     VALUES ($1, $2, 'requester', now() + interval '1 day')`,
    [DISPOSE_APPROVAL_ACTION, { serviceChangeId: 'svc-1', action: 'accept' }],
  );
  assert.equal((await pendingDisposeRequest(client, { driftId: driftIds.gamma, action: 'accept', requestedBy: 'requester' }))?.id, waiting.id);
  assert.equal(await pendingDisposeRequest(client, { driftId: driftIds.gamma, action: 'ignore', requestedBy: 'requester' }), null);
  assert.equal(await pendingDisposeRequest(client, { driftId: driftIds.gamma, action: 'accept', requestedBy: 'someone-else' }), null,
    "another person's request is never handed back as theirs");
  assert.equal(await pendingDisposeRequest(client, { driftId: driftIds.alpha, action: 'accept', requestedBy: 'requester' }), null);
  assert.ok(await pendingDisposeRequest(client, { serviceChangeId: 'svc-1', action: 'accept', requestedBy: 'requester' }));
  assert.equal(await pendingDisposeRequest(client, { serviceChangeId: 'svc-2', action: 'accept', requestedBy: 'requester' }), null);
  // One that was decided or ran out no longer counts.
  await client.query("UPDATE approval_request SET status = 'expired' WHERE id = $1", [waiting.id]);
  assert.equal(await pendingDisposeRequest(client, { driftId: driftIds.gamma, action: 'accept', requestedBy: 'requester' }), null);
} finally {
  await other?.end();
  await client?.end();
  await database.cleanup();
}
console.log('accept-once.test.mjs — all assertions passed');
