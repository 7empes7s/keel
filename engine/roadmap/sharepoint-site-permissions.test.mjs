// Gap 4 (site permissions audit, 2026-10-15): restore SharePoint groups, members,
// site collection admins, permission levels and role assignments from the content backup.
//
// Acceptance:
//  - a missing custom permission level, group, member, admin or role assignment is added
//    back exactly as the backup held it;
//  - nothing beyond the backup is ever written: anything wider, extra or changed is listed
//    as manual and left in place, and SharePoint's own sharing-link groups are left out;
//  - giving someone access needs the separate content-effect approval;
//  - an unqualified write sends no request at all;
//  - a changed site, a tampered or forged plan stops the run before any write;
//  - a second run writes nothing;
//  - on the test tenant only a KEEL-RT- site is planned;
//  - the Restorer's transport sends only the allow-listed writes.
//
// Everything runs against the isolated test database, an in-memory content store and an
// in-memory fake SharePoint REST API. No tenant is read or written.
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { SITES_WORKLOAD, canonicalJson } from '../content/sharepointSites.mjs';
import { createMemoryContentStore } from '../content/store.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { assertSitePermissionsRequest, sitePermissionsWriteTransport } from '../restore/workloads/sharepointRest.mjs';
import {
  GROUP_ADD, GROUP_MEMBER_ADD, ROLE_ASSIGNMENT_ADD, ROLE_DEFINITION_ADD, SITE_ADMIN_ADD, SITE_PERMISSIONS_ITEM, SITE_PERMISSIONS_RESTORE,
  SITE_PERMISSION_WRITE_OPERATIONS, createSitePermissionsRestoreArtifact, executeSitePermissionsRestore, loadSitePermissionsSource,
  planSitePermissionsRestore, readLiveSitePermissions, sitePermissionsPlanDigest, withinBackup,
} from '../restore/workloads/sharepointSitePermissions.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import {
  API, HOST, LIST, SITE, WEB_URL, backupState, fakeSharePoint, liveState, login,
} from '../test/fakeSharePointRest.mjs';
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

const NOW = new Date('2026-10-15T12:00:00Z');
const TEST_TENANT = 'sha256:site-permissions-test-tenant';

/** Stores the backup state as the content backup does and returns it as a restore source. */
async function backedUp(tenantRef, state = backupState(), { store = createMemoryContentStore() } = {}) {
  const site = fakeSharePoint(state);
  const value = await readLiveSitePermissions({ transport: site.transport, tenantHost: HOST, webUrl: WEB_URL });
  await store.putItem(Readable.from([Buffer.from(canonicalJson(value))]), {
    tenantRef, workload: SITES_WORKLOAD, container: `site:${SITE}`, itemKey: SITE_PERMISSIONS_ITEM, metadata: { contentType: 'application/json' },
  });
  const source = await loadSitePermissionsSource({ store, tenantRef, siteId: SITE });
  return { store, source };
}

let tenantSeq = 0;
const nextTenant = () => `sha256:site-permissions-${tenantSeq += 1}`;
let principalSeq = 0;
async function principal(client, label, role) {
  const email = `${label.replace(/[^a-z0-9-]/gi, '')}-${principalSeq += 1}@example.test`;
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

const readLedger = (tenantRef) => ({ tenantRef, rows: [{ id: 'sharepoint.site-permissions', state: 'live-qualified', enabled: true }] });
const liveWrite = (operationId, tenantRef) => ({
  operationId, kind: 'live-write-capture', synthetic: false, tenantRef, capturedAt: '2026-10-14T00:00:00Z', version: 'sharepoint-rest',
  ok: true, readBackVerified: true, proofRef: 'sharepoint-site-permissions-live-acceptance@sha256:x',
});
const qualify = (tenantRef, ids = SITE_PERMISSION_WRITE_OPERATIONS, capturedIn = tenantRef) => Object.fromEntries(SITE_PERMISSION_WRITE_OPERATIONS.map((id) => [id, workloadWriteQualification(id, {
  readLedger: readLedger(tenantRef), evidence: ids.includes(id) ? [liveWrite(id, capturedIn)] : [], tenantRef, now: NOW,
})]));

async function planned(client, tenantRef, site, { backup } = {}) {
  const { store, source } = backup ?? await backedUp(tenantRef);
  const live = await readLiveSitePermissions({ transport: site.transport, tenantHost: HOST, webUrl: WEB_URL });
  const plan = planSitePermissionsRestore({ source, live, tenantHost: HOST, siteId: SITE, tenantRef, testTenantRefs: [] });
  const requestedBy = await principal(client, `${tenantRef}-requester`, 'restorer');
  const artifact = await createSitePermissionsRestoreArtifact(client, { tenantRef, plan, requestedBy });
  site.requests.length = 0;
  return { plan, artifact, store, source, backup: { store, source } };
}

async function approve(client, tenantRef, artifact, plan) {
  const approver = await principal(client, `${tenantRef}-approver`, 'approver');
  await approveContentEffects(client, {
    tenantRef, artifactId: artifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'site access agreed with the site owner',
  });
}

const run = (client, tenantRef, artifact, site, store, qualifications) => executeSitePermissionsRestore(client, {
  tenantRef, artifactId: artifact.id, tenantHost: HOST, transport: site.transport, store, qualifications, testTenantRefs: [],
});

// ------------------------------------------------------------------- the plan

test('the plan adds back what is missing, in order, and lists everything wider for a person', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const { plan } = await planned(client, tenantRef, fakeSharePoint(liveState()));

  assert.deepEqual(plan.operations.map((operation) => [operation.operationId, operation.subject]), [
    [ROLE_DEFINITION_ADD, 'permission level KEEL-RT Reviewer'],
    [GROUP_ADD, 'group KEEL-RT Members'.replace('Members', 'Reviewers')],
    [GROUP_MEMBER_ADD, 'carol in KEEL-RT Members'],
    [GROUP_MEMBER_ADD, 'dave in KEEL-RT Reviewers'],
    [SITE_ADMIN_ADD, 'site collection admin erin'],
    [ROLE_ASSIGNMENT_ADD, 'KEEL-RT Reviewer for KEEL-RT Reviewers on the site'],
    [ROLE_ASSIGNMENT_ADD, 'Read for frank on the site'],
    [ROLE_ASSIGNMENT_ADD, 'Edit for dave on list KEEL-RT Documents'],
  ]);
  assert.deepEqual(plan.operations[0].roleDefinition, {
    name: 'KEEL-RT Reviewer', description: 'Reads and comments', order: 200, basePermissions: { high: '176', low: '138612835' },
  });
  assert.equal(plan.operations[1].group.title, 'KEEL-RT Reviewers');
  assert.equal(plan.operations[1].group.onlyAllowMembersViewMembership, true);
  assert.deepEqual(plan.operations[7].principal, { kind: 'user', loginName: login('dave'), title: 'dave' });
  assert.equal(plan.operations[7].listId, LIST);

  // Wider or extra now: listed, never removed. The owner of a re-created group is a hand step.
  const manual = plan.manual.map((item) => `${item.subject}: ${item.reason}`);
  for (const expected of [
    /^mallory in KEEL-RT Members: .*never removes a member/,
    /^site collection admin zoe: .*never removes an admin/,
    /^Full Control for mallory on the site: wider than the backup/,
    /^group KEEL-RT Extra: .*never removes a group/,
    /^group KEEL-RT Reviewers: its owner was KEEL-RT Owners/,
  ]) assert.ok(manual.some((line) => expected.test(line)), `${expected} in ${manual.join(' | ')}`);
  assert.equal(plan.manual.length, 5);
  // SharePoint's sharing-link group and the Limited Access level are left alone.
  assert.deepEqual(plan.excluded.map((item) => item.subject), ['group SharingLinks.0000.OrganizationView.1111']);
  assert.ok(!plan.operations.some((operation) => /limited/i.test(operation.role ?? '')));

  // Members, admins and role assignments give access: each is a content effect; a new level or empty group is not.
  assert.equal(plan.contentEffects.length, 6);
  assert.ok(plan.contentEffects.every((effect) => effect.effect === 'externally-sharing' && effect.field === 'grantsAccess'));
  assert.equal(plan.refusals.length, 0);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.operations[0].roleDefinition.basePermissions));
});

test('the plan refuses another tenant, another site and a non KEEL-RT site on the test tenant', async () => {
  const { source } = await backedUp('sha256:x');
  const live = await readLiveSitePermissions({ transport: fakeSharePoint(liveState()).transport, tenantHost: HOST, webUrl: WEB_URL });
  assert.throws(() => planSitePermissionsRestore({ source, live, tenantHost: 'fabrikam.sharepoint.com', siteId: SITE.replace('contoso', 'fabrikam'), tenantRef: 'sha256:x', testTenantRefs: [] }), /different SharePoint tenant/);
  assert.throws(() => planSitePermissionsRestore({ source, live, tenantHost: HOST, siteId: SITE.replace('contoso', 'fabrikam'), tenantRef: 'sha256:x', testTenantRefs: [] }), /not on this SharePoint tenant/);
  assert.throws(() => planSitePermissionsRestore({ source: { ...source, siteId: `${HOST},a,b` }, live, tenantHost: HOST, siteId: SITE, tenantRef: 'sha256:x', testTenantRefs: [] }), /another site/);
  assert.throws(() => planSitePermissionsRestore({ source, live: { ...live, web: { ...live.web, url: `https://${HOST}/sites/HR` } }, tenantHost: HOST, siteId: SITE, tenantRef: 'sha256:x', testTenantRefs: [] }), /not the site in the backup/);
  // The same site is fine on the test tenant (KEEL-RT-); a site named otherwise is refused there.
  assert.ok(planSitePermissionsRestore({ source, live, tenantHost: HOST, siteId: SITE, tenantRef: TEST_TENANT, testTenantRefs: [TEST_TENANT] }));
  const hr = (value) => ({ ...value, web: { ...value.web, url: `https://${HOST}/sites/HR` } });
  assert.throws(() => planSitePermissionsRestore({
    source: { ...source, value: hr(source.value) }, live: hr(live), tenantHost: HOST, siteId: SITE, tenantRef: TEST_TENANT, testTenantRefs: [TEST_TENANT],
  }), /KEEL-RT- targets/);
});

test('inheritance is never changed and an unread backup is never guessed at', async () => {
  // The site inherits now but had its own permissions; the list inherits now too.
  const now = liveState();
  now.web.HasUniqueRoleAssignments = false;
  now.lists = [];
  const { source } = await backedUp('sha256:y');
  const live = await readLiveSitePermissions({ transport: fakeSharePoint(now).transport, tenantHost: HOST, webUrl: WEB_URL });
  const plan = planSitePermissionsRestore({ source, live, tenantHost: HOST, siteId: SITE, tenantRef: 'sha256:y', testTenantRefs: [] });
  assert.ok(!plan.operations.some((operation) => operation.operationId === ROLE_ASSIGNMENT_ADD));
  // A site that inherits uses its parent's levels: the custom level is restored there instead.
  assert.ok(!plan.operations.some((operation) => operation.operationId === ROLE_DEFINITION_ADD));
  assert.ok(plan.manual.some((item) => item.subject === 'the site' && /never breaks inheritance/.test(item.reason)));
  assert.ok(plan.manual.some((item) => item.subject === 'list KEEL-RT Documents' && /never breaks inheritance/.test(item.reason)));

  // Members the backup could not read, and a list it could not read, stay manual.
  const unread = structuredClone(source);
  unread.value.groups.find((item) => item.title === 'KEEL-RT Reviewers').members = null;
  Object.assign(unread.value.lists[0], { roleAssignments: null, read: { status: 'denied', httpStatus: 403, error: 'HTTP 403' } });
  const live2 = await readLiveSitePermissions({ transport: fakeSharePoint(liveState()).transport, tenantHost: HOST, webUrl: WEB_URL });
  const plan2 = planSitePermissionsRestore({ source: unread, live: live2, tenantHost: HOST, siteId: SITE, tenantRef: 'sha256:y', testTenantRefs: [] });
  assert.ok(!plan2.operations.some((operation) => operation.subject === 'dave in KEEL-RT Reviewers'));
  assert.ok(!plan2.operations.some((operation) => operation.scope === `list:${LIST}`));
  assert.ok(plan2.manual.some((item) => item.subject === 'members of KEEL-RT Reviewers'));
  assert.ok(plan2.manual.some((item) => item.subject === 'list KEEL-RT Documents' && /could not read/.test(item.reason)));
});

test('a write the backup does not hold is never within the backup', async () => {
  const { source } = await backedUp('sha256:z');
  const backup = source.value;
  assert.equal(withinBackup({ operationId: SITE_ADMIN_ADD, principal: { loginName: login('erin') } }, backup), true);
  assert.equal(withinBackup({ operationId: SITE_ADMIN_ADD, principal: { loginName: login('zoe') } }, backup), false);
  assert.equal(withinBackup({ operationId: GROUP_MEMBER_ADD, group: 'KEEL-RT Members', principal: { loginName: login('carol') } }, backup), true);
  assert.equal(withinBackup({ operationId: GROUP_MEMBER_ADD, group: 'KEEL-RT Owners', principal: { loginName: login('carol') } }, backup), false);
  assert.equal(withinBackup({ operationId: GROUP_MEMBER_ADD, group: 'SharingLinks.0000.OrganizationView.1111', principal: { loginName: login('carol') } }, backup), false);
  const frank = { operationId: ROLE_ASSIGNMENT_ADD, scope: 'web', role: 'Read', principal: { kind: 'user', loginName: login('frank') } };
  assert.equal(withinBackup(frank, backup), true);
  assert.equal(withinBackup({ ...frank, role: 'Full Control' }, backup), false);
  assert.equal(withinBackup({ ...frank, principal: { kind: 'user', loginName: login('mallory') } }, backup), false);
  assert.equal(withinBackup({ ...frank, scope: `list:${LIST}` }, backup), false);
  assert.equal(withinBackup({ ...frank, role: 'Limited Access', principal: { kind: 'user', loginName: login('bob') } }, backup), false);
  const level = { operationId: ROLE_DEFINITION_ADD, roleDefinition: { name: 'KEEL-RT Reviewer', description: 'Reads and comments', order: 200, basePermissions: { high: '176', low: '138612835' } } };
  assert.equal(withinBackup(level, backup), true);
  assert.equal(withinBackup({ ...level, roleDefinition: { ...level.roleDefinition, basePermissions: { high: '2147483647', low: '4294967295' } } }, backup), false);
  assert.equal(withinBackup({ ...level, roleDefinition: { ...level.roleDefinition, name: 'Full Control' } }, backup), false);
  const created = { operationId: GROUP_ADD, group: { title: 'KEEL-RT Reviewers', description: 'KEEL-RT Reviewers of the site', allowMembersEditMembership: false, allowRequestToJoinLeave: false, autoAcceptRequestToJoinLeave: false, onlyAllowMembersViewMembership: true, requestToJoinLeaveEmailSetting: null } };
  assert.equal(withinBackup(created, backup), true);
  assert.equal(withinBackup({ ...created, group: { ...created.group, allowMembersEditMembership: true } }, backup), false);
  assert.equal(withinBackup({ operationId: 'sharepoint.site-role-assignments.remove' }, backup), false);
});

test('the backup is chosen from the content store by time, or by its own ref', async () => {
  const tenantRef = 'sha256:source';
  const store = createMemoryContentStore({ now: (() => { let at = Date.parse('2026-10-10T00:00:00Z'); return () => new Date(at += 86_400_000); })() });
  const first = await backedUp(tenantRef, backupState(), { store });
  const changed = backupState();
  changed.admins = ['alice'];
  const second = await backedUp(tenantRef, changed, { store });
  assert.notEqual(first.source.ref, second.source.ref);
  assert.equal((await loadSitePermissionsSource({ store, tenantRef, siteId: SITE })).ref, second.source.ref);
  assert.equal((await loadSitePermissionsSource({ store, tenantRef, siteId: SITE, at: first.source.storedAt })).ref, first.source.ref);
  assert.equal((await loadSitePermissionsSource({ store, tenantRef, siteId: SITE, ref: first.source.ref })).value.siteCollectionAdmins.length, 2);
  assert.equal(await loadSitePermissionsSource({ store, tenantRef, siteId: SITE, at: '2026-01-01T00:00:00Z' }), null);
  assert.equal(await loadSitePermissionsSource({ store, tenantRef: 'sha256:other', siteId: SITE }), null);
});

// ------------------------------------------------------------- qualification

test('an unqualified write sends nothing, even when only one of the five writes is off', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const site = fakeSharePoint(liveState());
  const { artifact, plan, store } = await planned(client, tenantRef, site);
  await approve(client, tenantRef, artifact, plan);
  const cases = {
    none: {},
    oneOff: qualify(tenantRef, SITE_PERMISSION_WRITE_OPERATIONS.filter((id) => id !== SITE_ADMIN_ADD)),
    otherTenant: qualify(tenantRef, SITE_PERMISSION_WRITE_OPERATIONS, 'sha256:other'),
  };
  for (const [name, qualifications] of Object.entries(cases)) {
    const result = await run(client, tenantRef, artifact, site, store, qualifications);
    assert.equal(result.outcome, 'disabled', name);
    assert.equal(site.requests.length, 0, `${name}: no request at all`);
  }
  for (const id of SITE_PERMISSION_WRITE_OPERATIONS) assert.equal(qualify(tenantRef)[id].enabled, true, id);
  // Without proof every write stays off.
  for (const id of SITE_PERMISSION_WRITE_OPERATIONS) assert.equal(workloadWriteQualification(id, { readLedger: readLedger(tenantRef), tenantRef, now: NOW }).enabled, false, id);
});

// ------------------------------------------------------------------ restore

test('a restore needs the content-effect approval, adds back only the backup, verifies, and a second run writes nothing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const site = fakeSharePoint(liveState());
  const { artifact, plan, store, backup } = await planned(client, tenantRef, site);

  const blocked = await run(client, tenantRef, artifact, site, store, qualify(tenantRef));
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.equal(site.requests.length, 0);

  await approve(client, tenantRef, artifact, plan);
  const result = await run(client, tenantRef, artifact, site, store, qualify(tenantRef));
  assert.equal(result.outcome, 'verified', result.reasons.join('; '));
  assert.equal(result.verified.length, 8);
  const writes = site.writes().map((request) => `${request.method} ${decodeURIComponent(new URL(request.url).pathname).replace('/sites/KEEL-RT-20261015/_api/', '')}`);
  assert.deepEqual(writes, [
    'POST web/roledefinitions',
    'POST web/sitegroups',
    'POST web/sitegroups/getbyid(4)/users',
    'POST web/sitegroups/getbyid(102)/users',
    'POST web/ensureuser',
    'POST web/siteusers/getbyid(24)',
    'POST web/roleassignments/addroleassignment(principalid=102,roledefid=101)',
    'POST web/ensureuser',
    'POST web/roleassignments/addroleassignment(principalid=25,roledefid=1073741826)',
    'POST web/ensureuser',
    `POST web/lists(guid'${LIST}')/roleassignments/addroleassignment(principalid=23,roledefid=1073741830)`,
  ]);
  assert.equal(result.writes, writes.length);
  assert.deepEqual(site.writes()[0].body, { Name: 'KEEL-RT Reviewer', Description: 'Reads and comments', Order: 200, BasePermissions: { High: '176', Low: '138612835' } });
  assert.deepEqual(site.writes()[5].headers, { 'X-HTTP-Method': 'MERGE' });
  // Nothing wider was touched: mallory, zoe and the extra group are still there.
  assert.deepEqual(site.state.groups.find((item) => item.Title === 'KEEL-RT Members').members.sort(), ['bob', 'carol', 'mallory']);
  assert.ok(site.state.admins.includes('zoe'));
  assert.ok(site.state.web_assignments.some(([, who, role]) => who === 'mallory' && role === 'full'));
  assert.ok(site.state.groups.some((item) => item.Title === 'KEEL-RT Extra'));

  // The same artifact again: the site changed since its dry run, so nothing is written.
  site.requests.length = 0;
  const again = await run(client, tenantRef, artifact, site, store, qualify(tenantRef));
  assert.equal(again.outcome, 'stale');
  assert.equal(site.writes().length, 0);

  // A new dry run from the same backup plans nothing and writes nothing.
  const { artifact: second, plan: secondPlan } = await planned(client, tenantRef, site, { backup });
  assert.equal(secondPlan.operations.length, 0);
  const none = await run(client, tenantRef, second, site, store, qualify(tenantRef));
  assert.equal(none.outcome, 'no-change');
  assert.equal(site.requests.length, 0);
});

test('a site changed after the dry run, a tampered or forged plan, or a refused write stops the run', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();

  const site = fakeSharePoint(liveState());
  const { artifact, plan, store } = await planned(client, tenantRef, site);
  await approve(client, tenantRef, artifact, plan);
  site.state.admins.push('frank');
  const stale = await run(client, tenantRef, artifact, site, store, qualify(tenantRef));
  assert.equal(stale.outcome, 'stale');
  assert.equal(site.writes().length, 0);

  // Editing the stored plan breaks its digest: refused before any request.
  const clean = fakeSharePoint(liveState());
  const second = await planned(client, tenantRef, clean);
  await approve(client, tenantRef, second.artifact, second.plan);
  await client.query(`UPDATE restore_dry_run SET workload_restore = jsonb_set(workload_restore, '{operations,4,principal,loginName}', $2) WHERE id = $1`, [second.artifact.id, JSON.stringify(login('mallory'))]);
  const tampered = await run(client, tenantRef, second.artifact, clean, second.store, qualify(tenantRef));
  assert.equal(tampered.outcome, 'refused');
  assert.equal(clean.requests.length, 0);

  // A plan re-written to make someone else an admin, with its digest recomputed and its
  // approved content effects left alone, is not in the backup: refused before any write.
  const forged = fakeSharePoint(liveState());
  const third = await planned(client, tenantRef, forged);
  await approve(client, tenantRef, third.artifact, third.plan);
  const edited = structuredClone(third.plan);
  edited.operations[4].principal = { loginName: login('zoe'), title: 'zoe' };
  edited.digest = sitePermissionsPlanDigest(edited);
  await client.query(`UPDATE restore_dry_run SET workload_restore = $2, digest = $3 WHERE id = $1`, [third.artifact.id, JSON.stringify(edited), edited.digest]);
  const forgedRun = await run(client, tenantRef, third.artifact, forged, third.store, qualify(tenantRef));
  assert.equal(forgedRun.outcome, 'refused');
  assert.match(forgedRun.reasons[0], /not in the backup/);
  assert.equal(forged.writes().length, 0);
  // The same with a write the backup does hold but the site already has: not what the backup gives.
  const fourthSite = fakeSharePoint(liveState());
  const fourth = await planned(client, tenantRef, fourthSite);
  await approve(client, tenantRef, fourth.artifact, fourth.plan);
  const extra = structuredClone(fourth.plan);
  extra.operations.push({ ...extra.operations[4], naturalKey: `${extra.operations[4].naturalKey}-again`, principal: { loginName: login('alice'), title: 'alice' } });
  extra.digest = sitePermissionsPlanDigest(extra);
  await client.query(`UPDATE restore_dry_run SET workload_restore = $2, digest = $3 WHERE id = $1`, [fourth.artifact.id, JSON.stringify(extra), extra.digest]);
  const extraRun = await run(client, tenantRef, fourth.artifact, fourthSite, fourth.store, qualify(tenantRef));
  assert.equal(extraRun.outcome, 'refused');
  assert.match(extraRun.reasons[0], /not what the backup gives/);
  assert.equal(fourthSite.writes().length, 0);

  // A refused write is reported and nothing after it is sent.
  const locked = fakeSharePoint(liveState(), { onWrite: () => ({ status: 403, headers: {}, body: { 'odata.error': { message: { value: 'Access denied.' } } } }) });
  const fifth = await planned(client, tenantRef, locked);
  await approve(client, tenantRef, fifth.artifact, fifth.plan);
  const refused = await run(client, tenantRef, fifth.artifact, locked, fifth.store, qualify(tenantRef));
  assert.equal(refused.outcome, 'failed');
  assert.match(refused.reasons[0], /HTTP 403/);
  assert.equal(locked.writes().length, 1);
});

// ------------------------------------------------------------------ transport

test('the Restorer transport sends only the allow-listed site permission writes, to the tenant host', async () => {
  const check = (url, init) => assertSitePermissionsRequest(url, init, HOST);
  // Reads the backup uses, and each declared write.
  check(`${API}/web/roledefinitions?$select=Id,Name`, { method: 'GET' });
  check(`${API}/web/roledefinitions`, { method: 'POST', body: { Name: 'x' } });
  check(`${API}/web/sitegroups`, { method: 'POST', body: { Title: 'x' } });
  check(`${API}/web/sitegroups/getbyid(4)/users`, { method: 'POST', body: { LoginName: 'x' } });
  check(`${API}/web/ensureuser`, { method: 'POST', body: { logonName: 'x' } });
  check(`${API}/web/siteusers/getbyid(4)`, { method: 'POST', body: { IsSiteAdmin: true }, headers: { 'X-HTTP-Method': 'MERGE' } });
  check(`${API}/web/roleassignments/addroleassignment(principalid=4,roledefid=1073741826)`, { method: 'POST' });
  check(`${API}/web/lists(guid'${LIST}')/roleassignments/addroleassignment(principalid=4,roledefid=1073741826)`, { method: 'POST' });
  for (const [url, init, reason] of [
    [`${API}/web/roleassignments/removeroleassignment(principalid=4,roledefid=1073741826)`, { method: 'POST' }, /not an allow-listed write/],
    [`${API}/web/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=false)`, { method: 'POST' }, /not an allow-listed write/],
    [`${API}/web/sitegroups/removebyid(4)`, { method: 'POST' }, /not an allow-listed write/],
    [`${API}/web/sitegroups(4)`, { method: 'DELETE' }, /never sends DELETE/],
    [`${API}/web/sitegroups`, { method: 'PATCH', body: {} }, /never sends PATCH/],
    [`${API}/web/siteusers/getbyid(4)`, { method: 'POST', body: { IsSiteAdmin: true } }, /only ever sent as MERGE/],
    [`${API}/web/siteusers/getbyid(4)`, { method: 'POST', body: { IsSiteAdmin: true, Title: 'x' }, headers: { 'X-HTTP-Method': 'MERGE' } }, /only IsSiteAdmin/],
    [`${API}/web/sitegroups`, { method: 'POST', body: { Title: 'x' }, headers: { 'X-HTTP-Method': 'MERGE' } }, /refused X-HTTP-Method/],
    [`${API}/web/sitegroups`, { method: 'POST', body: { Title: 'x' }, headers: { 'X-HTTP-Method': 'DELETE' } }, /refused X-HTTP-Method/],
    [`${API}/web/sitegroups`, { method: 'POST', body: { Title: 'x' }, headers: { 'X-RequestDigest': 'x' } }, /refused request header/],
    [`${API}/web/sitegroups?$select=Id`, { method: 'POST', body: { Title: 'x' } }, /with a query/],
    [`https://fabrikam.sharepoint.com/sites/KEEL-RT-x/_api/web/sitegroups`, { method: 'POST', body: { Title: 'x' } }, /writes to contoso.sharepoint.com only/],
    [`https://graph.microsoft.com/v1.0/sites/x/_api/web/sitegroups`, { method: 'POST', body: { Title: 'x' } }, /only/],
    [`${API}/web/roleassignments/addroleassignment(principalid=4,roledefid=1)`, { method: 'POST', body: {} }, /takes no body/],
    [`${API}/web/lists`, { method: 'GET', body: {} }, /a GET with a body/],
    [`${API}/web/lists/getbytitle('x')/items`, { method: 'GET' }, /not an allow-listed read/],
  ]) assert.throws(() => check(url, init), reason, url);

  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ Id: 7 }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const transport = sitePermissionsWriteTransport(async () => 'token', fetchImpl, { tenantHost: HOST });
  const created = await transport(`${API}/web/sitegroups`, { method: 'POST', body: { Title: 'KEEL-RT x' } });
  assert.equal(created.body.Id, 7);
  assert.equal(sent[0].init.redirect, 'error');
  assert.equal(sent[0].init.headers['content-type'], 'application/json;odata=nometadata');
  assert.equal(sent[0].init.body, JSON.stringify({ Title: 'KEEL-RT x' }));
  await assert.rejects(transport(`${API}/web/sitegroups(4)`, { method: 'DELETE' }), /never sends DELETE/);
  assert.equal(sent.length, 1);
});

test('the restore CLI table plans one site from the content backup and promotes with all five writes', () => {
  const entry = WORKLOAD_RESTORES[SITE_PERMISSIONS_RESTORE];
  assert.deepEqual([...entry.operations], [ROLE_DEFINITION_ADD, GROUP_ADD, GROUP_MEMBER_ADD, SITE_ADMIN_ADD, ROLE_ASSIGNMENT_ADD]);
  assert.match(entry.usage, /--site <site id>/);
  assert.match(entry.usage, /--at/);
});
