import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createIsolatedTestDatabase } from '../../test/dbTestHelper.mjs';
import { schemaSql } from '../../store/loadSchema.mjs';
import { authorizeContentRestore } from './gate.mjs';
import { createMemoryRestoreJournal, createPgRestoreJournal } from './journal.mjs';

const run = { id: 'mail:KEEL-RT-run', tenantRef: 'sha256:KEEL-RT', workload: 'exchange-mail', plan: { at: '2026-10-15T00:00:00.000Z' }, label: 'Restored 2026-10-15' };

async function roundTrip(journal) {
  const opened = await journal.openRun(run);
  assert.equal(opened.status, 'running');
  assert.equal((await journal.openRun({ ...run, label: 'Restored 2026-10-16' })).label, 'Restored 2026-10-15', 'a resumed run keeps its label');
  await assert.rejects(journal.openRun({ ...run, tenantRef: 'sha256:other' }), /another tenant/);
  assert.equal(await journal.entry(run.id, 'keel-content:a'), null);
  await journal.mark(run.id, 'keel-content:a', { kind: 'mail', status: 'pending' });
  await journal.mark(run.id, 'keel-content:a', { kind: 'mail', status: 'failed', reason: 'reset' });
  await journal.mark(run.id, 'keel-content:a', { kind: 'mail', status: 'pending' });
  const done = await journal.mark(run.id, 'keel-content:a', { kind: 'mail', status: 'restored', targetId: 'new-1' });
  assert.deepEqual(done, { sourceKey: 'keel-content:a', kind: 'mail', status: 'restored', targetId: 'new-1', reason: null, attempts: 2 });
  await journal.mark(run.id, 'container:mail:f1', { kind: 'mail-container', status: 'restored', targetId: 'folder-1' });
  assert.deepEqual((await journal.entries(run.id)).map((entry) => entry.sourceKey), ['container:mail:f1', 'keel-content:a']);
  await assert.rejects(journal.mark(run.id, 'keel-content:b', { kind: 'mail', status: 'done' }), /entry status/);
  await journal.finishRun(run.id, { status: 'completed', report: { restored: 1 } });
  await assert.rejects(journal.finishRun(run.id, { status: 'done' }), /run status/);
}

test('memory restore journal', async () => {
  await roundTrip(createMemoryRestoreJournal());
});

test('Postgres restore journal, and the content restore gate', async (t) => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  t.after(async () => {
    await client.end();
    await database.cleanup();
  });
  await client.query(schemaSql());
  await client.query(schemaSql()); // the fragment is safe to re-apply
  await roundTrip(createPgRestoreJournal(client));
  const { rows: [held] } = await client.query('SELECT status, report FROM content_restore_run WHERE id = $1', [run.id]);
  assert.deepEqual(held, { status: 'completed', report: { restored: 1 } });

  const { rows: [actor] } = await client.query(`INSERT INTO principal (email) VALUES ('keel-rt-operator@contoso.test') RETURNING id`);
  const { rows: [approver] } = await client.query(`INSERT INTO principal (email) VALUES ('keel-rt-approver@contoso.test') RETURNING id`);
  const request = async ({ action = 'content-restore', params = { runId: run.id, tenantRef: run.tenantRef }, requestedBy = actor.id, decidedBy = approver.id, status = 'approved' } = {}) => (await client.query(
    `INSERT INTO approval_request (action, params, requested_by, decided_by, status, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '1 day') RETURNING id`,
    [action, params, requestedBy, decidedBy, status],
  )).rows[0].id;
  const holds = async () => true;
  const check = (approvalId, options = {}) => authorizeContentRestore(client, { actor: actor.id, approvalId, runId: run.id, tenantRef: run.tenantRef, canFn: holds, ...options });

  const good = await request();
  assert.deepEqual(await check(good), { actor: actor.id, approvedBy: approver.id, approvalId: good });
  await assert.rejects(check(good, { canFn: async () => false }), /does not hold the content-restore capability/);
  await assert.rejects(check(good, { runId: 'mail:other' }), /another restore plan/);
  await assert.rejects(check(await request({ status: 'pending', decidedBy: null })), /is pending, not approved/);
  await assert.rejects(check(await request({ action: 'restore' })), /not a content restore/);
  await assert.rejects(check(await request({ decidedBy: actor.id })), /not decided by someone other than the requester/);
  await assert.rejects(check(await request({ requestedBy: approver.id })), /asked by someone else/);
  await assert.rejects(check(undefined), /needs --approval-id/);
  await assert.rejects(authorizeContentRestore(client, { actor: '00000000-0000-0000-0000-000000000000', approvalId: good, runId: run.id, tenantRef: run.tenantRef, canFn: holds }), /not an enabled principal/);
  // Without the injected check, the real role matrix decides: no role grants content-restore yet.
  await assert.rejects(check(good, { canFn: undefined }), /does not hold the content-restore capability/);
});
