import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createMemorySyncState, createPgSyncState } from './syncState.mjs';

const ref = { tenantRef: 'sha256:KEEL-RT', workload: 'onedrive', key: 'drive:KEEL-RT-drive' };

async function roundTrip(syncState) {
  assert.equal(await syncState.load(ref), null, 'a first run has no state');
  await syncState.save({ ...ref, state: { version: 1, deltaLink: 'KEEL-RT-1', items: { a: { name: 'KEEL-RT-a' } } } });
  await syncState.save({ ...ref, state: { version: 1, deltaLink: 'KEEL-RT-2', items: {} } });
  assert.deepEqual(await syncState.load(ref), { version: 1, deltaLink: 'KEEL-RT-2', items: {} }, 'the last save wins');
  assert.equal(await syncState.load({ ...ref, workload: 'exchange-mail' }), null, 'states are kept per workload');
  assert.equal(await syncState.load({ ...ref, tenantRef: 'sha256:other' }), null, 'states are kept per tenant');
  await assert.rejects(syncState.load({ ...ref, key: '' }), /needs a key/);
}

test('memory sync state keeps the last state per tenant, workload and key', async () => {
  await roundTrip(createMemorySyncState());
});

test('Postgres sync state keeps the last state per tenant, workload and key', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  t.after(async () => {
    await client.end();
    await database.cleanup();
  });
  await client.query(schemaSql());
  await client.query(schemaSql()); // the fragment is safe to re-apply
  await roundTrip(createPgSyncState(client));
});
