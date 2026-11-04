/**
 * Issue #964: the owner review classifies each group, team and app from the
 * newest complete backup's owner edges and users, on an isolated database.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { classifyNamedOwners, classifyOwners, enterpriseAppScope, loadOwnerDirectory, ownerReview } from './ownerReview.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:owners';
const OTHER = 'sha256:other';
const MICROSOFT = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
const id = (n) => `0e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const USERS = {
  active: id(1), disabled: id(2), guest: id(3), missing: id(4),
};
const GROUPS = {
  none: id(11), onlyDisabled: id(12), healthy: id(13), failed: id(14), gone: id(15), security: id(16), team: id(17), notRead: id(18), partial: id(19),
};
const APPS = { guest: id(21), failed: id(22) };
const APP_IDS = { guest: id(31), failed: id(32), microsoft: id(33), unknown: id(34) };
const SPS = { own: id(41), microsoft: id(42), unknown: id(43), managed: id(44) };

async function resource(client, snapshotId, type, payload) {
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: `${type}:${payload.displayName}`, resourceType: type, payload,
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'read-only', provenance: {},
    },
  });
}

async function edgeSet(client, snapshotId, tenantRef, { parentType, parentId, family, outcome = 'complete', targets = [], httpStatus = 200, error = null }) {
  const { rows } = await client.query(
    `INSERT INTO relationship_edge_set
       (snapshot_id, tenant_ref, parent_type, parent_source_id, family, edge_type, direction, outcome, item_count, pages_completed, completed_at, http_status, graph_code, error)
     VALUES ($1,$2,$3,$4,$5,'owner','direct',$6,$7,1,now(),$8,$9,$10) RETURNING id`,
    [snapshotId, tenantRef, parentType, parentId, family, outcome, targets.length, httpStatus, httpStatus >= 400 ? 'Authorization_RequestDenied' : null, error],
  );
  for (const target of targets) {
    await client.query(
      `INSERT INTO relationship_edge (set_id, tenant_ref, edge_key, target_source_id, target_type) VALUES ($1,$2,$3,$3,$4)`,
      [rows[0].id, tenantRef, target.id ?? target, target.type ?? 'user'],
    );
  }
}

async function seed(client) {
  await client.query(schemaSql());

  // An older complete backup says the healthy group had no owner: the newest must win.
  const older = await createSnapshot(client, { tenantRef: TENANT });
  await resource(client, older, 'group', { id: GROUPS.healthy, displayName: 'Sales', groupTypes: ['Unified'] });
  await edgeSet(client, older, TENANT, { parentType: 'group', parentId: GROUPS.healthy, family: 'owner', outcome: 'complete-empty' });
  await completeSnapshot(client, { id: older, status: 'complete', coverageDigest: {} });
  await client.query(`UPDATE snapshot SET started_at = now() - interval '2 days' WHERE id = $1`, [older]);

  const snap = await createSnapshot(client, { tenantRef: TENANT });
  await resource(client, snap, 'user', { id: USERS.active, displayName: 'Ana Active', userPrincipalName: 'ana@contoso.test', accountEnabled: true, userType: 'Member' });
  await resource(client, snap, 'user', { id: USERS.disabled, displayName: 'Dan Disabled', userPrincipalName: 'dan@contoso.test', accountEnabled: false, userType: 'Member' });
  await resource(client, snap, 'user', { id: USERS.guest, displayName: 'Gail Guest', userPrincipalName: 'gail_fabrikam.test#EXT#@contoso.test', accountEnabled: true, userType: 'Guest' });

  const unified = (key, name) => resource(client, snap, 'group', { id: GROUPS[key], displayName: name, groupTypes: ['Unified'] });
  await unified('none', 'Nobody owns me');
  await unified('onlyDisabled', 'Disabled only');
  await unified('healthy', 'Sales');
  await unified('failed', 'Read failed');
  await unified('gone', 'Owner left');
  await unified('team', 'Project team');
  await unified('notRead', 'Never read');
  await unified('partial', 'Half read');
  await resource(client, snap, 'group', { id: GROUPS.security, displayName: 'Security only', groupTypes: [] });

  const owner = (parentId, rest) => edgeSet(client, snap, TENANT, { parentType: 'group', parentId, family: 'owner', ...rest });
  await owner(GROUPS.none, { outcome: 'complete-empty' });
  await owner(GROUPS.onlyDisabled, { targets: [USERS.disabled] });
  await owner(GROUPS.healthy, { targets: [USERS.active, USERS.disabled] });
  await owner(GROUPS.failed, { outcome: 'failed', httpStatus: 403, error: 'Insufficient privileges' });
  await owner(GROUPS.gone, { targets: [USERS.missing] });
  await owner(GROUPS.team, { targets: [USERS.active] });
  await owner(GROUPS.partial, { outcome: 'partial', targets: [USERS.disabled], error: 'pagination incomplete' });
  await owner(GROUPS.security, { outcome: 'complete-empty' });

  await resource(client, snap, 'application', { id: APPS.guest, appId: APP_IDS.guest, displayName: 'Payroll connector' });
  await resource(client, snap, 'application', { id: APPS.failed, appId: APP_IDS.failed, displayName: 'HR sync' });
  await edgeSet(client, snap, TENANT, { parentType: 'application', parentId: APPS.guest, family: 'appOwner', targets: [USERS.guest] });
  await edgeSet(client, snap, TENANT, { parentType: 'application', parentId: APPS.failed, family: 'appOwner', outcome: 'failed', httpStatus: 403, error: 'Authorization_RequestDenied' });

  await resource(client, snap, 'servicePrincipal', { id: SPS.own, appId: APP_IDS.guest, displayName: 'Payroll connector', servicePrincipalType: 'Application' });
  await resource(client, snap, 'servicePrincipal', { id: SPS.microsoft, appId: APP_IDS.microsoft, displayName: 'Office 365 Exchange Online', servicePrincipalType: 'Application', appOwnerOrganizationId: MICROSOFT });
  await resource(client, snap, 'servicePrincipal', { id: SPS.unknown, appId: APP_IDS.unknown, displayName: 'Someone else', servicePrincipalType: 'Application' });
  await resource(client, snap, 'servicePrincipal', { id: SPS.managed, appId: id(35), displayName: 'vm-identity', servicePrincipalType: 'ManagedIdentity' });
  const sp = (parentId, rest) => edgeSet(client, snap, TENANT, { parentType: 'servicePrincipal', parentId, family: 'servicePrincipalOwner', ...rest });
  await sp(SPS.own, { targets: [USERS.active] });
  await sp(SPS.microsoft, { outcome: 'complete-empty' });
  await sp(SPS.unknown, { outcome: 'complete-empty' });
  await sp(SPS.managed, { outcome: 'complete-empty' });

  await completeSnapshot(client, { id: snap, status: 'complete', coverageDigest: { user: { outcome: 'complete' } } });

  // A newer backup that never finished is ignored.
  const running = await createSnapshot(client, { tenantRef: TENANT });
  await resource(client, running, 'group', { id: GROUPS.none, displayName: 'Nobody owns me', groupTypes: ['Unified'] });
  await edgeSet(client, running, TENANT, { parentType: 'group', parentId: GROUPS.none, family: 'owner', targets: [USERS.active] });

  // The team list from the Teams settings read.
  const { rows: [run] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to) VALUES ($1, 'teams-settings', 'complete', now(), now()) RETURNING id`,
    [TENANT],
  );
  await client.query(`INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)`, [run.id, `team:${GROUPS.team}`]);

  // Another tenant's ownerless group never shows.
  const other = await createSnapshot(client, { tenantRef: OTHER });
  await resource(client, other, 'group', { id: id(99), displayName: 'Other tenant', groupTypes: ['Unified'] });
  await edgeSet(client, other, OTHER, { parentType: 'group', parentId: id(99), family: 'owner', outcome: 'complete-empty' });
  await completeSnapshot(client, { id: other, status: 'complete', coverageDigest: {} });
}

test('each group, team and app is classified from the newest complete backup', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await seed(client);

  const review = await ownerReview(client, { tenantRef: TENANT, now: new Date('2026-11-04T07:00:00Z') });
  const byId = new Map(review.items.map((item) => [item.id, item]));
  const problem = (key) => byId.get(key)?.problem;

  assert.equal(problem(GROUPS.none), 'no-owner', 'a group with no owner');
  assert.equal(problem(GROUPS.onlyDisabled), 'only-disabled', 'a group whose only owner is disabled');
  assert.equal(problem(APPS.guest), 'guest-owner', 'an app with a guest owner');
  assert.equal(problem(GROUPS.healthy), 'fine', 'a healthy group (and the newest backup wins over the older one)');
  assert.equal(problem(GROUPS.failed), 'read-failed', 'a failed owner read is never "no owner"');
  assert.equal(problem(APPS.failed), 'read-failed', 'a refused app owner read is never "no owner"');
  assert.equal(problem(GROUPS.gone), 'no-owner', 'a group whose only owner no longer exists');
  assert.equal(problem(GROUPS.partial), 'read-failed', 'a partial read with no working owner is not "only disabled"');
  assert.equal(problem(GROUPS.notRead), 'not-read', 'a group the backup holds but whose owners were not read');
  assert.equal(problem(SPS.own), 'fine', "the tenant's own enterprise app is reviewed");

  assert.equal(byId.get(GROUPS.team).kind, 'team');
  assert.equal(byId.get(GROUPS.none).kind, 'group');
  assert.equal(byId.get(GROUPS.healthy).counts.disabled, 1);
  assert.equal(byId.get(GROUPS.gone).counts.gone, 1);
  assert.deepEqual(byId.get(APPS.guest).owners, [{ id: USERS.guest, name: 'Gail Guest', state: 'guest' }]);
  assert.deepEqual(byId.get(GROUPS.failed).readFailure, { outcome: 'failed', httpStatus: 403, graphCode: 'Authorization_RequestDenied', error: 'Insufficient privileges' });

  // Microsoft's own apps, apps of an unknown publisher, managed identities and
  // security groups are skipped; the other tenant never shows.
  for (const skipped of [SPS.microsoft, SPS.unknown, SPS.managed, GROUPS.security, id(99)]) assert.equal(byId.has(skipped), false, skipped);
  assert.deepEqual(review.skipped, { microsoft: 1, unknownPublisher: 1, otherType: 1 });

  assert.equal(review.reads.application.refused, 1);
  assert.equal(review.reads.application.permission, 'Application.Read.All');
  assert.equal(review.reads.group.refused, 1);
  assert.equal(review.reads.group.failed, 1, 'the partial read counts as failed');
  assert.equal(review.reads.group.notRead, 1);
  assert.equal(review.completeness, 'partial');
  assert.equal(review.directory.complete, true);
  assert.equal(review.directory.users, 3);
});

test('a missing owner is "unknown", not gone, when the user list was not read in full', () => {
  const directory = { complete: false, users: new Map() };
  const result = classifyOwners({ outcome: 'complete', targets: [{ id: USERS.missing, type: 'user' }] }, directory);
  assert.equal(result.owners[0].state, 'unknown');
  assert.equal(result.problem, 'fine');
  assert.equal(classifyOwners({ outcome: 'complete', targets: [{ id: USERS.missing, type: 'user' }] }, { ...directory, complete: true }).problem, 'no-owner');
});

test('an app that owns a group counts as a working owner', () => {
  const directory = { complete: true, users: new Map() };
  const apps = new Map([[SPS.own, 'Payroll connector']]);
  const result = classifyOwners({ outcome: 'complete', targets: [{ id: SPS.own, type: 'servicePrincipal' }] }, directory, apps);
  assert.deepEqual(result, { problem: 'fine', owners: [{ id: SPS.own, name: 'Payroll connector', state: 'app' }] });
});

test('enterprise app scope skips Microsoft first-party apps', () => {
  const own = new Set([APP_IDS.guest]);
  assert.equal(enterpriseAppScope({ appId: APP_IDS.microsoft, appOwnerOrganizationId: MICROSOFT, servicePrincipalType: 'Application' }, own), 'microsoft');
  assert.equal(enterpriseAppScope({ appId: APP_IDS.microsoft, appOwnerOrganizationId: '72F988BF-86F1-41AF-91AB-2D7CD011DB47' }, own), 'microsoft');
  assert.equal(enterpriseAppScope({ appId: APP_IDS.guest, servicePrincipalType: 'Application' }, own), 'review');
  assert.equal(enterpriseAppScope({ appId: APP_IDS.unknown, appOwnerOrganizationId: id(77) }, own), 'review');
  assert.equal(enterpriseAppScope({ appId: APP_IDS.unknown }, own), 'unknown-publisher');
  assert.equal(enterpriseAppScope({ appId: APP_IDS.unknown, servicePrincipalType: 'ManagedIdentity' }, own), 'other-type');
});

test('site owners known by name get the same disabled and guest check', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  const directory = await loadOwnerDirectory(client, { tenantRef: TENANT });
  assert.deepEqual(classifyNamedOwners({ names: ['Dan Disabled'], count: 1 }, directory), { problem: 'only-disabled', disabled: ['Dan Disabled'], guests: [], matched: 1 });
  assert.equal(classifyNamedOwners({ names: ['Gail Guest', 'Ana Active'], count: 2 }, directory).problem, 'guest-owner');
  assert.equal(classifyNamedOwners({ names: ['Ana Active'], count: 1 }, directory).problem, null);
  // An owner with no name might be anyone: never "only disabled".
  assert.equal(classifyNamedOwners({ names: ['Dan Disabled'], count: 2 }, directory).problem, null);
  // A name two users share is not matched.
  const twins = { complete: true, users: new Map([['a', { name: 'Sam', disabled: true, guest: false }], ['b', { name: 'Sam', disabled: false, guest: false }]]) };
  assert.equal(classifyNamedOwners({ names: ['Sam'], count: 1 }, twins).problem, null);
});
