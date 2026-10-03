// Roadmap task-129: the Overview's memorable number (portal experience contract).
//
// Acceptance: the verdict is one sentence under 25 words with the correct number in
// each of the three states the contract names, and reads "Protected" when healthy.
// Mutation check: rendering the number from a constant instead of the coverage
// reader fails this file — every count below is derived from a real report built
// over a collected snapshot, not from a fixture of the sentence.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { collectSnapshot } from '../collect/snapshot.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { formatHeadlineDate, protectionHeadline } from '../coverage/protectionHeadline.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const healthyReader = {
  async collect(version, path) {
    if (path.startsWith('/groups?')) return { items: [{ id: 'g1', mailNickname: 'board' }, { id: 'g2', mailNickname: 'ops' }] };
    return { items: [], error: null };
  },
};
const failingReader = {
  async collect(version, path) {
    if (path === '/roleManagement/directory/roleAssignments') return { items: [], error: { status: 403, error: 'denied' } };
    return healthyReader.collect(version, path);
  },
};

let tenantSeq = 0;
async function collectedTenant(client, reader, collectedAt) {
  tenantSeq += 1;
  const tenantRef = `sha256:task-129-${tenantSeq}`;
  const { snapshotId } = await collectSnapshot(client, { reader, tenantRef, tenantId: `tenant-${tenantSeq}` });
  // Pin the collection time so freshness is deterministic.
  await client.query('UPDATE snapshot SET started_at = $2, completed_at = $2 WHERE id = $1', [snapshotId, collectedAt]);
  return tenantRef;
}

const report = (client, tenantRef, now) => buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now });
const words = (sentence) => sentence.trim().split(/\s+/).length;

test('nothing proven yet: the sentence counts the types the reader says are backed up', async (t) => {
  const client = await schemaClient(t);
  const collectedAt = new Date('2026-10-02T09:00:00Z');
  const tenantRef = await collectedTenant(client, healthyReader, collectedAt);
  const { types } = await report(client, tenantRef, new Date('2026-10-02T10:00:00Z'));

  const backedUp = types.filter((entry) => entry.status === 'covered' && !entry.stale);
  assert.ok(backedUp.length > 10, 'the fixture collection backs up the whole descriptor set');
  const headline = protectionHeadline(types);
  assert.equal(headline.state, 'unproven');
  assert.equal(headline.counts.backedUp, backedUp.length);
  assert.equal(headline.sentence, `KEEL backs up ${backedUp.length} configuration types. No restore has been proven on this tenant yet.`);
  assert.equal(headline.headline, 'Backed up', 'never "Protected" before a restore was proven');
  assert.deepEqual(headline.action, { label: 'Plan a test restore', href: '/restore' });
  assert.ok(words(headline.sentence) <= 25);
});

test('a proven restore: "Protected", restorable of backed-up counts and the drill date, all from the reader', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = await collectedTenant(client, healthyReader, new Date('2026-10-02T09:00:00Z'));
  await appendEvidence(client, {
    tenantRef, kind: 'fidelity-drill', actor: 'drill', subject: { resourceType: 'group', measuredFidelity: 'full' },
  });
  // A drill that measured a type lower than declared changes the count.
  await appendEvidence(client, {
    tenantRef, kind: 'fidelity-drill', actor: 'drill', subject: { resourceType: 'namedLocation', measuredFidelity: 'read-only' },
  });
  const { types } = await report(client, tenantRef, new Date('2026-10-02T10:00:00Z'));
  const backedUp = types.filter((entry) => entry.status === 'covered' && !entry.stale);
  const restorable = backedUp.filter((entry) => ['full', 'partial'].includes(entry.fidelity.verifiedBy?.measuredFidelity ?? entry.fidelity.declared));
  assert.ok(restorable.length < backedUp.length, 'read-only types are backed up but not restorable');
  assert.equal(restorable.some((entry) => entry.type === 'namedLocation'), false, 'a measured fidelity overrides the declared one');

  const headline = protectionHeadline(types);
  const { rows } = await client.query(`SELECT max(occurred_at) AS at FROM evidence WHERE tenant_ref = $1 AND kind = 'fidelity-drill'`, [tenantRef]);
  assert.equal(headline.state, 'proven');
  assert.equal(headline.headline, 'Protected');
  assert.equal(headline.tone, 'good');
  assert.equal(headline.sentence,
    `KEEL can restore ${restorable.length} of ${backedUp.length} configuration types today. Last proven restore: ${formatHeadlineDate(rows[0].at)}.`);
  assert.equal(headline.action, null);
  assert.ok(words(headline.sentence) <= 25);
  assert.doesNotMatch(headline.sentence, /\d{7,}|[{}[\]"]/);
});

test('failing or stale collection: the count of types not backed up and since when, ahead of any proof', async (t) => {
  const client = await schemaClient(t);
  const collectedAt = new Date('2026-10-02T09:00:00Z');
  const tenantRef = await collectedTenant(client, failingReader, collectedAt);
  await appendEvidence(client, {
    tenantRef, kind: 'fidelity-drill', actor: 'drill', subject: { resourceType: 'group', measuredFidelity: 'full' },
  });

  // One type failed outright. Its timestamp is the failed attempt, never "since".
  const fresh = await report(client, tenantRef, new Date('2026-10-02T10:00:00Z'));
  const failed = fresh.types.filter((entry) => entry.status === 'failed');
  assert.equal(failed.length, 1);
  assert.ok(failed[0].lastCollectedAt, 'the failed attempt has a time');
  const headline = protectionHeadline(fresh.types);
  assert.equal(headline.state, 'collection');
  assert.equal(headline.counts.failing, 1);
  assert.equal(headline.sentence, '1 configuration type failed its last backup.');
  assert.deepEqual(headline.action, { label: 'Review backups', href: '/backups' });

  // A week later every tier-1 type is stale too: they count, with the oldest time.
  const late = await report(client, tenantRef, new Date('2026-10-09T10:00:00Z'));
  const stale = late.types.filter((entry) => entry.status === 'covered' && entry.stale);
  assert.ok(stale.length > 0);
  const lateHeadline = protectionHeadline(late.types);
  assert.equal(lateHeadline.counts.failing, failed.length + stale.length);
  assert.equal(lateHeadline.sentence,
    `${failed.length + stale.length} configuration types have no current backup; the last backup failed for 1 of them.`);
  assert.equal(lateHeadline.failingSince, collectedAt.toISOString());

  // Stale only (a healthy collection, a week old): "since" the last good backup.
  const healthy = await collectedTenant(client, healthyReader, collectedAt);
  const staleOnly = protectionHeadline((await report(client, healthy, new Date('2026-10-09T10:00:00Z'))).types);
  assert.equal(staleOnly.sentence,
    `${staleOnly.counts.stale} configuration types have not been backed up since ${formatHeadlineDate(collectedAt)}.`);
  assert.equal(staleOnly.counts.failing, staleOnly.counts.stale);
  assert.ok(words(lateHeadline.sentence) <= 25);
});

test('an empty tenant says plainly that there is nothing to restore from', async (t) => {
  const client = await schemaClient(t);
  const { types } = await report(client, 'sha256:task-129-empty', new Date('2026-10-02T10:00:00Z'));
  const headline = protectionHeadline(types);
  assert.equal(headline.state, 'collection');
  assert.equal(headline.tone, 'critical');
  assert.match(headline.sentence, /never been backed up|Nothing has been backed up/);
});
