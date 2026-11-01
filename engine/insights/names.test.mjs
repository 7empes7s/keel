import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { describeObject, holdsGuid, lookupNames, objectLabelText } from './names.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
after(async () => {
  await client?.end();
  await database.cleanup();
});

const TENANT = 'contoso';
const FINANCE_ID = '0f1a0000-0000-4000-8000-000000000001';
const OLD_TEAM_ID = '0f1a0000-0000-4000-8000-000000000002';
const POLICY_ID = 'ca000000-0000-4000-8000-000000000003';
const NEVER_ID = 'dead0000-0000-4000-8000-000000000009';
// Backups are dated relative to the run, so the test never rots.
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);

async function backup(tenantRef, startedAt, status, resources, coverage = null) {
  // Postgres keeps microseconds (production backups start at now()); JavaScript keeps
  // milliseconds. Every backup here has microseconds so a time that loses them on a
  // round trip through JavaScript fails these tests (lesson 2026-10-15).
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, status, coverage_digest) VALUES ($1, $2::timestamptz + interval '123 microseconds', $3, $4) RETURNING id, started_at",
    [tenantRef, startedAt, status, coverage],
  );
  for (const [key, type, payload] of resources) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, 'h', 'tier2', 'scoped', 'full', '{}')`,
      [snapshot.id, key, type, payload],
    );
  }
  return snapshot.started_at;
}

const finance = (name = 'Finance') => ['group:Finance', 'group', { id: FINANCE_ID, displayName: name }];
const oldTeam = ['group:Old project team', 'group', { id: OLD_TEAM_ID, displayName: 'Old project team' }];
const policy = [`conditionalAccessPolicy:${POLICY_ID}`, 'conditionalAccessPolicy', { id: POLICY_ID, displayName: 'Block legacy auth' }];

let goneAt;
before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  await backup(TENANT, daysAgo(5), 'complete', [finance('Finance (old name)'), oldTeam, policy]);
  goneAt = await backup(TENANT, daysAgo(3), 'complete', [finance(), policy]);
  // A failed backup that read no groups proves nothing about them.
  await backup(TENANT, daysAgo(2), 'failed', [policy]);
  await backup(TENANT, daysAgo(1), 'complete', [finance(), policy]);
  // Another tenant's backup never names this tenant's objects.
  await backup('fabrikam', daysAgo(1), 'complete', [['group:Secret', 'group', { id: NEVER_ID, displayName: 'Secret' }]]);
});

test('found: a key in the newest backup reads as its kind and newest name', async () => {
  const names = await lookupNames(client, { tenantRef: TENANT, ids: ['group:Finance'] });
  const object = names.get('group:Finance');
  assert.equal(object.status, 'found');
  assert.equal(object.typeName, 'Group');
  assert.equal(object.service, 'Entra');
  assert.equal(object.name, 'Finance');
  assert.equal(object.objectId, FINANCE_ID);
  assert.equal(object.deletedSince, null);
  assert.equal(objectLabelText(object), 'Group · Finance');
});

test('found: a bare object id and an id-keyed object read by name, never the id', async () => {
  const names = await lookupNames(client, { tenantRef: TENANT, ids: [FINANCE_ID.toUpperCase(), `conditionalAccessPolicy:${POLICY_ID}`] });
  const byId = names.get(FINANCE_ID.toUpperCase());
  assert.equal(byId.status, 'found');
  assert.equal(byId.name, 'Finance');
  assert.equal(byId.type, 'group');
  const keyed = names.get(`conditionalAccessPolicy:${POLICY_ID}`);
  assert.equal(keyed.name, 'Block legacy auth');
  assert.equal(keyed.typeName, 'Conditional Access policy');
  assert.equal(objectLabelText(keyed), 'Conditional Access policy · Block legacy auth');
});

test('deleted: gone from a later complete backup, with the date it went and its last name', async () => {
  const names = await lookupNames(client, { tenantRef: TENANT, ids: ['group:Old project team', OLD_TEAM_ID] });
  for (const id of ['group:Old project team', OLD_TEAM_ID]) {
    const object = names.get(id);
    assert.equal(object.status, 'deleted', id);
    assert.equal(object.name, 'Old project team');
    assert.equal(object.deletedSince, goneAt.toISOString());
    assert.equal(objectLabelText(object), `Group · Old project team (deleted since ${goneAt.toISOString().slice(0, 10)})`);
  }
});

test('unknown: no backup holds it; a readable key keeps its name, a bare id has none', async () => {
  const names = await lookupNames(client, { tenantRef: TENANT, ids: ['group:Never backed up', NEVER_ID, `group:${NEVER_ID}`, 'group:Secret'] });
  const readable = names.get('group:Never backed up');
  assert.equal(readable.status, 'unknown');
  assert.equal(readable.name, 'Never backed up');
  assert.equal(readable.typeName, 'Group');
  const bare = names.get(NEVER_ID);
  assert.equal(bare.status, 'unknown');
  assert.equal(bare.name, null);
  assert.equal(bare.typeName, 'Object');
  assert.equal(objectLabelText(bare), 'Object · unnamed');
  assert.equal(names.get(`group:${NEVER_ID}`).name, null, 'a key that holds an id never becomes a name');
  assert.equal(names.get('group:Secret').status, 'unknown', 'another tenant\'s backup is not read');
  for (const object of names.values()) assert.ok(!holdsGuid(objectLabelText(object)), objectLabelText(object));
});

test('a stored name that holds an id is skipped for an older readable one', async () => {
  const key = 'group:Renamed';
  const id = '0f1a0000-0000-4000-8000-0000000000aa';
  await backup('naming', daysAgo(4), 'complete', [[key, 'group', { id, displayName: 'Sales' }]]);
  await backup('naming', daysAgo(1), 'complete', [[key, 'group', { id, displayName: id }]]);
  const object = (await lookupNames(client, { tenantRef: 'naming', ids: [key] })).get(key);
  assert.equal(object.status, 'found');
  assert.equal(object.name, 'Sales');
});

test('renamed, not deleted: a key built from the old name follows the object to its new name', async () => {
  const id = '0f1a0000-0000-4000-8000-0000000000bb';
  await backup('renames', daysAgo(4), 'complete', [['group:Marketing', 'group', { id, displayName: 'Marketing' }]]);
  await backup('renames', daysAgo(1), 'complete', [['group:Brand team', 'group', { id, displayName: 'Brand team' }]]);
  const object = (await lookupNames(client, { tenantRef: 'renames', ids: ['group:Marketing'] })).get('group:Marketing');
  assert.equal(object.status, 'found');
  assert.equal(object.name, 'Brand team');
  assert.equal(object.deletedSince, null);
});

test('renamed, then deleted: the newer key is gone too, so it is deleted under its newest name', async () => {
  const id = '0f1a0000-0000-4000-8000-0000000000cc';
  await backup('renamed-gone', daysAgo(5), 'complete', [['group:M', 'group', { id, displayName: 'M' }], oldTeam]);
  await backup('renamed-gone', daysAgo(4), 'complete', [['group:N', 'group', { id, displayName: 'N' }], oldTeam]);
  const gone = await backup('renamed-gone', daysAgo(3), 'complete', [oldTeam]);
  const object = (await lookupNames(client, { tenantRef: 'renamed-gone', ids: ['group:M'] })).get('group:M');
  assert.equal(object.status, 'deleted');
  assert.equal(object.name, 'N');
  assert.equal(object.deletedSince, gone.toISOString());
});

test('deleted: the last object of its kind went, and the backup read that kind and found none', async () => {
  const id = '0f1a0000-0000-4000-8000-0000000000dd';
  const read = (group) => ({ group: { outcome: group }, conditionalAccessPolicy: { outcome: 'complete' } });
  await backup('last-of-kind', daysAgo(4), 'complete', [['group:Only group', 'group', { id, displayName: 'Only group' }], policy], read('complete'));
  const gone = await backup('last-of-kind', daysAgo(2), 'complete', [policy], read('complete-empty'));
  await backup('last-of-kind', daysAgo(1), 'complete', [policy], read('complete-empty'));
  const names = await lookupNames(client, { tenantRef: 'last-of-kind', ids: ['group:Only group', id] });
  for (const key of ['group:Only group', id]) {
    const object = names.get(key);
    assert.equal(object.status, 'deleted', key);
    assert.equal(object.name, 'Only group');
    assert.equal(object.deletedSince, gone.toISOString());
  }
});

test('renamed, then the last of its kind: deleted under its newest name', async () => {
  const id = '0f1a0000-0000-4000-8000-0000000000ee';
  const read = (group) => ({ group: { outcome: group }, conditionalAccessPolicy: { outcome: 'complete' } });
  await backup('renamed-last', daysAgo(5), 'complete', [['group:P', 'group', { id, displayName: 'P' }], policy], read('complete'));
  await backup('renamed-last', daysAgo(4), 'complete', [['group:Q', 'group', { id, displayName: 'Q' }], policy], read('complete'));
  const gone = await backup('renamed-last', daysAgo(3), 'complete', [policy], read('complete-empty'));
  const object = (await lookupNames(client, { tenantRef: 'renamed-last', ids: ['group:P'] })).get('group:P');
  assert.equal(object.status, 'deleted');
  assert.equal(object.name, 'Q');
  assert.equal(object.deletedSince, gone.toISOString());
});

test('found: a partial or not-requested read of its kind never marks it deleted, even with other rows of that kind', async () => {
  const id = '0f1a0000-0000-4000-8000-0000000000ff';
  const other = ['group:Someone else', 'group', { id: '0f1a0000-0000-4000-8000-000000000100', displayName: 'Someone else' }];
  await backup('partial-read', daysAgo(4), 'complete', [['group:Kept', 'group', { id, displayName: 'Kept' }], other], { group: { outcome: 'complete' } });
  await backup('partial-read', daysAgo(3), 'complete', [other], { group: { outcome: 'partial' } });
  await backup('partial-read', daysAgo(2), 'complete', [policy], { group: { outcome: 'not-requested' }, conditionalAccessPolicy: { outcome: 'complete' } });
  await backup('partial-read', daysAgo(1), 'complete', [other], { group: { outcome: 'failed' } });
  await backup('partial-read', daysAgo(0.5), 'complete', [other], { group: { outcome: 'unavailable' } });
  const object = (await lookupNames(client, { tenantRef: 'partial-read', ids: ['group:Kept'] })).get('group:Kept');
  assert.equal(object.status, 'found');
  assert.equal(object.deletedSince, null);
});

test('older backups that count rows per kind fall back to "it saved a row of that kind"', async () => {
  const id = '0f1a0000-0000-4000-8000-000000000101';
  const other = ['group:Stays', 'group', { id: '0f1a0000-0000-4000-8000-000000000102', displayName: 'Stays' }];
  await backup('legacy-counts', daysAgo(4), 'complete', [['group:Went', 'group', { id, displayName: 'Went' }], other], { group: 2 });
  const gone = await backup('legacy-counts', daysAgo(2), 'complete', [other], { group: 1 });
  const object = (await lookupNames(client, { tenantRef: 'legacy-counts', ids: ['group:Went'] })).get('group:Went');
  assert.equal(object.status, 'deleted');
  assert.equal(object.deletedSince, gone.toISOString());
});

test('an empty batch reads nothing', async () => {
  const calls = [];
  const names = await lookupNames({ query: async (...args) => { calls.push(args); return { rows: [] }; } }, { tenantRef: TENANT, ids: [null, '', undefined] });
  assert.equal(names.size, 0);
  assert.equal(calls.length, 0);
});

test('describeObject never shows an id as a name', () => {
  assert.equal(describeObject('user:5e170000-0000-4000-8000-000000000001', { status: 'unknown' }).name, null);
  assert.equal(describeObject('x', { status: 'found', name: 'Group 5e170000-0000-4000-8000-000000000001' }).name, null);
  assert.equal(describeObject('someNewType:Thing', { status: 'unknown' }).typeName, 'Some new type');
});

// Backlog B11: a lookup by object id or app id read the payload of every saved version
// (more than 9 minutes on live, operator queue Q303). It now reads the expression
// indexes in store/schema.d/91 and still finds an app by its app id, in any case.
test('an app is found by its app id, and a bare id is looked up through the indexes', async () => {
  const APP_ID = 'a9900000-0000-4000-8000-0000000000aa';
  const SP_ID = 'a9900000-0000-4000-8000-0000000000bb';
  await backup(TENANT, daysAgo(1), 'complete', [[`servicePrincipal:${SP_ID}`, 'servicePrincipal', { id: SP_ID, appId: APP_ID, displayName: 'Payroll' }]]);
  const names = await lookupNames(client, { tenantRef: TENANT, ids: [APP_ID.toUpperCase()] });
  assert.equal(names.get(APP_ID.toUpperCase()).name, 'Payroll');
  assert.equal(names.get(APP_ID.toUpperCase()).status, 'found');

  const plans = [];
  const explaining = {
    async query(text, values) {
      await client.query('SET enable_seqscan = off');
      try {
        const { rows } = await client.query(`EXPLAIN ${text}`, values);
        plans.push(rows.map((row) => row['QUERY PLAN']).join('\n'));
      } finally {
        await client.query('RESET enable_seqscan');
      }
      return { rows: [] };
    },
  };
  await lookupNames(explaining, { tenantRef: TENANT, ids: [SP_ID] });
  assert.match(plans[0], /resource_version_object_id_snapshot_idx/);
  assert.match(plans[0], /resource_version_app_id_snapshot_idx/);
  assert.doesNotMatch(plans[0], /Seq Scan on resource_version/);
});
