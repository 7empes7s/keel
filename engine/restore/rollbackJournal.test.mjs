import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect } from '../store/db.mjs';
import { recordPriorState, buildRollbackPlan } from './rollbackJournal.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set');

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query('DROP TABLE IF EXISTS rollback_entry CASCADE');
await admin.query(`
  CREATE TABLE rollback_entry (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id text NOT NULL,
    natural_key text NOT NULL,
    prior_state jsonb,
    recorded_at timestamptz NOT NULL DEFAULT now()
  );
`);
await admin.end();

const client = await connect(url);
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

await client.end();
console.log('rollbackJournal.test.mjs — all assertions passed');
