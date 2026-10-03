// Roadmap task-83: acknowledgement deadlines, escalation and the alerts inbox.
//
// Acceptance:
//  - a missed acknowledgement escalates once;
//  - an acknowledgement racing the deadline suppresses the send;
//  - a restart preserves an overdue deadline;
//  - a missing recipient is an actionable error;
//  - a read-only principal cannot resolve.
// Mutation checks:
//  - use process memory for the deadline;
//  - skip the acknowledgement re-check before sending;
//  - allow a read-only resolve.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import {
  AlertAuthorizationError, acknowledgeAlert, applyConditionEvent, resolveAlert,
} from '../notify/alerts.mjs';
import {
  EscalationAuthorizationError, MISSING_RECIPIENT, createEscalationRule, escalateOverdue,
} from '../notify/escalation.mjs';
import { attemptDelivery, createChannel } from '../notify/notifications.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

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
const freshTenant = () => { tenantSeq += 1; return `sha256:task-83-${tenantSeq}-${crypto.randomUUID()}`; };

async function principal(client, role, name = null) {
  const { rows } = await client.query('INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING id',
    [`${crypto.randomUUID()}@contoso.example`, name]);
  // Backdated: grants are checked at a millisecond instant against microsecond rows.
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

const MINUTE = 60_000;
const T0 = Date.now() - 10 * MINUTE;
const at = (minutes) => new Date(T0 + minutes * MINUTE);

function firing(tenantRef, eventId, minutes, resourceKey = 'group:board') {
  return {
    tenantRef, resourceKey, control: 'baseline', condition: 'drift', status: 'firing', eventId, occurredAt: at(minutes),
    detail: { resourceType: 'group', changeType: 'modified' },
  };
}

async function fixture(client, { channel = true } = {}) {
  const tenantRef = freshTenant();
  const admin = await principal(client, 'admin');
  const owner = await principal(client, 'operator', 'Dana On-call');
  const escalateTo = channel ? await createChannel(client, { kind: 'webhook', config: { url: 'https://hooks.example.invalid/oncall' } }) : null;
  const rule = await createEscalationRule(client, {
    tenantRef, control: 'baseline', ackWithinMs: 5 * MINUTE, ownerPrincipalId: owner, escalateChannelId: escalateTo?.id ?? null, createdBy: admin,
  });
  return { tenantRef, admin, owner, channel: escalateTo, rule };
}

async function escalations(client, alertId) {
  return (await client.query(
    "SELECT * FROM delivery WHERE event->>'alertId' = $1 AND event->>'kind' = 'alert.escalated' ORDER BY created_at", [alertId],
  )).rows;
}

test('a missed acknowledgement escalates exactly once, to the configured channel', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, admin, owner, channel } = await fixture(client);
  const { alert } = await applyConditionEvent(client, firing(tenantRef, 'f1', 0));
  assert.equal(alert.ack_deadline_at.toISOString(), at(5).toISOString(), 'deadline is the occurrence start plus the rule window');
  assert.equal(alert.owner_principal_id, owner);
  assert.equal(alert.owner_source, 'rule');

  assert.deepEqual(await escalateOverdue(client, { requestedBy: admin, now: at(4) }), [], 'not due before the deadline');
  // Two sweeps race on separate connections: the row lock and the claim let one win.
  const other = await database.connect();
  t.after(async () => { await other.end(); });
  const [first, second] = await Promise.all([
    escalateOverdue(client, { requestedBy: admin, now: at(6) }),
    escalateOverdue(other, { requestedBy: admin, now: at(6) }),
  ]);
  const outcomes = [...first, ...second].map((result) => result.outcome).sort();
  assert.equal(outcomes.filter((outcome) => outcome === 'escalated').length, 1, JSON.stringify(outcomes));
  assert.deepEqual(await escalateOverdue(client, { requestedBy: admin, now: at(9) }), [], 'an escalated occurrence is never claimed again');

  const sent = await escalations(client, alert.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel_id, channel.id);
  assert.equal(sent[0].event.occurrence, 1);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM job WHERE kind = 'notify' AND params->>'deliveryId' = $1", [sent[0].id])).rows[0].n, 1);
  const history = (await client.query('SELECT reason FROM alert_transition WHERE alert_id = $1 ORDER BY id', [alert.id])).rows;
  assert.deepEqual(history.map((row) => row.reason), ['condition-firing', 'escalated-ack-deadline-missed']);

  // A recurrence is a new occurrence with its own deadline and its own one escalation.
  await applyConditionEvent(client, { ...firing(tenantRef, 'r1', 7), status: 'resolved' });
  const { alert: reopened } = await applyConditionEvent(client, firing(tenantRef, 'f2', 8));
  assert.equal(reopened.ack_deadline_at.toISOString(), at(13).toISOString());
  await escalateOverdue(client, { requestedBy: admin, now: new Date(Math.max(Date.now(), at(14).getTime())) });
  assert.deepEqual((await escalations(client, alert.id)).map((row) => row.event.occurrence), [1, 2]);

  // Only a principal that may change settings sends escalations.
  const viewer = await principal(client, 'viewer');
  await assert.rejects(() => escalateOverdue(client, { requestedBy: viewer, now: at(20) }), EscalationAuthorizationError);
});

test('an acknowledgement racing the deadline suppresses the send', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, admin, owner } = await fixture(client);

  // Acknowledged after the deadline but before the sweep: nothing is queued.
  const early = await applyConditionEvent(client, firing(tenantRef, 'a1', 0, 'group:early'));
  await acknowledgeAlert(client, { tenantRef, alertId: early.alert.id, actor: owner });
  assert.deepEqual(await escalateOverdue(client, { requestedBy: admin, now: at(6) }), []);
  assert.equal((await escalations(client, early.alert.id)).length, 0);

  // Acknowledged after the escalation was queued but before it is sent: the delivery
  // re-checks the alert and is cancelled without calling the transport.
  const late = await applyConditionEvent(client, firing(tenantRef, 'b1', 0, 'group:late'));
  const [queued] = await escalateOverdue(client, { requestedBy: admin, now: at(6) });
  assert.equal(queued.outcome, 'escalated');
  await acknowledgeAlert(client, { tenantRef, alertId: late.alert.id, actor: owner });
  let sends = 0;
  const transports = { webhook: async () => { sends += 1; } };
  const attempt = await attemptDelivery(client, { deliveryId: queued.deliveryId, transports });
  assert.equal(sends, 0, 'the transport must not run for an acknowledged alert');
  assert.equal(attempt.delivery.status, 'cancelled');
  assert.match(attempt.delivery.last_error, /acknowledged before the escalation was sent/);

  // Unacknowledged, the same kind of delivery is sent.
  const sent = await applyConditionEvent(client, firing(tenantRef, 'c1', 0, 'group:unanswered'));
  const [due] = (await escalateOverdue(client, { requestedBy: admin, now: at(6) })).filter((result) => result.alertId === sent.alert.id);
  const delivered = await attemptDelivery(client, { deliveryId: due.deliveryId, transports });
  assert.equal(sends, 1);
  assert.equal(delivered.delivery.status, 'delivered');
});

test('a restart preserves an overdue deadline', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, channel } = await fixture(client);
  await client.query("INSERT INTO principal (email, system_kind) VALUES ('scheduler@keel.local', 'scheduler') ON CONFLICT DO NOTHING");
  const { alert } = await applyConditionEvent(client, firing(tenantRef, 'f1', 0));
  const { rows: [stored] } = await client.query('SELECT ack_deadline_at FROM alert WHERE id = $1', [alert.id]);
  assert.equal(stored.ack_deadline_at.toISOString(), at(5).toISOString(), 'the deadline is persisted on the alert row');

  // A fresh process (the restarted worker) knows nothing but the database.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { connect } from './engine/store/db.mjs';
    import { sweepAlertEscalations } from './cli/keel-worker.mjs';
    const client = await connect(process.env.FIXTURE_DB_URL);
    try {
      const results = await sweepAlertEscalations(client, { workerId: 'restarted' });
      console.log(JSON.stringify(results));
    } finally { await client.end(); }
  `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', env: { ...process.env, FIXTURE_DB_URL: database.url } });
  assert.equal(result.status, 0, result.stderr);
  const results = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(results.some((row) => row.alertId === alert.id && row.outcome === 'escalated'), result.stdout);
  const sent = await escalations(client, alert.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel_id, channel.id);
});

test('a missing recipient is an actionable error, and no owner is an explicit unassigned', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef, admin, rule } = await fixture(client, { channel: false });
  const { alert } = await applyConditionEvent(client, firing(tenantRef, 'f1', 0));
  const [first] = await escalateOverdue(client, { requestedBy: admin, now: at(6) });
  assert.equal(first.outcome, 'missing-recipient');
  assert.equal(first.error, MISSING_RECIPIENT);
  assert.match(MISSING_RECIPIENT, /Add an enabled channel/);
  let { rows: [row] } = await client.query('SELECT * FROM alert WHERE id = $1', [alert.id]);
  assert.equal(row.escalation_error, MISSING_RECIPIENT);
  assert.equal(row.escalated_occurrence, 0, 'an unsent escalation is not claimed');
  await escalateOverdue(client, { requestedBy: admin, now: at(7) });
  const failures = (await client.query("SELECT count(*)::int AS n FROM alert_transition WHERE alert_id = $1 AND reason = 'escalation-failed-no-recipient'", [alert.id])).rows[0].n;
  assert.equal(failures, 1, 'the failure is recorded once, not on every sweep');

  // Fixing the rule lets the same occurrence escalate.
  const channel = await createChannel(client, { kind: 'email', config: { to: 'oncall@contoso.example', from: 'keel@contoso.example' } });
  await client.query('UPDATE alert_escalation_rule SET escalate_channel_id = $2 WHERE id = $1', [rule.id, channel.id]);
  const [fixed] = await escalateOverdue(client, { requestedBy: admin, now: at(8) });
  assert.equal(fixed.outcome, 'escalated');
  ({ rows: [row] } = await client.query('SELECT * FROM alert WHERE id = $1', [alert.id]));
  assert.equal(row.escalation_error, null);

  // No matching rule: no deadline, and the owner is explicitly unassigned.
  const unruled = freshTenant();
  const { alert: orphan } = await applyConditionEvent(client, firing(unruled, 'g1', 0));
  assert.equal(orphan.ack_deadline_at, null);
  assert.equal(orphan.owner_principal_id, null);
  assert.equal(orphan.owner_source, 'unassigned');
});

test('a read-only principal cannot acknowledge or resolve, in the engine or the portal', async (t) => {
  const client = await schemaClient(t);
  const directory = mkdtempSync(join(tmpdir(), 'keel-alerts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'tenant.json');
  writeFileSync(config, JSON.stringify({ tenantId: 'alerts-inbox-tenant' }));
  const viewer = await principal(client, 'viewer', 'Riley Viewer');
  const operator = await principal(client, 'operator', 'Dana On-call');
  const admin = await principal(client, 'admin');

  const tenantRef = freshTenant();
  const { alert } = await applyConditionEvent(client, firing(tenantRef, 'f1', 0));
  await assert.rejects(() => resolveAlert(client, { tenantRef, alertId: alert.id, actor: viewer, reason: 'looks fine' }), AlertAuthorizationError);
  await assert.rejects(() => acknowledgeAlert(client, { tenantRef, alertId: alert.id, actor: viewer }), AlertAuthorizationError);
  const resolved = await resolveAlert(client, { tenantRef, alertId: alert.id, actor: operator, reason: 'fixed by hand' });
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.condition_active, false);
  // The next firing after a manual resolution reopens with history.
  const back = await applyConditionEvent(client, firing(tenantRef, 'f2', 1));
  assert.equal(back.outcome, 'reopened');

  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
    const { renderToStaticMarkup } = require('react-dom/server');
    const React = require('react');
    const { connect } = require('../engine/store/db.mjs');
    const { applyConditionEvent } = require('../engine/notify/alerts.mjs');
    const { createEscalationRule } = require('../engine/notify/escalation.mjs');
    const { POST: respond } = require('./app/api/actions/alerts/route.ts');
    const { GET: inbox } = require('./app/api/alerts/route.ts');
    const { AlertInbox } = require('./components/alert-inbox.tsx');
    const { alertsVerdict } = require('./lib/alerts-view.ts');
    const { tenantRef } = require('./lib/runtime-config.ts');
    const { PRINCIPAL_ID_HEADER, CAPABILITIES_HEADER } = require('./lib/principal.ts');
    const ids = JSON.parse(process.env.FIXTURE_IDS);
    const headers = (principal, capabilities) => {
      const h = new Headers({ 'content-type': 'application/json' });
      if (principal) h.set(PRINCIPAL_ID_HEADER, principal);
      if (capabilities) h.set(CAPABILITIES_HEADER, capabilities.join(' '));
      return h;
    };
    const post = (principal, capabilities, body) => respond(new Request('http://localhost/api/actions/alerts',
      { method: 'POST', headers: headers(principal, capabilities), body: JSON.stringify(body) }));
    (async () => {
      const db = await connect(process.env.KEEL_DB_URL);
      try {
        const ref = tenantRef();
        await createEscalationRule(db, { tenantRef: ref, control: 'baseline', ackWithinMs: 60000, ownerPrincipalId: ids.operator, createdBy: ids.admin });
        const { alert } = await applyConditionEvent(db, { tenantRef: ref, resourceKey: 'group:Finance', control: 'baseline', condition: 'drift',
          status: 'firing', eventId: 'portal-1', occurredAt: new Date(), detail: { resourceType: 'group', changeType: 'modified' } });

        // Viewing is read; the read-only viewer sees the inbox but no controls.
        const view = await inbox(new Request('http://localhost/api/alerts', { headers: headers(ids.viewer, ['read']) }));
        assert.equal(view.status, 200);
        const data = await view.json();
        assert.equal(data.alerts.length, 1);
        assert.equal(data.alerts[0].owner.name, 'Dana On-call');
        assert.ok(data.alerts[0].ackDeadlineAt);
        assert.equal(data.alerts[0].history[0].reason, 'condition-firing');
        const readOnly = renderToStaticMarkup(React.createElement(AlertInbox, { alerts: data.alerts, now: data.generatedAt, canRespond: false }));
        assert.match(readOnly, /Finance \(group\)/);
        assert.match(readOnly, /Owner: Dana On-call/);
        assert.doesNotMatch(readOnly, />Acknowledge</);
        assert.doesNotMatch(readOnly, />Resolve</);
        const operatorView = renderToStaticMarkup(React.createElement(AlertInbox, { alerts: data.alerts, now: data.generatedAt, canRespond: true }));
        assert.match(operatorView, />Acknowledge</);
        assert.match(alertsVerdict(data.alerts, data.generatedAt).text, /1 alert needs someone/);

        // The read-only principal is refused before the alert is touched, even with a forged body.
        for (const action of ['resolve', 'acknowledge']) {
          assert.equal((await post(ids.viewer, ['read'], { alertId: alert.id, action })).status, 403, action);
        }
        // A forged capability header still meets the engine's database check.
        assert.equal((await post(ids.viewer, ['read', 'dispose-accept'], { alertId: alert.id, action: 'resolve' })).status, 403);
        const still = (await db.query('SELECT state FROM alert WHERE id = $1', [alert.id])).rows[0].state;
        assert.equal(still, 'open');
        const denied = (await db.query("SELECT count(*)::int AS n FROM evidence WHERE kind = 'action-attempt' AND subject->>'action' = 'alert-respond' AND subject->>'decision' = 'denied'")).rows[0].n;
        assert.equal(denied, 2, 'the guard records each refused attempt');

        assert.equal((await post(ids.operator, ['dispose-accept'], { alertId: alert.id, action: 'acknowledge' })).status, 200);
        assert.equal((await post(ids.operator, ['dispose-accept'], { alertId: alert.id, action: 'acknowledge' })).status, 409);
        assert.equal((await post(ids.operator, ['dispose-accept'], { alertId: alert.id, action: 'resolve' })).status, 200);
        assert.equal((await db.query('SELECT state FROM alert WHERE id = $1', [alert.id])).rows[0].state, 'resolved');
        assert.equal((await post(ids.operator, ['dispose-accept'], { alertId: 'not-an-id', action: 'resolve' })).status, 400);
      } finally {
        await db.end();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: database.url, KEEL_TENANT_CONFIG_PATH: config,
      FIXTURE_IDS: JSON.stringify({ viewer, operator, admin }) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
