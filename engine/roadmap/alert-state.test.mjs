// Roadmap task-82: durable alert lifecycle and flapping behavior.
//
// Acceptance:
//  - repeated drift updates the same open alert;
//  - resolve then recurrence reopens with history;
//  - acknowledging does not resolve;
//  - a duplicate event is idempotent;
//  - an out-of-order stale event cannot close a new occurrence.
// Mutation checks:
//  - acknowledge also resolves the condition;
//  - create a new alert on every retry;
//  - apply a stale resolution to a newer occurrence.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { grantRole } from '../authz/administration.mjs';
import {
  ALERT_READ_CAPABILITY, AlertAuthorizationError, AlertStateError, acknowledgeAlert, applyConditionEvent,
  decideTransition, listAlerts, listAlertTransitions, suppressAlert, syncDriftAlerts, unsuppressAlert,
} from '../notify/alerts.mjs';
import { createChannel, createSubscription } from '../notify/notifications.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

let tenantSeq = 0;
const freshTenant = () => { tenantSeq += 1; return `sha256:task-82-${tenantSeq}-${crypto.randomUUID()}`; };

async function principal(client, role) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${crypto.randomUUID()}@contoso.example`]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id });
  return rows[0].id;
}

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000);

function observation(tenantRef, status, eventId, seconds, extra = {}) {
  return {
    tenantRef, resourceKey: 'group:board', control: 'baseline', condition: 'drift', status, eventId, occurredAt: at(seconds), ...extra,
  };
}

async function alertRows(client, tenantRef) {
  return (await client.query('SELECT * FROM alert WHERE tenant_ref = $1', [tenantRef])).rows;
}

async function transitions(client, alertId) {
  return (await client.query('SELECT * FROM alert_transition WHERE alert_id = $1 ORDER BY id', [alertId])).rows;
}

test('repeated drift updates the same open alert', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const first = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e1', 0));
  const second = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e2', 60));
  const third = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e3', 120, { severity: 'critical' }));
  assert.equal(first.outcome, 'opened');
  assert.equal(second.outcome, 'updated');
  assert.equal(third.outcome, 'updated');
  const rows = await alertRows(client, tenantRef);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.alert.id);
  assert.equal(rows[0].state, 'open');
  assert.equal(rows[0].firing_count, 3);
  assert.equal(rows[0].occurrence, 1);
  assert.equal(rows[0].severity, 'critical');
  assert.equal(rows[0].last_firing_at.toISOString(), at(120).toISOString());
  // Refiring is not a state change, so history holds only the opening.
  assert.deepEqual((await transitions(client, first.alert.id)).map((row) => row.to_state), ['open']);
});

test('resolve then recurrence reopens the same alert with history and clears the prior occurrence', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const operator = await principal(client, 'operator');
  const opened = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e1', 0));
  await acknowledgeAlert(client, { tenantRef, alertId: opened.alert.id, actor: operator, at: at(10) });
  const resolved = await applyConditionEvent(client, observation(tenantRef, 'resolved', 'e2', 60));
  assert.equal(resolved.outcome, 'resolved');
  assert.equal(resolved.alert.state, 'resolved');
  assert.equal(resolved.alert.resolved_event_id, 'e2');

  const reopened = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e3', 120));
  assert.equal(reopened.outcome, 'reopened');
  const [row] = await alertRows(client, tenantRef);
  assert.equal(row.id, opened.alert.id, 'a recurrence reopens the same alert');
  assert.equal(row.state, 'reopened');
  assert.equal(row.occurrence, 2);
  assert.equal(row.condition_active, true);
  assert.equal(row.occurrence_started_at.toISOString(), at(120).toISOString());
  // Every field of the prior occurrence is cleared, each asserted on its own.
  assert.equal(row.acknowledged_by, null);
  assert.equal(row.acknowledged_at, null);
  assert.equal(row.resolved_at, null);
  assert.equal(row.resolved_event_id, null);

  const history = await transitions(client, row.id);
  assert.deepEqual(history.map((entry) => [entry.occurrence, entry.from_state, entry.to_state]), [
    [1, null, 'open'], [1, 'open', 'acknowledged'], [1, 'acknowledged', 'resolved'], [2, 'resolved', 'reopened'],
  ]);
  assert.equal(history[1].actor, operator);
  assert.equal(history[3].evidence.priorResolvedEventId, 'e2');
  assert.equal(history[3].evidence.priorOccurrence, 1);

  // History is immutable evidence.
  await assert.rejects(() => client.query("UPDATE alert_transition SET reason = 'edited' WHERE id = $1", [history[0].id]), /append-only/);
  await assert.rejects(() => client.query('DELETE FROM alert_transition WHERE id = $1', [history[0].id]), /append-only/);
});

test('acknowledging records actor and time but does not resolve the condition', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const operator = await principal(client, 'operator');
  const viewer = await principal(client, 'viewer');
  const opened = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e1', 0));

  await assert.rejects(
    () => acknowledgeAlert(client, { tenantRef, alertId: opened.alert.id, actor: viewer, at: at(5) }),
    AlertAuthorizationError,
  );
  const acknowledged = await acknowledgeAlert(client, { tenantRef, alertId: opened.alert.id, actor: operator, at: at(10), note: 'looking' });
  assert.equal(acknowledged.state, 'acknowledged');
  assert.equal(acknowledged.acknowledged_by, operator);
  assert.equal(acknowledged.acknowledged_at.toISOString(), at(10).toISOString());
  assert.equal(acknowledged.condition_active, true, 'acknowledging must not resolve the condition');
  assert.equal(acknowledged.resolved_at, null);
  assert.equal(acknowledged.resolved_event_id, null);
  await assert.rejects(
    () => acknowledgeAlert(client, { tenantRef, alertId: opened.alert.id, actor: operator, at: at(11) }),
    AlertStateError,
  );

  // The condition keeps firing into the acknowledged alert, and a resolve observation
  // is still needed to resolve it.
  const refired = await applyConditionEvent(client, observation(tenantRef, 'firing', 'e2', 30));
  assert.equal(refired.outcome, 'updated');
  assert.equal(refired.alert.state, 'acknowledged');
  const stillActive = await listAlerts(client, { tenantRef, actor: viewer, states: ['acknowledged'] });
  assert.equal(stillActive.length, 1);
  assert.equal(stillActive[0].condition_active, true);
  const resolved = await applyConditionEvent(client, observation(tenantRef, 'resolved', 'e3', 60));
  assert.equal(resolved.outcome, 'resolved');
  assert.equal(resolved.alert.state, 'resolved');
});

test('a duplicate or retried event is idempotent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const first = await applyConditionEvent(client, observation(tenantRef, 'firing', 'drift:s1:group:board', 0));
  const retry = await applyConditionEvent(client, observation(tenantRef, 'firing', 'drift:s1:group:board', 0));
  const lateRetry = await applyConditionEvent(client, observation(tenantRef, 'firing', 'drift:s1:group:board', 0));
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(lateRetry.duplicate, true);
  assert.equal(retry.alert.id, first.alert.id);
  const rows = await alertRows(client, tenantRef);
  assert.equal(rows.length, 1, 'a retry must not create another alert');
  assert.equal(rows[0].firing_count, 1, 'a retry must not count as another firing');
  assert.equal((await transitions(client, first.alert.id)).length, 1);

  // A duplicated resolution is equally inert, even after a newer firing.
  await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r1', 60));
  await applyConditionEvent(client, observation(tenantRef, 'firing', 'f2', 120));
  const replayed = await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r1', 60));
  assert.equal(replayed.duplicate, true);
  const [row] = await alertRows(client, tenantRef);
  assert.equal(row.state, 'reopened');
  assert.equal(row.condition_active, true);
  assert.equal((await alertRows(client, tenantRef)).length, 1);
});

test('an out-of-order stale event cannot close a newer occurrence', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  await applyConditionEvent(client, observation(tenantRef, 'firing', 'f1', 0));
  await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r1', 60));
  const reopened = await applyConditionEvent(client, observation(tenantRef, 'firing', 'f2', 180));
  assert.equal(reopened.alert.occurrence, 2);

  // A resolution observed at 120s (between the first resolution and the recurrence)
  // arrives late, after the recurrence: it belongs to the first occurrence.
  const stale = await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r-late', 120));
  assert.equal(stale.outcome, 'stale');
  const [row] = await alertRows(client, tenantRef);
  assert.equal(row.state, 'reopened');
  assert.equal(row.condition_active, true);
  assert.equal(row.resolved_event_id, null);
  // The stale event is recorded, not silently dropped, and not applied again later.
  const { rows: [receipt] } = await client.query('SELECT outcome FROM alert_event_receipt WHERE tenant_ref = $1 AND event_id = $2', [tenantRef, 'r-late']);
  assert.equal(receipt.outcome, 'stale');
  assert.equal((await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r-late', 120))).duplicate, true);

  // A stale firing cannot reopen a resolved alert either.
  await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r2', 300));
  const staleFiring = await applyConditionEvent(client, observation(tenantRef, 'firing', 'f-late', 240));
  assert.equal(staleFiring.outcome, 'stale');
  assert.equal((await alertRows(client, tenantRef))[0].state, 'resolved');

  // The pure decision agrees.
  assert.deepEqual(decideTransition(row, { status: 'resolved', occurredAt: at(179) }), { action: 'ignore', outcome: 'stale' });
});

test('concurrent first firings for one identity converge on exactly one alert', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const a = await database.connect();
  const b = await database.connect();
  t.after(async () => { await a.end(); await b.end(); });
  // Two connections race the first firing; neither may see a raw unique violation.
  const results = await Promise.allSettled([
    applyConditionEvent(a, observation(tenantRef, 'firing', 'race-a', 0)),
    applyConditionEvent(b, observation(tenantRef, 'firing', 'race-b', 0)),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled'], JSON.stringify(results.map((r) => r.reason?.message)));
  const rows = await alertRows(client, tenantRef);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firing_count, 2);
  assert.deepEqual(results.map((result) => result.value.outcome).sort(), ['opened', 'updated']);
});

test('listAlerts and listAlertTransitions share one tenant and capability gate', async (t) => {
  const client = await schemaClient(t);
  const tenantA = freshTenant();
  const tenantB = freshTenant();
  const viewer = await principal(client, 'viewer');
  const nobody = await principal(client, null);
  const inA = await applyConditionEvent(client, observation(tenantA, 'firing', 'a1', 0));
  const inB = await applyConditionEvent(client, observation(tenantB, 'firing', 'b1', 0));

  assert.equal(ALERT_READ_CAPABILITY, 'read');
  assert.deepEqual((await listAlerts(client, { tenantRef: tenantA, actor: viewer })).map((row) => row.id), [inA.alert.id]);
  assert.deepEqual(await listAlertTransitions(client, { tenantRef: tenantA, actor: viewer, alertId: inB.alert.id }), []);
  assert.equal((await listAlertTransitions(client, { tenantRef: tenantB, actor: viewer, alertId: inB.alert.id })).length, 1);

  for (const actor of [nobody, 'not-a-principal']) {
    await assert.rejects(() => listAlerts(client, { tenantRef: tenantA, actor }), AlertAuthorizationError);
    await assert.rejects(() => listAlertTransitions(client, { tenantRef: tenantA, actor, alertId: inA.alert.id }), AlertAuthorizationError);
  }
  // Acting on another tenant's alert finds nothing.
  const operator = await principal(client, 'operator');
  await assert.rejects(() => acknowledgeAlert(client, { tenantRef: tenantA, alertId: inB.alert.id, actor: operator }), AlertStateError);
});

test('hysteresis: a resolution inside the window is a recorded flap, and the boundary is strict', async (t) => {
  const client = await schemaClient(t);

  // resolveMs 0: a resolution at the very instant of the last firing is real.
  const sameInstant = freshTenant();
  await applyConditionEvent(client, observation(sameInstant, 'firing', 'f1', 0, { hysteresis: { resolveMs: 0 } }));
  const immediate = await applyConditionEvent(client, observation(sameInstant, 'resolved', 'r1', 0, { hysteresis: { resolveMs: 0 } }));
  assert.equal(immediate.outcome, 'resolved', 'same-instant resolution with resolveMs 0 is not a flap');

  // Exactly at the window edge is real; one millisecond inside it is a flap.
  const edge = freshTenant();
  const window = { resolveMs: 60_000, reopenMs: 120_000 };
  await applyConditionEvent(client, observation(edge, 'firing', 'f1', 0, { hysteresis: window }));
  const inside = await applyConditionEvent(client, { ...observation(edge, 'resolved', 'r1', 0, { hysteresis: window }), occurredAt: new Date(T0 + 59_999) });
  assert.equal(inside.outcome, 'flap-held');
  assert.equal(inside.alert.condition_active, true);
  assert.equal(inside.alert.flap_count, 1);
  const atEdge = await applyConditionEvent(client, observation(edge, 'resolved', 'r2', 60, { hysteresis: window }));
  assert.equal(atEdge.outcome, 'resolved');

  // A recurrence inside reopenMs reopens as flapping: recorded, but not notified again.
  const flapped = await applyConditionEvent(client, observation(edge, 'firing', 'f2', 90, { hysteresis: window }));
  assert.equal(flapped.outcome, 'reopened');
  assert.equal(flapped.flapping, true);
  assert.equal(flapped.alert.flap_count, 2);
  const history = await transitions(client, flapped.alert.id);
  assert.deepEqual(history.map((entry) => entry.reason), [
    'condition-firing', 'resolution-held-flapping', 'condition-resolved', 'condition-recurred-flapping',
  ]);
});

test('a suppressed condition is kept, tracked and restored, never deleted', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const admin = await principal(client, 'admin');
  const operator = await principal(client, 'operator');
  const opened = await applyConditionEvent(client, observation(tenantRef, 'firing', 'f1', 0));
  await assert.rejects(() => suppressAlert(client, { tenantRef, alertId: opened.alert.id, actor: operator, reason: 'noise' }), AlertAuthorizationError);
  const suppressed = await suppressAlert(client, { tenantRef, alertId: opened.alert.id, actor: admin, reason: 'planned change window' });
  assert.equal(suppressed.state, 'suppressed');

  const resolved = await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r1', 60));
  assert.equal(resolved.alert.state, 'suppressed');
  assert.equal(resolved.alert.condition_active, false);
  const recurred = await applyConditionEvent(client, observation(tenantRef, 'firing', 'f2', 120));
  assert.equal(recurred.alert.state, 'suppressed');
  assert.equal(recurred.alert.condition_active, true);
  assert.equal(recurred.alert.occurrence, 2);

  const lifted = await unsuppressAlert(client, { tenantRef, alertId: opened.alert.id, actor: admin });
  assert.equal(lifted.state, 'open', 'lifting suppression shows the condition as it is now');
  assert.equal((await alertRows(client, tenantRef)).length, 1);
  assert.deepEqual((await transitions(client, opened.alert.id)).map((entry) => entry.to_state),
    ['open', 'suppressed', 'suppressed', 'suppressed', 'open']);
});

test('notification rides the task-20 delivery primitives once per occurrence', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const admin = await principal(client, 'admin');
  const channel = await createChannel(client, { kind: 'webhook', config: { url: 'https://hooks.example.invalid/keel' } });
  await createSubscription(client, { channelId: channel.id, eventGlob: 'alert.*', minSeverity: 'notice' });
  const notify = { requestedBy: admin };
  const deliveries = async () => (await client.query(
    "SELECT event FROM delivery WHERE channel_id = $1 AND event->>'tenantRef' = $2 ORDER BY created_at", [channel.id, tenantRef],
  )).rows.map((row) => [row.event.kind, row.event.occurrence]);

  await applyConditionEvent(client, observation(tenantRef, 'firing', 'f1', 0, { notify }));
  await applyConditionEvent(client, observation(tenantRef, 'firing', 'f1', 0, { notify }));
  await applyConditionEvent(client, observation(tenantRef, 'firing', 'f2', 30, { notify }));
  assert.deepEqual(await deliveries(), [['alert.opened', 1]]);
  await applyConditionEvent(client, observation(tenantRef, 'resolved', 'r1', 60, { notify }));
  await applyConditionEvent(client, observation(tenantRef, 'firing', 'f3', 600, { notify }));
  assert.deepEqual(await deliveries(), [['alert.opened', 1], ['alert.reopened', 2]]);

  // A notification lost between the state commit and dispatch is repaired by the retry.
  const lost = freshTenant();
  await applyConditionEvent(client, observation(lost, 'firing', 'g1', 0));
  const repaired = await applyConditionEvent(client, observation(lost, 'firing', 'g1', 0, { notify }));
  assert.equal(repaired.duplicate, true);
  assert.equal(repaired.deliveries.length, 1);
});

test('drift detection opens, updates and resolves alerts through the real CLI', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = freshTenant();
  const baseline = (await client.query("INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING *", [tenantRef])).rows[0];
  const digest = { group: { outcome: 'complete', itemCount: 1 } };
  async function snapshotWith(hash, completedAt) {
    const snapshot = (await client.query(`INSERT INTO snapshot (tenant_ref, status, coverage_digest, completed_at)
      VALUES ($1, 'complete', $2, $3) RETURNING *`, [tenantRef, digest, completedAt])).rows[0];
    const version = (await client.query(`INSERT INTO resource_version
      (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
      VALUES ($1, 'group:board', 'group', '{}', $2, 'tier1', 'access-affecting', 'full', '{}') RETURNING id`,
    [snapshot.id, hash])).rows[0];
    return { snapshot, version };
  }
  const seed = await snapshotWith('baseline-hash', at(0));
  await client.query('INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)', [baseline.id, 'group:board', seed.version.id]);
  const detect = (snapshotId) => exec(process.execPath, ['cli/keel-drift.mjs', 'detect', '--snapshot-id', snapshotId,
    '--tenant-ref', tenantRef, '--db-url', database.url], { cwd: repoRoot });

  const drifted1 = await snapshotWith('drifted-hash', at(100));
  const drifted2 = await snapshotWith('drifted-hash-2', at(200));
  const clean = await snapshotWith('baseline-hash', at(300));
  await detect(drifted1.snapshot.id);
  await detect(drifted2.snapshot.id);
  let rows = await alertRows(client, tenantRef);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'open');
  assert.equal(rows[0].firing_count, 2);
  assert.equal(rows[0].severity, 'warning');

  await detect(clean.snapshot.id);
  rows = await alertRows(client, tenantRef);
  assert.equal(rows[0].state, 'resolved');
  assert.equal(rows[0].resolved_event_id, `drift-clear:${clean.snapshot.id}:group:board`);

  // Replaying an earlier detection's observations is a duplicate; an older snapshot
  // not yet seen is stale. Neither reopens the resolved alert.
  const replay = await syncDriftAlerts(client, {
    tenantRef, snapshotId: drifted2.snapshot.id, observedAt: at(200), coveredTypes: ['group'],
    drift: [{ naturalKey: 'group:board', resourceType: 'group', changeType: 'modified', blastRadius: 'access-affecting' }],
  });
  assert.equal(replay[0].duplicate, true);
  const older = await snapshotWith('drifted-hash-3', at(250));
  await detect(older.snapshot.id);
  rows = await alertRows(client, tenantRef);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'resolved');
  assert.equal(rows[0].occurrence, 1);

  // syncDriftAlerts never resolves an alert for a type the detection did not cover.
  const other = freshTenant();
  await syncDriftAlerts(client, {
    tenantRef: other, snapshotId: 's1', observedAt: at(0), coveredTypes: ['group'],
    drift: [{ naturalKey: 'user:alex', resourceType: 'user', changeType: 'modified', blastRadius: 'tenant-lockout' }],
  });
  await syncDriftAlerts(client, { tenantRef: other, snapshotId: 's2', observedAt: at(60), coveredTypes: ['group'], drift: [] });
  const [userAlert] = await alertRows(client, other);
  assert.equal(userAlert.state, 'open');
  assert.equal(userAlert.severity, 'critical');
});
