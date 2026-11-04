import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { loadChangeFeed } from './feed.mjs';

// Issue #981: a reader scoped to some entities gets only drift rows for settings their
// entities own (the same filter as Open changes). Service reads and the audit log are
// tenant-wide and never read for them. Ownership itself is covered end to end in
// portal/test/change-feed-scope.test.ts; here nothing is owned by anyone, so an entity
// reader gets nothing, while a central reader's feed is unchanged.

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
after(async () => {
  await client?.end();
  await database.cleanup();
});

const TENANT = 'feed-scope';
const GROUP = '9a000000-0000-4000-8000-000000000002';
// Every time is set relative to the run, so the test never rots (lessons 2026-10-04, 2026-10-08).
const NOW = new Date();
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@contoso.test') RETURNING id", [TENANT, hoursAgo(100)]);
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, $2, $2, 'complete') RETURNING id", [TENANT, hoursAgo(10)],
  );
  await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, after_payload, blast_radius, detected_at)
     VALUES ($1, $2, $3, 'group:Finance', 'group', 'modified', 'h1', 'h2', $4, 'scoped', $5)`,
    [TENANT, baseline.id, snapshot.id, { id: GROUP, displayName: 'Finance' }, hoursAgo(9)],
  );
  await client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, 'entra:s1:0', $2, 'Group', $3, 'update', 'Add member to group', 'user', 'a0a00000-0000-4000-8000-0000000000a1')`,
    [TENANT, hoursAgo(5), GROUP],
  );
});

test('a central reader, with or without a scope given, gets every source', async () => {
  for (const scope of [undefined, null, { central: true, entities: [] }]) {
    const { rows } = await loadChangeFeed(client, { tenantRef: TENANT, now: NOW, scope });
    assert.deepEqual(rows.map((row) => row.source).sort(), ['audit', 'drift']);
  }
});

test('an entity reader gets only drift rows their entities own, so none here; an empty scope gets none', async () => {
  const queries = [];
  const spy = { query: (sql, values) => { queries.push(sql); return client.query(sql, values); } };
  for (const scope of [{ central: false, entities: ['CREOS'] }, { central: false, entities: [] }]) {
    const feed = await loadChangeFeed(spy, { tenantRef: TENANT, now: NOW, scope });
    assert.deepEqual(feed.rows, []);
    assert.equal(feed.truncated, false);
  }
  // Tenant-wide sources are not even read.
  assert.ok(!queries.some((sql) => /FROM audit_change_fact\s+WHERE tenant_ref = \$1 AND occurred_at/.test(sql)));
  assert.ok(!queries.some((sql) => /FROM workload_drift d/.test(sql)));
  assert.ok(!queries.some((sql) => /FROM content_item c/.test(sql)));
});
