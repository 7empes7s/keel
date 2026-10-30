import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { anonymityNamer } from './anonymity.mjs';
import { FEED_GROUPINGS, feedGroupOf, groupChangeFeed, hidePeopleText, loadChangeFeed, serviceObjectName } from './feed.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
after(async () => {
  await client?.end();
  await database.cleanup();
});

const TENANT = 'contoso';
const OTHER = 'fabrikam';
const ADA = 'a0a00000-0000-4000-8000-0000000000a1';
const BOB = 'b0b00000-0000-4000-8000-0000000000b2';
const KEEL_APP = 'c0c00000-0000-4000-8000-0000000000c3';
const POLICY = 'ca000000-0000-4000-8000-000000000001';
const GROUP = '9a000000-0000-4000-8000-000000000002';
const GONE = 'dead0000-0000-4000-8000-000000000003';
// Every time is set relative to the run, so the test never rots (lessons 2026-10-04, 2026-10-08).
const NOW = new Date();
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);

async function snapshot(tenantRef, startedAt, resources = []) {
  const { rows: [row] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, $2, $2::timestamptz + interval '10 minutes', 'complete') RETURNING id",
    [tenantRef, startedAt],
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

async function drift(tenantRef, baselineId, snapshotId, { key, type, change, after: afterPayload, before: beforePayload = null, hash = 'h2', radius = 'scoped', at }) {
  return client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'h1', $7, $8, $9, $10, $11) RETURNING id`,
    [tenantRef, baselineId, snapshotId, key, type, change, hash, beforePayload, afterPayload, radius, at],
  ).then((result) => result.rows[0].id);
}

async function audit(tenantRef, id, at, { target, targetType, operation, actor, kind = 'user', activity = null }) {
  await client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantRef, id, at, targetType, target, operation, activity, kind, actor],
  );
}

const people = [
  ['user:ada@contoso.test', 'user', { id: ADA, displayName: 'Ada Admin' }],
  ['user:bob@contoso.test', 'user', { id: BOB, displayName: 'Bob Builder' }],
  ['servicePrincipal:KEEL Restorer', 'servicePrincipal', { id: KEEL_APP, displayName: 'KEEL Restorer' }],
];
const caPolicy = (state) => [`conditionalAccessPolicy:${POLICY}`, 'conditionalAccessPolicy', { id: POLICY, displayName: 'Block legacy sign-in', state }];
const finance = ['group:Finance', 'group', { id: GROUP, displayName: 'Finance' }];

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@contoso.test') RETURNING id", [TENANT, hoursAgo(100)]);
  await snapshot(TENANT, hoursAgo(50), [...people, caPolicy('enabled'), finance]);
  const found = await snapshot(TENANT, hoursAgo(30), [...people, caPolicy('disabled'), finance]);
  const again = await snapshot(TENANT, hoursAgo(10), [...people, caPolicy('disabled'), finance]);
  // The same difference, found by two backups: one change.
  for (const [snap, at] of [[found, hoursAgo(29)], [again, hoursAgo(9)]]) {
    await drift(TENANT, baseline.id, snap, {
      key: `conditionalAccessPolicy:${POLICY}`, type: 'conditionalAccessPolicy', change: 'modified', radius: 'tenant-lockout',
      before: caPolicy('enabled')[2], after: caPolicy('disabled')[2], at,
    });
  }
  // A group removed, which nobody's audit record names.
  await drift(TENANT, baseline.id, again, { key: 'group:Old team', type: 'group', change: 'removed', before: { id: GONE, displayName: 'Old team' }, after: null, hash: null, at: hoursAgo(8) });
  // Ada turned the policy off between the backup before and the one that found it.
  await audit(TENANT, 'entra:r1:0', hoursAgo(40), { target: POLICY, targetType: 'Policy', operation: 'update', actor: ADA, activity: 'Update conditional access policy' });
  // Bob added someone to Finance; the restorer app changed it too; an object Keel never backed up.
  await audit(TENANT, 'entra:r2:0', hoursAgo(20), { target: GROUP, targetType: 'Group', operation: 'update', actor: BOB, activity: 'Add member to group' });
  await audit(TENANT, 'entra:r3:0', hoursAgo(5), { target: GROUP, targetType: 'Group', operation: 'update', actor: KEEL_APP, kind: 'servicePrincipal' });
  await audit(TENANT, 'intune:r4:0', hoursAgo(4), { target: GONE.replace('dead', 'beef'), targetType: 'DeviceConfiguration', operation: 'delete', actor: BOB, activity: 'Delete DeviceConfiguration' });
  // Outside the window, and another tenant's: never listed.
  await audit(TENANT, 'entra:old:0', hoursAgo(24 * 40), { target: GROUP, targetType: 'Group', operation: 'update', actor: BOB });
  await audit(OTHER, 'entra:x:0', hoursAgo(3), { target: GROUP, targetType: 'Group', operation: 'update', actor: BOB });
  // A SharePoint sharing setting that changed between two reads.
  const read = async (to) => (await client.query(
    "INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to) VALUES ($1, 'sharepoint-tenant-settings', 'complete', $2, $2) RETURNING id",
    [TENANT, to],
  )).rows[0].id;
  const previous = await read(hoursAgo(26));
  const current = await read(hoursAgo(2));
  await client.query("INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'tenant', '{\"sharingCapability\":\"ExternalUserSharingOnly\"}')", [previous]);
  await client.query("INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'tenant', '{\"sharingCapability\":\"ExternalUserAndGuestSharing\"}')", [current]);
  await client.query(
    "INSERT INTO workload_drift (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, fields, blast_radius) VALUES ($1, 'sharepoint-tenant-settings', $2, $3, 'tenant', 'modified', '[]', 'scoped')",
    [TENANT, current, previous],
  );
});

const feed = (options = {}) => loadChangeFeed(client, { tenantRef: TENANT, now: NOW, ...options });

test('every change, drift and audit event is one row, newest first, in this tenant only', async () => {
  const { rows, truncated } = await feed();
  assert.equal(truncated, false);
  assert.deepEqual(rows.map((entry) => entry.id), [
    'service:' + rows[0].id.slice('service:'.length), 'audit:intune:r4:0', 'audit:entra:r3:0', 'drift:' + rows[3].id.slice(6),
    'audit:entra:r2:0', 'drift:' + rows[5].id.slice(6), 'audit:entra:r1:0',
  ]);
  assert.deepEqual(rows.map((entry) => entry.source), ['service', 'audit', 'audit', 'drift', 'audit', 'drift', 'audit']);
  for (let index = 1; index < rows.length; index += 1) assert.ok(rows[index - 1].occurredAt >= rows[index].occurredAt);
});

test('a difference two backups found is listed once, at the first backup, with the one person who made it', async () => {
  const { rows } = await feed();
  const policy = rows.filter((entry) => entry.source === 'drift' && entry.type === 'conditionalAccessPolicy');
  assert.equal(policy.length, 1);
  const [entry] = policy;
  assert.equal(entry.occurredAt, hoursAgo(29).toISOString());
  assert.equal(entry.typeName, 'Conditional Access policy');
  assert.equal(entry.service, 'Entra');
  assert.equal(entry.priority, 'critical');
  assert.deepEqual(entry.object, { key: `conditionalAccessPolicy:${POLICY}`, name: 'Block legacy sign-in', status: 'found' });
  assert.equal(entry.change, 'modified');
  assert.deepEqual(entry.person, { kind: 'user', id: ADA, name: 'Ada Admin' });
});

test('a change no audit record names has no person', async () => {
  const { rows } = await feed();
  const removed = rows.find((entry) => entry.source === 'drift' && entry.type === 'group');
  assert.equal(removed.person, null);
  assert.equal(removed.change, 'removed');
  assert.deepEqual(removed.object, { key: 'group:Old team', name: 'Old team', status: 'deleted' });
});

test('audit rows name the object from the backup, and never show an id as a name', async () => {
  const { rows } = await feed();
  const added = rows.find((entry) => entry.id === 'audit:entra:r2:0');
  assert.equal(added.type, 'group');
  assert.equal(added.object.name, 'Finance');
  assert.equal(added.activity, 'Add member to group');
  assert.deepEqual(added.person, { kind: 'user', id: BOB, name: 'Bob Builder' });
  const app = rows.find((entry) => entry.id === 'audit:entra:r3:0');
  assert.deepEqual(app.person, { kind: 'servicePrincipal', id: KEEL_APP, name: 'KEEL Restorer' });
  // Never backed up: the log's own type in words, the log's service, no name.
  const unknown = rows.find((entry) => entry.id === 'audit:intune:r4:0');
  assert.equal(unknown.service, 'Intune');
  assert.equal(unknown.change, 'removed');
  assert.equal(unknown.object.name, null);
  assert.equal(unknown.object.status, 'unknown');
  assert.match(unknown.typeName, /^Device ?configuration$/i);
});

test('service setting changes carry the service and the setting group name', async () => {
  const { rows } = await feed();
  const [entry] = rows.filter((row) => row.source === 'service');
  assert.equal(entry.service, 'SharePoint');
  assert.equal(entry.object.name, 'Sharing settings');
  assert.equal(entry.person, null);
  assert.equal(entry.occurredAt, hoursAgo(2).toISOString());
});

test('with names hidden, people get code names and apps keep theirs', async () => {
  const namer = anonymityNamer({ enabled: true, salt: 'test-salt' });
  const { rows } = await feed({ namer });
  const ada = rows.find((entry) => entry.id === 'audit:entra:r1:0').person;
  const policy = rows.find((entry) => entry.source === 'drift' && entry.type === 'conditionalAccessPolicy').person;
  assert.match(ada.name, /^Person [A-Z2-9]{4}$/);
  assert.equal(ada.pseudonym, true);
  // The same person has the same code name on every row.
  assert.equal(policy.name, ada.name);
  assert.ok(!JSON.stringify(rows).includes('Ada Admin'));
  assert.ok(!JSON.stringify(rows).includes('Bob Builder'));
  assert.equal(rows.find((entry) => entry.id === 'audit:entra:r3:0').person.name, 'KEEL Restorer');
});

test('the window and the row limit bound the read', async () => {
  const short = await feed({ days: 1 });
  assert.ok(short.rows.every((entry) => entry.occurredAt >= hoursAgo(24).toISOString()));
  assert.ok(!short.rows.some((entry) => entry.id === 'audit:entra:r1:0'));
  const capped = await feed({ limit: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.truncated, true);
  // Silly values fall back to the defaults instead of reading everything.
  const fallback = await feed({ days: -5, limit: 'many' });
  assert.equal(fallback.rows.length, 7);
  assert.equal(new Date(fallback.until).getTime() - new Date(fallback.since).getTime(), 30 * 86_400_000);
});

test('a tenant with nothing read yet has an empty feed', async () => {
  const { rows } = await loadChangeFeed(client, { tenantRef: 'empty-tenant', now: NOW });
  assert.deepEqual(rows, []);
  await assert.rejects(() => loadChangeFeed(client, {}), TypeError);
});

test('grouping by each field: order and counts', async () => {
  const { rows } = await feed();
  assert.deepEqual(FEED_GROUPINGS, ['day', 'type', 'service', 'priority', 'person']);
  const byService = groupChangeFeed(rows, 'service');
  assert.deepEqual(byService.map((group) => [group.label, group.count]), [['Entra', 5], ['Intune', 1], ['SharePoint', 1]]);
  const byPriority = groupChangeFeed(rows, 'priority');
  assert.equal(byPriority[0].key, 'critical');
  assert.equal(byPriority.reduce((sum, group) => sum + group.count, 0), rows.length);
  const byPerson = groupChangeFeed(rows, 'person');
  assert.deepEqual(byPerson.map((group) => [group.label, group.count]), [['Bob Builder', 2], ['Ada Admin', 2], ['KEEL Restorer', 1], ['Not known', 2]].sort((a, b) => (a[0] === 'Not known') - (b[0] === 'Not known') || b[1] - a[1] || a[0].localeCompare(b[0])));
  assert.equal(byPerson.at(-1).label, 'Not known');
  const byDay = groupChangeFeed(rows, 'day');
  for (let index = 1; index < byDay.length; index += 1) assert.ok(byDay[index - 1].key > byDay[index].key);
  const byType = groupChangeFeed(rows, 'type');
  assert.equal(byType[0].key, 'conditionalAccessPolicy');
  assert.equal(byType[0].priorities.critical, 2);
  // Rows keep their newest-first order inside a group.
  const entra = byService[0].rows;
  for (let index = 1; index < entra.length; index += 1) assert.ok(entra[index - 1].occurredAt >= entra[index].occurredAt);
});

test('pure helpers: unknown grouping, unnamed people, service names', () => {
  assert.throws(() => groupChangeFeed([], 'colour'), RangeError);
  assert.deepEqual(feedGroupOf({ person: { kind: 'user', id: ADA, name: null } }, 'person'), { key: `user:${ADA}`, label: 'Unnamed person' });
  assert.deepEqual(feedGroupOf({ person: null }, 'person'), { key: 'unknown', label: 'Not known' });
  assert.equal(serviceObjectName('tenant', null), 'Sharing settings');
  assert.equal(serviceObjectName('site:abc', { webUrl: 'https://contoso.sharepoint.com/sites/hr' }), 'contoso.sharepoint.com/sites/hr');
  assert.equal(serviceObjectName(`policy:${POLICY}`, {}), null);
});

test('the same change made again after a roll back is listed again; a link change names who changed either end', async () => {
  const tenant = 'rollback-tenant';
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@contoso.test') RETURNING id", [tenant, hoursAgo(100)]);
  const first = await snapshot(tenant, hoursAgo(60), [...people, caPolicy('disabled')]);
  const second = await snapshot(tenant, hoursAgo(40), [...people, caPolicy('enabled')]);
  const third = await snapshot(tenant, hoursAgo(20), [...people, caPolicy('disabled')]);
  const off = { key: `conditionalAccessPolicy:${POLICY}`, type: 'conditionalAccessPolicy', change: 'modified', before: caPolicy('enabled')[2], after: caPolicy('disabled')[2] };
  const rolledBack = await drift(tenant, baseline.id, first, { ...off, at: hoursAgo(59) });
  await client.query("INSERT INTO disposition (drift_id, action, actor, reason) VALUES ($1, 'rollback', 'ops@contoso.test', 'not meant')", [rolledBack]);
  await drift(tenant, baseline.id, third, { ...off, at: hoursAgo(19) });
  // Bob added Ada to Finance: the link's key holds both ends' ids.
  await drift(tenant, baseline.id, second, { key: `edge:groupMember:${GROUP}:${ADA}`, type: 'groupMember', change: 'added', after: { groupId: GROUP, memberId: ADA }, at: hoursAgo(39) });
  await audit(tenant, 'entra:m1:0', hoursAgo(45), { target: GROUP, targetType: 'Group', operation: 'update', actor: BOB, activity: 'Add member to group' });
  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  const policy = rows.filter((entry) => entry.source === 'drift' && entry.type === 'conditionalAccessPolicy');
  assert.deepEqual(policy.map((entry) => entry.occurredAt), [hoursAgo(19).toISOString(), hoursAgo(59).toISOString()]);
  const link = rows.find((entry) => entry.source === 'drift' && entry.type === 'groupMember');
  assert.equal(link.person?.name, 'Bob Builder');
});

test('with names hidden, people a change is about and addresses in keys are code-named too', async () => {
  const tenant = 'people-tenant';
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@contoso.test') RETURNING id", [tenant, hoursAgo(100)]);
  const snap = await snapshot(tenant, hoursAgo(10), people);
  await drift(tenant, baseline.id, snap, { key: 'user:ada@contoso.test', type: 'user', change: 'modified', before: { id: ADA, displayName: 'Ada Admin' }, after: { id: ADA, displayName: 'Ada Admin', jobTitle: 'CEO' }, at: hoursAgo(9) });
  await audit(tenant, 'entra:u1:0', hoursAgo(12), { target: ADA, targetType: 'User', operation: 'update', actor: BOB, activity: 'Update user' });
  const namer = anonymityNamer({ enabled: true, salt: 'test-salt' });
  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW, namer });
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('Ada Admin') && !text.includes('ada@contoso.test') && !text.includes('Bob Builder'), text);
  const code = namer(ADA);
  assert.ok(rows.every((entry) => entry.object.name === code));
  assert.equal(rows.find((entry) => entry.source === 'drift').object.key, `user:${namer('ada@contoso.test')}`);
  assert.equal(hidePeopleText('https://contoso-my.sharepoint.com/personal/ada_contoso_com', namer), `https://contoso-my.sharepoint.com/personal/${namer('ada_contoso_com')}`);
  assert.equal(hidePeopleText('mail for ada@contoso.test', null), 'mail for ada@contoso.test');
});

test('an endpoint security policy made in Intune is listed under Defender', async () => {
  const tenant = 'tailspin';
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@tailspin.test') RETURNING id", [tenant, hoursAgo(100)]);
  const policy = (name, templateFamily) => ({ id: `${name}-id`, name, templateReference: { templateId: `${name}_1`, templateFamily } });
  const antivirus = ['configurationPolicy:KEEL-RT-Antivirus', 'configurationPolicy', policy('KEEL-RT-Antivirus', 'endpointSecurityAntivirus')];
  const wifi = ['configurationPolicy:KEEL-RT-Wi-Fi', 'configurationPolicy', policy('KEEL-RT-Wi-Fi', 'none')];
  const snap = await snapshot(tenant, hoursAgo(6), [antivirus, wifi]);
  for (const [key, type, payload] of [antivirus, wifi]) {
    await drift(tenant, baseline.id, snap, { key, type, change: 'modified', before: payload, after: payload, at: hoursAgo(5) });
  }
  const { rows } = await loadChangeFeed(client, { tenantRef: tenant, now: NOW });
  const byName = Object.fromEntries(rows.map((entry) => [entry.object.name, entry]));
  assert.deepEqual([byName['KEEL-RT-Antivirus'].type, byName['KEEL-RT-Antivirus'].service, byName['KEEL-RT-Antivirus'].typeName], ['configurationPolicy', 'Defender', 'Endpoint security policy']);
  assert.deepEqual([byName['KEEL-RT-Wi-Fi'].type, byName['KEEL-RT-Wi-Fi'].service, byName['KEEL-RT-Wi-Fi'].typeName], ['configurationPolicy', 'Intune', 'Settings catalog policy']);
});

test('grouping by type keeps endpoint security policies apart from other settings catalog policies', () => {
  const rows = [
    { type: 'configurationPolicy', kind: 'configurationPolicy', typeName: 'Settings catalog policy', service: 'Intune', priority: 'normal' },
    { type: 'configurationPolicy', kind: 'defenderEndpointSecurityPolicy', typeName: 'Endpoint security policy', service: 'Defender', priority: 'normal' },
  ];
  assert.deepEqual(groupChangeFeed(rows, 'type').map((group) => [group.key, group.label, group.count]), [
    ['configurationPolicy', 'Settings catalog policy', 1],
    ['defenderEndpointSecurityPolicy', 'Endpoint security policy', 1],
  ]);
});
