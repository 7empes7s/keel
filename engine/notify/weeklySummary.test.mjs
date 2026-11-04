// Issue #980: the weekly summary. What it says (fixture feed, names shown and hidden, no
// ids anywhere), who gets it (only channels with an explicit "Weekly summary" rule; "All
// alerts" never; PagerDuty and text messages refused), the per-channel shape, and that a
// failed send retries and a rerun of the same week sends nothing twice. No real sends:
// every transport here is a stub.
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { setAnonymity } from '../insights/anonymity.mjs';
import { SUMMARY_EVENT_KIND, buildWeeklySummary, isoWeek, summaryLink } from '../insights/summary.mjs';
import { createAdapterTransport } from './adapters.mjs';
import {
  DeliveryAttemptError, SUMMARY_REFUSED_CHANNEL_KINDS, SubscriptionRefusedError, attemptDelivery, checkSubscription,
  createChannel, createSubscription, createWebhookTransport, emailMessage, eventMatches, sendTestAlert,
} from './notifications.mjs';
import { sendSummaryNow, sendWeeklySummary, weeklySummaryEvent } from './weeklySummary.mjs';

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A feed row id ("drift:<uuid>", "audit:entra:r2:0"), never the words "by service: Entra".
const ROW_ID = /\b(?:drift|audit|service|backup):\S/;
const PORTAL = 'https://keel.contoso.test';

// ---- What the summary says, from a fixture feed ---------------------------------------
// The times are set explicitly from a fixed `now`, and checked against that same `now`.
const NOW = new Date('2026-11-09T07:00:00Z');
const at = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const person = (name) => ({ kind: 'user', id: '0a0a0a0a-0000-4000-8000-000000000001', name });
const fixtureRows = (who) => [
  {
    id: 'drift:11111111-1111-4111-8111-111111111111', source: 'drift', occurredAt: at(3), day: at(3).slice(0, 10),
    type: 'conditionalAccessPolicy', typeName: 'Conditional Access policy', service: 'Entra', priority: 'critical', priorityReason: null,
    object: { key: 'conditionalAccessPolicy:ca000000-0000-4000-8000-000000000001', name: 'Require MFA for admins', status: 'found' },
    change: 'modified', activity: null, person: person(who),
    flags: [{ key: 'ca-disabled', severity: 'critical', sentence: 'Turned off: Require MFA for admins.' }],
  },
  {
    id: 'audit:entra:r2:0', source: 'audit', occurredAt: at(30), day: at(30).slice(0, 10),
    type: 'group', typeName: 'Group', service: 'Entra', priority: 'high', priorityReason: null,
    object: { key: '9a000000-0000-4000-8000-000000000002', name: 'Finance', status: 'found' },
    change: 'modified', activity: 'Add member to group', person: person(who), flags: [],
  },
  {
    id: 'service:22222222-2222-4222-8222-222222222222', source: 'service', occurredAt: at(50), day: at(50).slice(0, 10),
    type: 'sharepoint-tenant-settings', typeName: 'SharePoint sharing settings', service: 'SharePoint', priority: 'normal', priorityReason: null,
    object: { key: 'sharepoint-tenant-settings:tenant', name: 'Sharing settings', status: 'found' },
    change: 'modified', activity: null, person: null, flags: [],
  },
];
const fixtureFeed = (who) => ({ since: at(24 * 7), until: NOW.toISOString(), rows: fixtureRows(who), truncated: false });

test('the summary says the Insights verdict, where to start, the services and the link, in plain sentences', () => {
  const event = buildWeeklySummary(fixtureFeed('Amara Okafor'), { now: NOW, portalUrl: `${PORTAL}/` });
  assert.equal(event.kind, SUMMARY_EVENT_KIND);
  assert.equal(event.severity, 'notice');
  assert.equal(event.week, '2026-W46');
  assert.equal(event.verdict, '3 changes in the last 7 days; 1 needs a look.');
  assert.equal(event.link, 'https://keel.contoso.test/insights?days=7');
  assert.equal(event.text, [
    'Keel weekly summary',
    '',
    '3 changes in the last 7 days; 1 needs a look.',
    '',
    'Where to start:',
    '- Amara Okafor changed Require MFA for admins, a Conditional Access policy, 3 hours ago. Turned off: Require MFA for admins.',
    '- Amara Okafor changed Finance, a group, 30 hours ago.',
    '',
    'Changes by service: Entra 2, SharePoint 1.',
    'No changes in Intune, Exchange, Teams, Purview, Power Platform, Defender and Microsoft 365 apps.',
    '',
    'Open Insights: https://keel.contoso.test/insights?days=7',
  ].join('\n'));
  assert.deepEqual(event.whereToStart[1], { sentence: 'Amara Okafor changed Finance, a group, 30 hours ago.', does: null, who: 'Amara Okafor', what: 'Finance', when: '30 hours ago' });
  assert.deepEqual(event.changesByService, [{ service: 'Entra', count: 2 }, { service: 'SharePoint', count: 1 }]);
  const json = JSON.stringify(event);
  assert.doesNotMatch(json, GUID, 'no object, person or row id anywhere in the event');
  assert.doesNotMatch(json, ROW_ID);
});

test('with names hidden the summary carries the code names the feed gave, and still no ids', () => {
  const event = buildWeeklySummary(fixtureFeed('Person K7QX'), { now: NOW, portalUrl: PORTAL });
  assert.match(event.text, /- Person K7QX changed Require MFA for admins/);
  assert.doesNotMatch(JSON.stringify(event), /Amara|Okafor/);
  assert.doesNotMatch(JSON.stringify(event), GUID);
});

test('at most five places to start; nothing changed reads as one sentence', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ ...fixtureRows('Amara Okafor')[1], id: `audit:entra:m${index}:0`, occurredAt: at(index + 1) }));
  assert.equal(buildWeeklySummary({ ...fixtureFeed('x'), rows: many }, { now: NOW }).whereToStart.length, 5);
  const quiet = buildWeeklySummary({ ...fixtureFeed('x'), rows: [] }, { now: NOW });
  assert.equal(quiet.verdict, 'No changes in the last 7 days.');
  assert.equal(quiet.text, 'Keel weekly summary\n\nNo changes in the last 7 days.\n\nOpen Insights: /insights?days=7');
  assert.deepEqual(quiet.quietServices, []);
});

test('the link uses the portal address only when it is a plain https address', () => {
  assert.equal(summaryLink('https://keel.example.com/some/path'), 'https://keel.example.com/insights?days=7');
  for (const value of [undefined, null, '', 'http://keel.example.com', 'https://user:pw@keel.example.com', 'not a url']) {
    assert.equal(summaryLink(value), '/insights?days=7', String(value));
  }
  assert.equal(isoWeek('2026-01-01T00:00:00Z'), '2026-W01');
  assert.equal(isoWeek('2027-01-03T12:00:00Z'), '2026-W53');
});

// ---- Who gets it: opt in only -----------------------------------------------------------
test('"All alerts" and every other pattern match alerts and tests, never the summary', () => {
  const summary = { kind: SUMMARY_EVENT_KIND, severity: 'notice' };
  for (const glob of ['*', 'summary.*', '*.weekly', 'summary.?eekly']) {
    assert.equal(eventMatches({ event_glob: glob, min_severity: 'notice', channel_kind: 'email' }, summary), false, glob);
  }
  assert.equal(eventMatches({ event_glob: SUMMARY_EVENT_KIND, min_severity: 'notice', channel_kind: 'email' }, summary), true);
  for (const kind of ['pagerduty', 'sms']) {
    assert.equal(eventMatches({ event_glob: SUMMARY_EVENT_KIND, min_severity: 'notice', channel_kind: kind }, summary), false, kind);
  }
  for (const kind of ['alert.opened', 'alert.reopened', 'alert.escalated', 'test']) {
    assert.equal(eventMatches({ event_glob: '*', min_severity: 'notice' }, { kind, severity: 'notice' }), true, kind);
  }
});

// ---- The durable path, against a database -------------------------------------------------
const database = await createIsolatedTestDatabase(import.meta.url);
let client;
const ADMIN = '11111111-1111-4111-8111-111111111111';
const READER = '22222222-2222-4222-8222-222222222222';
const TENANT = 'contoso';
const channels = {};
const ADA = 'a0a00000-0000-4000-8000-0000000000a1';
const POLICY = 'ca000000-0000-4000-8000-000000000001';
// Feed fixtures are relative to the run (lessons 2026-10-04, 2026-10-08).
const RUN = new Date();
const hoursAgo = (hours) => new Date(RUN.getTime() - hours * 3_600_000);
const caPolicy = (state) => [`conditionalAccessPolicy:${POLICY}`, 'conditionalAccessPolicy', { id: POLICY, displayName: 'Block legacy sign-in', state }];

async function snapshot(startedAt, resources) {
  const { rows: [row] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, $2, $2::timestamptz + interval '10 minutes', 'complete') RETURNING id",
    [TENANT, startedAt],
  );
  for (const [key, type, payload] of resources) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, 'h', 'tier2', 'scoped', 'full', '{}')`,
      [row.id, key, type, payload],
    );
  }
  return row.id;
}

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  await client.query("INSERT INTO principal (id, email) VALUES ($1, 'alerts-admin@example.com'), ($2, 'reader@example.com')", [ADMIN, READER]);
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'admin', $2)", [ADMIN, ADMIN]);
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'viewer', $2)", [READER, ADMIN]);
  // One change in the window: Ada turned a Conditional Access policy off.
  const people = [['user:ada@contoso.test', 'user', { id: ADA, displayName: 'Ada Admin', userPrincipalName: 'ada@contoso.test' }]];
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@contoso.test') RETURNING id", [TENANT, hoursAgo(100)]);
  await snapshot(hoursAgo(50), [...people, caPolicy('enabled')]);
  const found = await snapshot(hoursAgo(30), [...people, caPolicy('disabled')]);
  await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, 'conditionalAccessPolicy', 'modified', 'h1', 'h2', $5, $6, 'tenant-lockout', $7)`,
    [TENANT, baseline.id, found, `conditionalAccessPolicy:${POLICY}`, caPolicy('enabled')[2], caPolicy('disabled')[2], hoursAgo(29)],
  );
  await client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, 'entra:r1:0', $2, 'Policy', $3, 'update', 'Update conditional access policy', 'user', $4)`,
    [TENANT, hoursAgo(40), POLICY, ADA],
  );

  channels.teams = await createChannel(client, { kind: 'teams', config: { endpointRef: 'env:KEEL_INTEGRATION_TEAMS' } });
  channels.slack = await createChannel(client, { kind: 'slack', config: { endpointRef: 'env:KEEL_INTEGRATION_SLACK' } });
  channels.webhook = await createChannel(client, { kind: 'webhook', config: { url: 'https://hooks.contoso.test/keel' } });
  channels.email = await createChannel(client, { kind: 'email', config: { to: 'ops@contoso.test', from: 'keel@contoso.test' } });
  channels.allAlerts = await createChannel(client, { kind: 'email', config: { to: 'alerts@contoso.test', from: 'keel@contoso.test' } });
  channels.pagerduty = await createChannel(client, { kind: 'pagerduty', config: { routingKeyRef: 'env:KEEL_INTEGRATION_PD' } });
  channels.sms = await createChannel(client, { kind: 'sms', config: { provider: 'twilio', authTokenRef: 'env:KEEL_INTEGRATION_TWILIO', accountSid: 'AC00000000000000000000000000000000', from: '+15550000000', to: '+15550000001' } });
  for (const name of ['teams', 'slack', 'webhook', 'email']) {
    // Asked at warning: a summary is a notice, so its rule is stored at notice.
    const rule = await createSubscription(client, { channelId: channels[name].id, eventGlob: SUMMARY_EVENT_KIND, minSeverity: 'warning' });
    assert.equal(rule.min_severity, 'notice');
  }
  await createSubscription(client, { channelId: channels.allAlerts.id, eventGlob: '*', minSeverity: 'notice' });
  await createSubscription(client, { channelId: channels.pagerduty.id, eventGlob: '*', minSeverity: 'notice' });
});

after(async () => {
  await client?.end();
  await database.cleanup();
});

test('PagerDuty and text messages cannot subscribe to the summary, with a plain reason', async () => {
  await assert.rejects(
    () => createSubscription(client, { channelId: channels.pagerduty.id, eventGlob: SUMMARY_EVENT_KIND, minSeverity: 'notice' }),
    (error) => error instanceof SubscriptionRefusedError && error.message === SUMMARY_REFUSED_CHANNEL_KINDS.pagerduty,
  );
  await assert.rejects(
    () => checkSubscription(client, { channelId: channels.sms.id, eventGlob: SUMMARY_EVENT_KIND, minSeverity: 'notice' }),
    (error) => error instanceof SubscriptionRefusedError && /too short/.test(error.message),
  );
  assert.equal(await checkSubscription(client, { channelId: channels.pagerduty.id, eventGlob: '*', minSeverity: 'critical' }), 'critical');
  assert.match(SUMMARY_REFUSED_CHANNEL_KINDS.sms, /text message is too short/);
});

test('the job builds the summary from the change feed, with names shown and hidden', async () => {
  const shown = await weeklySummaryEvent(client, { tenantRef: TENANT, now: RUN, portalUrl: PORTAL });
  assert.equal(shown.verdict, '2 changes in the last 7 days; 1 needs a look.');
  assert.match(shown.whereToStart[0].sentence, /^Ada Admin changed Block legacy sign-in, a Conditional Access policy, 29 hours ago\.$/);
  assert.match(shown.whereToStart[0].does ?? '', /Block legacy sign-in/);
  assert.doesNotMatch(JSON.stringify(shown), GUID);

  await setAnonymity(client, { tenantRef: TENANT, enabled: true, actor: ADMIN });
  try {
    const hidden = await weeklySummaryEvent(client, { tenantRef: TENANT, now: RUN, portalUrl: PORTAL });
    assert.match(hidden.whereToStart[0].sentence, /^Person [A-Z2-9]{4} changed Block legacy sign-in/);
    const json = JSON.stringify(hidden);
    assert.doesNotMatch(json, /Ada|ada@/);
    assert.doesNotMatch(json, GUID);
    assert.doesNotMatch(json, ROW_ID);
  } finally {
    await setAnonymity(client, { tenantRef: TENANT, enabled: false, actor: ADMIN });
  }
});

test('one delivery per subscribed channel per run; "All alerts" gets none; a rerun of the week sends nothing twice', async () => {
  await assert.rejects(() => sendWeeklySummary(client, { tenantRef: TENANT, requestedBy: READER, now: RUN }), /not authorized/);
  const first = await sendWeeklySummary(client, { tenantRef: TENANT, requestedBy: ADMIN, now: RUN, portalUrl: PORTAL });
  const got = first.deliveries.map(({ delivery }) => delivery.channel_id).sort();
  assert.deepEqual(got, [channels.teams.id, channels.slack.id, channels.webhook.id, channels.email.id].sort());
  for (const { delivery, job } of first.deliveries) {
    assert.equal(delivery.event.kind, SUMMARY_EVENT_KIND);
    assert.equal(delivery.dedup_key, `${SUMMARY_EVENT_KIND}:${first.event.week}`);
    assert.equal(job.kind, 'notify');
  }
  const again = await sendWeeklySummary(client, { tenantRef: TENANT, requestedBy: ADMIN, now: new Date(RUN.getTime() + 60_000), portalUrl: PORTAL });
  assert.equal(again.event.week, first.event.week);
  assert.deepEqual(again.deliveries, [], 'the same week is not sent twice');
  const { rows } = await client.query('SELECT channel_id, count(*)::int AS n FROM delivery WHERE event->>\'kind\' = $1 GROUP BY channel_id', [SUMMARY_EVENT_KIND]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.n === 1));
  // A test alert still reaches "All alerts" and is untouched by the summary rule.
  const test = await sendTestAlert(client, { channelId: channels.allAlerts.id, requestedBy: ADMIN });
  assert.equal(test.delivery.event.kind, 'test');
  // The next week is a new summary.
  const nextWeek = await sendWeeklySummary(client, { tenantRef: TENANT, requestedBy: ADMIN, now: new Date(RUN.getTime() + 7 * 86_400_000), portalUrl: PORTAL });
  assert.equal(nextWeek.deliveries.length, 4);
});

test('a failed summary send retries and ends failed or delivered, like an alert', async () => {
  const { delivery } = await sendSummaryNow(client, { tenantRef: TENANT, channelId: channels.webhook.id, requestedBy: ADMIN, now: RUN, portalUrl: PORTAL });
  await client.query('UPDATE delivery SET max_attempts = 2 WHERE id = $1', [delivery.id]);
  const failing = { webhook: async () => { throw new Error('webhook returned HTTP 503'); } };
  await assert.rejects(() => attemptDelivery(client, { deliveryId: delivery.id, transports: failing }), (error) => error instanceof DeliveryAttemptError && error.status === 'retrying');
  await client.query('UPDATE delivery SET next_attempt_at = now() WHERE id = $1', [delivery.id]);
  await assert.rejects(() => attemptDelivery(client, { deliveryId: delivery.id, transports: failing }), (error) => error instanceof DeliveryAttemptError && error.status === 'failed');

  const { delivery: retried } = await sendSummaryNow(client, { tenantRef: TENANT, channelId: channels.webhook.id, requestedBy: ADMIN, now: RUN, portalUrl: PORTAL });
  let calls = 0;
  const flaky = { webhook: async () => { calls += 1; if (calls === 1) throw new Error('webhook returned HTTP 503'); } };
  await assert.rejects(() => attemptDelivery(client, { deliveryId: retried.id, transports: flaky }));
  await client.query('UPDATE delivery SET next_attempt_at = now() WHERE id = $1', [retried.id]);
  const done = await attemptDelivery(client, { deliveryId: retried.id, transports: flaky });
  assert.equal(done.delivery.status, 'delivered');
  assert.equal(done.delivery.attempts, 2);
});

test('"Send now" queues one delivery each time, needs configuration, and refuses PagerDuty', async () => {
  await assert.rejects(() => sendSummaryNow(client, { tenantRef: TENANT, channelId: channels.email.id, requestedBy: READER }), /not authorized/);
  await assert.rejects(() => sendSummaryNow(client, { tenantRef: TENANT, channelId: channels.pagerduty.id, requestedBy: ADMIN }), SubscriptionRefusedError);
  const one = await sendSummaryNow(client, { tenantRef: TENANT, channelId: channels.email.id, requestedBy: ADMIN, now: RUN });
  const two = await sendSummaryNow(client, { tenantRef: TENANT, channelId: channels.email.id, requestedBy: ADMIN, now: RUN });
  assert.notEqual(one.delivery.id, two.delivery.id);
  assert.equal(one.delivery.dedup_key, null);
});

// ---- The shape each channel gets --------------------------------------------------------
const summaryEvent = () => buildWeeklySummary(fixtureFeed('Amara Okafor'), { now: NOW, portalUrl: PORTAL });

test('Teams gets a card with the verdict, the places to start and a button to Insights', async () => {
  const sent = [];
  const transport = createAdapterTransport('teams', {
    resolveSecret: async () => 'https://prod-01.westeurope.logic.azure.com/workflows/abc?sig=secret',
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('', { status: 202 }); },
  });
  await transport({ channel: { kind: 'teams', config: { endpointRef: 'env:KEEL_INTEGRATION_TEAMS' } }, event: summaryEvent(), delivery: { id: 'd1' } });
  const card = sent[0].attachments[0].content;
  const texts = card.body.map((block) => block.text);
  assert.equal(texts[0], 'Keel weekly summary');
  assert.equal(texts[1], '3 changes in the last 7 days; 1 needs a look.');
  assert.ok(texts.includes('- Amara Okafor changed Finance, a group, 30 hours ago.'));
  assert.deepEqual(card.actions, [{ type: 'Action.OpenUrl', title: 'Open Insights', url: 'https://keel.contoso.test/insights?days=7' }]);
  assert.doesNotMatch(JSON.stringify(sent[0]), GUID);
});

test('Slack gets the text with a Slack link; email gets the same text; a webhook gets JSON with the same fields', async () => {
  const slack = [];
  await createAdapterTransport('slack', {
    resolveSecret: async () => 'https://hooks.slack.com/services/T0/B0/secret',
    fetchImpl: async (url, init) => { slack.push(JSON.parse(init.body)); return new Response('ok', { status: 200 }); },
  })({ channel: { kind: 'slack', config: { endpointRef: 'env:KEEL_INTEGRATION_SLACK' } }, event: summaryEvent(), delivery: { id: 'd2' } });
  assert.match(slack[0].text, /^\*Keel weekly summary\*\n3 changes in the last 7 days; 1 needs a look\./);
  assert.match(slack[0].text, /<https:\/\/keel\.contoso\.test\/insights\?days=7\|Open Insights>$/);

  const message = emailMessage({ channel: { config: { to: 'ops@contoso.test', from: 'keel@contoso.test' } }, event: summaryEvent() });
  assert.match(message, /^Subject: Keel weekly summary: 3 changes in the last 7 days; 1 needs a look\.$/m);
  assert.match(message, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.ok(message.includes(summaryEvent().text));
  assert.match(message, /Open Insights: https:\/\/keel\.contoso\.test\/insights\?days=7/);

  const posted = [];
  const webhook = createWebhookTransport({ request: async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } });
  await webhook({ channel: { config: { url: 'https://hooks.contoso.test/keel' } }, event: summaryEvent() });
  assert.deepEqual(Object.keys(posted[0]).sort(), ['byServiceLine', 'changesByService', 'days', 'kind', 'link', 'quietLine', 'quietServices', 'severity', 'since', 'text', 'title', 'until', 'verdict', 'week', 'whereToStart'].sort());
  assert.doesNotMatch(JSON.stringify(posted[0]), GUID);
});

test('PagerDuty and text-message adapters never send a summary', async () => {
  let fetched = 0;
  const transport = createAdapterTransport('pagerduty', { resolveSecret: async () => 'routing-key', fetchImpl: async () => { fetched += 1; return new Response('{}', { status: 202 }); } });
  await assert.rejects(
    () => transport({ channel: { kind: 'pagerduty', config: { routingKeyRef: 'env:KEEL_INTEGRATION_PD' } }, event: summaryEvent(), delivery: { id: 'd3' } }),
    (error) => error.outcome === 'unconfigured',
  );
  assert.equal(fetched, 0);
});
