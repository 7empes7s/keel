// Restores with open follow-up steps are listed with the job that ran them, so the
// portal can show every one of them, not only those still in a recent-jobs window.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { emitCompletionItems, listOpenCompletionWork } from './completion.mjs';
import { enqueue } from '../jobs/queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:open-completion-work';
const recreatedGroup = { naturalKey: 'group:Finance', resourceType: 'group', mechanism: 'recreate' };

test('open follow-up work lists each restore with its pending count and restore job', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

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
