import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { appendEvidence, verifyChain } from './evidence.mjs';
import { canonicalize } from '../cir/canonicalHash.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query('DROP TABLE IF EXISTS evidence_head, evidence');
await admin.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
await admin.end();

const client = new pg.Client({ connectionString: url });
await client.connect();
const tenantRef = 'sha256:evidence-truncation-test';

await appendEvidence(client, {
  tenantRef,
  kind: 'baseline',
  subject: { naturalKey: 'group:alpha', changeType: 'added' },
  actor: 'test-operator',
});
await appendEvidence(client, {
  tenantRef,
  kind: 'disposition',
  subject: { afterHash: 'after-alpha', naturalKey: 'group:alpha' },
  actor: 'test-operator',
});
await appendEvidence(client, {
  tenantRef,
  kind: 'rollback',
  subject: { naturalKey: 'group:beta', changeType: 'modified' },
  actor: 'test-operator',
});

assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });

const { rows } = await client.query(
  `SELECT seq, tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash
   FROM evidence
   WHERE tenant_ref = $1
   ORDER BY seq`,
  [tenantRef],
);
for (const row of rows) {
  const expectedRecordHash = createHash('sha256')
    .update(
      `${row.prev_hash ?? ''}${row.tenant_ref}${row.occurred_at.toISOString()}${row.kind}`
      + `${JSON.stringify(canonicalize(row.subject, 'group'))}${row.actor}`,
    )
    .digest('hex');
  assert.equal(row.record_hash, expectedRecordHash);
}
const newest = rows.at(-1);
await client.query('DELETE FROM evidence WHERE seq = $1', [newest.seq]);
assert.deepEqual(
  await verifyChain(client, { tenantRef }),
  { ok: false, reason: 'truncated', expectedSeq: newest.seq, actualSeq: rows.at(-2).seq },
);

const editTenantRef = 'sha256:evidence-edit-test';
await appendEvidence(client, {
  tenantRef: editTenantRef,
  kind: 'baseline',
  subject: { naturalKey: 'group:alpha', changeType: 'added' },
  actor: 'test-operator',
});
await appendEvidence(client, {
  tenantRef: editTenantRef,
  kind: 'disposition',
  subject: { afterHash: 'after-alpha', naturalKey: 'group:alpha' },
  actor: 'test-operator',
});
await appendEvidence(client, {
  tenantRef: editTenantRef,
  kind: 'rollback',
  subject: { naturalKey: 'group:beta', changeType: 'modified' },
  actor: 'test-operator',
});
assert.deepEqual(await verifyChain(client, { tenantRef: editTenantRef }), { ok: true });

const { rows: editRows } = await client.query(
  `SELECT seq, subject
   FROM evidence
   WHERE tenant_ref = $1
   ORDER BY seq`,
  [editTenantRef],
);
const middle = editRows[1];
await client.query(
  'UPDATE evidence SET subject = $1 WHERE seq = $2',
  [{ ...middle.subject, afterHash: 'tampered-hash' }, middle.seq],
);
assert.deepEqual(
  await verifyChain(client, { tenantRef: editTenantRef }),
  { ok: false, brokenAtSeq: middle.seq },
);

await client.end();
console.log('evidence.test.mjs — all assertions passed');
