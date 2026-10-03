/**
 * Roadmap task-90 boundary tests: entity-scoped reads and approval eligibility.
 * Exercises the production grant scope (engine/authz/permissions.mjs, principals.mjs,
 * can.mjs, administration.mjs), the scope filter and eligibility seam
 * (engine/authz/entityScope.mjs), task 89's ownership resolver, task 59's impact graph
 * and the approval engine (engine/govern/approvals.mjs) against the isolated test
 * database. Required mutation checks:
 *
 * - Filter only client-side.
 * - Omit hidden dependency from safety graph.
 * - Use stale ownership for approval.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { InvalidRoleGrantError, grantRole, revokeRole } from '../authz/administration.mjs';
import { can, capabilityScope } from '../authz/can.mjs';
import {
  REDACTED,
  approvalEligibility,
  captureApprovalScope,
  ownershipOfResources,
  ownershipVisibleTo,
  redactImpactForScope,
  scopePredicate,
} from '../authz/entityScope.mjs';
import { capabilitiesForPrincipal, resolvePrincipal } from '../authz/principals.mjs';
import {
  ApprovalInvalidatedError,
  ApprovalScopeError,
  approveRequest,
  listApprovalRequests,
  rejectRequest,
  requestApproval,
} from '../govern/approvals.mjs';
import { analyzeImpact, buildImpactGraph } from '../graph/impact.mjs';
import { createFixtureCmdbAdapter } from '../identity/adapters/cmdb.mjs';
import { resolveOwnership } from '../identity/ownership.mjs';
import { recordLineage } from '../store/resourceLineage.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const TENANT = 'fixture-tenant';
const HOUR = 60 * 60 * 1000;

const SOURCE = {
  creos: '11111111-1111-1111-1111-111111111111',
  creos2: '11111111-1111-1111-1111-222222222222',
  enovos: '22222222-2222-2222-2222-222222222222',
  shared: '33333333-3333-3333-3333-333333333333',
  failed: '44444444-4444-4444-4444-444444444444',
  dupA: '55555555-5555-5555-5555-555555555555',
  dupB: '66666666-6666-6666-6666-666666666666',
};
const KEY = {
  creos: 'group:Grid Operations Admins',
  creos2: 'group:Grid Field Crews',
  enovos: 'group:Retail Billing Admins',
  shared: 'group:Group Finance',
  failed: 'group:Unreachable Record',
  dup: 'group:Helpdesk',
};

const ownershipConfig = {
  entities: {
    CREOS: { cmdbValues: ['Creos Luxembourg S.A.'], codePrefixes: ['CRE'] },
    ENOVOS: { cmdbValues: ['Enovos Luxembourg S.A.'], codePrefixes: ['ENO'] },
  },
  maxEvidenceAgeMs: 4 * HOUR,
  lookupTimeoutMs: 50,
};
const record = (sourceId, owners, extra = {}) => ({ resourceType: 'group', sourceId, recordRef: `CI-${sourceId.slice(0, 4)}`, owners, ...extra });
const CREOS = 'Creos Luxembourg S.A.';
const ENOVOS = 'Enovos Luxembourg S.A.';

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // retry-safe migration

  const principal = async (email, grants) => {
    const { rows: [row] } = await client.query('INSERT INTO principal(email) VALUES ($1) RETURNING *', [email]);
    for (const [role, entityCode] of grants) {
      await grantRole(client, { principalId: row.id, role, grantedBy: 'fixture', activeFrom: '2020-01-01Z', entityCode });
    }
    return row;
  };
  const p = {
    collector: await principal('collector@example.invalid', [['operator', null], ['viewer', null]]),
    central: await principal('central-approver@example.invalid', [['approver', null], ['viewer', null]]),
    requester: await principal('requester@example.invalid', [['restorer', null], ['viewer', null]]),
    creosViewer: await principal('creos-viewer@example.invalid', [['viewer', 'CREOS']]),
    creosApprover: await principal('creos-approver@example.invalid', [['approver', 'CREOS'], ['viewer', 'CREOS']]),
    enovosApprover: await principal('enovos-approver@example.invalid', [['approver', 'ENOVOS'], ['viewer', 'ENOVOS']]),
    entityRequester: await principal('creos-requester@example.invalid', [['restorer', 'CREOS']]),
  };

  const observed = new Date(Date.now() - HOUR);
  for (const name of ['creos', 'creos2', 'enovos', 'shared', 'failed']) {
    await recordLineage(client, { tenantRef: TENANT, resourceType: 'group', sourceId: SOURCE[name], naturalKey: KEY[name], observedAt: observed });
  }
  // Two different resources currently share one display name.
  await recordLineage(client, { tenantRef: TENANT, resourceType: 'group', sourceId: SOURCE.dupA, naturalKey: KEY.dup, observedAt: observed });
  await recordLineage(client, { tenantRef: TENANT, resourceType: 'group', sourceId: SOURCE.dupB, naturalKey: KEY.dup, observedAt: observed });

  const adapter = createFixtureCmdbAdapter({
    tenantRef: TENANT,
    records: [
      record(SOURCE.creos, [CREOS]), record(SOURCE.creos2, [CREOS]), record(SOURCE.enovos, [ENOVOS]),
      record(SOURCE.shared, [CREOS, ENOVOS]), record(SOURCE.dupA, [CREOS]), record(SOURCE.dupB, [ENOVOS]),
    ],
    failures: [{ resourceType: 'group', sourceId: SOURCE.failed }],
  });
  const resolve = (name, now = new Date()) => resolveOwnership(client, {
    tenantRef: TENANT, managedTenantRef: TENANT, requestedBy: p.collector.id, resourceType: 'group',
    sourceId: SOURCE[name], adapter, config: ownershipConfig, now,
  });
  for (const name of ['creos', 'creos2', 'enovos', 'shared', 'failed', 'dupA', 'dupB']) await resolve(name);

  // Open drift against a baseline, one row per resource, detected now.
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now()) RETURNING id", [TENANT],
  );
  const { rows: [baseline] } = await client.query(
    "INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'fixture') RETURNING id", [TENANT],
  );
  const drift = {};
  for (const name of ['creos', 'creos2', 'enovos', 'shared', 'failed', 'dup']) {
    const { rows: [row] } = await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius)
       VALUES ($1, $2, $3, $4, 'group', 'modified', 'low') RETURNING id`,
      [TENANT, baseline.id, snapshot.id, KEY[name]],
    );
    drift[name] = row.id;
  }
  return { client, p, adapter, resolve, drift };
}

// The server reader under test: rows, a by-id fetch, a name search and a count all go
// through the same scope predicate, in SQL.
async function scopedDrift(client, scope, { id = null, search = null } = {}) {
  const visible = scopePredicate(scope, {
    tenantRef: TENANT, typeExpr: 'd.resource_type', keyExpr: 'd.natural_key', asOfExpr: 'd.detected_at', nextParam: 4,
  });
  const where = `d.tenant_ref = $1 AND ($2::uuid IS NULL OR d.id = $2) AND ($3::text IS NULL OR d.natural_key ILIKE $3) AND ${visible.sql}`;
  const values = [TENANT, id, search, ...visible.values];
  const { rows } = await client.query(`SELECT d.id, d.natural_key FROM drift d WHERE ${where} ORDER BY d.natural_key`, values);
  const { rows: [count] } = await client.query(`SELECT count(*)::int AS n FROM drift d WHERE ${where}`, values);
  return { keys: rows.map((row) => row.natural_key), count: count.n };
}

test('entity-scoped grants answer only for their entity; central grants and legacy rows stay tenant-wide', async (t) => {
  const { client, p } = await setup(t);

  assert.equal(await can(client, p.creosViewer, 'read'), false, 'an entity grant never answers the tenant-wide question');
  assert.equal(await can(client, p.creosViewer, 'read', new Date(), { entityCode: 'CREOS' }), true);
  assert.equal(await can(client, p.creosViewer, 'read', new Date(), { entityCode: 'ENOVOS' }), false);
  assert.deepEqual(await capabilitiesForPrincipal(client, p.creosViewer), []);
  assert.deepEqual(await capabilityScope(client, p.creosViewer, 'read'), { central: false, entities: ['CREOS'] });
  assert.deepEqual(await capabilityScope(client, p.central, 'approve'), { central: true, entities: [] });
  assert.deepEqual(await capabilityScope(client, p.creosViewer, 'approve'), { central: false, entities: [] });

  const resolved = await resolvePrincipal(client, 'creos-approver@example.invalid');
  assert.deepEqual(resolved.capabilities, []);
  assert.deepEqual(resolved.entityCapabilities, { CREOS: ['approve', 'read'] });

  // A grant written before task 90 holds the column default and stays central.
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by, active_from) VALUES ($1, 'investigator', 'legacy', '2020-01-01Z')", [p.creosViewer.id]);
  assert.equal(await can(client, p.creosViewer, 'investigate'), true);

  await assert.rejects(grantRole(client, { principalId: p.creosViewer.id, role: 'admin', grantedBy: 'fixture', entityCode: 'CREOS' }), InvalidRoleGrantError);
  await assert.rejects(grantRole(client, { principalId: p.creosViewer.id, role: 'viewer', grantedBy: 'fixture', entityCode: 'creos' }), InvalidRoleGrantError);
  await assert.rejects(
    client.query("INSERT INTO role_grant (principal_id, role, scope) VALUES ($1, 'viewer', 'entity:*')", [p.creosViewer.id]),
    /role_grant_scope_check/,
    'a malformed scope cannot be stored, so it can never be read as central',
  );
});

test('a scoped viewer cannot fetch another entity by id, search, export or count', async (t) => {
  const { client, p, drift } = await setup(t);
  const creos = await capabilityScope(client, p.creosViewer, 'read');
  const central = await capabilityScope(client, p.central, 'read');

  const all = await scopedDrift(client, central);
  assert.equal(all.count, 6, 'a central reader sees every row, including unresolved and ambiguous ones');

  const mine = await scopedDrift(client, creos);
  assert.deepEqual(mine.keys, [KEY.creos2, KEY.creos, KEY.shared].sort(), 'owned rows and rows shared with the entity');
  assert.equal(mine.count, 3, 'the count is computed by the same filter, never the tenant total');

  assert.deepEqual((await scopedDrift(client, creos, { id: drift.enovos })).keys, [], 'by id');
  assert.deepEqual((await scopedDrift(client, creos, { search: '%Billing%' })), { keys: [], count: 0 }, 'by search, with its count');
  assert.deepEqual((await scopedDrift(client, creos, { id: drift.failed })).keys, [], 'a failed CMDB lookup does not widen');
  assert.deepEqual((await scopedDrift(client, creos, { id: drift.dup })).keys, [], 'a name two resources hold is not attributed by name');
  assert.deepEqual(await scopedDrift(client, { central: false, entities: [] }), { keys: [], count: 0 }, 'no scope is nothing, never everything');
  assert.deepEqual(
    (await scopedDrift(client, { central: false, entities: ['ENOVOS'] })).keys,
    [KEY.enovos, KEY.shared].sort(),
  );
});

test('expired or re-attributed ownership is no longer visible to the old entity', async (t) => {
  const { client, p, adapter, resolve } = await setup(t);
  const creos = await capabilityScope(client, p.creosViewer, 'read');

  // The resource moves to Enovos in the CMDB and is re-resolved.
  adapter.setRecords([record(SOURCE.creos, [ENOVOS]), record(SOURCE.creos2, [CREOS])]);
  await resolve('creos');
  assert.ok(!(await scopedDrift(client, creos)).keys.includes(KEY.creos));

  // Evidence resolved five hours ago is past its four-hour freshness: invisible.
  await resolve('creos2', new Date(Date.now() - 5 * HOUR));
  assert.ok(!(await scopedDrift(client, creos)).keys.includes(KEY.creos2));
  const [answer] = await ownershipOfResources(client, { tenantRef: TENANT, resources: [{ resourceType: 'group', naturalKey: KEY.creos2 }] });
  assert.equal(ownershipVisibleTo(creos, answer), false);
  assert.equal(ownershipVisibleTo({ central: true }, answer), true);
});

test('a dependency outside the scope stays in the safety graph as a redacted central handoff', async (t) => {
  const { client, p } = await setup(t);
  const res = (naturalKey, refs = []) => ({
    naturalKey, resourceType: 'group', payload: {}, restorePriority: 100,
    references: refs.map((symbol) => ({ symbol, field: 'members', required: true })),
  });
  // A Creos group whose restore needs an Enovos group, which needs the ambiguous name.
  const graph = buildImpactGraph({ resources: [res(KEY.creos, [KEY.enovos]), res(KEY.enovos, [KEY.dup]), res(KEY.dup), res(KEY.creos2)] });
  const full = analyzeImpact(graph, { operation: 'restore', keys: [KEY.creos] });
  assert.deepEqual(full.closure, [KEY.dup, KEY.creos, KEY.enovos].sort());

  const creos = await capabilityScope(client, p.creosViewer, 'read');
  const owned = await ownershipOfResources(client, {
    tenantRef: TENANT, resources: [...graph.nodes.keys()].map((naturalKey) => ({ resourceType: 'group', naturalKey })),
  });
  const visible = new Set(owned.filter((entry) => ownershipVisibleTo(creos, entry)).map((entry) => entry.naturalKey));
  const view = redactImpactForScope(full, { isVisible: (key) => visible.has(key) });

  assert.deepEqual(view.closure, [KEY.creos, REDACTED], 'two foreign prerequisites collapse to one marker: no count is disclosed');
  assert.ok(!JSON.stringify(view).includes('Retail Billing'), 'the foreign resource is not named');
  assert.ok(!JSON.stringify(view).includes('Helpdesk'), 'the ambiguous resource is not named');
  assert.equal(view.scopeHandoff?.handoff, 'central');
  assert.equal(view.scopeHandoff?.required, true);
  assert.equal(view.fingerprint, full.fingerprint, 'decisions keep the full graph fingerprint');
  assert.deepEqual(view.completeness, full.completeness);
  assert.ok(view.waves.flat().includes(REDACTED), 'restore ordering still shows that something comes first');

  const own = redactImpactForScope(analyzeImpact(graph, { operation: 'restore', keys: [KEY.creos2] }), { isVisible: (key) => visible.has(key) });
  assert.equal(own.scopeHandoff, undefined, 'a wholly visible analysis needs no handoff');
});

test('approval eligibility: entity approver, foreign approver, central approver and shared resources', async (t) => {
  const { client, p, drift } = await setup(t);
  const scopeOf = (...names) => captureApprovalScope(client, {
    tenantRef: TENANT, resources: names.map((name) => ({ resourceType: 'group', naturalKey: KEY[name] })),
  });
  const ask = async (entityScope) => requestApproval(client, {
    tenantRef: TENANT, action: 'remediate', params: { driftIds: [drift.creos] }, requestedBy: p.requester.id, entityScope,
  });

  const creosScope = await scopeOf('creos', 'creos2');
  assert.equal(creosScope.centralOnly, false);
  assert.deepEqual(creosScope.entities, ['CREOS']);

  const foreign = await ask(creosScope);
  await assert.rejects(
    approveRequest(client, { tenantRef: TENANT, id: foreign.id, decidedBy: p.enovosApprover.id }),
    (error) => error instanceof ApprovalScopeError && error.handoff === 'central',
  );
  assert.equal((await client.query('SELECT status FROM approval_request WHERE id = $1', [foreign.id])).rows[0].status, 'pending');
  const { job } = await approveRequest(client, { tenantRef: TENANT, id: foreign.id, decidedBy: p.creosApprover.id });
  assert.equal(job.kind, 'remediate');

  const central = await ask(creosScope);
  assert.ok((await approveRequest(client, { tenantRef: TENANT, id: central.id, decidedBy: p.central.id })).job, 'a central approver remains explicitly authorized');

  const sharedScope = await scopeOf('creos', 'shared');
  assert.equal(sharedScope.centralOnly, true);
  const shared = await ask(sharedScope);
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: shared.id, decidedBy: p.creosApprover.id }), ApprovalScopeError);
  await assert.rejects(rejectRequest(client, { tenantRef: TENANT, id: shared.id, decidedBy: p.creosApprover.id, reason: 'no' }), ApprovalScopeError);
  assert.ok((await approveRequest(client, { tenantRef: TENANT, id: shared.id, decidedBy: p.central.id })).job);

  const unresolved = await ask(await scopeOf('failed'));
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: unresolved.id, decidedBy: p.creosApprover.id }), ApprovalScopeError);

  // A request made before task 90 has no captured scope: central approvers only.
  const legacy = await ask(null);
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: legacy.id, decidedBy: p.creosApprover.id, enforceScope: true }), ApprovalScopeError);
  assert.ok((await approveRequest(client, { tenantRef: TENANT, id: legacy.id, decidedBy: p.central.id, enforceScope: true })).job);
});

test('the approval inbox is filtered in SQL by the approver scope', async (t) => {
  const { client, p } = await setup(t);
  const scope = (...names) => captureApprovalScope(client, { tenantRef: TENANT, resources: names.map((name) => ({ resourceType: 'group', naturalKey: KEY[name] })) });
  const make = async (entityScope) => (await requestApproval(client, { tenantRef: TENANT, action: 'remediate', params: {}, requestedBy: p.requester.id, entityScope })).id;
  const creosId = await make(await scope('creos'));
  const enovosId = await make(await scope('enovos'));
  const sharedId = await make(await scope('shared'));
  const legacyId = await make(null);

  const ids = async (who) => (await listApprovalRequests(client, { statuses: ['pending'], approverScope: await capabilityScope(client, who, 'approve') })).map((row) => row.id).sort();
  assert.deepEqual(await ids(p.creosApprover), [creosId]);
  assert.deepEqual(await ids(p.enovosApprover), [enovosId]);
  assert.deepEqual(await ids(p.central), [creosId, enovosId, sharedId, legacyId].sort());
  assert.deepEqual(await ids(p.creosViewer), [], 'a viewer without approve sees no request');
});

test('a change of owner or grant invalidates a pending request; stale ownership never approves', async (t) => {
  const { client, p, adapter, resolve } = await setup(t);
  const scope = await captureApprovalScope(client, { tenantRef: TENANT, resources: [{ resourceType: 'group', naturalKey: KEY.creos }] });
  const ask = async (requestedBy = p.requester.id) => (await requestApproval(client, {
    tenantRef: TENANT, action: 'restore', params: {}, requestedBy, entityScope: scope,
  })).id;

  // The resource moves to Enovos after the request was made.
  const moved = await ask();
  adapter.setRecords([record(SOURCE.creos, [ENOVOS])]);
  await resolve('creos');
  const verdict = await approvalEligibility(client, { tenantRef: TENANT, entityScope: scope, approverId: p.creosApprover.id });
  assert.deepEqual(verdict, { eligible: false, reason: 'ownership-changed', invalidate: true });
  await assert.rejects(
    approveRequest(client, { tenantRef: TENANT, id: moved, decidedBy: p.creosApprover.id }),
    (error) => error instanceof ApprovalInvalidatedError && error.reason === 'ownership-changed',
  );
  // Even the central approver cannot approve what the request no longer describes.
  const movedCentral = await ask();
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: movedCentral, decidedBy: p.central.id }), ApprovalInvalidatedError);
  const { rows: [closed] } = await client.query('SELECT status, reason FROM approval_request WHERE id = $1', [moved]);
  assert.deepEqual(closed, { status: 'expired', reason: 'invalidated: ownership-changed' }, 'closed, committed before the refusal');

  // Back with Creos but re-resolved long ago: expired evidence refuses.
  adapter.setRecords([record(SOURCE.creos, [CREOS])]);
  await resolve('creos', new Date(Date.now() - 5 * HOUR));
  const staleScope = await captureApprovalScope(client, { tenantRef: TENANT, resources: [{ resourceType: 'group', naturalKey: KEY.creos }], at: new Date(Date.now() - 5 * HOUR + 1000) });
  assert.equal(staleScope.centralOnly, false);
  assert.deepEqual(
    await approvalEligibility(client, { tenantRef: TENANT, entityScope: staleScope, approverId: p.creosApprover.id }),
    { eligible: false, reason: 'ownership-expired', handoff: 'central' },
  );

  // Fresh again; the requester's entity grant is then revoked.
  await resolve('creos');
  const fresh = await captureApprovalScope(client, { tenantRef: TENANT, resources: [{ resourceType: 'group', naturalKey: KEY.creos }] });
  const { rows: [grant] } = await client.query("SELECT id FROM role_grant WHERE principal_id = $1 AND role = 'restorer'", [p.entityRequester.id]);
  const byEntity = (await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: {}, requestedBy: p.entityRequester.id, entityScope: fresh })).id;
  assert.deepEqual(
    await approvalEligibility(client, { tenantRef: TENANT, entityScope: fresh, approverId: p.creosApprover.id, requesterId: p.entityRequester.id, requesterCapability: 'restore' }),
    { eligible: true, via: 'entity' },
  );
  await revokeRole(client, { principalId: p.entityRequester.id, grantId: grant.id, revokedBy: 'fixture' });
  // revokeRole ends the grant at the database's now() (microseconds); let the clock pass it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    approveRequest(client, { tenantRef: TENANT, id: byEntity, decidedBy: p.creosApprover.id }),
    (error) => error instanceof ApprovalInvalidatedError && error.reason === 'requester-grant-changed',
  );

  // The approver's own grant ending refuses that approver without closing the request.
  const pending = (await requestApproval(client, { tenantRef: TENANT, action: 'restore', params: {}, requestedBy: p.requester.id, entityScope: fresh })).id;
  await client.query("UPDATE role_grant SET active_until = now() - interval '1 second' WHERE principal_id = $1 AND role = 'approver'", [p.creosApprover.id]);
  await assert.rejects(approveRequest(client, { tenantRef: TENANT, id: pending, decidedBy: p.creosApprover.id }), ApprovalScopeError);
  assert.equal((await client.query('SELECT status FROM approval_request WHERE id = $1', [pending])).rows[0].status, 'pending');
});
