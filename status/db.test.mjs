// status/db.test.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { connect } from './db.mjs';
import {
  createIsolatedTestDatabase, quoteIdentifier,
} from '../engine/test/dbTestHelper.mjs';

const TEST_STATUS_PASSWORD = 'status-test-only-not-a-real-secret';
const database = await createIsolatedTestDatabase(import.meta.url);
const role = `keel_status_test_${database.schema.slice('keel_test_'.length)}`;
let admin;
let client;

try {
  admin = await database.connect();
  await admin.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
  const roleSql = readFileSync(new URL('./setupRole.sql', import.meta.url), 'utf8')
    .replaceAll('keel_status', role)
    .replace('SCHEMA public', `SCHEMA ${quoteIdentifier(database.schema)}`);
  await admin.query(roleSql);
  await admin.query(`ALTER ROLE ${quoteIdentifier(role)} WITH PASSWORD '${TEST_STATUS_PASSWORD}'`);

  const statusUrl = database.urlForRole({ user: role, password: TEST_STATUS_PASSWORD });
  client = await connect(statusUrl);

  for (const table of [
    'snapshot', 'resource_version', 'baseline', 'drift', 'disposition', 'evidence', 'evidence_head',
  ]) {
    await client.query(`SELECT * FROM ${table} LIMIT 1`);
  }

  // Postgres error code 42501 = insufficient_privilege.
  await assert.rejects(
    client.query(`INSERT INTO snapshot (tenant_ref) VALUES ('sha256:should-fail')`),
    (error) => error.code === '42501',
  );
} finally {
  await client?.end();
  try {
    await database.cleanup();
  } finally {
    await admin?.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    await admin?.end();
  }
}

console.log('db.test.mjs — all assertions passed');
