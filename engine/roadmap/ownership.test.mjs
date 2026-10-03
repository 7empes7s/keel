/**
 * Roadmap task-89 boundary tests: CMDB-first ownership with explicit SHARED,
 * unknown and unresolved states. Exercises the production
 * engine/identity/ownership.mjs resolver, the fixture CMDB adapter, task 50's
 * resource lineage store and the keel-worker CLI seam against the isolated test
 * database. Required mutation checks:
 *
 * - Global-allow on CMDB failure.
 * - Merge ownership by display name.
 * - Ignore evidence expiry.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createFixtureCmdbAdapter } from '../identity/adapters/cmdb.mjs';
import {
  compileOwnershipConfig,
  ownershipAllowsWrite,
  ownershipEvidenceById,
  readOwnership,
  resolveOwnership,
} from '../identity/ownership.mjs';
import { recordLineage, tombstoneMissingLineages } from '../store/resourceLineage.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { runOwnershipCommand } from '../../cli/keel-worker.mjs';

const TENANT = 'fixture-tenant';
const OTHER_TENANT = 'other-tenant';
const T0 = new Date('2026-09-20T08:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);

const CREOS_GROUP = '11111111-1111-1111-1111-111111111111';
const ENOVOS_GROUP = '22222222-2222-2222-2222-222222222222';
const FALLBACK_GROUP = '33333333-3333-3333-3333-333333333333';
const MIXED_GROUP = '44444444-4444-4444-4444-444444444444';
const REUSED_OLD = '55555555-5555-5555-5555-555555555555';
const REUSED_NEW = '66666666-6666-6666-6666-666666666666';

const ownership = {
  entities: {
    CREOS: { cmdbValues: ['Creos Luxembourg S.A.'], codePrefixes: ['CRE'] },
    ENOVOS: { cmdbValues: ['Enovos Luxembourg S.A.'], codePrefixes: ['ENO'] },
  },
  maxEvidenceAgeMs: 4 * HOUR,
  lookupTimeoutMs: 50,
};

async function setup(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // retry-safe migration
  const principal = async (email, roles) => {
    const { rows: [row] } = await client.query('INSERT INTO principal(email) VALUES ($1) RETURNING *', [email]);
    for (const role of roles) {
      await client.query("INSERT INTO role_grant(principal_id, role, granted_by, active_from) VALUES ($1, $2, 'fixture', '2020-01-01Z')", [row.id, role]);
    }
    return row;
  };
  const operator = await principal('owner-operator@example.invalid', ['operator', 'viewer', 'restorer']);
  const viewer = await principal('owner-viewer@example.invalid', ['viewer']);
  const lineage = (sourceId, name, observedAt = at(-HOUR), tenantRef = TENANT) =>
    recordLineage(client, { tenantRef, resourceType: 'group', sourceId, naturalKey: `group:${name}`, observedAt });
  const base = { tenantRef: TENANT, managedTenantRef: TENANT, requestedBy: operator.id, resourceType: 'group' };
  const resolve = (sourceId, adapter, now = T0, config = ownership) =>
    resolveOwnership(client, { ...base, sourceId, adapter, config, now });
  const allows = (sourceId, entityCode, when = at(HOUR), extra = {}) =>
    ownershipAllowsWrite(client, { ...base, capability: 'restore', sourceId, entityCode, at: when, ...extra });
  return { client, operator, viewer, lineage, base, resolve, allows };
}

const record = (sourceId, owners, extra = {}) => ({ resourceType: 'group', sourceId, recordRef: `CI-${sourceId.slice(0, 4)}`, owners, ...extra });

test('Creos and Enovos synthetic resources route to their entity; fallback uses the documented entity code', async (t) => {
  const { lineage, resolve, allows } = await setup(t);
  await lineage(CREOS_GROUP, 'Grid Operations Admins');
  await lineage(ENOVOS_GROUP, 'Retail Billing Admins');
  await lineage(FALLBACK_GROUP, 'ENO-Field-Service');
  const adapter = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [
    record(CREOS_GROUP.toUpperCase(), ['Creos Luxembourg S.A.']),
    record(ENOVOS_GROUP, ['  enovos luxembourg s.a. ']),
  ] });

  const creos = await resolve(CREOS_GROUP, adapter);
  assert.equal(creos.state, 'owned');
  assert.equal(creos.entity_code, 'CREOS');
  assert.equal(creos.source, 'cmdb');
  assert.equal(creos.cmdb_record_ref, 'CI-1111');
  assert.equal(creos.expires_at.getTime(), at(4 * HOUR).getTime());

  const enovos = await resolve(ENOVOS_GROUP, adapter);
  assert.equal(enovos.entity_code, 'ENOVOS');

  const fallback = await resolve(FALLBACK_GROUP, adapter);
  assert.equal(fallback.state, 'owned');
  assert.equal(fallback.entity_code, 'ENOVOS');
  assert.equal(fallback.source, 'entity-code-fallback');

  assert.deepEqual(await allows(CREOS_GROUP, 'CREOS').then((r) => [r.allowed, r.reason]), [true, 'owned']);
  assert.deepEqual(await allows(CREOS_GROUP, 'ENOVOS').then((r) => [r.allowed, r.reason]), [false, 'entity-mismatch']);
  assert.equal((await allows(ENOVOS_GROUP, 'ENOVOS')).allowed, true);
  assert.equal((await allows(FALLBACK_GROUP, 'ENOVOS')).allowed, true);
  assert.equal((await allows(FALLBACK_GROUP, 'CREOS')).allowed, false);
});

test('an ambiguous owner enters SHARED and hands off to central approval', async (t) => {
  const { lineage, resolve, allows } = await setup(t);
  await lineage(MIXED_GROUP, 'CRE-Joint-Procurement');
  await lineage(CREOS_GROUP, 'Unmapped Co-owner');
  await lineage(ENOVOS_GROUP, 'Flagged Shared');
  const adapter = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [
    record(MIXED_GROUP, ['Creos Luxembourg S.A.', 'Enovos Luxembourg S.A.']),
    record(CREOS_GROUP, ['Creos Luxembourg S.A.', 'Encevo Group Services']),
    record(ENOVOS_GROUP, ['Enovos Luxembourg S.A.'], { shared: true }),
  ] });

  const both = await resolve(MIXED_GROUP, adapter);
  assert.equal(both.state, 'shared');
  assert.equal(both.entity_code, null);
  assert.deepEqual(both.entity_codes, ['CREOS', 'ENOVOS']);
  assert.equal((await resolve(CREOS_GROUP, adapter)).state, 'shared');
  assert.equal((await resolve(ENOVOS_GROUP, adapter)).reason, 'cmdb-marked-shared');

  for (const [sourceId, entity] of [[MIXED_GROUP, 'CREOS'], [MIXED_GROUP, 'ENOVOS'], [CREOS_GROUP, 'CREOS'], [ENOVOS_GROUP, 'ENOVOS']]) {
    const decision = await allows(sourceId, entity);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'central-approval-required');
    assert.equal(decision.handoff, 'central');
  }
});

test('a failed CMDB lookup stays unresolved: no fallback, no stale owner, no write for any entity', async (t) => {
  const { lineage, resolve, allows } = await setup(t);
  await lineage(CREOS_GROUP, 'CRE-Substation-Admins');
  await lineage(ENOVOS_GROUP, 'ENO-Trading');
  await lineage(MIXED_GROUP, 'Slow CMDB');

  const healthy = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [record(CREOS_GROUP, ['Creos Luxembourg S.A.'])] });
  assert.equal((await resolve(CREOS_GROUP, healthy)).state, 'owned');

  const outage = createFixtureCmdbAdapter({ tenantRef: TENANT, unavailable: true });
  const failed = await resolve(CREOS_GROUP, outage, at(10 * 60 * 1000));
  assert.equal(failed.state, 'unresolved');
  assert.equal(failed.reason, 'cmdb-lookup-failed');
  assert.equal(failed.entity_code, null);
  assert.deepEqual(failed.entity_codes, []);

  const oneFailure = createFixtureCmdbAdapter({ tenantRef: TENANT, failures: [{ resourceType: 'group', sourceId: ENOVOS_GROUP }] });
  assert.equal((await resolve(ENOVOS_GROUP, oneFailure)).state, 'unresolved', 'entity-code prefix must not mask a failure');

  const hanging = { tenantRef: TENANT, lookup: () => new Promise(() => {}) };
  assert.equal((await resolve(MIXED_GROUP, hanging)).state, 'unresolved');
  const malformed = { tenantRef: TENANT, lookup: async () => ({ status: 'found', recordRef: 'bad ref with spaces', owners: ['Creos Luxembourg S.A.'] }) };
  assert.equal((await resolve(MIXED_GROUP, malformed)).reason, 'cmdb-answer-malformed');

  for (const sourceId of [CREOS_GROUP, ENOVOS_GROUP, MIXED_GROUP]) {
    for (const entity of ['CREOS', 'ENOVOS']) {
      const decision = await allows(sourceId, entity);
      assert.equal(decision.allowed, false, `${sourceId}/${entity}`);
      assert.notEqual(decision.handoff, 'central');
    }
  }
});

test('a reused name does not inherit the previous lineage ownership', async (t) => {
  const { client, lineage, resolve, allows, base } = await setup(t);
  await lineage(REUSED_OLD, 'Payroll Approvers', at(-3 * HOUR));
  const adapter = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [record(REUSED_OLD, ['Creos Luxembourg S.A.'])] });
  assert.equal((await resolve(REUSED_OLD, adapter, at(-2 * HOUR))).entity_code, 'CREOS');

  await tombstoneMissingLineages(client, { tenantRef: TENANT, resourceType: 'group', observedSourceIds: [], observedAt: at(-90 * 60 * 1000) });
  await lineage(REUSED_NEW, 'Payroll Approvers', at(-HOUR));

  const reused = await resolve(REUSED_NEW, adapter);
  assert.equal(reused.state, 'unknown');
  assert.equal(reused.entity_code, null);
  assert.equal((await allows(REUSED_NEW, 'CREOS')).allowed, false);

  const old = await resolve(REUSED_OLD, adapter);
  assert.equal(old.state, 'unknown');
  assert.equal(old.reason, 'resource-tombstoned');

  const report = await readOwnership(client, { ...base, sourceId: REUSED_NEW, now: at(HOUR) });
  assert.equal(report.history.length, 1, 'the new lineage carries none of the old lineage history');
});

test('expired ownership evidence cannot authorize a write; CMDB validity also bounds freshness', async (t) => {
  const { client, lineage, resolve, allows, base } = await setup(t);
  await lineage(CREOS_GROUP, 'Grid Operations Admins');
  await lineage(ENOVOS_GROUP, 'Retail Billing Admins');
  const adapter = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [
    record(CREOS_GROUP, ['Creos Luxembourg S.A.']),
    record(ENOVOS_GROUP, ['Enovos Luxembourg S.A.'], { validUntil: at(HOUR).toISOString() }),
  ] });
  await resolve(CREOS_GROUP, adapter);
  const short = await resolve(ENOVOS_GROUP, adapter);
  assert.equal(short.expires_at.getTime(), at(HOUR).getTime());

  assert.equal((await allows(CREOS_GROUP, 'CREOS', at(3 * HOUR))).allowed, true);
  const expired = await allows(CREOS_GROUP, 'CREOS', at(5 * HOUR));
  assert.deepEqual([expired.allowed, expired.reason], [false, 'ownership-expired']);
  assert.equal((await allows(ENOVOS_GROUP, 'ENOVOS', at(30 * 60 * 1000))).allowed, true);
  assert.equal((await allows(ENOVOS_GROUP, 'ENOVOS', at(2 * HOUR))).reason, 'ownership-expired');

  const report = await readOwnership(client, { ...base, sourceId: CREOS_GROUP, now: at(5 * HOUR) });
  assert.equal(report.current.fresh, false);
});

test('a moved resource keeps prior approval evidence and invalidates decisions bound to it', async (t) => {
  const { client, lineage, resolve, allows, base } = await setup(t);
  await lineage(CREOS_GROUP, 'Metering Admins');
  const adapter = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [record(CREOS_GROUP, ['Creos Luxembourg S.A.'])] });
  const first = await resolve(CREOS_GROUP, adapter);
  const approvedUnder = (await allows(CREOS_GROUP, 'CREOS')).evidenceId;
  assert.equal(approvedUnder, first.id);

  adapter.setRecords([record(CREOS_GROUP, ['Enovos Luxembourg S.A.'], { recordRef: 'CI-MOVED' })]);
  const moved = await resolve(CREOS_GROUP, adapter, at(HOUR));
  assert.equal(moved.entity_code, 'ENOVOS');

  const cited = await ownershipEvidenceById(client, { ...base, evidenceId: approvedUnder });
  assert.equal(cited.entity_code, 'CREOS');
  assert.equal(cited.cmdb_record_ref, 'CI-1111');
  assert.equal(cited.superseded_at.getTime(), at(HOUR).getTime());

  assert.equal((await allows(CREOS_GROUP, 'ENOVOS', at(2 * HOUR), { evidenceId: approvedUnder })).reason, 'ownership-changed');
  assert.equal((await allows(CREOS_GROUP, 'CREOS', at(2 * HOUR))).reason, 'entity-mismatch');
  assert.equal((await allows(CREOS_GROUP, 'ENOVOS', at(2 * HOUR))).allowed, true);

  const report = await readOwnership(client, { ...base, sourceId: CREOS_GROUP, now: at(2 * HOUR) });
  assert.deepEqual(report.history.map((row) => row.entity_code), ['ENOVOS', 'CREOS']);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM resource_ownership_evidence WHERE superseded_at IS NULL');
  assert.equal(rows[0].n, 1);
});

test('tenant binding, capability checks and legacy reads never widen access', async (t) => {
  const { client, lineage, resolve, allows, base, viewer, operator } = await setup(t);
  await lineage(CREOS_GROUP, 'Grid Operations Admins');
  await lineage(CREOS_GROUP, 'Other Tenant Copy', at(-HOUR), OTHER_TENANT);
  const adapter = createFixtureCmdbAdapter({ tenantRef: TENANT, records: [record(CREOS_GROUP, ['Creos Luxembourg S.A.'])] });

  await assert.rejects(resolve(CREOS_GROUP, createFixtureCmdbAdapter({ tenantRef: OTHER_TENANT })), /not bound to this tenant/);
  await assert.rejects(resolveOwnership(client, { ...base, requestedBy: viewer.id, sourceId: CREOS_GROUP, adapter, config: ownership }), /not authorized/);
  await assert.rejects(resolveOwnership(client, { ...base, managedTenantRef: OTHER_TENANT, sourceId: CREOS_GROUP, adapter, config: ownership }), /tenant mismatch/);
  await assert.rejects(resolve(FALLBACK_GROUP, adapter), /no lineage/);
  await resolve(CREOS_GROUP, adapter);

  const foreign = await ownershipAllowsWrite(client, { ...base, tenantRef: OTHER_TENANT, managedTenantRef: OTHER_TENANT,
    capability: 'restore', sourceId: CREOS_GROUP, entityCode: 'CREOS', at: at(HOUR) });
  assert.equal(foreign.reason, 'ownership-never-resolved');
  assert.equal((await allows(CREOS_GROUP, 'CREOS', at(HOUR), { requestedBy: viewer.id })).reason, 'capability-missing');
  assert.equal((await allows(CREOS_GROUP, null)).reason, 'entity-scope-missing');

  await client.query('UPDATE principal SET disabled_at = now() WHERE id = $1', [operator.id]);
  assert.equal((await allows(CREOS_GROUP, 'CREOS')).allowed, false);
  await client.query('UPDATE principal SET disabled_at = NULL WHERE id = $1', [operator.id]);

  await client.query('DROP TABLE resource_ownership_evidence');
  const legacy = await readOwnership(client, { ...base, sourceId: CREOS_GROUP });
  assert.deepEqual([legacy.status, legacy.current], ['not-configured', null]);
  assert.equal((await allows(CREOS_GROUP, 'CREOS')).reason, 'ownership-not-configured');
});

test('configuration refuses duplicate mappings; the worker CLI seam resolves and reports with the fixture adapter', async (t) => {
  assert.throws(() => compileOwnershipConfig({ entities: { CREOS: { cmdbValues: ['X'] }, ENOVOS: { cmdbValues: ['x'] } } }), /mapped twice/);
  assert.throws(() => compileOwnershipConfig({ entities: { CREOS: { codePrefixes: ['CRE'] }, ENOVOS: { codePrefixes: ['CRE'] } } }), /duplicate/);
  assert.throws(() => compileOwnershipConfig({ entities: {} }), /no entities/);

  const { client, lineage, base } = await setup(t);
  await lineage(CREOS_GROUP, 'Grid Operations Admins');
  const config = { ...base, sourceId: CREOS_GROUP, ownership, fixtureRecords: [record(CREOS_GROUP, ['Creos Luxembourg S.A.'])] };
  const resolved = await runOwnershipCommand(client, config);
  assert.equal(resolved.entity_code, 'CREOS');
  const report = await runOwnershipCommand(client, config, { report: true });
  assert.equal(report.current.id, resolved.id);
  await assert.rejects(runOwnershipCommand(client, { ...config, fixtureRecords: undefined }), /fixtureRecords/);
});
