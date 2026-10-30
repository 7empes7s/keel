import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { completeSnapshot, connect, createSnapshot, insertReferences, insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import {
  CompareError, compareContentHoldings, compareContentItems, compareSettings, compareSnapshots, compareTenants, compareWithLive, compareWorkloads,
  differenceCount, listCompareSources, portablePayload, presenceFields,
} from './compare.mjs';
import { SCRIPT_BODY_FIELDS } from '../safety/scriptBodies.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const admin = await database.connect();
await admin.query(schemaSql());
await admin.end();
const client = await connect(database.url);
test.after(async () => { await client.end(); await database.cleanup(); });

const TENANT_A = 'sha256:00000000000000a1';
const TENANT_B = 'sha256:00000000000000b2';
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Stores a completed snapshot from raw Graph objects, the way collectSnapshot does. */
async function storeSnapshot(tenantRef, collected, { at, coverage = fullSuccessfulCoverageDigest() }) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const resource of canonicalizeAll(collected)) {
    const versionId = await insertResourceVersion(client, { snapshotId, resource: { ...resource, fidelity: resource.provenance.fidelity } });
    await insertReferences(client, { fromVersion: versionId, references: resource.references });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: coverage });
  await client.query('UPDATE snapshot SET started_at = $2, completed_at = $2 WHERE id = $1', [snapshotId, at]);
  return snapshotId;
}

const group = (n, nickname, extra = {}) => ({ id: guid(n), displayName: nickname, mailNickname: nickname, securityEnabled: true, ...extra });
const policy = (n, name, groupIds, state = 'enabled') => ({
  id: guid(n), displayName: name, state,
  conditions: { users: { includeGroups: groupIds, excludeGroups: [] }, applications: { includeApplications: ['All'] } },
  grantControls: { operator: 'OR', builtInControls: ['mfa'] },
});

async function putContent(tenantRef, { workload, container, itemKey, version, sha, bytes = 10, metadata = {}, at }) {
  await client.query(
    `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]','k1',$9)`,
    [tenantRef, workload, container, itemKey, version, metadata, sha.repeat(64).slice(0, 64), bytes, at],
  );
}

async function putWorkload(tenantRef, { workload, outcome, at, resources }) {
  const { rows: [run] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1,$2,$3,$4,$4,$4) RETURNING id`,
    [tenantRef, workload, outcome, at],
  );
  for (const [resourceKey, fields, fieldCoverage = {}] of resources) {
    await client.query('INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage) VALUES ($1,$2,$3,$4)', [run.id, resourceKey, fields, fieldCoverage]);
  }
}

const T1 = new Date('2026-10-01T06:00:00Z');
const T2 = new Date('2026-10-02T06:00:00Z');
const T3 = new Date('2026-10-03T06:00:00Z');

// Tenant A at T1 and T2.
const a1 = await storeSnapshot(TENANT_A, [
  ['group', [group(1, 'KEEL-RT-Finance'), group(2, 'KEEL-RT-Old'), group(3, 'KEEL-RT-Same')]],
  ['conditionalAccessPolicy', [policy(10, 'KEEL-RT-Require MFA', [guid(1)])]],
], { at: T1 });
const coverageWithoutCa = { ...fullSuccessfulCoverageDigest(), conditionalAccessPolicy: { outcome: 'failed', itemCount: null } };
const a2 = await storeSnapshot(TENANT_A, [
  ['group', [group(1, 'KEEL-RT-Finance', { securityEnabled: false }), group(3, 'KEEL-RT-Same'), group(4, 'KEEL-RT-New')]],
], { at: T2, coverage: coverageWithoutCa });
// Tenant B: the same objects with other ids; one real setting differs.
const b1 = await storeSnapshot(TENANT_B, [
  ['group', [group(101, 'KEEL-RT-Finance'), group(102, 'KEEL-RT-Old'), group(103, 'KEEL-RT-Same')]],
  ['conditionalAccessPolicy', [policy(110, 'KEEL-RT-Require MFA', [guid(101)], 'disabled')]],
  ['deviceCategory', [{ id: guid(120), displayName: 'KEEL-RT-Kiosk' }]],
], { at: T2 });

// Content in tenant A: one item kept, one changed, one deleted, one new; one in B.
await putContent(TENANT_A, { workload: 'exchange-mail', container: 'mailbox/u1/items/inbox', itemKey: 'm1', version: 'v1', sha: 'a', at: T1 });
await putContent(TENANT_A, { workload: 'exchange-mail', container: 'mailbox/u1/items/inbox', itemKey: 'm2', version: 'v1', sha: 'b', at: T1 });
await putContent(TENANT_A, { workload: 'exchange-mail', container: 'mailbox/u1/items/inbox', itemKey: 'm2', version: 'v2', sha: 'c', at: new Date('2026-10-01T12:00:00Z') });
await putContent(TENANT_A, { workload: 'onedrive', container: 'drive:d1', itemKey: 'f1', version: 'v1', sha: 'd', metadata: { name: 'KEEL-RT-plan.docx' }, at: T1 });
await putContent(TENANT_A, { workload: 'onedrive', container: 'drive:d1', itemKey: 'f1', version: 'record:x', sha: 'e', metadata: { deleted: true }, at: new Date('2026-10-01T13:00:00Z') });
await putContent(TENANT_A, { workload: 'onedrive', container: 'drive:d1', itemKey: 'f2', version: 'v1', sha: 'f', metadata: { name: 'KEEL-RT-new.docx' }, at: new Date('2026-10-01T14:00:00Z') });
await putContent(TENANT_B, { workload: 'exchange-mail', container: 'mailbox/u9/items/inbox', itemKey: 'm9', version: 'v1', sha: 'a', at: T1 });

// Workloads in tenant A: a mailbox setting changes; the second run is partial.
await putWorkload(TENANT_A, { workload: 'exchange-mailbox-settings', outcome: 'complete', at: T1, resources: [
  ['mailbox:keel-rt-a@contoso.example', { identity: guid(50), mailboxSettings: { ForwardingSmtpAddress: null, HiddenFromAddressListsEnabled: false } }],
  ['mailbox:keel-rt-b@contoso.example', { identity: guid(51), mailboxSettings: { ForwardingSmtpAddress: null } }],
] });
await putWorkload(TENANT_A, { workload: 'exchange-mailbox-settings', outcome: 'partial', at: new Date('2026-10-01T18:00:00Z'), resources: [
  ['mailbox:keel-rt-a@contoso.example', { identity: guid(50), mailboxSettings: { ForwardingSmtpAddress: 'smtp:x@example.com', HiddenFromAddressListsEnabled: true } },
    { 'mailboxSettings.ForwardingSmtpAddress': { status: 'observed' }, 'mailboxSettings.HiddenFromAddressListsEnabled': { status: 'failed' } }],
] });
await putWorkload(TENANT_A, { workload: 'teams-org-policies', outcome: 'failed', at: new Date('2026-10-01T18:00:00Z'), resources: [] });

const settingsItems = (result) => Object.fromEntries(result.settings.groups.flatMap((g) => g.items.map((item) => [item.naturalKey, item])));

test('two snapshots of one tenant: added, removed and changed, never a removal from a failed read', async () => {
  const result = await compareSnapshots(client, { leftSnapshotId: a1, rightSnapshotId: a2, now: T3 });
  assert.equal(result.mode, 'snapshots');
  assert.equal(result.portable, false);
  const items = settingsItems(result);
  assert.equal(items['group:KEEL-RT-Old'].changeType, 'removed');
  assert.equal(items['group:KEEL-RT-New'].changeType, 'added');
  // An object on one side only lists the settings it holds, each with its value.
  const added = items['group:KEEL-RT-New'];
  assert.ok(added.fields.length > 0 && added.fieldsTotal >= added.fields.length);
  assert.ok(added.fields.every((field) => field.kind === 'added' && field.before === null));
  assert.equal(added.fields.find((field) => field.path === 'displayName')?.after, 'KEEL-RT-New');
  const removed = items['group:KEEL-RT-Old'];
  assert.ok(removed.fields.length > 0 && removed.fields.every((field) => field.kind === 'removed' && field.after === null));
  assert.equal(items['group:KEEL-RT-Finance'].changeType, 'changed');
  assert.deepEqual(items['group:KEEL-RT-Finance'].fields.map((field) => [field.path, field.before, field.after]), [['securityEnabled', true, false]]);
  assert.equal(items['group:KEEL-RT-Same'], undefined);
  assert.equal(result.settings.totals.unchanged, 1);
  // The CA policy read failed on the right: not compared, and never reported as removed.
  assert.equal(items['conditionalAccessPolicy:KEEL-RT-Require MFA'], undefined);
  assert.deepEqual(result.settings.notCompared.map((entry) => [entry.resourceType, entry.left, entry.right]), [['conditionalAccessPolicy', 'complete', 'failed']]);
  const groups = result.settings.groups.find((g) => g.resourceType === 'group');
  assert.equal(groups.service, 'Entra ID');
});

test('content in one tenant is compared item by item, by container', async () => {
  const result = await compareSnapshots(client, { leftSnapshotId: a1, rightSnapshotId: a2, sections: ['content'], now: T3 });
  assert.equal(result.settings, null);
  assert.equal(result.content.by, 'item');
  assert.deepEqual(result.content.totals, { added: 1, removed: 1, changed: 1 });
  const mail = result.content.groups.find((g) => g.workload === 'exchange-mail');
  assert.equal(mail.service, 'Exchange Online');
  assert.deepEqual(mail.containers.map((c) => [c.container, c.changed, c.items.map((i) => i.itemKey)]), [['mailbox/u1/items/inbox', 1, ['m2']]]);
  const drive = result.content.groups.find((g) => g.workload === 'onedrive');
  const byKey = Object.fromEntries(drive.containers[0].items.map((item) => [item.itemKey, item]));
  assert.equal(byKey.f1.changeType, 'removed', 'a deleted marker removes the item');
  assert.equal(byKey.f2.changeType, 'added');
  assert.equal(byKey.f2.name, 'KEEL-RT-new.docx');
  assert.equal(drive.leftItems, 1);
  assert.equal(drive.rightItems, 1);
});

test('workloads compare only what both sides observed, and a partial run proves no removal', async () => {
  const result = await compareSnapshots(client, { leftSnapshotId: a1, rightSnapshotId: a2, sections: ['workloads'], now: T3 });
  const mailbox = result.workloads.groups.find((g) => g.workload === 'exchange-mailbox-settings');
  assert.equal(mailbox.state, 'compared');
  assert.equal(mailbox.removed, 0, 'keel-rt-b is missing from a partial run, which is not a removal');
  assert.equal(mailbox.unverified, 1);
  assert.deepEqual(mailbox.items, [{
    resourceKey: 'mailbox:keel-rt-a@contoso.example', changeType: 'changed', fieldsTotal: 1,
    fields: [{ path: 'mailboxSettings.ForwardingSmtpAddress', kind: 'changed', before: null, after: 'smtp:x@example.com' }],
  }]);
  assert.equal(mailbox.unverifiedFields, 1, 'a field the right side failed to read is not compared');
  const teams = result.workloads.groups.find((g) => g.workload === 'teams-org-policies');
  assert.equal(teams.state, 'not-compared');
});

test('tenant against tenant matches by name and ignores id-only differences', async () => {
  const result = await compareTenants(client, { leftTenantRef: TENANT_A, rightTenantRef: TENANT_B, now: T3 });
  assert.equal(result.mode, 'tenants');
  assert.equal(result.portable, true);
  assert.equal(result.left.snapshotId, a2, 'the newest completed snapshot of each tenant');
  // Snapshots a1 and b1 hold the same groups and policy with other ids.
  const exact = await compareSnapshots(client, { leftSnapshotId: a1, rightSnapshotId: b1, sections: ['settings', 'content'], now: T3 });
  assert.equal(exact.mode, 'tenants');
  const items = settingsItems(exact);
  assert.equal(items['group:KEEL-RT-Finance'], undefined, 'groups that differ only in their ids are the same');
  assert.equal(items['group:KEEL-RT-Old'], undefined);
  const ca = items['conditionalAccessPolicy:KEEL-RT-Require MFA'];
  assert.equal(ca.changeType, 'changed', 'the policy points at the same group by name; only its state differs');
  assert.deepEqual(ca.fields.map((field) => [field.path, field.before, field.after]), [['state', 'enabled', 'disabled']]);
  // A type keyed by a tenant id cannot be matched across tenants and says so.
  assert.deepEqual(exact.settings.unmatched.map((entry) => [entry.resourceType, entry.left, entry.right]), [['deviceCategory', 0, 1]]);
  assert.equal(exact.settings.unmatched[0].service, 'Intune');
  // Content ids are tenant-bound: two tenants are compared by what they hold.
  assert.equal(exact.content.by, 'holdings');
  const mail = exact.content.groups.find((g) => g.workload === 'exchange-mail');
  assert.equal(mail.inBoth, 1);
  assert.equal(mail.onlyLeft, 1);
  assert.equal(mail.onlyRight, 0);
  await assert.rejects(() => compareTenants(client, { leftTenantRef: TENANT_A, rightTenantRef: TENANT_A }), (error) => error instanceof CompareError && error.code === 'same-tenant');
});

test('the portable form replaces references by name and masks every other id', () => {
  const payload = { id: guid(9), conditions: { users: { includeGroups: [guid(1)] } }, note: 'x' };
  assert.deepEqual(portablePayload(payload, [{ field_path: 'conditions.users.includeGroups[0]', to_symbol: 'group:KEEL-RT-Finance' }]),
    { id: '<id>', conditions: { users: { includeGroups: ['ref:group:KEEL-RT-Finance'] } }, note: 'x' });
  assert.deepEqual(portablePayload({ owner: guid(2) }, [{ field_path: 'owner', to_symbol: null }]), { owner: 'ref:unresolved' });
});

test('a snapshot against live reads with GETs only, stores nothing, and refuses another tenant', async () => {
  const calls = [];
  const reader = {
    async collect(version, path) {
      calls.push(path);
      if (path.startsWith('/groups')) return { items: [group(1, 'KEEL-RT-Finance'), group(3, 'KEEL-RT-Same', { description: 'edited' })], pages: 1, status: 200, error: null };
      return { items: [], pages: 1, status: 200, error: null };
    },
  };
  const before = (await client.query('SELECT count(*)::int AS n FROM snapshot')).rows[0].n;
  const result = await compareWithLive(client, { snapshotId: a1, tenantRef: TENANT_A, reader, tenantId: 'fixture', sections: ['settings'], now: T3 });
  const after = (await client.query('SELECT count(*)::int AS n FROM snapshot')).rows[0].n;
  assert.equal(after, before, 'a live compare writes no snapshot');
  assert.ok(calls.length > 0);
  assert.deepEqual(Object.keys(reader), ['collect'], 'the reader offers reads only');
  assert.equal(result.mode, 'live');
  assert.equal(result.right.kind, 'live');
  const items = settingsItems(result);
  assert.equal(items['group:KEEL-RT-Old'].changeType, 'removed');
  assert.equal(items['group:KEEL-RT-Same'].changeType, 'changed');
  assert.equal(items['group:KEEL-RT-Same'].fields[0].path, 'description');
  assert.equal(items['conditionalAccessPolicy:KEEL-RT-Require MFA'].changeType, 'removed', 'a complete empty live read is authority');
  assert.equal(items['group:KEEL-RT-Finance'], undefined);
  await assert.rejects(
    () => compareWithLive(client, { snapshotId: b1, tenantRef: TENANT_A, reader, tenantId: 'fixture' }),
    (error) => error.code === 'tenant-mismatch',
  );
});

test('the pickers list each tenant with its completed snapshots, newest first', async () => {
  const sources = await listCompareSources(client);
  const a = sources.find((tenant) => tenant.tenantRef === TENANT_A);
  assert.deepEqual(a.snapshots.map((snapshot) => snapshot.id), [a2, a1]);
  assert.equal(a.snapshots[1].resourceCount, 4);
});

test('pure rules: unknown coverage is compared, differing hash versions are reprojected', () => {
  const row = (key, payload, hash, version = 2) => ({ natural_key: key, resource_type: 'group', payload, payload_hash: hash, hash_version: version, blast_radius: 'access-affecting' });
  const same = compareSettings(
    { rows: [row('group:x', { displayName: 'x', mailNickname: 'x' }, 'old-hash', 1)], coverage: null },
    { rows: [row('group:x', { displayName: 'x', mailNickname: 'x' }, 'new-hash', 2)], coverage: null },
  );
  assert.equal(same.totals.changed, 0, 'two hash versions are compared on their payloads, not their hash strings');
  assert.equal(same.totals.unchanged, 1);
  const workloads = compareWorkloads(new Map(), new Map([['purview-labels', { collectionId: 'c', outcome: 'complete', at: T1, observations: [] }]]));
  assert.equal(workloads.groups[0].reason, 'not-collected');
  assert.equal(differenceCount({ settings: same, workloads, content: null }).total, 0);
});

test('a role assignment schedule read at another time is unchanged, even against a hash stored under older rules', () => {
  const schedule = (start, expiration = { type: 'noExpiration', endDateTime: null, duration: null }) => ({
    id: 'a-1', principalId: 'p', roleDefinitionId: 'r', directoryScopeId: '/', memberType: 'Direct', status: 'Provisioned',
    scheduleInfo: { startDateTime: start, recurrence: null, expiration },
  });
  const row = (payload, hash) => ({ natural_key: 'a-1', resource_type: 'roleAssignmentSchedule', payload, payload_hash: hash, hash_version: 2, blast_radius: 'tenant-lockout' });
  const stored = row(schedule('2026-10-15T09:00:17.5660219Z'), 'hash-with-the-read-time');
  const live = row(schedule('2026-10-15T09:39:03.6767194Z'), 'hash-without-it');
  const same = compareSettings({ rows: [stored], coverage: null }, { rows: [live], coverage: null });
  assert.equal(same.totals.changed, 0, 'the start Graph reports as the read time is not a difference');
  assert.equal(same.totals.unchanged, 1);

  const expiring = row(schedule('2026-10-15T09:39:03.6767194Z', { type: 'afterDateTime', endDateTime: '2026-11-01T00:00:00Z', duration: null }), 'x');
  const changed = compareSettings({ rows: [stored], coverage: null }, { rows: [expiring], coverage: null });
  assert.equal(changed.totals.changed, 1, 'a new expiry is still a difference');
  assert.deepEqual(changed.groups[0].items[0].fields.map((field) => field.path).sort(), ['scheduleInfo.expiration.endDateTime', 'scheduleInfo.expiration.type']);
});

test('a deleted list item is gone, and a drive file is compared by its file, not its record', async () => {
  const C = 'sha256:00000000000000c3';
  const D = 'sha256:00000000000000d4';
  // A SharePoint list item deleted by its version marker; its metadata says nothing.
  await putContent(C, { workload: 'sharepoint-sites', container: 'site:s1', itemKey: 'list/l1/item/7', version: 'e1', sha: '1', metadata: { contentType: 'application/json' }, at: T1 });
  await putContent(C, { workload: 'sharepoint-sites', container: 'site:s1', itemKey: 'list/l1/item/7', version: 'deleted:e1', sha: '2', metadata: { contentType: 'application/json' }, at: new Date('2026-10-01T12:00:00Z') });
  // The same file in both tenants, each followed by its own (different) record.
  for (const [tenant, record] of [[C, '3'], [D, '4']]) {
    await putContent(tenant, { workload: 'onedrive', container: 'drive:x', itemKey: 'f', version: 'v1', sha: '9', bytes: 5000, metadata: { kind: 'drive-content' }, at: T1 });
    await putContent(tenant, { workload: 'onedrive', container: 'drive:x', itemKey: 'f', version: `record:${record}`, sha: record, bytes: 120, metadata: { kind: 'drive-record', name: 'KEEL-RT-same.docx' }, at: new Date('2026-10-01T07:00:00Z') });
  }
  // A new record alone (a rename) on C later does not make the file differ.
  await putContent(C, { workload: 'onedrive', container: 'drive:x', itemKey: 'f', version: 'record:5', sha: '5', bytes: 121, metadata: { kind: 'drive-record', name: 'KEEL-RT-renamed.docx' }, at: new Date('2026-10-01T15:00:00Z') });

  const items = await compareContentItems(client, { tenantRef: C, leftAt: new Date('2026-10-01T08:00:00Z'), rightAt: T2 });
  assert.deepEqual(items.totals, { added: 0, removed: 1, changed: 0 });
  assert.equal(items.groups.find((g) => g.workload === 'sharepoint-sites').containers[0].items[0].itemKey, 'list/l1/item/7');

  const holdings = await compareContentHoldings(client, { leftTenantRef: C, leftAt: T2, rightTenantRef: D, rightAt: T2 });
  const drive = holdings.groups.find((g) => g.workload === 'onedrive');
  assert.equal(drive.inBoth, 1, 'the same file in two tenants is held by both');
  assert.equal(drive.leftBytes, 5000, 'bytes are the file, not its record');
  assert.equal(holdings.groups.find((g) => g.workload === 'sharepoint-sites'), undefined, 'a deleted list item is not held');
});

test('across tenants, ids inside references and keys never count as differences', () => {
  const row = (key, type, payload, references = []) => ({ natural_key: key, resource_type: type, payload, payload_hash: key, hash_version: 2, blast_radius: 'tenant-lockout', references });
  const ca = (app) => row('conditionalAccessPolicy:KEEL-RT-App', 'conditionalAccessPolicy',
    { displayName: 'KEEL-RT-App', conditions: { applications: { includeApplications: [app] } } },
    [{ field_path: 'conditions.applications.includeApplications[0]', to_symbol: `servicePrincipal:${app}` }]);
  const office = 'global:Office365';
  const result = compareSettings(
    { rows: [ca(guid(201)), row(`application:${guid(301)}`, 'application', { displayName: 'KEEL-RT-Own' }), row('user:a@one.example', 'user', { displayName: 'A' }),
      row('conditionalAccessPolicy:KEEL-RT-Global', 'conditionalAccessPolicy', { displayName: 'KEEL-RT-Global', x: guid(400) }, [{ field_path: 'x', to_symbol: office }])], coverage: null },
    { rows: [ca(guid(202)), row(`application:${guid(302)}`, 'application', { displayName: 'KEEL-RT-Own' }), row('user:a@two.example', 'user', { displayName: 'A' }),
      row('conditionalAccessPolicy:KEEL-RT-Global', 'conditionalAccessPolicy', { displayName: 'KEEL-RT-Global', x: guid(401) }, [{ field_path: 'x', to_symbol: 'global:Teams' }])], coverage: null },
    { portable: true },
  );
  const items = Object.fromEntries(result.groups.flatMap((g) => g.items.map((item) => [item.naturalKey, item])));
  assert.equal(items['conditionalAccessPolicy:KEEL-RT-App'], undefined, 'the same app named by two tenant ids is the same');
  assert.equal(items['conditionalAccessPolicy:KEEL-RT-Global'].changeType, 'changed', 'two different global apps still differ');
  assert.equal(result.totals.added + result.totals.removed, 0, 'an id-keyed object on one side is not added or removed');
  assert.deepEqual(result.unmatched.map((entry) => [entry.resourceType, entry.left, entry.right]).sort(), [['application', 1, 1], ['user', 1, 1]]);
  const sites = compareWorkloads(
    new Map([['sharepoint-site-settings', { collectionId: 'a', outcome: 'complete', at: T1, observations: [{ resourceKey: `site:${guid(500)}`, fields: {}, fieldCoverage: {} }] }]]),
    new Map([['sharepoint-site-settings', { collectionId: 'b', outcome: 'complete', at: T1, observations: [{ resourceKey: `site:${guid(501)}`, fields: {}, fieldCoverage: {} }] }]]),
    { portable: true },
  );
  assert.equal(sites.groups[0].unmatched, 2);
  assert.equal(sites.totals.added + sites.totals.removed, 0);
});

test('issue #296: an unscheduled automatic reply\'s moving schedule is not a change; a scheduled one is', () => {
  const replies = (hour, status) => ({ status, externalAudience: 'none',
    scheduledStartDateTime: { dateTime: `2026-10-15T${hour}:00:00.0000000`, timeZone: 'UTC' },
    scheduledEndDateTime: { dateTime: `2026-10-16T${hour}:00:00.0000000`, timeZone: 'UTC' } });
  const side = (id, hour, statuses) => new Map([['exchange-mailbox-settings', { collectionId: id, outcome: 'complete', at: T1, observations: statuses.map((status, i) => ({
    resourceKey: `mailbox:keel-rt-${i}@contoso.example`, fields: { identity: guid(60 + i), mailboxSettings: { automaticRepliesSetting: replies(hour, status) } }, fieldCoverage: {},
  })) }]]);
  const statuses = ['disabled', 'alwaysEnabled', 'scheduled'];
  const [mailbox] = compareWorkloads(side('a', '02', statuses), side('b', '10', statuses)).groups;
  assert.equal(mailbox.unchanged, 2);
  assert.deepEqual(mailbox.items.map((item) => [item.resourceKey, item.fields.map((field) => field.path)]), [
    ['mailbox:keel-rt-2@contoso.example', ['mailboxSettings.automaticRepliesSetting']],
  ]);
});

test('an added or removed Intune script never shows its text, in Compare or Activity', () => {
  for (const [resourceType, bodyFields] of Object.entries(SCRIPT_BODY_FIELDS)) {
    const secrets = bodyFields.map((field) => `$password = 'KEEL-RT-${resourceType}-${field}'`);
    const payload = { id: guid(9), displayName: `KEEL-RT-${resourceType}`, ...Object.fromEntries(bodyFields.map((field, i) => [field, Buffer.from(secrets[i]).toString('base64')])) };
    const leaks = (value) => {
      const text = JSON.stringify(value);
      return secrets.some((secret) => text.includes(secret) || text.includes(Buffer.from(secret).toString('base64')) || text.includes('KEEL-RT-' + resourceType + '-'));
    };
    const assertHidden = (fields, side, where) => {
      for (const field of bodyFields) {
        const shown = fields.find((entry) => entry.path === field);
        assert.ok(shown, `${where}: ${resourceType}.${field} is still listed`);
        assert.match(shown[side], /^Script text hidden \(\d+ characters, fingerprint [0-9a-f]{12}\)$/, `${where}: ${resourceType}.${field}`);
      }
    };

    // Activity (portal/lib/activity-changes.ts) calls presenceFields directly.
    for (const changeType of ['added', 'removed']) {
      const result = presenceFields(resourceType, payload, changeType);
      assert.ok(!leaks(result), `presenceFields ${changeType} ${resourceType} leaks script text`);
      assertHidden(result.fields, changeType === 'added' ? 'after' : 'before', `presenceFields ${changeType}`);
    }

    // Compare, in one tenant and across two (portable).
    const row = { natural_key: `${resourceType}:KEEL-RT`, resource_type: resourceType, payload, payload_hash: 'h', hash_version: 2, blast_radius: null, references: [] };
    for (const portable of [false, true]) {
      const added = compareSettings({ rows: [], coverage: null }, { rows: [row], coverage: null }, { portable });
      const removed = compareSettings({ rows: [row], coverage: null }, { rows: [], coverage: null }, { portable });
      for (const [result, changeType] of [[added, 'added'], [removed, 'removed']]) {
        assert.ok(!leaks(result), `compareSettings ${changeType} ${resourceType} (portable ${portable}) leaks script text`);
        if (portable && result.groups.length === 0) {
          // Script ids are tenant-bound: across tenants the script is only counted as unmatched.
          assert.equal(result.unmatched[0]?.resourceType, resourceType);
          continue;
        }
        const item = result.groups[0].items[0];
        assert.equal(item.changeType, changeType);
        assertHidden(item.fields, changeType === 'added' ? 'after' : 'before', `compareSettings ${changeType} portable=${portable}`);
      }
    }
  }
});

test('a settings catalog item carries its template family, so lists can file it under Defender', () => {
  const policy = (name, family, extra = {}) => ({
    natural_key: `configurationPolicy:${name}`, resource_type: 'configurationPolicy', payload_hash: name, hash_version: 2, blast_radius: null, references: [],
    payload: { name, platforms: 'windows10', technologies: 'mdm', ...(family ? { templateReference: { templateFamily: family } } : {}), ...extra },
  });
  const left = [policy('KEEL-RT-AV', 'endpointSecurityAntivirus'), policy('KEEL-RT-Old', null)];
  const right = [policy('KEEL-RT-AV', 'endpointSecurityAntivirus', { description: 'now' }), policy('KEEL-RT-FW', 'endpointSecurityFirewall')];
  for (const portable of [false, true]) {
    const result = compareSettings({ rows: left, coverage: null }, { rows: right, coverage: null }, { portable });
    const items = Object.fromEntries(result.groups[0].items.map((item) => [item.name, item]));
    assert.equal(items['KEEL-RT-AV'].changeType, 'changed');
    assert.equal(items['KEEL-RT-AV'].templateFamily, 'endpointSecurityAntivirus');
    assert.equal(items['KEEL-RT-FW'].templateFamily, 'endpointSecurityFirewall');
    assert.equal(items['KEEL-RT-Old'].changeType, 'removed');
    assert.equal('templateFamily' in items['KEEL-RT-Old'], false, 'a policy with no template family carries none');
  }
});
