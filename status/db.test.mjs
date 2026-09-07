// status/db.test.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect } from './db.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');

const TEST_STATUS_PASSWORD = 'status-test-only-not-a-real-secret';

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
  'DROP TABLE IF EXISTS evidence, evidence_head, disposition, drift, baseline_resource, baseline, '
  + 'resource_reference, rollback_entry, resource_version, plan, snapshot CASCADE',
);
await admin.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
await admin.query(readFileSync(new URL('./setupRole.sql', import.meta.url), 'utf8'));
await admin.query(`ALTER ROLE keel_status WITH PASSWORD '${TEST_STATUS_PASSWORD}'`);

const statusUrl = url.replace(/\/\/[^:]+:[^@]+@/, `//keel_status:${TEST_STATUS_PASSWORD}@`);
const client = await connect(statusUrl);

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

await client.end();
await admin.end();

console.log('db.test.mjs — all assertions passed');
