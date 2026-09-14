import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { enqueue } from './queue.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
try {
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const { rows: [viewer] } = await client.query("INSERT INTO principal (email) VALUES ('viewer@fixture.invalid') RETURNING *");
  const { rows: [admin] } = await client.query("INSERT INTO principal (email) VALUES ('admin@fixture.invalid') RETURNING *");
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'viewer'), ($2, 'admin')", [viewer.id, admin.id]);
  await assert.rejects(() => enqueue(client, { kind: 'offsite', requestedBy: viewer.id }), /not authorized to enqueue offsite/);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM job WHERE kind = 'offsite'")).rows[0].n, 0);
  const job = await enqueue(client, { kind: 'offsite', requestedBy: admin.id });
  assert.equal(job.kind, 'offsite');
  await client.query('UPDATE principal SET disabled_at = now() WHERE id = $1', [admin.id]);
  await assert.rejects(() => enqueue(client, { kind: 'offsite', requestedBy: admin.id }), /not authorized to enqueue offsite/);
  await assert.rejects(() => enqueue(client, { kind: 'offsite', requestedBy: 'missing' }), /not authorized to enqueue offsite/);
  console.log('offsite.test.mjs — all assertions passed (read-only enqueue refused, admin accepted, disabled requester refused)');
} finally {
  await client.end();
  await database.cleanup();
}
