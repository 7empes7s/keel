/**
 * Issue #1076: each backup lists the deleted users, groups, apps and Conditional
 * Access policies, so the Changes list can say until when a removed one can be
 * recovered. A fake reader stands in for Graph; nothing reads a tenant.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { readDeletedItems } from '../reconcile/deletedItems.mjs';
import { createSnapshot } from './db.mjs';
import { currentDeletedItems, recordDeletedItems } from './deletedItems.mjs';
import { schemaSql } from './loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { tenantRefFor } from './tenantRef.mjs';
import { runCollect } from '../../cli/keel-collect.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
after(async () => { await client.end(); await database.cleanup(); });

const TENANT = 'sha256:deleted-items-test';
const USERS = '/directory/deletedItems/microsoft.graph.user';
const POLICIES = '/identity/conditionalAccess/deletedItems/policies';

function reader(listings) {
  const paths = [];
  return {
    paths,
    async collect(version, path) {
      paths.push(path);
      const key = Object.keys(listings).find((prefix) => path.startsWith(prefix));
      const listing = key ? listings[key] : [];
      return listing instanceof Error ? { items: undefined, error: { status: 403, error: listing.message } } : { items: listing };
    },
  };
}

const complete = { outcome: 'complete' };

test('only the soft-deletable types this backup read are listed, each with its outcome', async () => {
  const graph = reader({
    [USERS]: [{ id: 'U-1', deletedDateTime: '2026-10-01T10:00:00Z' }],
    [POLICIES]: new Error('denied'),
  });
  const reads = await readDeletedItems(graph, {
    coverageDigest: { user: complete, conditionalAccessPolicy: complete, group: { outcome: 'failed' }, namedLocation: complete },
  });
  assert.deepEqual(reads.map((read) => [read.resourceType, read.outcome]), [['user', 'complete'], ['conditionalAccessPolicy', 'failed']]);
  assert.ok(graph.paths[0].includes('deletedDateTime'), 'the user listing names deletedDateTime');
  assert.deepEqual(reads[0].items, [{ sourceId: 'u-1', deletedAt: '2026-10-01T10:00:00Z' }]);
});

test('the current deleted items are those the latest complete read listed', async () => {
  const first = await createSnapshot(client, { tenantRef: TENANT });
  await recordDeletedItems(client, {
    tenantRef: TENANT, snapshotId: first, readAt: new Date('2026-10-02T00:00:00Z'),
    reads: [
      { resourceType: 'user', outcome: 'complete', items: [{ sourceId: 'u-1', deletedAt: '2026-10-01T10:00:00Z' }, { sourceId: 'u-2', deletedAt: '2026-10-01T11:00:00Z' }] },
      { resourceType: 'conditionalAccessPolicy', outcome: 'complete', items: [{ sourceId: 'ca-1', deletedAt: '2026-09-20T08:00:00Z' }] },
    ],
  });
  const now = await currentDeletedItems(client, { tenantRef: TENANT, sourceIds: ['U-1', 'u-2', 'ca-1', 'g-9'] });
  assert.deepEqual([...now.entries()].sort(), [
    ['conditionalAccessPolicy|ca-1', '2026-09-20T08:00:00.000Z'],
    ['user|u-1', '2026-10-01T10:00:00.000Z'],
    ['user|u-2', '2026-10-01T11:00:00.000Z'],
  ]);

  // The next backup no longer lists Ben (restored or purged), and its policy read failed:
  // Ben is no longer deleted, and the policy keeps the last read that worked.
  const second = await createSnapshot(client, { tenantRef: TENANT });
  await recordDeletedItems(client, {
    tenantRef: TENANT, snapshotId: second, readAt: new Date('2026-10-03T00:00:00Z'),
    reads: [
      { resourceType: 'user', outcome: 'complete', items: [{ sourceId: 'u-1', deletedAt: '2026-10-01T10:00:00Z' }] },
      { resourceType: 'conditionalAccessPolicy', outcome: 'failed', items: [] },
    ],
  });
  const later = await currentDeletedItems(client, { tenantRef: TENANT, sourceIds: ['u-1', 'u-2', 'ca-1'] });
  assert.deepEqual([...later.keys()].sort(), ['conditionalAccessPolicy|ca-1', 'user|u-1']);

  // Another tenant's reads never answer.
  assert.equal((await currentDeletedItems(client, { tenantRef: 'sha256:other', sourceIds: ['u-1'] })).size, 0);
  assert.equal((await currentDeletedItems(client, { tenantRef: TENANT, sourceIds: [] })).size, 0);
});

test('every backup lists deleted items after its snapshot, and a failed listing never fails the backup', async () => {
  const backup = (graph, logs) => runCollect({
    config: { tenantId: 'fixture-tenant' },
    dbUrl: 'postgres://fixture',
    dependencies: {
      connect: async () => ({ query: (...args) => client.query(...args), end: async () => {} }),
      getToken: async () => ({ accessToken: 'fixture-token' }),
      GraphReader: class { constructor() { return graph; } },
      collectSnapshot: async (db, { tenantRef }) => ({ snapshotId: await createSnapshot(db, { tenantRef }), coverageDigest: { group: complete } }),
    },
    logger: { log: (line) => logs.push(line), error() {}, table() {} },
  });
  const logs = [];
  const done = await backup(reader({ '/directory/deletedItems/microsoft.graph.group': [{ id: 'g-1', deletedDateTime: '2026-10-05T00:00:00Z' }] }), logs);
  assert.equal(done.exitCode, 0);
  assert.ok(logs.includes('deleted items: 1 listed'));
  const tenantRef = tenantRefFor('fixture-tenant');
  assert.deepEqual([...(await currentDeletedItems(client, { tenantRef, sourceIds: ['g-1'] })).entries()], [['group|g-1', '2026-10-05T00:00:00.000Z']]);

  const failing = [];
  const broken = await backup({ async collect() { throw new Error('socket hang up'); } }, failing);
  assert.equal(broken.exitCode, 0);
  assert.ok(failing.includes('deleted items: 0 listed; not read for group'));
  assert.equal((await currentDeletedItems(client, { tenantRef, sourceIds: ['g-1'] })).size, 1, 'the last listing that worked still answers');
});
