// Restores with open follow-up steps are listed with the job that ran them, so the
// portal can show every one of them, not only those still in a recent-jobs window.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { countOpenCompletionSteps, emitCompletionItems, listCompletionItems, listOpenCompletionWork } from './completion.mjs';
import { enqueue } from '../jobs/queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:open-completion-work';
const recreatedGroup = { naturalKey: 'group:Finance', resourceType: 'group', mechanism: 'recreate' };

test('open follow-up work lists each restore with its pending count and restore job', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(schemaSql());

  const restoreRef = '71000000-0000-4000-8000-000000000001';
  const job = await enqueue(client, { kind: 'restore', params: { artifactId: restoreRef, mode: 'enforce' }, requestedBy: 'op' });
  // An undo of the same restore must not be picked as the restore's job.
  await enqueue(client, { kind: 'restore', params: { artifactId: restoreRef, compensates: 'x' }, requestedBy: 'op' });
  // Many newer jobs of another kind do not push the restore out.
  for (let i = 0; i < 5; i++) await enqueue(client, { kind: 'backup', params: {}, requestedBy: 'scheduler' });

  const items = await emitCompletionItems(client, { tenantRef: TENANT, restoreRef, owner: null, applied: [recreatedGroup] });
  assert.ok(items.length >= 2);
  await emitCompletionItems(client, { tenantRef: 'sha256:other-tenant', restoreRef: 'other', owner: null, applied: [recreatedGroup] });

  let work = await listOpenCompletionWork(client, { tenantRef: TENANT });
  assert.equal(work.length, 1, 'one restore, and never another tenant\'s');
  assert.equal(work[0].restoreRef, restoreRef);
  assert.equal(work[0].pending, items.length);
  assert.equal(work[0].jobId, job.id);

  await client.query(`UPDATE recovery_completion_item SET state = 'verified' WHERE tenant_ref = $1`, [TENANT]);
  work = await listOpenCompletionWork(client, { tenantRef: TENANT });
  assert.deepEqual(work, [], 'a restore with nothing pending is not listed');
});

// Restoring the same object again opens the same steps again. The earlier restore's
// steps are replaced, not stacked: one "issue new secrets" step to do, not one per run.
test('a later restore of the same object replaces the earlier restore\'s open steps', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(schemaSql());
  const tenantRef = 'sha256:replaced-steps';
  const first = '72000000-0000-4000-8000-000000000001';
  const second = '72000000-0000-4000-8000-000000000002';
  const app = { naturalKey: 'application:Payroll', resourceType: 'application', mechanism: 'recreate' };
  const other = { naturalKey: 'group:Finance', resourceType: 'group', mechanism: 'recreate' };

  const firstItems = await emitCompletionItems(client, { tenantRef, restoreRef: first, owner: null, applied: [app, other] });
  // Set explicitly so the order never depends on two inserts landing in one tick.
  await client.query(`UPDATE recovery_completion_item SET created_at = now() - interval '1 hour' WHERE restore_ref = $1`, [first]);
  const secondItems = await emitCompletionItems(client, { tenantRef, restoreRef: second, owner: null, applied: [app] });
  const appSteps = secondItems.length;
  const otherSteps = firstItems.length - appSteps;
  assert.ok(appSteps >= 2 && otherSteps >= 1);

  const work = await listOpenCompletionWork(client, { tenantRef });
  assert.deepEqual(
    work.map((entry) => [entry.restoreRef, entry.pending]),
    [[second, appSteps], [first, otherSteps]],
    'the earlier restore keeps only the steps no later restore opened again',
  );
  assert.equal(await countOpenCompletionSteps(client, { tenantRef }), appSteps + otherSteps);

  const earlier = await listCompletionItems(client, { tenantRef, restoreRef: first });
  assert.deepEqual(
    [...new Set(earlier.filter((entry) => entry.replacedBy).map((entry) => `${entry.naturalKey}>${entry.replacedBy}`))],
    [`application:Payroll>${second}`],
    'the job page says which restore replaced each step',
  );
  assert.ok(earlier.every((entry) => entry.state === 'pending'), 'a replaced step is never marked verified');
  assert.ok((await listCompletionItems(client, { tenantRef, restoreRef: second })).every((entry) => entry.replacedBy === null));

  // A step closed with evidence is never counted as replaced work.
  await client.query(`UPDATE recovery_completion_item SET state = 'verified' WHERE restore_ref = $1`, [second]);
  assert.equal(await countOpenCompletionSteps(client, { tenantRef }), otherSteps);
});

// An enforcement step closes only through the approved enforcement step of its own
// restore, so a later restore of the same policy never hides it.
test('an enforcement step is never replaced by a later restore', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(schemaSql());
  const tenantRef = 'sha256:enforcement-not-replaced';
  const policy = { naturalKey: 'conditionalAccessPolicy:Require MFA', resourceType: 'conditionalAccessPolicy', mechanism: 'update-existing', enforcementPending: true };
  const first = await emitCompletionItems(client, { tenantRef, restoreRef: '73000000-0000-4000-8000-000000000001', owner: null, applied: [policy] });
  await client.query(`UPDATE recovery_completion_item SET created_at = now() - interval '1 hour' WHERE tenant_ref = $1`, [tenantRef]);
  const second = await emitCompletionItems(client, { tenantRef, restoreRef: '73000000-0000-4000-8000-000000000002', owner: null, applied: [policy] });
  assert.ok(first.some((entry) => entry.kind === 'enforcement'));
  assert.equal(await countOpenCompletionSteps(client, { tenantRef }), first.length + second.length);
});
