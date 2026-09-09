import { strict as assert } from 'node:assert';
import { recordPriorState, buildRollbackPlan } from './rollbackJournal.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  const admin = await database.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(`
      CREATE TABLE rollback_entry (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id text NOT NULL,
        natural_key text NOT NULL,
        prior_state jsonb,
        recorded_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  } finally {
    await admin.end();
  }

  client = await database.connect();
const runId = 'run-test-1';

// A create (no prior object) records prior_state = null -> rollback action "delete".
await recordPriorState(client, { runId, naturalKey: 'group:New-Thing', priorState: null });
// An update records the actual prior payload -> rollback action "restore-prior".
await recordPriorState(client, { runId, naturalKey: 'group:Existing-Thing', priorState: { displayName: 'Old Name' } });

const plan = await buildRollbackPlan(client, { runId });
const byKey = Object.fromEntries(plan.map((p) => [p.naturalKey, p]));
assert.equal(byKey['group:New-Thing'].action, 'delete');
assert.equal(byKey['group:Existing-Thing'].action, 'restore-prior');
assert.equal(byKey['group:Existing-Thing'].priorState.displayName, 'Old Name');

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('rollbackJournal.test.mjs — all assertions passed');
