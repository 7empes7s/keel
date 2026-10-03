/**
 * Roadmap task-91 boundary tests: evidence-based change attribution and approver routing.
 * Exercises the production audit ingestion (engine/identity/auditIngest.mjs, task 88)
 * feeding minimized attribution facts, the attribution reader and classifier
 * (engine/identity/attribution.mjs), task 89 ownership, task 90 scope and the approval
 * engine (engine/govern/approvals.mjs) against the isolated test database.
 * Required mutation checks:
 *
 * - Label nearest sign-in exact.
 * - Ignore resource identity.
 * - Route cross-entity approval to first matching entity.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { capabilityScope } from '../authz/can.mjs';
import { captureApprovalScope } from '../authz/entityScope.mjs';
import { ApprovalScopeError, approveRequest, listApprovalRequests, requestApproval, routeApproval } from '../govern/approvals.mjs';
import { attributeChanges, changedFields, classifyAttribution, coverageFromRuns } from '../identity/attribution.mjs';
import { createFixtureAuditAdapter, ingestAudit, migrateAuditIngestion } from '../identity/auditIngest.mjs';
import { createFixtureCmdbAdapter } from '../identity/adapters/cmdb.mjs';
import { resolveOwnership } from '../identity/ownership.mjs';
import { recordLineage } from '../store/resourceLineage.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const A = 'tenant-a';
const B = 'tenant-b';
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
// The change happened between the last unchanged collection and the one that saw it.
const WINDOW = { from: iso(-3 * HOUR), until: iso(-10 * 60 * 1000) };
const INGEST = { from: iso(-4 * HOUR), until: iso(0) };

const ID = {
  creos: '11111111-1111-4111-8111-111111111111',
  creos2: '11111111-1111-4111-8111-222222222222',
  enovos: '22222222-2222-4222-8222-222222222222',
  shared: '33333333-3333-4333-8333-333333333333',
  dupA: '55555555-5555-4555-8555-555555555555',
  dupB: '66666666-6666-4666-8666-666666666666',
  alice: 'aaaaaaaa-0000-4000-8000-00000000a11c',
  bob: 'bbbbbbbb-0000-4000-8000-000000000b0b',
};
const KEY = {
  creos: 'group:Grid Operations Admins', creos2: 'group:Grid Field Crews', enovos: 'group:Retail Billing Admins',
  shared: 'group:Group Finance', dup: 'group:Helpdesk',
};
const CREOS = 'Creos Luxembourg S.A.';
const ENOVOS = 'Enovos Luxembourg S.A.';
const ownershipConfig = {
  entities: {
    CREOS: { cmdbValues: [CREOS], codePrefixes: ['CRE'] },
    ENOVOS: { cmdbValues: [ENOVOS], codePrefixes: ['ENO'] },
  },
  maxEvidenceAgeMs: 4 * HOUR,
  lookupTimeoutMs: 50,
};
const record = (sourceId, owners, resourceType = 'group') => ({ resourceType, sourceId, recordRef: `CI-${sourceId.slice(0, 4)}`, owners });

const auditEvent = (id, at, { target = ID.creos, type = 'group', operation = 'Update', fields = ['description'], actor = ID.alice, ...extra } = {}) => ({
  id, occurredAt: at, ...extra,
  change: { targetType: type, targetId: target, operation, activity: 'Update group', fields, actorKind: 'user', actorId: actor },
});
const signIn = (id, at, actor) => ({ id, occurredAt: at, actor: { kind: 'user', id: actor } });

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // retry-safe

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
  };

  const observed = new Date(NOW - 5 * HOUR);
  const lineage = (tenantRef, resourceType, sourceId, naturalKey) => recordLineage(client, { tenantRef, resourceType, sourceId, naturalKey, observedAt: observed });
  for (const name of ['creos', 'creos2', 'enovos', 'shared']) await lineage(A, 'group', ID[name], KEY[name]);
  await lineage(A, 'group', ID.dupA, KEY.dup);
  await lineage(A, 'group', ID.dupB, KEY.dup);
  // The actors are collected users of tenant A.
  await lineage(A, 'user', ID.alice, 'user:Alice Admin');
  await lineage(A, 'user', ID.bob, 'user:Bob Builder');
  // Tenant B holds the SAME object ids under other names (a shared actor id).
  await lineage(B, 'group', ID.creos, 'group:Tenant B Group');
  await lineage(B, 'user', ID.alice, 'user:Mallory Other Tenant');

  const cmdb = createFixtureCmdbAdapter({
    tenantRef: A,
    records: [record(ID.creos, [CREOS]), record(ID.creos2, [CREOS]), record(ID.enovos, [ENOVOS]), record(ID.shared, [CREOS, ENOVOS])],
  });
  const resolve = (name, now = new Date()) => resolveOwnership(client, {
    tenantRef: A, managedTenantRef: A, requestedBy: p.collector.id, resourceType: 'group',
    sourceId: ID[name], adapter: cmdb, config: ownershipConfig, now,
  });
  for (const name of ['creos', 'creos2', 'enovos', 'shared']) await resolve(name);

  // Task 88's production ingestion, with the fixture read-only adapter.
  const ingest = (tenantRef, source, pages, extra = {}) => ingestAudit(client, {
    tenantRef, managedTenantRef: tenantRef, requestedBy: p.collector.id, source, enabled: true,
    from: INGEST.from, until: INGEST.until, retentionDays: 30, maxRequests: 5, maxEvents: 100, maxDurationMs: 5000, pageSize: 50,
    adapter: createFixtureAuditAdapter({ tenantRef, pages }), ...extra,
  });
  const change = (name, fields = ['description'], extra = {}) => ({
    id: `drift-${name}`, resourceType: 'group', naturalKey: KEY[name], changeType: 'modified', fields, window: WINDOW, ...extra,
  });
  const attribute = (tenantRef, changes, scope) => attributeChanges(client, { tenantRef, changes, scope });
  return { client, p, cmdb, resolve, ingest, change, attribute };
}

test('direct resource and operation evidence supports exact; a different resource never does', async (t) => {
  const { client, ingest, change, attribute } = await setup(t);
  // Before migration: no audit log configured, which is unknown, never "nobody".
  const [before] = await attribute(A, [change('creos')]);
  assert.deepEqual([before.verdict, before.reason], ['unknown', 'audit-log-not-configured']);

  await migrateAuditIngestion(client);
  await migrateAuditIngestion(client); // retry-safe
  const result = await ingest(A, 'audit', [{
    events: [
      auditEvent('evt-alice-creos', iso(-2 * HOUR)),
      // Bob changed a different group in the same window, the same field name.
      auditEvent('evt-bob-enovos', iso(-2 * HOUR + 60000), { target: ID.enovos, actor: ID.bob }),
      // Bob also touched this group, but a field that did not change here.
      auditEvent('evt-bob-creos-other-field', iso(-90 * 60000), { actor: ID.bob, fields: ['visibility'] }),
      // Outside the change window: not evidence for it.
      auditEvent('evt-bob-creos-before', iso(-3.5 * HOUR), { actor: ID.bob }),
    ],
    nextCursor: null,
  }]);
  assert.equal(result.status, 'complete');
  await ingest(A, 'sign-in', [{ events: [signIn('si-bob', iso(-2 * HOUR), ID.bob)], nextCursor: null }]);

  const [exact] = await attribute(A, [change('creos', ['description'])]);
  assert.equal(exact.verdict, 'exact');
  assert.equal(exact.reason, 'audit-record-names-resource');
  assert.deepEqual(exact.actors, [{ kind: 'user', id: ID.alice, name: 'Alice Admin' }]);
  assert.deepEqual(exact.evidence.map((fact) => fact.sourceEventId), ['evt-alice-creos']);
  assert.equal(exact.resourceObjectId, ID.creos);
  assert.deepEqual(exact.coverage, { audit: 'covered', signIn: 'covered' });

  // Bob's record is for another resource: with no record naming creos2, the only
  // evidence is a nearby sign-in, which is never exact.
  const [other] = await attribute(A, [change('creos2', ['description'])]);
  assert.notEqual(other.verdict, 'exact');
  assert.deepEqual([other.verdict, other.reason], ['plausible', 'sign-in-proximity-only']);
  assert.deepEqual(other.evidence, [], 'a sign-in is context, not a record of this change');

  // A name two resources hold is never resolved by name.
  const [dup] = await attribute(A, [change('dup')]);
  assert.deepEqual([dup.verdict, dup.reason], ['unknown', 'resource-identity-unresolved']);

  // An added resource is not explained by an update record.
  const [added] = await attribute(A, [change('creos', [], { changeType: 'added' })]);
  assert.notEqual(added.verdict, 'exact');

  // The classifier on its own: a record about another object id is not about this one.
  const elsewhere = classifyAttribution({
    tenantRef: A,
    change: { resourceType: 'group', sourceId: ID.creos2, changeType: 'modified', fields: ['description'], window: WINDOW },
    auditFacts: [{ tenantRef: A, sourceEventId: 'evt', occurredAt: iso(-2 * HOUR), targetType: 'group', targetId: ID.creos, operation: 'update', fields: ['description'], actorKind: 'user', actorId: ID.alice }],
    signInFacts: [], auditCoverage: { status: 'covered' }, signInCoverage: { status: 'covered' },
  });
  assert.deepEqual([elsewhere.verdict, elsewhere.reason], ['unknown', 'no-audit-record-names-resource']);

  assert.deepEqual(changedFields({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: true }), ['b', 'c', 'd']);
});

test('two nearby actors yield plausible or unknown, never exact', async (t) => {
  const { client, ingest, change, attribute } = await setup(t);
  await migrateAuditIngestion(client);
  await ingest(A, 'audit', [{
    events: [
      auditEvent('evt-alice', iso(-2 * HOUR)),
      auditEvent('evt-bob', iso(-100 * 60000), { actor: ID.bob }),
    ],
    nextCursor: null,
  }]);
  await ingest(A, 'sign-in', [{ events: [signIn('si-a', iso(-2 * HOUR), ID.alice), signIn('si-b', iso(-2 * HOUR), ID.bob)], nextCursor: null }]);

  const [both] = await attribute(A, [change('creos')]);
  assert.equal(both.verdict, 'plausible');
  assert.equal(both.reason, 'several-actors-changed-resource');
  assert.deepEqual(both.actors.map((actor) => actor.name).sort(), ['Alice Admin', 'Bob Builder']);

  // No record names creos2; two people signed in during the window: unknown, and
  // neither of them is named on a change no evidence ties them to.
  const [nearby] = await attribute(A, [change('creos2')]);
  assert.deepEqual([nearby.verdict, nearby.reason, nearby.actors], ['unknown', 'several-nearby-sign-ins', []]);

  // The classifier itself: the single nearest sign-in alone is plausible at most.
  const verdict = classifyAttribution({
    tenantRef: A,
    change: { resourceType: 'group', sourceId: ID.creos2, changeType: 'modified', fields: ['description'], window: WINDOW },
    auditFacts: [],
    signInFacts: [{ tenantRef: A, sourceEventId: 'si', occurredAt: iso(-11 * 60000), actorKind: 'user', actorId: ID.alice }],
    auditCoverage: { status: 'covered' },
    signInCoverage: { status: 'covered' },
  });
  assert.equal(verdict.verdict, 'plausible');
});

test('missing retention, revoked reads and archives are unknown, distinct from an empty log', async (t) => {
  const { client, ingest, change, attribute } = await setup(t);
  await migrateAuditIngestion(client);

  // Microsoft only had events from one hour ago: the change window is not covered.
  const gap = await ingest(A, 'audit', [{
    events: [auditEvent('evt-late', iso(-30 * 60000), { target: ID.enovos, actor: ID.bob })],
    nextCursor: null, availableFrom: iso(-HOUR),
  }]);
  assert.ok(gap.retentionGap);
  const [lost] = await attribute(A, [change('creos')]);
  assert.deepEqual([lost.verdict, lost.reason], ['unknown', 'audit-retention-gap']);

  // The same record but an incomplete log: plausible, not exact.
  await client.query(`INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, fields, actor_kind, actor_id)
    VALUES ($1, 'evt-in-gap', $2, 'group', $3, 'update', '{description}', 'user', $4)`, [A, iso(-2 * HOUR), ID.creos, ID.alice]);
  const [partial] = await attribute(A, [change('creos')]);
  assert.deepEqual([partial.verdict, partial.reason], ['plausible', 'audit-log-incomplete']);

  // Tenant B: the read scope was revoked. That is not an empty log.
  await migrateAuditIngestion(client);
  const failing = createFixtureAuditAdapter({ tenantRef: B, pages: [] });
  failing.readPage = async () => { throw Object.assign(new Error('denied'), { status: 403 }); };
  const revoked = await ingest(B, 'audit', [], { adapter: failing });
  assert.equal(revoked.status, 'read-scope-revoked');
  await recordLineage(client, { tenantRef: B, resourceType: 'group', sourceId: ID.creos2, naturalKey: KEY.creos2, observedAt: new Date(NOW - 5 * HOUR) });
  const [denied] = await attribute(B, [change('creos2')]);
  assert.deepEqual([denied.verdict, denied.reason], ['unknown', 'audit-read-scope-revoked']);

  // A complete empty log over the window is checked, and says nobody is on record.
  const empty = await ingest('tenant-c', 'audit', [{ events: [], nextCursor: null }]);
  assert.equal(empty.status, 'complete-empty');
  await recordLineage(client, { tenantRef: 'tenant-c', resourceType: 'group', sourceId: ID.creos2, naturalKey: KEY.creos2, observedAt: new Date(NOW - 5 * HOUR) });
  const [none] = await attribute('tenant-c', [change('creos2')]);
  assert.deepEqual([none.verdict, none.reason], ['unknown', 'no-audit-record-names-resource']);

  // KEEL's own retention: a window older than the history KEEL keeps is a gap, even
  // though a completed run once traversed it.
  const run = { evidence: { status: 'complete', window: { from: iso(-80 * 24 * HOUR), until: iso(0) }, retentionDays: 30 } };
  assert.equal(coverageFromRuns({ runs: [run], state: null }, { from: iso(-60 * 24 * HOUR), until: iso(-59 * 24 * HOUR) }).status, 'retention-gap');
  assert.equal(coverageFromRuns({ runs: [run], state: null }, WINDOW).status, 'covered');
  const resumed = { evidence: { status: 'budget-exhausted', window: { from: iso(-80 * 24 * HOUR), until: iso(0) }, retentionDays: 30 } };
  assert.equal(coverageFromRuns({ runs: [resumed], state: null }, WINDOW).status, 'not-read', 'an unfinished traversal proves nothing');
});

test('tenant isolation survives shared actor and object ids', async (t) => {
  const { client, ingest, change, attribute } = await setup(t);
  await migrateAuditIngestion(client);
  // Only tenant B has a record by the shared actor id on the shared object id.
  await ingest(B, 'audit', [{ events: [auditEvent('evt-b', iso(-2 * HOUR))], nextCursor: null }]);
  await ingest(A, 'audit', [{ events: [], nextCursor: null }]);
  const [inA] = await attribute(A, [change('creos')]);
  assert.deepEqual([inA.verdict, inA.reason], ['unknown', 'no-audit-record-names-resource']);

  const [inB] = await attribute(B, [{ ...change('creos'), naturalKey: 'group:Tenant B Group' }]);
  assert.equal(inB.verdict, 'exact');
  assert.deepEqual(inB.actors, [{ kind: 'user', id: ID.alice, name: 'Mallory Other Tenant' }], 'named from tenant B inventory only');

  // The classifier refuses a fact handed to it from another tenant.
  const leaked = classifyAttribution({
    tenantRef: A,
    change: { resourceType: 'group', sourceId: ID.creos, changeType: 'modified', fields: [], window: WINDOW },
    auditFacts: [{ tenantRef: B, sourceEventId: 'evt-b', occurredAt: iso(-2 * HOUR), targetType: 'group', targetId: ID.creos, operation: 'update', fields: [], actorKind: 'user', actorId: ID.alice }],
    signInFacts: [], auditCoverage: { status: 'covered' }, signInCoverage: { status: 'covered' },
  });
  assert.equal(leaked.verdict, 'unknown');
});

test('facts are minimized; an invalid fact refuses the page without advancing the cursor', async (t) => {
  const { client, p, ingest, change, attribute } = await setup(t);
  await migrateAuditIngestion(client);
  await ingest(A, 'audit', [{
    events: [auditEvent('evt-min', iso(-2 * HOUR), {
      initiatedBy: { user: { userPrincipalName: 'alice@contoso.example', ipAddress: '203.0.113.7' } },
      targetResources: [{ modifiedProperties: [{ displayName: 'description', oldValue: 'old-canary', newValue: 'new-canary' }] }],
    })],
    nextCursor: null,
  }]);
  const { rows } = await client.query('SELECT * FROM audit_change_fact');
  const stored = JSON.stringify(rows);
  for (const leaked of ['alice@contoso', '203.0.113', 'canary']) assert.ok(!stored.includes(leaked), leaked);
  assert.deepEqual(rows[0].fields, ['description']);

  const bad = await ingest('tenant-d', 'audit', [{
    events: [{ id: 'evt-bad', occurredAt: iso(-2 * HOUR), change: { targetType: 'group', targetId: 'Grid Operations Admins', operation: 'Update', actorKind: 'user', actorId: ID.alice } }],
    nextCursor: null,
  }]);
  assert.equal(bad.status, 'invalid-page');
  const { rows: [state] } = await client.query("SELECT cursor, complete FROM audit_ingest_state WHERE tenant_ref = 'tenant-d'");
  assert.deepEqual(state, { cursor: null, complete: false });
  const tokenActivity = await ingest('tenant-e', 'audit', [{ events: [auditEvent('evt-tok', iso(-HOUR), { })].map((event) => ({ ...event, change: { ...event.change, activity: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' } })), nextCursor: null }]);
  assert.equal(tokenActivity.status, 'invalid-page');

  // A scoped reader does not learn who an account outside their entities is.
  const creos = await capabilityScope(client, p.creosViewer, 'read');
  const [scoped] = await attribute(A, [change('creos')], creos);
  assert.equal(scoped.verdict, 'exact');
  assert.deepEqual(scoped.actors, [{ kind: 'user', id: null, name: null }]);
});

test('approval routing follows current ownership and hands cross-entity scope to central', async (t) => {
  const { client, p, cmdb, resolve } = await setup(t);
  const scopeOf = (...names) => captureApprovalScope(client, { tenantRef: A, resources: names.map((name) => ({ resourceType: 'group', naturalKey: KEY[name] })) });
  const route = async (scope, requesterId = p.requester.id) => routeApproval(client, { tenantRef: A, entityScope: scope, requesterId });

  const creosOnly = await route(await scopeOf('creos', 'creos2'));
  assert.equal(creosOnly.route, 'entity');
  assert.equal(creosOnly.entityCode, 'CREOS');
  assert.deepEqual(creosOnly.approvers, [p.creosApprover.id]);

  const cross = await route(await scopeOf('creos', 'enovos'));
  assert.deepEqual([cross.route, cross.reason], ['central', 'cross-entity']);
  assert.equal(cross.entityCode, undefined);
  assert.deepEqual(cross.approvers, [p.central.id], 'neither entity approver is routed a cross-entity request');

  const shared = await route(await scopeOf('shared'));
  assert.deepEqual([shared.route, shared.reason], ['central', 'shared-or-unattributed']);
  assert.deepEqual([(await route(null)).route, (await route(null)).reason], ['central', 'no-captured-scope']);
  assert.ok(!(await route(null, p.central.id)).approvers.includes(p.central.id), 'the requester is never routed their own request');

  // The request records its route, in the row and in the evidence.
  const request = await requestApproval(client, { tenantRef: A, action: 'remediate', params: {}, requestedBy: p.requester.id, entityScope: await scopeOf('creos', 'enovos') });
  assert.equal(request.route.reason, 'cross-entity');
  const { rows: [evidence] } = await client.query("SELECT subject FROM evidence WHERE kind = 'approval-request' ORDER BY seq DESC LIMIT 1");
  assert.equal(evidence.subject.route.route, 'central');
  const [listed] = await listApprovalRequests(client, { statuses: ['pending'] });
  assert.equal(listed.route.reason, 'cross-entity');
  // Eligibility is unchanged: the routed-away entity approver still cannot decide it.
  await assert.rejects(approveRequest(client, { tenantRef: A, id: request.id, decidedBy: p.creosApprover.id }), ApprovalScopeError);

  // Ownership changes after the request: refused, never followed to the new owner.
  const captured = await scopeOf('creos');
  cmdb.setRecords([record(ID.creos, [ENOVOS])]);
  await resolve('creos');
  assert.deepEqual([(await route(captured)).route, (await route(captured)).reason], ['refused', 'ownership-changed']);
  assert.equal((await route(captured)).approvers, undefined);

  // Same owner, but the evidence has since expired: handed to central, not refused.
  cmdb.setRecords([record(ID.creos2, [CREOS])]);
  const fresh = await scopeOf('creos2');
  await resolve('creos2', new Date(NOW - 5 * HOUR));
  assert.deepEqual([(await route(fresh)).route, (await route(fresh)).reason], ['central', 'ownership-expired']);
  // Re-resolved to a single entity again: routed to that entity once more.
  await resolve('creos2');
  assert.equal((await route(fresh)).route, 'entity');
});
