// Gap 5 (site permissions audit, 2026-10-15): restore SharePoint site app grants.
//
// Acceptance:
//  - a missing grant is re-created and a narrowed one raised, both to the backup's role;
//  - nothing is ever granted beyond the backup: a wider, extra or unclear grant is manual;
//  - granting an app access needs the separate content-effect approval;
//  - an unqualified write does zero requests;
//  - a second run writes nothing.
//
// Everything runs against the isolated test database and an in-memory fake Graph.
// No tenant is read or written.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { recordSharePointRun } from '../collect/workloads/sharepoint.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { loadSharePointSource } from '../restore/workloads/sharepoint.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import {
  SITE_GRANTS_RESTORE, SITE_GRANT_ADD, SITE_GRANT_UPDATE, SITE_GRANT_WRITE_OPERATIONS, createSiteGrantsRestoreArtifact,
  executeSiteGrantsRestore, planSiteGrantsRestore, readLiveSiteGrants, siteGrantsPlanDigest, withinBackup,
} from '../restore/workloads/sharepointSiteGrants.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const HOST = 'contoso.sharepoint.com';
const NOW = new Date('2026-10-15T12:00:00Z');
const SITE = 'contoso.sharepoint.com,00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101';
const PERMISSIONS_URL = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(SITE)}/permissions`;
const APP_A = { id: '0000000a-0000-4000-8000-00000000000a', displayName: 'KEEL-RT-app-a' };
const APP_B = { id: '0000000b-0000-4000-8000-00000000000b', displayName: 'KEEL-RT-app-b' };
const APP_C = { id: '0000000c-0000-4000-8000-00000000000c', displayName: 'KEEL-RT-app-c' };
const APP_D = { id: '0000000d-0000-4000-8000-00000000000d', displayName: 'KEEL-RT-app-d' };

/** A grant as Graph returns it. */
const graphGrant = (id, roles, ...apps) => ({ id, roles, grantedToIdentitiesV2: apps.map((application) => ({ application })) });
/** A grant as the collector stores it. */
const stored = (id, roles, ...apps) => ({ id, roles: [...roles].sort(), applications: apps.map(({ id: appId, displayName }) => ({ id: appId, displayName })) });

// The backup: A write, B write, C read, D write.
const BACKUP = [
  stored('grant-a', ['write'], APP_A),
  stored('grant-b', ['write'], APP_B),
  stored('grant-c', ['read'], APP_C),
  stored('grant-d', ['write'], APP_D),
];
// Now: A gone, B narrowed to read, C widened to write, D unchanged, and an extra grant for app E.
const APP_E = { id: '0000000e-0000-4000-8000-00000000000e', displayName: 'KEEL-RT-app-e' };
const LIVE = [
  graphGrant('grant-b', ['read'], APP_B),
  graphGrant('grant-c', ['write'], APP_C),
  graphGrant('grant-d', ['write'], APP_D),
  graphGrant('grant-e', ['read'], APP_E),
];

let tenantSeq = 0;
const nextTenant = () => `sha256:site-grants-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role) {
  const email = `${label.replace(/[^a-z0-9-]/gi, '')}-${principalSeq += 1}@example.test`;
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

async function recordSource(client, tenantRef, { grants = BACKUP, status = 'observed', webUrl = null } = {}) {
  const run = await recordSharePointRun(client, {
    tenantRef,
    result: {
      workload: 'sharepoint-site-settings', tenantHost: HOST, outcome: 'complete',
      observedFrom: '2026-10-14T02:00:00Z', observedTo: '2026-10-14T02:01:00Z',
      tenant: { fields: {}, fieldCoverage: {} },
      sites: [{
        siteId: SITE,
        fields: { displayName: 'KEEL-RT-site', ...(webUrl ? { webUrl } : {}), appPermissionGrants: status === 'observed' ? grants : undefined },
        fieldCoverage: {
          displayName: { status: 'observed', operation: 'sharepoint.site-properties' },
          ...(webUrl ? { webUrl: { status: 'observed', operation: 'sharepoint.site-properties' } } : {}),
          appPermissionGrants: { status, operation: 'sharepoint.site-permissions' },
        },
      }],
    },
  });
  return loadSharePointSource(client, { tenantRef, collectionId: run.id });
}

/** An in-memory /sites/{id}/permissions. `onWrite` can refuse a write. */
function fakeSite(initial, { onWrite } = {}) {
  const state = { grants: structuredClone(initial), next: 1 };
  const requests = [];
  async function transport(url, init) {
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body ?? null });
    if (method !== 'GET') {
      const refused = onWrite?.(method, init.body);
      if (refused) return refused;
    }
    if (url === PERMISSIONS_URL && method === 'GET') return { status: 200, headers: {}, body: { value: structuredClone(state.grants) } };
    if (url === PERMISSIONS_URL && method === 'POST') {
      const grant = { id: `new-${state.next += 1}`, roles: [...init.body.roles], grantedToIdentitiesV2: structuredClone(init.body.grantedToIdentities) };
      state.grants.push(grant);
      return { status: 201, headers: {}, body: structuredClone(grant) };
    }
    const match = url.startsWith(`${PERMISSIONS_URL}/`) ? state.grants.find((grant) => `${PERMISSIONS_URL}/${encodeURIComponent(grant.id)}` === url) : null;
    if (match && method === 'PATCH') {
      match.roles = [...init.body.roles];
      return { status: 200, headers: {}, body: structuredClone(match) };
    }
    return { status: 404, headers: {}, body: { error: { code: 'itemNotFound' } } };
  }
  return { state, requests, transport, writes: () => requests.filter((request) => request.method !== 'GET') };
}

const readLedger = (tenantRef) => ({ tenantRef, rows: [{ id: 'sharepoint.site-permissions', state: 'live-qualified', enabled: true }] });
const liveWrite = (operationId, tenantRef) => ({
  operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: '2026-10-14T00:00:00Z', version: 'v1.0',
  ok: true, readBackVerified: true, proofRef: 'sharepoint-site-grants-live-acceptance@sha256:x',
});
const qualify = (tenantRef, ids = SITE_GRANT_WRITE_OPERATIONS, capturedIn = tenantRef) => Object.fromEntries(SITE_GRANT_WRITE_OPERATIONS.map((id) => [id, workloadWriteQualification(id, {
  readLedger: readLedger(tenantRef), evidence: ids.includes(id) ? [liveWrite(id, capturedIn)] : [], tenantRef, now: NOW,
})]));

async function planned(client, tenantRef, graph, { source, testTenantRefs } = {}) {
  const recorded = source ?? await recordSource(client, tenantRef);
  const live = await readLiveSiteGrants({ transport: graph.transport, siteId: SITE });
  const plan = planSiteGrantsRestore({ source: recorded, live, tenantHost: HOST, siteId: SITE, tenantRef, ...(testTenantRefs ? { testTenantRefs } : {}) });
  const requestedBy = await principal(client, `${tenantRef}-requester`, 'restorer');
  const artifact = await createSiteGrantsRestoreArtifact(client, { tenantRef, plan, requestedBy });
  graph.requests.length = 0;
  return { plan, artifact, requestedBy, source: recorded };
}

async function approve(client, tenantRef, artifact, plan) {
  const approver = await principal(client, `${tenantRef}-approver`, 'approver');
  await approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'app access agreed with the site owner',
  });
}

// ------------------------------------------------------------------- the plan

test('the plan re-creates a missing grant and raises a narrowed one, never beyond the backup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const graph = fakeSite(LIVE);
  const { plan } = await planned(client, tenantRef, graph);

  assert.deepEqual(plan.operations.map((operation) => [operation.operationId, operation.application]), [
    [SITE_GRANT_ADD, 'KEEL-RT-app-a'],
    [SITE_GRANT_UPDATE, 'KEEL-RT-app-b'],
  ]);
  assert.deepEqual(plan.operations[0].body, { roles: ['write'], grantedToIdentities: [{ application: APP_A }] });
  assert.deepEqual(plan.operations[1].body, { roles: ['write'] });
  assert.equal(plan.operations[1].permissionId, 'grant-b');
  // D is unchanged; C is wider now and E is not in the backup: a person decides, KEEL never narrows or removes.
  assert.deepEqual(plan.manual.map((item) => item.application).sort(), ['KEEL-RT-app-c', 'KEEL-RT-app-e']);
  assert.match(plan.manual.find((item) => item.application === 'KEEL-RT-app-c').reason, /never narrows/);
  assert.match(plan.manual.find((item) => item.application === 'KEEL-RT-app-e').reason, /never removes/);
  // Both writes give an app access to content: each is a content effect.
  assert.deepEqual(plan.contentEffects.map((effect) => [effect.field, effect.effect, effect.after]), [
    ['roles', 'externally-sharing', ['write']], ['roles', 'externally-sharing', ['write']],
  ]);
  assert.equal(plan.refusals.length, 0);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.operations[0].body.grantedToIdentities[0].application));
  // A source from another tenant, or a site from another host, is refused.
  const source = await recordSource(client, tenantRef);
  assert.throws(() => planSiteGrantsRestore({ source, live: [], tenantHost: 'fabrikam.sharepoint.com', siteId: SITE, tenantRef }), /different SharePoint tenant/);
  assert.throws(() => planSiteGrantsRestore({ source, live: [], tenantHost: HOST, siteId: SITE.replace('contoso', 'fabrikam'), tenantRef }), /not on this SharePoint tenant/);
});

test('an unclear backup is never guessed at: unknown roles, no application and an unread field stay manual', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const odd = [stored('x', ['sp.full control'], APP_A), { id: 'y', roles: ['read'], applications: [] }, stored('z', ['owner'], APP_B)];
  const plan = planSiteGrantsRestore({ source: await recordSource(client, tenantRef, { grants: odd }), live: [], tenantHost: HOST, siteId: SITE, tenantRef });
  // `owner` is how Graph reads a full control grant back; it is written as fullcontrol.
  assert.deepEqual(plan.operations.map((operation) => operation.body.roles), [['fullcontrol']]);
  assert.equal(plan.manual.length, 2);
  const unread = planSiteGrantsRestore({ source: await recordSource(client, tenantRef, { status: 'denied' }), live: [], tenantHost: HOST, siteId: SITE, tenantRef });
  assert.equal(unread.operations.length, 0);
  assert.match(unread.manual[0].reason, /denied in the source/);
});

test('a write that names another app, adds an app or grants a wider role is never within the backup', () => {
  const backup = { id: 'grant-a', roles: ['read'], applications: [APP_A] };
  const add = { operationId: SITE_GRANT_ADD, backup, body: { roles: ['read'], grantedToIdentities: [{ application: APP_A }] } };
  assert.equal(withinBackup(add), true);
  assert.equal(withinBackup({ ...add, body: { ...add.body, roles: ['write'] } }), false);
  assert.equal(withinBackup({ ...add, body: { ...add.body, roles: ['read', 'write'] } }), false);
  assert.equal(withinBackup({ ...add, body: { ...add.body, grantedToIdentities: [{ application: APP_B }] } }), false);
  assert.equal(withinBackup({ ...add, body: { ...add.body, grantedToIdentities: [{ application: APP_A }, { application: APP_B }] } }), false);
  assert.equal(withinBackup({ ...add, body: { ...add.body, grantedToIdentities: [{ application: APP_A, user: { id: 'u' } }] } }), false);
  assert.equal(withinBackup({ ...add, body: { ...add.body, expirationDateTime: null } }), false);
  assert.equal(withinBackup({ operationId: SITE_GRANT_UPDATE, backup, body: { roles: ['read'] } }), true);
  assert.equal(withinBackup({ operationId: SITE_GRANT_UPDATE, backup, body: { roles: ['owner'] } }), false);
});

// ------------------------------------------------------------- qualification

test('an unqualified write sends nothing, even when only one of the two writes is off', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const graph = fakeSite(LIVE);
  const { artifact, plan } = await planned(client, tenantRef, graph);
  await approve(client, tenantRef, artifact, plan);
  for (const [name, qualifications] of Object.entries({
    none: {}, addOnly: qualify(tenantRef, [SITE_GRANT_ADD]), updateOnly: qualify(tenantRef, [SITE_GRANT_UPDATE]), otherTenant: qualify(tenantRef, SITE_GRANT_WRITE_OPERATIONS, 'sha256:other'),
  })) {
    const result = await executeSiteGrantsRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualifications });
    assert.equal(result.outcome, 'disabled', name);
    assert.equal(graph.requests.length, 0, `${name}: no request at all`);
  }
  for (const id of SITE_GRANT_WRITE_OPERATIONS) assert.equal(qualify(tenantRef)[id].enabled, true, id);
});

// ------------------------------------------------------------------ restore

test('a restore needs the content-effect approval, writes within the backup, verifies, and a second run writes nothing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const graph = fakeSite(LIVE);
  const { artifact, plan, source } = await planned(client, tenantRef, graph);

  const blocked = await executeSiteGrantsRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualifications: qualify(tenantRef) });
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.equal(graph.requests.length, 0);

  await approve(client, tenantRef, artifact, plan);
  const result = await executeSiteGrantsRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualifications: qualify(tenantRef) });
  assert.equal(result.outcome, 'verified', result.reasons.join('; '));
  assert.equal(result.writes, 2);
  assert.deepEqual(graph.requests.map((request) => request.method), ['GET', 'POST', 'PATCH', 'GET']);
  assert.deepEqual(graph.writes()[0].body, { roles: ['write'], grantedToIdentities: [{ application: APP_A }] });
  assert.equal(graph.writes()[1].url, `${PERMISSIONS_URL}/grant-b`);
  // C (wider) and E (extra) are untouched.
  assert.deepEqual(graph.state.grants.find((grant) => grant.id === 'grant-c').roles, ['write']);
  assert.ok(graph.state.grants.some((grant) => grant.id === 'grant-e'));

  // The same artifact again: the grants changed since its dry run, so nothing is written.
  graph.requests.length = 0;
  const again = await executeSiteGrantsRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualifications: qualify(tenantRef) });
  assert.equal(again.outcome, 'stale');
  assert.equal(graph.writes().length, 0);

  // A new dry run from the same backup plans nothing and writes nothing.
  const { artifact: second, plan: secondPlan } = await planned(client, tenantRef, graph, { source });
  assert.equal(secondPlan.operations.length, 0);
  const none = await executeSiteGrantsRestore(client, { tenantRef, artifactId: second.id, tenantHost: HOST, transport: graph.transport, qualifications: qualify(tenantRef) });
  assert.equal(none.outcome, 'no-change');
  assert.equal(graph.requests.length, 0);
});

test('a grant changed after the dry run, a tampered plan or a refused write stops the run', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();

  const graph = fakeSite(LIVE);
  const { artifact, plan } = await planned(client, tenantRef, graph);
  await approve(client, tenantRef, artifact, plan);
  graph.state.grants.push(graphGrant('grant-f', ['read'], APP_A));
  const stale = await executeSiteGrantsRestore(client, { tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: graph.transport, qualifications: qualify(tenantRef) });
  assert.equal(stale.outcome, 'stale');
  assert.equal(graph.writes().length, 0);

  // Widening the stored plan breaks its digest: refused before any request.
  const clean = fakeSite(LIVE);
  const { artifact: other, plan: otherPlan } = await planned(client, tenantRef, clean);
  await approve(client, tenantRef, other, otherPlan);
  await client.query(`UPDATE restore_dry_run SET workload_restore = jsonb_set(workload_restore, '{operations,0,body,roles}', '["fullcontrol"]') WHERE id = $1`, [other.id]);
  const tampered = await executeSiteGrantsRestore(client, { tenantRef, artifactId: other.id, tenantHost: HOST, transport: clean.transport, qualifications: qualify(tenantRef) });
  assert.equal(tampered.outcome, 'refused');
  assert.equal(clean.requests.length, 0);

  // A plan re-written to a wider role and another app, with its digest recomputed and
  // its approved content effects left alone, is not what the backup gives: refused.
  const forged = fakeSite(LIVE);
  const { artifact: fourth, plan: fourthPlan } = await planned(client, tenantRef, forged);
  await approve(client, tenantRef, fourth, fourthPlan);
  const edited = structuredClone(fourthPlan);
  Object.assign(edited.operations[0].backup, { roles: ['fullcontrol'], applications: [{ id: APP_E.id, displayName: null }] });
  Object.assign(edited.operations[0].body, { roles: ['fullcontrol'], grantedToIdentities: [{ application: { id: APP_E.id } }] });
  edited.digest = siteGrantsPlanDigest(edited);
  await client.query(`UPDATE restore_dry_run SET workload_restore = $2, digest = $3 WHERE id = $1`, [fourth.id, JSON.stringify(edited), edited.digest]);
  const forgedRun = await executeSiteGrantsRestore(client, { tenantRef, artifactId: fourth.id, tenantHost: HOST, transport: forged.transport, qualifications: qualify(tenantRef) });
  assert.equal(forgedRun.outcome, 'refused');
  assert.match(forgedRun.reasons[0], /not what the recorded backup gives/);
  assert.equal(forged.writes().length, 0);

  // A refused write is reported and nothing after it is sent.
  const locked = fakeSite(LIVE, { onWrite: () => ({ status: 403, headers: {}, body: { error: { code: 'accessDenied', message: 'Blocked by PreservationLock policy' } } }) });
  const { artifact: third, plan: thirdPlan } = await planned(client, tenantRef, locked);
  await approve(client, tenantRef, third, thirdPlan);
  const refused = await executeSiteGrantsRestore(client, { tenantRef, artifactId: third.id, tenantHost: HOST, transport: locked.transport, qualifications: qualify(tenantRef) });
  assert.equal(refused.outcome, 'refused');
  assert.equal(locked.writes().length, 1);
});

// ------------------------------------------------------- test tenant fixtures (#317)

test('on the test tenant only a KEEL-RT- site and KEEL-RT- applications are granted, at plan time and again before writing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const testTenantRefs = [tenantRef];
  const fixtureSite = 'https://contoso.sharepoint.com/sites/KEEL-RT-site';

  // A fixture site and fixture apps: planned as usual.
  const fixtures = await planned(client, tenantRef, fakeSite(LIVE), { source: await recordSource(client, tenantRef, { webUrl: fixtureSite }), testTenantRefs });
  assert.equal(fixtures.plan.operations.length, 2);
  assert.deepEqual(fixtures.plan.refusals, []);

  // A real application on a fixture site is refused; the fixture app beside it is planned.
  const payroll = { ...APP_A, displayName: 'Contoso payroll' };
  const grants = [stored('grant-a', ['write'], payroll), ...BACKUP.slice(1)];
  const mixed = await planned(client, tenantRef, fakeSite(LIVE), { source: await recordSource(client, tenantRef, { grants, webUrl: fixtureSite }), testTenantRefs });
  assert.deepEqual(mixed.plan.operations.map((operation) => operation.application), ['KEEL-RT-app-b']);
  assert.equal(mixed.plan.refusals.length, 1);
  assert.match(mixed.plan.refusals[0].reason, /^not-a-fixture: .*Contoso payroll/);
  assert.equal(mixed.artifact.status, 'refused');

  // A real site is refused whatever the applications are called; so is a site with no name.
  const finance = await recordSource(client, tenantRef, { webUrl: 'https://contoso.sharepoint.com/sites/Finance' });
  const real = await planned(client, tenantRef, fakeSite(LIVE), { source: finance, testTenantRefs });
  assert.deepEqual(real.plan.operations, []);
  assert.ok(real.plan.refusals.length === 2 && real.plan.refusals.every((refusal) => /the site \(Finance\)/.test(refusal.reason)));
  const unnamed = await planned(client, tenantRef, fakeSite(LIVE), { testTenantRefs });
  assert.ok(unnamed.plan.refusals.every((refusal) => /no name/.test(refusal.reason)));

  // A plan made where the guard did not apply is checked again before writing: nothing is sent.
  const graph = fakeSite(LIVE);
  const older = await planned(client, tenantRef, graph, { source: finance, testTenantRefs: [] });
  assert.equal(older.plan.operations.length, 2);
  await approve(client, tenantRef, older.artifact, older.plan);
  const result = await executeSiteGrantsRestore(client, {
    tenantRef, artifactId: older.artifact.id, tenantHost: HOST, transport: graph.transport, qualifications: qualify(tenantRef), testTenantRefs,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(graph.writes().length, 0);
});

test('the restore CLI table plans one site from --site with the collector and promotes with both writes', () => {
  const entry = WORKLOAD_RESTORES[SITE_GRANTS_RESTORE];
  assert.deepEqual([...entry.operations], [SITE_GRANT_ADD, SITE_GRANT_UPDATE]);
  assert.match(entry.usage, /--site <site id>/);
});
