import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { permissionsSummary } from '../content/sharepointSites.mjs';
import { drivePermissionExposure } from '../content/permissionExposure.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { anonymityNamer } from './anonymity.mjs';
import { loadChangeFeed } from './feed.mjs';
import { loadNextSteps, stepDate } from './nextSteps.mjs';

// Each change feed row says its next step (#979): decide it under Open changes, how it was
// decided, see who can reach a site, restore from a backup, or only the audit log saw it.
// A decided row, or one whose alert was acknowledged or resolved, is dealt with.

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
after(async () => {
  await client?.end();
  await database.cleanup();
});

const TENANT = 'contoso';
// Every time is set relative to the run, so the test never rots (lessons 2026-10-04, 2026-10-08).
const NOW = new Date();
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
const POLICY = 'ca000000-0000-4000-8000-000000000001';
const DEVICE_POLICY = 'de000000-0000-4000-8000-000000000004';
const LONE = 'aa000000-0000-4000-8000-000000000005';
const SITE = 'contoso.sharepoint.com,00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101';

const ids = {};

async function snapshot(startedAt, resources = []) {
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

async function drift(baselineId, snapshotId, { key, type = 'group', change = 'modified', after: afterPayload, before: beforePayload = null, at }) {
  const { rows: [row] } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'h1', 'h2', $7, $8, 'scoped', $9) RETURNING id`,
    [TENANT, baselineId, snapshotId, key, type, change, beforePayload, afterPayload, at],
  );
  return row.id;
}

async function principal(email, name) {
  const { rows: [row] } = await client.query('INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING id::text AS id', [email, name]);
  return row.id;
}

async function alert(resourceKey, state, at, by = null) {
  await client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity, first_opened_at, occurrence_started_at,
                        last_firing_at, last_observed_at, last_event_id, acknowledged_by, acknowledged_at, resolved_at)
     VALUES ($1, $2, 'baseline', 'drift', $3, true, 'warning', $4, $4, $4, $4, 'e1', $5, $6, $7)`,
    [TENANT, resourceKey, state, hoursAgo(28), by, state === 'acknowledged' ? at : null, state === 'resolved' ? at : null],
  );
}

let serial = 0;
async function content({ workload, container, itemKey, metadata, at }) {
  serial += 1;
  await client.query(
    `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 10, '[]', 'k1', $8)`,
    [TENANT, workload, container, itemKey, `v${serial}`, metadata, String(serial % 10).repeat(64), at],
  );
}

const sitePermissions = (everyoneEdit) => ({
  groups: [{ id: 3, title: 'Finance Owners', members: [{ id: 7, title: 'Ada Admin', loginName: 'i:0#.f|membership|ada@contoso.test', principalType: 1 }] }],
  siteCollectionAdmins: [],
  roleAssignments: [
    { principalId: 3, member: { id: 3, title: 'Finance Owners', principalType: 8 }, roles: [{ name: 'Full Control' }] },
    ...(everyoneEdit ? [{ principalId: 5, member: { id: 5, title: 'Everyone except external users', loginName: 'c:0-.f|rolemanager|spo-grid-all-users/1111', principalType: 4 }, roles: [{ name: 'Edit' }] }] : []),
  ],
});

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  ids.ada = await principal('ada@contoso.test', 'Ada Admin');
  ids.bob = await principal('bob@contoso.test', 'Bob Builder');
  ids.cleo = await principal('cleo@contoso.test', 'Cleo Approver');
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_at, set_by) VALUES ($1, $2, 'ops@contoso.test') RETURNING id", [TENANT, hoursAgo(100)]);
  ids.snapshotBefore = await snapshot(hoursAgo(60), [[`deviceConfiguration:${DEVICE_POLICY}`, 'deviceConfiguration', { id: DEVICE_POLICY, displayName: 'Laptop rules' }]]);
  const found = await snapshot(hoursAgo(30));
  const again = await snapshot(hoursAgo(10));

  ids.open = await drift(baseline.id, found, { key: `conditionalAccessPolicy:${POLICY}`, type: 'conditionalAccessPolicy', before: { id: POLICY, state: 'enabled' }, after: { id: POLICY, state: 'disabled' }, at: hoursAgo(29) });
  // A later backup records the same difference again: the open change is that row.
  ids.openAgain = await drift(baseline.id, again, { key: `conditionalAccessPolicy:${POLICY}`, type: 'conditionalAccessPolicy', before: { id: POLICY, state: 'enabled' }, after: { id: POLICY, state: 'disabled' }, at: hoursAgo(9) });
  ids.accepted = await drift(baseline.id, found, { key: 'group:Accepted', after: { id: 'g1', displayName: 'Accepted' }, at: hoursAgo(28) });
  ids.ignored = await drift(baseline.id, found, { key: 'group:Ignored', after: { id: 'g2', displayName: 'Ignored' }, at: hoursAgo(27) });
  ids.undone = await drift(baseline.id, found, { key: 'group:Undone', after: { id: 'g3', displayName: 'Undone' }, at: hoursAgo(26) });
  ids.lapsed = await drift(baseline.id, found, { key: 'group:Lapsed', after: { id: 'g4', displayName: 'Lapsed' }, at: hoursAgo(25) });

  await client.query("INSERT INTO disposition (drift_id, action, actor, reason, decided_at) VALUES ($1, 'accept', $2, 'Planned change', $3)", [ids.accepted, ids.ada, hoursAgo(20)]);
  await client.query("INSERT INTO disposition (drift_id, action, actor, reason, decided_at, expires_at) VALUES ($1, 'ignore', $2, 'Known noise', $3, $4)", [ids.ignored, ids.bob, hoursAgo(19), new Date(NOW.getTime() + 86_400_000)]);
  // An ignore that ran out counts as no decision: the change is open again.
  await client.query("INSERT INTO disposition (drift_id, action, actor, reason, decided_at, expires_at) VALUES ($1, 'ignore', $2, 'Known noise', $3, $4)", [ids.lapsed, ids.bob, hoursAgo(19), hoursAgo(1)]);
  const { rows: [approval] } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, status, decided_by, decided_at, expires_at)
     VALUES ('remediate', $1, $2, 'approved', $3, $4, $5) RETURNING id`,
    [{ driftIds: [ids.undone] }, ids.bob, ids.cleo, hoursAgo(18), new Date(NOW.getTime() + 86_400_000)],
  );
  await client.query(
    `INSERT INTO job (kind, params, status, requested_by, created_at, finished_at, idempotency_key)
     VALUES ('remediate', $1, 'succeeded', $2, $3, $4, $5)`,
    [{ driftIds: [ids.undone] }, ids.bob, hoursAgo(18), hoursAgo(17), `approval:${approval.id}`],
  );

  // The audit log: the policy change a backup found too, a change only the log saw (its
  // alert acknowledged), and a deleted device policy a backup from before holds.
  const audit = (id, at, target, targetType, operation) => client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, null, 'user', 'a0a00000-0000-4000-8000-0000000000a1')`,
    [TENANT, id, at, targetType, target, operation],
  );
  await audit('entra:linked:0', hoursAgo(40), POLICY, 'Policy', 'update');
  await audit('entra:lone:0', hoursAgo(12), LONE, 'Group', 'update');
  await audit('intune:gone:0', hoursAgo(11), DEVICE_POLICY, 'DeviceConfiguration', 'delete');
  await alert(LONE, 'acknowledged', hoursAgo(5), ids.ada);
  // An open alert on the policy: the change still needs a look.
  await alert(`conditionalAccessPolicy:${POLICY}`, 'open', hoursAgo(8));

  // A service setting change, still open.
  const read = async (to) => (await client.query(
    "INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to) VALUES ($1, 'sharepoint-tenant-settings', 'complete', $2, $2) RETURNING id",
    [TENANT, to],
  )).rows[0].id;
  const previous = await read(hoursAgo(26));
  const current = await read(hoursAgo(2));
  ids.service = (await client.query(
    "INSERT INTO workload_drift (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, fields, blast_radius) VALUES ($1, 'sharepoint-tenant-settings', $2, $3, 'tenant', 'modified', '[]', 'scoped') RETURNING id",
    [TENANT, current, previous],
  )).rows[0].id;

  // Who can reach a site and a OneDrive.
  for (const [everyoneEdit, at] of [[false, hoursAgo(30)], [true, hoursAgo(6)]]) {
    await content({ workload: 'sharepoint-sites', container: `site:${SITE}`, itemKey: 'site/permissions', at, metadata: { summary: permissionsSummary(sitePermissions(everyoneEdit)), siteName: 'Finance' } });
  }
  const anyone = { id: 'L1', roles: ['read'], link: { scope: 'anonymous', type: 'view' } };
  for (const [grants, at] of [[[], hoursAgo(30)], [[anyone], hoursAgo(6)]]) {
    await content({ workload: 'onedrive', container: 'drive:b!abc', itemKey: 'budget.xlsx', at, metadata: { kind: 'drive-record', ownerName: 'Ada Admin', exposure: drivePermissionExposure(grants) } });
  }
});

const feed = (options = {}) => loadChangeFeed(client, { tenantRef: TENANT, now: NOW, ...options });
const rowOf = (rows, id) => rows.find((row) => row.id === id);

test('an open backup change: "Accept or undo" opens the newest record of it under Open changes', async () => {
  const { rows } = await feed();
  const step = rowOf(rows, `drift:${ids.open}`).nextStep;
  assert.equal(step.kind, 'decide');
  assert.deepEqual(step.link, { label: 'Accept or undo', href: `/changes?open=${ids.openAgain}` });
  assert.deepEqual(step.points, { openChange: ids.openAgain });
  // An open alert on it does not count as dealt with.
  assert.equal(step.dealtWith, false);
  assert.equal(step.alert, undefined);
  // An ignore that ran out leaves the change open.
  assert.equal(rowOf(rows, `drift:${ids.lapsed}`).nextStep.kind, 'decide');
});

test('an open service setting change opens itself under Open changes', async () => {
  const { rows } = await feed();
  const step = rowOf(rows, `service:${ids.service}`).nextStep;
  assert.deepEqual([step.kind, step.link?.href, step.dealtWith], ['decide', `/changes?open=${ids.service}`, false]);
});

test('decided changes say how, by whom and when, and are dealt with', async () => {
  const { rows } = await feed();
  const on = (hours) => stepDate(hoursAgo(hours), NOW);
  const accepted = rowOf(rows, `drift:${ids.accepted}`).nextStep;
  assert.deepEqual([accepted.kind, accepted.text, accepted.link, accepted.dealtWith], ['accepted', `Accepted by Ada Admin on ${on(20)}.`, null, true]);
  const ignored = rowOf(rows, `drift:${ids.ignored}`).nextStep;
  assert.deepEqual([ignored.kind, ignored.text, ignored.dealtWith], ['ignored', `Ignored by Bob Builder on ${on(19)}.`, true]);
  const undone = rowOf(rows, `drift:${ids.undone}`).nextStep;
  assert.deepEqual([undone.kind, undone.text, undone.dealtWith], ['undone', `Undone on ${on(17)}, approved by Cleo Approver.`, true]);
});

test('an accepted service change says who accepted it', async () => {
  const tenantRef = TENANT;
  const { rows: [row] } = await client.query('SELECT collection_id FROM workload_drift WHERE id = $1', [ids.service]);
  await client.query(
    "INSERT INTO workload_approved (tenant_ref, workload, resource_key, collection_id, approved_by, reason, approved_at) VALUES ($1, 'sharepoint-tenant-settings', 'tenant', $2, $3, 'Planned', $4)",
    [tenantRef, row.collection_id, ids.ada, hoursAgo(1)],
  );
  try {
    const step = rowOf((await feed()).rows, `service:${ids.service}`).nextStep;
    assert.deepEqual([step.kind, step.text, step.dealtWith], ['accepted', `Accepted by Ada Admin on ${stepDate(hoursAgo(1), NOW)}.`, true]);
  } finally {
    await client.query("DELETE FROM workload_approved WHERE tenant_ref = $1 AND workload = 'sharepoint-tenant-settings'", [tenantRef]);
  }
});

test('an audit row links to the open change for the same object, or says only the log saw it', async () => {
  const { rows } = await feed();
  const linked = rowOf(rows, 'audit:entra:linked:0').nextStep;
  assert.deepEqual([linked.kind, linked.link?.href], ['decide', `/changes?open=${ids.openAgain}`]);
  const lone = rowOf(rows, 'audit:entra:lone:0').nextStep;
  assert.deepEqual([lone.kind, lone.text, lone.link], ['audit', 'Seen in the Microsoft audit log. The next backup shows whether it is still in place.', null]);
  // Its alert was acknowledged after the change: dealt with, and the record names it.
  assert.equal(lone.dealtWith, true);
  assert.equal(lone.alert.text, `Its alert was acknowledged by Ada Admin on ${stepDate(hoursAgo(5), NOW)}.`);
  assert.ok(lone.points.alert);
});

test('a deleted object a backup holds: restore from the backup before the change', async () => {
  const { rows } = await feed();
  const step = rowOf(rows, 'audit:intune:gone:0').nextStep;
  assert.deepEqual([step.kind, step.link], ['restore', { label: 'Restore from the backup before this change', href: `/restore?snapshot=${ids.snapshotBefore}` }]);
  assert.deepEqual(step.points, { snapshot: ids.snapshotBefore });
  assert.equal(step.dealtWith, false);
});

test('content rows: a site links to its page, a OneDrive says where to look', async () => {
  const { rows } = await feed();
  const site = rows.find((row) => row.source === 'backup' && row.service === 'SharePoint').nextStep;
  assert.deepEqual([site.kind, site.link], ['site', { label: 'See who can reach this site', href: `/sites/${encodeURIComponent(SITE)}` }]);
  assert.deepEqual(site.points, { site: SITE });
  const drive = rows.find((row) => row.source === 'backup' && row.service === 'OneDrive').nextStep;
  assert.deepEqual([drive.kind, drive.link], ['onedrive', null]);
  assert.match(drive.text, /SharePoint admin center/);
});

test('a resolved alert also deals with a change; one resolved before the change does not', async () => {
  await alert('group:Lapsed', 'resolved', hoursAgo(2));
  await alert(DEVICE_POLICY, 'resolved', hoursAgo(40));
  try {
    const { rows } = await feed();
    const lapsed = rowOf(rows, `drift:${ids.lapsed}`).nextStep;
    assert.deepEqual([lapsed.kind, lapsed.dealtWith, lapsed.alert?.text], ['decide', true, `Its alert was resolved on ${stepDate(hoursAgo(2), NOW)}.`]);
    assert.equal(rowOf(rows, 'audit:intune:gone:0').nextStep.dealtWith, false);
  } finally {
    await client.query("DELETE FROM alert WHERE tenant_ref = $1 AND state = 'resolved'", [TENANT]);
  }
});

test('with names hidden, deciders show as code names', async () => {
  const namer = anonymityNamer({ enabled: true, salt: 'test-salt' });
  const { rows } = await feed({ namer });
  const text = JSON.stringify(rows.map((row) => row.nextStep));
  for (const name of ['Ada Admin', 'Bob Builder', 'Cleo Approver', '@contoso.test']) assert.ok(!text.includes(name), name);
  assert.equal(rowOf(rows, `drift:${ids.accepted}`).nextStep.text, `Accepted by ${namer('ada@contoso.test')} on ${stepDate(hoursAgo(20), NOW)}.`);
  assert.match(rowOf(rows, `drift:${ids.undone}`).nextStep.text, new RegExp(`approved by ${namer('cleo@contoso.test')}\\.$`));
});

test('every row has exactly one next step, read with a fixed number of queries for the whole page', async () => {
  const { rows } = await feed();
  assert.ok(rows.length >= 10);
  for (const row of rows) assert.ok(row.nextStep && typeof row.nextStep.kind === 'string' && row.nextStep.text, row.id);
  const counting = (count) => ({ query: (...args) => { count.n += 1; return client.query(...args); } });
  const items = rows.map((row) => ({ id: row.id, source: row.source, occurredAt: row.occurredAt, key: row.object.key }));
  const few = { n: 0 };
  await loadNextSteps(counting(few), { tenantRef: TENANT, now: NOW, items: items.slice(0, 3) });
  const all = { n: 0 };
  await loadNextSteps(counting(all), { tenantRef: TENANT, now: NOW, items });
  assert.ok(all.n <= 16, `queries: ${all.n}`);
  assert.ok(all.n - few.n <= 8, `queries grow with rows: ${few.n} then ${all.n}`);
});
